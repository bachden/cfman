import { pool } from "./database.js";
import {
  decryptChannelSecrets,
  getChannelAdapter,
  type ChannelRecord,
  type PromptButton,
  type PromptEvent
} from "./notifications.js";

export type PromptStatus = "answered" | "timed_out" | "failed";

export type PromptOutcome = {
  promptId: string;
  channelKey: string;
  status: PromptStatus;
  // The value of the button that was pressed; null unless the status is
  // "answered", which is what a script branches on.
  value: string | null;
  label: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  error: string | null;
};

export class PromptError extends Error {}

type Waiter = {
  promptId: string;
  channel: ChannelRecord;
  buttons: PromptButton[];
  body: string;
  providerMessageId: string | null;
  settle: (outcome: { index: number; answeredBy: string | null; event: PromptEvent } | { failure: string }) => void;
};

type Poller = {
  waiters: Set<string>;
  running: boolean;
};

const waiters = new Map<string, Waiter>();
const pollers = new Map<string, Poller>();

export const MIN_PROMPT_TIMEOUT_MS = 5_000;
export const MAX_PROMPT_TIMEOUT_MS = 600_000;

function outcomeText(body: string, suffix: string): string {
  return `${body}\n\n${suffix}`;
}

// A press that nobody is waiting for any more still deserves an answer in the
// chat, otherwise the client spins on the button.
async function acknowledgeOrphan(channel: ChannelRecord, event: PromptEvent): Promise<void> {
  const adapter = getChannelAdapter(channel.type);
  if (!adapter.interactive) return;
  await adapter.interactive
    .acknowledge({ secrets: decryptChannelSecrets(channel.secrets), event, text: "This request is no longer waiting for an answer." })
    .catch(() => undefined);
}

async function pollOnce(key: string, channel: ChannelRecord, cursor: string | null): Promise<{ cursor: string | null; events: PromptEvent[] }> {
  const adapter = getChannelAdapter(channel.type);
  if (!adapter.interactive) throw new PromptError(`Channel type ${channel.type} cannot receive button presses`);
  const controller = new AbortController();
  // Longer than the adapter's own long poll, so an idle poll ends by itself
  // rather than by this deadline.
  const timer = setTimeout(() => controller.abort(), 40_000);
  try {
    return await adapter.interactive.poll({
      secrets: decryptChannelSecrets(channel.secrets),
      cursor,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// Permanent in the sense that waiting longer cannot help: the bot is wired so
// that presses will never arrive, so every waiting script is told at once
// instead of sitting out its whole timeout.
function isPermanentPollFailure(message: string): boolean {
  return /webhook|unauthorized|not found|invalid token/i.test(message);
}

function failWaiters(key: string, reason: string): void {
  const poller = pollers.get(key);
  if (!poller) return;
  for (const promptId of [...poller.waiters]) {
    waiters.get(promptId)?.settle({ failure: reason });
  }
}

async function runPoller(key: string, channel: ChannelRecord): Promise<void> {
  const poller = pollers.get(key);
  if (!poller || poller.running) return;
  poller.running = true;
  let cursor: string | null = null;
  let consecutiveFailures = 0;
  try {
    while (pollers.get(key)?.waiters.size) {
      try {
        const result = await pollOnce(key, channel, cursor);
        cursor = result.cursor;
        consecutiveFailures = 0;
        for (const event of result.events) {
          const waiter = waiters.get(event.promptId);
          if (!waiter) {
            await acknowledgeOrphan(channel, event);
            continue;
          }
          waiter.settle({ index: event.buttonIndex, answeredBy: event.answeredBy, event });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Polling failed";
        if (isPermanentPollFailure(message)) {
          failWaiters(key, message);
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          failWaiters(key, message);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  } finally {
    const current = pollers.get(key);
    if (current) {
      current.running = false;
      if (!current.waiters.size) pollers.delete(key);
    }
  }
}

export function normalizePromptButtons(input: unknown, maxButtons: number): PromptButton[] {
  if (!Array.isArray(input) || input.length === 0) throw new PromptError("At least one button is required");
  if (input.length > maxButtons) throw new PromptError(`At most ${maxButtons} buttons are supported on this channel`);
  const buttons = input.map((entry, index) => {
    const raw = typeof entry === "string" ? { label: entry, value: entry } : entry as { label?: unknown; value?: unknown };
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!label) throw new PromptError(`Button ${index + 1} has no label`);
    if (label.length > 32) throw new PromptError(`Button "${label}" is longer than 32 characters`);
    const value = typeof raw.value === "string" && raw.value.trim() ? raw.value.trim() : label;
    if (value.length > 48) throw new PromptError(`The value of button "${label}" is longer than 48 characters`);
    return { label, value };
  });
  if (new Set(buttons.map((button) => button.value)).size !== buttons.length) {
    throw new PromptError("Button values must be distinct, because the value is what the script reads back");
  }
  return buttons;
}

export type AskOnChannelInput = {
  channel: ChannelRecord;
  body: string;
  buttons: unknown;
  timeoutMs: number;
  automationRunId?: string | null;
  requestedBy?: string | null;
  requestedVia?: "web" | "mcp" | "automation";
};

// Sends a question with buttons and waits for the answer. It resolves rather
// than throws when nobody answers in time: a script asking for permission
// treats silence as an outcome, not as a crash.
export async function askOnChannel(input: AskOnChannelInput): Promise<PromptOutcome> {
  const { channel } = input;
  const adapter = getChannelAdapter(channel.type);
  if (!adapter.interactive) {
    throw new PromptError(`Channel "${channel.key}" is a ${adapter.label} channel, which cannot show buttons`);
  }
  if (!channel.enabled) throw new PromptError(`Channel "${channel.key}" is disabled`);
  const body = input.body.trim();
  if (!body) throw new PromptError("The question is empty");
  const buttons = normalizePromptButtons(input.buttons, adapter.interactive.maxButtons);
  const timeoutMs = Math.min(MAX_PROMPT_TIMEOUT_MS, Math.max(MIN_PROMPT_TIMEOUT_MS, Math.trunc(input.timeoutMs)));

  const inserted = await pool.query(
    `INSERT INTO notification_prompts(channel_id, automation_run_id, body, buttons, status,
                                      requested_by, requested_via, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, $6, now() + ($7::int * interval '1 millisecond'))
     RETURNING id`,
    [
      channel.id,
      input.automationRunId ?? null,
      body,
      JSON.stringify(buttons),
      input.requestedBy ?? null,
      input.requestedVia ?? "automation",
      timeoutMs
    ]
  );
  const promptId = inserted.rows[0].id as string;

  let providerMessageId: string | null = null;
  try {
    const sent = await adapter.interactive.send({
      config: channel.config,
      secrets: decryptChannelSecrets(channel.secrets),
      body,
      promptId,
      buttons
    });
    providerMessageId = sent.providerMessageId;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The question could not be sent";
    await pool.query("UPDATE notification_prompts SET status = 'failed', error = $1 WHERE id = $2", [message, promptId]);
    await pool.query("UPDATE notification_channels SET last_used_at = now(), last_error = $1 WHERE id = $2", [message, channel.id]);
    throw new PromptError(message);
  }

  await pool.query(
    "UPDATE notification_prompts SET provider_message_id = $1 WHERE id = $2",
    [providerMessageId, promptId]
  );
  // The question is also an outgoing message, so the channel log stays a
  // complete record of what the bot said.
  await pool.query(
    `INSERT INTO notification_messages(channel_id, automation_run_id, body, status, provider_message_id, requested_by, requested_via)
     VALUES ($1, $2, $3, 'sent', $4, $5, $6)`,
    [
      channel.id,
      input.automationRunId ?? null,
      `${body}\n[buttons: ${buttons.map((button) => button.label).join(", ")}]`,
      providerMessageId,
      input.requestedBy ?? null,
      input.requestedVia ?? "automation"
    ]
  );
  await pool.query("UPDATE notification_channels SET last_used_at = now(), last_error = null WHERE id = $1", [channel.id]);

  const pollKey = adapter.pollKey?.({ config: channel.config, secrets: decryptChannelSecrets(channel.secrets) }) ?? `${channel.type}:${channel.id}`;
  const poller = pollers.get(pollKey) ?? { waiters: new Set<string>(), running: false };
  pollers.set(pollKey, poller);
  poller.waiters.add(promptId);

  const settled = new Promise<{ index: number; answeredBy: string | null; event: PromptEvent } | { failure: string } | "timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref();
    waiters.set(promptId, {
      promptId,
      channel,
      buttons,
      body,
      providerMessageId,
      settle: (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      }
    });
  });

  void runPoller(pollKey, channel);

  const result = await settled;
  waiters.delete(promptId);
  poller.waiters.delete(promptId);

  const secrets = decryptChannelSecrets(channel.secrets);
  const close = async (text: string) => {
    await adapter.interactive!
      .close({ config: channel.config, secrets, providerMessageId, body: outcomeText(body, text) })
      .catch(() => undefined);
  };

  if (result === "timeout" || "failure" in result) {
    const failure = result === "timeout" ? null : result.failure;
    const status: PromptStatus = failure ? "failed" : "timed_out";
    // Only a prompt still pending is closed out here: a press that landed in
    // the same instant has already written its own answer.
    const updated = await pool.query(
      "UPDATE notification_prompts SET status = $1, error = $2 WHERE id = $3 AND status = 'pending' RETURNING id",
      [status, failure, promptId]
    );
    if (updated.rowCount) {
      await close(failure
        ? `⚠️ Could not wait for an answer: ${failure}`
        : `⌛ No answer within ${Math.round(timeoutMs / 1000)}s.`);
      return {
        promptId,
        channelKey: channel.key,
        status,
        value: null,
        label: null,
        answeredBy: null,
        answeredAt: null,
        error: failure
      };
    }
  }

  const answer = "index" in (result as object)
    ? result as { index: number; answeredBy: string | null; event: PromptEvent }
    : null;
  if (answer) {
    const button = buttons[answer.index];
    if (button) {
      const updated = await pool.query(
        `UPDATE notification_prompts
            SET status = 'answered', answer_value = $1, answer_label = $2, answered_by = $3, answered_at = now()
          WHERE id = $4 AND status = 'pending'
          RETURNING answered_at AS "answeredAt"`,
        [button.value, button.label, answer.answeredBy, promptId]
      );
      if (updated.rowCount) {
        await adapter.interactive
          .acknowledge({ secrets, event: answer.event, text: `${button.label} it is.` })
          .catch(() => undefined);
        await close(`✅ ${button.label}${answer.answeredBy ? ` — ${answer.answeredBy}` : ""}`);
        return {
          promptId,
          channelKey: channel.key,
          status: "answered",
          value: button.value,
          label: button.label,
          answeredBy: answer.answeredBy,
          answeredAt: new Date(updated.rows[0].answeredAt as string).toISOString(),
          error: null
        };
      }
    }
  }

  // Whatever is in the row wins: another path already settled this prompt.
  const current = await pool.query(
    `SELECT status, answer_value AS "value", answer_label AS "label", answered_by AS "answeredBy",
            answered_at AS "answeredAt", error
       FROM notification_prompts WHERE id = $1`,
    [promptId]
  );
  const row = current.rows[0] as {
    status: PromptStatus;
    value: string | null;
    label: string | null;
    answeredBy: string | null;
    answeredAt: Date | null;
    error: string | null;
  };
  return {
    promptId,
    channelKey: channel.key,
    status: row.status,
    value: row.value,
    label: row.label,
    answeredBy: row.answeredBy,
    answeredAt: row.answeredAt ? new Date(row.answeredAt).toISOString() : null,
    error: row.error
  };
}

// A prompt still marked pending at startup lost its waiting script when the
// process stopped, so nothing is left to answer it.
export async function reconcileInterruptedPrompts(): Promise<void> {
  await pool.query(
    `UPDATE notification_prompts
        SET status = 'failed', error = 'The server stopped while this question was waiting for an answer.'
      WHERE status = 'pending'`
  );
}
