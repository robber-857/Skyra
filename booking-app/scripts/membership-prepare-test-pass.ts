import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import db from "../app/db.server";
import { savePass } from "../app/services/catalog.server";
import { DEVELOPMENT_BOOKING_SHOP } from "../app/services/commerce-capabilities.server";

export const TEST_MONTHLY_PASS_NAME = "[DEV] SKYRA Lifestyle 1 month";

const optionsInput = z.object({
  actorId: z.string().uuid(),
  serviceIds: z.array(z.string().uuid()).min(1).max(200),
  shopDomain: z.literal(DEVELOPMENT_BOOKING_SHOP),
});

export function assertLocalPreparationDatabase(
  databaseUrl: string | undefined,
  nodeEnv: string | undefined,
) {
  let target: URL;
  try {
    target = new URL(databaseUrl || "");
  } catch {
    throw new Error("A local development DATABASE_URL is required.");
  }
  if (
    nodeEnv === "production" ||
    !["postgresql:", "postgres:"].includes(target.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    target.port !== "55432" ||
    !(
      target.pathname === "/skyra_booking" ||
      (nodeEnv === "test" && target.pathname === "/skyra_booking_test")
    ) ||
    target.searchParams
      .getAll("schema")
      .some(
        (schema) =>
          schema !== "public" &&
          !(
            nodeEnv === "test" &&
            target.pathname === "/skyra_booking_test" &&
            /^skyra_test_[a-z0-9_]+$/.test(schema)
          ),
      ) ||
    target.searchParams.has("host")
  ) {
    throw new Error(
      "Preparation is limited to the local development database and never production.",
    );
  }
}

/**
 * Local fixture preparation only. This never reads a Shopify token, calls a
 * provider, or enables sales. savePass queues the usual DRAFT catalogue sync.
 * The transaction holds an advisory lock across savePass's own transaction so
 * concurrent invocations of this script reuse the committed first creation.
 */
export async function prepareTestMonthlyPass(raw: unknown) {
  const input = optionsInput.parse(raw);
  assertLocalPreparationDatabase(
    process.env.DATABASE_URL,
    process.env.NODE_ENV,
  );
  const serviceIds = [...new Set(input.serviceIds)];

  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${DEVELOPMENT_BOOKING_SHOP}), hashtext(${"membership-prepare-test-pass-v1"}))`;
      const shop = await tx.shop.findUnique({
        where: { domain: DEVELOPMENT_BOOKING_SHOP },
        select: { id: true, domain: true, status: true },
      });
      if (!shop || shop.status !== "ACTIVE")
        throw new Error("The existing development shop must be ACTIVE.");

      const staff = await tx.staffAccount.findFirst({
        where: {
          id: input.actorId,
          shopId: shop.id,
          role: "ADMIN",
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (!staff)
        throw new Error("Choose an existing ACTIVE development-shop ADMIN.");

      const services = await tx.service.findMany({
        where: {
          shopId: shop.id,
          id: { in: serviceIds },
          status: "ACTIVE",
          kind: "CLASS",
        },
        select: { id: true },
      });
      if (services.length !== serviceIds.length)
        throw new Error(
          "Choose existing ACTIVE group classes from the development shop.",
        );

      const candidates = await tx.passPlan.findMany({
        where: {
          shopId: shop.id,
          OR: [
            { name: TEST_MONTHLY_PASS_NAME },
            {
              requestedPriceCents: 29900,
              credits: 12,
              validityMonths: 1,
              introOnly: false,
            },
          ],
        },
      });
      const matches = candidates.filter(
        (pass) =>
          pass.requestedPriceCents === 29900 &&
          pass.credits === 12 &&
          pass.validityMonths === 1 &&
          pass.introOnly === false,
      );
      if (
        candidates.some(
          (pass) =>
            pass.name === TEST_MONTHLY_PASS_NAME &&
            !matches.some((match) => match.id === pass.id),
        )
      )
        throw new Error(
          "A differently configured Pass already uses the test monthly name. Review it without overwriting.",
        );
      if (matches.length > 1)
        throw new Error(
          "Multiple A$299 / 12-class / one-month Passes exist. Select one in Admin before preparation.",
        );

      const existing = matches[0];
      if (
        existing &&
        (existing.saleable ||
          existing.standalonePurchaseEnabled ||
          existing.autoRenewEnabled ||
          existing.sellingPlanGid !== null)
      )
        throw new Error(
          "The existing monthly Pass has selling or renewal configuration. Review it in Admin; preparation will not overwrite it.",
        );
      if (existing) {
        const eligibility = await tx.passEligibility.findMany({
          where: { shopId: shop.id, passPlanId: existing.id },
          select: { serviceId: true },
        });
        if (
          eligibility.length !== serviceIds.length ||
          eligibility.some((entry) => !serviceIds.includes(entry.serviceId))
        )
          throw new Error(
            "The existing monthly Pass has different eligible classes. Review it in Admin without overwriting.",
          );
      }

      const pass =
        existing ??
        (await savePass(
          { shopId: shop.id, actorId: staff.id, role: "ADMIN" },
          {
            name: TEST_MONTHLY_PASS_NAME,
            status: "DRAFT",
            requestedPriceCents: 29900,
            credits: 12,
            // Required legacy field; calendar validityMonths takes precedence.
            validityDays: 30,
            validityMonths: 1,
            introOnly: false,
            saleable: false,
            serviceIds,
          },
        ));

      const mapping = await tx.productMapping.findUnique({
        where: {
          shopId_ownerType_ownerId: {
            shopId: shop.id,
            ownerType: "PASS_PLAN",
            ownerId: pass.id,
          },
        },
        select: {
          id: true,
          productGid: true,
          variantGid: true,
          syncStatus: true,
          requestedVersion: true,
          shopifyVersion: true,
          productStatus: true,
        },
      });
      if (!mapping)
        throw new Error(
          "The existing monthly Pass has no catalogue mapping. Repair it in Classes & Passes before continuing.",
        );
      if (mapping.productStatus === "ACTIVE")
        throw new Error(
          "The existing monthly product is ACTIVE in Shopify. Review it before reusing a closed test fixture.",
        );
      return {
        shop,
        action: existing ? ("REUSED" as const) : ("CREATED" as const),
        pass: {
          id: pass.id,
          name: pass.name,
          requestedPriceCents: pass.requestedPriceCents,
          credits: pass.credits,
          validityMonths: pass.validityMonths,
          introOnly: pass.introOnly,
          status: pass.status,
          saleable: pass.saleable,
          standalonePurchaseEnabled: pass.standalonePurchaseEnabled,
          autoRenewEnabled: pass.autoRenewEnabled,
          sellingPlanGid: pass.sellingPlanGid,
          version: pass.version,
          serviceIds,
        },
        mapping,
        checkout: "CLOSED" as const,
        nextStep:
          "Synchronize the DRAFT product, verify the native payment guard and same-app selling plan, then enable test sales separately.",
      };
    },
    {
      timeout: 30000,
      maxWait: 10000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}

async function main() {
  const [mode, actorId, ...serviceIds] = process.argv.slice(2);
  if (mode !== "--prepare-local-test-pass" || !actorId || !serviceIds.length)
    throw new Error(
      "Usage: tsx --env-file=.env scripts/membership-prepare-test-pass.ts --prepare-local-test-pass <existing-admin-uuid> <existing-class-uuid> [...class-uuids]",
    );
  // The executable entry point never accepts the dedicated unit-test database.
  assertLocalPreparationDatabase(process.env.DATABASE_URL, "development");
  try {
    const result = await prepareTestMonthlyPass({
      shopDomain: DEVELOPMENT_BOOKING_SHOP,
      actorId,
      serviceIds,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.$disconnect();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
