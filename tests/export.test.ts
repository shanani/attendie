import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { calculate } from "../src/calculator";
import { attendanceSheets, attendanceWorkbook } from "../src/export";
import { parseAttendancePage } from "../src/parser";
import { columnName, excelDate } from "../src/xlsx";

const september = (lang: "en" | "ar") => {
  const { days } = parseAttendancePage(new JSDOM(readFileSync(`tests/fixtures/attendance-${lang}.html`, "utf8")).window.document);
  return calculate(days, "2026-09-28");
};

describe("xlsx helpers", () => {
  it("names columns and dates the way Excel does", () => {
    expect([0, 25, 26, 27, 701].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ"]);
    expect(excelDate("1900-03-01")).toBe(61);
    expect(excelDate("2026-09-10")).toBe(46275);
  });
});

describe("Excel export", () => {
  it("puts a Summary sheet first, with formulas that match the extension's numbers", () => {
    const s = september("en");
    const [summary, days] = attendanceSheets(s, "en");
    expect([summary.name, days.name]).toEqual(["Summary", "Days"]);
    expect(days.rows).toHaveLength(s.days.length + 1);

    const line = (label: string) => summary.rows.find((r) => r[0]?.value === label)!;
    expect(line("Remaining this month")[1]).toMatchObject({ formula: "B2-B9", value: s.remaining });
    expect(line("Lateness (after entry window)")[1].formula).toBe("SUMIFS('Days'!M2:M29,'Days'!D2:D29,1)");
    expect(line("Absent days")[1]).toMatchObject({ formula: `COUNTIF('Days'!E2:E29,"Absent")`, value: 1 });
    // Row 9 is "Charged to allowance", row 2 the allowance.
    expect(line("Charged to allowance")).toBe(summary.rows[8]);
    expect(line("Needs justification")[1]).toMatchObject({ formula: "MAX(0,B9-B2)", value: 2, style: { fill: "red" } });
  });

  it("marks each day for manual checking", () => {
    const [, days] = attendanceSheets(september("en"), "en");
    const header = days.rows[0].map((c) => c.value);
    const row = (iso: string) => days.rows.find((r) => r[0].value === excelDate(iso))!;
    const cell = (iso: string, name: string) => row(iso)[header.indexOf(name)];

    // 10 Sep: absent (3:55), red, not counted.
    expect(cell("2026-09-10", "Counted (1/0)").value).toBe(0);
    expect(cell("2026-09-10", "Status")).toMatchObject({ value: "Absent", style: { fill: "red" } });
    expect(cell("2026-09-10", "Time in")).toMatchObject({ value: (9 * 60 + 17) / 1440, style: { numFmt: "time" } });
    expect(cell("2026-09-10", "Out − In (min)")).toMatchObject({ value: 235, formula: expect.stringContaining("*1440") });
    // 2 Sep: counted, HR's own minutes, 101 min outside.
    expect(cell("2026-09-02", "Counted (1/0)").value).toBe(1);
    expect(cell("2026-09-02", "Outside (min)").value).toBe(101);
    expect(cell("2026-09-02", "Late/short from").value).toBe("HR page");
    // Today: excluded by default, with a note.
    expect(cell("2026-09-28", "Notes").value).toContain("Today: excluded by default");
  });

  it("flags odd punches in orange for the gate report", () => {
    const s = calculate(
      [{ date: "2026-09-01", dayType: "regular", clockIn: 480, clockOut: null, reported: null, netMinutes: null }],
      "2026-09-30",
    );
    const [, days] = attendanceSheets(s, "en");
    const gate = days.rows[1][days.rows[0].findIndex((c) => c.value === "Check gate report")];
    expect(gate).toMatchObject({ value: "⚠ sign-in without sign-out", style: { fill: "orange" } });
  });

  it("writes a valid Arabic, right-to-left workbook", () => {
    const files = unzipSync(attendanceWorkbook(september("ar"), "ar"));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]),
    );
    const workbook = strFromU8(files["xl/workbook.xml"]);
    expect(workbook).toContain('name="الملخص"');
    expect(workbook).toContain('fullCalcOnLoad="1"');
    expect(strFromU8(files["xl/worksheets/sheet2.xml"])).toContain('rightToLeft="1"');
  });
});
