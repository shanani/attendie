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
  reported: { lateness: 0, shortness: 0, outside: 0 },
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
    expect(ar.days).toEqual(en.days);
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
    expect(status("2026-09-28")).toBe("notCounted");
    expect(status("2026-09-07")).toBe("excluded");

    expect(s.totals).toEqual({ lateness: 385, shortness: 197, outside: 397, extra: 494 });
    expect(s.extraUsed).toBe(494);
    expect(s.charged).toBe(485);
    expect(s.remaining).toBe(-5);
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

  it("treats a half-day leave as 4 required hours with no 4-hour minimum", () => {
    const morning = calculate(
      [regular("2026-09-01", "8:00 AM", "11:50 AM", { dayType: "halfDayLeave" })],
      "2026-09-30",
    );
    expect(morning.days[0]).toMatchObject({ status: "ok", halfDay: "morningWork", shortness: 10 });

    const afternoon = calculate(
      [regular("2026-09-01", "1:15 PM", "5:30 PM", { dayType: "halfDayLeave" })],
      "2026-09-30",
    );
    expect(afternoon.days[0]).toMatchObject({ status: "ok", halfDay: "afternoonWork", lateness: 15, extra: 30 });

    // Make-up on a half day counts anywhere between 7:00 and 18:00.
    const early = calculate(
      [regular("2026-09-01", "10:30 AM", "3:30 PM", { dayType: "halfDayLeave" })],
      "2026-09-30",
    );
    expect(early.days[0]).toMatchObject({ status: "ok", halfDay: "afternoonWork", lateness: 0, extra: 60 });

    const long = calculate(
      [regular("2026-09-01", "7:00 AM", "6:30 PM", { dayType: "halfDayLeave" })],
      "2026-09-30",
    );
    expect(long.days[0]).toMatchObject({ halfDay: "morningWork", extra: 7 * 60 });
  });

  it("flags missing punches and absences on past working days", () => {
    const s = calculate(
      [
        regular("2026-09-01", "8:00 AM", "", { clockOut: null }),
        regular("2026-09-02", "", "", { clockIn: null, clockOut: null }),
      ],
      "2026-09-30",
    );
    expect(s.days.map((d) => d.status)).toEqual(["missingPunch", "absent"]);
    expect(s.charged).toBe(0);
  });
});

describe("user overrides", () => {
  it("excludes a day or changes its type", () => {
    const { days } = load("attendance-en.html");
    // 10 Sep was absent (3:55); mark it as a half-day leave instead, and exclude 27 Sep (142 min late).
    const s = calculate(days, "2026-09-28", { "2026-09-10": "halfDayLeave", "2026-09-27": "excluded" });
    const day = (d: string) => s.days.find((x) => x.day.date === d)!;
    expect(day("2026-09-10")).toMatchObject({ status: "ok", pageType: "regular", lateness: 17, shortness: 0, extra: 12 });
    expect(day("2026-09-27").status).toBe("excluded");
    expect(s.totals.lateness).toBe(385 - 142 + 17);
  });

  it("can turn a work-from-home day into a counted day", () => {
    const wfh = regular("2026-09-01", "", "", { dayType: "wfh", clockIn: null, clockOut: null });
    expect(calculate([wfh], "2026-09-30", { "2026-09-01": "regular" }).days[0].status).toBe("absent");
  });
});

describe("half-day leave days without sign-in/out (August sample)", () => {
  it("reads them and uses HR's reported minutes", () => {
    const { days } = load("attendance-en-halfday.html");
    expect(days).toHaveLength(31);
    const halfDays = days.filter((d) => d.dayType === "halfDayLeave");
    expect(halfDays.map((d) => d.date)).toEqual(["2026-08-18", "2026-08-20", "2026-08-26"]);
    expect(halfDays.every((d) => d.clockIn === null && d.clockOut === null)).toBe(true);

    const s = calculate(days, "2026-09-28");
    const day = (d: string) => s.days.find((x) => x.day.date === d)!;
    expect(day("2026-08-18")).toMatchObject({ status: "ok", fromPage: true, lateness: 0 });
    expect(day("2026-08-20")).toMatchObject({ status: "ok", fromPage: true, lateness: 11 });
    expect(day("2026-08-26")).toMatchObject({ status: "ok", fromPage: true, lateness: 7 });
    expect(s.days.filter((d) => d.status === "absent")).toHaveLength(0);
  });
});
