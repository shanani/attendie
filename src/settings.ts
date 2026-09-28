import type { Minutes, RawDay } from "./types";

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
  /** A day is on the Ramadan shift when the page's "Shift Type" contains one of these. */
  ramadanNames: string[];
  /** ...or when it falls between these ISO dates (inclusive); empty to rely on the shift name only. */
  ramadanFrom: string;
  ramadanTo: string;
  /** Sign-in and sign-out closer together than this look like one punch recorded twice. */
  singlePunchWithin: number;
}

export const DEFAULT_SETTINGS: Settings = {
  monthlyAllowance: h(8),
  regular: { entryFrom: h(7), entryTo: h(9), hours: h(8), makeupUntil: h(18) },
  ramadan: { entryFrom: h(10), entryTo: h(12), hours: h(5), makeupUntil: h(18) },
  ramadanNames: ["Ramadan", "رمضان"],
  ramadanFrom: "",
  ramadanTo: "",
  singlePunchWithin: 5,
};

export type ShiftName = "regular" | "ramadan";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Which shift a day is on: Ramadan by the page's shift name, or by the Ramadan dates. */
export function shiftOf(day: RawDay, settings: Settings): ShiftName {
  const name = normalize(day.shiftName ?? "");
  if (name && settings.ramadanNames.some((n) => n.trim() && name.includes(normalize(n)))) return "ramadan";
  const { ramadanFrom: from, ramadanTo: to } = settings;
  if (from && to && day.date >= from && day.date <= to) return "ramadan";
  return "regular";
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
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    regular: { ...DEFAULT_SETTINGS.regular, ...stored?.regular },
    ramadan: { ...DEFAULT_SETTINGS.ramadan, ...stored?.ramadan },
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get("settings");
  return withDefaults(stored.settings as Partial<Settings> | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}
