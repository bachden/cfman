// A storage path is a virtual POSIX path relative to whatever the configured
// driver treats as its root: the local base directory, or the bucket prefix.
// It never leaks the driver's own addressing - the webapp, automation scripts,
// and enrolled machines all speak this one path shape.

export class StoragePathError extends Error {
  // Read by the app's error handler, which answers with this status and lets
  // the message through for anything below 500.
  readonly statusCode = 400;
}

const MAX_SEGMENT_LENGTH = 255;
const MAX_PATH_LENGTH = 1024;
const MAX_DEPTH = 32;

// Rejected because at least one of the two drivers, or an operator's own shell,
// cannot address them: backslash and colon are path syntax on Windows, the
// wildcard set is unquotable in a shell, and control characters cannot survive
// an HTTP header or an S3 key round-trip.
const FORBIDDEN_IN_SEGMENT = /[\\:*?"<>|]|[\x00-\x1f\x7f]/;

export function normalizeStoragePath(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new StoragePathError("Path must be a string");
  const trimmed = input.trim();
  if (!trimmed || trimmed === "/" || trimmed === ".") return "";
  if (trimmed.length > MAX_PATH_LENGTH) throw new StoragePathError(`Path cannot exceed ${MAX_PATH_LENGTH} characters`);
  const segments: string[] = [];
  for (const rawSegment of trimmed.split("/")) {
    const segment = rawSegment.trim();
    if (!segment || segment === ".") continue;
    if (segment === "..") throw new StoragePathError('Path cannot contain ".."');
    if (segment.length > MAX_SEGMENT_LENGTH) throw new StoragePathError(`Each path segment cannot exceed ${MAX_SEGMENT_LENGTH} characters`);
    if (FORBIDDEN_IN_SEGMENT.test(segment)) throw new StoragePathError(`"${rawSegment}" contains a character that is not allowed in a path`);
    // Trailing dots and spaces are silently dropped by Windows, so a name that
    // relies on them would not round-trip once a machine downloads it.
    if (/[. ]$/.test(segment)) throw new StoragePathError(`"${segment}" cannot end with a dot or a space`);
    if (/^\.+$/.test(segment)) throw new StoragePathError("A path segment cannot consist only of dots");
    segments.push(segment);
  }
  if (segments.length > MAX_DEPTH) throw new StoragePathError(`Path cannot be deeper than ${MAX_DEPTH} folders`);
  const normalized = segments.join("/");
  if (normalized.length > MAX_PATH_LENGTH) throw new StoragePathError(`Path cannot exceed ${MAX_PATH_LENGTH} characters`);
  return normalized;
}

export function requireStoragePath(input: unknown): string {
  const path = normalizeStoragePath(input);
  if (!path) throw new StoragePathError("A path is required; the storage root itself cannot be addressed here");
  return path;
}

export function joinStoragePath(...parts: Array<string | undefined | null>): string {
  return normalizeStoragePath(parts.filter((part) => part !== undefined && part !== null && part !== "").join("/"));
}

export function storageBaseName(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? "";
}

export function storageParentPath(path: string): string {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/");
}

// Whether `path` is `root` itself or sits underneath it. The root "" contains
// everything, which is what makes an unrestricted caller expressible as a
// write root of "".
export function isPathWithin(root: string, path: string): boolean {
  if (!root) return true;
  return path === root || path.startsWith(`${root}/`);
}

const CONTENT_TYPES: Record<string, string> = {
  ".7z": "application/x-7z-compressed",
  ".bat": "text/plain; charset=utf-8",
  ".bmp": "image/bmp",
  ".cmd": "text/plain; charset=utf-8",
  ".conf": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".dll": "application/vnd.microsoft.portable-executable",
  ".env": "text/plain; charset=utf-8",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/vnd.microsoft.icon",
  ".ini": "text/plain; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".msi": "application/x-msi",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ps1": "text/plain; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".tgz": "application/gzip",
  ".toml": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip"
};

export function contentTypeForPath(path: string): string {
  const name = storageBaseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  return CONTENT_TYPES[name.slice(dot)] ?? "application/octet-stream";
}

// Turns an operator-chosen code (tenant code, tunnel code) into one path
// segment. A code that is already a usable segment is kept exactly as it is,
// case included, so the common case reads as the operator wrote it. Anything
// that had to be rewritten carries a short digest of the original, because two
// different codes can otherwise sanitize to the same segment and two machines
// would then share one upload folder.
export function storageSlug(value: string, digest: (input: string) => string): string {
  const trimmed = value.trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+/, "").replace(/[-.]+$/, "");
  const safe = sanitized || "unnamed";
  return safe === trimmed ? safe : `${safe}-${digest(value).slice(0, 6)}`;
}
