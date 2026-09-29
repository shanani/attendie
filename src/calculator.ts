import { DEFAULT_SETTINGS, resolveShifts, type Settings, type ShiftName, shiftWindows } from "./settings";
import type { DayType, Minutes, Overrides, RawDay } from "./types";

export { DEFAULT_SETTINGS } from "./settings";
const HALF_DAY_TYPES: DayType[] = ["halfDayLeave", "halfDayMorning", "halfDayEvening"];

/** Day types that are left out of the calculation entirely. */
const EXCLUDED_TYPES: DayType[] = ["weekend", "holiday", "wfh", "annualVacation", "training", "excluded"];

export type DayStatus =
  /** Counted in the monthly totals. */
  | "ok"
  /** Worked under the minimum, or a missing sign-in/sign-out; not counted. See `absentReason`. */
  | "absent"
  /** Weekend, holiday, WFH, vacation or training; or excluded by the user (today is by default). */
  | "excluded"
  /** A later day; nothing to count yet. */
  | "notCounted";

/** Why a day's sign-in/out looks wrong and should be checked against the security gate report. */
export type PunchProblem =
  /** Signed out but no sign-in. */
  | "missingSignIn"
  /** Signed in but no sign-out. */
  | "missingSignOut"
  /** Sign-in and sign-out a few minutes apart, i.e. one punch. */
  | "singlePunch"
  /** The day's punch list has a sign-in without a sign-out (or the reverse). */
  | "unpairedPunch";

export type AbsentReason =
  /** Neither sign-in nor sign-out. */
  | "noSignInOut"
  /** Signed in but no sign-out (or only one punch). */
  | "noSignOut"
  /** Signed out but no sign-in. */
  | "noSignIn"
  /** Worked less than the minimum on a full working day. */
  | "underMinimum";

export interface DayResult {
  day: RawDay;
  /** Day type as shown on the HR page, before any user override. */
  pageType: DayType;
  status: DayStatus;
  absentReason?: AbsentReason;
  /** Set when the sign-in/out looks wrong; the day should be checked with the security gate report. */
  punchProblem?: PunchProblem;
  /** Today, excluded by default because it is not over yet; the user can change its type to count it. */
  todayDefault?: boolean;
  /** Which part of a half day was the leave (chosen by the user, or detected from the arrival time). */
  halfDay?: "morningLeave" | "eveningLeave";
  /** The shift the day was worked on. */
  shift: ShiftName;
  /** The part of the day that counts (half days leave out the vacation part). */
  window?: { start: Minutes; end: Minutes };
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
  /** The monthly allowance the balance starts from. */
  allowance: number;
  /**
   * The real balance left for anything: allowance − lateness (lateness has priority), then plus
   * leftover make-up or minus shortness/outside it did not cover. Leftover make-up never offsets
   * lateness beyond the allowance. Negative means over.
   */
  remaining: number;
  /** Number of absent days (not counted in the totals). */
  absentDays: number;
  /**
   * Minutes that need a justification: how far the charged minutes go past the allowance.
   * With lateness over the allowance this is (lateness − allowance) + shortness/outside not made up;
   * leftover make-up never reduces it, because make-up cannot cover lateness.
   */
  justification: { total: number; latenessOver: number; notMadeUp: number };
  /** Number of days whose sign-in/out should be checked with the security gate report. */
  problemDays: number;
}

/** Past normal or half day whose punches look wrong, or undefined when they look fine. */
function findPunchProblem(day: RawDay, settings: Settings): PunchProblem | undefined {
  const { clockIn, clockOut } = day;
  if (clockIn === null && clockOut !== null) return "missingSignIn";
  if (clockIn !== null && clockOut === null) return "missingSignOut";
  if (clockIn !== null && clockOut !== null && clockOut - clockIn < settings.singlePunchWithin) return "singlePunch";
  if (day.unpairedPunch) return "unpairedPunch";
  return undefined;
}

function evaluateDay(pageDay: RawDay, shiftName: ShiftName, today: string, settings: Settings, overrides: Overrides): DayResult {
  // Today is not over (the sign-out may be missing), so it is excluded unless the user chose a type.
  const todayDefault = pageDay.date === today && !(pageDay.date in overrides);
  const day = { ...pageDay, dayType: todayDefault ? "excluded" : (overrides[pageDay.date] ?? pageDay.dayType) };
  const shift = settings[shiftName];
  const windows = shiftWindows(shift);
  const result: DayResult = {
    day,
    pageType: pageDay.dayType,
    shift: shiftName,
    status: "ok",
    worked: 0,
    lateness: 0,
    shortness: 0,
    outside: 0,
    extra: 0,
  };
  if (todayDefault) result.todayDefault = true;

  if (EXCLUDED_TYPES.includes(day.dayType) || (day.dayType === "unknown" && day.clockIn === null)) {
    result.status = "excluded";
    return result;
  }
  if (day.date > today) {
    result.status = "notCounted";
    return result;
  }
  // Only normal and half days get here. Today still has time to sign out, so it is never flagged.
  if (day.date < today) result.punchProblem = findPunchProblem(day, settings);

  const { clockIn, clockOut } = day;
  // Any missing sign-in or sign-out makes the day absent.
  if (clockIn === null || clockOut === null || clockOut <= clockIn) {
    result.status = "absent";
    result.absentReason = clockIn === null ? (clockOut === null ? "noSignInOut" : "noSignIn") : "noSignOut";
    return result;
  }

  const isHalfDay = HALF_DAY_TYPES.includes(day.dayType);
  // Normal day: work counts from the earliest entry until make-up ends (regular: 7:00–18:00).
  // Half days leave out the vacation part (regular: morning leave 11:00–18:00, evening leave 7:00–13:00).
  let dayStart = shift.entryFrom;
  let dayEnd = shift.makeupUntil;
  let entryTo = shift.entryTo;
  let required = shift.hours;
  if (isHalfDay) {
    required = windows.half;
    const morningLeave =
      day.dayType === "halfDayMorning" || (day.dayType === "halfDayLeave" && clockIn >= windows.detectMorningLeaveAt);
    result.halfDay = morningLeave ? "morningLeave" : "eveningLeave";
    ({ start: dayStart, entryTo, end: dayEnd } = morningLeave ? windows.morningLeave : windows.eveningLeave);
  }
  result.window = { start: dayStart, end: dayEnd };

  const outside =
    day.reported?.outside ??
    (day.netMinutes !== null ? Math.max(0, clockOut - clockIn - day.netMinutes) : 0);

  const effectiveIn = Math.max(clockIn, dayStart);
  const effectiveOut = Math.min(clockOut, dayEnd);
  // A late arrival still has to stay until the end of the latest shift.
  const expectedOut = Math.min(effectiveIn, entryTo) + required;

  result.outside = outside;
  result.worked = Math.max(0, effectiveOut - effectiveIn - outside);

  if (!isHalfDay && result.worked < windows.minimumWorked) {
    result.status = "absent";
    result.absentReason = "underMinimum";
    return result;
  }

  // Prefer HR's own per-day minutes when the page lists them: HR counts seconds (the page shows
  // only minutes) and applies a grace period, so its numbers are exact. They were worked out for
  // the page's day type, so a day the user re-typed is calculated instead.
  const hr = day.dayType === pageDay.dayType ? day.reported : null;
  result.lateness = hr?.lateness ?? Math.max(0, clockIn - entryTo);
  result.shortness = hr?.shortness ?? Math.max(0, expectedOut - clockOut);
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
  settings: Settings = DEFAULT_SETTINGS,
): Summary {
  const shifts = resolveShifts(days, settings);
  const results = days.map((d, i) => evaluateDay(d, shifts[i], today, settings, overrides));
  const counted = results.filter((r) => r.status === "ok");
  const sum = (key: "lateness" | "shortness" | "outside" | "extra") =>
    counted.reduce((acc, r) => acc + r[key], 0);

  const totals = { lateness: sum("lateness"), shortness: sum("shortness"), outside: sum("outside"), extra: sum("extra") };
  const coverable = totals.shortness + totals.outside;
  const extraUsed = Math.min(totals.extra, coverable);
  const charged = totals.lateness + (coverable - extraUsed);
  const latenessOver = Math.max(0, totals.lateness - settings.monthlyAllowance);
  const notMadeUp = coverable - extraUsed;
  const afterLateness = settings.monthlyAllowance - totals.lateness;
  const makeupBalance = totals.extra - coverable;
  // Lateness is paid from the allowance first. Leftover make-up then adds to what is left, but cannot
  // fill a gap left by lateness over the allowance; shortness/outside it did not cover comes off it.
  const remaining = makeupBalance < 0 ? afterLateness + makeupBalance : afterLateness >= 0 ? afterLateness + makeupBalance : afterLateness;

  return {
    month: days[0]?.date.slice(0, 7) ?? "",
    days: results,
    totals,
    extraUsed,
    extraLeft: totals.extra - extraUsed,
    charged,
    allowance: settings.monthlyAllowance,
    remaining,
    absentDays: results.filter((r) => r.status === "absent").length,
    justification: { total: Math.max(0, -remaining), latenessOver, notMadeUp },
    problemDays: results.filter((r) => r.punchProblem).length,
  };
}
