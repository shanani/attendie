# Attendie

Chrome extension that reads your HR **Attendance Report** page (Arabic or English) and shows how much of your monthly allowance is left. It only reads the page; it never changes it.

## Install

1. Download **[attendie-extension.zip](https://github.com/shanani/attendie/releases/latest/download/attendie-extension.zip)** (the latest release) and unzip it into a folder you keep.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder (the one with `manifest.json`).
4. Open your HR Attendance Report page, pick the month, click the extension icon, then press **Generate summary**.

To update, replace the folder's contents with the new zip and press the reload icon on the extension card.

Every push to `main` builds, tests and publishes a new release (`.github/workflows/release.yml`).

### Build it yourself

```bash
npm install
npm run build
```

Then load the `dist` folder as above.

## What the popup shows

- **Remaining this month**: allowance minutes left (negative means you are over).
- **Make-up balance**: the month's make-up pool after deducting every day's shortness and outside time (earned − shortness − outside). A short day lowers it; negative means the allowance is being used.
- **Total lateness**: minutes arriving after 9:00.
- **Lateness + shortness/outside**: all missing time before any make-up is applied.
- **Needs justification**: the minutes past the 8-hour allowance. With lateness over 8 hours that is (lateness − 8h) + shortness/outside not covered by make-up (leftover make-up never reduces the lateness part); otherwise it is lateness + uncovered shortness/outside − 8h. Green at 0.
- **Absent days** in red: the total and each date with its reason.
- **Days to check with the security gate report** in orange: a sign-in without a sign-out (or the reverse), one punch (in and out a few minutes apart), or an unpaired punch in the day's punch list.
- **Today** is excluded by default because it is not over yet; to count it, change its type in the day table. Later days are not counted.
- A day-by-day table with a **Net** column per day: make-up − shortness − outside (e.g. −0:58 for a day with 108 min outside and 50 min make-up). Make-up is a monthly pool, so a negative day is first paid from other days' left-over make-up; only what is still missing is charged to the allowance.

**Export to Excel** downloads the month as `attendance-YYYY-MM.xlsx` for checking by hand:

- **Summary** sheet: every total as a formula over the Days sheet, next to the extension's value and the difference (should be 0), plus the rules.
- **Days** sheet: one row per day with real Excel dates and times, a `Counted (1/0)` column you can change to see the totals update, an `Out − In` formula column, the reason for any absence, and the same red (absent) / orange (check gate report) colours.

In the day table you can also **change a day's sign-in/out** (click the time): correct a wrong punch, fill a missing one, or plan ahead, e.g. set today's sign-out to see the effect before you leave. Setting times on today or a later day counts that day. Edited days are calculated from your times (not HR's per-day minutes) and marked "times changed by you"; the gate-report flag still follows the page's real punches.

In the day table you can change any day's type (for example mark a day as vacation, half-day leave, or **Excluded**). The popup recalculates right away. Your changes are saved in the extension, per date, and can be reset for the month.

## Settings (Ramadan)

Click ⚙ in the popup (or right-click the icon → Options) to set:

- **Monthly allowance** (default 8 hours).
- **Regular shift** and **Ramadan shift**: earliest entry, latest entry, working hours, and until when make-up counts. Defaults: regular 7:00–9:00 entry, 8 hours, make-up until 18:00; Ramadan 10:00–12:00 entry, 5 hours (exit 15:00–17:00), make-up until 18:00.
- **Which days are Ramadan**: on a working day (normal or half day), a "Shift Type" of `Regular` / `منتظم` means the regular shift and **any other name** means Ramadan (the regular names are editable; matching ignores case, spaces and Arabic spelling variants). Weekends, vacations, holidays, WFH and training are not judged by their shift name. Days without a shift name (half days) take the nearest working day's shift. Optional Ramadan dates make every day between them Ramadan.

Half days and the absent threshold follow the day's shift: a half day is half the hours, and a full day under half the hours is absent (4:00 regular, 2:30 Ramadan).

## Rules

Defaults live in `src/settings.ts` (`DEFAULT_SETTINGS`); the calculation is in `src/calculator.ts`. The times below are the regular shift's.

- Weekends, holidays, work from home, annual vacation and training are excluded.
- Today is excluded by default (its sign-out is not final); later days are not counted.
- Flexible entry 7:00–9:00; required 8h. Arriving after 9:00 is **lateness** and you still have to stay until 17:00.
- Time before 7:00 and after 18:00 does not count.
- Leaving before entry + 8h is **shortness**; "Out of STC" minutes are **outside** time.
- Lateness and shortness use HR's own per-day minutes from the day's detail whenever the page lists them (HR counts seconds and has a short grace period, so its numbers are exact); they are calculated from the times only when HR lists none, or when you changed the day's type.
- Time after entry + 8h (up to 18:00) is **extra** (make-up). It stays within the month.
- Extra covers shortness and outside time only, never lateness.
- **Remaining** is one balance for everything: allowance − lateness (lateness has priority), plus left-over make-up, or minus shortness/outside that make-up did not cover. So every short day lowers it. Left-over make-up never offsets lateness above the allowance.
- **Absent** (not counted, shown in red with the total and the reason), on normal and half days only:
  - a missing sign-in or sign-out, or no sign-in/out at all;
  - under 4h of work on a normal day (half days have no 4-hour minimum).
- Half-day leave requires 4h, and the vacation part never counts as make-up:
  - **Morning leave** (work in the afternoon): entry 11:00–13:00, only 11:00–18:00 counts.
  - **Evening leave** (work in the morning): entry 7:00–9:00, only 7:00–13:00 counts.
  - The page does not say which half was the leave. With times, arriving at 10:00 or later means morning leave, earlier means evening leave. You can also pick it in the day's **Type** dropdown.
- Normal days use the in/out/total time from their main row. Half-day leave days show no times there; their times are only in the day's punch list, which the page loads when the row is opened. So on **Generate summary** the extension opens each past half day, reads the times, and closes it again. A day still without times is absent.

## Icon

`static/icons/icon.svg` (and a simpler `icon-small.svg` for 16/32 px). After editing, regenerate the PNGs with `node scripts/icons.mjs` (needs Playwright).

## Development

```bash
npm test          # parser + rules tests against real sample pages in tests/fixtures
npm run typecheck
npm run watch     # rebuild on change
```
