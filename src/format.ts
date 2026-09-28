import type { DayResult } from "./calculator";
import { STRINGS } from "./i18n";
import type { Lang, Minutes } from "./types";

/** Duration: 125 → "2:05", -5 → "-0:05". */
export function hm(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/** Time of day: 570 → "09:30"; null → "–". */
export function clock(minutes: Minutes | null): string {
  return minutes === null ? "–" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "11:00–18:00", kept left-to-right inside Arabic text. */
export function timeRange(start: Minutes, end: Minutes): string {
  return `\u2066${clock(start)}–${clock(end)}\u2069`;
}

/** "morning leave, counts 11:00–18:00", or "" for a full day. */
export function halfDayNote(d: DayResult, lang: Lang): string {
  if (!d.halfDay || !d.window) return "";
  return STRINGS[lang].halfDayPart[d.halfDay].replace("{0}", timeRange(d.window.start, d.window.end));
}
