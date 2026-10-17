import { z } from "zod";
import { pool } from "./database.js";
import { decryptSecret, encryptSecret } from "./security.js";

export const channelKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Key must be lowercase letters, digits, hyphen or underscore, starting with a letter or digit");

export type ChannelType = "telegram";

export type ChannelRecord = {
  id: string;
  key: string;
  name: string;
  type: ChannelType;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChannelSummary = Omit<ChannelRecord, "secrets"> & {
  typeLabel: string;
  target: string;
  secretHints: Record<string, string>;
  // Whether this channel can ask a question with buttons and deliver the
  // answer back, which is what cfman.ask needs.
  supportsButtons: boolean;
  maxButtons: number;
};

export type SendResult = { providerMessageId: string | null };

export type PromptButton = { label: string; value: string };

// What a chat platform hands back when someone presses a button. `token` is
// whatever that platform needs to acknowledge the press (Telegram's
// callback_query id); the prompt manager passes it straight back.
export type PromptEvent = {
  promptId: string;
  buttonIndex: number;
  answeredBy: string | null;
  token: string;
};

// The second half of a channel adapter: present only for platforms that can
// ask a question and deliver the answer back. A platform without it can still
// send messages; cfman.ask refuses it by name instead of silently sending a
// message nobody can answer.
export type InteractiveChannelAdapter = {
  maxButtons: number;
  send: (input: {
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    body: string;
    promptId: string;
    buttons: PromptButton[];
  }) => Promise<SendResult>;
  // Waits for presses. It returns as soon as the platform answers - with
  // events or empty-handed when the long poll expires - so the caller decides
  // whether to ask again.
  poll: (input: {
    secrets: Record<string, string>;
    cursor: string | null;
    signal: AbortSignal;
  }) => Promise<{ cursor: string | null; events: PromptEvent[] }>;
  // Tells the platform the press was handled, which is what stops the chat
  // client from showing a pending spinner on the button.
  acknowledge: (input: { secrets: Record<string, string>; event: PromptEvent; text: string }) => Promise<void>;
  // Replaces the question with its outcome and takes the buttons away, so a
  // decided prompt cannot be answered twice.
  close: (input: {
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    providerMessageId: string | null;
    body: string;
  }) => Promise<void>;
};

type ChannelAdapter = {
  type: ChannelType;
  label: string;
  // Non-secret settings, stored as-is and shown in the UI.
  configSchema: z.ZodType<Record<string, unknown>>;
  // Secret settings, each value encrypted individually before it is stored.
  // Every key is optional on update so an edit can leave a secret untouched.
  secretSchema: z.ZodObject<Record<string, z.ZodString>>;
  // One-line description of where a message actually lands.
  describe: (config: Record<string, unknown>) => string;
  maxBodyLength: number;
  send: (input: { config: Record<string, unknown>; secrets: Record<string, string>; body: string }) => Promise<SendResult>;
  // Channels that can only speak leave this out; see InteractiveChannelAdapter.
  interactive?: InteractiveChannelAdapter;
  // Presses are routed by the prompt id carried in the button, so every prompt
  // waiting on the same credentials shares one poll loop. Two channels built
  // on the same bot token are therefore polled once, not twice - which is also
  // what Telegram requires, since concurrent getUpdates calls reject.
  pollKey?: (input: { config: Record<string, unknown>; secrets: Record<string, string> }) => string;
};

const telegramConfigSchema = z.object({
  chatId: z.string().trim().min(1).max(120).describe("Numeric chat id or @channelusername"),
  parseMode: z.enum(["none", "markdown", "html"]).default("none"),
  disableNotification: z.boolean().default(false)
});

const telegramAdapter: ChannelAdapter = {
  type: "telegram",
  label: "Telegram bot",
  configSchema: telegramConfigSchema as unknown as z.ZodType<Record<string, unknown>>,
  secretSchema: z.object({ botToken: z.string().trim().min(10).max(200) }),
  describe: (config) => {
    const parsed = telegramConfigSchema.parse(config);
    return `Chat ${parsed.chatId}${parsed.parseMode === "none" ? "" : ` · ${parsed.parseMode === "html" ? "HTML" : "MarkdownV2"}`}`;
  },
  maxBodyLength: 4096,
  send: async ({ config, secrets, body }) => {
    const parsed = telegramConfigSchema.parse(config);
    const botToken = secrets.botToken;
    if (!botToken) throw new Error("This Telegram channel has no bot token configured");
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: parsed.chatId,
        text: body,
        ...(parsed.parseMode === "none" ? {} : { parse_mode: parsed.parseMode === "html" ? "HTML" : "MarkdownV2" }),
        ...(parsed.disableNotification ? { disable_notification: true } : {})
      }),
      signal: AbortSignal.timeout(20_000)
    });
    const payload = await response.json().catch(() => ({})) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    // Telegram answers 4xx with a human-readable `description` ("chat not
    // found", "can't parse entities: ..."), which is far more useful to an
    // operator than the status code on its own.
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.description ?? `Telegram returned HTTP ${response.status}`);
    }
    return { providerMessageId: payload.result?.message_id ? String(payload.result.message_id) : null };
  }
};

// Telegram carries at most 64 bytes of callback data, which is exactly what a
// prompt id plus a button index needs.
const TELEGRAM_CALLBACK_PREFIX = "cfman";

function telegramApi(botToken: string, method: string, payload: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  return fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal
  }).then(async (response) => {
    const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: unknown };
    if (!response.ok || result.ok === false) {
      throw new Error(result.description ?? `Telegram returned HTTP ${response.status}`);
    }
    return result as Record<string, unknown>;
  });
}

function describePresser(from: { username?: string; first_name?: string; last_name?: string; id?: number } | undefined): string | null {
  if (!from) return null;
  if (from.username) return `@${from.username}`;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return name || (from.id === undefined ? null : `id ${from.id}`);
}

telegramAdapter.pollKey = ({ secrets }) => `telegram:${secrets.botToken ?? ""}`;

telegramAdapter.interactive = {
  // One row of buttons stays readable on a phone; more than this belongs in a
  // question asked a different way.
  maxButtons: 5,
  send: async ({ config, secrets, body, promptId, buttons }) => {
    const parsed = telegramConfigSchema.parse(config);
    const botToken = secrets.botToken;
    if (!botToken) throw new Error("This Telegram channel has no bot token configured");
    const result = await telegramApi(botToken, "sendMessage", {
      chat_id: parsed.chatId,
      text: body,
      ...(parsed.parseMode === "none" ? {} : { parse_mode: parsed.parseMode === "html" ? "HTML" : "MarkdownV2" }),
      ...(parsed.disableNotification ? { disable_notification: true } : {}),
      reply_markup: {
        inline_keyboard: [buttons.map((button, index) => ({
          text: button.label,
          callback_data: `${TELEGRAM_CALLBACK_PREFIX}:${promptId}:${index}`
        }))]
      }
    }, AbortSignal.timeout(20_000));
    const message = result.result as { message_id?: number } | undefined;
    return { providerMessageId: message?.message_id ? String(message.message_id) : null };
  },
  poll: async ({ secrets, cursor, signal }) => {
    const botToken = secrets.botToken;
    if (!botToken) throw new Error("This Telegram channel has no bot token configured");
    let result: Record<string, unknown>;
    try {
      result = await telegramApi(botToken, "getUpdates", {
        ...(cursor ? { offset: Number(cursor) } : {}),
        timeout: 25,
        allowed_updates: ["callback_query"]
      }, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A webhook and getUpdates are mutually exclusive on Telegram's side,
      // and the raw conflict text does not say what to do about it.
      if (message.includes("webhook is active")) {
        throw new Error("This bot has a webhook configured, so CFMan cannot receive button presses. Delete the webhook (deleteWebhook) and try again.");
      }
      throw error;
    }
    const updates = (result.result ?? []) as Array<{
      update_id: number;
      callback_query?: { id: string; data?: string; from?: { username?: string; first_name?: string; last_name?: string; id?: number } };
    }>;
    const events: PromptEvent[] = [];
    let nextCursor = cursor;
    for (const update of updates) {
      nextCursor = String(update.update_id + 1);
      const query = update.callback_query;
      const parts = query?.data?.split(":") ?? [];
      if (!query || parts[0] !== TELEGRAM_CALLBACK_PREFIX || parts.length !== 3) continue;
      const buttonIndex = Number(parts[2]);
      if (!Number.isInteger(buttonIndex)) continue;
      events.push({ promptId: parts[1] ?? "", buttonIndex, answeredBy: describePresser(query.from), token: query.id });
    }
    return { cursor: nextCursor, events };
  },
  acknowledge: async ({ secrets, event, text }) => {
    await telegramApi(secrets.botToken ?? "", "answerCallbackQuery", {
      callback_query_id: event.token,
      text: text.slice(0, 200)
    }, AbortSignal.timeout(15_000));
  },
  close: async ({ config, secrets, providerMessageId, body }) => {
    if (!providerMessageId) return;
    const parsed = telegramConfigSchema.parse(config);
    await telegramApi(secrets.botToken ?? "", "editMessageText", {
      chat_id: parsed.chatId,
      message_id: Number(providerMessageId),
      text: body,
      ...(parsed.parseMode === "none" ? {} : { parse_mode: parsed.parseMode === "html" ? "HTML" : "MarkdownV2" })
    }, AbortSignal.timeout(15_000));
  }
};

const adapters: Record<ChannelType, ChannelAdapter> = { telegram: telegramAdapter };

export const CHANNEL_TYPES = Object.keys(adapters) as ChannelType[];

export function getChannelAdapter(type: ChannelType): ChannelAdapter {
  const adapter = adapters[type];
  if (!adapter) throw new Error(`Unsupported channel type: ${type}`);
  return adapter;
}

export function channelTypeCatalog(): Array<{ type: ChannelType; label: string; secretFields: string[]; supportsButtons: boolean; maxButtons: number }> {
  return CHANNEL_TYPES.map((type) => ({
    type,
    label: adapters[type].label,
    secretFields: Object.keys(adapters[type].secretSchema.shape),
    supportsButtons: Boolean(adapters[type].interactive),
    maxButtons: adapters[type].interactive?.maxButtons ?? 0
  }));
}

export function channelSupportsButtons(type: ChannelType): boolean {
  return Boolean(adapters[type].interactive);
}

export function parseChannelConfig(type: ChannelType, config: unknown): Record<string, unknown> {
  return getChannelAdapter(type).configSchema.parse(config ?? {}) as Record<string, unknown>;
}

export function parseChannelSecrets(type: ChannelType, secrets: unknown, { partial }: { partial: boolean }): Record<string, string> {
  const adapter = getChannelAdapter(type);
  const schema = partial ? adapter.secretSchema.partial() : adapter.secretSchema;
  const parsed = schema.parse(secrets ?? {}) as Record<string, string | undefined>;
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string" && value.length > 0)) as Record<string, string>;
}

export function encryptChannelSecrets(secrets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(secrets).map(([key, value]) => [key, encryptSecret(value)]));
}

export function decryptChannelSecrets(stored: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(stored ?? {}).map(([key, value]) => [key, decryptSecret(value)]));
}

// Never returns the secret itself - only enough of it for an operator to tell
// which credential is currently stored.
function hintChannelSecrets(stored: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(stored ?? {}).map(([key, value]) => {
    try {
      const plain = decryptSecret(value);
      return [key, plain.length <= 8 ? "••••" : `••••${plain.slice(-4)}`];
    } catch {
      return [key, "••••"];
    }
  }));
}

const channelColumns = `id, key, name, type, description, enabled, config, secrets,
       last_used_at AS "lastUsedAt", last_error AS "lastError",
       created_at AS "createdAt", updated_at AS "updatedAt"`;

export function toChannelSummary(record: ChannelRecord): ChannelSummary {
  const { secrets, ...rest } = record;
  let target = "";
  try {
    target = getChannelAdapter(record.type).describe(record.config);
  } catch {
    target = "Incomplete configuration";
  }
  const adapter = getChannelAdapter(record.type);
  return {
    ...rest,
    typeLabel: adapter.label,
    target,
    secretHints: hintChannelSecrets(secrets),
    supportsButtons: Boolean(adapter.interactive),
    maxButtons: adapter.interactive?.maxButtons ?? 0
  };
}

export async function listChannels(): Promise<ChannelSummary[]> {
  const result = await pool.query(`SELECT ${channelColumns} FROM notification_channels ORDER BY key`);
  return result.rows.map((row) => toChannelSummary(row as ChannelRecord));
}

export async function getChannelById(id: string): Promise<ChannelRecord | null> {
  const result = await pool.query(`SELECT ${channelColumns} FROM notification_channels WHERE id = $1`, [id]);
  return (result.rows[0] as ChannelRecord | undefined) ?? null;
}

export async function getChannelByKey(key: string): Promise<ChannelRecord | null> {
  const result = await pool.query(`SELECT ${channelColumns} FROM notification_channels WHERE key = $1`, [key]);
  return (result.rows[0] as ChannelRecord | undefined) ?? null;
}

export class ChannelSendError extends Error {
  constructor(message: string, public readonly messageId: string | null) {
    super(message);
  }
}

export type SendMessageInput = {
  channel: ChannelRecord;
  body: string;
  automationRunId?: string | null;
  requestedBy?: string | null;
  requestedVia?: "web" | "mcp" | "automation";
};

export type SendMessageRecord = {
  messageId: string;
  channelId: string;
  channelKey: string;
  status: "sent";
  providerMessageId: string | null;
  truncated: boolean;
  bodyLength: number;
};

export async function sendChannelMessage(input: SendMessageInput): Promise<SendMessageRecord> {
  const { channel } = input;
  if (!channel.enabled) throw new ChannelSendError(`Channel "${channel.key}" is disabled`, null);
  const adapter = getChannelAdapter(channel.type);
  const trimmed = input.body.trim();
  if (!trimmed) throw new ChannelSendError("Message body is empty", null);
  const truncated = trimmed.length > adapter.maxBodyLength;
  const body = truncated ? `${trimmed.slice(0, adapter.maxBodyLength - 10)}\n[...]` : trimmed;
  const record = async (status: "sent" | "failed", error: string | null, providerMessageId: string | null) => {
    const inserted = await pool.query(
      `INSERT INTO notification_messages(channel_id, automation_run_id, body, status, error, provider_message_id, requested_by, requested_via)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        channel.id,
        input.automationRunId ?? null,
        body,
        status,
        error,
        providerMessageId,
        input.requestedBy ?? null,
        input.requestedVia ?? "web"
      ]
    );
    return inserted.rows[0].id as string;
  };
  try {
    const result = await adapter.send({ config: channel.config, secrets: decryptChannelSecrets(channel.secrets), body });
    const messageId = await record("sent", null, result.providerMessageId);
    await pool.query("UPDATE notification_channels SET last_used_at = now(), last_error = null WHERE id = $1", [channel.id]);
    return {
      messageId,
      channelId: channel.id,
      channelKey: channel.key,
      status: "sent",
      providerMessageId: result.providerMessageId,
      truncated,
      bodyLength: body.length
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send the message";
    const messageId = await record("failed", message, null);
    await pool.query("UPDATE notification_channels SET last_used_at = now(), last_error = $1 WHERE id = $2", [message, channel.id]);
    throw new ChannelSendError(message, messageId);
  }
}
