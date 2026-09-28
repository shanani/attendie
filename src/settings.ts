import type { DayType, Minutes, RawDay } from "./types";

const h = (hours: number, minutes = 0): Minutes => hours * 60 + minutes;

/** Working times of one shift. Times are minutes since midnight; durations are minutes. */
export interface Shift {
  /** Flexible entry window; arriving after `entryTo` is lateness. */
  entryFrom: Minutes;
  entryTo: Minutes;
  /** Required work on a full day. Half days, and the minimum before a day is absent, are half of it. */
  hours: number;
  /** Make-up (extra minutes) counts until this time; nothing later counts. */
  makeupUntil: Minutes;
}

export interface Settings {
  /** Monthly allowance that covers lateness, and shortness/outside not made up. */
  monthlyAllowance: number;
  regular: Shift;
  ramadan: Shift;
  /**
   * The page's "Shift Type" names that mean the regular shift (either language).
   * Any other shift name means the Ramadan shift.
   */
  regularNames: string[];
  /** Days between these ISO dates (inclusive) are Ramadan whatever the shift name; empty to rely on the name only. */
  ramadanFrom: string;
  ramadanTo: string;
  /** Sign-in and sign-out closer together than this look like one punch recorded twice. */
  singlePunchWithin: number;
}

export const DEFAULT_SETTINGS: Settings = {
  monthlyAllowance: h(8),
  regular: { entryFrom: h(7), entryTo: h(9), hours: h(8), makeupUntil: h(18) },
  ramadan: { entryFrom: h(10), entryTo: h(12), hours: h(5), makeupUntil: h(18) },
  regularNames: ["Regular", "منتظم"],
  ramadanFrom: "",
  ramadanTo: "",
  singlePunchWithin: 5,
};

export type ShiftName = "regular" | "ramadan";

/** Compares shift names across spelling variants: case, spaces, Arabic alef forms, tatweel and diacritics. */
function normalizeName(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Day types whose shift name decides the shift. Weekends, vacations etc. never do. */
const WORKING_TYPES: DayType[] = ["regular", "halfDayLeave", "unknown"];

/**
 * The shift a day's own row shows, or undefined when it does not show one: an empty Shift Type
 * (half days) or a day that is not a working day (weekend, vacation, holiday, WFH, training).
 */
function shiftFromRow(day: RawDay, settings: Settings): ShiftName | undefined {
  const { ramadanFrom: from, ramadanTo: to } = settings;
  if (from && to && day.date >= from && day.date <= to) return "ramadan";
  if (!WORKING_TYPES.includes(day.dayType)) return undefined;
  const name = normalizeName(day.shiftName ?? "");
  if (!name) return undefined;
  return settings.regularNames.some((n) => normalizeName(n) === name) ? "regular" : "ramadan";
}

/**
 * Which shift each day is on. A "Regular" / "منتظم" shift name is the regular shift; any other name
 * (whatever HR calls it in Ramadan) is the Ramadan shift; days inside the Ramadan dates are Ramadan.
 * Only working days are judged by their name; the rest (half days without a name, weekends, leave)
 * take the shift of the nearest working day.
 */
export function resolveShifts(days: RawDay[], settings: Settings): ShiftName[] {
  const own = days.map((d) => shiftFromRow(d, settings));
  return own.map((shift, i) => {
    if (shift) return shift;
    for (let distance = 1; distance < days.length; distance++) {
      const nearest = own[i - distance] ?? own[i + distance];
      if (nearest) return nearest;
    }
    return "regular";
  });
}

/**
 * The windows a shift implies. Half days take half the hours:
 *  - evening leave (work in the morning): counts from entryFrom until entryTo + half;
 *  - morning leave (work in the afternoon): entry window and counting both start half later.
 * With the regular shift (7:00–9:00, 8h, make-up until 18:00) this gives 11:00–18:00 and 7:00–13:00.
 */
export function shiftWindows(shift: Shift) {
  const half = shift.hours / 2;
  const morningStart = shift.entryFrom + half;
  return {
    half,
    /** Below this much work a full day is absent. */
    minimumWorked: half,
    morningLeave: { start: morningStart, entryTo: shift.entryTo + half, end: shift.makeupUntil },
    eveningLeave: { start: shift.entryFrom, entryTo: shift.entryTo, end: shift.entryTo + half },
    /** A half day with no leave part given: arriving at or after this means morning leave. */
    detectMorningLeaveAt: Math.round((shift.entryTo + morningStart) / 2),
  };
}

/** Fills in anything missing from stored settings (e.g. after an update adds a new setting). */
export function withDefaults(stored: Partial<Settings> | undefined): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  // Copy only settings that still exist (1.0.5 stored a "ramadanNames" list that is no longer used).
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (stored?.[key] !== undefined) (settings as any)[key] = stored[key];
  }
  settings.regular = { ...DEFAULT_SETTINGS.regular, ...stored?.regular };
  settings.ramadan = { ...DEFAULT_SETTINGS.ramadan, ...stored?.ramadan };
  return settings;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get("settings");
  return withDefaults(stored.settings as Partial<Settings> | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}
