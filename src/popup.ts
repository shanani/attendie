import { calculate, type DayResult, type Summary } from "./calculator";
import { attendanceWorkbook } from "./export";
import { clock, halfDayNote, hm } from "./format";
import { STRINGS } from "./i18n";
import { loadSettings, type Settings } from "./settings";
import type { DayType, Lang, Minutes, Overrides, ParseResult, TimeEdits } from "./types";

const app = document.getElementById("app")!;

/** Types the user can pick for a day, in menu order. */
const SELECTABLE_TYPES: DayType[] = [
  "regular",
  "halfDayLeave",
  "halfDayMorning",
  "halfDayEvening",
  "annualVacation",
  "wfh",
  "training",
  "holiday",
  "weekend",
  "excluded",
];

/** State of the current summary, kept so a day-type change can recalculate without re-reading the page. */
let parsed: ParseResult | null = null;
let overrides: Overrides = {};
let timeEdits: TimeEdits = {};
let settings: Settings | null = null;
let daysOpen = false;
let breakdownOpen = false;

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dash(minutes: number): string {
  return minutes ? hm(minutes) : "–";
}

function formatDate(iso: string, lang: Lang): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { day: "numeric", month: "short" });
}

function formatMonth(month: string, lang: Lang): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { month: "long", year: "numeric" });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function setLang(lang: Lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}

async function loadOverrides(): Promise<Overrides> {
  const stored = await chrome.storage.local.get("overrides");
  return (stored.overrides as Overrides | undefined) ?? {};
}

async function saveOverrides() {
  await chrome.storage.local.set({ overrides });
}

async function loadTimeEdits(): Promise<TimeEdits> {
  const stored = await chrome.storage.local.get("timeEdits");
  return (stored.timeEdits as TimeEdits | undefined) ?? {};
}

async function saveTimeEdits() {
  await chrome.storage.local.set({ timeEdits });
}

const toMinutes = (value: string): Minutes | null => {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Sign-in and sign-out as editable time fields. Changing either one (or filling a missing one)
 * recalculates with the new times; setting them back to the page's times removes the edit.
 */
function timeInputs(d: DayResult, lang: Lang): [HTMLTableCellElement, HTMLTableCellElement] {
  const t = STRINGS[lang];
  // Weekends, vacations etc. with no punches have nothing to edit.
  if (d.status === "excluded" && !d.todayDefault && !d.pageTimes && d.day.clockIn === null && d.day.clockOut === null) {
    return [el("td", { textContent: "–" }), el("td", { textContent: "–" })];
  }
  const page = d.pageTimes ?? { clockIn: d.day.clockIn, clockOut: d.day.clockOut };
  const make = (value: Minutes | null, pageValue: Minutes | null) => {
    const input = el("input", { type: "time", className: "time", value: value === null ? "" : clock(value) });
    const changed = d.pageTimes !== undefined && value !== pageValue;
    if (changed) {
      input.classList.add("edited");
      input.title = t.pageTime.replace("{0}", clock(pageValue));
    }
    return input;
  };
  const inInput = make(d.day.clockIn, page.clockIn);
  const outInput = make(d.day.clockOut, page.clockOut);
  const save = async () => {
    const next = { clockIn: toMinutes(inInput.value), clockOut: toMinutes(outInput.value) };
    if (next.clockIn === page.clockIn && next.clockOut === page.clockOut) delete timeEdits[d.day.date];
    else timeEdits[d.day.date] = next;
    await saveTimeEdits();
    renderCurrent();
  };
  inInput.addEventListener("change", save);
  outInput.addEventListener("change", save);
  return [el("td", {}, inInput), el("td", {}, outInput)];
}

/** Title row with a link to the settings page. */
function header(title: string, lang: Lang) {
  const settingsLink = el("button", { className: "icon", title: STRINGS[lang].settings, textContent: "⚙" });
  settingsLink.setAttribute("aria-label", STRINGS[lang].settings);
  settingsLink.addEventListener("click", () => chrome.runtime.openOptionsPage());
  return el("div", { className: "header" }, el("h1", { textContent: title }), settingsLink);
}

function renderStart(lang: Lang, error?: string) {
  setLang(lang);
  const t = STRINGS[lang];
  const button = el("button", { className: "primary", textContent: t.generate });
  button.addEventListener("click", () => generate(lang));
  app.replaceChildren(
    header(t.title, lang),
    el("p", { className: "muted", textContent: t.intro }),
    button,
    ...(error ? [el("p", { className: "error", textContent: error })] : []),
  );
}

function stat(label: string, minutes: number, lang: Lang, className = "", sub = hm(minutes)) {
  return el(
    "div",
    { className: `stat ${className}` },
    el("div", { className: "label", textContent: label }),
    el("div", { className: "value" }, el("strong", { textContent: String(minutes) }), ` ${STRINGS[lang].min}`),
    el("div", { className: "sub", textContent: sub }),
  );
}

function row(label: string, value: string, className = "") {
  return el("div", { className: `row ${className}` }, el("span", { textContent: label }), el("strong", { textContent: value }));
}

function absentReason(d: DayResult, lang: Lang): string {
  return d.absentReason ? STRINGS[lang].absentReason[d.absentReason].replace("{0}", hm(d.worked)) : "";
}

/** Red summary of absent days: the total, then each date with why it is absent. */
function absentBlock(days: DayResult[], lang: Lang) {
  const t = STRINGS[lang];
  const sep = lang === "ar" ? "، " : ", ";
  return el(
    "div",
    { className: `absent-block ${days.length ? "has-absent" : ""}` },
    el("div", { className: "row" }, el("span", { textContent: t.absentDays }), el("strong", { textContent: String(days.length) })),
    ...(days.length
      ? [el("div", { textContent: days.map((d) => `${formatDate(d.day.date, lang)} (${absentReason(d, lang)})`).join(sep) })]
      : []),
    el("div", { className: "small note", textContent: t.absentNote }),
  );
}

/** Green when nothing needs justifying; otherwise the minutes to justify and where they come from. */
function justifyTile(summary: Summary, lang: Lang) {
  const t = STRINGS[lang];
  const { total, latenessOver, notMadeUp } = summary.justification;
  if (total === 0) {
    return el(
      "section",
      { className: "justify ok" },
      el("div", { className: "row" }, el("span", { textContent: `✓ ${t.justifyTitle}` }), el("strong", { textContent: `0 ${t.min}` })),
      el("div", { className: "small", textContent: t.justifyNone }),
    );
  }
  return el(
    "section",
    { className: "justify due" },
    el(
      "div",
      { className: "row" },
      el("span", { textContent: `⚠ ${t.justifyTitle}` }),
      el("strong", { textContent: `${total} ${t.min} · ${hm(total)}` }),
    ),
    el("div", {
      className: "small",
      textContent: latenessOver
        ? t.justifyOver.replace("{0}", String(latenessOver)).replace("{1}", String(notMadeUp))
        : t.justifyWithin.replace("{0}", String(summary.totals.lateness)).replace("{1}", String(notMadeUp)),
    }),
  );
}

/** Orange list of days whose sign-in/out should be checked with the security gate report. */
function gateBlock(days: DayResult[], lang: Lang) {
  const t = STRINGS[lang];
  const sep = lang === "ar" ? "، " : ", ";
  return el(
    "div",
    { className: "gate-block" },
    el("div", { className: "row" }, el("span", { textContent: `⚠ ${t.gateDays}` }), el("strong", { textContent: String(days.length) })),
    el("div", { textContent: days.map((d) => `${formatDate(d.day.date, lang)} (${t.punchProblem[d.punchProblem!]})`).join(sep) }),
    el("div", { className: "small note", textContent: t.gateNote }),
  );
}

function downloadExcel(summary: Summary, lang: Lang, settings: Settings) {
  const blob = new Blob([attendanceWorkbook(summary, lang, settings) as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `attendance-${summary.month}.xlsx` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function dayList(title: string, days: DayResult[], lang: Lang) {
  const text = days.length
    ? days.map((d) => formatDate(d.day.date, lang)).join(lang === "ar" ? "، " : ", ")
    : STRINGS[lang].none;
  return el("div", { className: "list" }, el("span", { className: "muted", textContent: title }), el("div", { textContent: text }));
}

function typeSelect(result: DayResult, lang: Lang) {
  const t = STRINGS[lang];
  const types = SELECTABLE_TYPES.includes(result.pageType) ? SELECTABLE_TYPES : [result.pageType, ...SELECTABLE_TYPES];
  const select = el(
    "select",
    {},
    ...types.map((type) => el("option", { value: type, textContent: t.dayTypes[type], selected: type === result.day.dayType })),
  );
  select.addEventListener("change", async () => {
    const chosen = select.value as DayType;
    // Today defaults to excluded, so any other choice for it has to be remembered.
    const defaultType = result.day.date === localToday() ? "excluded" : result.pageType;
    if (chosen === defaultType) delete overrides[result.day.date];
    else overrides[result.day.date] = chosen;
    await saveOverrides();
    renderCurrent();
  });
  return select;
}

function daysTable(summary: Summary, lang: Lang) {
  const t = STRINGS[lang];
  return el(
    "table",
    {},
    el("thead", {}, el("tr", {}, ...t.cols.map((c, i) => el("th", { textContent: c, title: i === 8 ? t.netHelp : "" })))),
    el(
      "tbody",
      {},
      ...summary.days.map((d) => {
        const overridden = d.day.dayType !== d.pageType && !d.todayDefault;
        const counted = d.status === "ok";
        const cells = [
          formatDate(d.day.date, lang),
          // The page's own Total Hours, so it matches HR (the calculation still stops counting at the make-up time).
          counted || d.absentReason === "underMinimum" ? dash(d.day.netMinutes ?? d.worked) : "–",
          dash(d.lateness),
          dash(d.shortness),
          dash(d.outside),
          dash(d.extra),
        ].map((v) => el("td", { textContent: v }));
        cells.splice(1, 0, ...timeInputs(d, lang));
        // The day's own make-up minus its shortness/outside, e.g. −0:58 for a day 108 min outside with 50 min make-up.
        const net = d.extra - d.shortness - d.outside;
        cells.push(
          el("td", {
            className: `net ${net < 0 ? "neg" : net > 0 ? "pos" : ""}`,
            textContent: counted && (d.extra || d.shortness || d.outside) ? `${net > 0 ? "+" : net < 0 ? "−" : ""}${hm(Math.abs(net))}` : "–",
          }),
        );
        const note = [
          d.shift === "ramadan" && `🌙 ${t.shiftNames.ramadan}`,
          halfDayNote(d, lang),
          absentReason(d, lang),
          d.todayDefault && t.excel.todayNote,
          d.pageTimes && t.timesEdited,
        ]
          .filter(Boolean)
          .join(" · ");
        const status = (d.punchProblem ? "⚠ " : "") + t.status[d.status] + (note ? ` (${note})` : "");
        return el(
          "tr",
          {
            className: `${d.status}${overridden ? " overridden" : ""}${d.punchProblem ? " problem" : ""}`,
            title: overridden ? t.overridden.replace("{0}", t.dayTypes[d.pageType]) : "",
          },
          ...cells,
          el("td", {}, typeSelect(d, lang)),
          el("td", { textContent: status }),
        );
      }),
    ),
  );
}

function renderSummary(summary: Summary, lang: Lang) {
  setLang(lang);
  const t = STRINGS[lang];
  const { totals } = summary;
  const allowance = summary.allowance;
  const over = summary.remaining < 0;

  const fill = el("div", { className: "fill" });
  fill.style.width = `${Math.min(100, Math.round((summary.charged / allowance) * 100))}%`;

  const stats = el(
    "section",
    { className: "stats" },
    stat(t.statRemaining, summary.remaining, lang, `hero ${over ? "over" : ""}`),
    // The month's make-up pool after every day's shortness/outside is deducted (e.g. a 7-hour day with
    // 108 min outside and 50 min make-up takes 58 off it). Negative means the allowance is being used.
    stat(
      t.statMakeupBalance,
      totals.extra - totals.shortness - totals.outside,
      lang,
      `makeup ${totals.extra - totals.shortness - totals.outside < 0 ? "neg" : ""}`,
      t.makeupBalanceSub.replace("{0}", String(totals.extra)).replace("{1}", String(totals.shortness + totals.outside)),
    ),
    stat(t.statLateness, totals.lateness, lang),
    stat(t.statLateShort, totals.lateness + totals.shortness + totals.outside, lang),
  );

  const usage = el(
    "section",
    { className: `usage ${over ? "over" : ""}` },
    el("div", { className: "bar" }, fill),
    el("div", {
      className: "muted small",
      textContent: `${hm(summary.charged)} ${t.of} ${hm(allowance)}${over ? ` · ${t.over} ${hm(-summary.remaining)}` : ""}`,
    }),
  );

  const byStatus = (s: DayResult["status"]) => summary.days.filter((d) => d.status === s);
  const lists = el(
    "section",
    {},
    absentBlock(byStatus("absent"), lang),
    ...(summary.problemDays ? [gateBlock(summary.days.filter((d) => d.punchProblem), lang)] : []),
    ...summary.days
      .filter((d) => d.todayDefault)
      .map((d) => el("p", { className: "muted small", textContent: t.todayExcluded.replace("{0}", formatDate(d.day.date, lang)) })),
    ...(byStatus("notCounted").length ? [dayList(t.notCounted, byStatus("notCounted"), lang)] : []),
  );

  const breakdown = el(
    "details",
    { open: breakdownOpen },
    el("summary", { textContent: t.breakdown }),
    row(t.lateness, hm(totals.lateness)),
    row(t.shortness, hm(totals.shortness)),
    row(t.outside, hm(totals.outside)),
    row(t.extra, hm(totals.extra)),
    row(t.extraUsed, `−${hm(summary.extraUsed)}`),
    row(t.charged, hm(summary.charged), "total"),
    row(t.extraLeft, hm(summary.extraLeft), "muted"),
  );
  breakdown.addEventListener("toggle", () => (breakdownOpen = breakdown.open));

  const monthDates = summary.days.map((d) => d.day.date);
  const hasOverrides = monthDates.some((d) => d in overrides || d in timeEdits);
  const reset = el("button", { className: "link", textContent: t.resetOverrides });
  reset.addEventListener("click", async () => {
    for (const date of monthDates) {
      delete overrides[date];
      delete timeEdits[date];
    }
    await saveOverrides();
    await saveTimeEdits();
    renderCurrent();
  });

  const days = el(
    "details",
    { open: daysOpen },
    el("summary", { textContent: t.details }),
    el("div", { className: "scroll" }, daysTable(summary, lang)),
    ...(hasOverrides ? [reset] : []),
  );
  days.addEventListener("toggle", () => (daysOpen = days.open));

  const again = el("button", { className: "secondary", textContent: t.generate });
  again.addEventListener("click", () => generate(lang));
  const exportButton = el("button", { className: "secondary", textContent: `⬇ ${t.exportExcel}` });
  exportButton.addEventListener("click", () => downloadExcel(summary, lang, settings!));

  app.replaceChildren(
    header(`${t.title} · ${formatMonth(summary.month, lang)}`, lang),
    stats,
    justifyTile(summary, lang),
    usage,
    lists,
    el("section", {}, breakdown),
    el("section", {}, days),
    el("div", { className: "actions" }, exportButton, again),
  );
}

function renderCurrent() {
  if (!parsed) return;
  renderSummary(calculate(parsed.days, localToday(), overrides, settings!, timeEdits), parsed.lang);
}

async function generate(fallbackLang: Lang) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no tab");
    // Search every frame: the report may live inside an iframe.
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    app.append(el("p", { className: "muted", textContent: STRINGS[fallbackLang].reading }));
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (today: string) => (globalThis as any).__attendieRead(today),
      args: [localToday()],
    });
    const found = results
      .map((r) => r.result as ParseResult | undefined)
      .find((r) => r && r.days.length > 0);
    if (!found) {
      renderStart(fallbackLang, STRINGS[fallbackLang].notFound);
      return;
    }
    parsed = found;
    overrides = await loadOverrides();
    timeEdits = await loadTimeEdits();
    settings = await loadSettings();
    renderCurrent();
  } catch {
    renderStart(fallbackLang, STRINGS[fallbackLang].cannotRun);
  }
}

renderStart(navigator.language.startsWith("ar") ? "ar" : "en");
