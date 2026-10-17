import { Worker } from "node:worker_threads";

export type SandboxLog = { at: string; level: "log" | "warn" | "error"; message: string };

export type SandboxCallHandler = (method: string, args: unknown[]) => Promise<unknown>;

export type SandboxRunInput = {
  source: string;
  globals: Record<string, unknown>;
  methods: string[];
  timeoutMs: number;
  onCall: SandboxCallHandler;
  onLog: (log: SandboxLog) => void;
};

export type SandboxRunResult =
  | { status: "completed"; value: unknown }
  | { status: "failed"; error: string; stack?: string }
  | { status: "timed_out"; error: string };

type WorkerMessage =
  | { type: "log"; level: "log" | "warn" | "error"; message: string }
  | { type: "call"; id: number; method: string; args: unknown[] }
  | { type: "done"; value: unknown }
  | { type: "error"; message: string; stack?: string };

// tsx keeps the TypeScript sources in place at runtime, so the compiled
// ".js" sibling only exists in the production build. Resolving against this
// module's own extension is what lets the same code start the worker under
// `tsx watch`, `node --test`, and `node dist/index.js` alike.
const workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./sandbox-worker.ts" : "./sandbox-worker.js", import.meta.url);

export function runInSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  return new Promise<SandboxRunResult>((resolve) => {
    const worker = new Worker(workerUrl, {
      workerData: { source: input.source, globals: input.globals, methods: input.methods },
      // The script is operator-authored but still arbitrary code: it gets no
      // environment variables and no stdio of its own.
      env: {},
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    let settled = false;
    const finish = (result: SandboxRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    // A hard deadline the script cannot escape: an endless loop, a never
    // settling await, or a wedged context call all end the same way, because
    // terminating the worker kills the thread outright.
    const timer = setTimeout(() => {
      finish({ status: "timed_out", error: `Execution exceeded its ${input.timeoutMs} ms limit` });
    }, input.timeoutMs);
    timer.unref();
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "log") {
        input.onLog({ at: new Date().toISOString(), level: message.level, message: message.message });
        return;
      }
      if (message.type === "call") {
        void input.onCall(message.method, message.args)
          .then((value) => worker.postMessage({ type: "callResult", id: message.id, ok: true, value }))
          .catch((error: unknown) => worker.postMessage({
            type: "callResult",
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : "Context call failed"
          }));
        return;
      }
      if (message.type === "done") {
        finish({ status: "completed", value: message.value });
        return;
      }
      finish({ status: "failed", error: message.message, ...(message.stack ? { stack: message.stack } : {}) });
    });
    worker.on("error", (error) => {
      finish({ status: "failed", error: error instanceof Error ? error.message : "Sandbox worker failed" });
    });
    worker.on("exit", (code) => {
      finish({ status: "failed", error: `Sandbox worker exited unexpectedly with code ${code}` });
    });
  });
}
