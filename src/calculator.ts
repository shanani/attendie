import type { DayType, Minutes, Overrides, RawDay } from "./types";

const h = (hours: number, minutes = 0): Minutes => hours * 60 + minutes;

/** Company attendance policy. All values are minutes (times are minutes since midnight). */
export interface Rules {
  /** Monthly allowance that can cover lateness, shortness and time outside. */
  monthlyAllowance: number;
  /** Required work on a normal day. */
  dailyRequired: number;
  /** Required work on a half-day-leave day. */
  halfDayRequired: number;
  /** Below this much work the day is absent (no makeup), unless it is a half-day leave. */
  minimumWorked: number;
  /** Flexible entry window; arriving after its end is lateness. */
  entryFrom: Minutes;
  entryTo: Minutes;
  /** Entry window when the half-day leave is taken in the morning. */
  halfDayAfternoonEntryFrom: Minutes;
  halfDayAfternoonEntryTo: Minutes;
  /** Nothing after this time counts (extra minutes stop here). */
  dayEnd: Minutes;
}

export const DEFAULT_RULES: Rules = {
  monthlyAllowance: h(8),
  dailyRequired: h(8),
  halfDayRequired: h(4),
  minimumWorked: h(4),
  entryFrom: h(7),
  entryTo: h(9),
  halfDayAfternoonEntryFrom: h(11),
  halfDayAfternoonEntryTo: h(13),
  dayEnd: h(18),
};

/** Day types that are left out of the calculation entirely. */
const EXCLUDED_TYPES: DayType[] = ["weekend", "holiday", "wfh", "annualVacation", "training", "excluded"];

export type DayStatus =
  /** Counted in the monthly totals. */
  | "ok"
  /** Worked less than the minimum; not counted, flagged as absent. */
  | "absent"
  /** Working day with a missing sign-in or sign-out; not counted, flagged. */
  | "missingPunch"
  /** Weekend, holiday, WFH, vacation or training. */
  | "excluded"
  /** Today or later; sign-out is not final yet. */
  | "notCounted";

export interface DayResult {
  day: RawDay;
  /** Day type as shown on the HR page, before any user override. */
  pageType: DayType;
  status: DayStatus;
  halfDay?: "morningWork" | "afternoonWork";
  /** Minutes actually worked inside the allowed window, minus time outside. */
  worked: number;
  lateness: number;
  shortness: number;
  outside: number;
  extra: number;
}

export interface Summary {
  /** yyyy-mm of the report. */
  month: string;
  days: DayResult[];
  totals: { lateness: number; shortness: number; outside: number; extra: number };
  /** Extra minutes spent covering shortness and time outside. */
  extraUsed: number;
  /** Extra minutes left over (they do not carry to next month). */
  extraLeft: number;
  /** Minutes charged against the monthly allowance. */
  charged: number;
  /** Allowance left; negative means over the allowance. */
  remaining: number;
}

function evaluateDay(pageDay: RawDay, today: string, rules: Rules, overrides: Overrides): DayResult {
  const day = { ...pageDay, dayType: overrides[pageDay.date] ?? pageDay.dayType };
  const result: DayResult = { day, pageType: pageDay.dayType, status: "ok", worked: 0, lateness: 0, shortness: 0, outside: 0, extra: 0 };

  if (EXCLUDED_TYPES.includes(day.dayType) || (day.dayType === "unknown" && day.clockIn === null)) {
    result.status = "excluded";
    return result;
  }
  if (day.date >= today) {
    result.status = "notCounted";
    return result;
  }
  const { clockIn, clockOut } = day;
  if (clockIn === null || clockOut === null || clockOut <= clockIn) {
    result.status = clockIn === null && clockOut === null ? "absent" : "missingPunch";
    return result;
  }

  const isHalfDay = day.dayType === "halfDayLeave";
  let entryFrom = rules.entryFrom;
  let entryTo = rules.entryTo;
  let required = rules.dailyRequired;
  if (isHalfDay) {
    required = rules.halfDayRequired;
    // Arriving after the normal entry window means the leave was taken in the morning.
    const afternoon = clockIn > rules.entryTo + 60;
    result.halfDay = afternoon ? "afternoonWork" : "morningWork";
    if (afternoon) {
      entryFrom = rules.halfDayAfternoonEntryFrom;
      entryTo = rules.halfDayAfternoonEntryTo;
    }
  }

  const outside =
    day.outsideMinutes ??
    (day.netMinutes !== null ? Math.max(0, clockOut - clockIn - day.netMinutes) : 0);

  const effectiveIn = Math.max(clockIn, entryFrom);
  const effectiveOut = Math.min(clockOut, rules.dayEnd);
  // A late arrival still has to stay until the end of the latest shift.
  const expectedOut = Math.min(effectiveIn, entryTo) + required;

  result.outside = outside;
  result.worked = Math.max(0, effectiveOut - effectiveIn - outside);

  if (!isHalfDay && result.worked < rules.minimumWorked) {
    result.status = "absent";
    return result;
  }

  result.lateness = Math.max(0, clockIn - entryTo);
  result.shortness = Math.max(0, expectedOut - clockOut);
  result.extra = Math.max(0, effectiveOut - expectedOut);
  return result;
}

/**
 * Applies the monthly rules:
 *  - lateness can only be covered by the monthly allowance;
 *  - shortness and time outside are covered by extra minutes first, then the allowance;
 *  - extra minutes only live within the month.
 *
 * @param today ISO date (yyyy-mm-dd); this day and later are not counted.
 * @param overrides Day types chosen by the user, keyed by ISO date.
 */
export function calculate(
  days: RawDay[],
  today: string,
  overrides: Overrides = {},
  rules: Rules = DEFAULT_RULES,
): Summary {
  const results = days.map((d) => evaluateDay(d, today, rules, overrides));
  const counted = results.filter((r) => r.status === "ok");
  const sum = (key: "lateness" | "shortness" | "outside" | "extra") =>
    counted.reduce((acc, r) => acc + r[key], 0);

  const totals = { lateness: sum("lateness"), shortness: sum("shortness"), outside: sum("outside"), extra: sum("extra") };
  const coverable = totals.shortness + totals.outside;
  const extraUsed = Math.min(totals.extra, coverable);
  const charged = totals.lateness + (coverable - extraUsed);

  return {
    month: days[0]?.date.slice(0, 7) ?? "",
    days: results,
    totals,
    extraUsed,
    extraLeft: totals.extra - extraUsed,
    charged,
    remaining: rules.monthlyAllowance - charged,
  };
}
