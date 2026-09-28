import { dayRowDate, dayRows, parseAttendancePage, readPunches } from "./parser";
import type { ParseResult } from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the page, first loading the punch lists of half-day leave days.
 *
 * Normal days show their times in the main row. Half-day leave days show them only in the
 * "Time in | Time out" punch list, which the page fills when the row is expanded. So each past
 * half day without times is expanded, its punches read, and the row collapsed again.
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
    if (day.dayType !== "halfDayLeave") continue;

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
  }
  return result;
}
