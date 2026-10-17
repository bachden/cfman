import { createContext, runInContext } from "node:vm";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";

type CallResultMessage = { type: "callResult"; id: number; ok: boolean; value?: unknown; error?: string };

if (!parentPort) throw new Error("Automation sandbox must run inside a worker thread");
const port: MessagePort = parentPort;

const { source, globals, methods } = workerData as {
  source: string;
  globals: Record<string, unknown>;
  methods: string[];
};

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextCallId = 1;

port.on("message", (message: CallResultMessage) => {
  if (message.type !== "callResult") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.value);
  else entry.reject(new Error(message.error ?? "Context call failed"));
});

function callHost(method: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextCallId++;
    pending.set(id, { resolve, reject });
    try {
      port.postMessage({ type: "call", id, method, args });
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error("Unable to reach the automation context"));
    }
  });
}

// Errors created inside the vm context belong to another realm, so
// `instanceof Error` is false for them here; their shape is what identifies
// them, both for logging and for reporting a failed run.
function describeError(error: unknown): { message: string; stack?: string } {
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    const stack = (error as { stack?: unknown }).stack;
    return {
      message: (error as { message: string }).message,
      ...(typeof stack === "string" ? { stack } : {})
    };
  }
  return { message: String(error) };
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
    const described = describeError(value);
    return described.stack ?? described.message;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function emitLog(level: "log" | "warn" | "error", values: unknown[]): void {
  port.postMessage({ type: "log", level, message: values.map(formatLogValue).join(" ").slice(0, 4_000) });
}

const cfman: Record<string, unknown> = Object.fromEntries(
  methods.map((method) => [method, (...args: unknown[]) => callHost(method, args)])
);

// Output helpers: the runner accepts a bare value too, but these make the
// declared MIME type explicit, which is what the run history then renders.
cfman.text = (body: unknown) => ({ mimeType: "text/plain", body: typeof body === "string" ? body : formatLogValue(body) });
cfman.json = (value: unknown) => ({ mimeType: "application/json", body: JSON.stringify(value, null, 2) });
cfman.xml = (body: string) => ({ mimeType: "application/xml", body: String(body) });
cfman.output = (body: string, mimeType: string) => ({ mimeType, body: String(body) });

const sandboxConsole = {
  log: (...values: unknown[]) => emitLog("log", values),
  info: (...values: unknown[]) => emitLog("log", values),
  warn: (...values: unknown[]) => emitLog("warn", values),
  error: (...values: unknown[]) => emitLog("error", values),
  debug: (...values: unknown[]) => emitLog("log", values)
};

const context = createContext({
  ...globals,
  cfman,
  console: sandboxConsole,
  // Timers are the host's, not the sandbox's: an unfinished one cannot
  // outlive the worker, which is terminated as soon as the run settles.
  setTimeout: (handler: () => void, delay: number) => setTimeout(handler, Math.min(Math.max(0, delay), 600_000)),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(0, Number(ms) || 0), 600_000)))
});

async function main(): Promise<void> {
  const factory = runInContext(`(async () => {\n${source}\n})`, context, { filename: "automation-script.js" }) as () => Promise<unknown>;
  const value = await factory();
  port.postMessage({ type: "done", value: normalize(value) });
}

// Everything crossing the thread boundary has to survive structured cloning;
// a function or a class instance in the returned value would otherwise fail
// the postMessage itself with an opaque DataCloneError.
function normalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

main().catch((error: unknown) => {
  port.postMessage({ type: "error", ...describeError(error) });
});
