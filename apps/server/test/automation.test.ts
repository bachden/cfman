import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRuns, scheduleSchema } from "../src/lib/automation/cron.js";
import { runInSandbox } from "../src/lib/automation/sandbox.js";
import { normalizeScriptOutput } from "../src/lib/automation/runner.js";

function sandbox(source: string, overrides: Partial<Parameters<typeof runInSandbox>[0]> = {}) {
  return runInSandbox({
    source,
    globals: { trigger: { source: "manual" } },
    methods: ["listTunnels"],
    timeoutMs: 5_000,
    onCall: async (method, args) => ({ method, args }),
    onLog: () => undefined,
    ...overrides
  });
}

test("a rule script returns its value to the host", async () => {
  const result = await sandbox("return { ok: true, startedBy: trigger.source };");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" ? result.value : null, { ok: true, startedBy: "manual" });
});

test("context calls are dispatched back to the host", async () => {
  const result = await sandbox("const answer = await cfman.listTunnels({ limit: 5 }); return answer;");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" ? result.value : null, { method: "listTunnels", args: [{ limit: 5 }] });
});

test("console output is streamed as run logs", async () => {
  const logs: string[] = [];
  const result = await sandbox("console.log('checked', 3); return 'done';", { onLog: (log) => logs.push(log.message) });
  assert.equal(result.status, "completed");
  assert.deepEqual(logs, ["checked 3"]);
});

test("an endless loop is stopped by the run timeout", async () => {
  const result = await sandbox("while (true) {}", { timeoutMs: 1_000 });
  assert.equal(result.status, "timed_out");
});

test("an await that never settles is stopped by the run timeout", async () => {
  const result = await sandbox("await new Promise(() => {}); return 'unreachable';", { timeoutMs: 1_000 });
  assert.equal(result.status, "timed_out");
});

test("a thrown error is reported without killing the host", async () => {
  const result = await sandbox("throw new Error('boom');");
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" ? result.error : null, "boom");
});

test("the sandbox has no access to the host runtime", async () => {
  const result = await sandbox("return typeof process + ',' + typeof require + ',' + typeof fetch;");
  assert.equal(result.status, "completed");
  assert.equal(result.status === "completed" ? result.value : null, "undefined,undefined,undefined");
});

test("output helpers declare their MIME type", async () => {
  const result = await sandbox("return cfman.json({ failed: 2 });");
  assert.equal(result.status, "completed");
  assert.deepEqual(normalizeScriptOutput(result.status === "completed" ? result.value : null), {
    mimeType: "application/json",
    body: JSON.stringify({ failed: 2 }, null, 2)
  });
});

test("a bare return value is typed by its JavaScript type", () => {
  assert.deepEqual(normalizeScriptOutput("hello"), { mimeType: "text/plain", body: "hello" });
  assert.deepEqual(normalizeScriptOutput({ a: 1 }), { mimeType: "application/json", body: JSON.stringify({ a: 1 }, null, 2) });
  assert.deepEqual(normalizeScriptOutput(undefined), { mimeType: "text/plain", body: "" });
});

test("a cron expression is validated with its own time zone", () => {
  const schedule = scheduleSchema.parse({ cron: "0 8 * * *", timezone: "Asia/Ho_Chi_Minh" });
  const runs = nextRuns(schedule, 2, new Date("2026-03-01T00:00:00Z"));
  assert.equal(runs.length, 2);
  assert.equal(runs[0], "2026-03-01T01:00:00.000Z");
  assert.equal(scheduleSchema.safeParse({ cron: "not a cron", timezone: "UTC" }).success, false);
  assert.equal(scheduleSchema.safeParse({ cron: "0 8 * * *", timezone: "Mars/Olympus" }).success, false);
});

// The runner is exercised against the real tables: the rule, the run row, and
// the side effect the script performs all have to line up, which no
// sandbox-only test can show.
test("a rule run records the outcome of its one script", async (t) => {
  const database = await import("../src/lib/database.js");
  await database.runMigrations();
  const { runAutomationRule } = await import("../src/lib/automation/runner.js");
  const { pool } = database;
  const suffix = Date.now().toString(36);
  t.after(async () => {
    await pool.query("DELETE FROM automation_rules WHERE key LIKE $1", [`test-${suffix}%`]);
  });

  const { saveRuleScript } = await import("../src/lib/automation/versions.js");
  const createRule = async (key: string, scriptSource: string) => {
    const inserted = await pool.query(
      `INSERT INTO automation_rules(key, name, cron, timezone, script_timeout_ms)
       VALUES ($1, $2, '0 0 * * *', 'UTC', 10000)
       RETURNING id`,
      [key, key]
    );
    const ruleId = inserted.rows[0].id as string;
    await saveRuleScript({ ruleId, scriptSource, createdBy: null });
    return ruleId;
  };

  const reporting = await createRule(`test-${suffix}-ok`, "return cfman.json({ failed: 3 });");
  const succeeded = await runAutomationRule({ ruleId: reporting, trigger: "manual" });
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.output?.mimeType, "application/json");

  // The script decides for itself whether there is anything to report, so a
  // quiet run is an ordinary success with an empty result.
  const quiet = await createRule(`test-${suffix}-quiet`, "if (0 > 1) return 'unreachable';");
  const quietRun = await runAutomationRule({ ruleId: quiet, trigger: "manual" });
  assert.equal(quietRun.status, "succeeded");
  assert.equal(quietRun.output?.body, "");

  // Sending through a channel that does not exist fails the script itself,
  // which is the whole run: there is no separate action stage left to fail.
  const sending = await createRule(`test-${suffix}-send`, `await cfman.sendMessage("missing-${suffix}", "hello");`);
  const sendRun = await runAutomationRule({ ruleId: sending, trigger: "manual" });
  assert.equal(sendRun.status, "failed");
  assert.match(sendRun.error ?? "", /missing-/);

  const persisted = await pool.query(
    "SELECT status, output_mime_type FROM automation_runs WHERE rule_id = ANY($1::uuid[]) ORDER BY started_at",
    [[reporting, quiet, sending]]
  );
  assert.deepEqual(persisted.rows.map((row) => row.status), ["succeeded", "succeeded", "failed"]);
  assert.equal(persisted.rows[0].output_mime_type, "application/json");
});

// Versioning is what lets a finished run still be read against the source it
// executed, so the run row has to point at a version, not at whatever the
// rule holds today.
test("saving an edited script creates a version, and a run records the version it executed", async (t) => {
  const database = await import("../src/lib/database.js");
  await database.runMigrations();
  const { runAutomationRule } = await import("../src/lib/automation/runner.js");
  const { saveRuleScript, latestRuleVersion } = await import("../src/lib/automation/versions.js");
  const { pool } = database;
  const suffix = Date.now().toString(36);
  const key = `test-${suffix}-versions`;
  // The last test touching the database closes the shared pool for the file.
  t.after(async () => {
    await pool.query("DELETE FROM automation_rules WHERE key = $1", [key]);
    await pool.end();
  });

  const inserted = await pool.query(
    `INSERT INTO automation_rules(key, name, cron, timezone, script_timeout_ms)
     VALUES ($1, $1, '0 0 * * *', 'UTC', 10000) RETURNING id`,
    [key]
  );
  const ruleId = inserted.rows[0].id as string;

  const first = await saveRuleScript({ ruleId, scriptSource: "return 'one';", createdBy: null });
  assert.deepEqual([first.version, first.created], [1, true]);

  // Saving a rule whose script did not change must not spend a version number.
  const unchanged = await saveRuleScript({ ruleId, scriptSource: "return 'one';", createdBy: null });
  assert.deepEqual([unchanged.version, unchanged.created, unchanged.versionId], [1, false, first.versionId]);

  const firstRun = await runAutomationRule({ ruleId, trigger: "manual" });
  assert.equal(firstRun.scriptVersion, 1);
  assert.equal(firstRun.sequence, 1);
  assert.equal(firstRun.output?.body, "one");

  const second = await saveRuleScript({ ruleId, scriptSource: "return 'two';", createdBy: null });
  assert.deepEqual([second.version, second.created], [2, true]);
  assert.equal((await latestRuleVersion(ruleId))?.version, 2);

  // A run always takes the newest version, and the earlier run keeps pointing
  // at the source it really ran.
  const secondRun = await runAutomationRule({ ruleId, trigger: "manual" });
  assert.equal(secondRun.scriptVersion, 2);
  // The sequence counts runs of the rule, so a new version does not restart it.
  assert.equal(secondRun.sequence, 2);
  assert.equal(secondRun.output?.body, "two");

  const runRows = await pool.query(
    `SELECT v.version, run.output_body AS "outputBody", v.script_source AS "scriptSource"
       FROM automation_runs run
       JOIN automation_rule_versions v ON v.id = run.script_version_id
      WHERE run.rule_id = $1
      ORDER BY run.started_at`,
    [ruleId]
  );
  assert.deepEqual(runRows.rows.map((row) => row.version), [1, 2]);
  assert.deepEqual(runRows.rows.map((row) => row.scriptSource), ["return 'one';", "return 'two';"]);
  assert.deepEqual(runRows.rows.map((row) => row.outputBody), ["one", "two"]);

  // A script reads its rule's own history back by key and sequence number.
  const { createAutomationContext } = await import("../src/lib/automation/context.js");
  const context = createAutomationContext({ requestedBy: null, automationRunId: null, deadlineAt: Date.now() + 10_000 });
  const listed = await context.call("listRuns", [{ rule: key, limit: 10 }]) as { runs: Array<{ sequence: number; scriptVersion: number; status: string }> };
  assert.deepEqual(listed.runs.map((run) => run.sequence), [2, 1]);
  assert.deepEqual(listed.runs.map((run) => run.scriptVersion), [2, 1]);

  const detail = await context.call("getRun", [key, 1]) as { run: { sequence: number; outputBody: string; scriptVersion: number; logs: unknown[] } };
  assert.equal(detail.run.sequence, 1);
  assert.equal(detail.run.scriptVersion, 1);
  assert.equal(detail.run.outputBody, "one");

  const last = await context.call("getLastRun", [key]) as { run: { sequence: number; scriptVersion: number; outputBody: string } | null };
  assert.equal(last.run?.sequence, 2);
  assert.equal(last.run?.outputBody, "two");

  await assert.rejects(() => context.call("getRun", [key, 99]), /has no run #99/);
  await assert.rejects(() => context.call("getRun", ["no-such-rule-key", 1]), /No automation rule matches/);
  await assert.rejects(() => context.call("getLastRun", ["no-such-rule-key"]), /No automation rule matches/);

  // A rule that has never finished a run has no last run, which is a null
  // rather than an error: the first run of a rule is an ordinary case.
  const fresh = await pool.query(
    `INSERT INTO automation_rules(key, name, cron, timezone, script_timeout_ms)
     VALUES ($1, $1, '0 0 * * *', 'UTC', 10000) RETURNING id`,
    [`${key}-fresh`]
  );
  const freshLast = await context.call("getLastRun", [`${key}-fresh`]) as { run: unknown };
  assert.equal(freshLast.run, null);
  await pool.query("DELETE FROM automation_rules WHERE id = $1", [fresh.rows[0].id]);

  // A run still in progress is not "the last run": a script reading its own
  // rule mid-run must see the run before itself.
  await pool.query(
    `INSERT INTO automation_runs(rule_id, sequence, trigger_source, status, trigger_payload)
     VALUES ($1, 99, 'manual', 'running', '{}'::jsonb)`,
    [ruleId]
  );
  const stillSecond = await context.call("getLastRun", [key]) as { run: { sequence: number } | null };
  assert.equal(stillSecond.run?.sequence, 2);
});

// The MCP tool is the only description an agent writing a rule ever sees, so
// it has to carry the same calls and types the editor gets.
test("the MCP script description spells out every call and type", async () => {
  const { AUTOMATION_CONTEXT_METHODS, AUTOMATION_OUTPUT_HELPERS, automationScriptToolDescription } =
    await import("../src/lib/automation/context.js");
  const description = automationScriptToolDescription();
  for (const member of [...AUTOMATION_CONTEXT_METHODS, ...AUTOMATION_OUTPUT_HELPERS]) {
    assert.ok(description.includes(member.declaration), `cfman.${member.name} is missing from the MCP description`);
    assert.ok(description.includes(member.description), `the description of cfman.${member.name} is missing`);
  }
  for (const type of ["interface CfmanTunnel", "interface CfmanRun", "interface CfmanRunDetail", "interface CfmanExecution", "interface CfmanChannel", "declare const trigger", "declare const rule"]) {
    assert.ok(description.includes(type), `${type} is missing from the MCP description`);
  }
});

test("the documented context calls match the ones the sandbox implements", async () => {
  const { AUTOMATION_CONTEXT_METHODS, AUTOMATION_OUTPUT_HELPERS, automationTypeDefinitions, createAutomationContext } =
    await import("../src/lib/automation/context.js");
  const implemented = createAutomationContext({ requestedBy: null, automationRunId: null, deadlineAt: Date.now() }).methodNames;
  assert.deepEqual(
    AUTOMATION_CONTEXT_METHODS.map((method) => method.name).sort(),
    [...implemented].sort(),
    "every documented cfman call must exist, and every implemented call must be documented"
  );
  // The declaration file the editor loads has to name all of them too.
  const definitions = automationTypeDefinitions();
  for (const member of [...AUTOMATION_CONTEXT_METHODS, ...AUTOMATION_OUTPUT_HELPERS]) {
    assert.ok(definitions.includes(member.declaration), `missing declaration for cfman.${member.name}`);
  }
  for (const global of ["declare const cfman", "declare const trigger", "declare const rule", "declare function sleep"]) {
    assert.ok(definitions.includes(global), `missing ${global}`);
  }
});
