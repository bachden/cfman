import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyScriptArguments,
  describeArgumentValueSources,
  expandArgumentValue,
  expandVariableReferences,
  resolveArgumentValues,
  VariableResolutionError,
  type ExecutionVariables,
  type ScriptArgument,
  type VariableSource
} from "../src/lib/execution-variables.js";

const argument = (name: string, overrides: Partial<ScriptArgument> = {}): ScriptArgument => ({
  name,
  defaultValue: "",
  description: "",
  required: false,
  ...overrides
});

const storeScope = (extra: ExecutionVariables = {}, extraSources: Record<string, VariableSource> = {}) => ({
  raw: { TENANT_CODE: "dcorp", STORE_NAME: "PhamHaiTest58", STORE_CODE: "pmha_58", ...extra },
  sources: {
    TENANT_CODE: "built-in" as VariableSource,
    STORE_NAME: "built-in" as VariableSource,
    STORE_CODE: "built-in" as VariableSource,
    ...extraSources
  }
});

test("a variable value can reference another variable", () => {
  const scope = storeScope({ GREETING: "hello from $STORE_NAME" }, { GREETING: "store" });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.GREETING, "hello from PhamHaiTest58");
});

test("references nest through several levels and both syntaxes", () => {
  const scope = storeScope({
    LABEL: "${TENANT_CODE}/${STORE_CODE}",
    BANNER: "site $LABEL",
    MESSAGE: "hello from ${BANNER}"
  }, { LABEL: "global", BANNER: "account", MESSAGE: "store" });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.MESSAGE, "hello from site dcorp/pmha_58");
});

test("a direct cycle is reported with the path that formed it", () => {
  const scope = storeScope({ A: "$B", B: "$C", C: "$A" }, { A: "global", B: "global", C: "global" });
  assert.throws(
    () => expandVariableReferences(scope.raw, scope.sources),
    (error: unknown) => error instanceof VariableResolutionError && /cycle detected: A -> B -> C -> A/.test((error as Error).message)
  );
});

test("a variable referencing itself is a cycle", () => {
  const scope = storeScope({ LOOP: "x$LOOP" }, { LOOP: "store" });
  assert.throws(() => expandVariableReferences(scope.raw, scope.sources), VariableResolutionError);
});

test("a diamond is resolved, not mistaken for a cycle", () => {
  const scope = storeScope({ BASE: "b", LEFT: "$BASE-l", RIGHT: "$BASE-r", TOP: "$LEFT+$RIGHT" }, {
    BASE: "global", LEFT: "global", RIGHT: "global", TOP: "global"
  });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.TOP, "b-l+b-r");
});

test("runaway expansion is stopped instead of reaching a store", () => {
  const raw: ExecutionVariables = { L0: "x".repeat(200) };
  const sources: Record<string, VariableSource> = { L0: "global" };
  for (let level = 1; level <= 12; level += 1) {
    raw[`L${level}`] = `$L${level - 1}$L${level - 1}`;
    sources[`L${level}`] = "global";
  }
  assert.throws(() => expandVariableReferences(raw, sources), VariableResolutionError);
});

test("built-in store identity is data, never a template", () => {
  const scope = storeScope({ INJECTED: "boom" });
  scope.raw.STORE_NAME = "shop $INJECTED";
  scope.sources.INJECTED = "store";
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.STORE_NAME, "shop $INJECTED");
});

test("an unknown name stays literal instead of silently emptying", () => {
  const scope = storeScope({ GREETING: "hello $NOT_DEFINED" }, { GREETING: "store" });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.GREETING, "hello $NOT_DEFINED");
});

test("$$ escapes a literal dollar sign", () => {
  const scope = storeScope({ PRICE: "$$5 for $STORE_CODE" }, { PRICE: "store" });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.PRICE, "$5 for pmha_58");
});

test("a custom argument value resolves against the store's variables", () => {
  const scope = storeScope();
  const available = expandVariableReferences(scope.raw, scope.sources);
  const values = resolveArgumentValues(
    [argument("GREETING")],
    available,
    { GREETING: { type: "custom", value: "hello from $STORE_NAME" } }
  );
  assert.equal(values.GREETING, "hello from PhamHaiTest58");
});

test("a declared default resolves the same way as a custom value", () => {
  const scope = storeScope();
  const available = expandVariableReferences(scope.raw, scope.sources);
  const values = resolveArgumentValues([argument("GREETING", { defaultValue: "hi ${STORE_CODE}" })], available, {});
  assert.equal(values.GREETING, "hi pmha_58");
});

test("the same argument resolves per store, which is what bulk runs rely on", () => {
  const bindings = { GREETING: { type: "custom" as const, value: "hello from $STORE_NAME" } };
  const first = expandVariableReferences(storeScope().raw, storeScope().sources);
  const secondScope = storeScope();
  secondScope.raw.STORE_NAME = "OtherStore";
  const second = expandVariableReferences(secondScope.raw, secondScope.sources);
  assert.equal(resolveArgumentValues([argument("GREETING")], first, bindings).GREETING, "hello from PhamHaiTest58");
  assert.equal(resolveArgumentValues([argument("GREETING")], second, bindings).GREETING, "hello from OtherStore");
});

test("a dollar sign produced by expansion is data, not a second-round reference", () => {
  const scope = storeScope({ PAYLOAD: "$$STORE_NAME" }, { PAYLOAD: "store" });
  const available = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(available.PAYLOAD, "$STORE_NAME");
  assert.equal(expandArgumentValue("value: $PAYLOAD", available), "value: $STORE_NAME");
});

test("an expanded value cannot become executable shell text", () => {
  const scope = storeScope({ EVIL: "$(touch /tmp/pwned)" }, { EVIL: "store" });
  const available = expandVariableReferences(scope.raw, scope.sources);
  const values = resolveArgumentValues([argument("ARG")], available, { ARG: { type: "custom", value: "x $EVIL" } });
  assert.equal(values.ARG, "x $(touch /tmp/pwned)");
  const bash = applyScriptArguments("echo \"$ARG\"", "bash", values);
  assert.match(bash, /^ARG='x \$\(touch \/tmp\/pwned\)'$/m);
});

// Run the generated prologue through a real shell rather than asserting on the
// escaping itself: what matters is that a hostile value stays one inert string.
test("a quote in an expanded value cannot break out of its assignment", () => {
  const marker = join(tmpdir(), `cfman-injection-${randomUUID()}`);
  const payload = `'; touch ${marker}; x='`;
  const scope = storeScope({ EVIL: payload }, { EVIL: "store" });
  const available = expandVariableReferences(scope.raw, scope.sources);
  const values = resolveArgumentValues([argument("ARG")], available, { ARG: { type: "custom", value: "$EVIL" } });

  const script = applyScriptArguments('printf %s "$ARG"', "bash", values);
  const stdout = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(stdout, payload, "the value must survive as literal text");
  assert.equal(existsSync(marker), false, "the payload must not have executed");

  // pwsh is not assumed to be installed, so this side is checked by construction.
  const powershell = applyScriptArguments("$true", "powershell", values);
  assert.match(powershell, /^\$ARG = '''; touch .+; x='''$/m);
});

test("an argument declared under a built-in name keeps the operator's mapping", () => {
  const scope = storeScope({ GREETING_FROM_STORE: "Hello, this is PhamHaiTest58!!!" }, { GREETING_FROM_STORE: "store" });
  const available = expandVariableReferences(scope.raw, scope.sources);
  const argumentsList = [argument("STORE_NAME", { required: true }), argument("STORE_TENANT", { required: true })];
  const bindings = {
    STORE_NAME: { type: "variable" as const, variable: "GREETING_FROM_STORE" },
    STORE_TENANT: { type: "variable" as const, variable: "GREETING_FROM_STORE" }
  };
  const values = resolveArgumentValues(argumentsList, available, bindings);
  assert.equal(values.STORE_NAME, "Hello, this is PhamHaiTest58!!!", "the built-in must not overwrite a declared argument");
  assert.equal(values.STORE_TENANT, "Hello, this is PhamHaiTest58!!!");
  // The recorded source has always claimed the binding, so the value has to agree with it.
  const sources = describeArgumentValueSources(argumentsList, scope.sources, bindings);
  assert.deepEqual(sources.STORE_NAME, { origin: "variable", variable: "GREETING_FROM_STORE", scope: "store" });
});

test("built-in identity is still injected for arguments a script does not declare", () => {
  const scope = storeScope();
  const available = expandVariableReferences(scope.raw, scope.sources);
  const values = resolveArgumentValues([argument("OTHER")], available, {});
  assert.equal(values.STORE_NAME, "PhamHaiTest58");
  assert.equal(values.TENANT_CODE, "dcorp");
  assert.equal(values.STORE_CODE, "pmha_58");
});

test("a required argument that expands to nothing is still rejected", () => {
  const scope = storeScope({ EMPTY: "" }, { EMPTY: "store" });
  const available = expandVariableReferences(scope.raw, scope.sources);
  assert.throws(
    () => resolveArgumentValues([argument("ARG", { required: true })], available, { ARG: { type: "custom", value: "$EMPTY" } }),
    /Required argument missing a value: ARG/
  );
});
