import assert from "node:assert/strict";
import { test } from "node:test";
import { Cron } from "croner";
import { describeCron } from "../src/lib/automation/cron.js";

// The schedule builder writes the expression a rule actually runs on, so what
// it produces has to be accepted by the same cron engine the scheduler uses
// and has to read back into the state it came from. The module lives in the
// web app because it is editor logic; it is exercised here because this is
// where the project runs tests.
const { buildCron, parseCron, DEFAULT_CRON_BUILDER } = await import(
  new URL("../../web/src/cron.ts", import.meta.url).href
) as typeof import("../../web/src/cron.js");

const cases = [
  { state: { frequency: "minutes" as const, everyMinutes: 5 }, cron: "*/5 * * * *", reads: "Every 5 minutes" },
  { state: { frequency: "hourly" as const, minute: 30 }, cron: "30 * * * *", reads: "At 30 minutes past the hour" },
  { state: { frequency: "daily" as const, hour: 8, minute: 0 }, cron: "0 8 * * *", reads: "At 08:00" },
  { state: { frequency: "weekly" as const, hour: 7, minute: 15, weekdays: [1, 3, 5] }, cron: "15 7 * * 1,3,5", reads: "At 07:15, only on Monday, Wednesday, and Friday" },
  { state: { frequency: "monthly" as const, hour: 23, minute: 45, dayOfMonth: 28 }, cron: "45 23 28 * *", reads: "At 23:45, on day 28 of the month" }
];

test("every schedule the builder produces is a valid cron expression that reads back the same way", () => {
  for (const entry of cases) {
    const state = { ...DEFAULT_CRON_BUILDER, ...entry.state };
    const cron = buildCron(state);
    assert.equal(cron, entry.cron);

    // The scheduler's own engine has to accept it and have a next run.
    const schedule = new Cron(cron, { timezone: "UTC", paused: true });
    assert.ok(schedule.nextRun(), `${cron} never runs`);
    schedule.stop();

    assert.equal(describeCron(cron), entry.reads);
    assert.deepEqual(parseCron(cron), state, `${cron} did not read back into the state that produced it`);
  }
});

test("the builder refuses expressions it cannot show rather than rewriting them", () => {
  // Everything here is valid cron that the builder has no control for; a null
  // keeps the editor on the expression field instead of silently replacing it.
  for (const expression of ["0 */2 * * *", "0 8 1 1 *", "*/30 9-17 * * 1-5", "0 0 8 * * *", "0 8 * * MON", "not a cron"]) {
    assert.equal(parseCron(expression), null, `${expression} should not map onto the builder`);
  }
});

test("a weekday range written by hand still opens in the builder", () => {
  assert.deepEqual(parseCron("0 8 * * 1-5"), { ...DEFAULT_CRON_BUILDER, frequency: "weekly", minute: 0, hour: 8, weekdays: [1, 2, 3, 4, 5] });
  // Sunday is both 0 and 7 in cron; the builder settles on 0.
  assert.deepEqual(parseCron("0 8 * * 7"), { ...DEFAULT_CRON_BUILDER, frequency: "weekly", minute: 0, hour: 8, weekdays: [0] });
});
