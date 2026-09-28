import { clock, hm, timeRange } from "./format";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, shiftWindows, type Settings, type Shift } from "./settings";

const TEXT = {
  en: {
    title: "Attendie settings",
    intro: "Shift times used to calculate lateness, shortness and make-up. Changes apply the next time you press Generate summary.",
    general: "General",
    allowance: "Monthly allowance (hours)",
    regular: "Regular shift",
    ramadan: "Ramadan shift",
    entryFrom: "Earliest entry",
    entryTo: "Latest entry (later is lateness)",
    hours: "Working hours per day",
    makeupUntil: "Make-up counts until",
    derived: "Exit {0} · half day {1} · absent under {2} (half the hours)",
    ramadanDays: "Which days are Ramadan",
    names: "Shift names on the page that mean Ramadan (comma-separated)",
    namesHelp: "Matched against the page's \"Shift Type\" column, e.g. Ramadan, رمضان.",
    from: "Ramadan from (optional)",
    to: "Ramadan to (optional)",
    datesHelp: "If HR still shows \"Regular\" during Ramadan, set the dates and those days use the Ramadan shift.",
    save: "Save",
    reset: "Restore defaults",
    saved: "Saved ✓",
    errEntry: "{0}: latest entry must be after earliest entry.",
    errHours: "{0}: working hours must be more than 0.",
    errMakeup: "{0}: make-up must count until at least the latest exit ({1}).",
    errDates: "Ramadan dates: set both, with 'to' on or after 'from'.",
    errAllowance: "The monthly allowance cannot be negative.",
  },
  ar: {
    title: "إعدادات Attendie",
    intro: "أوقات الدوام المستخدمة لحساب التأخير والتقصير والتعويض. تُطبَّق التغييرات عند الضغط على إنشاء الملخص في المرة القادمة.",
    general: "عام",
    allowance: "الرصيد الشهري (ساعات)",
    regular: "الدوام العادي",
    ramadan: "دوام رمضان",
    entryFrom: "أبكر دخول",
    entryTo: "آخر دخول (بعده تأخير)",
    hours: "ساعات العمل اليومية",
    makeupUntil: "يُحتسب التعويض حتى",
    derived: "الخروج {0} · نصف اليوم {1} · غياب إذا أقل من {2} (نصف الساعات)",
    ramadanDays: "أيام رمضان",
    names: "أسماء الدوام في الصفحة التي تعني رمضان (مفصولة بفواصل)",
    namesHelp: "تُقارن مع عمود \"نوع الدوام\" في الصفحة، مثل Ramadan، رمضان.",
    from: "رمضان من (اختياري)",
    to: "رمضان إلى (اختياري)",
    datesHelp: "إذا بقيت الصفحة تعرض \"منتظم\" في رمضان، حدّد التواريخ لتُحتسب تلك الأيام بدوام رمضان.",
    save: "حفظ",
    reset: "استعادة الافتراضي",
    saved: "تم الحفظ ✓",
    errEntry: "{0}: آخر دخول يجب أن يكون بعد أبكر دخول.",
    errHours: "{0}: ساعات العمل يجب أن تكون أكثر من 0.",
    errMakeup: "{0}: يجب أن يُحتسب التعويض حتى آخر خروج على الأقل ({1}).",
    errDates: "تواريخ رمضان: حدّد التاريخين، و'إلى' في يوم 'من' أو بعده.",
    errAllowance: "لا يمكن أن يكون الرصيد الشهري سالباً.",
  },
};

const lang = navigator.language.startsWith("ar") ? "ar" : "en";
const t = TEXT[lang];
document.documentElement.lang = lang;
document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
document.title = t.title;

const app = document.getElementById("app")!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  node.append(...children);
  return node;
}

const toTimeValue = (m: number) => clock(m);
const fromTimeValue = (v: string) => {
  const [hh, mm] = v.split(":").map(Number);
  return hh * 60 + mm;
};

function field(label: string, input: HTMLInputElement, help?: string) {
  return el("label", { className: "field" }, el("span", { textContent: label }), input, ...(help ? [el("small", { textContent: help })] : []));
}

/** The inputs of one shift, plus a live line showing what they imply. */
function shiftSection(name: "regular" | "ramadan", shift: Shift) {
  const entryFrom = el("input", { type: "time", value: toTimeValue(shift.entryFrom), required: true });
  const entryTo = el("input", { type: "time", value: toTimeValue(shift.entryTo), required: true });
  const hours = el("input", { type: "number", min: "0.5", max: "12", step: "0.25", value: String(shift.hours / 60), required: true });
  const makeupUntil = el("input", { type: "time", value: toTimeValue(shift.makeupUntil), required: true });
  const derived = el("p", { className: "derived" });

  const read = (): Shift => ({
    entryFrom: fromTimeValue(entryFrom.value),
    entryTo: fromTimeValue(entryTo.value),
    hours: Math.round(Number(hours.value) * 60),
    makeupUntil: fromTimeValue(makeupUntil.value),
  });
  const update = () => {
    const s = read();
    if ([s.entryFrom, s.entryTo, s.hours, s.makeupUntil].some(Number.isNaN)) return;
    const w = shiftWindows(s);
    derived.textContent = t.derived
      .replace("{0}", timeRange(s.entryFrom + s.hours, s.entryTo + s.hours))
      .replace("{1}", hm(w.half))
      .replace("{2}", hm(w.minimumWorked));
  };
  for (const input of [entryFrom, entryTo, hours, makeupUntil]) input.addEventListener("input", update);
  update();

  const section = el(
    "fieldset",
    {},
    el("legend", { textContent: t[name] }),
    el("div", { className: "grid" }, field(t.entryFrom, entryFrom), field(t.entryTo, entryTo), field(t.hours, hours), field(t.makeupUntil, makeupUntil)),
    derived,
  );
  return { section, read };
}

function validate(s: Settings): string[] {
  const errors: string[] = [];
  if (!(s.monthlyAllowance >= 0)) errors.push(t.errAllowance);
  for (const name of ["regular", "ramadan"] as const) {
    const shift = s[name];
    if (!(shift.entryTo >= shift.entryFrom)) errors.push(t.errEntry.replace("{0}", t[name]));
    if (!(shift.hours > 0)) errors.push(t.errHours.replace("{0}", t[name]));
    else if (!(shift.makeupUntil >= shift.entryTo + shift.hours))
      errors.push(t.errMakeup.replace("{0}", t[name]).replace("{1}", clock(shift.entryTo + shift.hours)));
  }
  if ((s.ramadanFrom || s.ramadanTo) && !(s.ramadanFrom && s.ramadanTo && s.ramadanTo >= s.ramadanFrom)) errors.push(t.errDates);
  return errors;
}

function render(settings: Settings) {
  const allowance = el("input", { type: "number", min: "0", max: "100", step: "0.25", value: String(settings.monthlyAllowance / 60) });
  const regular = shiftSection("regular", settings.regular);
  const ramadan = shiftSection("ramadan", settings.ramadan);
  const names = el("input", { type: "text", value: settings.ramadanNames.join(", ") });
  const from = el("input", { type: "date", value: settings.ramadanFrom });
  const to = el("input", { type: "date", value: settings.ramadanTo });
  const status = el("p", { className: "status", role: "status" });

  const save = el("button", { type: "submit", className: "primary", textContent: t.save });
  const reset = el("button", { type: "button", className: "secondary", textContent: t.reset });
  reset.addEventListener("click", async () => {
    await saveSettings(DEFAULT_SETTINGS);
    render(DEFAULT_SETTINGS);
    showStatus(t.saved);
  });

  const form = el(
    "form",
    {},
    el("fieldset", {}, el("legend", { textContent: t.general }), el("div", { className: "grid" }, field(t.allowance, allowance))),
    regular.section,
    ramadan.section,
    el(
      "fieldset",
      {},
      el("legend", { textContent: t.ramadanDays }),
      field(t.names, names, t.namesHelp),
      el("div", { className: "grid" }, field(t.from, from), field(t.to, to)),
      el("small", { textContent: t.datesHelp }),
    ),
    el("div", { className: "actions" }, save, reset),
    status,
  );

  function showStatus(message: string, error = false) {
    status.textContent = message;
    status.className = `status${error ? " error" : ""}`;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const next: Settings = {
      ...settings,
      monthlyAllowance: Math.round(Number(allowance.value) * 60),
      regular: regular.read(),
      ramadan: ramadan.read(),
      ramadanNames: names.value.split(/[,،]/).map((n) => n.trim()).filter(Boolean),
      ramadanFrom: from.value,
      ramadanTo: to.value,
    };
    const errors = validate(next);
    if (errors.length) return showStatus(errors.join(" "), true);
    await saveSettings(next);
    settings = next;
    showStatus(t.saved);
  });

  app.replaceChildren(el("h1", { textContent: t.title }), el("p", { className: "muted", textContent: t.intro }), form);
}

loadSettings().then(render);
