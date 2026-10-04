import { afterEach, expect, test, vi } from "vitest";
import {
  assertMembershipCart,
  createMembershipCart,
  readMembershipCart,
  readSubscriptionContract,
  readMembershipBillingContext,
  submitMembershipBilling,
  readMembershipBilling,
  readMembershipOrder,
  cancelSubscriptionContract,
  setNextBillingDate,
  PASS_PURCHASE_REFERENCE_KEY,
} from "../app/services/shopify-membership.server";

const domain = "skyra-booking-dev.myshopify.com";
const target = {
  reference: "purchase-reference",
  productGid: "gid://shopify/Product/1",
  variantGid: "gid://shopify/ProductVariant/2",
  priceCents: 29900,
  sellingPlanGid: "gid://shopify/SellingPlan/3",
};
function cart() {
  return {
    id: "gid://shopify/Cart/cart-one?key=secret",
    checkoutUrl: `https://${domain}/checkouts/one`,
    totalQuantity: 1,
    buyerIdentity: { countryCode: "AU" },
    lines: {
      nodes: [
        {
          id: "line",
          quantity: 1,
          attributes: [
            { key: PASS_PURCHASE_REFERENCE_KEY, value: target.reference },
          ],
          merchandise: {
            id: target.variantGid,
            product: { id: target.productGid },
          },
          sellingPlanAllocation: { sellingPlan: { id: target.sellingPlanGid } },
          cost: {
            amountPerQuantity: { amount: "299.00", currencyCode: "AUD" },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
}
const response = (data: unknown) => Response.json({ data });
afterEach(() => vi.useRealTimers());

test("both purchase entrances create exactly one verified selling-plan line", async () => {
  const value = cart();
  value.lines.nodes[0].attributes.push({
    key: "_skyra_booking_ref",
    value: "booking-ref",
  });
  const client = vi
    .fn()
    .mockResolvedValue(
      response({ cartCreate: { cart: value, userErrors: [], warnings: [] } }),
    );
  const result = await createMembershipCart(
    client,
    { ...target, bookingReference: "booking-ref" },
    domain,
  );
  expect(result).toEqual({ cart: value, clean: true });
  expect(client).toHaveBeenCalledTimes(1);
  expect(client.mock.calls[0][1]).toMatchObject({
    tries: 1,
    variables: {
      input: {
        buyerIdentity: { countryCode: "AU" },
        lines: [
          {
            merchandiseId: target.variantGid,
            quantity: 1,
            sellingPlanId: target.sellingPlanGid,
            attributes: value.lines.nodes[0].attributes,
          },
        ],
      },
    },
  });
  expect(
    client.mock.calls[0][1].variables.input.buyerIdentity,
  ).not.toHaveProperty("customerAccessToken");
});

test("one-time standalone passes remain supported without subscription authorization", async () => {
  const value = {
    ...cart(),
    lines: {
      ...cart().lines,
      nodes: [{ ...cart().lines.nodes[0], sellingPlanAllocation: null }],
    },
  };
  const client = vi
    .fn()
    .mockResolvedValue(
      response({ cartCreate: { cart: value, userErrors: [], warnings: [] } }),
    );
  await createMembershipCart(
    client,
    { ...target, sellingPlanGid: null },
    domain,
  );
  expect(client.mock.calls[0][1].variables.input.lines[0]).not.toHaveProperty(
    "sellingPlanId",
  );
});

test("the protected cart carries the server authorization and checks Shopify's retained proof", async () => {
  const authorization = {
    version: 1 as const,
    state: "OPEN" as const,
    nonce: "a".repeat(43),
    purchaseId: "8105843b-43d3-41de-a7a9-2ad945079c20",
    membershipId: "55d5ab6e-cf10-4633-8bda-a350e1cdad5f",
    cycle: 1,
    customerGid: "gid://shopify/Customer/10",
    productGid: target.productGid,
    variantGid: target.variantGid,
    sellingPlanGid: target.sellingPlanGid,
    priceCents: target.priceCents,
    currency: "AUD" as const,
  };
  const protectedTarget = { ...target, authorization };
  const value = { ...cart(), authorization: { jsonValue: authorization } };
  const providerCart = {
    ...value,
    authorization: { value: JSON.stringify(authorization) },
  };
  const client = vi.fn().mockResolvedValue(
    response({
      cartCreate: { cart: providerCart, userErrors: [], warnings: [] },
    }),
  );
  await createMembershipCart(client, protectedTarget, domain);
  expect(client.mock.calls[0][1].variables.input.metafields).toEqual([
    {
      key: "membership_checkout",
      type: "json",
      value: JSON.stringify(authorization),
    },
  ]);
  expect(() => assertMembershipCart(cart(), protectedTarget, domain)).toThrow();
  expect(() =>
    assertMembershipCart(
      {
        ...value,
        authorization: {
          jsonValue: { ...authorization, nonce: "b".repeat(43) },
        },
      },
      protectedTarget,
      domain,
    ),
  ).toThrow();
  const read = vi.fn().mockResolvedValue(response({ cart: providerCart }));
  await readMembershipCart(read, value.id, protectedTarget, domain);
  expect(read.mock.calls[0][0]).toContain('key: "membership_checkout"');
});

test.each([
  (value: ReturnType<typeof cart>) => {
    value.lines.nodes[0].sellingPlanAllocation.sellingPlan.id =
      "gid://shopify/SellingPlan/other";
  },
  (value: ReturnType<typeof cart>) => {
    value.lines.nodes[0].quantity = 2;
  },
  (value: ReturnType<typeof cart>) => {
    value.lines.nodes[0].attributes[0].value = "another-purchase";
  },
  (value: ReturnType<typeof cart>) => {
    value.lines.nodes[0].attributes.push(value.lines.nodes[0].attributes[0]);
  },
  (value: ReturnType<typeof cart>) => {
    value.lines.nodes[0].cost.amountPerQuantity.amount = "598.00";
  },
  (value: ReturnType<typeof cart>) => {
    value.lines.nodes[0].cost.amountPerQuantity.currencyCode = "USD";
  },
  (value: ReturnType<typeof cart>) => {
    value.checkoutUrl = "https://attacker.example/checkouts/one";
  },
  (value: ReturnType<typeof cart>) => {
    value.id = "gid://shopify/Cart/cart-one";
  },
])(
  "rejects a changed membership cart before returning its checkout URL (%#)",
  (alter) => {
    const value = cart();
    alter(value);
    expect(() => assertMembershipCart(value, target, domain)).toThrow();
  },
);

test("cart response loss makes one request and never leaks the original error", async () => {
  const client = vi
    .fn()
    .mockRejectedValue(new Error("secret-token-and-cart-key"));
  await expect(
    createMembershipCart(client, target, domain),
  ).rejects.toMatchObject({ code: "CART_REQUEST_UNKNOWN" });
  expect(client).toHaveBeenCalledTimes(1);
});

test("a created but mismatched cart is unknown, never a safe rejection to create another", async () => {
  const value = cart();
  value.totalQuantity = 2;
  const client = vi
    .fn()
    .mockResolvedValue(
      response({ cartCreate: { cart: value, userErrors: [], warnings: [] } }),
    );
  await expect(
    createMembershipCart(client, target, domain),
  ).rejects.toMatchObject({ code: "CART_REQUEST_UNKNOWN" });
});

test("cart read verifies the original cart ID and remains read-only", async () => {
  const value = cart();
  const client = vi
    .fn()
    .mockImplementation(() => Promise.resolve(response({ cart: value })));
  await expect(
    readMembershipCart(client, value.id, target, domain),
  ).resolves.toEqual(value);
  await expect(
    readMembershipCart(
      client,
      "gid://shopify/Cart/different?key=secret",
      target,
      domain,
    ),
  ).rejects.toMatchObject({ code: "CART_CHANGED" });
  expect(client.mock.calls.every(([query]) => query.startsWith("query"))).toBe(
    true,
  );
});

const contractGid = "gid://shopify/SubscriptionContract/4";
function contract() {
  return {
    id: contractGid,
    status: "PAUSED",
    nextBillingDate: null,
    currencyCode: "AUD",
    app: { id: "gid://shopify/App/5" },
    customer: { id: "gid://shopify/Customer/6" },
    originOrder: { id: "gid://shopify/Order/7" },
    customerPaymentMethod: {
      id: "gid://shopify/CustomerPaymentMethod/8",
      revokedAt: null,
    },
    deliveryPrice: { amount: "0.00", currencyCode: "AUD" },
    billingPolicy: { interval: "MONTH", intervalCount: 1 },
    discounts: {
      nodes: [] as { id: string }[],
      pageInfo: { hasNextPage: false },
    },
    lines: {
      nodes: [
        {
          id: "gid://shopify/SubscriptionLine/9",
          productId: target.productGid,
          variantId: target.variantGid,
          quantity: 1,
          sellingPlanId: target.sellingPlanGid,
          requiresShipping: false,
          currentPrice: { amount: "299.00", currencyCode: "AUD" },
          lineDiscountedPrice: { amount: "299.00", currencyCode: "AUD" },
          pricingPolicy: null as null | {
            basePrice: { amount: string; currencyCode: string };
            cycleDiscounts: {
              afterCycle: number;
              computedPrice: { amount: string; currencyCode: string };
            }[];
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
}
test("contract read verifies app ownership and supplies exact payable-line identity", async () => {
  const value = contract();
  const client = vi.fn().mockResolvedValue(
    response({
      currentAppInstallation: { app: value.app },
      subscriptionContract: value,
    }),
  );
  await expect(readSubscriptionContract(client, contractGid)).resolves.toEqual(
    value,
  );
  client.mockResolvedValue(
    response({
      currentAppInstallation: { app: { id: "gid://shopify/App/other" } },
      subscriptionContract: value,
    }),
  );
  await expect(
    readSubscriptionContract(client, contractGid),
  ).rejects.toMatchObject({ code: "CONTRACT_NOT_OWNED" });
});

const billingContextNow = new Date("2026-11-02T01:00:00Z");
function activeContract() {
  return {
    ...contract(),
    status: "ACTIVE",
    nextBillingDate: "2026-11-02T00:00:00Z",
  };
}
function cycle() {
  return {
    cycleIndex: 9,
    cycleStartAt: "2026-11-01T00:00:00Z",
    cycleEndAt: "2026-12-01T00:00:00Z",
    billingAttemptExpectedDate: "2026-11-02T00:00:00Z",
    status: "UNBILLED",
    edited: false,
    skipped: false,
    sourceContract: { id: contractGid },
    editedContract: null as null | { __typename: string },
    billingAttempts: {
      nodes: [] as { id: string }[],
      pageInfo: { hasNextPage: false },
    },
  };
}
function contextClient(
  value = activeContract(),
  billingCycle: unknown = cycle(),
) {
  return vi
    .fn()
    .mockResolvedValueOnce(
      response({
        currentAppInstallation: { app: value.app },
        subscriptionContract: value,
      }),
    )
    .mockResolvedValueOnce(
      response({ subscriptionBillingCycle: billingCycle }),
    );
}

test("billing context selects the real Shopify index from its due date, independently of local periods", async () => {
  const value = activeContract();
  const client = contextClient(value);
  await expect(
    readMembershipBillingContext(client, contractGid, billingContextNow),
  ).resolves.toEqual({
    contract: value,
    nextBillingDate: new Date(value.nextBillingDate),
    billingCycleSelector: { index: 9 },
  });
  expect(client).toHaveBeenCalledTimes(2);
  expect(client.mock.calls[1][1]).toMatchObject({
    tries: 1,
    variables: { contractId: contractGid, date: "2026-11-02T00:00:00.000Z" },
  });
  expect(
    client.mock.calls.every(([query]) => query.startsWith("#graphql\nquery")),
  ).toBe(true);
});

test.each([
  [
    "weekly billing",
    (value: ReturnType<typeof activeContract>) => {
      value.billingPolicy.interval = "WEEK";
    },
  ],
  [
    "multi-month billing",
    (value: ReturnType<typeof activeContract>) => {
      value.billingPolicy.intervalCount = 3;
    },
  ],
  [
    "paused",
    (value: ReturnType<typeof activeContract>) => {
      value.status = "PAUSED";
    },
  ],
  [
    "future due date",
    (value: ReturnType<typeof activeContract>) => {
      value.nextBillingDate = "2026-11-03T00:00:00Z";
    },
  ],
  [
    "invalid due date",
    (value: ReturnType<typeof activeContract>) => {
      value.nextBillingDate = "not-a-date";
    },
  ],
  [
    "discount",
    (value: ReturnType<typeof activeContract>) => {
      value.discounts.nodes = [{ id: "discount-one" }];
    },
  ],
  [
    "unread discounts",
    (value: ReturnType<typeof activeContract>) => {
      value.discounts.pageInfo.hasNextPage = true;
    },
  ],
  [
    "line discount",
    (value: ReturnType<typeof activeContract>) => {
      value.lines.nodes[0].lineDiscountedPrice.amount = "269.00";
    },
  ],
  [
    "line currency",
    (value: ReturnType<typeof activeContract>) => {
      value.lines.nodes[0].lineDiscountedPrice.currencyCode = "USD";
    },
  ],
] as const)(
  "%s stops billing context before selecting or submitting a cycle",
  async (_, change) => {
    const value = activeContract();
    change(value);
    const client = contextClient(value);
    await expect(
      readMembershipBillingContext(client, contractGid, billingContextNow),
    ).rejects.toMatchObject({ code: "BILLING_CONTEXT_UNSAFE" });
    expect(client).toHaveBeenCalledTimes(1);
  },
);

test.each(["billingPolicy", "discounts"])(
  "missing %s is not evidence that renewal terms are safe",
  async (key) => {
    const value = activeContract();
    Reflect.deleteProperty(value, key);
    const client = contextClient(value);
    await expect(
      readMembershipBillingContext(client, contractGid, billingContextNow),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(client).toHaveBeenCalledTimes(1);
  },
);

test("a missing next billing date never falls back to the app's local cycle", async () => {
  const value = { ...activeContract(), nextBillingDate: null };
  const client = vi.fn().mockResolvedValueOnce(
    response({
      currentAppInstallation: { app: value.app },
      subscriptionContract: value,
    }),
  );
  await expect(
    readMembershipBillingContext(client, contractGid, billingContextNow),
  ).rejects.toMatchObject({ code: "BILLING_CONTEXT_UNSAFE" });
  expect(client).toHaveBeenCalledTimes(1);
});

test("same-price app-managed future metadata is allowed without claiming it locks the charge", async () => {
  const value = activeContract();
  value.lines.nodes[0].pricingPolicy = {
    basePrice: { amount: "299.00", currencyCode: "AUD" },
    cycleDiscounts: [
      {
        afterCycle: 6,
        computedPrice: { amount: "299.00", currencyCode: "AUD" },
      },
    ],
  };
  await expect(
    readMembershipBillingContext(
      contextClient(value),
      contractGid,
      billingContextNow,
    ),
  ).resolves.toMatchObject({ billingCycleSelector: { index: 9 } });
});

test.each(["price", "currency", "invalid amount"])(
  "future pricing metadata %s change blocks the fixed-price Pass",
  async (field) => {
    const value = activeContract();
    value.lines.nodes[0].pricingPolicy = {
      basePrice: { amount: "299.00", currencyCode: "AUD" },
      cycleDiscounts: [
        {
          afterCycle: 6,
          computedPrice: {
            amount:
              field === "price"
                ? "399.00"
                : field === "invalid amount"
                  ? "299.000"
                  : "299.00",
            currencyCode: field === "currency" ? "USD" : "AUD",
          },
        },
      ],
    };
    const client = contextClient(value);
    await expect(
      readMembershipBillingContext(client, contractGid, billingContextNow),
    ).rejects.toMatchObject({ code: "BILLING_CONTEXT_UNSAFE" });
    expect(client).toHaveBeenCalledTimes(1);
  },
);

test.each([
  undefined,
  { basePrice: { amount: "299.00", currencyCode: "AUD" } },
])(
  "missing future-pricing fields cannot be interpreted as no adjustment",
  async (pricingPolicy) => {
    const value = activeContract();
    Reflect.set(value.lines.nodes[0], "pricingPolicy", pricingPolicy);
    const client = contextClient(value);
    await expect(
      readMembershipBillingContext(client, contractGid, billingContextNow),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(client).toHaveBeenCalledTimes(1);
  },
);

test.each([
  [
    "billed",
    (value: ReturnType<typeof cycle>) => {
      value.status = "BILLED";
    },
  ],
  [
    "skipped",
    (value: ReturnType<typeof cycle>) => {
      value.skipped = true;
    },
  ],
  [
    "edited schedule",
    (value: ReturnType<typeof cycle>) => {
      value.edited = true;
    },
  ],
  [
    "edited contract",
    (value: ReturnType<typeof cycle>) => {
      value.editedContract = {
        __typename: "SubscriptionBillingCycleEditedContract",
      };
    },
  ],
  [
    "existing attempt",
    (value: ReturnType<typeof cycle>) => {
      value.billingAttempts.nodes = [
        { id: "gid://shopify/SubscriptionBillingAttempt/existing" },
      ];
    },
  ],
  [
    "unread attempts",
    (value: ReturnType<typeof cycle>) => {
      value.billingAttempts.pageInfo.hasNextPage = true;
    },
  ],
  [
    "another source",
    (value: ReturnType<typeof cycle>) => {
      value.sourceContract.id = "gid://shopify/SubscriptionContract/other";
    },
  ],
  [
    "different expected date",
    (value: ReturnType<typeof cycle>) => {
      value.billingAttemptExpectedDate = "2026-11-01T00:00:00Z";
    },
  ],
  [
    "future expected date",
    (value: ReturnType<typeof cycle>) => {
      value.billingAttemptExpectedDate = "2026-11-03T00:00:00Z";
    },
  ],
  [
    "unrelated date interval",
    (value: ReturnType<typeof cycle>) => {
      value.cycleStartAt = "2026-11-03T00:00:00Z";
    },
  ],
] as const)(
  "%s Shopify cycle cannot be submitted as a new safe renewal",
  async (_, change) => {
    const value = cycle();
    change(value);
    const client = contextClient(activeContract(), value);
    await expect(
      readMembershipBillingContext(client, contractGid, billingContextNow),
    ).rejects.toMatchObject({ code: "BILLING_CONTEXT_UNSAFE" });
    expect(client).toHaveBeenCalledTimes(2);
  },
);

test.each([
  null,
  { cycleIndex: 9 },
  { ...cycle(), billingAttempts: { nodes: [] } },
])("unknown cycle data fails closed", async (value) => {
  const client = contextClient(activeContract(), value);
  await expect(
    readMembershipBillingContext(client, contractGid, billingContextNow),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(client).toHaveBeenCalledTimes(2);
});

test("a lost cycle read cannot authorize a provider submission or expose upstream errors", async () => {
  const client = contextClient();
  client
    .mockReset()
    .mockResolvedValueOnce(
      response({
        currentAppInstallation: { app: activeContract().app },
        subscriptionContract: activeContract(),
      }),
    )
    .mockRejectedValueOnce(new Error("private-provider-details"));
  const error = await readMembershipBillingContext(
    client,
    contractGid,
    billingContextNow,
  ).catch((result) => result);
  expect(error).toMatchObject({ code: "UNAVAILABLE" });
  expect(error.message).not.toContain("private-provider-details");
  expect(client).toHaveBeenCalledTimes(2);
});

test("invalid caller clock does not make a renewal due", async () => {
  const client = vi.fn();
  await expect(
    readMembershipBillingContext(client, contractGid, new Date("invalid")),
  ).rejects.toMatchObject({ code: "BILLING_CONTEXT_UNSAFE" });
  expect(client).not.toHaveBeenCalled();
});

test("a malformed renewal policy remains readable for cancellation and reconciliation", async () => {
  const value = activeContract();
  value.billingPolicy.interval = "WEEK";
  value.discounts.nodes = [{ id: "manual-discount" }];
  const client = contextClient(value);
  await expect(readSubscriptionContract(client, contractGid)).resolves.toEqual(
    value,
  );
  expect(client).toHaveBeenCalledTimes(1);
});

function billing() {
  return {
    id: "gid://shopify/SubscriptionBillingAttempt/10",
    idempotencyKey: "cycle-one-persisted-key",
    ready: false,
    order: null,
    errorCode: null,
    nextActionUrl: null,
    subscriptionContract: { id: contractGid },
  };
}
const billInput = {
  contractGid,
  idempotencyKey: billing().idempotencyKey,
  originTime: new Date("2026-11-02T00:00:00Z"),
  billingCycleSelector: { index: 9 },
};
test("billing preserves its key and due time and rejects overselling or unpaid orders", async () => {
  const value = billing();
  const client = vi.fn().mockResolvedValue(
    response({
      subscriptionBillingAttemptCreate: {
        subscriptionBillingAttempt: value,
        userErrors: [],
      },
    }),
  );
  await expect(
    submitMembershipBilling(client, billInput),
  ).resolves.toMatchObject({ id: value.id, ready: false, orderGid: null });
  expect(client.mock.calls[0][1]).toMatchObject({
    tries: 1,
    variables: {
      contractId: contractGid,
      input: {
        idempotencyKey: billInput.idempotencyKey,
        originTime: "2026-11-02T00:00:00.000Z",
        billingCycleSelector: { index: 9 },
        inventoryPolicy: "PRODUCT_VARIANT_INVENTORY_POLICY",
        paymentProcessingPolicy: "FAIL_UNLESS_VALID_PAYMENT_METHOD",
      },
    },
  });
  expect(client).toHaveBeenCalledTimes(1);
});

test.each([
  undefined,
  null,
  { index: 0 },
  { index: 1.5 },
  { index: Number.MAX_SAFE_INTEGER + 1 },
  { date: "2026-11-02T00:00:00Z" },
  { index: 9, date: "2026-11-02T00:00:00Z" },
])(
  "missing or ambiguous billing selector cannot submit a payment",
  async (selector) => {
    const client = vi.fn();
    await expect(
      submitMembershipBilling(client, {
        ...billInput,
        billingCycleSelector: selector,
      } as Parameters<typeof submitMembershipBilling>[1]),
    ).rejects.toMatchObject({ code: "INVALID_BILLING_ATTEMPT" });
    expect(client).not.toHaveBeenCalled();
  },
);

test("a billing request that times out remains unknown and is not retried", async () => {
  vi.useFakeTimers();
  const client = vi.fn().mockImplementation(() => new Promise(() => {}));
  const result = expect(
    submitMembershipBilling(client, billInput),
  ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUEST_UNKNOWN" });
  await vi.advanceTimersByTimeAsync(6000);
  await result;
  expect(client).toHaveBeenCalledTimes(1);
  expect(client.mock.calls[0][1].signal.aborted).toBe(true);
});

test("billing output must match the same contract and idempotency key", async () => {
  for (const value of [
    { ...billing(), idempotencyKey: "other-key" },
    {
      ...billing(),
      subscriptionContract: { id: "gid://shopify/SubscriptionContract/other" },
    },
  ]) {
    const client = vi.fn().mockResolvedValue(
      response({
        subscriptionBillingAttemptCreate: {
          subscriptionBillingAttempt: value,
          userErrors: [],
        },
      }),
    );
    await expect(
      submitMembershipBilling(client, billInput),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUEST_UNKNOWN" });
  }
});

test("reconciliation reads the original attempt and returns succeeded order identity", async () => {
  const value = {
    ...billing(),
    ready: true,
    order: { id: "gid://shopify/Order/11" },
  };
  const client = vi
    .fn()
    .mockResolvedValue(response({ subscriptionBillingAttempt: value }));
  await expect(readMembershipBilling(client, value.id)).resolves.toMatchObject({
    ready: true,
    orderGid: value.order.id,
  });
  expect(client.mock.calls[0][0]).toContain("query SkyraMembershipBilling");
});

test("contract cancellation errors and unknown responses cannot be reported as cancelled", async () => {
  const client = vi.fn().mockResolvedValue(
    response({
      subscriptionContractCancel: {
        contract: null,
        userErrors: [{ code: "INVALID", message: "upstream-private-text" }],
      },
    }),
  );
  await expect(
    cancelSubscriptionContract(client, contractGid),
  ).rejects.toMatchObject({ code: "CONTRACT_UPDATE_REJECTED" });
  client.mockRejectedValue(new Error("network-key"));
  await expect(
    cancelSubscriptionContract(client, contractGid),
  ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUEST_UNKNOWN" });
});

test("next billing date uses the real period expiry and validates before sending", async () => {
  const date = "2026-12-02T00:00:00.000Z";
  const client = vi.fn().mockResolvedValue(
    response({
      subscriptionContractSetNextBillingDate: {
        contract: { id: contractGid, nextBillingDate: date },
        userErrors: [],
      },
    }),
  );
  await expect(
    setNextBillingDate(client, contractGid, date),
  ).resolves.toMatchObject({ nextBillingDate: date });
  expect(client.mock.calls[0][1].variables).toEqual({ id: contractGid, date });
  await expect(
    setNextBillingDate(client, contractGid, "not-a-date"),
  ).rejects.toThrow();
  expect(client).toHaveBeenCalledTimes(1);
});

test("order reconciliation provides authoritative line/contract, refunds and customer identity", async () => {
  const value = {
    id: "gid://shopify/Order/11",
    displayFinancialStatus: "PAID",
    currencyCode: "AUD",
    cancelledAt: null,
    test: true,
    customer: contract().customer,
    totalReceivedSet: { shopMoney: { amount: "299.00", currencyCode: "AUD" } },
    totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "AUD" } },
    totalPriceSet: { shopMoney: { amount: "299.00", currencyCode: "AUD" } },
    totalDiscountsSet: { shopMoney: { amount: "0.00", currencyCode: "AUD" } },
    totalShippingPriceSet: {
      shopMoney: { amount: "0.00", currencyCode: "AUD" },
    },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/12",
          quantity: 1,
          currentQuantity: 1,
          requiresShipping: false,
          product: { id: target.productGid },
          variant: { id: target.variantGid },
          contract: { id: contractGid },
          sellingPlan: { sellingPlanId: target.sellingPlanGid },
          customAttributes: [
            {
              key: PASS_PURCHASE_REFERENCE_KEY,
              value: "old-first-order-reference",
            },
          ],
          originalUnitPriceSet: {
            shopMoney: { amount: "299.00", currencyCode: "AUD" },
          },
          discountedTotalSet: {
            shopMoney: { amount: "299.00", currencyCode: "AUD" },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
  const client = vi
    .fn()
    .mockImplementation(() => Promise.resolve(response({ order: value })));
  await expect(readMembershipOrder(client, value.id)).resolves.toEqual({
    orderGid: value.id,
    lineItemGid: value.lineItems.nodes[0].id,
    customerGid: value.customer.id,
    productGid: target.productGid,
    variantGid: target.variantGid,
    priceCents: 29900,
    currency: "AUD",
    quantity: 1,
    contractGid,
    paidPriceCents: 29900,
    sellingPlanGid: target.sellingPlanGid,
  });
  await expect(
    readMembershipOrder(client, "gid://shopify/Order/different"),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(client.mock.calls[0][0]).toContain("query SkyraMembershipOrder");
  const free = structuredClone(value);
  free.totalReceivedSet.shopMoney.amount = "0.00";
  free.totalPriceSet.shopMoney.amount = "0.00";
  free.totalDiscountsSet.shopMoney.amount = "299.00";
  free.lineItems.nodes[0].discountedTotalSet.shopMoney.amount = "0.00";
  client.mockImplementation(() => Promise.resolve(response({ order: free })));
  await expect(readMembershipOrder(client, value.id)).resolves.toMatchObject({
    priceCents: 29900,
    paidPriceCents: 0,
  });
  for (const unsafe of [
    { ...value, displayFinancialStatus: "PENDING" },
    { ...value, cancelledAt: "2026-11-01T00:00:00Z" },
    {
      ...value,
      totalRefundedSet: { shopMoney: { amount: "1.00", currencyCode: "AUD" } },
    },
    {
      ...value,
      totalReceivedSet: { shopMoney: { amount: "0.00", currencyCode: "AUD" } },
    },
    {
      ...value,
      totalDiscountsSet: { shopMoney: { amount: "5.00", currencyCode: "AUD" } },
    },
    {
      ...value,
      totalShippingPriceSet: {
        shopMoney: { amount: "5.00", currencyCode: "AUD" },
      },
    },
    {
      ...value,
      lineItems: {
        ...value.lineItems,
        nodes: [...value.lineItems.nodes, ...value.lineItems.nodes],
      },
    },
  ]) {
    client.mockImplementation(() =>
      Promise.resolve(response({ order: unsafe })),
    );
    await expect(readMembershipOrder(client, value.id)).resolves.toBeNull();
  }
});
