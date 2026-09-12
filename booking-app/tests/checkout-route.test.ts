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
vi.mock("../app/services/booking-checkout.server", () => ({
  prepareBookingCheckout: mocks.prepare,
}));
import { action, loader } from "../app/routes/apps.skyra-booking.checkout";
import type { ActionFunctionArgs } from "react-router";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({});
  mocks.shop.mockResolvedValue({ id: "shop-id", status: "ACTIVE" });
});
function post(customer = "123", headers: Record<string, string> = {}) {
  const request = new Request(
    "https://app.example/apps/skyra-booking/checkout?shop=dev.myshopify.com&logged_in_customer_id=" +
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
test("public Checkout remains disabled even for a signed logged-in buyer", async () => {
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "CHECKOUT_NOT_AVAILABLE",
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(mocks.prepare).not.toHaveBeenCalled();
});
test("anonymous checkout cannot authenticate using a request body", async () => {
  expect((await post("")).status).toBe(401);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
test("cross-site checkout and unsigned requests are rejected", async () => {
  expect((await post("123", { "Sec-Fetch-Site": "cross-site" })).status).toBe(
    403,
  );
  const denied = new Response("", { status: 401 });
  mocks.auth.mockRejectedValue(denied);
  await expect(post()).rejects.toBe(denied);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
test("GET cannot create carts", async () => {
  expect(loader().status).toBe(405);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
