import { calculate, type DayResult, type Summary } from "./calculator";
import { STRINGS } from "./i18n";
import type { DayType, Lang, Minutes, Overrides, ParseResult } from "./types";

const app = document.getElementById("app")!;

/** Types the user can pick for a day, in menu order. */
const SELECTABLE_TYPES: DayType[] = [
  "regular",
  "halfDayLeave",
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
let daysOpen = false;
let breakdownOpen = false;

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 125 → "2:05", -5 → "-0:05". */
function hm(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

function clock(minutes: Minutes | null): string {
  return minutes === null ? "–" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
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

function renderStart(lang: Lang, error?: string) {
  setLang(lang);
  const t = STRINGS[lang];
  const button = el("button", { className: "primary", textContent: t.generate });
  button.addEventListener("click", () => generate(lang));
  app.replaceChildren(
    el("h1", { textContent: t.title }),
    el("p", { className: "muted", textContent: t.intro }),
    button,
    ...(error ? [el("p", { className: "error", textContent: error })] : []),
  );
}

function stat(label: string, minutes: number, lang: Lang, className = "") {
  return el(
    "div",
    { className: `stat ${className}` },
    el("div", { className: "label", textContent: label }),
    el("div", { className: "value" }, el("strong", { textContent: String(minutes) }), ` ${STRINGS[lang].min}`),
    el("div", { className: "sub", textContent: hm(minutes) }),
  );
}

function row(label: string, value: string, className = "") {
  return el("div", { className: `row ${className}` }, el("span", { textContent: label }), el("strong", { textContent: value }));
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
    if (chosen === result.pageType) delete overrides[result.day.date];
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
    el("thead", {}, el("tr", {}, ...t.cols.map((c) => el("th", { textContent: c })))),
    el(
      "tbody",
      {},
      ...summary.days.map((d) => {
        const overridden = d.day.dayType !== d.pageType;
        const counted = d.status === "ok";
        const cells = [
          formatDate(d.day.date, lang),
          clock(d.day.clockIn),
          clock(d.day.clockOut),
          counted || d.status === "absent" ? dash(d.worked) : "–",
          dash(d.lateness),
          dash(d.shortness),
          dash(d.outside),
          dash(d.extra),
        ].map((v) => el("td", { textContent: v }));
        const status = t.status[d.status] + (d.halfDay ? ` (${t.halfDay})` : "");
        return el(
          "tr",
          {
            className: `${d.status}${overridden ? " overridden" : ""}`,
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
  const allowance = summary.charged + summary.remaining;
  const over = summary.remaining < 0;

  const fill = el("div", { className: "fill" });
  fill.style.width = `${Math.min(100, Math.round((summary.charged / allowance) * 100))}%`;

  const stats = el(
    "section",
    { className: "stats" },
    stat(t.statRemaining, summary.remaining, lang, `hero ${over ? "over" : ""}`),
    stat(t.statMakeup, totals.extra, lang),
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
    dayList(t.absent, byStatus("absent"), lang),
    ...(byStatus("missingPunch").length ? [dayList(t.missingPunch, byStatus("missingPunch"), lang)] : []),
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
  const hasOverrides = monthDates.some((d) => d in overrides);
  const reset = el("button", { className: "link", textContent: t.resetOverrides });
  reset.addEventListener("click", async () => {
    for (const date of monthDates) delete overrides[date];
    await saveOverrides();
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

  app.replaceChildren(
    el("h1", { textContent: `${t.title} · ${formatMonth(summary.month, lang)}` }),
    stats,
    usage,
    lists,
    el("section", {}, breakdown),
    el("section", {}, days),
    again,
  );
}

function renderCurrent() {
  if (!parsed) return;
  renderSummary(calculate(parsed.days, localToday(), overrides), parsed.lang);
}

async function generate(fallbackLang: Lang) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no tab");
    // Search every frame: the report may live inside an iframe.
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => (globalThis as any).__attendieRead(),
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
    renderCurrent();
  } catch {
    renderStart(fallbackLang, STRINGS[fallbackLang].cannotRun);
  }
}

renderStart(navigator.language.startsWith("ar") ? "ar" : "en");
