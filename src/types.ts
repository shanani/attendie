/** Minutes since midnight, e.g. 9:30 AM = 570. */
export type Minutes = number;

export type Lang = "en" | "ar";

export type DayType =
  | "regular"
  | "weekend"
  | "holiday"
  | "wfh"
  | "annualVacation"
  | "training"
  | "halfDayLeave"
  /** Set by the user to leave a day out of the calculation (e.g. sick leave). */
  | "excluded"
  | "unknown";

/** Day types the user chose per date, overriding what the page shows. */
export type Overrides = Record<string, DayType>;

/** One day exactly as read from the HR attendance page. */
export interface RawDay {
  /** ISO date, yyyy-mm-dd. */
  date: string;
  dayType: DayType;
  clockIn: Minutes | null;
  clockOut: Minutes | null;
  /** "Out of STC" minutes from the day's detail table, if listed. */
  outsideMinutes: number | null;
  /** The page's "Total Hours" column, in minutes. */
  netMinutes: number | null;
}

export interface ParseResult {
  lang: Lang;
  days: RawDay[];
}
