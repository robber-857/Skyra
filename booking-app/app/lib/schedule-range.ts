// Shared Admin selection bounds; these do not create sessions or extend Passes.
export const SCHEDULE_MIN_DATE = "2026-01-01";
export const SCHEDULE_MAX_DATE = "2099-12-31";
export const SCHEDULE_MIN_LOCAL_START = `${SCHEDULE_MIN_DATE}T00:00`;
export const SCHEDULE_MAX_LOCAL_START = `${SCHEDULE_MAX_DATE}T23:59`;

export function isScheduleDateInRange(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < SCHEDULE_MIN_DATE ||
    value > SCHEDULE_MAX_DATE
  )
    return false;
  const day = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value
  );
}
