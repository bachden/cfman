import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { request as undiciRequest } from "undici";
import { contentTypeForPath, storageBaseName } from "./paths.js";
import { encodeS3Path, sha256Hex, signSigV4, type SigV4Credentials } from "./sigv4.js";
import { StorageError, type FileStorageBackend, type StorageEntry, type StorageStat, type StorageWriteSource } from "./types.js";

export type S3StorageOptions = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  credentials: SigV4Credentials;
};

// A folder has no existence of its own in object storage, so an explicitly
// created one is recorded as a zero-byte object whose key ends in "/" - the
// same marker the S3 console and the AWS CLI use. It is how an empty folder
// survives a page reload, and it is hidden from listings.
const FOLDER_MARKER = "/";

const LIST_PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 60_000;

// What one S3 call hands back. Only the few header fields the driver reads are
// kept, so the rest of the class never deals with undici's header shapes.
type S3Response = {
  status: number;
  ok: boolean;
  contentLength: number;
  contentType: string | null;
  lastModified: string | null;
  text: () => Promise<string>;
  buffer: () => Promise<Buffer>;
  stream: Readable;
  discard: () => Promise<void>;
};

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export class S3FileStorage implements FileStorageBackend {
  readonly driver = "s3" as const;
  private readonly prefix: string;

  constructor(private readonly options: S3StorageOptions) {
    this.prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  }

  private keyFor(path: string): string {
    return `${this.prefix}${path}`;
  }

  private pathFor(key: string): string {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }

  private url(key: string, query?: Record<string, string | undefined>): URL {
    const base = new URL(this.options.endpoint);
    const encodedKey = encodeS3Path(key);
    const url = this.options.forcePathStyle
      ? new URL(`${base.origin}${base.pathname.replace(/\/+$/, "")}/${encodeURIComponent(this.options.bucket)}${encodedKey}`)
      : new URL(`${base.protocol}//${this.options.bucket}.${base.host}${encodedKey}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    return url;
  }

  // undici's request, not global fetch: an upload is a Node stream with a
  // Content-Length the driver already knows, and fetch is free to turn that
  // into a chunked body. Cloudflare R2 rejects a chunked PutObject outright,
  // so the explicit length has to survive down to the wire.
  private async send(
    method: string,
    url: URL,
    init: { headers?: Record<string, string>; body?: Buffer | Readable; payloadHash: string; contentLength?: number }
  ): Promise<S3Response> {
    const headers = signSigV4({
      method,
      url,
      headers: {
        ...init.headers,
        // S3 wants the payload hash as a header as well as in the signature,
        // and R2 rejects a request that omits it.
        "x-amz-content-sha256": init.payloadHash,
        ...(init.contentLength !== undefined ? { "content-length": String(init.contentLength) } : {})
      },
      payloadHash: init.payloadHash,
      region: this.options.region,
      service: "s3",
      credentials: this.options.credentials
    });
    try {
      const response = await undiciRequest(url, {
        method: method as "GET" | "PUT" | "HEAD" | "DELETE" | "POST",
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      return {
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        contentLength: Number(headerValue(response.headers["content-length"]) ?? 0),
        contentType: headerValue(response.headers["content-type"]),
        lastModified: headerValue(response.headers["last-modified"]),
        text: () => response.body.text(),
        buffer: async () => Buffer.from(await response.body.arrayBuffer()),
        stream: response.body,
        discard: async () => { await response.body.dump().catch(() => undefined); }
      };
    } catch (error) {
      throw new StorageError(`Unable to reach the S3 endpoint: ${error instanceof Error ? error.message : "request failed"}`, 502);
    }
  }

  private async fail(response: S3Response, path: string): Promise<never> {
    const body = await response.text().catch(() => "");
    const message = firstTag(body, "Message") ?? firstTag(body, "Code") ?? `S3 returned HTTP ${response.status}`;
    if (response.status === 404) throw new StorageError(`Not found: ${path || "/"}`, 404);
    if (response.status === 403) throw new StorageError(`The S3 credentials are not allowed to do this: ${message}`, 502);
    throw new StorageError(`S3 request failed: ${message}`, response.status >= 500 ? 502 : 400);
  }

  async list(path: string): Promise<StorageEntry[]> {
    const prefix = path ? `${this.keyFor(path)}/` : this.prefix;
    const entries: StorageEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const url = this.url("", {
        "list-type": "2",
        prefix,
        delimiter: "/",
        "encoding-type": "url",
        "max-keys": String(LIST_PAGE_SIZE),
        "continuation-token": continuationToken
      });
      const response = await this.send("GET", url, { payloadHash: sha256Hex("") });
      if (!response.ok) await this.fail(response, path);
      const xml = await response.text();
      for (const block of blocks(xml, "CommonPrefixes")) {
        const rawPrefix = decodeListValue(firstTag(block, "Prefix") ?? "");
        if (!rawPrefix) continue;
        const entryPath = this.pathFor(rawPrefix.replace(/\/+$/, ""));
        entries.push({ name: storageBaseName(entryPath), path: entryPath, kind: "folder", size: null, modifiedAt: null, contentType: null });
      }
      for (const block of blocks(xml, "Contents")) {
        const key = decodeListValue(firstTag(block, "Key") ?? "");
        if (!key || key === prefix || key.endsWith(FOLDER_MARKER)) continue;
        const entryPath = this.pathFor(key);
        const lastModified = firstTag(block, "LastModified");
        entries.push({
          name: storageBaseName(entryPath),
          path: entryPath,
          kind: "file",
          size: Number(firstTag(block, "Size") ?? 0),
          modifiedAt: lastModified ? new Date(lastModified).toISOString() : null,
          contentType: contentTypeForPath(entryPath)
        });
      }
      continuationToken = firstTag(xml, "IsTruncated") === "true" ? decodeListValue(firstTag(xml, "NextContinuationToken") ?? "") : undefined;
    } while (continuationToken);
    return entries;
  }

  async stat(path: string): Promise<StorageStat | null> {
    if (!path) return { path: "", name: "", kind: "folder", size: 0, modifiedAt: null, contentType: "" };
    const response = await this.send("HEAD", this.url(this.keyFor(path)), { payloadHash: sha256Hex("") });
    if (response.ok) {
      await response.discard();
      return {
        path,
        name: storageBaseName(path),
        kind: "file",
        size: response.contentLength,
        modifiedAt: response.lastModified ? new Date(response.lastModified).toISOString() : null,
        contentType: response.contentType || contentTypeForPath(path)
      };
    }
    if (response.status !== 404) await this.fail(response, path);
    await response.discard();
    return (await this.folderExists(path))
      ? { path, name: storageBaseName(path), kind: "folder", size: 0, modifiedAt: null, contentType: "" }
      : null;
  }

  private async folderExists(path: string): Promise<boolean> {
    const url = this.url("", { "list-type": "2", prefix: `${this.keyFor(path)}/`, "max-keys": "1", "encoding-type": "url" });
    const response = await this.send("GET", url, { payloadHash: sha256Hex("") });
    if (!response.ok) await this.fail(response, path);
    const xml = await response.text();
    return firstTag(xml, "Key") !== undefined;
  }

  async read(path: string): Promise<{ stat: StorageStat; stream: Readable }> {
    const response = await this.send("GET", this.url(this.keyFor(path)), { payloadHash: sha256Hex("") });
    if (!response.ok) {
      if (response.status === 404) {
        await response.discard();
        if (await this.folderExists(path)) throw new StorageError(`${path} is a folder, not a file`, 409);
        throw new StorageError(`File not found: ${path}`, 404);
      }
      await this.fail(response, path);
    }
    return {
      stat: {
        path,
        name: storageBaseName(path),
        kind: "file",
        size: response.contentLength,
        modifiedAt: response.lastModified ? new Date(response.lastModified).toISOString() : null,
        contentType: response.contentType || contentTypeForPath(path)
      },
      stream: response.stream
    };
  }

  async readBuffer(path: string, maxBytes: number): Promise<{ stat: StorageStat; data: Buffer }> {
    const found = await this.stat(path);
    if (!found) throw new StorageError(`File not found: ${path}`, 404);
    if (found.kind !== "file") throw new StorageError(`${path} is a folder, not a file`, 409);
    if (found.size > maxBytes) {
      throw new StorageError(`${path} is ${found.size} bytes, which exceeds the ${maxBytes} byte limit for reading a file into memory`, 413);
    }
    const response = await this.send("GET", this.url(this.keyFor(path)), { payloadHash: sha256Hex("") });
    if (!response.ok) await this.fail(response, path);
    return { stat: found, data: await response.buffer() };
  }

  async write(path: string, source: StorageWriteSource, contentType: string): Promise<StorageStat> {
    if (await this.folderExists(path)) throw new StorageError(`A folder already exists at ${path}`, 409);
    const size = source.kind === "buffer" ? source.data.byteLength : source.size;
    const response = await this.send("PUT", this.url(this.keyFor(path)), {
      headers: { "content-type": contentType },
      body: source.kind === "buffer" ? source.data : createReadStream(source.filePath),
      payloadHash: source.kind === "buffer" ? sha256Hex(source.data) : source.sha256,
      contentLength: size
    });
    if (!response.ok) await this.fail(response, path);
    await response.discard();
    return { path, name: storageBaseName(path), kind: "file", size, modifiedAt: new Date().toISOString(), contentType };
  }

  async createFolder(path: string): Promise<void> {
    const existing = await this.stat(path);
    if (existing?.kind === "file") throw new StorageError(`A file already exists at ${path}`, 409);
    const response = await this.send("PUT", this.url(`${this.keyFor(path)}${FOLDER_MARKER}`), {
      headers: { "content-type": "application/x-directory" },
      body: Buffer.alloc(0),
      payloadHash: sha256Hex(""),
      contentLength: 0
    });
    if (!response.ok) await this.fail(response, path);
    await response.discard();
  }

  async remove(path: string, options: { recursive: boolean }): Promise<void> {
    const found = await this.stat(path);
    if (!found) throw new StorageError(`Nothing exists at ${path}`, 404);
    if (found.kind === "file") {
      await this.deleteKey(this.keyFor(path), path);
      return;
    }
    const keys = await this.listAllKeys(`${this.keyFor(path)}/`);
    const contentKeys = keys.filter((key) => key !== `${this.keyFor(path)}${FOLDER_MARKER}`);
    if (contentKeys.length && !options.recursive) {
      throw new StorageError(`${path} is not empty; deleting it requires the recursive option`, 409);
    }
    await this.deleteKeys([...keys, `${this.keyFor(path)}${FOLDER_MARKER}`], path);
  }

  async move(from: string, to: string): Promise<void> {
    const source = await this.stat(from);
    if (!source) throw new StorageError(`Nothing exists at ${from}`, 404);
    if (await this.stat(to)) throw new StorageError(`${to} already exists`, 409);
    if (source.kind === "file") {
      await this.copyKey(this.keyFor(from), this.keyFor(to), from);
      await this.deleteKey(this.keyFor(from), from);
      return;
    }
    const fromPrefix = `${this.keyFor(from)}/`;
    const toPrefix = `${this.keyFor(to)}/`;
    // listAllKeys covers the folder's own marker object too, since its key is
    // the prefix itself, so copying every listed key reproduces an empty
    // folder as faithfully as a full one.
    const keys = await this.listAllKeys(fromPrefix);
    for (const key of keys) {
      await this.copyKey(key, `${toPrefix}${key.slice(fromPrefix.length)}`, from);
    }
    if (!keys.length) await this.createFolder(to);
    await this.deleteKeys(keys, from);
  }

  private async listAllKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const url = this.url("", {
        "list-type": "2",
        prefix,
        "encoding-type": "url",
        "max-keys": String(LIST_PAGE_SIZE),
        "continuation-token": continuationToken
      });
      const response = await this.send("GET", url, { payloadHash: sha256Hex("") });
      if (!response.ok) await this.fail(response, this.pathFor(prefix));
      const xml = await response.text();
      for (const block of blocks(xml, "Contents")) {
        const key = decodeListValue(firstTag(block, "Key") ?? "");
        if (key) keys.push(key);
      }
      continuationToken = firstTag(xml, "IsTruncated") === "true" ? decodeListValue(firstTag(xml, "NextContinuationToken") ?? "") : undefined;
    } while (continuationToken);
    return keys;
  }

  private async copyKey(fromKey: string, toKey: string, path: string): Promise<void> {
    const response = await this.send("PUT", this.url(toKey), {
      headers: { "x-amz-copy-source": `/${this.options.bucket}${encodeS3Path(fromKey)}` },
      payloadHash: sha256Hex(""),
      contentLength: 0
    });
    if (!response.ok) await this.fail(response, path);
    // A CopyObject can report failure inside a 200 body, so the result is read
    // rather than discarded.
    const body = await response.text().catch(() => "");
    if (firstTag(body, "Code")) throw new StorageError(`S3 copy failed: ${firstTag(body, "Message") ?? firstTag(body, "Code")}`, 502);
  }

  private async deleteKey(key: string, path: string): Promise<void> {
    const response = await this.send("DELETE", this.url(key), { payloadHash: sha256Hex("") });
    if (!response.ok && response.status !== 404) await this.fail(response, path);
    await response.discard();
  }

  private async deleteKeys(keys: string[], path: string): Promise<void> {
    const unique = [...new Set(keys)];
    const concurrency = 8;
    for (let index = 0; index < unique.length; index += concurrency) {
      await Promise.all(unique.slice(index, index + concurrency).map((key) => this.deleteKey(key, path)));
    }
  }
}

// Minimal XML reading for the three list responses this driver issues. S3's
// list XML has no attributes, no namespaces on the elements read here, and no
// nesting of the same element name, so matching the element pair is enough -
// and far less to maintain than a parser dependency.
function firstTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXmlEntities(match[1]!) : undefined;
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1]!);
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

// Keys come back percent-encoded because every list request asks for
// encoding-type=url, which is what keeps a key containing a character XML
// cannot carry (a newline, say) intact.
function decodeListValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
