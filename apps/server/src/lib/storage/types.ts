import type { Readable } from "node:stream";

export type StorageDriver = "local" | "s3";

export type StorageEntryKind = "file" | "folder";

export type StorageEntry = {
  name: string;
  path: string;
  kind: StorageEntryKind;
  // A folder has no size or timestamp of its own: neither driver tracks one
  // the other could reproduce, so the webapp shows a dash rather than a value
  // that would change meaning with the driver.
  size: number | null;
  modifiedAt: string | null;
  contentType: string | null;
};

export type StorageStat = {
  path: string;
  name: string;
  kind: StorageEntryKind;
  size: number;
  modifiedAt: string | null;
  contentType: string;
};

// A body that has already been measured, so a driver that needs the length up
// front (S3 signs it) never has to buffer the whole thing to find out.
export type StorageWriteSource =
  | { kind: "buffer"; data: Buffer }
  | { kind: "file"; filePath: string; size: number; sha256: string };

export class StorageError extends Error {
  constructor(message: string, public readonly statusCode: number = 400) {
    super(message);
  }
}

export interface FileStorageBackend {
  readonly driver: StorageDriver;
  /** Direct children of one folder. The storage root is the empty path. */
  list(path: string): Promise<StorageEntry[]>;
  /** Null when nothing exists at the path, under either kind. */
  stat(path: string): Promise<StorageStat | null>;
  read(path: string): Promise<{ stat: StorageStat; stream: Readable }>;
  readBuffer(path: string, maxBytes: number): Promise<{ stat: StorageStat; data: Buffer }>;
  write(path: string, source: StorageWriteSource, contentType: string): Promise<StorageStat>;
  createFolder(path: string): Promise<void>;
  remove(path: string, options: { recursive: boolean }): Promise<void>;
  move(from: string, to: string): Promise<void>;
}
