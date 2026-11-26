import { createHash } from "node:crypto";
import { config } from "../../config.js";
import { getMaxUploadMb } from "../app-settings.js";
import { pool } from "../database.js";
import { LocalFileStorage } from "./local.js";
import { joinStoragePath, storageSlug } from "./paths.js";
import { S3FileStorage } from "./s3.js";
import { StorageError, type FileStorageBackend, type StorageDriver } from "./types.js";

export * from "./paths.js";
export * from "./types.js";

// Operator-editable in Settings rather than fixed at boot, so raising the
// limit does not need a redeploy. Read per request; the setting is one small
// row and an upload is already doing far more work than that lookup.
export async function getMaxUploadBytes(): Promise<number> {
  return (await getMaxUploadMb()) * 1024 * 1024;
}

// The ceiling on a file read into memory instead of streamed: an automation
// script receives the bytes through a worker postMessage, and an MCP tool
// through a JSON response, so neither can carry an arbitrarily large file.
export const MAX_INLINE_READ_BYTES = 8 * 1024 * 1024;

type StorageConfiguration =
  | { ok: true; backend: FileStorageBackend }
  | { ok: false; error: string };

let cached: StorageConfiguration | null = null;

function build(): StorageConfiguration {
  try {
    if (config.FILE_STORAGE_DRIVER === "local") {
      return { ok: true, backend: new LocalFileStorage(config.FILE_STORAGE_LOCAL_PATH) };
    }
    const missing = (
      [
        ["FILE_STORAGE_S3_ENDPOINT", config.FILE_STORAGE_S3_ENDPOINT],
        ["FILE_STORAGE_S3_BUCKET", config.FILE_STORAGE_S3_BUCKET],
        ["FILE_STORAGE_S3_ACCESS_KEY_ID", config.FILE_STORAGE_S3_ACCESS_KEY_ID],
        ["FILE_STORAGE_S3_SECRET_ACCESS_KEY", config.FILE_STORAGE_S3_SECRET_ACCESS_KEY]
      ] as const
    ).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
      return { ok: false, error: `S3 file storage is selected but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set` };
    }
    return {
      ok: true,
      backend: new S3FileStorage({
        endpoint: config.FILE_STORAGE_S3_ENDPOINT!,
        region: config.FILE_STORAGE_S3_REGION,
        bucket: config.FILE_STORAGE_S3_BUCKET!,
        prefix: config.FILE_STORAGE_S3_PREFIX,
        forcePathStyle: config.FILE_STORAGE_S3_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: config.FILE_STORAGE_S3_ACCESS_KEY_ID!,
          secretAccessKey: config.FILE_STORAGE_S3_SECRET_ACCESS_KEY!,
          sessionToken: config.FILE_STORAGE_S3_SESSION_TOKEN
        }
      })
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "File storage is misconfigured" };
  }
}

function configuration(): StorageConfiguration {
  cached ??= build();
  return cached;
}

export function fileStorage(): FileStorageBackend {
  const resolved = configuration();
  // A misconfiguration is reported per request rather than at boot: cfman's
  // other work (tunnels, enrollments, executions) does not depend on file
  // storage, and refusing to start would take all of it down with it.
  if (!resolved.ok) throw new StorageError(resolved.error, 503);
  return resolved.backend;
}

// What the webapp is allowed to know: the kind of storage, and whether it is
// usable. Never the base path, bucket, endpoint, or credentials. Everything
// here comes from the service environment, so it needs no database round trip
// and stays usable from the audit-log call sites that only want the driver.
export function fileStorageInfo(): { driver: StorageDriver; configured: boolean; error: string | null; tunnelUploadPrefix: string } {
  const resolved = configuration();
  return {
    driver: config.FILE_STORAGE_DRIVER,
    configured: resolved.ok,
    error: resolved.ok ? null : resolved.error,
    tunnelUploadPrefix: config.FILE_STORAGE_TUNNEL_UPLOAD_PREFIX
  };
}

/** The same thing plus the operator-set upload limit: what the API answers with. */
export async function fileStorageSettings(): Promise<ReturnType<typeof fileStorageInfo> & { maxUploadBytes: number }> {
  return { ...fileStorageInfo(), maxUploadBytes: await getMaxUploadBytes() };
}

function shortDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The one folder an enrolled machine may write into. Derived from the tunnel's
// own identity rather than stored, so it cannot drift from the tunnel it
// belongs to, and handed to every script as CFMAN_FILES_UPLOAD_ROOT so a
// script never has to guess at it.
export function tunnelUploadRoot(tenantCode: string, tunnelCode: string): string {
  return joinStoragePath(
    config.FILE_STORAGE_TUNNEL_UPLOAD_PREFIX,
    storageSlug(tenantCode, shortDigest),
    storageSlug(tunnelCode, shortDigest)
  );
}

// The variables every script running on an enrolled machine receives so it can
// reach the file store without being told any of this by its author. They are
// put in the dispatched script's prologue only - never recorded on the
// execution row - because CFMAN_AGENT_TOKEN is a live credential and execution
// history is read by anyone who can see the tunnel.
export const FILE_STORAGE_SCRIPT_VARIABLES = [
  { name: "CFMAN_BASE_URL", description: "Public base URL of this cfman instance." },
  { name: "CFMAN_TUNNEL_ID", description: "Id of the tunnel this execution is running on." },
  { name: "CFMAN_AGENT_TOKEN", description: "The machine's command-agent token, sent as the X-Cloudflare-Man-Agent-Token header on a file-store request." },
  { name: "CFMAN_FILES_URL", description: "File-store endpoint for this machine. Append ?path=<storage path> to download, and PUT the body to the same URL with /content to upload." },
  { name: "CFMAN_FILES_UPLOAD_ROOT", description: "The only folder this machine may write into. Every upload path has to start with it." }
] as const;

export function fileStorageScriptVariables(input: {
  publicBaseUrl: string;
  tunnelId: string;
  agentToken: string;
  tenantCode: string;
  tunnelCode: string;
}): Record<string, string> {
  return {
    CFMAN_BASE_URL: input.publicBaseUrl,
    CFMAN_TUNNEL_ID: input.tunnelId,
    CFMAN_AGENT_TOKEN: input.agentToken,
    CFMAN_FILES_URL: `${input.publicBaseUrl}/api/public/tunnels/${input.tunnelId}/files`,
    CFMAN_FILES_UPLOAD_ROOT: tunnelUploadRoot(input.tenantCode, input.tunnelCode)
  };
}

export async function tunnelUploadRootById(tunnelId: string): Promise<string> {
  const result = await pool.query("SELECT tenant_code, tunnel_code FROM tunnels WHERE id = $1", [tunnelId]);
  const row = result.rows[0];
  if (!row) throw new StorageError("Tunnel not found", 404);
  return tunnelUploadRoot(row.tenant_code as string, row.tunnel_code as string);
}
