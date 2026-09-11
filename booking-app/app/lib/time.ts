import { DateTime } from "luxon";
import { DomainError } from "./errors.server";
export function localInstant(value: string, zone: string) {
  const date = DateTime.fromISO(value, { zone });
  if (
    !date.isValid ||
    date.toFormat("yyyy-MM-dd'T'HH:mm") !== value ||
    date.getPossibleOffsets().length !== 1
  )
    throw new DomainError(
      "INVALID_LOCAL_TIME",
      "Choose a valid, unambiguous local time (daylight saving transition).",
    );
  return date.toJSDate();
}
export function weekRange(day: string, zone: string) {
  const parsed = DateTime.fromISO(day, { zone });
  if (!parsed.isValid)
    throw new DomainError("INVALID_DATE", "Choose a valid week.");
  const start = parsed.startOf("week");
  return {
    start: start.toJSDate(),
    end: start.plus({ weeks: 1 }).toJSDate(),
    label: start.toISODate()!,
  };
}
