// Calendar-month terms are shared by Admin, checkout and provider verification.
export function supportsRenewalPeriod(
  months: number | null | undefined,
): months is number {
  return Number.isInteger(months) && months! >= 1 && months! <= 120;
}
