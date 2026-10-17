// The builder covers the schedules an operator writes by hand nine times out
// of ten; anything beyond them (step hours, ranges of days, seconds) stays in
// the expression field, which is what the server validates either way.
export type CronFrequency = "minutes" | "hourly" | "daily" | "weekly" | "monthly";

export type CronBuilderState = {
  frequency: CronFrequency;
  everyMinutes: number;
  minute: number;
  hour: number;
  weekdays: number[];
  dayOfMonth: number;
};

export const DEFAULT_CRON_BUILDER: CronBuilderState = {
  frequency: "minutes",
  everyMinutes: 15,
  minute: 0,
  hour: 8,
  weekdays: [1],
  dayOfMonth: 1
};

export const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" }
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function buildCron(state: CronBuilderState): string {
  const minute = Math.min(59, Math.max(0, Math.trunc(state.minute)));
  const hour = Math.min(23, Math.max(0, Math.trunc(state.hour)));
  switch (state.frequency) {
    case "minutes":
      return `*/${Math.min(59, Math.max(1, Math.trunc(state.everyMinutes)))} * * * *`;
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly": {
      // Sunday is 0 in cron; the chips read Monday first, so the values are
      // sorted back into cron order before they are written.
      const days = [...new Set(state.weekdays)].sort((left, right) => left - right);
      return `${minute} ${hour} * * ${(days.length ? days : [1]).join(",")}`;
    }
    case "monthly":
      return `${minute} ${hour} ${Math.min(31, Math.max(1, Math.trunc(state.dayOfMonth)))} * *`;
  }
}

function expandWeekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^([0-7])-([0-7])$/.exec(part);
    if (range) {
      const [, fromField = "", toField = ""] = range;
      const from = Number(fromField) % 7;
      const to = Number(toField) % 7;
      if (from > to) return null;
      for (let day = from; day <= to; day += 1) days.add(day);
      continue;
    }
    if (/^[0-7]$/.test(part)) {
      days.add(Number(part) % 7);
      continue;
    }
    return null;
  }
  return days.size ? [...days].sort((left, right) => left - right) : null;
}

// The builder state an expression corresponds to, or null when the expression
// says something the builder cannot show. That null is what keeps the builder
// from quietly rewriting a schedule it does not understand.
export function parseCron(expression: string): CronBuilderState | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  // The length check above is what makes these five defined; the defaults are
  // only here so the compiler can see it too.
  const [minuteField = "", hourField = "", dayOfMonthField = "", monthField = "", weekdayField = ""] = fields;
  if (monthField !== "*") return null;

  const everyMinutes = /^\*\/([1-9]\d?)$/.exec(minuteField);
  if (everyMinutes && hourField === "*" && dayOfMonthField === "*" && weekdayField === "*") {
    return { ...DEFAULT_CRON_BUILDER, frequency: "minutes", everyMinutes: Number(everyMinutes[1] ?? "15") };
  }

  if (!/^[0-5]?\d$/.test(minuteField)) return null;
  const minute = Number(minuteField);

  if (hourField === "*" && dayOfMonthField === "*" && weekdayField === "*") {
    return { ...DEFAULT_CRON_BUILDER, frequency: "hourly", minute };
  }

  if (!/^([01]?\d|2[0-3])$/.test(hourField)) return null;
  const hour = Number(hourField);

  if (dayOfMonthField === "*" && weekdayField === "*") {
    return { ...DEFAULT_CRON_BUILDER, frequency: "daily", minute, hour };
  }

  if (dayOfMonthField === "*") {
    const weekdays = expandWeekdays(weekdayField);
    return weekdays ? { ...DEFAULT_CRON_BUILDER, frequency: "weekly", minute, hour, weekdays } : null;
  }

  if (weekdayField === "*" && /^([1-9]|[12]\d|3[01])$/.test(dayOfMonthField)) {
    return { ...DEFAULT_CRON_BUILDER, frequency: "monthly", minute, hour, dayOfMonth: Number(dayOfMonthField) };
  }

  return null;
}

export function timeValue(state: Pick<CronBuilderState, "hour" | "minute">): string {
  return `${pad(state.hour)}:${pad(state.minute)}`;
}

export function parseTimeValue(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const [, hourField = "", minuteField = ""] = match;
  return { hour: Number(hourField), minute: Number(minuteField) };
}
