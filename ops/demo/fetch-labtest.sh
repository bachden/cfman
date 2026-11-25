#!/usr/bin/env bash
# Demo: pull a file out of the cfman file store onto the target machine.
#
# Run it through cfman (MCP cfman_execute_inline_script / cfman_execute_script,
# or the Execute panel in the web UI) against the tunnel "Bach's AI Station".
# cfman prepends the file-store helpers (getRemoteFile, listRemoteFiles,
# remoteFileExists, uploadToRemote, removeRemoteFile) and the CFMAN_* variables
# to every dispatched script, so this body never builds a URL or an auth header.
#
# Running it directly from a shell will fail on purpose: getRemoteFile only
# exists inside a cfman execution.

set -euo pipefail

REMOTE_PATH="labtest.txt"
DEST_DIR="/root/cfman-demo"

echo "== cfman file-store demo =="
echo "instance   : ${CFMAN_BASE_URL}"
echo "tunnel     : ${CFMAN_TUNNEL_ID}"
echo "host       : $(hostname)"
echo "upload root: ${CFMAN_FILES_UPLOAD_ROOT}"
echo

echo "-- 1. what is in the store root"
listRemoteFiles ""
echo

echo "-- 2. does ${REMOTE_PATH} exist"
if remoteFileExists "${REMOTE_PATH}"; then
  echo "yes"
else
  echo "no - nothing to fetch, aborting"
  exit 1
fi
echo

echo "-- 3. download it to ${DEST_DIR}"
mkdir -p "${DEST_DIR}"
LOCAL_PATH="$(getRemoteFile "${REMOTE_PATH}" "${DEST_DIR}")"
echo "landed at: ${LOCAL_PATH}"
echo

echo "-- 4. proof it is really here"
ls -l "${LOCAL_PATH}"
echo "sha256: $(sha256sum "${LOCAL_PATH}" | cut -d' ' -f1)"
echo "bytes : $(wc -c < "${LOCAL_PATH}")"
echo "---- content ----"
cat "${LOCAL_PATH}"
echo "---- end ----"
