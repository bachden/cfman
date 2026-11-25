import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";

// Set before config.ts is first imported: the storage driver is built from
// the parsed environment, and node:test runs test files concurrently, so this
// file needs a schema of its own rather than sharing - and truncating - the
// one app.test.ts is using at the same time.
const storageRoot = await mkdtemp(join(tmpdir(), "cfman-files-api-"));
process.env.DATABASE_SCHEMA = "test_file_storage";
process.env.FILE_STORAGE_DRIVER = "local";
process.env.FILE_STORAGE_LOCAL_PATH = storageRoot;
process.env.FILE_STORAGE_TUNNEL_UPLOAD_PREFIX = "uploads";

let app: FastifyInstance;
let pool: (typeof import("../src/lib/database.js"))["pool"];
let sessionCookie = "";
let tunnelId = "";
let agentToken = "";

const host = "localhost";

before(async () => {
  const database = await import("../src/lib/database.js");
  pool = database.pool;
  await database.runMigrations();
  await database.seedRootUser();
  await pool.query("TRUNCATE audit_logs, enrollments, tunnels, zones, cloudflare_accounts, sessions RESTART IDENTITY CASCADE");
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { host },
    payload: { username: "root", password: "12345678" }
  });
  assert.equal(login.statusCode, 200, login.body);
  sessionCookie = login.headers["set-cookie"]!.toString().split(";")[0]!;

  const account = await pool.query(
    "INSERT INTO cloudflare_accounts(name, provider_mode, status) VALUES ('files-test', 'mock', 'active') RETURNING id"
  );
  const zone = await pool.query(
    "INSERT INTO zones(account_id, name) VALUES ($1, 'files-test.example') RETURNING id",
    [account.rows[0].id]
  );
  const tunnel = await pool.query(
    `INSERT INTO tunnels(tenant_code, tunnel_code, display_name, account_id, zone_id, hostname)
     VALUES ('ideaLAB', 'ldap', 'Files Test Tunnel', $1, $2, 'ldap.files-test.example')
     RETURNING id`,
    [account.rows[0].id, zone.rows[0].id]
  );
  tunnelId = tunnel.rows[0].id;
  const { ensureCommandAgentToken } = await import("../src/lib/command-agent.js");
  agentToken = await ensureCommandAgentToken(pool, tunnelId);
});

after(async () => {
  await app?.close();
  await pool?.end();
  await rm(storageRoot, { recursive: true, force: true });
});

function session(extra: Record<string, string> = {}) {
  return { host, cookie: sessionCookie, ...extra };
}

function agent(extra: Record<string, string> = {}) {
  return { host, "x-cloudflare-man-agent-token": agentToken, ...extra };
}

test("the storage root starts empty and reports the configured driver without leaking where it is", async () => {
  const response = await app.inject({ method: "GET", url: "/api/files", headers: session() });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body.entries, []);
  assert.equal(body.path, "");
  assert.equal(body.parent, null);
  assert.equal(body.storage.driver, "local");
  assert.equal(body.storage.configured, true);
  assert.equal(JSON.stringify(body).includes(storageRoot), false, "the base path must never reach the webapp");
});

test("a folder is created, a file is uploaded into it, and both read back", async () => {
  const folder = await app.inject({
    method: "POST",
    url: "/api/files/folders",
    headers: session(),
    payload: { path: "artifacts/installers" }
  });
  assert.equal(folder.statusCode, 201, folder.body);
  assert.equal(folder.json().path, "artifacts/installers");

  const upload = await app.inject({
    method: "PUT",
    url: `/api/files/content?path=${encodeURIComponent("artifacts/installers/agent báo.txt")}`,
    headers: session({ "content-type": "text/plain" }),
    payload: "installer payload"
  });
  assert.equal(upload.statusCode, 201, upload.body);
  assert.equal(upload.json().file.size, 17);

  const listing = await app.inject({ method: "GET", url: "/api/files?path=artifacts/installers", headers: session() });
  assert.equal(listing.statusCode, 200, listing.body);
  assert.deepEqual(listing.json().entries.map((entry: { name: string }) => entry.name), ["agent báo.txt"]);
  assert.equal(listing.json().parent, "artifacts");

  // Folders sort before files, so a browser never has to re-sort a listing.
  const root = await app.inject({ method: "GET", url: "/api/files", headers: session() });
  assert.deepEqual(root.json().entries.map((entry: { kind: string }) => entry.kind), ["folder"]);

  const download = await app.inject({
    method: "GET",
    url: `/api/files/content?path=${encodeURIComponent("artifacts/installers/agent báo.txt")}&download=1`,
    headers: session()
  });
  assert.equal(download.statusCode, 200, download.body);
  assert.equal(download.body, "installer payload");
  assert.equal(download.headers["content-length"], "17");
  // A non-ASCII name survives as the RFC 5987 form, with an ASCII fallback for
  // clients that read only the plain parameter.
  assert.match(String(download.headers["content-disposition"]), /^attachment; filename="agent b_o.txt"; filename\*=UTF-8''agent%20b%C3%A1o\.txt$/);
});

test("a path that would escape the storage root is refused with its reason", async () => {
  const response = await app.inject({
    method: "GET",
    url: `/api/files?path=${encodeURIComponent("../../etc")}`,
    headers: session()
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /\.\./);
});

test("a file is read and written as JSON for callers that cannot stream bytes", async () => {
  const write = await app.inject({
    method: "POST",
    url: "/api/files/data",
    headers: session(),
    payload: { path: "notes/readme.md", content: "# cfman\nstored by the API\n" }
  });
  assert.equal(write.statusCode, 201, write.body);
  assert.equal(write.json().file.contentType, "text/markdown; charset=utf-8");

  const read = await app.inject({ method: "GET", url: "/api/files/data?path=notes/readme.md", headers: session() });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().file.content, "# cfman\nstored by the API\n");

  const base64 = await app.inject({ method: "GET", url: "/api/files/data?path=notes/readme.md&encoding=base64", headers: session() });
  assert.equal(Buffer.from(base64.json().file.content, "base64").toString("utf8"), "# cfman\nstored by the API\n");
});

test("a move renames in place and a delete needs recursive for a folder that still holds something", async () => {
  const move = await app.inject({
    method: "POST",
    url: "/api/files/move",
    headers: session(),
    payload: { from: "notes/readme.md", to: "notes/README.md" }
  });
  assert.equal(move.statusCode, 200, move.body);
  assert.equal(move.json().to, "notes/README.md");

  const refused = await app.inject({ method: "DELETE", url: "/api/files?path=notes", headers: session() });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.match(refused.json().error, /not empty/);

  const deleted = await app.inject({ method: "DELETE", url: "/api/files?path=notes&recursive=true", headers: session() });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const gone = await app.inject({ method: "GET", url: "/api/files/stat?path=notes", headers: session() });
  assert.equal(gone.json().file, null);
});

test("every mutation is written to the audit trail with the path it touched", async () => {
  const audit = await pool.query(
    "SELECT action, entity_id, details FROM audit_logs WHERE action LIKE 'file_storage.%' ORDER BY id"
  );
  const actions = audit.rows.map((row) => `${row.action} ${row.entity_id}`);
  assert.ok(actions.includes("file_storage.folder_created artifacts/installers"), actions.join("; "));
  assert.ok(actions.includes("file_storage.path_moved notes/README.md"), actions.join("; "));
  assert.ok(actions.some((entry) => entry.startsWith("file_storage.path_deleted notes")), actions.join("; "));
});

test("an enrolled machine reads any path with its command-agent token", async () => {
  const listing = await app.inject({
    method: "GET",
    url: `/api/public/tunnels/${tunnelId}/files?path=artifacts/installers`,
    headers: agent()
  });
  assert.equal(listing.statusCode, 200, listing.body);
  assert.deepEqual(listing.json().entries.map((entry: { name: string }) => entry.name), ["agent báo.txt"]);
  // The machine is told its own write root rather than having to derive it.
  assert.equal(listing.json().uploadRoot, "uploads/ideaLAB/ldap");

  const download = await app.inject({
    method: "GET",
    url: `/api/public/tunnels/${tunnelId}/files/content?path=${encodeURIComponent("artifacts/installers/agent báo.txt")}`,
    headers: agent()
  });
  assert.equal(download.statusCode, 200, download.body);
  assert.equal(download.body, "installer payload");
});

test("an enrolled machine writes only inside its own upload folder", async () => {
  const allowed = await app.inject({
    method: "PUT",
    url: `/api/public/tunnels/${tunnelId}/files/content?path=${encodeURIComponent("uploads/ideaLAB/ldap/logs/install.log")}`,
    headers: agent({ "content-type": "application/octet-stream" }),
    payload: "install finished"
  });
  assert.equal(allowed.statusCode, 201, allowed.body);
  assert.equal(allowed.json().file.path, "uploads/ideaLAB/ldap/logs/install.log");
  // An agent that sends no useful type gets the one the extension implies.
  assert.equal(allowed.json().file.contentType, "text/plain; charset=utf-8");

  for (const path of ["artifacts/installers/agent báo.txt", "uploads/ideaLAB/other/report.csv", "uploads/ideaLAB/ldap"]) {
    const refused = await app.inject({
      method: "PUT",
      url: `/api/public/tunnels/${tunnelId}/files/content?path=${encodeURIComponent(path)}`,
      headers: agent({ "content-type": "application/octet-stream" }),
      payload: "overwritten"
    });
    assert.equal(refused.statusCode, 403, `${path}: ${refused.body}`);
  }

  // The artifact a machine must not be able to overwrite is still intact.
  const intact = await app.inject({
    method: "GET",
    url: `/api/files/content?path=${encodeURIComponent("artifacts/installers/agent báo.txt")}`,
    headers: session()
  });
  assert.equal(intact.body, "installer payload");

  const deleteOutside = await app.inject({
    method: "DELETE",
    url: `/api/public/tunnels/${tunnelId}/files/content?path=${encodeURIComponent("artifacts/installers/agent báo.txt")}`,
    headers: agent()
  });
  assert.equal(deleteOutside.statusCode, 403, deleteOutside.body);

  const deleteOwn = await app.inject({
    method: "DELETE",
    url: `/api/public/tunnels/${tunnelId}/files/content?path=${encodeURIComponent("uploads/ideaLAB/ldap/logs/install.log")}`,
    headers: agent()
  });
  assert.equal(deleteOwn.statusCode, 200, deleteOwn.body);
});

test("a wrong or missing agent token reaches nothing", async () => {
  for (const headers of [{ host }, { host, "x-cloudflare-man-agent-token": "not-the-token" }]) {
    const response = await app.inject({ method: "GET", url: `/api/public/tunnels/${tunnelId}/files`, headers });
    assert.equal(response.statusCode, 401, response.body);
  }
  // A valid token is still only valid for its own tunnel.
  const otherTunnel = await app.inject({
    method: "GET",
    url: "/api/public/tunnels/00000000-0000-4000-8000-000000000000/files",
    headers: agent()
  });
  assert.equal(otherTunnel.statusCode, 401, otherTunnel.body);
});

test("the webapp needs a session, and the file routes are not open to the world", async () => {
  for (const url of ["/api/files", "/api/files/stat?path=a", "/api/files/data?path=a"]) {
    const response = await app.inject({ method: "GET", url, headers: { host } });
    assert.equal(response.statusCode, 401, `${url}: ${response.body}`);
  }
});

test("settings report the storage kind and nothing about where it lives", async () => {
  const response = await app.inject({ method: "GET", url: "/api/settings", headers: session() });
  assert.equal(response.statusCode, 200, response.body);
  const storage = response.json().settings.fileStorage;
  assert.equal(storage.driver, "local");
  assert.equal(storage.configured, true);
  assert.equal(storage.tunnelUploadPrefix, "uploads");
  assert.equal(JSON.stringify(response.json()).includes(storageRoot), false);
});
