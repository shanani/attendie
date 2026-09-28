import type { DayType, Lang, Minutes, ParseResult, RawDay, ReportedMinutes } from "./types";

/** Day-type labels as the HR page shows them, in both languages. */
const DAY_TYPE_LABELS: [DayType, string[]][] = [
  ["halfDayLeave", ["Half Day Leave", "إجازة نصف يوم"]],
  ["annualVacation", ["Annual Vacation", "إجازة سنوية"]],
  ["wfh", ["Working from Home", "العمل من المنزل"]],
  ["holiday", ["Holiday Day", "عطلة رسمية"]],
  ["weekend", ["Weekend", "عطلة أسبوعية"]],
  ["training", ["Training", "تدريب"]],
  ["regular", ["Regular", "منتظم"]],
];

/** Row labels of the day's detail table ("Type | Minutes | Justified minutes"). */
const REPORTED_LABELS: [keyof ReportedMinutes, string[]][] = [
  ["lateness", ["Lateness", "التأخير"]],
  ["shortness", ["Shortness", "Half-Day Shortness", "التقصير", "تقصير نصف يوم"]],
  ["outside", ["Out of STC", "خارج الشركة"]],
];

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يونيه: 6,
  يوليو: 7, يوليه: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
};

function normalize(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[أإآ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLabel(text: string): string {
  return normalize(text).toLowerCase();
}

function textOf(el: Element | null | undefined): string {
  return el ? normalize(el.textContent ?? "") : "";
}

/** "9:34 AM" / "9:34 م" / "17:05" → minutes since midnight. */
export function parseClock(text: string): Minutes | null {
  const m = normalize(text).match(/(\d{1,2}):(\d{2})\s*(AM|PM|ص|م)?/i);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const suffix = m[3]?.toUpperCase();
  if (suffix === "PM" || suffix === "م") {
    if (hours < 12) hours += 12;
  } else if ((suffix === "AM" || suffix === "ص") && hours === 12) {
    hours = 0;
  }
  return hours * 60 + minutes;
}

/** "08:27" → 507. */
export function parseDuration(text: string): number | null {
  const m = normalize(text).match(/^(\d{1,3}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "01 September 2026" / "01 سبتمبر 2026" → "2026-09-01". */
export function parseDate(text: string): string | null {
  const m = normalize(text).match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function detectDayType(rowText: string, hasTimes: boolean): DayType {
  const haystack = normalizeLabel(rowText);
  for (const [type, labels] of DAY_TYPE_LABELS) {
    if (labels.some((l) => haystack.includes(normalizeLabel(l)))) return type;
  }
  return hasTimes ? "regular" : "unknown";
}

/** Minutes HR lists in the expandable detail row that follows a day row. */
function readReportedMinutes(dayRow: Element): ReportedMinutes | null {
  const detailRow = dayRow.nextElementSibling;
  if (!detailRow?.querySelector("td.cdk-column-expandedDetail")) return null;
  const reported: ReportedMinutes = { lateness: 0, shortness: 0, outside: 0 };
  for (const tr of Array.from(detailRow.querySelectorAll("table.detail-table tr"))) {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 2) continue;
    const label = normalizeLabel(cells[0].textContent ?? "");
    const match = REPORTED_LABELS.find(([, labels]) => labels.some((l) => normalizeLabel(l) === label));
    if (match) reported[match[0]] += Number(textOf(cells[1])) || 0;
  }
  return reported;
}

/**
 * First sign-in and last sign-out from the "Time in | Time out" punch list in the detail row.
 * Used when the main row has no times (e.g. half-day leave days).
 */
function readPunches(dayRow: Element): { clockIn: Minutes | null; clockOut: Minutes | null } {
  const ins: Minutes[] = [];
  const outs: Minutes[] = [];
  const detailRow = dayRow.nextElementSibling;
  if (detailRow?.querySelector("td.cdk-column-expandedDetail")) {
    for (const tr of Array.from(detailRow.querySelectorAll("table.detail-table tr"))) {
      const cells = tr.querySelectorAll("td");
      if (cells.length !== 2) continue;
      const clockIn = parseClock(textOf(cells[0]));
      const clockOut = parseClock(textOf(cells[1]));
      if (clockIn !== null) ins.push(clockIn);
      if (clockOut !== null) outs.push(clockOut);
    }
  }
  return {
    clockIn: ins.length ? Math.min(...ins) : null,
    clockOut: outs.length ? Math.max(...outs) : null,
  };
}

/** Reads the attendance table from the HR "Attendance Report" page. */
export function parseAttendancePage(root: ParentNode): ParseResult {
  const rows = Array.from(root.querySelectorAll("tr")).filter((tr) =>
    tr.querySelector(":scope > td.cdk-column-Day"),
  );

  const days: RawDay[] = [];
  let arabicDates = 0;
  for (const row of rows) {
    const cell = (column: string) => row.querySelector(`:scope > td.cdk-column-${column}`);
    const dateText = textOf(cell("Day"));
    const date = parseDate(dateText);
    if (!date) continue;
    if (/[؀-ۿ]/.test(dateText)) arabicDates++;

    let clockIn = parseClock(textOf(cell("ClockIn")));
    let clockOut = parseClock(textOf(cell("ClockOut")));
    if (clockIn === null && clockOut === null) ({ clockIn, clockOut } = readPunches(row));
    const rowText = Array.from(row.querySelectorAll(":scope > td"))
      .map((td) => td.textContent ?? "")
      .join(" ");

    days.push({
      date,
      dayType: detectDayType(rowText, clockIn !== null),
      clockIn,
      clockOut,
      reported: readReportedMinutes(row),
      netMinutes: parseDuration(textOf(cell("netAttendanceHours"))),
    });
  }

  const lang: Lang = days.length > 0 && arabicDates > days.length / 2 ? "ar" : "en";
  return { lang, days };
}
