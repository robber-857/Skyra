import { expect, test, vi } from "vitest";
import {
  PRIVATE_CART_CREATE,
  PRIVATE_CART_IDENTITY_QUERY,
  PRIVATE_CART_READ,
  PRIVATE_CART_SHOP_QUERY,
  privateCartProbeVariables,
  probeMembershipPrivateCart,
} from "../scripts/membership-private-cart-probe";
import { PUBLIC_MEMBERSHIP_STOREFRONT_TOKENS } from "../app/services/membership-checkout-authorization.server";

// Importing the shared environment guard must never connect to a real DB here.
vi.mock("../app/db.server", () => ({ default: {} }));

const domain = "skyra-booking-dev.myshopify.com";
const appKey = "c9d266a38e2f11a1240139974253b3a1";
const identity = { shop: domain, isOnline: false };
const privateCartId = "gid://shopify/Cart/private-id?key=do-not-save-secret";
const probeNamespace = "app--98765";

function fixture() {
  const identityData = {
    shop: {
      id: "gid://shopify/Shop/1",
      myshopifyDomain: domain,
      currencyCode: "AUD",
    },
    currentAppInstallation: {
      app: { id: "gid://shopify/App/2", apiKey: appKey },
      accessScopes: [
        "unauthenticated_read_product_listings",
        "unauthenticated_write_checkouts",
        "unauthenticated_read_selling_plans",
      ].map((handle) => ({ handle })),
    },
    metafieldDefinitions: {
      nodes: [
        {
          namespace: probeNamespace,
          key: "membership_checkout",
          type: { name: "json" },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
  const tokens = {
    nodes: [] as { id: string }[],
    pageInfo: { hasNextPage: false, endCursor: null as string | null },
  };
  const cart = {
    totalQuantity: 0,
    authorization: {
      namespace: probeNamespace,
      key: "membership_checkout",
      type: "json",
      value: '{"kind":"PRIVATE_ACCESS_PROBE"}',
    },
  };
  const adminQuery = vi.fn(async (query: string) => {
    if (query === PRIVATE_CART_IDENTITY_QUERY)
      return Response.json({ data: identityData });
    if (query === PUBLIC_MEMBERSHIP_STOREFRONT_TOKENS)
      return Response.json({
        data: { shop: { storefrontAccessTokens: tokens } },
      });
    throw new Error("Unexpected Admin operation");
  });
  const storefrontQuery = vi.fn(async (query: string) => {
    if (query === PRIVATE_CART_SHOP_QUERY)
      return Response.json({ data: { shop: { id: identityData.shop.id } } });
    if (query === PRIVATE_CART_CREATE)
      return Response.json({
        data: {
          cartCreate: { cart: { ...cart, id: privateCartId }, userErrors: [] },
        },
      });
    if (query === PRIVATE_CART_READ)
      return Response.json({
        data: {
          cart: {
            ...cart,
            implicitAuthorization: cart.authorization,
            resolvedAuthorization: cart.authorization,
          },
        },
      });
    throw new Error("Unexpected Storefront operation");
  });
  const dependencies = {
    offlineSessionExists: vi.fn(async () => true),
    adminContext: vi.fn(async () => ({
      session: identity,
      admin: { graphql: adminQuery },
    })),
    storefrontContext: vi.fn(async () => ({
      session: identity,
      storefront: { graphql: storefrontQuery },
    })),
  };
  return {
    identityData,
    tokens,
    cart,
    adminQuery,
    storefrontQuery,
    dependencies,
  };
}

test("the only mutation is one empty cart with a malformed non-payment probe", async () => {
  const f = fixture();
  const report = await probeMembershipPrivateCart(f.dependencies);
  expect(report).toMatchObject({
    adminVerified: true,
    sameAppVerified: true,
    storefrontVerified: true,
    publicStorefrontTokensAbsent: true,
    cartCreateSubmitted: true,
    cartCreated: true,
    emptyCart: true,
    noBuyerIdentitySubmitted: true,
    expectedAppNamespace: probeNamespace,
    writeAppNamespace: probeNamespace,
    readAppNamespace: probeNamespace,
    namespaceMatchesApp: true,
    probeValueMatches: true,
    readbackVerified: true,
    noCustomerProofWritten: true,
    paymentSubmitted: false,
    emailSent: false,
    publicTokenCreated: false,
    financialFlagsChanged: false,
    automaticRetry: false,
    cartSecretsRetained: false,
    failedStage: null,
    errorCodes: [],
  });
  expect(
    f.adminQuery.mock.calls.every(([query]) => !query.includes("mutation")),
  ).toBe(true);
  expect(f.storefrontQuery.mock.calls.map(([query]) => query)).toEqual([
    PRIVATE_CART_SHOP_QUERY,
    PRIVATE_CART_CREATE,
    PRIVATE_CART_READ,
  ]);
  const calls = f.storefrontQuery.mock.calls as unknown as [
    string,
    { tries: number; variables: unknown },
  ][];
  expect(calls[1][1]).toEqual({
    tries: 1,
    variables: privateCartProbeVariables(),
  });
  expect(calls[2][1]).toEqual({
    tries: 1,
    variables: { cartId: privateCartId, namespace: probeNamespace },
  });
  expect(privateCartProbeVariables()).toEqual({
    input: {
      lines: [],
      metafields: [
        {
          key: "membership_checkout",
          type: "json",
          value: '{"kind":"PRIVATE_ACCESS_PROBE"}',
        },
      ],
    },
  });
  expect(PRIVATE_CART_CREATE).not.toContain("checkoutUrl");
  expect(PRIVATE_CART_CREATE).not.toContain("buyerIdentity");
  expect(PRIVATE_CART_READ).not.toContain("buyerIdentity");
  const retained = JSON.stringify(report);
  for (const secret of [
    privateCartId,
    "do-not-save-secret",
    appKey,
    "accessToken",
    "apiSecret",
  ])
    expect(retained).not.toContain(secret);
});

test("namespace equality uses the actual Admin definition, not an assumed App GID number", async () => {
  const f = fixture();
  expect(f.identityData.currentAppInstallation.app.id).toBe(
    "gid://shopify/App/2",
  );
  expect(f.cart.authorization.namespace).toBe("app--98765");
  expect(
    (await probeMembershipPrivateCart(f.dependencies)).readbackVerified,
  ).toBe(true);
});

test("explicit identity-only mode completes only reads and never submits a Cart", async () => {
  const f = fixture();
  const report = await probeMembershipPrivateCart(f.dependencies, {
    identityOnly: true,
  });
  expect(report).toMatchObject({
    identityOnly: true,
    identityProbeVerified: true,
    identityResponseReceived: true,
    identityHttpOk: true,
    identityHttpStatus: 200,
    identityValidationIssues: [],
    cartCreateSubmitted: false,
    cartCreated: false,
    readbackVerified: false,
  });
  expect(f.storefrontQuery.mock.calls.map(([query]) => query)).toEqual([
    PRIVATE_CART_SHOP_QUERY,
  ]);
  expect(
    f.adminQuery.mock.calls.every(([query]) => !query.includes("mutation")),
  ).toBe(true);
});

test("missing saved offline session stops before SDK loading", async () => {
  const f = fixture();
  f.dependencies.offlineSessionExists.mockResolvedValue(false);
  const report = await probeMembershipPrivateCart(f.dependencies);
  expect(report.failedStage).toBe("OFFLINE_SESSION");
  expect(f.dependencies.adminContext).not.toHaveBeenCalled();
  expect(f.dependencies.storefrontContext).not.toHaveBeenCalled();
});

test.each([
  "foreign-domain",
  "foreign-app",
  "wrong-currency",
  "missing-scopes",
  "unknown-definition",
  "unread-definition-page",
])(
  "%s rejects the Cart mutation before obtaining Storefront",
  async (failure) => {
    const f = fixture();
    if (failure === "foreign-domain")
      f.identityData.shop.myshopifyDomain = "mf0n6s-zg.myshopify.com";
    if (failure === "foreign-app")
      f.identityData.currentAppInstallation.app.apiKey = "another-app";
    if (failure === "wrong-currency") f.identityData.shop.currencyCode = "USD";
    if (failure === "missing-scopes")
      f.identityData.currentAppInstallation.accessScopes = [];
    if (failure === "unknown-definition")
      f.identityData.metafieldDefinitions.nodes = [];
    if (failure === "unread-definition-page")
      f.identityData.metafieldDefinitions.pageInfo.hasNextPage = true;
    const report = await probeMembershipPrivateCart(f.dependencies);
    expect(report.failedStage).toBe("ADMIN_IDENTITY");
    expect(report.cartCreateSubmitted).toBe(false);
    expect(f.dependencies.storefrontContext).not.toHaveBeenCalled();
  },
);

test.each(["existing-token", "incomplete-pagination", "token-read-failure"])(
  "%s never proceeds to creating a Cart or a public token",
  async (failure) => {
    const f = fixture();
    if (failure === "existing-token")
      f.tokens.nodes = [{ id: "gid://shopify/StorefrontAccessToken/4" }];
    if (failure === "incomplete-pagination")
      f.tokens.pageInfo.hasNextPage = true;
    if (failure === "token-read-failure")
      f.adminQuery.mockImplementation(async (query: string) => {
        if (query === PRIVATE_CART_IDENTITY_QUERY)
          return Response.json({ data: f.identityData });
        throw new Error("sensitive-private-token-do-not-print");
      });
    const report = await probeMembershipPrivateCart(f.dependencies);
    expect(report.failedStage).toBe("PUBLIC_STOREFRONT_TOKENS");
    expect(report.cartCreateSubmitted).toBe(false);
    expect(f.dependencies.storefrontContext).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("sensitive-private-token");
  },
);

test("the Storefront identity must be the same shop before a Cart can be created", async () => {
  const f = fixture();
  f.storefrontQuery.mockResolvedValue(
    Response.json({ data: { shop: { id: "gid://shopify/Shop/999" } } }),
  );
  const report = await probeMembershipPrivateCart(f.dependencies);
  expect(report.failedStage).toBe("STOREFRONT_IDENTITY");
  expect(report.cartCreateSubmitted).toBe(false);
  expect(f.storefrontQuery).toHaveBeenCalledOnce();
});

test("a lost create response never starts another Cart and retains no secret exception data", async () => {
  const f = fixture();
  f.storefrontQuery.mockImplementation(async (query: string) => {
    if (query === PRIVATE_CART_SHOP_QUERY)
      return Response.json({ data: { shop: { id: "gid://shopify/Shop/1" } } });
    throw new Error(privateCartId + " private-provider-token");
  });
  const report = await probeMembershipPrivateCart(f.dependencies);
  expect(report).toMatchObject({
    failedStage: "EMPTY_CART_CREATE",
    cartCreateSubmitted: true,
    readbackVerified: false,
    automaticRetry: false,
    errorCodes: ["EMPTY_CART_PROBE_UNVERIFIED_NO_AUTOMATIC_RETRY"],
  });
  expect(f.storefrontQuery.mock.calls.map(([query]) => query)).toEqual([
    PRIVATE_CART_SHOP_QUERY,
    PRIVATE_CART_CREATE,
  ]);
  expect(JSON.stringify(report)).not.toContain("private");
});

test.each([
  "wrong-namespace",
  "nonempty-cart",
  "open-grant",
  "unexpected-field",
])(
  "%s cannot be reported as a successful empty private access probe",
  async (failure) => {
    const f = fixture();
    if (failure === "wrong-namespace")
      f.cart.authorization.namespace = "app--3";
    if (failure === "nonempty-cart") f.cart.totalQuantity = 1;
    if (failure === "open-grant")
      f.cart.authorization.value = '{"version":1,"state":"OPEN"}';
    if (failure === "unexpected-field")
      f.cart.authorization.value =
        '{"kind":"PRIVATE_ACCESS_PROBE","secret":"do-not-save-secret"}';
    const report = await probeMembershipPrivateCart(f.dependencies);
    expect(report.failedStage).toBe(
      failure === "nonempty-cart" ? "EMPTY_CART_CREATE" : "EMPTY_CART_READBACK",
    );
    expect(report.readbackVerified).toBe(false);
    if (failure === "nonempty-cart")
      expect(
        f.storefrontQuery.mock.calls.map(([query]) => query),
      ).not.toContain(PRIVATE_CART_READ);
    expect(JSON.stringify(report)).not.toContain("do-not-save-secret");
  },
);

test("readback namespace mismatch fails without retaining the Cart ID or attempting recreation", async () => {
  const f = fixture();
  f.storefrontQuery.mockImplementation(async (query: string) => {
    if (query === PRIVATE_CART_SHOP_QUERY)
      return Response.json({ data: { shop: { id: "gid://shopify/Shop/1" } } });
    if (query === PRIVATE_CART_CREATE)
      return Response.json({
        data: {
          cartCreate: {
            cart: { ...f.cart, id: privateCartId },
            userErrors: [],
          },
        },
      });
    return Response.json({
      data: {
        cart: {
          ...f.cart,
          authorization: { ...f.cart.authorization, namespace: "app--3" },
          implicitAuthorization: f.cart.authorization,
          resolvedAuthorization: f.cart.authorization,
        },
      },
    });
  });
  const report = await probeMembershipPrivateCart(f.dependencies);
  expect(report.failedStage).toBe("EMPTY_CART_READBACK");
  expect(report.namespaceMatchesApp).toBe(false);
  expect(report.readbackVerified).toBe(false);
  expect(
    f.storefrontQuery.mock.calls.filter(
      ([query]) => query === PRIVATE_CART_CREATE,
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(report)).not.toContain("do-not-save-secret");
});

test("a missing explicit alias is compared with implicit and full namespaces without claiming complete readback", async () => {
  const f = fixture();
  f.storefrontQuery.mockImplementation(async (query: string) => {
    if (query === PRIVATE_CART_SHOP_QUERY)
      return Response.json({ data: { shop: { id: "gid://shopify/Shop/1" } } });
    if (query === PRIVATE_CART_CREATE)
      return Response.json({
        data: {
          cartCreate: {
            cart: { ...f.cart, id: privateCartId, authorization: null },
            userErrors: [],
          },
        },
      });
    return Response.json({
      data: {
        cart: {
          ...f.cart,
          authorization: null,
          implicitAuthorization: f.cart.authorization,
          resolvedAuthorization: f.cart.authorization,
        },
      },
    });
  });
  const report = await probeMembershipPrivateCart(f.dependencies);
  expect(report).toMatchObject({
    createResponseReceived: true,
    createHttpOk: true,
    createCartPresent: true,
    createAuthorizationPresent: false,
    createIdHasKey: true,
    createShapeValid: true,
    createGraphqlErrors: false,
    createUserErrors: false,
    createValidationIssues: [],
    explicitAppAliasRead: false,
    implicitAppDefaultRead: true,
    resolvedAppNamespaceRead: true,
    implicitValueMatches: true,
    resolvedValueMatches: true,
    explicitValueMatches: false,
    readbackVerified: false,
    failedStage: "EMPTY_CART_READBACK",
    automaticRetry: false,
  });
  expect(JSON.stringify(report)).not.toContain("do-not-save-secret");
  expect(
    f.storefrontQuery.mock.calls.filter(
      ([query]) => query === PRIVATE_CART_CREATE,
    ),
  ).toHaveLength(1);
});

test("Cart user errors and SDK GraphQL exceptions retain only whitelisted codes", async () => {
  for (const errorKind of ["user-error", "sdk-error"]) {
    const f = fixture();
    f.storefrontQuery.mockImplementation(async (query: string) => {
      if (query === PRIVATE_CART_SHOP_QUERY)
        return Response.json({
          data: { shop: { id: "gid://shopify/Shop/1" } },
        });
      if (errorKind === "sdk-error")
        throw {
          message: privateCartId,
          headers: { Authorization: "provider-private-secret" },
          body: {
            errors: {
              graphQLErrors: [
                {
                  extensions: { code: "ACCESS_DENIED" },
                  message: "provider-private-secret",
                },
                { extensions: { code: "PROVIDER_PRIVATE_SECRET" } },
              ],
            },
          },
        };
      return Response.json({
        data: {
          cartCreate: {
            cart: null,
            userErrors: [
              { code: "INVALID", field: ["input", "metafields"] },
              {
                code: "PROVIDER_PRIVATE_SECRET",
                field: ["provider-private-secret"],
              },
            ],
          },
        },
      });
    });
    const report = await probeMembershipPrivateCart(f.dependencies);
    expect(report.errorCodes).toContain(
      errorKind === "user-error" ? "INVALID" : "ACCESS_DENIED",
    );
    expect(report.errorCodes).toContain("UNRECOGNIZED_PROVIDER_CODE");
    expect(report.automaticRetry).toBe(false);
    const retained = JSON.stringify(report);
    expect(retained).not.toContain("PROVIDER_PRIVATE_SECRET");
    expect(retained).not.toContain("provider-private-secret");
    expect(retained).not.toContain(privateCartId);
  }
});

test.each([500, 302])(
  "a thrown SDK Response (%i) retains status and redirect booleans without the URL",
  async (status) => {
    const f = fixture();
    f.dependencies.adminContext.mockRejectedValue(
      new Response(undefined, {
        status,
        headers:
          status === 302
            ? {
                location:
                  "https://test.example/auth?token=do-not-save-redirect-secret",
              }
            : {},
      }),
    );
    const report = await probeMembershipPrivateCart(f.dependencies, {
      identityOnly: true,
    });
    expect(report).toMatchObject({
      failedStage: "ADMIN_CONTEXT",
      sdkHttpStatus: status,
      sdkExceptionClass: "Response",
      sdkRedirect: {
        hasLocation: status === 302,
        isOAuthRedirect: status === 302,
        reauthorizationRequested: false,
      },
      cartCreateSubmitted: false,
      readbackVerified: false,
    });
    expect(JSON.stringify(report)).not.toContain("test.example");
    expect(JSON.stringify(report)).not.toContain("do-not-save-redirect-secret");
    expect(f.storefrontQuery).not.toHaveBeenCalled();
  },
);

test("a Cart ID without its secret key is diagnosed and never read or automatically recreated", async () => {
  const f = fixture();
  f.storefrontQuery.mockImplementation(async (query: string) => {
    if (query === PRIVATE_CART_SHOP_QUERY)
      return Response.json({ data: { shop: { id: "gid://shopify/Shop/1" } } });
    return Response.json({
      data: {
        cartCreate: {
          cart: { ...f.cart, id: "gid://shopify/Cart/private-id" },
          userErrors: [],
        },
      },
    });
  });
  const report = await probeMembershipPrivateCart(f.dependencies);
  expect(report).toMatchObject({
    failedStage: "EMPTY_CART_CREATE",
    createCartPresent: true,
    createIdHasKey: false,
    createShapeValid: false,
    automaticRetry: false,
    createValidationIssues: [
      { path: ["cartCreate", "cart", "id"], code: "invalid_format" },
    ],
  });
  expect(
    f.storefrontQuery.mock.calls.filter(
      ([query]) => query === PRIVATE_CART_CREATE,
    ),
  ).toHaveLength(1);
  expect(f.storefrontQuery.mock.calls.map(([query]) => query)).not.toContain(
    PRIVATE_CART_READ,
  );
  expect(JSON.stringify(report)).not.toContain("private-id");
});
