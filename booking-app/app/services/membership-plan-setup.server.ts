import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import type { Actor } from "./authorization";
import { audit, lockShop } from "./catalog.server";
import { priceInCents } from "./purchase-mapping.server";
import type { GraphQL } from "./shopify-catalog.server";
import { assertMembershipSellingPlan } from "./membership-selling-plan.server";
import { inventoryMembershipCheckout } from "./membership-inventory-checkout.server";

export const CREATE_MONTHLY_PLAN = `#graphql
mutation AdminMonthlyPlanCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput!) {
  sellingPlanGroupCreate(input: $input, resources: $resources) {
    sellingPlanGroup { id sellingPlans(first: 2) { nodes { id } pageInfo { hasNextPage } } }
    userErrors { field message }
  }
}`;

const inputSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
const groupSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/SellingPlanGroup\/[1-9]\d*$/),
  sellingPlans: z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().regex(/^gid:\/\/shopify\/SellingPlan\/[1-9]\d*$/),
        }),
      )
      .length(1),
    pageInfo: z.object({ hasNextPage: z.literal(false) }),
  }),
});

export function legacyTrustedGroup(domain: string) {
  return (
    (domain === "skyra-booking-dev.myshopify.com"
      ? process.env.SKYRA_MEMBERSHIPS_TEST_SELLING_PLAN_GROUP_GID
      : process.env.SKYRA_MEMBERSHIPS_SELLING_PLAN_GROUP_GID) || ""
  );
}

export async function configureMonthlyPlan(
  actor: Actor,
  raw: unknown,
  admin: GraphQL,
  domain: string,
) {
  if (actor.role !== "ADMIN")
    throw new DomainError("FORBIDDEN", "Administrator access required.", 403);
  const input = inputSchema.parse(raw);
  // Commit the creation claim BEFORE Shopify. A double click, crash or lost
  // response must never blindly create another plan. No network I/O under lock.
  const { pass, mapping, create } = await db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const pass = await tx.passPlan.findFirst({
      where: { id: input.id, shopId: actor.shopId },
      include: { services: { include: { service: true } } },
    });
    if (!pass) throw new DomainError("NOT_FOUND", "Pass not found.", 404);
    if (
      pass.version !== input.version ||
      pass.updatedAt.toISOString() !== input.updatedAt
    )
      throw new DomainError(
        "CONFLICT",
        "This Pass changed. Refresh before configuring renewal.",
        409,
      );
    if (
      pass.validityMonths !== 1 ||
      pass.introOnly ||
      pass.requestedPriceCents <= 0 ||
      !pass.services.length ||
      pass.services.some((s) => s.service.status !== "ACTIVE") ||
      new Set(pass.services.map((s) => s.service.kind)).size !== 1
    )
      throw new DomainError(
        "INVALID_RENEWAL_PLAN",
        "Choose at least one active eligible class of one type, a positive price and one calendar month, without a first-time-customer restriction.",
      );
    if (["CREATING", "UNKNOWN"].includes(pass.renewalSetupState))
      throw new DomainError(
        "RENEWAL_SETUP_PENDING",
        "The previous Shopify creation is still being checked. No duplicate plan will be created. Contact support if this status persists.",
        409,
      );
    const mapping = await tx.productMapping.findUnique({
      where: {
        shopId_ownerType_ownerId: {
          shopId: actor.shopId,
          ownerType: "PASS_PLAN",
          ownerId: pass.id,
        },
      },
    });
    if (
      !mapping?.productGid ||
      !mapping.variantGid ||
      mapping.syncStatus !== "SYNCED" ||
      mapping.shopifyVersion !== pass.version ||
      mapping.requestedVersion !== pass.version ||
      priceInCents(mapping.publishedPrice) !== pass.requestedPriceCents
    )
      throw new DomainError(
        "SYNC_REQUIRED",
        "Wait for product synchronization in Classes & Passes, then try again.",
        409,
      );
    const create = !pass.sellingPlanGid;
    await tx.passPlan.update({
      where: { id: pass.id },
      data: { renewalSetupState: create ? "CREATING" : "VERIFYING" },
    });
    await audit(tx, actor, "MEMBERSHIP_PLAN_SETUP_STARTED", pass.id, null, {
      create,
      version: pass.version,
      variantGid: mapping.variantGid,
    });
    return { pass, mapping, create };
  });
  let groupGid = pass.sellingPlanGroupGid || legacyTrustedGroup(domain);
  let planGid = pass.sellingPlanGid;
  if (create) {
    try {
      const response = await admin(CREATE_MONTHLY_PLAN, {
        tries: 1,
        signal: AbortSignal.timeout(12000),
        variables: {
          input: {
            name: `${pass.name} — monthly renewal`,
            merchantCode: `skyra-pass-${pass.id}`,
            options: ["Pass renewal"],
            sellingPlansToCreate: [
              {
                name: "Renew after the activated Pass expires",
                options: ["Monthly Pass renewal"],
                category: "SUBSCRIPTION",
                description:
                  "Each paid Pass starts at its first staff-confirmed attendance and lasts one calendar month. The renewed Pass waits for its own first attendance. Cancel to stop future renewals.",
                billingPolicy: {
                  recurring: {
                    interval: "MONTH",
                    intervalCount: 1,
                    minCycles: 1,
                  },
                },
                deliveryPolicy: {
                  recurring: {
                    interval: "MONTH",
                    intervalCount: 1,
                    intent: "FULFILLMENT_BEGIN",
                    preAnchorBehavior: "ASAP",
                  },
                },
                pricingPolicies: [
                  {
                    fixed: {
                      adjustmentType: "PERCENTAGE",
                      adjustmentValue: { percentage: 0 },
                    },
                  },
                ],
                inventoryPolicy: { reserve: "ON_SALE" },
              },
            ],
          },
          resources: {
            productVariantIds: inventoryMembershipCheckout()
              ? []
              : [mapping.variantGid],
          },
        },
      });
      const payload = await response.json();
      const result = payload.data?.sellingPlanGroupCreate;
      if (
        response.ok &&
        !payload.errors?.length &&
        result?.userErrors?.length &&
        !result.sellingPlanGroup
      ) {
        await db.passPlan.update({
          where: { id: pass.id },
          data: { renewalSetupState: "REJECTED" },
        });
        throw new DomainError(
          "RENEWAL_SETUP_REJECTED",
          "Shopify could not create the plan. Check this app's subscription permissions and the store's subscription eligibility, then retry.",
          409,
        );
      }
      if (!response.ok || payload.errors?.length || result?.userErrors?.length)
        throw new Error("Uncertain creation");
      const group = groupSchema.parse(result?.sellingPlanGroup);
      groupGid = group.id;
      planGid = group.sellingPlans.nodes[0].id;
      // Retain creator evidence before readback, so readback failure is retryable
      // without repeating the mutation. These IDs never come from the form.
      await db.passPlan.update({
        where: { id: pass.id },
        data: {
          sellingPlanGroupGid: groupGid,
          sellingPlanGid: planGid,
          renewalSetupState: "VERIFYING",
        },
      });
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "RENEWAL_SETUP_REJECTED"
      )
        throw error;
      await db.passPlan.updateMany({
        where: { id: pass.id, renewalSetupState: "CREATING" },
        data: { renewalSetupState: "UNKNOWN" },
      });
      throw new DomainError(
        "RENEWAL_SETUP_UNKNOWN",
        "Shopify creation could not be confirmed. The Pass has not been enabled for renewal. The original result needs review before creating another plan.",
        503,
      );
    }
  }
  await assertMembershipSellingPlan(admin, {
    trustedGroupGid: groupGid,
    sellingPlanGid: planGid || "",
    productGid: mapping.productGid!,
    variantGid: mapping.variantGid!,
    priceCents: pass.requestedPriceCents,
    currency: "AUD",
    ...(inventoryMembershipCheckout()
      ? { association: "DETACHED" as const }
      : {}),
  });
  await db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const updated = await tx.passPlan.updateMany({
      where: {
        id: pass.id,
        shopId: actor.shopId,
        version: pass.version,
        sellingPlanGid: planGid,
        renewalSetupState: "VERIFYING",
      },
      data: { sellingPlanGroupGid: groupGid, renewalSetupState: "READY" },
    });
    if (updated.count !== 1)
      throw new DomainError(
        "CONFLICT",
        "Pass changed. Refresh and verify the existing plan again.",
        409,
      );
    await audit(tx, actor, "MEMBERSHIP_PLAN_VERIFIED", pass.id, null, {
      groupGid,
      sellingPlanGid: planGid,
      version: pass.version,
    });
  });
}
