import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { fileStorage, MAX_INLINE_READ_BYTES } from "./index.js";
import {
  contentTypeForPath,
  isPathWithin,
  normalizeStoragePath,
  requireStoragePath,
  storageParentPath
} from "./paths.js";
import { StorageError, type StorageEntry, type StorageStat } from "./types.js";

export type FolderListing = {
  path: string;
  parent: string | null;
  entries: StorageEntry[];
};

// Folders first, then files, each A-Z and case-insensitively: the same order
// the webapp would otherwise have to re-derive, and the order an automation
// script can rely on without sorting.
function compareEntries(left: StorageEntry, right: StorageEntry): number {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

export async function listFolder(rawPath: unknown): Promise<FolderListing> {
  const path = normalizeStoragePath(rawPath);
  const entries = await fileStorage().list(path);
  return { path, parent: path ? storageParentPath(path) : null, entries: entries.sort(compareEntries) };
}

export async function statPath(rawPath: unknown): Promise<StorageStat | null> {
  return fileStorage().stat(normalizeStoragePath(rawPath));
}

export async function openFile(rawPath: unknown): Promise<{ stat: StorageStat; stream: Readable }> {
  return fileStorage().read(requireStoragePath(rawPath));
}

export type InlineEncoding = "utf8" | "base64";

export async function readFileInline(
  rawPath: unknown,
  encoding: InlineEncoding = "utf8"
): Promise<{ path: string; name: string; contentType: string; size: number; modifiedAt: string | null; encoding: InlineEncoding; content: string }> {
  const path = requireStoragePath(rawPath);
  const { stat, data } = await fileStorage().readBuffer(path, MAX_INLINE_READ_BYTES);
  return {
    path,
    name: stat.name,
    contentType: stat.contentType,
    size: stat.size,
    modifiedAt: stat.modifiedAt,
    encoding,
    content: data.toString(encoding)
  };
}

export async function writeFileInline(
  rawPath: unknown,
  content: string,
  options: { encoding?: InlineEncoding; contentType?: string | undefined; writeRoot?: string } = {}
): Promise<StorageStat> {
  const path = enforceWriteRoot(requireStoragePath(rawPath), options.writeRoot ?? "");
  const data = Buffer.from(content, options.encoding ?? "utf8");
  if (data.byteLength > MAX_INLINE_READ_BYTES) {
    throw new StorageError(`Content is ${data.byteLength} bytes, which exceeds the ${MAX_INLINE_READ_BYTES} byte limit for writing a file inline`, 413);
  }
  return fileStorage().write(path, { kind: "buffer", data }, options.contentType || contentTypeForPath(path));
}

export async function createFolder(rawPath: unknown, options: { writeRoot?: string } = {}): Promise<{ path: string }> {
  const path = enforceWriteRoot(requireStoragePath(rawPath), options.writeRoot ?? "");
  await fileStorage().createFolder(path);
  return { path };
}

export async function removePath(
  rawPath: unknown,
  options: { recursive?: boolean; writeRoot?: string } = {}
): Promise<{ path: string }> {
  const path = enforceWriteRoot(requireStoragePath(rawPath), options.writeRoot ?? "");
  await fileStorage().remove(path, { recursive: options.recursive ?? false });
  return { path };
}

export async function movePath(
  rawFrom: unknown,
  rawTo: unknown,
  options: { writeRoot?: string } = {}
): Promise<{ from: string; to: string }> {
  const writeRoot = options.writeRoot ?? "";
  const from = enforceWriteRoot(requireStoragePath(rawFrom), writeRoot);
  const to = enforceWriteRoot(requireStoragePath(rawTo), writeRoot);
  if (from === to) throw new StorageError("The source and destination paths are the same", 400);
  if (isPathWithin(from, to)) throw new StorageError("A folder cannot be moved inside itself", 400);
  await fileStorage().move(from, to);
  return { from, to };
}

// A caller with a write root can read the whole store but only change things
// inside its own folder. The webapp passes no root, an enrolled machine passes
// its tunnel's upload folder.
export function enforceWriteRoot(path: string, writeRoot: string): string {
  if (!writeRoot) return path;
  if (!isPathWithin(writeRoot, path)) {
    throw new StorageError(`Writing is only allowed under ${writeRoot}/`, 403);
  }
  if (path === writeRoot) throw new StorageError(`${writeRoot} is the upload root itself and cannot be changed`, 403);
  return path;
}

export type SpooledUpload = {
  filePath: string;
  size: number;
  sha256: string;
  cleanup: () => Promise<void>;
};

// An upload is spooled to a temp file before it reaches the driver. Both
// drivers need the exact length up front - the local one to rename a complete
// file into place, the S3 one to sign and declare Content-Length, which R2
// requires - and spooling is what keeps a large upload off the heap while
// still knowing it.
export async function spoolUpload(body: Readable, maxBytes: number): Promise<SpooledUpload> {
  const directory = await mkdtemp(join(tmpdir(), "cfman-upload-"));
  const filePath = join(directory, "payload");
  const cleanup = () => rm(directory, { recursive: true, force: true }).catch(() => undefined);
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new StorageError(`Upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`, 413));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(body, meter, createWriteStream(filePath));
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { filePath, size, sha256: hash.digest("hex"), cleanup };
}

export async function writeSpooledUpload(
  rawPath: unknown,
  upload: SpooledUpload,
  options: { contentType?: string | undefined; writeRoot?: string } = {}
): Promise<StorageStat> {
  const path = enforceWriteRoot(requireStoragePath(rawPath), options.writeRoot ?? "");
  const contentType = normalizeContentType(options.contentType) || contentTypeForPath(path);
  return fileStorage().write(path, { kind: "file", filePath: upload.filePath, size: upload.size, sha256: upload.sha256 }, contentType);
}

// A browser PUT of a File sends the file's own type, which is worth keeping,
// but an agent that sends nothing useful should not pin the stored type to
// application/octet-stream when the extension says more.
function normalizeContentType(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "application/octet-stream") return "";
  return trimmed.slice(0, 200);
}
