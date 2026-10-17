import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { automationTypeDefinitions, AUTOMATION_CONTEXT_METHODS, AUTOMATION_OUTPUT_HELPERS } from "../src/lib/automation/context.js";

// The rule editor's IntelliSense is produced by Monaco's TypeScript worker,
// which is plain JavaScript running against the same declaration file the
// server serves. Driving that worker directly here proves the completions an
// operator sees really do come from this server's context definition - the
// browser only supplies the editor around it.
const require = createRequire(import.meta.url);
// monaco-editor's export map rewrites every subpath onto esm/vs, and the
// package is hoisted to the workspace root by the web app's dependencies.
const workerEntry = require.resolve("monaco-editor/languages/features/typescript/tsWorker.js", {
  paths: [new URL("../../web/", import.meta.url).pathname]
});

type CompletionEntry = { name: string };
type TypeScriptWorkerLike = {
  getCompletionsAtPosition: (fileName: string, position: number) => Promise<{ entries: CompletionEntry[] } | undefined>;
  getQuickInfoAtPosition: (fileName: string, position: number) => Promise<{ displayParts?: Array<{ text: string }> } | undefined>;
};

const MODEL_URI = "inmemory://model/1";
const LIB_PATH = "ts:cfman-automation.d.ts";

async function completionsAt(source: string, marker: string): Promise<string[]> {
  const { create } = await import(workerEntry) as {
    create: (ctx: unknown, data: unknown) => TypeScriptWorkerLike;
  };
  const position = source.indexOf(marker) + marker.length;
  assert.ok(position > marker.length - 1, `marker ${marker} not found`);
  const worker = create(
    {
      getMirrorModels: () => [{
        uri: { toString: () => MODEL_URI, path: "/model/1" },
        version: 1,
        getValue: () => source
      }]
    },
    {
      // Mirrors apps/web/src/components/ScriptEditor.tsx exactly; a drift
      // there is what this test is meant to catch.
      compilerOptions: { target: 99, module: 99, allowNonTsExtensions: true, allowJs: true, lib: ["esnext"] },
      extraLibs: { [LIB_PATH]: { content: automationTypeDefinitions(), version: 1 } },
      inlayHintsOptions: {}
    }
  );
  const completions = await worker.getCompletionsAtPosition(MODEL_URI, position);
  return (completions?.entries ?? []).map((entry) => entry.name);
}

test("typing cfman. offers every context call the sandbox provides", async () => {
  // Completing a real member access, rather than a dangling dot, is what the
  // editor does. In a JavaScript file TypeScript also offers identifiers it
  // saw in the same file, so the probe's own name is dropped here.
  const names = (await completionsAt("cfman.member;", "cfman.")).filter((name) => name !== "cfman");
  const expected = [...AUTOMATION_CONTEXT_METHODS, ...AUTOMATION_OUTPUT_HELPERS].map((member) => member.name);
  for (const name of expected) {
    assert.ok(names.includes(name), `cfman.${name} is missing from the editor suggestions`);
  }
  assert.deepEqual([...names].sort(), [...expected].sort(), "cfman offers exactly the documented calls");
});

test("a context call result is typed, so its fields complete too", async () => {
  const names = await completionsAt("const page = await cfman.listTunnels();\npage.tunnels[0].", "page.tunnels[0].");
  for (const field of ["displayName", "tunnelCode", "cfTunnelStatus", "onboardingStatus", "platform"]) {
    assert.ok(names.includes(field), `tunnel field ${field} is missing from the editor suggestions`);
  }
});

test("the trigger that started the run is typed too", async () => {
  const names = await completionsAt("trigger.", "trigger.");
  assert.ok(names.includes("source"));
  assert.ok(names.includes("firedAt"));
  assert.ok(names.includes("scheduledFor"));
});

test("the editor offers the rule globals but nothing the sandbox lacks", async () => {
  const names = await completionsAt("const value = ", "const value = ");
  for (const global of ["cfman", "trigger", "rule", "sleep", "console", "JSON", "Math", "Promise"]) {
    assert.ok(names.includes(global), `${global} should be suggested`);
  }
  // The sandbox has no DOM and no Node globals; suggesting them would send
  // operators straight into a runtime failure.
  for (const absent of ["fetch", "document", "window", "require", "process", "localStorage"]) {
    assert.ok(!names.includes(absent), `${absent} must not be suggested`);
  }
});
