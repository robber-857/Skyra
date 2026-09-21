import { expect, test } from "vitest";
import { passActivationWindow } from "../app/services/pass-activation.server";
import { DateTime } from "luxon";
for (const [start, months, end] of [
  ["2026-01-31", 1, "2026-02-28"],
  ["2028-01-31", 1, "2028-02-29"],
  ["2026-09-21", 2, "2026-11-21"],
  ["2026-03-21", 6, "2026-09-21"],
  ["2026-09-21", 10, "2027-07-21"],
  ["2026-09-21", 3, "2026-12-21"],
] as const)
  test(`calendar validity ${start} plus ${months} months`, () => {
    const date = DateTime.fromISO(`${start}T18:00`, {
      zone: "Australia/Sydney",
    });
    const result = passActivationWindow(date.toJSDate(), {
      validityMonths: months,
    });
    expect(
      DateTime.fromJSDate(result.startsAt, {
        zone: "Australia/Sydney",
      }).toISODate(),
    ).toBe(start);
    expect(
      DateTime.fromJSDate(result.expiresAt, {
        zone: "Australia/Sydney",
      }).toISODate(),
    ).toBe(end);
    expect(
      DateTime.fromJSDate(result.expiresAt, { zone: "Australia/Sydney" }).hour,
    ).toBe(0);
  });
test("civil days cross daylight saving without becoming 24-hour intervals", () => {
  const r = passActivationWindow(new Date("2026-10-03T02:00:00Z"), {
    validityDays: 2,
  });
  expect((r.expiresAt.getTime() - r.startsAt.getTime()) / 3600000).toBe(47);
});
