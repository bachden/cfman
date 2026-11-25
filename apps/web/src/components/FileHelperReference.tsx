import type { StorageDriver } from "../types";

// Mirrors FILE_HELPER_DOCS and FILE_STORAGE_SCRIPT_VARIABLES on the server,
// which is where the functions themselves are generated. Kept here rather than
// fetched: this is reference text next to an editor, and a script author
// should see it without waiting on a request.
const HELPERS: Array<{ signature: string; description: string }> = [
  {
    signature: "getRemoteFile(remotePath, localFolder?, deleteOnDone?)",
    description: "Downloads one stored file into localFolder - the machine's temp folder when omitted - and returns the full local path. With deleteOnDone the local copy is removed when the script finishes; the stored file is never touched."
  },
  {
    signature: "uploadToRemote(localPath, remotePath?)",
    description: "Uploads one local file and returns the storage path it landed on. Without remotePath it keeps the file's own name. A remotePath is taken as relative to the upload folder unless it already begins with it, so an upload cannot land outside it."
  },
  {
    signature: "removeRemoteFile(remotePath, recursive?)",
    description: "Deletes one stored file or folder. Only inside the machine's own upload folder - the rest of the store is read-only to a machine."
  },
  {
    signature: "listRemoteFiles(remoteFolder?)",
    description: "Lists one folder of the store. Reading spans the whole store, so a machine can pull an artifact published anywhere in it."
  },
  {
    signature: "remoteFileExists(remotePath)",
    description: "Whether anything is stored at that path, without downloading it. The exit status in sh, a boolean in PowerShell."
  }
];

const VARIABLES: Array<{ name: string; description: string }> = [
  { name: "CFMAN_FILES_URL", description: "The file-store endpoint for this machine, already scoped to its tunnel." },
  { name: "CFMAN_FILES_UPLOAD_ROOT", description: "The only folder this machine may write into, resolved from its tenant and tunnel code." },
  { name: "CFMAN_AGENT_TOKEN", description: "The machine's own command-agent token, used as the request credential. Never recorded on the execution." },
  { name: "CFMAN_BASE_URL", description: "Public base URL of this cfman instance." },
  { name: "CFMAN_TUNNEL_ID", description: "Id of the tunnel the execution is running on." }
];

const EXAMPLES: Record<"powershell" | "bash" | "sh", string> = {
  powershell: `$local = getRemoteFile 'artifacts/installers/agent.msi' 'C:\\cfman\\work' $true
Start-Process -FilePath msiexec -ArgumentList '/i', $local, '/qn' -Wait
uploadToRemote 'C:\\cfman\\work\\install.log' 'logs/install.log'`,
  bash: `local_file="$(getRemoteFile 'artifacts/installers/agent.tar.gz' /var/tmp true)"
tar -xzf "$local_file" -C /opt/agent
uploadToRemote /var/log/agent-install.log 'logs/install.log'`,
  sh: `local_file="$(getRemoteFile 'artifacts/installers/agent.tar.gz' /var/tmp true)"
tar -xzf "$local_file" -C /opt/agent
uploadToRemote /var/log/agent-install.log 'logs/install.log'`
};

export function FileHelperReference({ language, driver }: { language: "powershell" | "bash" | "sh"; driver?: StorageDriver | undefined }) {
  return <details className="file-helper-reference">
    <summary>File store helpers and variables available to this script</summary>
    <div className="file-helper-reference-body">
      <p>
        cfman prepends these to every script it dispatches, so a script addresses a file by its storage path and never builds a URL or an
        auth header. Paths are the same ones the Files page shows{driver ? `, stored ${driver === "s3" ? "in an S3-compatible bucket" : "in a directory on the cfman machine"}` : ""} -
        a script does not change when the storage does.
      </p>
      <pre><code>{EXAMPLES[language]}</code></pre>
      <dl>
        {HELPERS.map((helper) => <div key={helper.signature}><dt><code>{helper.signature}</code></dt><dd>{helper.description}</dd></div>)}
      </dl>
      <p className="file-helper-reference-variables-label">The helpers are built on these injected variables, which a script can also use directly:</p>
      <dl>
        {VARIABLES.map((variable) => <div key={variable.name}><dt><code>{variable.name}</code></dt><dd>{variable.description}</dd></div>)}
      </dl>
    </div>
  </details>;
}
