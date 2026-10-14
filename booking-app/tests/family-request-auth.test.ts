import { beforeEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DomainError } from "../app/lib/errors.server";
const mocks = vi.hoisted(() => ({ proxy: vi.fn(), account: vi.fn(), shop: vi.fn(), resolve: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ authenticate: { public: { appProxy: mocks.proxy, customerAccount: mocks.account } } }));
vi.mock("../app/db.server", () => ({ default: { shop: { findUnique: mocks.shop } } }));
vi.mock("../app/services/family-accounts.server", () => ({ resolveFamilyActor: mocks.resolve }));
import { bookingRequest } from "../app/services/booking-proxy.server";
import { customerAccountRequest } from "../app/services/customer-account-auth.server";

const memberId = randomUUID();
const signed = { shopId: "shop", customerGid: "gid://shopify/Customer/123" };
const selected = { ...signed, customerGid: "gid://shopify/Customer/456", accountCustomerGid: signed.customerGid };
beforeEach(() => {
  vi.resetAllMocks();
  process.env.SHOPIFY_API_KEY = "app-client";
  mocks.proxy.mockResolvedValue({});
  mocks.shop.mockResolvedValue({ id: "shop", status: "ACTIVE" });
  const now = Math.floor(Date.now() / 1000);
  mocks.account.mockResolvedValue({ sessionToken: { aud: "app-client", sub: signed.customerGid, dest: "studio.myshopify.com", iat: now - 5, nbf: now - 5, exp: now + 60 }, cors: (r: Response) => r });
  mocks.resolve.mockResolvedValue(selected);
});
const proxyRequest = (body: unknown) => new Request("https://app.test/start?shop=studio.myshopify.com&logged_in_customer_id=123", { method: "POST", headers: { "Content-Type": "application/json", "X-Skyra-Booking": "1" }, body: JSON.stringify(body) });

test("proxy resolves member only after Shopify verification and strips selection from the domain input", async () => {
  const run = vi.fn(async () => ({ ok: true }));
  expect((await bookingRequest(proxyRequest({ familyMemberId: memberId, token: "token" }), run)).status).toBe(200);
  expect(mocks.resolve).toHaveBeenCalledWith(signed, memberId);
  expect(run).toHaveBeenCalledWith(selected, { token: "token" });
  expect(mocks.proxy.mock.invocationCallOrder[0]).toBeLessThan(mocks.resolve.mock.invocationCallOrder[0]);
});
test("Customer Account GET and POST use the signed guardian for family authorization", async () => {
  const run = vi.fn(async () => ({ ok: true }));
  await customerAccountRequest(new Request(`https://app.test/api/customer-bookings?familyMemberId=${memberId}&view=passes`), run);
  expect(run).toHaveBeenLastCalledWith(selected, { view: "passes" });
  await customerAccountRequest(new Request("https://app.test/api/customer-bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ familyMemberId: memberId, action: "CANCEL" }) }), run);
  expect(run).toHaveBeenLastCalledWith(selected, { action: "CANCEL" });
});
test("forbidden families, malformed selection and duplicate selection cannot reach handlers", async () => {
  const run = vi.fn(async () => ({}));
  mocks.resolve.mockRejectedValue(new DomainError("FORBIDDEN", "Not your family.", 403));
  expect((await bookingRequest(proxyRequest({ familyMemberId: memberId }), run)).status).toBe(403);
  expect((await bookingRequest(proxyRequest({ familyMemberId: "not-a-uuid" }), run)).status).toBe(400);
  expect((await customerAccountRequest(new Request(`https://app.test/api/customer-bookings?familyMemberId=${memberId}&familyMemberId=${memberId}`), run)).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});
test("family creation stays bound to the signed account and cannot select another member", async () => {
  const run = vi.fn(async () => ({}));
  expect((await bookingRequest(proxyRequest({ familyMemberId: memberId }), run, 2048, false)).status).toBe(400);
  expect((await customerAccountRequest(new Request(`https://app.test/api/customer-family?familyMemberId=${memberId}`), run, { resolveMember: false })).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
  expect(mocks.resolve).not.toHaveBeenCalled();
});
