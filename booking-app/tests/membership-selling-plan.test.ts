import { afterEach, expect, test, vi } from "vitest";
import {
  assertMembershipSellingPlan,
  MEMBERSHIP_SELLING_PLAN_READ,
  type MembershipSellingPlanTarget,
} from "../app/services/membership-selling-plan.server";

const target: MembershipSellingPlanTarget = {
  trustedGroupGid: "gid://shopify/SellingPlanGroup/400",
  productGid: "gid://shopify/Product/200",
  variantGid: "gid://shopify/ProductVariant/300",
  sellingPlanGid: "gid://shopify/SellingPlan/500",
  priceCents: 29900,
  currency: "AUD",
};
function data() {
  return {
    shop: { currencyCode: "AUD" },
    productVariant: {
      id: target.variantGid,
      price: "299.00",
      product: { id: target.productGid },
    },
    sellingPlanGroups: {
      nodes: [
        {
          id: target.trustedGroupGid,
          appliesToProduct: true,
          appliesToProductVariant: false,
          sellingPlans: {
            nodes: [
              {
                id: target.sellingPlanGid,
                category: "SUBSCRIPTION",
                billingPolicy: {
                  __typename: "SellingPlanRecurringBillingPolicy",
                  interval: "MONTH",
                  intervalCount: 1,
                  anchors: [] as unknown[],
                  minCycles: null as number | null,
                  maxCycles: null as number | null,
                },
                deliveryPolicy: {
                  __typename: "SellingPlanRecurringDeliveryPolicy",
                  interval: "MONTH",
                  intervalCount: 1,
                  anchors: [] as unknown[],
                  cutoff: null as number | null,
                  intent: "FULFILLMENT_BEGIN",
                  preAnchorBehavior: "ASAP",
                },
                pricingPolicies: [] as unknown[],
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
}
function fixedPrice(amount = "299.00", currencyCode = "AUD") {
  return {
    __typename: "SellingPlanFixedPricingPolicy",
    adjustmentType: "PRICE",
    adjustmentValue: { __typename: "MoneyV2", amount, currencyCode },
  };
}
const clientFor = (value: unknown) =>
  vi.fn().mockResolvedValue(Response.json({ data: value }));
const unavailable = { code: "MEMBERSHIP_SELLING_PLAN_UNAVAILABLE" };
const mismatch = { code: "MEMBERSHIP_SELLING_PLAN_MISMATCH" };
afterEach(() => vi.useRealTimers());

test("proves a backend-approved group through the calling app filter before permitting a monthly plan", async () => {
  const client = clientFor(data());
  await expect(assertMembershipSellingPlan(client, target)).resolves.toEqual({
    groupGid: target.trustedGroupGid,
    sellingPlanGid: target.sellingPlanGid,
    priceCents: 29900,
    currency: "AUD",
  });
  expect(client).toHaveBeenCalledOnce();
  expect(client.mock.calls[0][0]).toBe(MEMBERSHIP_SELLING_PLAN_READ);
  expect(client.mock.calls[0][0]).not.toMatch(/\bmutation\b/);
  expect(client.mock.calls[0][1]).toMatchObject({
    tries: 1,
    variables: {
      groupQuery: "app_id:CURRENT AND id:400",
      productGid: target.productGid,
      variantGid: target.variantGid,
    },
  });
});

test("missing or malformed trusted group provenance rejects before any Shopify request", async () => {
  for (const trustedGroupGid of [
    "",
    "gid://shopify/SellingPlanGroup/0",
    "gid://shopify/SellingPlanGroup/400 OR app_id:ALL",
  ]) {
    const client = clientFor(data());
    await expect(
      assertMembershipSellingPlan(client, { ...target, trustedGroupGid }),
    ).rejects.toMatchObject(unavailable);
    expect(client).not.toHaveBeenCalled();
  }
});

test("a foreign app plan absent from CURRENT cannot be approved by a pasted selling-plan ID", async () => {
  const value = data();
  value.sellingPlanGroups.nodes = [];
  await expect(
    assertMembershipSellingPlan(clientFor(value), target),
  ).rejects.toMatchObject(mismatch);
});

test("a matching display appId never establishes group ownership", async () => {
  const value = data();
  const forged = {
    ...value.sellingPlanGroups.nodes[0],
    id: "gid://shopify/SellingPlanGroup/999",
    appId: "expected-app-display-id",
  };
  value.sellingPlanGroups.nodes = [forged];
  await expect(
    assertMembershipSellingPlan(clientFor(value), target),
  ).rejects.toMatchObject(mismatch);
});

test("requires exact group, selected plan, product, variant and AUD variant price", async () => {
  for (const change of [
    (v: ReturnType<typeof data>) => {
      v.productVariant.id = "gid://shopify/ProductVariant/999";
    },
    (v: ReturnType<typeof data>) => {
      v.productVariant.product.id = "gid://shopify/Product/999";
    },
    (v: ReturnType<typeof data>) => {
      v.productVariant.price = "300.00";
    },
    (v: ReturnType<typeof data>) => {
      v.productVariant.price = "299.0000000000000001";
    },
    (v: ReturnType<typeof data>) => {
      v.shop.currencyCode = "USD";
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].id =
        "gid://shopify/SellingPlan/999";
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].appliesToProduct = false;
    },
  ]) {
    const value = data();
    change(value);
    await expect(
      assertMembershipSellingPlan(clientFor(value), target),
    ).rejects.toMatchObject(mismatch);
  }
});

test("an explicitly associated variant is sufficient without a whole-product association", async () => {
  const value = data();
  value.sellingPlanGroups.nodes[0].appliesToProduct = false;
  value.sellingPlanGroups.nodes[0].appliesToProductVariant = true;
  await expect(
    assertMembershipSellingPlan(clientFor(value), target),
  ).resolves.toMatchObject({ sellingPlanGid: target.sellingPlanGid });
});

test("rejects fixed, prepaid, nonmonthly, anchored and minimum-commitment billing or delivery", async () => {
  for (const change of [
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].category = "PRE_ORDER";
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].billingPolicy.__typename =
        "SellingPlanFixedBillingPolicy";
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].billingPolicy.interval =
        "YEAR";
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].billingPolicy.intervalCount = 3;
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].billingPolicy.minCycles = 2;
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].billingPolicy.maxCycles = 12;
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].billingPolicy.anchors =
        [{ type: "MONTHDAY" }];
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].deliveryPolicy.interval =
        "WEEK";
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].deliveryPolicy.intervalCount = 2;
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].deliveryPolicy.anchors =
        [{ type: "MONTHDAY" }];
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].deliveryPolicy.cutoff = 1;
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].deliveryPolicy.preAnchorBehavior =
        "NEXT";
    },
  ]) {
    const value = data();
    change(value);
    await expect(
      assertMembershipSellingPlan(clientFor(value), target),
    ).rejects.toMatchObject(mismatch);
  }
});

test("supports no adjustment, zero fixed discounts or one snapshot fixed AUD price", async () => {
  for (const policy of [
    fixedPrice("299.0000"),
    {
      __typename: "SellingPlanFixedPricingPolicy",
      adjustmentType: "FIXED_AMOUNT",
      adjustmentValue: {
        __typename: "MoneyV2",
        amount: "0.00",
        currencyCode: "AUD",
      },
    },
    {
      __typename: "SellingPlanFixedPricingPolicy",
      adjustmentType: "PERCENTAGE",
      adjustmentValue: {
        __typename: "SellingPlanPricingPolicyPercentageValue",
        percentage: 0,
      },
    },
  ]) {
    const value = data();
    value.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].pricingPolicies = [
      policy,
    ];
    await expect(
      assertMembershipSellingPlan(clientFor(value), target),
    ).resolves.toMatchObject({ priceCents: 29900 });
  }
});

test("future-cycle rules, nonzero discounts, altered prices/currencies and unknown policies fail closed", async () => {
  for (const policies of [
    [
      {
        ...fixedPrice(),
        __typename: "SellingPlanRecurringPricingPolicy",
        afterCycle: 1,
      },
    ],
    [
      fixedPrice(),
      {
        ...fixedPrice(),
        __typename: "SellingPlanRecurringPricingPolicy",
        afterCycle: 1,
      },
    ],
    [fixedPrice("399.00")],
    [fixedPrice("299.00", "USD")],
    [fixedPrice("299.0000000000000001")],
    [fixedPrice("9007199254740991.00")],
    [
      {
        __typename: "SellingPlanFixedPricingPolicy",
        adjustmentType: "PERCENTAGE",
        adjustmentValue: {
          __typename: "SellingPlanPricingPolicyPercentageValue",
          percentage: 10,
        },
      },
    ],
    [
      {
        __typename: "SellingPlanFixedPricingPolicy",
        adjustmentType: "FIXED_AMOUNT",
        adjustmentValue: {
          __typename: "MoneyV2",
          amount: "1.00",
          currencyCode: "AUD",
        },
      },
    ],
    [{ __typename: "NewUnsupportedPolicy" }],
  ]) {
    const value = data();
    value.sellingPlanGroups.nodes[0].sellingPlans.nodes[0].pricingPolicies =
      policies;
    await expect(
      assertMembershipSellingPlan(clientFor(value), target),
    ).rejects.toMatchObject(mismatch);
  }
});

test("incomplete, duplicate and malformed Shopify observations cannot prove authorization", async () => {
  for (const change of [
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.pageInfo.hasNextPage = true;
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.pageInfo.hasNextPage = true;
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes.push(v.sellingPlanGroups.nodes[0]);
    },
    (v: ReturnType<typeof data>) => {
      v.sellingPlanGroups.nodes[0].sellingPlans.nodes.push(
        v.sellingPlanGroups.nodes[0].sellingPlans.nodes[0],
      );
    },
  ]) {
    const value = data();
    change(value);
    await expect(
      assertMembershipSellingPlan(clientFor(value), target),
    ).rejects.toHaveProperty("code");
  }
  await expect(
    assertMembershipSellingPlan(
      clientFor({ shop: { currencyCode: "AUD" } }),
      target,
    ),
  ).rejects.toMatchObject(unavailable);
});

test("upstream denial or transport failure is redacted and never retried", async () => {
  const denied = vi
    .fn()
    .mockResolvedValue(
      Response.json({
        errors: [{ message: "sensitive-upstream-token" }],
        data: data(),
      }),
    );
  await expect(
    assertMembershipSellingPlan(denied, target),
  ).rejects.toMatchObject(unavailable);
  expect(denied).toHaveBeenCalledOnce();
  const broken = vi
    .fn()
    .mockRejectedValue(new Error("sensitive-upstream-token"));
  await expect(
    assertMembershipSellingPlan(broken, target),
  ).rejects.not.toHaveProperty("message", expect.stringContaining("sensitive"));
  expect(broken).toHaveBeenCalledOnce();
});

test("an unanswered read aborts without authorizing or issuing another request", async () => {
  vi.useFakeTimers();
  const client = vi.fn().mockImplementation(() => new Promise(() => {}));
  const result = expect(
    assertMembershipSellingPlan(client, target),
  ).rejects.toMatchObject(unavailable);
  await vi.advanceTimersByTimeAsync(6001);
  await result;
  expect(client).toHaveBeenCalledOnce();
  expect(client.mock.calls[0][1].signal.aborted).toBe(true);
});


test.each([3, 6, 12])("verifies %s-month plans and rejects either provider interval drifting", async (months) => {
  const value = data();
  const plan = value.sellingPlanGroups.nodes[0].sellingPlans.nodes[0];
  plan.billingPolicy.intervalCount = months;
  plan.deliveryPolicy.intervalCount = months;
  await expect(assertMembershipSellingPlan(clientFor(value), { ...target, validityMonths: months })).resolves.toBeDefined();
  plan.billingPolicy.intervalCount = 1;
  await expect(assertMembershipSellingPlan(clientFor(value), { ...target, validityMonths: months })).rejects.toMatchObject(mismatch);
  plan.billingPolicy.intervalCount = months;
  plan.deliveryPolicy.intervalCount = 1;
  await expect(assertMembershipSellingPlan(clientFor(value), { ...target, validityMonths: months })).rejects.toMatchObject(mismatch);
});
