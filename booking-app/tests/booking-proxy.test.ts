import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), findShop: vi.fn() }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { appProxy: mocks.authenticate } },
}));
vi.mock("../app/db.server", () => ({
  default: { shop: { findUnique: mocks.findShop } },
}));
import { bookingRequest } from "../app/services/booking-proxy.server";
const run = vi.fn(async () => ({ ok: true }));
function request(
  query = "shop=dev.myshopify.com&logged_in_customer_id=123",
  init: RequestInit = {},
) {
  return new Request("https://app.example/apps/skyra-booking/start?" + query, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Skyra-Booking": "1" },
    body: "{}",
    ...init,
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({});
  mocks.findShop.mockResolvedValue({ id: "shop-id", status: "ACTIVE" });
  run.mockResolvedValue({ ok: true });
});
test("a verified proxy ID becomes the only customer identity passed to the booking service", async () => {
  const response = await bookingRequest(request(), run);
  expect(response.status).toBe(200);
  expect(run).toHaveBeenCalledWith(
    { shopId: "shop-id", customerGid: "gid://shopify/Customer/123" },
    {},
  );
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
});
test("invalid signatures stop before shop lookup or booking writes", async () => {
  const denied = new Response("Invalid signature", { status: 401 });
  mocks.authenticate.mockRejectedValue(denied);
  await expect(bookingRequest(request(), run)).rejects.toBe(denied);
  expect(mocks.findShop).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
test.each([
  "shop=a&shop=b",
  "shop=a&logged_in_customer_id=1&logged_in_customer_id=2",
])("duplicate Shopify identity fields are rejected", async (query) => {
  expect((await bookingRequest(request(query), run)).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});
test.each([
  { "Content-Type": "application/x-www-form-urlencoded" },
  { "Content-Type": "application/json" },
  {
    "Content-Type": "application/json",
    "X-Skyra-Booking": "1",
    "Sec-Fetch-Site": "cross-site",
  },
])(
  "cross-site/simple form submissions cannot mutate attempts",
  async (headers) => {
    expect(
      (
        await bookingRequest(
          request(undefined, {
            headers: new Headers(
              Object.entries(headers).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            ),
          }),
          run,
        )
      ).status,
    ).toBe(403);
    expect(run).not.toHaveBeenCalled();
  },
);
test("a browser-supplied identity alias cannot authenticate an anonymous customer", async () => {
  await bookingRequest(
    request("shop=a&customer_id=999&authenticated=true"),
    run,
  );
  expect(run).toHaveBeenCalledWith(
    { shopId: "shop-id", customerGid: null },
    {},
  );
});
test("malformed JSON is rejected and internal errors do not disclose secrets", async () => {
  expect(
    (await bookingRequest(request(undefined, { body: "{" }), run)).status,
  ).toBe(400);
  run.mockRejectedValue(new Error("private database detail and token"));
  const response = await bookingRequest(request(), run);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private database");
});
