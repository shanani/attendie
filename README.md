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
- **Absent days** in red: the total and each date with its reason. Also days not counted yet (today and later), and a day-by-day table.

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
- **Absent** (not counted, shown in red with the total and the reason), on normal and half days only:
  - a missing sign-in or sign-out, or no sign-in/out at all;
  - under 4h of work on a normal day (half days have no 4-hour minimum).
- Half-day leave requires 4h, and the vacation part never counts as make-up:
  - **Morning leave** (work in the afternoon): entry 11:00–13:00, only 11:00–18:00 counts.
  - **Evening leave** (work in the morning): entry 7:00–9:00, only 7:00–13:00 counts.
  - The page does not say which half was the leave. With times, arriving at 10:00 or later means morning leave, earlier means evening leave. You can also pick it in the day's **Type** dropdown.
- Normal days use the in/out/total time from their main row. Half-day leave days show no times there; their times are only in the day's punch list, which the page loads when the row is opened. So on **Generate summary** the extension opens each past half day, reads the times, and closes it again. A day still without times is absent.

## Development

```bash
npm test          # parser + rules tests against real sample pages in tests/fixtures
npm run typecheck
npm run watch     # rebuild on change
```
