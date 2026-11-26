import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Set before config.ts is first imported, and in a schema of this file's own:
// node:test runs test files concurrently, so sharing one would mean sharing
// the storage root and the channel rows with another file's truncations.
const storageRoot = await mkdtemp(join(tmpdir(), "cfman-channel-files-"));
process.env.DATABASE_SCHEMA = "test_notification_files";
process.env.FILE_STORAGE_DRIVER = "local";
process.env.FILE_STORAGE_LOCAL_PATH = storageRoot;

type Telegram = typeof import("../src/lib/notifications.js");
type Storage = typeof import("../src/lib/storage/operations.js");

let notifications: Telegram;
let storage: Storage;
let pool: (typeof import("../src/lib/database.js"))["pool"];

before(async () => {
  const database = await import("../src/lib/database.js");
  pool = database.pool;
  await database.runMigrations();
  notifications = await import("../src/lib/notifications.js");
  storage = await import("../src/lib/storage/operations.js");
  await pool.query("DELETE FROM notification_channels");
});

after(async () => {
  await pool?.query("DELETE FROM notification_channels");
  await pool?.end();
  await rm(storageRoot, { recursive: true, force: true });
});

type RecordedUpload = { method: string; fields: Record<string, string>; document: { name: string; type: string; text: string } | null };

// Stands in for the Telegram bot API, and is the only part of this that is not
// the real code: the adapter, the multipart body, the storage read, and the
// message row are all exercised as they are in production.
function telegramStub() {
  const calls: RecordedUpload[] = [];
  const originalFetch = globalThis.fetch;
  let messageId = 500;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split("/").pop() ?? "";
    const fields: Record<string, string> = {};
    let document: RecordedUpload["document"] = null;
    if (init?.body instanceof FormData) {
      for (const [name, value] of init.body.entries()) {
        if (typeof value === "string") {
          fields[name] = value;
          continue;
        }
        document = { name: (value as File).name, type: value.type, text: await value.text() };
      }
    } else {
      Object.assign(fields, JSON.parse(String(init?.body ?? "{}")) as Record<string, string>);
    }
    calls.push({ method, fields, document });
    messageId += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

async function createChannel(key: string): Promise<string> {
  const inserted = await pool.query(
    `INSERT INTO notification_channels(key, name, type, config, secrets)
     VALUES ($1, $1, 'telegram', $2::jsonb, $3::jsonb) RETURNING id`,
    [
      key,
      JSON.stringify({ chatId: "-100999", parseMode: "none", disableNotification: false }),
      JSON.stringify(notifications.encryptChannelSecrets({ botToken: "123456:file-token" }))
    ]
  );
  return inserted.rows[0].id as string;
}

test("a stored file goes out as a document with the body as its caption", async (t) => {
  const key = `files-caption-${Date.now().toString(36)}`;
  await createChannel(key);
  const stub = telegramStub();
  t.after(() => stub.restore());

  await storage.writeFileInline("reports/daily.csv", "tunnel,status\nldap,healthy\n");
  const channel = await notifications.getChannelByKey(key);
  assert.ok(channel);

  const attachments = await notifications.resolveChannelAttachments(channel, ["reports/daily.csv"]);
  const sent = await notifications.sendChannelMessage({ channel, body: "Daily report", attachments, requestedVia: "web" });

  assert.equal(stub.calls.length, 1);
  const [upload] = stub.calls;
  assert.equal(upload!.method, "sendDocument");
  assert.equal(upload!.fields.chat_id, "-100999");
  assert.equal(upload!.fields.caption, "Daily report");
  assert.equal(upload!.document?.name, "daily.csv");
  assert.equal(upload!.document?.type, "text/csv; charset=utf-8");
  assert.equal(upload!.document?.text, "tunnel,status\nldap,healthy\n");

  // The log records which storage paths went out, not the bytes.
  assert.deepEqual(sent.attachments, [{ path: "reports/daily.csv", name: "daily.csv", size: 27, contentType: "text/csv; charset=utf-8" }]);
  const row = await pool.query("SELECT body, status, attachments FROM notification_messages WHERE id = $1", [sent.messageId]);
  assert.equal(row.rows[0].status, "sent");
  assert.equal(row.rows[0].body, "Daily report");
  assert.deepEqual(row.rows[0].attachments, [{ path: "reports/daily.csv", name: "daily.csv", size: 27, contentType: "text/csv; charset=utf-8" }]);
});

test("several files arrive in order, with the caption on the first only", async (t) => {
  const key = `files-many-${Date.now().toString(36)}`;
  await createChannel(key);
  const stub = telegramStub();
  t.after(() => stub.restore());

  await storage.writeFileInline("batch/first.txt", "first");
  await storage.writeFileInline("batch/second.txt", "second");
  const channel = await notifications.getChannelByKey(key);
  assert.ok(channel);

  const attachments = await notifications.resolveChannelAttachments(channel, ["batch/first.txt", "batch/second.txt"]);
  await notifications.sendChannelMessage({ channel, body: "two files", attachments, requestedVia: "mcp" });

  assert.deepEqual(stub.calls.map((call) => call.document?.name), ["first.txt", "second.txt"]);
  assert.equal(stub.calls[0]!.fields.caption, "two files");
  assert.equal(stub.calls[1]!.fields.caption, undefined);
});

test("a file with no text of its own is a message in its own right", async (t) => {
  const key = `files-bare-${Date.now().toString(36)}`;
  await createChannel(key);
  const stub = telegramStub();
  t.after(() => stub.restore());

  await storage.writeFileInline("bare/notes.txt", "no caption");
  const channel = await notifications.getChannelByKey(key);
  assert.ok(channel);

  const attachments = await notifications.resolveChannelAttachments(channel, ["bare/notes.txt"]);
  const sent = await notifications.sendChannelMessage({ channel, body: "", attachments, requestedVia: "web" });

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]!.fields.caption, undefined);
  assert.equal(sent.status, "sent");
});

test("text too long for a caption is sent as its own message ahead of the file", async (t) => {
  const key = `files-long-${Date.now().toString(36)}`;
  await createChannel(key);
  const stub = telegramStub();
  t.after(() => stub.restore());

  await storage.writeFileInline("long/report.txt", "body");
  const channel = await notifications.getChannelByKey(key);
  assert.ok(channel);

  const body = "x".repeat(1_500);
  const attachments = await notifications.resolveChannelAttachments(channel, ["long/report.txt"]);
  await notifications.sendChannelMessage({ channel, body, attachments, requestedVia: "web" });

  assert.deepEqual(stub.calls.map((call) => call.method), ["sendMessage", "sendDocument"]);
  assert.equal(stub.calls[0]!.fields.text, body);
  assert.equal(stub.calls[1]!.fields.caption, undefined);
});

test("a path that is missing, a folder, or too numerous is refused before anything is sent", async (t) => {
  const key = `files-refuse-${Date.now().toString(36)}`;
  await createChannel(key);
  const stub = telegramStub();
  t.after(() => stub.restore());

  await storage.createFolder("refuse/folder");
  const channel = await notifications.getChannelByKey(key);
  assert.ok(channel);

  await assert.rejects(
    () => notifications.resolveChannelAttachments(channel, ["refuse/nothing-here.txt"]),
    (error: Error & { statusCode?: number }) => error.statusCode === 404 && /not found/i.test(error.message)
  );
  await assert.rejects(
    () => notifications.resolveChannelAttachments(channel, ["refuse/folder"]),
    (error: Error & { statusCode?: number }) => error.statusCode === 409 && /folder, not a file/.test(error.message)
  );
  await storage.writeFileInline("refuse/one.txt", "one");
  await assert.rejects(
    () => notifications.resolveChannelAttachments(channel, Array.from({ length: 11 }, () => "refuse/one.txt")),
    (error: Error & { statusCode?: number }) => error.statusCode === 400 && /at most 10 file/.test(error.message)
  );

  // Nothing reached Telegram: a bad path fails the whole send rather than
  // delivering the files that happened to be fine.
  assert.equal(stub.calls.length, 0);
});

test("a failed upload is recorded against the channel with the file named", async (t) => {
  const key = `files-failed-${Date.now().toString(36)}`;
  await createChannel(key);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, description: "file is too big" }), { status: 400 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await storage.writeFileInline("failed/report.bin", "payload");
  const channel = await notifications.getChannelByKey(key);
  assert.ok(channel);

  const attachments = await notifications.resolveChannelAttachments(channel, ["failed/report.bin"]);
  await assert.rejects(
    () => notifications.sendChannelMessage({ channel, body: "nope", attachments, requestedVia: "web" }),
    (error: Error) => /report\.bin: file is too big/.test(error.message)
  );

  const row = await pool.query(
    "SELECT status, error, attachments FROM notification_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1",
    [channel.id]
  );
  assert.equal(row.rows[0].status, "failed");
  assert.match(row.rows[0].error as string, /report\.bin/);
  assert.equal((row.rows[0].attachments as unknown[]).length, 1);
  const stored = await pool.query("SELECT last_error FROM notification_channels WHERE id = $1", [channel.id]);
  assert.match(stored.rows[0].last_error as string, /file is too big/);
});
