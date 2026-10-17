import { Cron } from "croner";
import cronstrue from "cronstrue";
import { z } from "zod";

export const serverTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function assertTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    throw new Error(`"${timezone}" is not a valid IANA time zone`);
  }
}

// A cron rule is stored with the time zone it was written in, never the
// server's: "every day at 08:00" has to keep meaning 08:00 where the operator
// is, including across that zone's own DST transitions.
export const scheduleSchema = z.object({
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(80).default(serverTimezone)
}).superRefine((value, context) => {
  try {
    assertTimezone(value.timezone);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["timezone"], message: error instanceof Error ? error.message : "Invalid time zone" });
    return;
  }
  try {
    const cron = new Cron(value.cron, { timezone: value.timezone, paused: true });
    if (!cron.nextRun()) {
      context.addIssue({ code: "custom", path: ["cron"], message: "This expression never runs again" });
    }
    cron.stop();
  } catch (error) {
    context.addIssue({ code: "custom", path: ["cron"], message: error instanceof Error ? error.message : "Invalid cron expression" });
  }
});

export type RuleSchedule = z.infer<typeof scheduleSchema>;

// A plain-language reading of the expression, shown beside the next runs so an
// operator can check the schedule says what they meant. Like croner, cronstrue
// reads a six-field expression as seconds-first, so both agree on what the
// extra field is.
export function describeCron(cron: string): string | null {
  try {
    return cronstrue.toString(cron, {
      use24HourTimeFormat: true,
      verbose: false,
      throwExceptionOnParseError: true
    });
  } catch {
    return null;
  }
}

export function nextRunAt(schedule: RuleSchedule, from: Date = new Date()): Date | null {
  const cron = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
  const next = cron.nextRun(from);
  cron.stop();
  return next;
}

export function nextRuns(schedule: RuleSchedule, count: number, from: Date = new Date()): string[] {
  const cron = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
  const runs = cron.nextRuns(count, from).map((date) => date.toISOString());
  cron.stop();
  return runs;
}
