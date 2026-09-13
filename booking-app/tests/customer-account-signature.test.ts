import { beforeAll, afterAll, expect, test } from "vitest";
import { createHmac } from "node:crypto";
let authenticate: typeof import("../app/shopify.server").authenticate;
const secret = "local-customer-signature-test-only";
beforeAll(async () => {
  process.env.SHOPIFY_API_KEY = "customer-signature-test";
  process.env.SHOPIFY_API_SECRET = secret;
  process.env.SHOPIFY_APP_URL = "https://app.example";
  ({ authenticate } = await import("../app/shopify.server"));
});
afterAll(async () => {
  const { default: db } = await import("../app/db.server");
  await db.$disconnect();
});
function request(overrides: Record<string, unknown> = {}, key = secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: "customer-signature-test",
      sub: "gid://shopify/Customer/123",
      dest: "studio.myshopify.com",
      iat: now,
      nbf: now,
      exp: now + 300,
      ...overrides,
    }),
  ).toString("base64url");
  const signed = header + "." + payload;
  const signature = createHmac("sha256", key)
    .update(signed)
    .digest("base64url");
  return new Request("https://app.example/api/customer-bookings", {
    headers: {
      Authorization: "Bearer " + signed + "." + signature,
      Origin: "https://extensions.shopifycdn.com",
    },
  });
}
test("installed Shopify SDK accepts a correctly signed customer account token", async () => {
  expect(
    (await authenticate.public.customerAccount(request())).sessionToken.sub,
  ).toBe("gid://shopify/Customer/123");
});
test("installed Shopify SDK rejects forged signatures and expired tokens", async () => {
  await expect(
    authenticate.public.customerAccount(request({}, "different-key")),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    authenticate.public.customerAccount(
      request({ exp: Math.floor(Date.now() / 1000) - 60 }),
    ),
  ).rejects.toMatchObject({ status: 401 });
});
