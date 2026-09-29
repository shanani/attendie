import type { DayResult, Summary } from "./calculator";
import { clock, halfDayNote, hm } from "./format";
import { STRINGS } from "./i18n";
import { DEFAULT_SETTINGS, type Settings, shiftWindows } from "./settings";
import type { Lang } from "./types";
import { buildXlsx, columnName, excelDate, type Cell, type Sheet, type Style } from "./xlsx";

/** Columns of the Days sheet, in order. The Summary formulas refer to them by key. */
const DAY_COLUMNS = [
  "date",
  "pageType",
  "typeUsed",
  "shift",
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
  "balance",
  "source",
] as const;
type DayColumn = (typeof DAY_COLUMNS)[number];

const WIDTHS: Record<DayColumn, number> = {
  date: 17, pageType: 16, typeUsed: 16, shift: 14, counted: 9, status: 11, gateCheck: 26, notes: 38, timeIn: 9, timeOut: 9,
  span: 11, pageTotal: 11, worked: 10, lateness: 10, shortness: 10, outside: 10, extra: 10, balance: 12, source: 12,
};

const col = (key: DayColumn) => columnName(DAY_COLUMNS.indexOf(key));

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
    halfDayNote(d, lang),
    d.absentReason && t.absentReason[d.absentReason].replace("{0}", hm(d.worked)),
  ].filter(Boolean) as string[];

  const inRef = `${col("timeIn")}${rowNumber}`;
  const outRef = `${col("timeOut")}${rowNumber}`;
  const hasTimes = d.day.clockIn !== null && d.day.clockOut !== null;
  const cells: Record<DayColumn, Cell> = {
    date: { value: excelDate(d.day.date), style: { ...base, numFmt: "date" } },
    pageType: text(t.dayTypes[d.pageType]),
    typeUsed: text(t.dayTypes[d.day.dayType]),
    shift: text(t.shiftNames[d.shift]),
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
    balance: {
      value: counted ? d.extra - d.shortness - d.outside : "",
      formula: `IF(${col("counted")}${rowNumber}=1,${col("extra")}${rowNumber}-${col("shortness")}${rowNumber}-${col("outside")}${rowNumber},"")`,
      style: { ...base, numFmt: "int", bold: true },
    },
    source: text(counted ? (d.day.reported && d.day.dayType === d.pageType ? x.sourceHr : x.sourceCalc) : ""),
  };
  return DAY_COLUMNS.map((key) => cells[key]);
}

/** The rules as they apply with these settings, one line each. */
function ruleLines(lang: Lang, settings: Settings): string[] {
  const x = STRINGS[lang].excel;
  const t = STRINGS[lang];
  const fill = (template: string, values: Record<string, string>) =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
  const [excluded, allowance, shift, ramadanDays, ...rest] = x.rules;
  const shiftLine = (name: "regular" | "ramadan") => {
    const s = settings[name];
    return fill(shift, {
      shift: t.shiftNames[name],
      hours: hm(s.hours),
      from: clock(s.entryFrom),
      to: clock(s.entryTo),
      until: clock(s.makeupUntil),
      minimum: hm(shiftWindows(s).minimumWorked),
    });
  };
  const dates =
    settings.ramadanFrom && settings.ramadanTo
      ? x.ramadanDates.replace("{0}", settings.ramadanFrom).replace("{1}", settings.ramadanTo)
      : "";
  return [
    excluded,
    fill(allowance, { allowance: hm(settings.monthlyAllowance) }),
    shiftLine("regular"),
    shiftLine("ramadan"),
    fill(ramadanDays, { names: settings.regularNames.map((n) => `"${n}"`).join(", "), dates }),
    ...rest,
  ];
}

function summarySheet(summary: Summary, lang: Lang, daysSheet: string, lastRow: number, settings: Settings): Sheet {
  const t = STRINGS[lang];
  const x = t.excel;
  const range = (key: DayColumn) => `'${daysSheet}'!${col(key)}2:${col(key)}${lastRow}`;
  const sumCounted = (key: DayColumn) => `SUMIFS(${range(key)},${range("counted")},1)`;
  const header: Style = { bold: true, fill: "header" };
  const { totals } = summary;

  // [label, formula (row numbers refer to this sheet), extension's value, how it is worked out]
  const lines: [string, string | null, number, string][] = [
    [x.sumAllowance, null, settings.monthlyAllowance, x.howAllowance],
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
    [x.sumLatenessOver, "MAX(0,B3-B2)", summary.justification.latenessOver, x.howLatenessOver],
    [x.sumNotMadeUp, "B7-B8", summary.justification.notMadeUp, x.howNotMadeUp],
    [t.justifyTitle, "MAX(0,B9-B2)", summary.justification.total, x.howJustify],
    [x.sumBalance, sumCounted("balance"), totals.extra - totals.shortness - totals.outside, x.howBalance],
  ];

  const rows: Cell[][] = [
    x.summaryHeaders.map((h) => ({ value: h, style: header })),
    ...lines.map(([label, formula, value, how], i): Cell[] => {
      const r = i + 2;
      const strong = label === t.statRemaining || label === t.justifyTitle;
      const bad = label === t.justifyTitle ? value > 0 : value < 0;
      const style: Style = { numFmt: "int", bold: strong, fill: strong ? (bad ? "red" : "green") : undefined };
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
    ...ruleLines(lang, settings).map((line) => [{ value: line, style: { wrap: false } }]),
    [],
    [{ value: x.tip, style: { fill: "yellow" } }],
  ];
  return { name: x.summarySheet, rows, widths: [40, 12, 12, 11, 70], freezeHeader: true, rightToLeft: lang === "ar" };
}

/** The Days and Summary sheets for a month, with formulas that recompute every total. */
export function attendanceSheets(summary: Summary, lang: Lang, settings: Settings = DEFAULT_SETTINGS): Sheet[] {
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
  return [summarySheet(summary, lang, x.daysSheet, summary.days.length + 1, settings), days];
}

export function attendanceWorkbook(summary: Summary, lang: Lang, settings: Settings = DEFAULT_SETTINGS): Uint8Array {
  return buildXlsx(attendanceSheets(summary, lang, settings));
}
