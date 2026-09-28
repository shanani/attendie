import { DEFAULT_RULES, type DayResult, type Rules, type Summary } from "./calculator";
import { STRINGS } from "./i18n";
import type { Lang } from "./types";
import { buildXlsx, columnName, excelDate, type Cell, type Sheet, type Style } from "./xlsx";

/** Columns of the Days sheet, in order. The Summary formulas refer to them by key. */
const DAY_COLUMNS = [
  "date",
  "pageType",
  "typeUsed",
  "counted",
  "status",
  "gateCheck",
  "notes",
  "timeIn",
  "timeOut",
  "span",
  "pageTotal",
  "worked",
  "lateness",
  "shortness",
  "outside",
  "extra",
  "source",
] as const;
type DayColumn = (typeof DAY_COLUMNS)[number];

const WIDTHS: Record<DayColumn, number> = {
  date: 17, pageType: 16, typeUsed: 16, counted: 9, status: 11, gateCheck: 26, notes: 38, timeIn: 9, timeOut: 9,
  span: 11, pageTotal: 11, worked: 10, lateness: 10, shortness: 10, outside: 10, extra: 10, source: 12,
};

const col = (key: DayColumn) => columnName(DAY_COLUMNS.indexOf(key));
const hm = (m: number) => `${m < 0 ? "-" : ""}${Math.floor(Math.abs(m) / 60)}:${String(Math.abs(m) % 60).padStart(2, "0")}`;

function rowStyle(d: DayResult): Style {
  if (d.punchProblem) return { fill: "orange" };
  if (d.status === "absent") return { fill: "red" };
  if (d.status !== "ok") return { muted: true };
  return {};
}

function dayRow(d: DayResult, lang: Lang, rowNumber: number): Cell[] {
  const t = STRINGS[lang];
  const x = t.excel;
  const base = rowStyle(d);
  const counted = d.status === "ok";
  const minutes = (value: number, show = counted): Cell => ({ value: show ? value : null, style: { ...base, numFmt: "int" } });
  const time = (m: number | null): Cell => ({ value: m === null ? null : m / 1440, style: { ...base, numFmt: "time" } });
  const text = (value: string, wrap = false): Cell => ({ value, style: { ...base, wrap } });

  const notes = [
    d.todayDefault && x.todayNote,
    d.day.dayType !== d.pageType && !d.todayDefault && t.overridden.replace("{0}", t.dayTypes[d.pageType]),
    d.halfDay && t.halfDayPart[d.halfDay],
    d.absentReason && t.absentReason[d.absentReason].replace("{0}", hm(d.worked)),
  ].filter(Boolean) as string[];

  const inRef = `${col("timeIn")}${rowNumber}`;
  const outRef = `${col("timeOut")}${rowNumber}`;
  const hasTimes = d.day.clockIn !== null && d.day.clockOut !== null;
  const cells: Record<DayColumn, Cell> = {
    date: { value: excelDate(d.day.date), style: { ...base, numFmt: "date" } },
    pageType: text(t.dayTypes[d.pageType]),
    typeUsed: text(t.dayTypes[d.day.dayType]),
    counted: { value: counted ? 1 : 0, style: { ...base, numFmt: "int", bold: true } },
    status: text(t.status[d.status]),
    gateCheck: text(d.punchProblem ? `⚠ ${t.punchProblem[d.punchProblem]}` : ""),
    notes: text(notes.join(" · "), true),
    timeIn: time(d.day.clockIn),
    timeOut: time(d.day.clockOut),
    span: {
      value: hasTimes ? d.day.clockOut! - d.day.clockIn! : "",
      formula: `IF(AND(ISNUMBER(${inRef}),ISNUMBER(${outRef})),ROUND((${outRef}-${inRef})*1440,0),"")`,
      style: { ...base, numFmt: "int" },
    },
    pageTotal: time(d.day.netMinutes),
    worked: minutes(d.worked, counted || d.absentReason === "underMinimum"),
    lateness: minutes(d.lateness),
    shortness: minutes(d.shortness),
    outside: minutes(d.outside),
    extra: minutes(d.extra),
    source: text(counted ? (d.day.reported && d.day.dayType === d.pageType ? x.sourceHr : x.sourceCalc) : ""),
  };
  return DAY_COLUMNS.map((key) => cells[key]);
}

function summarySheet(summary: Summary, lang: Lang, daysSheet: string, lastRow: number, rules: Rules): Sheet {
  const t = STRINGS[lang];
  const x = t.excel;
  const range = (key: DayColumn) => `'${daysSheet}'!${col(key)}2:${col(key)}${lastRow}`;
  const sumCounted = (key: DayColumn) => `SUMIFS(${range(key)},${range("counted")},1)`;
  const header: Style = { bold: true, fill: "header" };
  const { totals } = summary;

  // [label, formula (row numbers refer to this sheet), extension's value, how it is worked out]
  const lines: [string, string | null, number, string][] = [
    [x.sumAllowance, null, rules.monthlyAllowance, x.howAllowance],
    [t.lateness, sumCounted("lateness"), totals.lateness, x.howSum],
    [t.shortness, sumCounted("shortness"), totals.shortness, x.howSum],
    [t.outside, sumCounted("outside"), totals.outside, x.howSum],
    [t.statMakeup, sumCounted("extra"), totals.extra, x.howSum],
    [x.sumShortOutside, "B4+B5", totals.shortness + totals.outside, x.howShortOutside],
    [t.extraUsed, "MIN(B6,B7)", summary.extraUsed, x.howExtraUsed],
    [t.charged, "B3+B7-B8", summary.charged, x.howCharged],
    [t.statRemaining, "B2-B9", summary.remaining, x.howRemaining],
    [t.statLateShort, "B3+B7", totals.lateness + totals.shortness + totals.outside, x.howLateShort],
    [t.absentDays, `COUNTIF(${range("status")},"${t.status.absent}")`, summary.absentDays, x.howAbsent],
    [x.sumGateDays, `SUMPRODUCT(--(LEN(${range("gateCheck")})>0))`, summary.problemDays, x.howGate],
  ];

  const rows: Cell[][] = [
    x.summaryHeaders.map((h) => ({ value: h, style: header })),
    ...lines.map(([label, formula, value, how], i): Cell[] => {
      const r = i + 2;
      const strong = label === t.statRemaining;
      const style: Style = { numFmt: "int", bold: strong, fill: strong ? (value < 0 ? "red" : "green") : undefined };
      return [
        { value: label, style: { bold: strong } },
        formula === null ? { value, style } : { value, formula, style },
        { value, style: { numFmt: "int" } },
        { value: 0, formula: `B${r}-C${r}`, style: { numFmt: "int" } },
        { value: how, style: { wrap: true } },
      ];
    }),
    [],
    [{ value: x.rulesTitle, style: { bold: true } }],
    ...x.rules.map((line) => [{ value: line, style: { wrap: false } }]),
    [],
    [{ value: x.tip, style: { fill: "yellow" } }],
  ];
  return { name: x.summarySheet, rows, widths: [40, 12, 12, 11, 70], freezeHeader: true, rightToLeft: lang === "ar" };
}

/** The Days and Summary sheets for a month, with formulas that recompute every total. */
export function attendanceSheets(summary: Summary, lang: Lang, rules: Rules = DEFAULT_RULES): Sheet[] {
  const x = STRINGS[lang].excel;
  const header: Style = { bold: true, fill: "header", wrap: true };
  const days: Sheet = {
    name: x.daysSheet,
    rows: [
      DAY_COLUMNS.map((key) => ({ value: x.headers[key], style: header })),
      ...summary.days.map((d, i) => dayRow(d, lang, i + 2)),
    ],
    widths: DAY_COLUMNS.map((key) => WIDTHS[key]),
    freezeHeader: true,
    autoFilter: true,
    rightToLeft: lang === "ar",
  };
  return [summarySheet(summary, lang, x.daysSheet, summary.days.length + 1, rules), days];
}

export function attendanceWorkbook(summary: Summary, lang: Lang, rules: Rules = DEFAULT_RULES): Uint8Array {
  return buildXlsx(attendanceSheets(summary, lang, rules));
}
