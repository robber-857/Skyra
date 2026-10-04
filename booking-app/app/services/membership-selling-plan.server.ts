import { z } from "zod";
import { DomainError } from "../lib/errors.server";
import type { GraphQL } from "./shopify-catalog.server";

// appId is a developer-supplied display string, not the creating app's identity.
// trustedGroupGid must come from a backend record of this app's successful
// group creation (or its HMAC-verified creator webhook), never a customer or
// a freely pasted catalog field. CURRENT is an additional server-side check.
export const MEMBERSHIP_SELLING_PLAN_READ = `#graphql
query MembershipSellingPlan($groupQuery: String!, $productGid: ID!, $variantGid: ID!) {
  shop { currencyCode }
  productVariant(id: $variantGid) {
    id price product { id }
  }
  sellingPlanGroups(first: 2, query: $groupQuery) {
    nodes {
      id
      appliesToProduct(productId: $productGid)
      appliesToProductVariant(productVariantId: $variantGid)
      sellingPlans(first: 100) {
        nodes {
          id category
          billingPolicy {
            __typename
            ... on SellingPlanRecurringBillingPolicy {
              interval intervalCount minCycles maxCycles anchors { type }
            }
          }
          deliveryPolicy {
            __typename
            ... on SellingPlanRecurringDeliveryPolicy {
              interval intervalCount anchors { type } cutoff intent preAnchorBehavior
            }
          }
          pricingPolicies {
            __typename
            ... on SellingPlanFixedPricingPolicy {
              adjustmentType
              adjustmentValue {
                __typename
                ... on MoneyV2 { amount currencyCode }
                ... on SellingPlanPricingPolicyPercentageValue { percentage }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage }
  }
}`;

const gid = (owner: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${owner}/[1-9]\\d*$`));
const targetSchema = z
  .object({
    trustedGroupGid: gid("SellingPlanGroup"),
    productGid: gid("Product"),
    variantGid: gid("ProductVariant"),
    sellingPlanGid: gid("SellingPlan"),
    priceCents: z.number().int().positive().safe(),
    currency: z.literal("AUD"),
  })
  .strict();
export type MembershipSellingPlanTarget = z.infer<typeof targetSchema>;
const pageInfo = z.object({ hasNextPage: z.boolean() });
const dataSchema = z.object({
  shop: z.object({ currencyCode: z.string() }),
  productVariant: z
    .object({
      id: gid("ProductVariant"),
      price: z.string(),
      product: z.object({ id: gid("Product") }),
    })
    .nullable(),
  sellingPlanGroups: z.object({
    nodes: z.array(
      z.object({
        id: gid("SellingPlanGroup"),
        appliesToProduct: z.boolean(),
        appliesToProductVariant: z.boolean(),
        sellingPlans: z.object({
          nodes: z.array(
            z.object({
              id: gid("SellingPlan"),
              category: z.string().nullable(),
              billingPolicy: z.unknown(),
              deliveryPolicy: z.unknown(),
              pricingPolicies: z.array(z.unknown()),
            }),
          ),
          pageInfo,
        }),
      }),
    ),
    pageInfo,
  }),
});
const billingSchema = z.object({
  __typename: z.literal("SellingPlanRecurringBillingPolicy"),
  interval: z.literal("MONTH"),
  intervalCount: z.literal(1),
  anchors: z.array(z.unknown()).length(0),
  minCycles: z.number().int().min(0).max(1).nullable(),
  maxCycles: z.null(),
});
const deliverySchema = z.object({
  __typename: z.literal("SellingPlanRecurringDeliveryPolicy"),
  interval: z.literal("MONTH"),
  intervalCount: z.literal(1),
  anchors: z.array(z.unknown()).length(0),
  cutoff: z.literal(0).nullable(),
  intent: z.literal("FULFILLMENT_BEGIN"),
  preAnchorBehavior: z.literal("ASAP"),
});
const policySchema = z.object({
  __typename: z.literal("SellingPlanFixedPricingPolicy"),
  adjustmentType: z.enum(["PRICE", "FIXED_AMOUNT", "PERCENTAGE"]),
  adjustmentValue: z.discriminatedUnion("__typename", [
    z.object({
      __typename: z.literal("MoneyV2"),
      amount: z.string(),
      currencyCode: z.literal("AUD"),
    }),
    z.object({
      __typename: z.literal("SellingPlanPricingPolicyPercentageValue"),
      percentage: z.number().finite(),
    }),
  ]),
});

// Compare wire decimals as integer cents, including trailing zeros, without
// allowing fractional-cent rounding or a Number overflow to authorize billing.
function cents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (/[^0]/.test(fraction.slice(2))) return null;
  const result =
    BigInt(match[1]) * 100n + BigInt((fraction + "00").slice(0, 2));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}
function safePricing(policies: unknown[], priceCents: number) {
  // An unadjusted variant or one fixed, unchanged price is supported. Future
  // cycle rules require a separate consent/versioning design and are rejected.
  if (!policies.length) return true;
  if (policies.length !== 1) return false;
  const parsed = policySchema.safeParse(policies[0]);
  if (!parsed.success) return false;
  const policy = parsed.data;
  if (policy.adjustmentType === "PERCENTAGE")
    return (
      policy.adjustmentValue.__typename ===
        "SellingPlanPricingPolicyPercentageValue" &&
      policy.adjustmentValue.percentage === 0
    );
  if (policy.adjustmentValue.__typename !== "MoneyV2") return false;
  return (
    cents(policy.adjustmentValue.amount) ===
    (policy.adjustmentType === "PRICE" ? priceCents : 0)
  );
}
function unavailable() {
  return new DomainError(
    "MEMBERSHIP_SELLING_PLAN_UNAVAILABLE",
    "We could not verify this monthly renewal plan. Please contact the studio before paying.",
    503,
  );
}
function mismatch() {
  return new DomainError(
    "MEMBERSHIP_SELLING_PLAN_MISMATCH",
    "This renewal plan does not match the monthly Pass terms. Please contact the studio before paying.",
    409,
  );
}

export async function assertMembershipSellingPlan(
  admin: GraphQL,
  input: MembershipSellingPlanTarget,
) {
  const target = targetSchema.safeParse(input);
  if (!target.success) throw unavailable();
  const expected = target.data;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let data: unknown;
  try {
    data = await Promise.race([
      (async () => {
        const response = await admin(MEMBERSHIP_SELLING_PLAN_READ, {
          variables: {
            groupQuery: `app_id:CURRENT AND id:${expected.trustedGroupGid.split("/").at(-1)!}`,
            productGid: expected.productGid,
            variantGid: expected.variantGid,
          },
          tries: 1,
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok || payload.errors?.length || !payload.data)
          throw unavailable();
        return payload.data as unknown;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(unavailable());
        }, 6000);
      }),
    ]);
  } catch {
    // No provider error text, customer data or credentials escape this adapter.
    throw unavailable();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const parsed = dataSchema.safeParse(data);
  if (!parsed.success) throw unavailable();
  const {
    shop,
    productVariant: variant,
    sellingPlanGroups: groups,
  } = parsed.data;
  const group = groups.nodes[0];
  if (groups.pageInfo.hasNextPage || group?.sellingPlans.pageInfo.hasNextPage)
    throw unavailable();
  const plans =
    group?.sellingPlans.nodes.filter(
      (plan) => plan.id === expected.sellingPlanGid,
    ) ?? [];
  const plan = plans[0];
  if (
    shop.currencyCode !== "AUD" ||
    variant?.id !== expected.variantGid ||
    variant.product.id !== expected.productGid ||
    cents(variant.price) !== expected.priceCents ||
    groups.nodes.length !== 1 ||
    group?.id !== expected.trustedGroupGid ||
    !(group.appliesToProduct || group.appliesToProductVariant) ||
    plans.length !== 1 ||
    plan?.category !== "SUBSCRIPTION" ||
    !billingSchema.safeParse(plan.billingPolicy).success ||
    !deliverySchema.safeParse(plan.deliveryPolicy).success ||
    !safePricing(plan.pricingPolicies, expected.priceCents)
  )
    throw mismatch();
  return {
    groupGid: group.id,
    sellingPlanGid: plan.id,
    priceCents: expected.priceCents,
    currency: "AUD" as const,
  };
}
