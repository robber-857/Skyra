import { beforeEach, expect, test, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { DomainError } from "../app/lib/errors.server";

const mocks = vi.hoisted(() => ({ context: vi.fn(), preview: vi.fn() }));
vi.mock("../app/services/context.server", () => ({
  adminContext: mocks.context,
}));
vi.mock("../app/services/booking-notifications.server", () => ({
  previewBookingNotification: mocks.preview,
}));
import { loader } from "../app/routes/app.notifications.$id";

const id = "00000000-0000-4000-8000-000000000001";
function args(notificationId = id): LoaderFunctionArgs {
  return {
    request: new Request(
      `https://example.com/app/notifications/${notificationId}`,
    ),
    params: { id: notificationId },
    url: new URL(`https://example.com/app/notifications/${notificationId}`),
    pattern: "/app/notifications/:id",
    context: {},
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({ actor: { shopId: "authenticated-shop" } });
});

test("preview uses authenticated shop and returns private content", async () => {
  const email = {
    subject: "Class reminder",
    html: "<p>Reminder</p>",
    text: "Reminder",
  };
  mocks.preview.mockResolvedValue(email);
  const result = await loader(args());
  expect(mocks.preview).toHaveBeenCalledWith("authenticated-shop", id);
  expect(result.data).toEqual({ email, error: null });
  expect(result.init?.headers).toEqual({
    "Cache-Control": "private, no-store",
  });
});

test("invalid or inaccessible notifications return readable unavailable states", async () => {
  const invalid = await loader(args("invalid"));
  expect(invalid.init?.status).toBe(404);
  expect(invalid.data.email).toBeNull();
  expect(mocks.preview).not.toHaveBeenCalled();
  mocks.preview.mockRejectedValue(
    new DomainError(
      "NOTIFICATION_NOT_FOUND",
      "Email notification not found.",
      404,
    ),
  );
  const missing = await loader(args());
  expect(missing.init?.status).toBe(404);
  expect(missing.data).toEqual({
    email: null,
    error: "Email notification not found.",
  });
});

test("authentication failures are preserved and cannot expose email content", async () => {
  const unauthorized = new Response("Unauthorized", { status: 401 });
  mocks.context.mockRejectedValue(unauthorized);
  await expect(loader(args())).rejects.toBe(unauthorized);
  expect(mocks.preview).not.toHaveBeenCalled();
});
