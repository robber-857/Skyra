import { DateTime } from "luxon";
import { DomainError } from "../lib/errors.server";

// Sydney civil dates: clamped calendar months, preserving DST transitions.
// The end is exclusive; neither purchasing nor cancellation changes this window.
export function passActivationWindow(
  sessionStartsAt: Date,
  terms: {
    validityDays?: number | null;
    validityMonths?: number | null;
    activationTimezone?: string;
  },
) {
  const start = DateTime.fromJSDate(sessionStartsAt, {
    zone: terms.activationTimezone || "Australia/Sydney",
  }).startOf("day");
  const value = terms.validityMonths ?? terms.validityDays;
  if (!start.isValid || !value || !Number.isInteger(value) || value < 1)
    throw new DomainError(
      "INVALID_PASS_TERMS",
      "Pass validity is missing or invalid.",
    );
  const end = start.plus(
    terms.validityMonths != null ? { months: value } : { days: value },
  );
  if (!end.isValid || end.toMillis() <= sessionStartsAt.getTime())
    throw new DomainError(
      "INVALID_PASS_TERMS",
      "Pass expiry must follow its first class.",
    );
  return { startsAt: start.toJSDate(), expiresAt: end.toJSDate() };
}
