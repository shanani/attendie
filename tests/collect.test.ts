import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { calculate } from "../src/calculator";
import { collectAttendance } from "../src/collect";
import { dayRowDate, dayRows } from "../src/parser";

/**
 * The August sample with the page's behaviour mimicked: a day's punch list is filled only
 * after its row is clicked open (18 and 20 Aug use the times the real page showed).
 */
function augustPage(loadDelayMs = 20) {
  const html = readFileSync(new URL("./fixtures/attendance-en-halfday.html", import.meta.url), "utf8");
  const { window } = new JSDOM(html);
  const doc = window.document;
  const punchesByDate: Record<string, string> = {
    "2026-08-18": "<tr><td>12:41 PM</td><td>6:00 PM</td></tr>",
    "2026-08-20": "<tr><td>1:11 PM</td><td>6:00 PM</td></tr>",
  };
  const clicked: string[] = [];
  for (const row of dayRows(doc)) {
    const date = dayRowDate(row)!;
    row.addEventListener("click", () => {
      clicked.push(date);
      const open = row.getAttribute("aria-expanded") !== "true";
      row.setAttribute("aria-expanded", String(open));
      if (!open || !punchesByDate[date]) return;
      setTimeout(() => {
        const punchTable = row.nextElementSibling!.querySelectorAll("table.detail-table")[1];
        punchTable.querySelector("td[colspan]")!.parentElement!.outerHTML = punchesByDate[date];
      }, loadDelayMs);
    });
  }
  return { doc, clicked };
}

describe("collectAttendance", () => {
  it("opens days without times, reads their punches, and closes them again", async () => {
    const { doc, clicked } = augustPage();
    const result = await collectAttendance(doc, "2026-09-28", 300);

    // Only the three half days lack times among past working/half days; each is opened and closed.
    expect(clicked).toEqual(["2026-08-18", "2026-08-18", "2026-08-20", "2026-08-20", "2026-08-26", "2026-08-26"]);
    expect(dayRows(doc).every((r) => r.getAttribute("aria-expanded") !== "true")).toBe(true);

    const day = (d: string) => result.days.find((x) => x.date === d)!;
    expect(day("2026-08-18")).toMatchObject({ dayType: "halfDayLeave", clockIn: 12 * 60 + 41, clockOut: 18 * 60 });
    expect(day("2026-08-20")).toMatchObject({ dayType: "halfDayLeave", clockIn: 13 * 60 + 11, clockOut: 18 * 60 });
    expect(day("2026-08-26")).toMatchObject({ clockIn: null, clockOut: null });

    // Matches HR: 20 Aug is 11 min late (morning leave, entry after 13:00), 18 Aug is on time.
    const s = calculate(result.days, "2026-09-28");
    const res = (d: string) => s.days.find((x) => x.day.date === d)!;
    expect(res("2026-08-18")).toMatchObject({ status: "ok", halfDay: "morningLeave", lateness: 0, extra: 79 });
    expect(res("2026-08-20")).toMatchObject({ status: "ok", halfDay: "morningLeave", lateness: 11, extra: 60 });
    expect(res("2026-08-26")).toMatchObject({ status: "absent", absentReason: "noSignInOut" });
  });

  it("leaves today and later days alone", async () => {
    const { doc, clicked } = augustPage();
    await collectAttendance(doc, "2026-08-19", 300);
    expect(clicked).toEqual(["2026-08-18", "2026-08-18"]);
  });
});
