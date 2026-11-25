import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";

const { encodeS3Path, sha256Hex, signSigV4 } = await import("../src/lib/storage/sigv4.js");
const { normalizeStoragePath, requireStoragePath, StoragePathError, isPathWithin, storageSlug, contentTypeForPath } =
  await import("../src/lib/storage/paths.js");
const { LocalFileStorage } = await import("../src/lib/storage/local.js");

let base = "";

before(async () => {
  base = await mkdtemp(join(tmpdir(), "cfman-storage-test-"));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

test("a storage path is normalized to a clean relative POSIX path", () => {
  assert.equal(normalizeStoragePath(undefined), "");
  assert.equal(normalizeStoragePath("/"), "");
  assert.equal(normalizeStoragePath("  /artifacts//installers/ "), "artifacts/installers");
  assert.equal(normalizeStoragePath("./artifacts/./agent.msi"), "artifacts/agent.msi");
  assert.equal(normalizeStoragePath("artifacts/My Report (final).csv"), "artifacts/My Report (final).csv");
  // Each segment is trimmed before it is checked, so stray whitespace around a
  // name an operator typed is cleaned up rather than refused.
  assert.equal(normalizeStoragePath("artifacts / trailing "), "artifacts/trailing");
});

test("a storage path cannot escape the root or carry an unaddressable name", () => {
  for (const rejected of ["../etc/passwd", "artifacts/../../etc", "a/..", "artifacts\\agent.msi", "C:/windows", "a/b?c", 'a/"b"', "a/b|c", "artifacts/trailing.", "artifacts/trailing .", "artifacts/..."]) {
    assert.throws(() => normalizeStoragePath(rejected), StoragePathError, `expected ${rejected} to be rejected`);
  }
  assert.throws(() => requireStoragePath("/"), StoragePathError);
});

test("a write root bounds what an enrolled machine may change", () => {
  assert.equal(isPathWithin("uploads/idealab/ldap", "uploads/idealab/ldap/report.csv"), true);
  assert.equal(isPathWithin("uploads/idealab/ldap", "uploads/idealab/ldap"), true);
  assert.equal(isPathWithin("uploads/idealab/ldap", "uploads/idealab/ldap-other/report.csv"), false);
  assert.equal(isPathWithin("uploads/idealab/ldap", "artifacts/agent.msi"), false);
  // No root at all means the whole store, which is what the webapp gets.
  assert.equal(isPathWithin("", "anything/at/all"), true);
});

test("a code that is already path-safe becomes itself, and one that is not stays distinguishable", () => {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  assert.equal(storageSlug("idealab-metadata", digest), "idealab-metadata");
  // Tenant codes are free-form text, so two that sanitize to the same stem
  // must not end up sharing one machine's upload folder.
  assert.equal(storageSlug("ideaLAB", digest), "ideaLAB");
  const sanitized = storageSlug("idea LAB", digest);
  assert.match(sanitized, /^idea-LAB-[0-9a-f]{6}$/);
  assert.notEqual(sanitized, storageSlug("idea-LAB", digest));
  assert.notEqual(storageSlug("idea/LAB", digest), sanitized);
  assert.equal(storageSlug("!!!", digest).startsWith("unnamed-"), true);
});

test("content type comes from the extension", () => {
  assert.equal(contentTypeForPath("artifacts/agent.msi"), "application/x-msi");
  assert.equal(contentTypeForPath("a/b/report.CSV"), "text/csv; charset=utf-8");
  assert.equal(contentTypeForPath("artifacts/noextension"), "application/octet-stream");
});

test("the local driver reads back what it wrote, including folders and moves", async () => {
  const storage = new LocalFileStorage(base);

  await storage.createFolder("artifacts/installers");
  assert.equal((await storage.stat("artifacts/installers"))?.kind, "folder");

  const payload = Buffer.from("MZ fake installer", "utf8");
  const written = await storage.write("artifacts/installers/agent.msi", { kind: "buffer", data: payload }, "application/x-msi");
  assert.equal(written.size, payload.byteLength);
  assert.equal(written.kind, "file");

  const listing = await storage.list("artifacts");
  assert.deepEqual(listing.map((entry) => `${entry.kind}:${entry.name}`), ["folder:installers"]);

  const read = await storage.readBuffer("artifacts/installers/agent.msi", 1024 * 1024);
  assert.equal(read.data.toString("utf8"), "MZ fake installer");

  const streamed = await storage.read("artifacts/installers/agent.msi");
  const chunks: Buffer[] = [];
  for await (const chunk of streamed.stream) chunks.push(chunk as Buffer);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "MZ fake installer");

  await storage.move("artifacts/installers/agent.msi", "artifacts/installers/agent-1.0.msi");
  assert.equal(await storage.stat("artifacts/installers/agent.msi"), null);
  assert.equal((await storage.stat("artifacts/installers/agent-1.0.msi"))?.size, payload.byteLength);

  // A non-empty folder is kept until the caller says recursive, so a wrong
  // path cannot quietly delete a tree.
  await assert.rejects(() => storage.remove("artifacts/installers", { recursive: false }), /not empty/);
  await storage.remove("artifacts/installers", { recursive: true });
  assert.equal(await storage.stat("artifacts/installers"), null);
});

test("the local driver refuses to address anything outside its base directory", async () => {
  const storage = new LocalFileStorage(base);
  // normalizeStoragePath is the first gate; this is the driver's own.
  await assert.rejects(() => storage.stat("../escaped"), /escapes the storage root/);
});

test("an upload spooled from a stream lands intact and reports its own digest", async () => {
  const { spoolUpload } = await import("../src/lib/storage/operations.js");
  const body = Buffer.from(randomUUID().repeat(400), "utf8");
  const upload = await spoolUpload(Readable.from([body.subarray(0, 100), body.subarray(100)]), 1024 * 1024);
  try {
    assert.equal(upload.size, body.byteLength);
    assert.equal(upload.sha256, createHash("sha256").update(body).digest("hex"));
    assert.deepEqual(await readFile(upload.filePath), body);
  } finally {
    await upload.cleanup();
  }
});

test("an upload past the limit is refused mid-stream instead of buffered", async () => {
  const { spoolUpload } = await import("../src/lib/storage/operations.js");
  await assert.rejects(
    () => spoolUpload(Readable.from([Buffer.alloc(64), Buffer.alloc(64)]), 100),
    /exceeds/
  );
});

test("the local driver accepts a spooled file on the same filesystem", async () => {
  const { spoolUpload, writeSpooledUpload } = await import("../src/lib/storage/operations.js");
  const source = join(base, "source.txt");
  await writeFile(source, "hello from a spooled upload");
  const upload = await spoolUpload(Readable.from([Buffer.from("hello from a spooled upload")]), 1024);
  try {
    // writeSpooledUpload goes through the configured driver, which in a test
    // run is the local one pointed at the repository's default storage path,
    // so the assertion here is only that the size and type survive the hop.
    const stat = await writeSpooledUpload(`cfman-test-${randomUUID()}/spooled.txt`, upload, {});
    assert.equal(stat.size, 27);
    assert.equal(stat.contentType, "text/plain; charset=utf-8");
    const { fileStorage } = await import("../src/lib/storage/index.js");
    await fileStorage().remove(stat.path, { recursive: false });
    await fileStorage().remove(stat.path.split("/")[0]!, { recursive: true });
  } finally {
    await upload.cleanup();
    await rm(source, { force: true });
  }
});

// AWS publishes a signing-key derivation example and a signed-request test
// suite. Both are reproduced here because a signer that is merely
// self-consistent still gets every request rejected by a real bucket, and
// there is no way to tell the two apart without an external vector.
test("SigV4 reproduces the AWS get-vanilla test vector", () => {
  const headers = signSigV4({
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
    headers: {},
    payloadHash: sha256Hex(""),
    region: "us-east-1",
    service: "service",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    now: new Date("2015-08-30T12:36:00Z")
  });
  assert.equal(headers["x-amz-date"], "20150830T123600Z");
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request,"
      + " SignedHeaders=host;x-amz-date,"
      + " Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
  );
});

test("SigV4 signs the headers it is given, sorted, with the host and date it adds itself", () => {
  const headers = signSigV4({
    method: "PUT",
    url: new URL(`https://examplebucket.s3.amazonaws.com${encodeS3Path("test$file.text")}`),
    headers: {
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
      "x-amz-content-sha256": "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      date: "Fri, 24 May 2013 00:00:00 GMT"
    },
    payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    region: "us-east-1",
    service: "s3",
    credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    now: new Date("2013-05-24T00:00:00Z")
  });
  assert.match(headers.authorization!, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,/);
  assert.equal(headers.host, "examplebucket.s3.amazonaws.com");
});

test("SigV4 sorts the query string, so the signature does not depend on parameter order", () => {
  const sign = (href: string) => signSigV4({
    method: "GET",
    url: new URL(href),
    headers: { "x-amz-content-sha256": sha256Hex("") },
    payloadHash: sha256Hex(""),
    // R2's region name signs like any other; what this pins down is that a
    // listing built from an object literal cannot break by reordering.
    region: "auto",
    service: "s3",
    credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    now: new Date("2013-05-24T00:00:00Z")
  }).authorization;
  assert.equal(
    sign("https://examplebucket.s3.amazonaws.com/?list-type=2&prefix=artifacts/installers/&delimiter=/&encoding-type=url"),
    sign("https://examplebucket.s3.amazonaws.com/?delimiter=/&encoding-type=url&list-type=2&prefix=artifacts/installers/")
  );
});

test("an object key is encoded per segment, leaving the separators alone", () => {
  assert.equal(encodeS3Path("artifacts/my report (final).csv"), "/artifacts/my%20report%20%28final%29.csv");
  assert.equal(encodeS3Path("a/b/c~d-e_f.g"), "/a/b/c~d-e_f.g");
  assert.equal(encodeS3Path("test$file.text"), "/test%24file.text");
});
