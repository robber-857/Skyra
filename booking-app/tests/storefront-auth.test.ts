import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), findShop: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ authenticate: { public: { appProxy: mocks.authenticate } } }));
vi.mock("../app/db.server", () => ({ default: { shop: { findUnique: mocks.findShop } } }));
import { loader } from "../app/routes/apps.skyra-booking.auth";

const request = (query = "shop=dev.myshopify.com&logged_in_customer_id=") => loader({
  request: new Request("https://booking.example/apps/skyra-booking/auth?" + query),
  params: {}, context: {}, url: new URL("https://booking.example/apps/skyra-booking/auth?" + query), pattern: "/apps/skyra-booking/auth",
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({});
  mocks.findShop.mockResolvedValue({ status: "ACTIVE" });
});

describe("storefront login gate", () => {
  it("rejects an unverified request before reading customer or shop data", async () => {
    const denied = new Response("Invalid signature", { status: 401 });
    mocks.authenticate.mockRejectedValue(denied);
    await expect(request("shop=dev.myshopify.com&logged_in_customer_id=123")).rejects.toBe(denied);
    expect(denied.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.findShop).not.toHaveBeenCalled();
  });
  it("returns only a private non-cacheable boolean for a signed-in customer", async () => {
    const response = await request("shop=dev.myshopify.com&logged_in_customer_id=12345678901234567890");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(await response.json()).toEqual({ authenticated: true });
  });
  it.each(["", "0", "-1", "customer", "1,2"])("treats invalid or absent customer ID '%s' as anonymous", async (id) => {
    const response = await request("shop=dev.myshopify.com&logged_in_customer_id=" + id);
    expect(await response.json()).toEqual({ authenticated: false });
  });
  it("ignores a client supplied authenticated flag or customer ID alias", async () => {
    const response = await request("shop=dev.myshopify.com&customer_id=123&authenticated=true");
    expect(await response.json()).toEqual({ authenticated: false });
  });
  it.each(["shop=a&shop=b", "shop=a&logged_in_customer_id=1&logged_in_customer_id=2", "logged_in_customer_id=1"])("rejects ambiguous identity context", async (query) => {
    expect((await request(query)).status).toBe(400);
    expect(mocks.findShop).not.toHaveBeenCalled();
  });
  it.each([null, { status: "UNINSTALLED" }])("does not authenticate a missing or inactive shop", async (shop) => {
    mocks.findShop.mockResolvedValue(shop);
    expect((await request("shop=dev.myshopify.com&logged_in_customer_id=123")).status).toBe(404);
  });
});
