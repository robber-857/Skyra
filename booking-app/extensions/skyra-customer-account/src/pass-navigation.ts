type PassNavigationState = { active: boolean; page: number };
export function restoredPassNavigation(state: unknown): PassNavigationState {
  const value =
    state && typeof state === "object"
      ? (state as Record<string, unknown>).skyraPasses
      : null;
  if (!value || typeof value !== "object") return { active: false, page: 1 };
  const saved = value as Record<string, unknown>;
  return {
    active: saved.active === true,
    page:
      Number.isInteger(saved.page) &&
      Number(saved.page) >= 1 &&
      Number(saved.page) <= 100000
        ? Number(saved.page)
        : 1,
  };
}
export function withPassNavigation(
  state: unknown,
  active: boolean,
  page: number,
) {
  return {
    ...(state && typeof state === "object" ? state : {}),
    skyraPasses: { active, page },
  };
}
