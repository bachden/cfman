import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import {
  contentTypeForPath,
  storageBaseName,
  storageParentPath
} from "./paths.js";
import { StorageError, type FileStorageBackend, type StorageEntry, type StorageStat, type StorageWriteSource } from "./types.js";

// The local driver maps the virtual path tree onto one base directory on the
// machine running cfman. The base path is deliberately never sent to the
// webapp: an operator who drops files straight into it sees them appear in the
// file manager, which is the whole point of pointing cfman at a real directory.
export class LocalFileStorage implements FileStorageBackend {
  readonly driver = "local" as const;

  constructor(private readonly basePath: string) {
    if (!isAbsolute(basePath)) throw new StorageError("FILE_STORAGE_LOCAL_PATH must be an absolute path", 500);
  }

  // Normalized paths already cannot contain ".." or a backslash, so this is a
  // second line of defence rather than the only one. It bounds the path cfman
  // itself builds; a symlink the operator placed inside the base directory is
  // still followed by the kernel, which is treated as the operator's own
  // decision about what belongs in their storage root.
  private absolute(path: string): string {
    const target = resolve(this.basePath, path);
    if (target !== this.basePath && !target.startsWith(this.basePath + sep)) {
      throw new StorageError("Path escapes the storage root");
    }
    return target;
  }

  private async ensureBase(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
  }

  async list(path: string): Promise<StorageEntry[]> {
    await this.ensureBase();
    const absolute = this.absolute(path);
    let dirents;
    try {
      dirents = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) throw new StorageError(`Folder not found: ${path || "/"}`, 404);
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new StorageError(`Not a folder: ${path}`, 409);
      throw error;
    }
    const entries: StorageEntry[] = [];
    for (const dirent of dirents) {
      const entryPath = path ? `${path}/${dirent.name}` : dirent.name;
      // A symlink is reported as whatever it points at; one that dangles or
      // escapes the base directory is skipped rather than shown as broken.
      let stats;
      try {
        stats = await stat(join(absolute, dirent.name));
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        entries.push({ name: dirent.name, path: entryPath, kind: "folder", size: null, modifiedAt: null, contentType: null });
      } else if (stats.isFile()) {
        entries.push({
          name: dirent.name,
          path: entryPath,
          kind: "file",
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          contentType: contentTypeForPath(entryPath)
        });
      }
    }
    return entries;
  }

  async stat(path: string): Promise<StorageStat | null> {
    await this.ensureBase();
    if (!path) {
      return { path: "", name: "", kind: "folder", size: 0, modifiedAt: null, contentType: "" };
    }
    try {
      const stats = await stat(this.absolute(path));
      if (stats.isDirectory()) {
        return { path, name: storageBaseName(path), kind: "folder", size: 0, modifiedAt: stats.mtime.toISOString(), contentType: "" };
      }
      if (!stats.isFile()) return null;
      return {
        path,
        name: storageBaseName(path),
        kind: "file",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        contentType: contentTypeForPath(path)
      };
    } catch (error) {
      if (isNotFound(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
      throw error;
    }
  }

  async read(path: string): Promise<{ stat: StorageStat; stream: Readable }> {
    const found = await this.requireFile(path);
    return { stat: found, stream: createReadStream(this.absolute(path)) };
  }

  async readBuffer(path: string, maxBytes: number): Promise<{ stat: StorageStat; data: Buffer }> {
    const found = await this.requireFile(path);
    if (found.size > maxBytes) {
      throw new StorageError(`${path} is ${found.size} bytes, which exceeds the ${maxBytes} byte limit for reading a file into memory`, 413);
    }
    const handle = await open(this.absolute(path), "r");
    try {
      return { stat: found, data: await handle.readFile() };
    } finally {
      await handle.close();
    }
  }

  async write(path: string, source: StorageWriteSource, contentType: string): Promise<StorageStat> {
    await this.ensureBase();
    const absolute = this.absolute(path);
    await this.rejectExistingFolder(path);
    await mkdir(this.absolute(storageParentPath(path)), { recursive: true });
    if (source.kind === "buffer") {
      // Written through a temp sibling and renamed, so a reader never observes
      // a half-written file at the destination path.
      const temporary = `${absolute}.cfman-${process.pid}-${Date.now()}.part`;
      const handle = await open(temporary, "w");
      try {
        await handle.writeFile(source.data);
      } finally {
        await handle.close();
      }
      await rename(temporary, absolute).catch(async (error: unknown) => {
        await unlink(temporary).catch(() => undefined);
        throw error;
      });
    } else {
      // The upload already landed in a temp file; rename when it is on the same
      // filesystem, copy when it is not.
      try {
        await rename(source.filePath, absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await copyFile(source.filePath, absolute);
      }
    }
    const written = await this.stat(path);
    if (!written || written.kind !== "file") throw new StorageError(`Unable to confirm the file written at ${path}`, 500);
    return { ...written, contentType };
  }

  async createFolder(path: string): Promise<void> {
    await this.ensureBase();
    const existing = await this.stat(path);
    if (existing?.kind === "file") throw new StorageError(`A file already exists at ${path}`, 409);
    await mkdir(this.absolute(path), { recursive: true });
  }

  async remove(path: string, options: { recursive: boolean }): Promise<void> {
    const existing = await this.stat(path);
    if (!existing) throw new StorageError(`Nothing exists at ${path}`, 404);
    if (existing.kind === "folder" && !options.recursive) {
      const children = await this.list(path);
      if (children.length) throw new StorageError(`${path} is not empty; deleting it requires the recursive option`, 409);
    }
    await rm(this.absolute(path), { recursive: true, force: true });
  }

  async move(from: string, to: string): Promise<void> {
    const source = await this.stat(from);
    if (!source) throw new StorageError(`Nothing exists at ${from}`, 404);
    if (await this.stat(to)) throw new StorageError(`${to} already exists`, 409);
    await mkdir(this.absolute(storageParentPath(to)), { recursive: true });
    await rename(this.absolute(from), this.absolute(to));
  }

  private async requireFile(path: string): Promise<StorageStat> {
    const found = await this.stat(path);
    if (!found) throw new StorageError(`File not found: ${path}`, 404);
    if (found.kind !== "file") throw new StorageError(`${path} is a folder, not a file`, 409);
    return found;
  }

  private async rejectExistingFolder(path: string): Promise<void> {
    const existing = await this.stat(path);
    if (existing?.kind === "folder") throw new StorageError(`A folder already exists at ${path}`, 409);
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
