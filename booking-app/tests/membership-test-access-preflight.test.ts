import { expect, test, vi } from "vitest";
import {
  assertTestAccessEnvironment,
  checkTestSdkAccess,
  parseOfficialTestAppEnvironment,
  type OfflineSessionMetadata,
} from "../scripts/membership-test-access-preflight";

const domain = "skyra-booking-dev.myshopify.com";
const apiKey = "c9d266a38e2f11a1240139974253b3a1";
const dbUrl =
  "postgresql://fixture:fixture@127.0.0.1:55432/skyra_booking?schema=public";
const safeEnvironment = {
  shopDomain: domain,
  databaseUrl: dbUrl,
  nodeEnv: "development",
  apiKey,
  apiSecret: "fixture-secret",
  configClientId: apiKey,
};

test.each([
  { shopDomain: "mf0n6s-zg.myshopify.com" },
  { databaseUrl: "postgresql://fixture:fixture@remote:55432/skyra_booking" },
  {
    databaseUrl:
      "postgresql://fixture:fixture@127.0.0.1:55432/skyra_booking_test",
  },
  { nodeEnv: "production" },
  { apiKey: "production-app" },
  { configClientId: "production-app" },
  { apiSecret: "" },
])("rejects unsafe environment before loading the SDK (%j)", (change) => {
  expect(() =>
    assertTestAccessEnvironment({ ...safeEnvironment, ...change }),
  ).toThrow();
});

test("accepts only explicit official test app credentials and discards every other CLI setting", () => {
  const parsed = parseOfficialTestAppEnvironment(
    [
      `SHOPIFY_API_KEY="${apiKey}"`,
      "SHOPIFY_API_SECRET='fixture-secret'",
      "SCOPES=read_products,write_products",
      "SHOPIFY_ACCESS_TOKEN=must-not-be-imported",
      "MERCHANT_TOKEN=must-not-be-imported",
      "SHOPIFY_APP_URL=https://irrelevant.example",
    ].join("\n"),
  );
  expect(parsed).toEqual({
    SHOPIFY_API_KEY: apiKey,
    SHOPIFY_API_SECRET: "fixture-secret",
    SCOPES: "read_products,write_products",
  });
  expect(() => assertTestAccessEnvironment(safeEnvironment)).not.toThrow();
});

test.each([
  `SHOPIFY_API_KEY=another-app\nSHOPIFY_API_SECRET=fixture-secret`,
  `SHOPIFY_API_KEY=${apiKey}`,
  `SHOPIFY_API_KEY=${apiKey}\nSHOPIFY_API_SECRET=fixture-secret\nSHOPIFY_API_SECRET=another`,
])(
  "ambiguous or absent official app credentials never fall back to other tokens",
  (output) => {
    expect(() => parseOfficialTestAppEnvironment(output)).toThrow();
  },
);

const identity = { shop: domain, isOnline: false };
function fixture() {
  const before: OfflineSessionMetadata = {
    id: `offline_${domain}`,
    shop: domain,
    isOnline: false,
    scope: "read_products",
    expires: new Date(Date.now() - 60000),
    hasRefreshToken: true,
    refreshTokenExpires: new Date(Date.now() + 86400000),
  };
  const after = {
    ...before,
    expires: new Date(Date.now() + 3600000),
    scope: "read_products,write_validations",
  };
  const loadOfflineMetadata = vi
    .fn()
    .mockResolvedValueOnce(before)
    .mockResolvedValue(after);
  const adminQuery = vi.fn().mockResolvedValue(
    Response.json({
      data: {
        shop: {
          id: "gid://shopify/Shop/1",
          myshopifyDomain: domain,
          currencyCode: "AUD",
        },
        currentAppInstallation: {
          app: { id: "gid://shopify/App/2", apiKey },
          accessScopes: [
            { handle: "read_products" },
            { handle: "write_validations" },
          ],
        },
      },
    }),
  );
  const storefrontQuery = vi
    .fn()
    .mockResolvedValue(
      Response.json({ data: { shop: { id: "gid://shopify/Shop/1" } } }),
    );
  const adminContext = vi
    .fn()
    .mockResolvedValue({ session: identity, admin: { graphql: adminQuery } });
  const storefrontContext = vi
    .fn()
    .mockResolvedValue({
      session: identity,
      storefront: { graphql: storefrontQuery },
    });
  return {
    before,
    after,
    dependencies: { loadOfflineMetadata, adminContext, storefrontContext },
    adminQuery,
    storefrontQuery,
  };
}

test("normal SDK contexts and read-only shop identity probes prove refresh without serializing credentials", async () => {
  const f = fixture();
  const result = await checkTestSdkAccess(f.dependencies);
  expect(result).toMatchObject({
    adminVerified: true,
    storefrontVerified: true,
    sameAppVerified: true,
    sdkRefresh: "SUCCEEDED",
    requiresInteractiveLogin: false,
  });
  expect(result.liveScopeHandles).toEqual([
    "read_products",
    "write_validations",
  ]);
  expect(f.dependencies.adminContext).toHaveBeenCalledWith(domain);
  expect(f.dependencies.storefrontContext).toHaveBeenCalledWith(domain);
  expect(f.adminQuery.mock.calls[0][0]).not.toContain("mutation");
  expect(f.storefrontQuery.mock.calls[0][0]).not.toContain("mutation");
  expect(f.adminQuery.mock.calls[0][1].tries).toBe(1);
  expect(JSON.stringify(result)).not.toContain(apiKey);
  expect(JSON.stringify(result)).not.toContain("accessToken");
});

test("refresh failure does not bypass the SDK or proceed to Storefront", async () => {
  const f = fixture();
  f.dependencies.adminContext.mockRejectedValue({
    response: {
      code: 400,
      body: { error: "invalid_grant", refresh_token: "do-not-log" },
      headers: { Authorization: "do-not-log" },
    },
  });
  f.dependencies.loadOfflineMetadata.mockReset().mockResolvedValue(f.before);
  const result = await checkTestSdkAccess(f.dependencies);
  expect(result).toMatchObject({
    adminVerified: false,
    storefrontVerified: false,
    failedStage: "ADMIN_CONTEXT",
    sdkRefresh: "FAILED_OR_UNVERIFIED",
    httpStatus: 400,
    requiresInteractiveLogin: true,
  });
  expect(f.dependencies.storefrontContext).not.toHaveBeenCalled();
  expect(f.adminQuery).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("do-not-log");
  expect(JSON.stringify(result)).not.toContain("invalid_grant");
});

test("an expired saved session without refresh cannot be repaired by a copied CLI token", async () => {
  const f = fixture();
  f.before.hasRefreshToken = false;
  f.dependencies.loadOfflineMetadata.mockReset().mockResolvedValue(f.before);
  f.adminQuery.mockRejectedValue({ response: { code: 401 } });
  const result = await checkTestSdkAccess(f.dependencies);
  expect(result).toMatchObject({
    sdkRefresh: "UNAVAILABLE_NO_REFRESH_TOKEN",
    httpStatus: 401,
    requiresInteractiveLogin: true,
  });
  expect(f.dependencies.storefrontContext).not.toHaveBeenCalled();
});

test("a foreign app or store cannot be reported as a successful development read", async () => {
  const f = fixture();
  f.adminQuery.mockResolvedValue(
    Response.json({
      data: {
        shop: {
          id: "gid://shopify/Shop/1",
          myshopifyDomain: "mf0n6s-zg.myshopify.com",
          currencyCode: "AUD",
        },
        currentAppInstallation: {
          app: { id: "gid://shopify/App/2", apiKey: "another-app" },
          accessScopes: [],
        },
      },
    }),
  );
  const result = await checkTestSdkAccess(f.dependencies);
  expect(result.adminVerified).toBe(false);
  expect(result.requiresInteractiveLogin).toBe(true);
  expect(f.dependencies.storefrontContext).not.toHaveBeenCalled();
});

test("Storefront must belong to the same Admin shop", async () => {
  const f = fixture();
  f.storefrontQuery.mockResolvedValue(
    Response.json({ data: { shop: { id: "gid://shopify/Shop/999" } } }),
  );
  const result = await checkTestSdkAccess(f.dependencies);
  expect(result).toMatchObject({
    adminVerified: true,
    storefrontVerified: false,
    failedStage: "STOREFRONT_READ",
    requiresInteractiveLogin: true,
  });
});

test("a missing or foreign saved offline session stops before any SDK call", async () => {
  const f = fixture();
  f.dependencies.loadOfflineMetadata
    .mockReset()
    .mockResolvedValue({ ...f.before, shop: "mf0n6s-zg.myshopify.com" });
  await expect(checkTestSdkAccess(f.dependencies)).rejects.toThrow(
    "normal saved offline session",
  );
  expect(f.dependencies.adminContext).not.toHaveBeenCalled();
});
