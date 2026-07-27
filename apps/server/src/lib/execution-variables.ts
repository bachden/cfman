import { z } from "zod";
import { pool } from "./database.js";

const variableNameSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Variable names may contain letters, numbers, and underscores, and cannot start with a number");
const variableValueSchema = z.string().max(10_000).refine((value) => !value.includes("\0"), "Variable values cannot contain null bytes");

export const executionVariablesSchema = z.record(variableNameSchema, variableValueSchema).superRefine((variables, context) => {
  if (Object.keys(variables).length > 100) context.addIssue({ code: "custom", message: "At most 100 variables are allowed" });
});

export const scriptArgumentSchema = z.object({
  name: variableNameSchema,
  defaultValue: variableValueSchema.default(""),
  description: z.string().trim().max(300).default(""),
  required: z.boolean().default(false)
});

export const scriptArgumentsSchema = z.array(scriptArgumentSchema).max(100).superRefine((argumentsList, context) => {
  const names = new Set<string>();
  argumentsList.forEach((argument, index) => {
    const normalized = argument.name.toUpperCase();
    if (names.has(normalized)) context.addIssue({ code: "custom", path: [index, "name"], message: "Argument names must be unique" });
    names.add(normalized);
  });
});

export type ExecutionVariables = z.infer<typeof executionVariablesSchema>;
export type ScriptArgument = z.infer<typeof scriptArgumentSchema>;

export const STORE_BUILT_IN_VARIABLES = ["TENANT_CODE", "STORE_NAME", "STORE_CODE"] as const;

// How a declared script argument gets its value at execution time. This is a
// mapping chosen by the operator when preparing a run - it is never persisted
// as part of the script/argument definition, and script arguments and
// environment variables otherwise know nothing about each other.
export const argumentBindingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("custom"), value: variableValueSchema }),
  z.object({ type: z.literal("variable"), variable: variableNameSchema })
]);

export const argumentBindingsSchema = z.record(variableNameSchema, argumentBindingSchema).superRefine((bindings, context) => {
  if (Object.keys(bindings).length > 100) context.addIssue({ code: "custom", message: "At most 100 argument bindings are allowed" });
});

export type ArgumentBinding = z.infer<typeof argumentBindingSchema>;
export type ArgumentBindings = z.infer<typeof argumentBindingsSchema>;

type StoreVariableScope = {
  id: string;
  tenantCode: string;
  storeCode: string;
  storeName: string;
  storeVariables: unknown;
  computerVariables: unknown;
  zoneVariables: unknown;
  accountVariables: unknown;
};

export type VariableSource = "global" | "account" | "zone" | "store" | "built-in" | "computer";

function normalizedVariables(variables: ExecutionVariables): ExecutionVariables {
  return Object.fromEntries(Object.entries(variables).map(([name, value]) => [name.toUpperCase(), value]));
}

// A variable value or an argument value may reference other variables as $NAME
// or ${NAME}. Expansion happens here, in TypeScript, against already-resolved
// values - never by handing the reference to the shell. applyScriptArguments
// still single-quotes every emitted value, so an expanded result can never
// become executable text: a value of $(rm -rf /) stays the literal characters
// "$(rm -rf /)". $$ escapes a literal dollar sign for values that need one.
const VARIABLE_REFERENCE = /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

// Guards against a small set of variables expanding into an enormous string
// (each level multiplying the previous one) before it ever reaches a store.
const MAX_EXPANDED_LENGTH = 20_000;

export class VariableResolutionError extends Error {}

type ExpansionContext = {
  raw: ExecutionVariables;
  // Names resolved from store identity columns. They hold store data, not
  // templates, so a display name containing $FOO stays literal instead of
  // turning arbitrary store data into a reference.
  literals: Set<string>;
  cache: Map<string, string>;
  stack: string[];
};

function expandTemplate(template: string, context: ExpansionContext): string {
  if (!template.includes("$")) return template;
  const expanded = template.replace(VARIABLE_REFERENCE, (match, braced?: string, bare?: string) => {
    if (match === "$$") return "$";
    const name = (braced ?? bare ?? "").toUpperCase();
    // An unknown name stays literal: substituting an empty string would quietly
    // change what a script does, and a typo should be visible in the output.
    if (!(name in context.raw)) return match;
    return resolveVariable(name, context);
  });
  if (expanded.length > MAX_EXPANDED_LENGTH) {
    throw new VariableResolutionError(`Variable expansion exceeded ${MAX_EXPANDED_LENGTH} characters`);
  }
  return expanded;
}

function resolveVariable(name: string, context: ExpansionContext): string {
  const cached = context.cache.get(name);
  if (cached !== undefined) return cached;
  if (context.stack.includes(name)) {
    throw new VariableResolutionError(`Variable reference cycle detected: ${[...context.stack, name].join(" -> ")}`);
  }
  const raw = context.raw[name] ?? "";
  const value = context.literals.has(name) ? raw : (() => {
    context.stack.push(name);
    try {
      return expandTemplate(raw, context);
    } finally {
      context.stack.pop();
    }
  })();
  context.cache.set(name, value);
  return value;
}

// Expands every variable against every other variable. Resolution is eager so
// that a cycle is reported when variables are resolved, not later when some
// unrelated script happens to be the first one to reference it.
export function expandVariableReferences(raw: ExecutionVariables, sources: Record<string, VariableSource>): ExecutionVariables {
  const literals = new Set(Object.entries(sources).filter(([, source]) => source === "built-in").map(([name]) => name));
  const context: ExpansionContext = { raw, literals, cache: new Map(), stack: [] };
  return Object.fromEntries(Object.keys(raw).map((name) => [name, resolveVariable(name, context)]));
}

// Expands references inside a single argument value. The variables passed in
// are already fully expanded, so this is deliberately one pass: a $ that came
// out of a variable's value is data and must never be re-read as a reference.
export function expandArgumentValue(value: string, variables: ExecutionVariables): string {
  if (!value.includes("$")) return value;
  const expanded = value.replace(VARIABLE_REFERENCE, (match, braced?: string, bare?: string) => {
    if (match === "$$") return "$";
    const name = (braced ?? bare ?? "").toUpperCase();
    if (!(name in variables)) return match;
    return variables[name] ?? "";
  });
  if (expanded.length > MAX_EXPANDED_LENGTH) {
    throw new VariableResolutionError(`Variable expansion exceeded ${MAX_EXPANDED_LENGTH} characters`);
  }
  return expanded;
}

function parseStoredVariables(value: unknown): ExecutionVariables {
  const parsed = executionVariablesSchema.safeParse(value ?? {});
  return parsed.success ? normalizedVariables(parsed.data) : {};
}

export async function getGlobalExecutionVariables(): Promise<ExecutionVariables> {
  const result = await pool.query("SELECT value FROM app_settings WHERE key = 'execution_variables'");
  if (!result.rowCount) return {};
  try {
    return parseStoredVariables(JSON.parse(result.rows[0].value as string));
  } catch {
    return {};
  }
}

// Resolves the full set of environment variables available to one store,
// completely independent of any script or argument. This is the "value
// provider" layer: scripts and their arguments know nothing about it until an
// operator explicitly binds an argument to one of these names.
function resolveAvailableVariables(
  scope: StoreVariableScope,
  globalVariables: ExecutionVariables
): { variables: ExecutionVariables; sources: Record<string, VariableSource> } {
  const variables: ExecutionVariables = {};
  const sources: Record<string, VariableSource> = {};
  const merge = (values: ExecutionVariables, source: VariableSource) => {
    for (const [name, value] of Object.entries(normalizedVariables(values))) {
      variables[name] = value;
      sources[name] = source;
    }
  };

  merge(globalVariables, "global");
  merge(parseStoredVariables(scope.accountVariables), "account");
  merge(parseStoredVariables(scope.zoneVariables), "zone");
  merge(parseStoredVariables(scope.storeVariables), "store");
  merge({ TENANT_CODE: scope.tenantCode, STORE_NAME: scope.storeName, STORE_CODE: scope.storeCode }, "built-in");
  merge(parseStoredVariables(scope.computerVariables), "computer");
  // Expansion runs per store: the same $STORE_NAME reference resolves to a
  // different value on every store of a bulk run.
  return { variables: expandVariableReferences(variables, sources), sources };
}

export async function resolveAvailableVariablesForStore(storeId: string): Promise<{ variables: ExecutionVariables; sources: Record<string, VariableSource> }> {
  const resolved = await resolveAvailableVariablesForStores([storeId]);
  const result = resolved.get(storeId);
  if (!result) throw new Error("Store not found");
  return result;
}

export async function resolveAvailableVariablesForStores(
  storeIds: string[]
): Promise<Map<string, { variables: ExecutionVariables; sources: Record<string, VariableSource> }>> {
  if (!storeIds.length) return new Map();
  const [globalVariables, scopeResult] = await Promise.all([
    getGlobalExecutionVariables(),
    pool.query(
      `SELECT s.id, s.tenant_code AS "tenantCode", s.store_code AS "storeCode", s.display_name AS "storeName",
              s.execution_variables AS "storeVariables", z.execution_variables AS "zoneVariables",
              a.execution_variables AS "accountVariables", active_enrollment.execution_variables AS "computerVariables"
         FROM stores s
         JOIN zones z ON z.id = s.zone_id
         JOIN cloudflare_accounts a ON a.id = s.account_id
         LEFT JOIN LATERAL (
           SELECT e.execution_variables
             FROM enrollments e
            WHERE e.store_id = s.id AND e.status IN ('ready', 'installed')
              AND e.unenrolled_at IS NULL AND e.deleted_at IS NULL
            ORDER BY COALESCE(e.installed_at, e.claimed_at, e.created_at) DESC
            LIMIT 1
         ) active_enrollment ON TRUE
        WHERE s.id = ANY($1::uuid[])`,
      [storeIds]
    )
  ]);
  return new Map((scopeResult.rows as StoreVariableScope[]).map((scope) => [scope.id, resolveAvailableVariables(scope, globalVariables)]));
}

// Maps each declared script argument to its final value for one store's
// available variables, following the operator's explicit binding choice: a
// literal custom value, or a reference to one of that store's available
// environment variables (resolved fresh per store, since the same variable
// name can resolve differently on different stores). An argument with no
// binding falls back to its own default value - the argument's default is its
// own value provider, independent of the environment-variable layer.
export function resolveArgumentValues(
  argumentsList: ScriptArgument[],
  availableVariables: ExecutionVariables,
  bindings: ArgumentBindings
): ExecutionVariables {
  const normalizedBindings = Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name.toUpperCase(), binding]));
  const values: ExecutionVariables = {};
  for (const argument of argumentsList) {
    const key = argument.name.toUpperCase();
    const binding = normalizedBindings[key];
    // A "variable" binding is a direct reference, so its value is taken as-is.
    // Custom values and declared defaults are templates and may reference
    // variables themselves.
    if (binding?.type === "variable") values[key] = availableVariables[binding.variable.toUpperCase()] ?? "";
    else if (binding?.type === "custom") values[key] = expandArgumentValue(binding.value, availableVariables);
    else values[key] = expandArgumentValue(argument.defaultValue, availableVariables);
  }
  // Built-in store identity values are always available to every script,
  // regardless of what arguments it declares or how they're mapped - but a
  // script that declares an argument under a built-in name keeps the operator's
  // mapping for it. Overwriting it here would silently discard the chosen
  // binding while describeArgumentValueSources still recorded that binding,
  // leaving history describing a value the run never used.
  for (const name of STORE_BUILT_IN_VARIABLES) {
    if (!(name in values)) values[name] = availableVariables[name] ?? "";
  }

  const missing = argumentsList.filter((argument) => argument.required && !values[argument.name.toUpperCase()]);
  if (missing.length) throw new Error(`Required argument${missing.length === 1 ? "" : "s"} missing a value: ${missing.map((argument) => argument.name).join(", ")}`);
  return values;
}

// Where each resolved argument value in resolveArgumentValues actually came
// from, recorded alongside the value at execution time so history can show
// it later: a literal custom value, the argument's own declared default, or a
// binding to one of the store's resolved variables (with the scope it
// resolved from, since the same variable name can come from a different
// scope on different stores).
export type ArgumentValueSource =
  | { origin: "custom" }
  | { origin: "default" }
  | { origin: "variable"; variable: string; scope: VariableSource };

export function describeArgumentValueSources(
  argumentsList: ScriptArgument[],
  sources: Record<string, VariableSource>,
  bindings: ArgumentBindings
): Record<string, ArgumentValueSource> {
  const normalizedBindings = Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name.toUpperCase(), binding]));
  const result: Record<string, ArgumentValueSource> = {};
  for (const argument of argumentsList) {
    const key = argument.name.toUpperCase();
    const binding = normalizedBindings[key];
    if (binding?.type === "variable") {
      const variable = binding.variable.toUpperCase();
      result[key] = { origin: "variable", variable, scope: sources[variable] ?? "global" };
    } else if (binding?.type === "custom") {
      result[key] = { origin: "custom" };
    } else {
      result[key] = { origin: "default" };
    }
  }
  for (const name of STORE_BUILT_IN_VARIABLES) {
    if (!(name in result)) result[name] = { origin: "variable", variable: name, scope: sources[name] ?? "built-in" };
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// Applies resolved argument values as plain script-scoped variables, not OS
// environment variables: `export`/`$env:` would leak into every child
// process the script spawns and make behavior depend on whatever else that
// specific machine's environment already defines for the same name. A script
// receives arguments, not ambient environment state - it should behave
// identically regardless of which machine runs it.
export function applyScriptArguments(
  script: string,
  language: "powershell" | "bash" | "sh",
  variables: ExecutionVariables
): string {
  const entries = Object.entries(variables).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return script;
  const prologue = language === "powershell"
    ? entries.map(([name, value]) => `$${name} = ${powershellQuote(value)}`).join("\n")
    : entries.map(([name, value]) => `${name}=${shellQuote(value)}`).join("\n");
  return `${prologue}\n${script}`;
}
