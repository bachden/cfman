// Functions prepended to every script cfman dispatches to an enrolled machine,
// so a script author addresses a file by its storage path and never builds a
// URL, an auth header, or a percent-encoding by hand. They are generated
// rather than installed with the agent: an agent already in the field would
// otherwise have to be upgraded before a script could use them.
//
// The unix agent runs scripts through `/bin/sh -lc`, so the shell side is
// POSIX sh - no bashisms - and the Windows agent runs powershell.exe with
// -EncodedCommand, so the PowerShell side has to work on 5.1.

export type ScriptHelperDoc = {
  signature: string;
  description: string;
};

export const FILE_HELPER_DOCS: ScriptHelperDoc[] = [
  {
    signature: "getRemoteFile(remotePath, localFolder?, deleteOnDone?) -> local file path",
    description: "Downloads one file out of the file store into localFolder (the machine's temp folder when omitted) and returns the full local path. With deleteOnDone the local copy is removed when the script finishes; the stored file is never touched."
  },
  {
    signature: "uploadToRemote(localPath, remotePath?) -> storage path",
    description: "Uploads one local file into this machine's upload folder and returns the storage path it landed on. Without remotePath it keeps the file's own name. A remotePath is taken as relative to the upload folder unless it already begins with it, so an upload cannot land outside it."
  },
  {
    signature: "removeRemoteFile(remotePath, recursive?)",
    description: "Deletes one file, or one folder, from the file store. Only inside this machine's upload folder - the rest of the store is read-only to a machine."
  },
  {
    signature: "listRemoteFiles(remoteFolder?) -> JSON listing",
    description: "Lists one folder of the file store. Reading spans the whole store, so a machine can pull an artifact published anywhere in it."
  },
  {
    signature: "remoteFileExists(remotePath) -> true/false",
    description: "Whether anything exists at that storage path, without downloading it. In sh it is the exit status; in PowerShell it is a boolean."
  }
];

const POWERSHELL_HELPERS = `$CfmanLocalCopies = New-Object System.Collections.Generic.List[string]
function cfmanRemotePath { param([string]$Path) (($Path -replace '\\\\', '/').Trim()).Trim('/') }
function cfmanFilesUri {
  param([string]$Suffix, [string]$RemotePath, [string]$Extra)
  $remote = cfmanRemotePath $RemotePath
  $uri = $script:CFMAN_FILES_URL + $Suffix + '?path=' + [System.Uri]::EscapeDataString($remote)
  if ($Extra) { $uri = $uri + '&' + $Extra }
  return $uri
}
function cfmanFilesRequest {
  param([string]$Method, [string]$Uri, [string]$OutFile, [string]$InFile)
  $parameters = @{
    Method = $Method
    Uri = $Uri
    Headers = @{ 'X-Cloudflare-Man-Agent-Token' = $script:CFMAN_AGENT_TOKEN }
    UseBasicParsing = $true
    ErrorAction = 'Stop'
  }
  if ($OutFile) { $parameters['OutFile'] = $OutFile }
  if ($InFile) { $parameters['InFile'] = $InFile }
  return Invoke-WebRequest @parameters
}
# A remotePath is relative to the upload root unless it already starts with
# it, so a script cannot address a file outside the folder this machine owns -
# the server refuses that outright, and re-rooting here means a plain relative
# path is the natural way to write one.
function cfmanUploadPath {
  param([string]$LocalPath, [string]$RemotePath)
  $root = cfmanRemotePath $script:CFMAN_FILES_UPLOAD_ROOT
  $given = cfmanRemotePath $RemotePath
  if (-not $given) { return $root + '/' + [System.IO.Path]::GetFileName($LocalPath) }
  if ($given -eq $root -or $given.StartsWith($root + '/')) { return $given }
  return $root + '/' + $given
}
function getRemoteFile {
  param([Parameter(Mandatory = $true)][string]$RemotePath, [string]$LocalFolder, [bool]$DeleteOnDone = $false)
  $remote = cfmanRemotePath $RemotePath
  if (-not $remote) { throw 'getRemoteFile: a remote path is required' }
  if (-not $LocalFolder) { $LocalFolder = $env:TEMP }
  if (-not (Test-Path -LiteralPath $LocalFolder)) { New-Item -ItemType Directory -Path $LocalFolder -Force | Out-Null }
  $target = Join-Path $LocalFolder ([System.IO.Path]::GetFileName($remote))
  cfmanFilesRequest -Method 'Get' -Uri (cfmanFilesUri -Suffix '/content' -RemotePath $remote) -OutFile $target | Out-Null
  if ($DeleteOnDone) { [void]$script:CfmanLocalCopies.Add($target) }
  return $target
}
function uploadToRemote {
  param([Parameter(Mandatory = $true)][string]$LocalPath, [string]$RemotePath)
  if (-not (Test-Path -LiteralPath $LocalPath -PathType Leaf)) { throw "uploadToRemote: $LocalPath does not exist" }
  $remote = cfmanUploadPath -LocalPath $LocalPath -RemotePath $RemotePath
  $resolved = (Resolve-Path -LiteralPath $LocalPath).ProviderPath
  cfmanFilesRequest -Method 'Put' -Uri (cfmanFilesUri -Suffix '/content' -RemotePath $remote) -InFile $resolved | Out-Null
  return $remote
}
function removeRemoteFile {
  param([Parameter(Mandatory = $true)][string]$RemotePath, [bool]$Recursive = $false)
  $extra = 'recursive=' + $(if ($Recursive) { 'true' } else { 'false' })
  cfmanFilesRequest -Method 'Delete' -Uri (cfmanFilesUri -Suffix '/content' -RemotePath $RemotePath -Extra $extra) | Out-Null
}
function listRemoteFiles {
  param([string]$RemotePath)
  $response = cfmanFilesRequest -Method 'Get' -Uri (cfmanFilesUri -Suffix '' -RemotePath $RemotePath)
  return ($response.Content | ConvertFrom-Json)
}
function remoteFileExists {
  param([Parameter(Mandatory = $true)][string]$RemotePath)
  try {
    $response = cfmanFilesRequest -Method 'Get' -Uri (cfmanFilesUri -Suffix '/stat' -RemotePath $RemotePath)
    return $null -ne ($response.Content | ConvertFrom-Json).file
  } catch { return $false }
}
function cfmanCleanupLocalCopies {
  foreach ($path in $script:CfmanLocalCopies) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  $script:CfmanLocalCopies.Clear()
}`;

// Every byte of a storage path is percent-encoded rather than only the ones
// that have to be. od and sed are POSIX, which a hand-rolled encoder in sh is
// not, and a path can hold any UTF-8 the name rules allow.
//
// The list of local copies to delete at exit is kept in a file, not a shell
// variable: a script reads getRemoteFile's result with $(...), which runs the
// function in a subshell, so anything it assigned would be discarded before
// the trap in the parent shell could ever see it.
const SHELL_HELPERS = `CFMAN_CLEANUP_LIST="\${TMPDIR:-/tmp}/cfman-cleanup-$$.list"
cfmanUrlEncode() { printf '%s' "$1" | od -An -tx1 -v | tr -d '\\n ' | sed 's/../%&/g'; }
cfmanRemotePath() { printf '%s' "$1" | sed -e 's#^/*##' -e 's#/*$##'; }
cfmanFilesCurl() { curl --silent --show-error --fail --location -H "X-Cloudflare-Man-Agent-Token: $CFMAN_AGENT_TOKEN" "$@"; }
getRemoteFile() {
  _cfman_remote=$(cfmanRemotePath "$1")
  if [ -z "$_cfman_remote" ]; then echo 'getRemoteFile: a remote path is required' >&2; return 1; fi
  _cfman_folder=\${2:-\${TMPDIR:-/tmp}}
  mkdir -p -- "$_cfman_folder" || return 1
  _cfman_target="$_cfman_folder/$(basename -- "$_cfman_remote")"
  cfmanFilesCurl -o "$_cfman_target" "$CFMAN_FILES_URL/content?path=$(cfmanUrlEncode "$_cfman_remote")" || return 1
  case "\${3:-}" in
    true|TRUE|True|1|yes) printf '%s\\n' "$_cfman_target" >> "$CFMAN_CLEANUP_LIST" ;;
  esac
  printf '%s\\n' "$_cfman_target"
}
uploadToRemote() {
  if [ ! -f "$1" ]; then echo "uploadToRemote: $1 does not exist" >&2; return 1; fi
  _cfman_root=$(cfmanRemotePath "$CFMAN_FILES_UPLOAD_ROOT")
  _cfman_given=$(cfmanRemotePath "\${2:-}")
  if [ -z "$_cfman_given" ]; then
    _cfman_remote="$_cfman_root/$(basename -- "$1")"
  elif [ "$_cfman_given" = "$_cfman_root" ] || [ "\${_cfman_given#"$_cfman_root"/}" != "$_cfman_given" ]; then
    _cfman_remote="$_cfman_given"
  else
    _cfman_remote="$_cfman_root/$_cfman_given"
  fi
  cfmanFilesCurl -T "$1" "$CFMAN_FILES_URL/content?path=$(cfmanUrlEncode "$_cfman_remote")" >/dev/null || return 1
  printf '%s\\n' "$_cfman_remote"
}
removeRemoteFile() {
  _cfman_recursive=false
  case "\${2:-}" in true|TRUE|True|1|yes) _cfman_recursive=true ;; esac
  cfmanFilesCurl -X DELETE "$CFMAN_FILES_URL/content?path=$(cfmanUrlEncode "$(cfmanRemotePath "$1")")&recursive=$_cfman_recursive" >/dev/null
}
listRemoteFiles() {
  cfmanFilesCurl "$CFMAN_FILES_URL?path=$(cfmanUrlEncode "$(cfmanRemotePath "\${1:-}")")"
}
remoteFileExists() {
  cfmanFilesCurl "$CFMAN_FILES_URL/stat?path=$(cfmanUrlEncode "$(cfmanRemotePath "$1")")" 2>/dev/null | grep -q '"kind"'
}
cfmanCleanupLocalCopies() {
  [ -f "$CFMAN_CLEANUP_LIST" ] || return 0
  while IFS= read -r _cfman_path; do
    [ -n "$_cfman_path" ] && rm -f -- "$_cfman_path"
  done < "$CFMAN_CLEANUP_LIST"
  rm -f -- "$CFMAN_CLEANUP_LIST"
}
trap cfmanCleanupLocalCopies EXIT`;

/**
 * Wraps the operator's script with the file helpers. On the shell side the
 * cleanup runs from a trap, so the body is left exactly as written; on the
 * PowerShell side there is no equivalent of a trap for an ordinary exit, so
 * the body goes in a try/finally. The finally has no catch beside it, which
 * is what keeps a failing script failing.
 */
export function withFileHelpers(script: string, language: "powershell" | "bash" | "sh"): string {
  if (language === "powershell") {
    return `${POWERSHELL_HELPERS}\ntry {\n${script}\n} finally { cfmanCleanupLocalCopies }\n`;
  }
  return `${SHELL_HELPERS}\n${script}\n`;
}
