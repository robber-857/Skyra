import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, test, expect, vi } from "vitest";
import db from "../app/db.server";
import { refreshOfflineScopes } from "../app/services/offline-scopes.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Test database required");
});
afterAll(async () => {
  await db.$disconnect();
});
const key = "a".repeat(32);
async function fixture() {
  const shop = randomUUID() + ".myshopify.com";
  const session = await db.session.create({
    data: {
      id: "offline_" + shop,
      shop,
      state: "test",
      scope: "read_products",
      isOnline: false,
      accessToken: "test-only-" + randomUUID(),
    },
  });
  const live = {
    shop: { myshopifyDomain: shop },
    currentAppInstallation: {
      app: { apiKey: key },
      accessScopes: [
        { handle: "write_products" },
        { handle: "unauthenticated_read_product_listings" },
      ],
    },
  };
  const graphql = vi.fn(async () => Response.json({ data: live }));
  const run = () => refreshOfflineScopes(shop, key, session, graphql);
  return { shop, session, live, graphql, run };
}
test("refreshes only verified granted scopes without touching tokens", async () => {
  const f = await fixture();
  const result = await f.run();
  expect(result.scopes).toEqual([
    "unauthenticated_read_product_listings",
    "write_products",
  ]);
  const after = await db.session.findUniqueOrThrow({
    where: { id: f.session.id },
  });
  expect(after.accessToken).toBe(f.session.accessToken);
  expect(after.scope).toBe(result.scopes.join(","));
  expect(JSON.stringify(result)).not.toContain(f.session.accessToken);
});
test("removes stale revoked scopes instead of granting unverified access", async () => {
  const f = await fixture();
  f.live.currentAppInstallation.accessScopes = [];
  await f.run();
  expect(
    (await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).scope,
  ).toBe("");
});
test.each(["shop", "app"])(
  "rejects mismatched remote %s identity",
  async (kind) => {
    const f = await fixture();
    if (kind === "shop") f.live.shop.myshopifyDomain = "other.myshopify.com";
    else f.live.currentAppInstallation.app.apiKey = "b".repeat(32);
    await expect(f.run()).rejects.toMatchObject({
      code: "APP_IDENTITY_MISMATCH",
    });
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: f.session.id } }))
        .scope,
    ).toBe("read_products");
  },
);
test.each(["online", "shop", "id", "token"])(
  "rejects invalid local %s session",
  async (kind) => {
    const f = await fixture();
    if (kind === "online") f.session.isOnline = true;
    if (kind === "shop") f.session.shop = "other.myshopify.com";
    if (kind === "id") f.session.id = "other";
    if (kind === "token") f.session.accessToken = "";
    await expect(f.run()).rejects.toMatchObject({ code: "INVALID_SESSION" });
    expect(f.graphql).not.toHaveBeenCalled();
  },
);
test("does not overwrite a newer offline session", async () => {
  const f = await fixture();
  f.graphql.mockImplementation(async () => {
    await db.session.update({
      where: { id: f.session.id },
      data: { accessToken: "new-test-token", scope: "new-scope" },
    });
    return Response.json({ data: f.live });
  });
  await expect(f.run()).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(
    (await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).scope,
  ).toBe("new-scope");
});
test("rejects malformed upstream responses without session changes", async () => {
  const f = await fixture();
  f.graphql.mockResolvedValue(Response.json({ data: {} }));
  await expect(f.run()).rejects.toMatchObject({ code: "SHOPIFY_UNAVAILABLE" });
  expect(
    (await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).scope,
  ).toBe("read_products");
});
test("does not expose upstream credential errors", async () => {
  const f = await fixture();
  f.graphql.mockRejectedValue(new Error("private-value"));
  await expect(f.run()).rejects.not.toThrow("private-value");
});
