import { afterEach, expect, test, vi } from "vitest";
import {
  assertNoPublicMembershipStorefrontTokens,
  assertMembershipCheckoutProtection,
  authorizeMembershipCheckout,
  closeMembershipCheckout,
  readMembershipCheckoutAuthorization,
  MEMBERSHIP_CHECKOUT_AUTHORIZATION_READ,
  MEMBERSHIP_CHECKOUT_AUTHORIZATION_SET,
  PUBLIC_MEMBERSHIP_STOREFRONT_TOKENS,
  MEMBERSHIP_CHECKOUT_PROTECTION_READ,
  type MembershipCheckoutAuthorization,
} from "../app/services/membership-checkout-authorization.server";

const customerGid = "gid://shopify/Customer/10";
function proof(): MembershipCheckoutAuthorization {
  return {
    version: 1,
    state: "OPEN",
    nonce: "a".repeat(43),
    purchaseId: "8105843b-43d3-41de-a7a9-2ad945079c20",
    membershipId: "55d5ab6e-cf10-4633-8bda-a350e1cdad5f",
    cycle: 1,
    customerGid,
    productGid: "gid://shopify/Product/20",
    variantGid: "gid://shopify/ProductVariant/30",
    sellingPlanGid: "gid://shopify/SellingPlan/40",
    priceCents: 29900,
    currency: "AUD",
  };
}
const response = (data: unknown) => Response.json({ data });
function tokenPage(
  hasNextPage = false,
  endCursor: string | null = null,
  nodes: { id: string }[] = [],
) {
  return response({
    shop: {
      storefrontAccessTokens: {
        nodes,
        pageInfo: { hasNextPage, endCursor },
      },
    },
  });
}
function customer(
  authorization: MembershipCheckoutAuthorization | null = null,
) {
  return response({
    customer: {
      id: customerGid,
      authorization: authorization
        ? {
            type: "json",
            jsonValue: authorization,
            compareDigest: "prior-digest",
          }
        : null,
    },
  });
}
function written(authorization = proof()) {
  return response({
    metafieldsSet: {
      metafields: [
        {
          key: "membership_checkout",
          type: "json",
          jsonValue: authorization,
          compareDigest: "next-digest",
          owner: { id: customerGid },
        },
      ],
      userErrors: [],
    },
  });
}
function authorizeClient(
  current: MembershipCheckoutAuthorization | null = null,
) {
  return vi
    .fn()
    .mockResolvedValueOnce(tokenPage())
    .mockResolvedValueOnce(customer(current));
}
afterEach(() => vi.useRealTimers());

function protection() {
  return {
    validation: {
      id: "gid://shopify/Validation/50",
      enabled: true,
      blockOnFailure: true,
      shopifyFunction: {
        id: "function-one",
        handle: "skyra-membership-checkout-guard",
        appKey: "expected-app-client-id",
        apiVersion: "2026-07",
      },
    },
    product: {
      id: proof().productGid,
      managedMonthlyPass: { jsonValue: true as unknown },
    },
  };
}

test("checkout protection verifies the exact live enabled Function, owning app and product marker", async () => {
  const client = vi.fn().mockResolvedValue(response(protection()));
  await assertMembershipCheckoutProtection(
    client,
    proof().productGid,
    protection().validation.id,
    "expected-app-client-id",
  );
  expect(client).toHaveBeenCalledTimes(1);
  expect(client.mock.calls[0][0]).toBe(MEMBERSHIP_CHECKOUT_PROTECTION_READ);
  expect(client.mock.calls[0][1]).toMatchObject({
    tries: 1,
    variables: {
      productGid: proof().productGid,
      validationGid: "gid://shopify/Validation/50",
    },
  });
});

test.each([
  [
    "wrong validation",
    (data: ReturnType<typeof protection>) => {
      data.validation.id = "gid://shopify/Validation/999";
    },
  ],
  [
    "disabled",
    (data: ReturnType<typeof protection>) => {
      data.validation.enabled = false;
    },
  ],
  [
    "runtime failure bypass",
    (data: ReturnType<typeof protection>) => {
      data.validation.blockOnFailure = false;
    },
  ],
  [
    "wrong handle",
    (data: ReturnType<typeof protection>) => {
      data.validation.shopifyFunction.handle = "other-checkout-function";
    },
  ],
  [
    "wrong app",
    (data: ReturnType<typeof protection>) => {
      data.validation.shopifyFunction.appKey = "another-app-client-id";
    },
  ],
  [
    "wrong API version",
    (data: ReturnType<typeof protection>) => {
      data.validation.shopifyFunction.apiVersion = "2026-04";
    },
  ],
  [
    "wrong product",
    (data: ReturnType<typeof protection>) => {
      data.product.id = "gid://shopify/Product/999";
    },
  ],
  [
    "unmarked",
    (data: ReturnType<typeof protection>) => {
      data.product.managedMonthlyPass.jsonValue = false;
    },
  ],
  [
    "string marker",
    (data: ReturnType<typeof protection>) => {
      data.product.managedMonthlyPass.jsonValue = "true";
    },
  ],
  [
    "numeric marker",
    (data: ReturnType<typeof protection>) => {
      data.product.managedMonthlyPass.jsonValue = 1;
    },
  ],
] as const)(
  "%s cannot be treated as checkout protection",
  async (_, change) => {
    const data = protection();
    change(data);
    const client = vi.fn().mockResolvedValue(response(data));
    await expect(
      assertMembershipCheckoutProtection(
        client,
        proof().productGid,
        "gid://shopify/Validation/50",
        "expected-app-client-id",
      ),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_CHECKOUT_PROTECTION_UNAVAILABLE",
    });
    expect(client).toHaveBeenCalledTimes(1);
  },
);

test.each([
  { ...protection(), validation: null },
  {
    ...protection(),
    validation: { ...protection().validation, shopifyFunction: null },
  },
  { ...protection(), product: null },
  {
    ...protection(),
    product: { ...protection().product, managedMonthlyPass: null },
  },
])(
  "missing live validation, Function or product never grants protection",
  async (data) => {
    const client = vi.fn().mockResolvedValue(response(data));
    await expect(
      assertMembershipCheckoutProtection(
        client,
        proof().productGid,
        "gid://shopify/Validation/50",
        "expected-app-client-id",
      ),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_CHECKOUT_PROTECTION_UNAVAILABLE",
    });
  },
);

test("unreadable checkout protection fails closed without accepting environment flags", async () => {
  const client = vi.fn().mockRejectedValue(new Error("permission denied"));
  await expect(
    assertMembershipCheckoutProtection(
      client,
      proof().productGid,
      "gid://shopify/Validation/50",
      "expected-app-client-id",
    ),
  ).rejects.toMatchObject({ code: "MEMBERSHIP_AUTHORIZATION_UNAVAILABLE" });
  expect(client).toHaveBeenCalledTimes(1);
});

test("an unknown protection read timeout aborts with no second request", async () => {
  vi.useFakeTimers();
  const client = vi.fn().mockImplementation(() => new Promise(() => undefined));
  const result = assertMembershipCheckoutProtection(
    client,
    proof().productGid,
    "gid://shopify/Validation/50",
    "expected-app-client-id",
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(6001);
  expect(await result).toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_UNAVAILABLE",
  });
  expect(client).toHaveBeenCalledTimes(1);
  expect(client.mock.calls[0][1].signal.aborted).toBe(true);
});

test("public token check queries identifiers only and requires a complete listing", async () => {
  const client = vi
    .fn()
    .mockResolvedValueOnce(tokenPage(true, "page-one"))
    .mockResolvedValueOnce(tokenPage());
  await assertNoPublicMembershipStorefrontTokens(client);
  expect(client).toHaveBeenCalledTimes(2);
  expect(client.mock.calls[0][0]).toBe(PUBLIC_MEMBERSHIP_STOREFRONT_TOKENS);
  expect(client.mock.calls[0][0]).not.toMatch(/\baccessToken\b/);
  expect(client.mock.calls[0][1]).toMatchObject({
    tries: 1,
    variables: { after: null },
  });
  expect(client.mock.calls[1][1].variables).toEqual({ after: "page-one" });
});

test.each([0, 1])(
  "a public token on page %s blocks checkout before reading or writing customer proof",
  async (index) => {
    const client = vi.fn();
    if (index) client.mockResolvedValueOnce(tokenPage(true, "next"));
    client.mockResolvedValueOnce(
      tokenPage(false, null, [{ id: "gid://shopify/StorefrontAccessToken/1" }]),
    );
    await expect(
      authorizeMembershipCheckout(client, proof()),
    ).rejects.toMatchObject({
      code: "PUBLIC_MEMBERSHIP_STOREFRONT_TOKEN",
    });
    expect(client).toHaveBeenCalledTimes(index + 1);
  },
);

test.each([
  { shop: null },
  { shop: { storefrontAccessTokens: { nodes: [] } } },
  {
    shop: {
      storefrontAccessTokens: {
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    },
  },
])("missing or incomplete public token results fail closed", async (data) => {
  const client = vi.fn().mockResolvedValue(response(data));
  await expect(
    authorizeMembershipCheckout(client, proof()),
  ).rejects.toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_UNAVAILABLE",
  });
  expect(client).toHaveBeenCalledTimes(1);
});

test("repeated pagination cursor is not treated as a complete token listing", async () => {
  const client = vi
    .fn()
    .mockImplementation(async () => tokenPage(true, "same"));
  await expect(
    assertNoPublicMembershipStorefrontTokens(client),
  ).rejects.toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_UNAVAILABLE",
  });
  expect(client).toHaveBeenCalledTimes(2);
});

test("token pagination is bounded and reaching the limit never allows checkout", async () => {
  const client = vi
    .fn()
    .mockImplementation(async () =>
      tokenPage(true, `page-${client.mock.calls.length}`),
    );
  await expect(
    assertNoPublicMembershipStorefrontTokens(client),
  ).rejects.toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_UNAVAILABLE",
  });
  expect(client).toHaveBeenCalledTimes(5);
});

test("customer proof absence is verified rather than inferred from missing data", async () => {
  const client = vi.fn().mockResolvedValue(customer());
  await expect(
    readMembershipCheckoutAuthorization(client, customerGid),
  ).resolves.toEqual({
    customerGid,
    authorization: null,
    compareDigest: null,
  });
  expect(client.mock.calls[0][0]).toBe(MEMBERSHIP_CHECKOUT_AUTHORIZATION_READ);
});

test.each([
  { customer: null },
  { customer: { id: customerGid } },
  { customer: { id: "gid://shopify/Customer/999", authorization: null } },
  {
    customer: {
      id: customerGid,
      authorization: { type: "json", jsonValue: proof() },
    },
  },
  {
    customer: {
      id: customerGid,
      authorization: {
        type: "json",
        jsonValue: { ...proof(), customerGid: "gid://shopify/Customer/999" },
        compareDigest: "digest",
      },
    },
  },
  {
    customer: {
      id: customerGid,
      authorization: {
        type: "json",
        jsonValue: { ...proof(), extra: true },
        compareDigest: "digest",
      },
    },
  },
])("customer, digest and complete proof must all be verified", async (data) => {
  const client = vi.fn().mockResolvedValue(response(data));
  await expect(
    readMembershipCheckoutAuthorization(client, customerGid),
  ).rejects.toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_UNAVAILABLE",
  });
});

test("first authorization uses an explicit absence digest and confirms the exact proof", async () => {
  const desired = proof();
  const client = authorizeClient().mockResolvedValueOnce(written(desired));
  await expect(authorizeMembershipCheckout(client, desired)).resolves.toEqual({
    customerGid,
    authorization: desired,
    compareDigest: "next-digest",
  });
  expect(client).toHaveBeenCalledTimes(3);
  expect(client.mock.calls[2][0]).toBe(MEMBERSHIP_CHECKOUT_AUTHORIZATION_SET);
  expect(client.mock.calls[2][1]).toMatchObject({
    tries: 1,
    variables: {
      metafields: [
        {
          ownerId: customerGid,
          namespace: "$app",
          key: "membership_checkout",
          type: "json",
          compareDigest: null,
          value: JSON.stringify(desired),
        },
      ],
    },
  });
});

test("identical OPEN proof is idempotent without rewriting or rotating its nonce", async () => {
  const desired = proof();
  const reversed = Object.fromEntries(
    Object.entries(desired).reverse(),
  ) as MembershipCheckoutAuthorization;
  const client = authorizeClient(reversed);
  await expect(
    authorizeMembershipCheckout(client, desired),
  ).resolves.toMatchObject({
    authorization: desired,
    compareDigest: "prior-digest",
  });
  expect(client).toHaveBeenCalledTimes(2);
});

test.each([
  { nonce: "b".repeat(43) },
  { purchaseId: "df105e6c-0cba-4a56-a387-f1b0fa651f4e" },
  { cycle: 2 },
  { priceCents: 1 },
  { sellingPlanGid: null },
])("another OPEN proof cannot be silently replaced", async (change) => {
  const client = authorizeClient({ ...proof(), ...change });
  await expect(
    authorizeMembershipCheckout(client, proof()),
  ).rejects.toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_CONFLICT",
  });
  expect(client).toHaveBeenCalledTimes(2);
});

test("a CLOSED purchase cannot be reopened with the same or a new nonce", async () => {
  for (const nonce of ["a".repeat(43), "b".repeat(43)]) {
    const client = authorizeClient({ ...proof(), state: "CLOSED" });
    await expect(
      authorizeMembershipCheckout(client, { ...proof(), nonce }),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_AUTHORIZATION_CONFLICT",
    });
    expect(client).toHaveBeenCalledTimes(2);
  }
});

test("a different purchase can replace CLOSED only with its original comparison digest", async () => {
  const desired = {
    ...proof(),
    nonce: "b".repeat(43),
    purchaseId: "df105e6c-0cba-4a56-a387-f1b0fa651f4e",
    cycle: 2,
  };
  const client = authorizeClient({
    ...proof(),
    state: "CLOSED",
  }).mockResolvedValueOnce(written(desired));
  await authorizeMembershipCheckout(client, desired);
  expect(client.mock.calls[2][1].variables.metafields[0].compareDigest).toBe(
    "prior-digest",
  );
});

test.each(["STALE_OBJECT", "INVALID_COMPARE_DIGEST"])(
  "CAS %s conflict never retries or bypasses the digest",
  async (code) => {
    const client = authorizeClient().mockResolvedValueOnce(
      response({
        metafieldsSet: { metafields: null, userErrors: [{ code }] },
      }),
    );
    await expect(
      authorizeMembershipCheckout(client, proof()),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_AUTHORIZATION_CONFLICT",
    });
    expect(client).toHaveBeenCalledTimes(3);
  },
);

test("a known rejected write cannot masquerade as confirmed authorization", async () => {
  const client = authorizeClient().mockResolvedValueOnce(
    response({
      metafieldsSet: {
        metafields: null,
        userErrors: [{ code: "APP_NOT_AUTHORIZED" }],
      },
    }),
  );
  await expect(
    authorizeMembershipCheckout(client, proof()),
  ).rejects.toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_REJECTED",
  });
  expect(client).toHaveBeenCalledTimes(3);
});

test.each([
  { metafieldsSet: { metafields: [], userErrors: [] } },
  { metafieldsSet: { metafields: null, userErrors: [] } },
  {
    metafieldsSet: {
      metafields: [
        {
          key: "membership_checkout",
          type: "json",
          jsonValue: { ...proof(), priceCents: 1 },
          compareDigest: "next",
          owner: { id: customerGid },
        },
      ],
      userErrors: [],
    },
  },
  {
    metafieldsSet: {
      metafields: [
        {
          key: "membership_checkout",
          type: "json",
          jsonValue: proof(),
          compareDigest: "next",
          owner: { id: "gid://shopify/Customer/999" },
        },
      ],
      userErrors: [],
    },
  },
])(
  "unconfirmed or mismatched mutation output is UNKNOWN without a second write",
  async (data) => {
    const client = authorizeClient().mockResolvedValueOnce(response(data));
    await expect(
      authorizeMembershipCheckout(client, proof()),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_AUTHORIZATION_UNKNOWN",
    });
    expect(client).toHaveBeenCalledTimes(3);
  },
);

test("a lost write response remains UNKNOWN and exposes no upstream details", async () => {
  const client = authorizeClient().mockRejectedValueOnce(
    new Error(`upstream secret ${proof().nonce}`),
  );
  const error = await authorizeMembershipCheckout(client, proof()).catch(
    (failure) => failure,
  );
  expect(error).toMatchObject({ code: "MEMBERSHIP_AUTHORIZATION_UNKNOWN" });
  expect(error.message).not.toContain(proof().nonce);
  expect(client).toHaveBeenCalledTimes(3);
});

test("a write timeout aborts the single request without retrying", async () => {
  vi.useFakeTimers();
  const client = authorizeClient().mockImplementationOnce(
    () => new Promise(() => undefined),
  );
  const result = authorizeMembershipCheckout(client, proof()).catch(
    (error) => error,
  );
  await vi.waitFor(() => expect(client).toHaveBeenCalledTimes(3));
  await vi.advanceTimersByTimeAsync(6001);
  expect(await result).toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_UNKNOWN",
  });
  expect(client).toHaveBeenCalledTimes(3);
  expect(client.mock.calls[2][1].signal.aborted).toBe(true);
  expect(client.mock.calls[2][1].tries).toBe(1);
});

test("a read transport failure stops authorization with no mutation", async () => {
  const client = vi.fn().mockRejectedValue(new Error("provider unavailable"));
  await expect(
    authorizeMembershipCheckout(client, proof()),
  ).rejects.toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_UNAVAILABLE",
  });
  expect(client).toHaveBeenCalledTimes(1);
});

test("closing retains all identifiers and amount, uses CAS, and requires no public-token check", async () => {
  const closed = { ...proof(), state: "CLOSED" as const };
  const client = vi
    .fn()
    .mockResolvedValueOnce(customer(proof()))
    .mockResolvedValueOnce(written(closed));
  await expect(closeMembershipCheckout(client, proof())).resolves.toMatchObject(
    { authorization: closed },
  );
  expect(client).toHaveBeenCalledTimes(2);
  expect(client.mock.calls[0][0]).toBe(MEMBERSHIP_CHECKOUT_AUTHORIZATION_READ);
  expect(client.mock.calls[1][1].variables.metafields[0]).toMatchObject({
    compareDigest: "prior-digest",
    value: JSON.stringify(closed),
  });
});

test("closing an already identical CLOSED proof is idempotent", async () => {
  const closed = { ...proof(), state: "CLOSED" as const };
  const client = vi.fn().mockResolvedValueOnce(customer(closed));
  await expect(closeMembershipCheckout(client, proof())).resolves.toMatchObject(
    { authorization: closed },
  );
  expect(client).toHaveBeenCalledTimes(1);
});

test("closing an old purchase cannot overwrite a newer OPEN or CLOSED authorization", async () => {
  for (const state of ["OPEN", "CLOSED"] as const) {
    const client = vi.fn().mockResolvedValueOnce(
      customer({
        ...proof(),
        state,
        nonce: "b".repeat(43),
        purchaseId: "df105e6c-0cba-4a56-a387-f1b0fa651f4e",
      }),
    );
    await expect(
      closeMembershipCheckout(client, proof()),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_AUTHORIZATION_CONFLICT" });
    expect(client).toHaveBeenCalledTimes(1);
  }
});

test("closing an absent proof creates CLOSED only if it is still absent", async () => {
  const closed = { ...proof(), state: "CLOSED" as const };
  const client = vi
    .fn()
    .mockResolvedValueOnce(customer())
    .mockResolvedValueOnce(written(closed));
  await closeMembershipCheckout(client, proof());
  expect(
    client.mock.calls[1][1].variables.metafields[0].compareDigest,
  ).toBeNull();
});

test.each([
  { nonce: "short" },
  { cycle: 0 },
  { priceCents: 29.9 },
  { currency: "USD" },
  { customerGid: "gid://shopify/Customer/other" },
  { state: "EXPIRED" },
])("invalid authorization cannot invoke Shopify", async (change) => {
  const client = vi.fn();
  await expect(
    authorizeMembershipCheckout(client, {
      ...proof(),
      ...change,
    } as MembershipCheckoutAuthorization),
  ).rejects.toMatchObject({ code: "INVALID_MEMBERSHIP_AUTHORIZATION" });
  expect(client).not.toHaveBeenCalled();
});
