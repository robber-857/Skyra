import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  shop: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { appProxy: mocks.auth } },
  unauthenticated: {},
}));
vi.mock("../app/db.server", () => ({
  default: { shop: { findUnique: mocks.shop } },
}));
vi.mock("../app/services/owned-booking.server", () => ({
  confirmOwnedBooking: mocks.prepare,
}));
import { action, loader } from "../app/routes/apps.skyra-booking.confirm";
import type { ActionFunctionArgs } from "react-router";
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({});
  mocks.shop.mockResolvedValue({
    id: "shop-id",
    domain: "skyra-booking-dev.myshopify.com",
    status: "ACTIVE",
  });
  mocks.prepare.mockResolvedValue({ status: "CONFIRMED" });
});
function post(customer = "123", headers: Record<string, string> = {}) {
  const request = new Request(
    "https://app.example/apps/skyra-booking/confirmation?shop=skyra-booking-dev.myshopify.com&logged_in_customer_id=" +
      customer,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Skyra-Booking": "1",
        ...headers,
      },
      body: "{}",
    },
  );
  return action({ request } as ActionFunctionArgs);
}
test("public owned Pass confirmation remains disabled even for a signed logged-in buyer", async () => {
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "BOOKING_NOT_AVAILABLE",
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(mocks.prepare).not.toHaveBeenCalled();
});
test("the exact development shop can open owned-Pass booking with an explicit gate", async () => {
  vi.stubEnv("SKYRA_BOOKING_TEST_SHOP", "skyra-booking-dev.myshopify.com");
  vi.stubEnv("SKYRA_BOOKING_OWNED_PASSES_ENABLED", "true");
  const response = await post();
  expect(response.status).toBe(200);
  expect(mocks.prepare).toHaveBeenCalledOnce();
});
test("anonymous confirmation cannot authenticate using a request body", async () => {
  expect((await post("")).status).toBe(401);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
test("cross-site confirmation and unsigned requests are rejected", async () => {
  expect((await post("123", { "Sec-Fetch-Site": "cross-site" })).status).toBe(
    403,
  );
  const denied = new Response("", { status: 401 });
  mocks.auth.mockRejectedValue(denied);
  await expect(post()).rejects.toBe(denied);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
test("GET cannot create bookings", async () => {
  expect(loader().status).toBe(405);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
