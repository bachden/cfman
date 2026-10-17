import assert from "node:assert/strict";
import { test } from "node:test";
import { runMigrations, pool } from "../src/lib/database.js";
import { encryptChannelSecrets, getChannelByKey } from "../src/lib/notifications.js";
import { askOnChannel, normalizePromptButtons, PromptError } from "../src/lib/notification-prompts.js";

await runMigrations();

// Stands in for Telegram itself: it records what the bot sent, and can hand
// back a button press the same way getUpdates would. Everything between the
// script and this - adapter, prompt row, poll loop, acknowledgement, closing
// the message - is the real code.
function telegramStub({ press }: { press: boolean }) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let pendingCallback: string | null = null;
  let updateId = 100;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split("/").pop() ?? "";
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, payload });
    const json = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (method === "sendMessage") {
      const markup = payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
      if (press) pendingCallback = markup.inline_keyboard[0]?.[1]?.callback_data ?? null;
      return json({ message_id: 42 });
    }
    if (method === "getUpdates") {
      if (!pendingCallback) {
        // An idle long poll: no updates, which is what makes the timeout path
        // take its own course instead of erroring out.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return json([]);
      }
      const data = pendingCallback;
      pendingCallback = null;
      updateId += 1;
      return json([{ update_id: updateId, callback_query: { id: "cbq-1", data, from: { username: "bach" } } }]);
    }
    return json(true);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

async function createChannel(key: string): Promise<string> {
  const inserted = await pool.query(
    `INSERT INTO notification_channels(key, name, type, config, secrets)
     VALUES ($1, $1, 'telegram', $2::jsonb, $3::jsonb) RETURNING id`,
    [key, JSON.stringify({ chatId: "-100123", parseMode: "none", disableNotification: false }), JSON.stringify(encryptChannelSecrets({ botToken: "123456:test-token" }))]
  );
  return inserted.rows[0].id as string;
}

test("a pressed button becomes the script's answer", async (t) => {
  const key = `test-prompt-${Date.now().toString(36)}`;
  await createChannel(key);
  const stub = telegramStub({ press: true });
  t.after(async () => {
    stub.restore();
    await pool.query("DELETE FROM notification_channels WHERE key = $1", [key]);
  });

  const channel = await getChannelByKey(key);
  assert.ok(channel);
  const outcome = await askOnChannel({
    channel,
    body: "Restart the agent?",
    buttons: ["Restart", { label: "Skip", value: "skip" }],
    timeoutMs: 15_000,
    requestedVia: "web"
  });

  assert.equal(outcome.status, "answered");
  assert.equal(outcome.value, "skip");
  assert.equal(outcome.label, "Skip");
  assert.equal(outcome.answeredBy, "@bach");

  // The press is acknowledged and the question is rewritten without buttons,
  // so the same decision cannot be made twice.
  assert.ok(stub.calls.some((call) => call.method === "answerCallbackQuery"));
  const closing = stub.calls.find((call) => call.method === "editMessageText");
  assert.ok(closing, "the question should be closed out in the chat");
  assert.match(String(closing.payload.text), /Restart the agent\?[\s\S]*Skip/);

  const stored = await pool.query(
    `SELECT status, answer_value AS "value", answered_by AS "answeredBy" FROM notification_prompts WHERE id = $1`,
    [outcome.promptId]
  );
  assert.deepEqual(stored.rows[0], { status: "answered", value: "skip", answeredBy: "@bach" });

  // The question is also part of what the channel said.
  const logged = await pool.query("SELECT body FROM notification_messages WHERE channel_id = (SELECT id FROM notification_channels WHERE key = $1)", [key]);
  assert.match(String(logged.rows[0].body), /\[buttons: Restart, Skip\]/);
});

test("silence becomes a timed_out answer rather than an error", async (t) => {
  const key = `test-prompt-timeout-${Date.now().toString(36)}`;
  await createChannel(key);
  const stub = telegramStub({ press: false });
  t.after(async () => {
    stub.restore();
    await pool.query("DELETE FROM notification_channels WHERE key = $1", [key]);
    await pool.end();
  });

  const channel = await getChannelByKey(key);
  assert.ok(channel);
  const outcome = await askOnChannel({
    channel,
    body: "Deploy now?",
    buttons: ["Yes", "No"],
    timeoutMs: 5_000,
    requestedVia: "web"
  });

  assert.equal(outcome.status, "timed_out");
  assert.equal(outcome.value, null);
  const closing = stub.calls.filter((call) => call.method === "editMessageText").pop();
  assert.match(String(closing?.payload.text), /No answer within 5s/);

  const stored = await pool.query("SELECT status FROM notification_prompts WHERE id = $1", [outcome.promptId]);
  assert.equal(stored.rows[0].status, "timed_out");
});

test("buttons are checked before anything is sent to the chat", () => {
  assert.throws(() => normalizePromptButtons([], 5), PromptError);
  assert.throws(() => normalizePromptButtons(["a", "b", "c"], 2), /At most 2 buttons/);
  assert.throws(() => normalizePromptButtons([{ label: "x".repeat(33) }], 5), /longer than 32 characters/);
  assert.throws(() => normalizePromptButtons(["Same", { label: "Other", value: "Same" }], 5), /must be distinct/);
  assert.deepEqual(normalizePromptButtons(["Approve", { label: "Reject", value: "no" }], 5), [
    { label: "Approve", value: "Approve" },
    { label: "Reject", value: "no" }
  ]);
});
