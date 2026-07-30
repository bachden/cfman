import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyScriptArguments,
  assertNoArgumentNesting,
  describeArgumentValueSources,
  expandArgumentValue,
  expandVariableReferences,
  resolveArgumentValues,
  scriptArgumentsSchema,
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

const tunnelScope = (extra: ExecutionVariables = {}, extraSources: Record<string, VariableSource> = {}) => ({
  raw: { TENANT_CODE: "acme", TUNNEL_NAME: "PhamHaiTest58", TUNNEL_CODE: "pmha_58", ...extra },
  sources: {
    TENANT_CODE: "built-in" as VariableSource,
    TUNNEL_NAME: "built-in" as VariableSource,
    TUNNEL_CODE: "built-in" as VariableSource,
    ...extraSources
  }
});

test("a variable value can reference another variable", () => {
  const scope = tunnelScope({ GREETING: "hello from $TUNNEL_NAME" }, { GREETING: "tunnel" });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.GREETING, "hello from PhamHaiTest58");
});

test("references nest through several levels and both syntaxes", () => {
  const scope = tunnelScope({
    LABEL: "${TENANT_CODE}/${TUNNEL_CODE}",
    BANNER: "site $LABEL",
    MESSAGE: "hello from ${BANNER}"
  }, { LABEL: "global", BANNER: "account", MESSAGE: "tunnel" });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.MESSAGE, "hello from site acme/pmha_58");
});

test("a direct cycle is reported with the path that formed it", () => {
  const scope = tunnelScope({ A: "$B", B: "$C", C: "$A" }, { A: "global", B: "global", C: "global" });
  assert.throws(
    () => expandVariableReferences(scope.raw, scope.sources),
    (error: unknown) => error instanceof VariableResolutionError && /cycle detected: A -> B -> C -> A/.test((error as Error).message)
  );
});

test("a variable referencing itself is a cycle", () => {
  const scope = tunnelScope({ LOOP: "x$LOOP" }, { LOOP: "tunnel" });
  assert.throws(() => expandVariableReferences(scope.raw, scope.sources), VariableResolutionError);
});

test("a diamond is resolved, not mistaken for a cycle", () => {
  const scope = tunnelScope({ BASE: "b", LEFT: "$BASE-l", RIGHT: "$BASE-r", TOP: "$LEFT+$RIGHT" }, {
    BASE: "global", LEFT: "global", RIGHT: "global", TOP: "global"
  });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.TOP, "b-l+b-r");
});

test("runaway expansion is stopped instead of reaching a tunnel", () => {
  const raw: ExecutionVariables = { L0: "x".repeat(200) };
  const sources: Record<string, VariableSource> = { L0: "global" };
  for (let level = 1; level <= 12; level += 1) {
    raw[`L${level}`] = `$L${level - 1}$L${level - 1}`;
    sources[`L${level}`] = "global";
  }
  assert.throws(() => expandVariableReferences(raw, sources), VariableResolutionError);
});

test("built-in tunnel identity is data, never a template", () => {
  const scope = tunnelScope({ INJECTED: "boom" });
  scope.raw.TUNNEL_NAME = "shop $INJECTED";
  scope.sources.INJECTED = "tunnel";
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.TUNNEL_NAME, "shop $INJECTED");
});

test("an unknown name stays literal instead of silently emptying", () => {
  const scope = tunnelScope({ GREETING: "hello $NOT_DEFINED" }, { GREETING: "tunnel" });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.GREETING, "hello $NOT_DEFINED");
});

test("$$ escapes a literal dollar sign", () => {
  const scope = tunnelScope({ PRICE: "$$5 for $TUNNEL_CODE" }, { PRICE: "tunnel" });
  const resolved = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(resolved.PRICE, "$5 for pmha_58");
});

test("a custom argument value resolves against the tunnel's variables", () => {
  const scope = tunnelScope();
  const available = expandVariableReferences(scope.raw, scope.sources);
  const values = resolveArgumentValues(
    [argument("GREETING")],
    available,
    { GREETING: { type: "custom", value: "hello from $TUNNEL_NAME" } }
  );
  assert.equal(values.GREETING, "hello from PhamHaiTest58");
});

test("a declared default resolves the same way as a custom value", () => {
  const scope = tunnelScope();
  const available = expandVariableReferences(scope.raw, scope.sources);
  const values = resolveArgumentValues([argument("GREETING", { defaultValue: "hi ${TUNNEL_CODE}" })], available, {});
  assert.equal(values.GREETING, "hi pmha_58");
});

test("the same argument resolves per tunnel, which is what bulk runs rely on", () => {
  const bindings = { GREETING: { type: "custom" as const, value: "hello from $TUNNEL_NAME" } };
  const first = expandVariableReferences(tunnelScope().raw, tunnelScope().sources);
  const secondScope = tunnelScope();
  secondScope.raw.TUNNEL_NAME = "OtherTunnel";
  const second = expandVariableReferences(secondScope.raw, secondScope.sources);
  assert.equal(resolveArgumentValues([argument("GREETING")], first, bindings).GREETING, "hello from PhamHaiTest58");
  assert.equal(resolveArgumentValues([argument("GREETING")], second, bindings).GREETING, "hello from OtherTunnel");
});

test("a dollar sign produced by expansion is data, not a second-round reference", () => {
  const scope = tunnelScope({ PAYLOAD: "$$TUNNEL_NAME" }, { PAYLOAD: "tunnel" });
  const available = expandVariableReferences(scope.raw, scope.sources);
  assert.equal(available.PAYLOAD, "$TUNNEL_NAME");
  assert.equal(expandArgumentValue("value: $PAYLOAD", available), "value: $TUNNEL_NAME");
});

test("an expanded value cannot become executable shell text", () => {
  const scope = tunnelScope({ EVIL: "$(touch /tmp/pwned)" }, { EVIL: "tunnel" });
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
  const scope = tunnelScope({ EVIL: payload }, { EVIL: "tunnel" });
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
  const scope = tunnelScope({ GREETING_FROM_TUNNEL: "Hello, this is PhamHaiTest58!!!" }, { GREETING_FROM_TUNNEL: "tunnel" });
  const available = expandVariableReferences(scope.raw, scope.sources);
  const argumentsList = [argument("TUNNEL_NAME", { required: true }), argument("TUNNEL_TENANT", { required: true })];
  const bindings = {
    TUNNEL_NAME: { type: "variable" as const, variable: "GREETING_FROM_TUNNEL" },
    TUNNEL_TENANT: { type: "variable" as const, variable: "GREETING_FROM_TUNNEL" }
  };
  const values = resolveArgumentValues(argumentsList, available, bindings);
  assert.equal(values.TUNNEL_NAME, "Hello, this is PhamHaiTest58!!!", "the built-in must not overwrite a declared argument");
  assert.equal(values.TUNNEL_TENANT, "Hello, this is PhamHaiTest58!!!");
  // The recorded source has always claimed the binding, so the value has to agree with it.
  const sources = describeArgumentValueSources(argumentsList, scope.sources, bindings);
  assert.deepEqual(sources.TUNNEL_NAME, { origin: "variable", variable: "GREETING_FROM_TUNNEL", scope: "tunnel" });
});

test("built-in identity is still injected for arguments a script does not declare", () => {
  const scope = tunnelScope();
  const available = expandVariableReferences(scope.raw, scope.sources);
  const values = resolveArgumentValues([argument("OTHER")], available, {});
  assert.equal(values.TUNNEL_NAME, "PhamHaiTest58");
  assert.equal(values.TENANT_CODE, "acme");
  assert.equal(values.TUNNEL_CODE, "pmha_58");
});

test("a required argument that expands to nothing is still rejected", () => {
  const scope = tunnelScope({ EMPTY: "" }, { EMPTY: "tunnel" });
  const available = expandVariableReferences(scope.raw, scope.sources);
  assert.throws(
    () => resolveArgumentValues([argument("ARG", { required: true })], available, { ARG: { type: "custom", value: "$EMPTY" } }),
    /Required argument missing a value: ARG/
  );
});

test("a script argument's default value cannot reference another argument", () => {
  const result = scriptArgumentsSchema.safeParse([argument("ARG_A"), argument("ARG_B", { defaultValue: "computed from $ARG_A" })]);
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /Default value cannot reference argument ARG_A/);
});

test("a script argument's default value referencing itself is rejected the same way", () => {
  const result = scriptArgumentsSchema.safeParse([argument("LOOP", { defaultValue: "x $LOOP" })]);
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /Default value cannot reference argument LOOP/);
});

test("a default value may still reference an environment variable", () => {
  const result = scriptArgumentsSchema.safeParse([argument("GREETING", { defaultValue: "hi $TUNNEL_NAME" })]);
  assert.equal(result.success, true);
});

test("a variable binding cannot point at another declared argument", () => {
  const argumentsList = [argument("ARG_A"), argument("ARG_B")];
  assert.throws(
    () => assertNoArgumentNesting(argumentsList, { ARG_B: { type: "variable", variable: "ARG_A" } }),
    /Argument ARG_B cannot bind to argument ARG_A - arguments cannot reference each other/
  );
});

test("a custom binding cannot reference another declared argument via \\$NAME", () => {
  const argumentsList = [argument("ARG_A"), argument("ARG_B")];
  assert.throws(
    () => assertNoArgumentNesting(argumentsList, { ARG_B: { type: "custom", value: "prefix-$ARG_A" } }),
    /Argument ARG_B cannot reference argument ARG_A - arguments cannot reference each other/
  );
});

test("bindings referencing real environment variables are unaffected by the nesting guard", () => {
  const argumentsList = [argument("ARG_A"), argument("ARG_B")];
  assert.doesNotThrow(() => assertNoArgumentNesting(argumentsList, {
    ARG_A: { type: "variable", variable: "TUNNEL_NAME" },
    ARG_B: { type: "custom", value: "hello $TUNNEL_NAME" }
  }));
});

test("resolveArgumentValues rejects argument nesting before resolving anything", () => {
  const scope = tunnelScope();
  const available = expandVariableReferences(scope.raw, scope.sources);
  const argumentsList = [argument("ARG_A"), argument("ARG_B")];
  assert.throws(
    () => resolveArgumentValues(argumentsList, available, { ARG_B: { type: "variable", variable: "ARG_A" } }),
    VariableResolutionError
  );
});
