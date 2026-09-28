import { describe, expect, it } from "vitest";
import { calculate } from "../src/calculator";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { DEFAULT_SETTINGS, resolveShifts, shiftWindows, withDefaults, type Settings } from "../src/settings";
import { parseAttendancePage, parseClock } from "../src/parser";
import type { RawDay } from "../src/types";

const t = (text: string) => parseClock(text)!;
const day = (date: string, clockIn: string, clockOut: string, extra: Partial<RawDay> = {}): RawDay => ({
  date,
  dayType: "regular",
  clockIn: t(clockIn),
  clockOut: t(clockOut),
  reported: null,
  netMinutes: null,
  shiftName: "Ramadan",
  ...extra,
});
const one = (d: RawDay, overrides = {}, settings: Settings = DEFAULT_SETTINGS) =>
  calculate([d], "2026-12-31", overrides, settings).days[0];

describe("shift windows", () => {
  it("reproduce the regular rules", () => {
    const w = shiftWindows(DEFAULT_SETTINGS.regular);
    expect(w).toEqual({
      half: 240,
      minimumWorked: 240,
      morningLeave: { start: t("11:00"), entryTo: t("13:00"), end: t("18:00") },
      eveningLeave: { start: t("7:00"), entryTo: t("9:00"), end: t("13:00") },
      detectMorningLeaveAt: t("10:00"),
    });
  });

  it("scale with the Ramadan shift (entry 10:00–12:00, 5 hours)", () => {
    const w = shiftWindows(DEFAULT_SETTINGS.ramadan);
    expect(w.minimumWorked).toBe(150); // 2.5 hours
    expect(w.eveningLeave).toEqual({ start: t("10:00"), entryTo: t("12:00"), end: t("14:30") });
    expect(w.morningLeave).toEqual({ start: t("12:30"), entryTo: t("14:30"), end: t("18:00") });
  });
});

describe("which shift a day is on", () => {
  const shifts = (days: RawDay[], settings: Settings = DEFAULT_SETTINGS) => resolveShifts(days, settings);

  it("is regular for Regular / منتظم, and Ramadan for any other shift name", () => {
    expect(
      shifts([
        day("2026-03-01", "10:00", "15:00", { shiftName: "Regular" }),
        day("2026-03-02", "10:00", "15:00", { shiftName: "منتظم" }),
        day("2026-03-03", "10:00", "15:00", { shiftName: "Ramadan" }),
        day("2026-03-04", "10:00", "15:00", { shiftName: "دوام رمضان" }),
        day("2026-03-05", "10:00", "15:00", { shiftName: "Special Shift" }),
        day("2026-03-06", "10:00", "15:00", { shiftName: "  REGULAR " }),
        day("2026-03-07", "10:00", "15:00", { shiftName: "مُنتظم" }), // with a diacritic
      ]),
    ).toEqual(["regular", "regular", "ramadan", "ramadan", "ramadan", "regular", "regular"]);
  });

  it("uses the regular names set in the settings", () => {
    const settings = withDefaults({ regularNames: ["Normal", "عادي"] });
    expect(shifts([day("2026-03-01", "8:00", "16:00", { shiftName: "Normal" }), day("2026-03-02", "8:00", "16:00", { shiftName: "Regular" })], settings)).toEqual([
      "regular",
      "ramadan",
    ]);
  });

  it("ignores the shift name of weekends, vacations and other non-working days", () => {
    const off = (date: string, dayType: RawDay["dayType"]) =>
      day(date, "10:00", "15:00", { dayType, shiftName: "Ramadan", clockIn: null, clockOut: null });
    // Regular working days around them decide their shift.
    expect(
      shifts([
        day("2026-03-01", "8:00", "16:00", { shiftName: "Regular" }),
        off("2026-03-02", "weekend"),
        off("2026-03-03", "annualVacation"),
        off("2026-03-04", "wfh"),
        day("2026-03-05", "8:00", "16:00", { shiftName: "Regular" }),
      ]),
    ).toEqual(["regular", "regular", "regular", "regular", "regular"]);
  });

  it("gives half days without a shift name the nearest working day's shift", () => {
    const half = (date: string) => day(date, "13:00", "15:30", { dayType: "halfDayLeave", shiftName: "" });
    expect(
      shifts([
        day("2026-03-01", "10:00", "15:00", { shiftName: "Ramadan" }),
        day("2026-03-02", "", "", { dayType: "weekend", shiftName: "", clockIn: null, clockOut: null }),
        half("2026-03-03"),
        day("2026-03-04", "10:00", "15:00", { shiftName: "Ramadan" }),
      ]),
    ).toEqual(["ramadan", "ramadan", "ramadan", "ramadan"]);
    expect(shifts([half("2026-03-01"), day("2026-03-02", "8:00", "16:00", { shiftName: "Regular" })])).toEqual(["regular", "regular"]);
  });

  it("makes every day inside the Ramadan dates Ramadan, whatever its name", () => {
    const settings = { ...DEFAULT_SETTINGS, ramadanFrom: "2026-02-18", ramadanTo: "2026-03-19" };
    expect(
      shifts([day("2026-03-01", "10:00", "15:00", { shiftName: "Regular" }), day("2026-03-20", "8:00", "16:00", { shiftName: "Regular" })], settings),
    ).toEqual(["ramadan", "regular"]);
  });

  it("keeps the September sample regular (Regular / منتظم)", () => {
    for (const lang of ["en", "ar"]) {
      const { days } = parseAttendancePage(new JSDOM(readFileSync(`tests/fixtures/attendance-${lang}.html`, "utf8")).window.document);
      expect(new Set(resolveShifts(days, DEFAULT_SETTINGS))).toEqual(new Set(["regular"]));
    }
  });

  it("drops the old ramadanNames setting", () => {
    expect(withDefaults({ ramadanNames: ["Ramadan"] } as never)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("Ramadan days", () => {
  it("need 5 hours from entry, with lateness after 12:00", () => {
    expect(one(day("2026-03-01", "10:00", "15:00"))).toMatchObject({ shift: "ramadan", status: "ok", lateness: 0, shortness: 0, extra: 0 });
    expect(one(day("2026-03-02", "11:30", "16:00"))).toMatchObject({ lateness: 0, shortness: 30, extra: 0 });
    // 12:20 is 20 min late; still has to stay until 17:00 (12:00 + 5h); 17:30 gives 30 min make-up.
    expect(one(day("2026-03-03", "12:20", "17:30"))).toMatchObject({ lateness: 20, shortness: 0, extra: 30 });
  });

  it("are absent under 2.5 hours (half the shift)", () => {
    expect(one(day("2026-03-01", "10:00", "12:29"))).toMatchObject({ status: "absent", absentReason: "underMinimum" });
    expect(one(day("2026-03-02", "10:00", "12:30"))).toMatchObject({ status: "ok", shortness: 150 });
  });

  it("have 2.5-hour half days with Ramadan windows", () => {
    // Evening leave: 10:00 in, due out 12:30; nothing after 14:30 counts.
    expect(one(day("2026-03-01", "10:00", "16:00", { dayType: "halfDayLeave" }))).toMatchObject({
      halfDay: "eveningLeave",
      window: { start: t("10:00"), end: t("14:30") },
      extra: 120,
    });
    // Morning leave: 13:00 in (entry window 12:30–14:30), due out 15:30.
    expect(one(day("2026-03-02", "13:00", "15:30", { dayType: "halfDayLeave" }))).toMatchObject({
      halfDay: "morningLeave",
      lateness: 0,
      shortness: 0,
    });
  });

  it("use the times set in the settings", () => {
    const settings = withDefaults({ ramadan: { entryFrom: t("9:00"), entryTo: t("11:00"), hours: 6 * 60, makeupUntil: t("17:00") } });
    // 11:10 is 10 min late; due out 17:00 (11:00 + 6h); make-up stops at 17:00.
    expect(one(day("2026-03-01", "11:10", "17:30"), {}, settings)).toMatchObject({ lateness: 10, shortness: 0, extra: 0 });
    expect(shiftWindows(settings.ramadan).minimumWorked).toBe(180);
  });

  it("do not change regular days in the same month", () => {
    const s = calculate(
      [day("2026-03-01", "10:00", "15:00"), day("2026-02-10", "8:00", "16:00", { shiftName: "Regular" })],
      "2026-12-31",
    );
    expect(s.days.map((d) => [d.shift, d.status, d.shortness])).toEqual([
      ["ramadan", "ok", 0],
      ["regular", "ok", 0],
    ]);
  });
});

describe("reading Ramadan rows from the page", () => {
  it("treats a day with a non-regular shift name and no punches as an absent working day", () => {
    const doc = new JSDOM(readFileSync("tests/fixtures/attendance-ar.html", "utf8")).window.document;
    const row = Array.from(doc.querySelectorAll("tr")).find((tr) => tr.querySelector(":scope > td.cdk-column-Day")?.textContent?.includes("10 سبتمبر"))!;
    row.querySelector("td.cdk-column-shiftType")!.textContent = " رمضان ";
    for (const col of ["ClockIn", "ClockOut", "netAttendanceHours"]) row.querySelector(`td.cdk-column-${col}`)!.textContent = "";

    const days = parseAttendancePage(doc).days;
    const tenth = days.find((d) => d.date === "2026-09-10")!;
    expect(tenth).toMatchObject({ dayType: "regular", shiftName: "رمضان", clockIn: null, clockOut: null });
    const result = calculate(days, "2026-09-28").days.find((d) => d.day.date === "2026-09-10")!;
    expect(result).toMatchObject({ shift: "ramadan", status: "absent", absentReason: "noSignInOut" });
  });
});
