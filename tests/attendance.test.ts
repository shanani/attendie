import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { calculate } from "../src/calculator";
import { parseAttendancePage, parseClock, parseDate } from "../src/parser";
import type { RawDay } from "../src/types";

const load = (file: string) =>
  parseAttendancePage(new JSDOM(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")).window.document);

const regular = (date: string, clockIn: string, clockOut: string, extra: Partial<RawDay> = {}): RawDay => ({
  date,
  dayType: "regular",
  clockIn: parseClock(clockIn),
  clockOut: parseClock(clockOut),
  // No HR detail table, so the calculator works lateness and shortness out from the times.
  reported: null,
  netMinutes: null,
  ...extra,
});

describe("parser", () => {
  it("parses clock times and dates in both languages", () => {
    expect(parseClock("9:34 AM")).toBe(574);
    expect(parseClock("12:05 PM")).toBe(725);
    expect(parseClock("6:01 PM")).toBe(1081);
    expect(parseClock("٦:٠١ م")).toBe(1081);
    expect(parseDate("01 September 2026")).toBe("2026-09-01");
    expect(parseDate("01 سبتمبر 2026")).toBe("2026-09-01");
    expect(parseDate("5 أكتوبر 2026")).toBe("2026-10-05");
  });

  it("reads the English and Arabic pages identically", () => {
    const en = load("attendance-en.html");
    const ar = load("attendance-ar.html");
    expect(en.lang).toBe("en");
    expect(ar.lang).toBe("ar");
    expect(en.days).toHaveLength(28);
    // The Arabic copy was saved with weekend punches on 4 Sep; every other day is identical.
    const withoutPunches = (days: RawDay[]) =>
      days.map((d) => (d.date === "2026-09-04" ? { ...d, clockIn: null, clockOut: null } : d));
    expect(withoutPunches(ar.days)).toEqual(en.days);
  });

  it("reads day types, times and time outside", () => {
    const { days } = load("attendance-en.html");
    const byDate = (d: string) => days.find((x) => x.date === d)!;
    expect(byDate("2026-09-02")).toEqual({
      date: "2026-09-02",
      dayType: "regular",
      clockIn: 7 * 60 + 32,
      clockOut: 17 * 60 + 22,
      reported: { lateness: 0, shortness: 0, outside: 101 },
      netMinutes: 8 * 60 + 9,
    });
    expect(byDate("2026-09-04").dayType).toBe("weekend");
    expect(byDate("2026-09-07").dayType).toBe("wfh");
    expect(byDate("2026-09-23").dayType).toBe("holiday");
    expect(byDate("2026-09-20").reported).toEqual({ lateness: 20, shortness: 0, outside: 148 });
  });
});

describe("calculator", () => {
  it("summarizes the September sample, excluding today", () => {
    const { days } = load("attendance-en.html");
    const s = calculate(days, "2026-09-28");

    expect(s.month).toBe("2026-09");
    const status = (d: string) => s.days.find((x) => x.day.date === d)!.status;
    expect(status("2026-09-10")).toBe("absent"); // 3:55 worked
    expect(status("2026-09-22")).toBe("ok"); // 4:20 worked
    expect(status("2026-09-28")).toBe("excluded"); // today, excluded by default
    expect(status("2026-09-07")).toBe("excluded");

    // Lateness and shortness are HR's own per-day minutes (the page lists 3 Sep shortness as 31, not 32).
    expect(s.totals).toEqual({ lateness: 385, shortness: 194, outside: 397, extra: 494 });
    expect(s.extraUsed).toBe(494);
    expect(s.charged).toBe(482);
    expect(s.remaining).toBe(-2);
  });

  it("does not let extra minutes cover lateness", () => {
    // Late 30 min, stays until 6 PM: 60 extra minutes, but lateness still charged.
    const s = calculate([regular("2026-09-01", "9:30 AM", "6:00 PM")], "2026-09-30");
    expect(s.days[0]).toMatchObject({ lateness: 30, shortness: 0, extra: 60 });
    expect(s.charged).toBe(30);
    expect(s.extraLeft).toBe(60);
  });

  it("uses extra minutes from one day to cover shortness on another", () => {
    const s = calculate(
      [regular("2026-09-01", "7:00 AM", "4:00 PM"), regular("2026-09-02", "8:00 AM", "3:40 PM")],
      "2026-09-30",
    );
    expect(s.totals).toMatchObject({ extra: 60, shortness: 20 });
    expect(s.charged).toBe(0);
    expect(s.remaining).toBe(480);
  });

  it("ignores time before 7 AM and after 6 PM", () => {
    const s = calculate([regular("2026-09-01", "6:30 AM", "7:00 PM")], "2026-09-30");
    expect(s.days[0]).toMatchObject({ worked: 11 * 60, lateness: 0, extra: 3 * 60 });
  });

  it("detects the leave part of a half day from the arrival time", () => {
    const half = (clockIn: string, clockOut: string, dayType: RawDay["dayType"] = "halfDayLeave") =>
      calculate([regular("2026-09-01", clockIn, clockOut, { dayType })], "2026-09-30").days[0];

    // Arrives before 10:00 → evening leave: 4h from entry, nothing counts after 13:00.
    expect(half("8:00 AM", "11:50 AM")).toMatchObject({ status: "ok", halfDay: "eveningLeave", shortness: 10, extra: 0 });
    expect(half("7:00 AM", "6:30 PM")).toMatchObject({ halfDay: "eveningLeave", worked: 6 * 60, extra: 2 * 60 });
    expect(half("9:20 AM", "1:20 PM")).toMatchObject({ halfDay: "eveningLeave", lateness: 20, shortness: 0, extra: 0 });

    // Arrives at 10:00 or later → morning leave: entry 11:00–13:00, counts until 18:00.
    expect(half("1:15 PM", "5:30 PM")).toMatchObject({ halfDay: "morningLeave", lateness: 15, extra: 30 });
    expect(half("10:30 AM", "3:30 PM")).toMatchObject({ halfDay: "morningLeave", lateness: 0, worked: 4 * 60 + 30, extra: 30 });
  });

  it("uses the leave part the user chose over detection", () => {
    const day = (dayType: RawDay["dayType"]) =>
      calculate([regular("2026-09-01", "8:00 AM", "4:00 PM", { dayType })], "2026-09-30").days[0];

    // Chosen morning leave: 8:00–11:00 was the vacation part, so work counts from 11:00.
    expect(day("halfDayMorning")).toMatchObject({ halfDay: "morningLeave", worked: 5 * 60, extra: 60 });
    // Chosen evening leave: work counts only until 13:00.
    expect(day("halfDayEvening")).toMatchObject({ halfDay: "eveningLeave", worked: 5 * 60, extra: 60 });
  });

  it("marks any missing sign-in or sign-out as absent, on normal and half days", () => {
    const s = calculate(
      [
        regular("2026-09-01", "8:00 AM", "", { clockOut: null }),
        regular("2026-09-02", "", "", { clockIn: null, clockOut: null }),
        regular("2026-09-03", "", "4:00 PM", { clockIn: null }),
        regular("2026-09-06", "", "", { clockIn: null, clockOut: null, dayType: "halfDayLeave" }),
        regular("2026-09-07", "8:00 AM", "10:00 AM"),
        regular("2026-09-08", "8:00 AM", "10:00 AM", { dayType: "halfDayEvening" }),
      ],
      "2026-09-30",
    );
    expect(s.days.map((d) => [d.status, d.absentReason])).toEqual([
      ["absent", "noSignOut"],
      ["absent", "noSignInOut"],
      ["absent", "noSignIn"],
      ["absent", "noSignInOut"],
      ["absent", "underMinimum"],
      ["ok", undefined], // half day: no 4-hour minimum
    ]);
    expect(s.absentDays).toBe(5);
    expect(s.totals.shortness).toBe(120); // only the half day is counted
  });

  it("excludes today by default, without flagging its missing sign-out", () => {
    const s = calculate([regular("2026-09-28", "8:00 AM", "", { clockOut: null })], "2026-09-28");
    expect(s.days[0]).toMatchObject({ status: "excluded", todayDefault: true, pageType: "regular" });
    expect(s.days[0].punchProblem).toBeUndefined();
    expect(s.absentDays).toBe(0);
  });

  it("counts today when the user gives it a type", () => {
    const today = regular("2026-09-28", "8:00 AM", "4:30 PM");
    const s = calculate([today], "2026-09-28", { "2026-09-28": "regular" });
    expect(s.days[0]).toMatchObject({ status: "ok", extra: 30 });
    expect(s.days[0].todayDefault).toBeUndefined();
  });

  it("leaves later days uncounted", () => {
    const s = calculate([regular("2026-09-29", "", "", { clockIn: null, clockOut: null })], "2026-09-28");
    expect(s.days[0].status).toBe("notCounted");
  });

  it("flags odd sign-in/out for a check with the security gate report", () => {
    const s = calculate(
      [
        regular("2026-09-01", "8:00 AM", "", { clockOut: null }),
        regular("2026-09-02", "", "4:00 PM", { clockIn: null }),
        regular("2026-09-03", "9:00 AM", "9:01 AM"),
        regular("2026-09-06", "8:00 AM", "4:00 PM", { unpairedPunch: true }),
        regular("2026-09-07", "8:00 AM", "4:00 PM"),
        regular("2026-09-08", "", "", { clockIn: null, clockOut: null }),
        regular("2026-09-09", "8:00 AM", "4:00 PM", { dayType: "weekend", unpairedPunch: true }),
      ],
      "2026-09-30",
    );
    expect(s.days.map((d) => d.punchProblem)).toEqual([
      "missingSignOut",
      "missingSignIn",
      "singlePunch",
      "unpairedPunch",
      undefined, // fine
      undefined, // no punches at all: absent, not odd
      undefined, // weekend: not checked
    ]);
    expect(s.problemDays).toBe(4);
    // An unpaired punch in the list does not stop the day being counted.
    expect(s.days[3].status).toBe("ok");
  });
});

describe("user overrides", () => {
  it("excludes a day or changes its type", () => {
    const { days } = load("attendance-en.html");
    // 10 Sep was absent (3:55); mark it as a half-day leave instead, and exclude 27 Sep (142 min late).
    const s = calculate(days, "2026-09-28", { "2026-09-10": "halfDayLeave", "2026-09-27": "excluded" });
    const day = (d: string) => s.days.find((x) => x.day.date === d)!;
    expect(day("2026-09-10")).toMatchObject({ status: "ok", pageType: "regular", lateness: 17, shortness: 0, extra: 0 });
    expect(day("2026-09-27").status).toBe("excluded");
    expect(s.totals.lateness).toBe(385 - 142 + 17);
  });

  it("can turn a work-from-home day into a counted day", () => {
    const wfh = regular("2026-09-01", "", "", { dayType: "wfh", clockIn: null, clockOut: null });
    expect(calculate([wfh], "2026-09-30", { "2026-09-01": "regular" }).days[0].status).toBe("absent");
  });
});

describe("half-day leave days without sign-in/out (August sample)", () => {
  it("reads them and marks them absent", () => {
    const { days } = load("attendance-en-halfday.html");
    expect(days).toHaveLength(31);
    const halfDays = days.filter((d) => d.dayType === "halfDayLeave");
    expect(halfDays.map((d) => d.date)).toEqual(["2026-08-18", "2026-08-20", "2026-08-26"]);
    expect(halfDays.every((d) => d.clockIn === null && d.clockOut === null)).toBe(true);

    const s = calculate(days, "2026-09-28");
    const absent = s.days.filter((d) => d.status === "absent");
    expect(absent.map((d) => [d.day.date, d.absentReason])).toEqual([
      ["2026-08-18", "noSignInOut"],
      ["2026-08-20", "noSignInOut"],
      ["2026-08-26", "noSignInOut"],
    ]);
    expect(s.absentDays).toBe(3);
  });
});

describe("punch list fallback", () => {
  it("takes times from the detail punch list when the main row has none", () => {
    const html = readFileSync(new URL("./fixtures/attendance-en-halfday.html", import.meta.url), "utf8");
    const doc = new JSDOM(html).window.document;
    // Put punches into 20 Aug's (half-day leave) punch list, the way the page lists them.
    const row = Array.from(doc.querySelectorAll("tr")).find((tr) =>
      tr.querySelector(":scope > td.cdk-column-Day")?.textContent?.includes("20 August 2026"),
    )!;
    const punchTable = row.nextElementSibling!.querySelectorAll("table.detail-table")[1];
    punchTable.querySelector("td[colspan]")!.parentElement!.outerHTML =
      "<tr><td>11:11 AM</td><td>1:00 PM</td></tr><tr><td>1:30 PM</td><td>3:40 PM</td></tr>";

    const day = parseAttendancePage(doc).days.find((d) => d.date === "2026-08-20")!;
    expect(day).toMatchObject({ dayType: "halfDayLeave", clockIn: 11 * 60 + 11, clockOut: 15 * 60 + 40 });

    const result = calculate([day], "2026-09-28").days[0];
    // Lateness is HR's own figure for the day (11), which the page lists alongside the punches.
    expect(result).toMatchObject({ status: "ok", halfDay: "morningLeave", lateness: 11, shortness: 0, extra: 29 });
  });

  it("does not read the weekend punches of the Arabic sample as a working day", () => {
    const day = load("attendance-ar.html").days.find((d) => d.date === "2026-09-04")!;
    expect(day).toMatchObject({ dayType: "weekend", clockIn: 15 * 60 + 15, clockOut: 15 * 60 + 34 });
    expect(calculate([day], "2026-09-28").days[0].status).toBe("excluded");
  });
});

describe("HR's own per-day minutes", () => {
  it("match the page's August totals exactly", () => {
    const { days } = load("attendance-en-halfday.html");
    // Give the half days the times the page shows once their rows are opened.
    const times: Record<string, [number, number]> = {
      "2026-08-18": [12 * 60 + 41, 18 * 60],
      "2026-08-20": [13 * 60 + 11, 18 * 60],
      "2026-08-26": [13 * 60 + 7, 17 * 60 + 33],
    };
    for (const d of days) if (times[d.date]) [d.clockIn, d.clockOut] = times[d.date];

    const s = calculate(days, "2026-09-28");
    const day = (d: string) => s.days.find((x) => x.day.date === d)!;
    // The page's summary: lateness 442, out of STC 792, shortness 92, 0 absent days.
    expect(s.totals).toMatchObject({ lateness: 442, outside: 792, shortness: 92 });
    expect(s.absentDays).toBe(0);
    expect(day("2026-08-23").lateness).toBe(0); // 9:04, inside HR's grace period
    expect(day("2026-08-06").shortness).toBe(34); // HR counts seconds; the times alone give 35
  });

  it("are not used for a day whose type the user changed", () => {
    const { days } = load("attendance-en.html");
    // 10 Sep: HR lists shortness 227 for a full day; as an evening-leave half day it is 0.
    const s = calculate(days, "2026-09-28", { "2026-09-10": "halfDayEvening" });
    expect(s.days.find((d) => d.day.date === "2026-09-10")).toMatchObject({ status: "ok", lateness: 17, shortness: 0 });
  });
});

describe("needs justification", () => {
  const day = (date: string, clockIn: string, clockOut: string) => regular(date, clockIn, clockOut);
  const days = (n: number, clockIn: string, clockOut: string, from = 1) =>
    Array.from({ length: n }, (_, i) => day(`2026-09-${String(from + i).padStart(2, "0")}`, clockIn, clockOut));

  it("is 0 when everything fits within the allowance", () => {
    // 60 min late, 30 min short covered by 60 min make-up.
    const s = calculate([day("2026-09-01", "10:00 AM", "5:00 PM"), day("2026-09-02", "8:00 AM", "3:30 PM"), day("2026-09-03", "7:00 AM", "4:00 PM")], "2026-09-30");
    expect(s.totals).toMatchObject({ lateness: 60, shortness: 30, extra: 60 });
    expect(s.justification).toEqual({ total: 0, latenessOver: 0, notMadeUp: 0 });
  });

  it("with lateness within 8 hours, lets the allowance absorb uncovered shortness first", () => {
    // 400 min late + 100 min short with no make-up = 500 charged: 20 over the allowance.
    const s = calculate([...days(4, "10:40 AM", "5:00 PM"), day("2026-09-10", "8:00 AM", "2:20 PM")], "2026-09-30");
    expect(s.totals).toMatchObject({ lateness: 400, shortness: 100, extra: 0 });
    expect(s.justification).toEqual({ total: 20, latenessOver: 0, notMadeUp: 100 });
    expect(s.remaining).toBe(-20);
  });

  it("with lateness over 8 hours, adds the excess lateness and the uncovered shortness", () => {
    // 600 min late (120 over) + 45 min short with no make-up.
    const s = calculate([...days(10, "10:00 AM", "5:00 PM"), day("2026-09-15", "8:00 AM", "3:15 PM")], "2026-09-30");
    expect(s.totals).toMatchObject({ lateness: 600, shortness: 45, extra: 0 });
    expect(s.justification).toEqual({ total: 165, latenessOver: 120, notMadeUp: 45 });
  });

  it("never lets leftover make-up reduce lateness over 8 hours", () => {
    // 600 min late (120 over); 300 min make-up with nothing to cover: still 120.
    const s = calculate([...days(10, "10:00 AM", "5:00 PM"), ...days(5, "7:00 AM", "4:00 PM", 15)], "2026-09-30");
    expect(s.totals).toMatchObject({ lateness: 600, shortness: 0, extra: 300 });
    expect(s.justification).toEqual({ total: 120, latenessOver: 120, notMadeUp: 0 });
  });

  it("is 2 min for the September sample", () => {
    const s = calculate(load("attendance-en.html").days, "2026-09-28");
    expect(s.justification).toEqual({ total: 2, latenessOver: 0, notMadeUp: 97 });
  });
});
