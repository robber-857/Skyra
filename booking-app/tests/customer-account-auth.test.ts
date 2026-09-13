import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  shop: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { customerAccount: mocks.auth } },
}));
vi.mock("../app/db.server", () => ({
  default: { shop: { findUnique: mocks.shop } },
}));
import {
  customerTokenContext,
  customerAccountRequest,
} from "../app/services/customer-account-auth.server";
const now = Math.floor(Date.now() / 1000);
const valid = {
  aud: "app-client",
  sub: "gid://shopify/Customer/123",
  dest: "studio.myshopify.com",
  iss: "https://shopify.com/customer-account",
  iat: now - 5,
  nbf: now - 5,
  exp: now + 60,
};
beforeEach(() => {
  vi.resetAllMocks();
  process.env.SHOPIFY_API_KEY = "app-client";
  mocks.auth.mockResolvedValue({
    sessionToken: valid,
    cors: (r: Response) => {
      r.headers.set("Access-Control-Allow-Origin", "*");
      return r;
    },
  });
  mocks.shop.mockResolvedValue({ id: "shop-id", status: "ACTIVE" });
  mocks.run.mockResolvedValue({ bookings: [] });
});
test("valid verified account claims bind exact store and customer", () => {
  expect(customerTokenContext(valid, "app-client", now)).toEqual({
    domain: "studio.myshopify.com",
    customerGid: valid.sub,
  });
});
test.each([
  { aud: "another-app" },
  { sub: undefined },
  { sub: "gid://shopify/Order/123" },
  { exp: now },
  { iat: now + 120 },
  { nbf: now + 120 },
  { dest: "https://studio.myshopify.com.evil.test" },
  { dest: "http://studio.myshopify.com" },
  { dest: "https://studio.myshopify.com/?shop=other" },
  { iss: "https://evil.test" },
])("reject invalid account claims %j", (patch) => {
  expect(() =>
    customerTokenContext({ ...valid, ...patch }, "app-client", now),
  ).toThrow();
});
test("verified GET passes only signed identity and disables response caching", async () => {
  const r = await customerAccountRequest(
    new Request("https://app.example/api/customer-bookings?view=passes"),
    mocks.run,
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("Cache-Control")).toContain("no-store");
  expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(mocks.run).toHaveBeenCalledWith(
    { shopId: "shop-id", customerGid: valid.sub },
    { view: "passes" },
  );
});
test("authentication failure cannot reach database or handler", async () => {
  const denied = new Response("", { status: 401 });
  mocks.auth.mockRejectedValue(denied);
  await expect(
    customerAccountRequest(
      new Request("https://app.example/api/customer-bookings"),
      mocks.run,
    ),
  ).rejects.toBe(denied);
  expect(mocks.shop).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});
test("audience mismatch is rejected despite SDK allowing a public extension token", async () => {
  mocks.auth.mockResolvedValue({
    sessionToken: { ...valid, aud: "other-app" },
    cors: (r: Response) => r,
  });
  expect(
    (
      await customerAccountRequest(
        new Request("https://app.example/api/customer-bookings"),
        mocks.run,
      )
    ).status,
  ).toBe(401);
  expect(mocks.run).not.toHaveBeenCalled();
});
test("inactive store cannot access existing customer data", async () => {
  mocks.shop.mockResolvedValue({ id: "shop-id", status: "INACTIVE" });
  expect(
    (
      await customerAccountRequest(
        new Request("https://app.example/api/customer-bookings"),
        mocks.run,
      )
    ).status,
  ).toBe(404);
  expect(mocks.run).not.toHaveBeenCalled();
});
test("mutations require bounded valid JSON and safe errors", async () => {
  for (const [body, type, status] of [
    ["{}", "text/plain", 415],
    ["x".repeat(2049), "application/json", 413],
    ["{", "application/json", 400],
  ] as const) {
    const r = await customerAccountRequest(
      new Request("https://app.example/api/customer-bookings", {
        method: "POST",
        headers: { "Content-Type": type },
        body,
      }),
      mocks.run,
    );
    expect(r.status).toBe(status);
  }
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.run.mockRejectedValue(Error("private database credential"));
  const r = await customerAccountRequest(
    new Request("https://app.example/api/customer-bookings"),
    mocks.run,
  );
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain("credential");
});

test("documented bare host without issuer and HTTPS host both authenticate", () => {
  expect(
    customerTokenContext({ ...valid, iss: undefined }, "app-client", now)
      .domain,
  ).toBe("studio.myshopify.com");
  expect(
    customerTokenContext(
      { ...valid, dest: "https://studio.myshopify.com/" },
      "app-client",
      now,
    ).domain,
  ).toBe("studio.myshopify.com");
});
