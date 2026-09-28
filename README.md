# Attendie

Chrome extension that reads your HR **Attendance Report** page (Arabic or English) and shows how much of your monthly allowance is left. It only reads the page; it never changes it.

## Install

```bash
npm install
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `dist` folder.
3. Open your HR Attendance Report page, pick the month, click the extension icon, then press **Generate summary**.

After changing code, run `npm run build` again and press the reload icon on the extension card.

## What the popup shows

- **Remaining this month**: allowance minutes left (negative means you are over).
- **Total make-up time**: extra minutes earned (after the 8h day, up to 6 PM).
- **Total lateness**: minutes arriving after 9:00.
- **Lateness + shortness/outside**: all missing time before any make-up is applied.
- Absent days, days not counted yet (today and later), and a day-by-day table.

In the day table you can change any day's type (for example mark a day as vacation, half-day leave, or **Excluded**). The popup recalculates right away. Your changes are saved in the extension, per date, and can be reset for the month.

## Rules

All rules live in `src/calculator.ts` (`DEFAULT_RULES`).

- Weekends, holidays, work from home, annual vacation and training are excluded.
- Today and later days are not counted (sign-out is not final).
- Flexible entry 7:00–9:00; required 8h. Arriving after 9:00 is **lateness** and you still have to stay until 17:00.
- Time before 7:00 and after 18:00 does not count.
- Leaving before entry + 8h is **shortness**; "Out of STC" minutes are **outside** time.
- Time after entry + 8h (up to 18:00) is **extra** (make-up). It stays within the month.
- Extra covers shortness and outside time only, never lateness.
- Whatever is left (lateness + uncovered shortness/outside) is charged to the **8h monthly allowance**.
- Under 4h of work is **absent**: not counted, no make-up. Half-day leave days are exempt.
- Half-day leave requires 4h: entry 7:00–9:00 (work in the morning) or 11:00–13:00 (work in the afternoon). Make-up still counts anywhere between 7:00 and 18:00.
- The HR page shows no sign-in/out times on half-day leave days, so for those days the lateness, shortness and outside minutes HR lists in the day's detail are used as-is (no make-up can be measured).

## Development

```bash
npm test          # parser + rules tests against real sample pages in tests/fixtures
npm run typecheck
npm run watch     # rebuild on change
```
