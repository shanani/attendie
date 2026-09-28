import { dayRowDate, dayRows, parseAttendancePage, readPunches } from "./parser";
import type { DayType, ParseResult } from "./types";

/** Day types whose sign-in/out matters; for these, missing times are looked up in the punch list. */
const NEEDS_TIMES: DayType[] = ["regular", "halfDayLeave", "unknown"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the page, first loading the punch lists it needs.
 *
 * The page fills a day's "Time in | Time out" punch list only when its row is expanded, and
 * half-day leave days show their times nowhere else. So for each past working or half day
 * without times, expand the row, wait for the punches, read them, and collapse the row again.
 * Nothing on the page is changed.
 *
 * @param today ISO date; today and later are not counted, so their rows are left alone.
 */
export async function collectAttendance(doc: Document, today: string, timeoutMs = 3000): Promise<ParseResult> {
  const result = parseAttendancePage(doc);
  const punches = new Map<string, ReturnType<typeof readPunches>>();

  for (const row of dayRows(doc)) {
    const date = dayRowDate(row);
    const day = result.days.find((d) => d.date === date);
    if (!date || !day || date >= today || day.clockIn !== null || day.clockOut !== null) continue;
    if (!NEEDS_TIMES.includes(day.dayType)) continue;

    const wasExpanded = row.getAttribute("aria-expanded") === "true";
    if (!wasExpanded) row.click();
    let found = readPunches(row);
    for (let waited = 0; found.clockIn === null && found.clockOut === null && waited < timeoutMs; waited += 100) {
      await sleep(100);
      found = readPunches(row);
    }
    if (!wasExpanded && row.getAttribute("aria-expanded") === "true") row.click();
    punches.set(date, found);
  }

  for (const day of result.days) {
    const found = punches.get(day.date);
    if (!found || (found.clockIn === null && found.clockOut === null)) continue;
    day.clockIn = found.clockIn;
    day.clockOut = found.clockOut;
    if (day.dayType === "unknown") day.dayType = "regular";
  }
  return result;
}
