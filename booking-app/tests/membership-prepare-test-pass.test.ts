import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { savePass } from "../app/services/catalog.server";
import { bookingProductStatus } from "../app/services/commerce-capabilities.server";
import {
  assertLocalPreparationDatabase,
  prepareTestMonthlyPass,
  TEST_MONTHLY_PASS_NAME,
} from "../scripts/membership-prepare-test-pass";

const domain = "skyra-booking-dev.myshopify.com";
let shopId: string | undefined;
let staffId: string;
let serviceId: string;
let fiveClassId: string;
let previousAuditCount: number;
const args = () => ({
  shopDomain: domain,
  actorId: staffId,
  serviceIds: [serviceId],
});

beforeAll(async () => {
  assertLocalPreparationDatabase(process.env.DATABASE_URL, "test");
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error(
      "These tests require the dedicated skyra_booking_test database.",
    );
  if (await db.shop.findUnique({ where: { domain } }))
    throw new Error(
      "The test dev-shop fixture already exists; preserve it and investigate before running.",
    );
  shopId = (
    await db.shop.create({
      data: { domain, rules: { localMonthlyPreparationFixture: true } },
    })
  ).id;
  staffId = (
    await db.staffAccount.create({
      data: {
        shopId,
        subject: randomUUID(),
        role: "ADMIN",
        displayName: "Test administrator",
      },
    })
  ).id;
  const locationId = (
    await db.location.create({ data: { shopId, name: "Fixture studio" } })
  ).id;
  serviceId = (
    await db.service.create({
      data: {
        shopId,
        name: "Fixture aerial class",
        kind: "CLASS",
        status: "ACTIVE",
        locationId,
        durationMin: 60,
        capacity: 8,
        requestedPriceCents: 4900,
      },
    })
  ).id;
  fiveClassId = (
    await db.passPlan.create({
      data: {
        shopId,
        name: "Existing five-class Pass",
        credits: 5,
        validityDays: 90,
        requestedPriceCents: 22000,
        status: "ACTIVE",
        saleable: true,
      },
    })
  ).id;
});

beforeEach(async () => {
  if (!shopId) return;
  await db.shop.update({ where: { id: shopId }, data: { status: "ACTIVE" } });
  await db.outboxEvent.deleteMany({ where: { shopId } });
  previousAuditCount = await db.auditLog.count({ where: { shopId } });
  await db.productMapping.deleteMany({ where: { shopId } });
  await db.passEligibility.deleteMany({ where: { shopId } });
  await db.passPlan.deleteMany({ where: { shopId, id: { not: fiveClassId } } });
  await db.staffAccount.update({
    where: { id: staffId },
    data: { role: "ADMIN", status: "ACTIVE" },
  });
  await db.service.update({
    where: { id: serviceId },
    data: { kind: "CLASS", status: "ACTIVE" },
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (shopId) {
    await db.outboxEvent.deleteMany({ where: { shopId } });
    await db.productMapping.deleteMany({ where: { shopId } });
    await db.passEligibility.deleteMany({ where: { shopId } });
    await db.passPlan.deleteMany({ where: { shopId } });
    await db.service.deleteMany({ where: { shopId } });
    await db.location.deleteMany({ where: { shopId } });
    await db.staffAccount.deleteMany({ where: { shopId } });
    // AuditLog has an append-only trigger and Shop FK. Retire the fixture shop
    // instead of deleting its audit history or occupying the hard dev domain.
    await db.shop.update({
      where: { id: shopId },
      data: {
        domain: `retired-monthly-fixture-${shopId}.myshopify.com`,
        status: "INACTIVE",
      },
    });
  }
  await db.$disconnect();
});

async function createMonthly(overrides: Record<string, unknown> = {}) {
  return savePass(
    { shopId: shopId!, actorId: staffId, role: "ADMIN" },
    {
      name: TEST_MONTHLY_PASS_NAME,
      status: "DRAFT",
      saleable: false,
      requestedPriceCents: 29900,
      credits: 12,
      validityDays: 30,
      validityMonths: 1,
      introOnly: false,
      serviceIds: [serviceId],
      ...overrides,
    },
  );
}

test("creates one closed monthly Pass through the catalogue service with durable mapping and audit", async () => {
  const result = await prepareTestMonthlyPass(args());
  expect(result.action).toBe("CREATED");
  expect(result.pass).toMatchObject({
    name: TEST_MONTHLY_PASS_NAME,
    requestedPriceCents: 29900,
    credits: 12,
    validityMonths: 1,
    introOnly: false,
    status: "DRAFT",
    saleable: false,
    standalonePurchaseEnabled: false,
    autoRenewEnabled: false,
    sellingPlanGid: null,
    version: 1,
  });
  expect(bookingProductStatus(domain, result.pass)).toBe("DRAFT");
  expect(result.mapping).toMatchObject({
    syncStatus: "PENDING",
    productGid: null,
    variantGid: null,
    requestedVersion: 1,
    shopifyVersion: 0,
  });
  expect(
    await db.passEligibility.findMany({
      where: { passPlanId: result.pass.id },
    }),
  ).toEqual([{ shopId, passPlanId: result.pass.id, serviceId }]);
  expect(
    await db.outboxEvent.findMany({
      where: { shopId, aggregateId: result.pass.id },
    }),
  ).toMatchObject([
    {
      kind: "CATALOG_SYNC",
      version: 1,
      status: "PENDING",
      payload: { ownerType: "PASS_PLAN" },
    },
  ]);
  expect(
    await db.auditLog.findMany({ where: { shopId, entityId: result.pass.id } }),
  ).toMatchObject([{ action: "PASS_SAVED", actorId: staffId }]);
});

test("concurrent invocations and a later retry reuse one Pass and preserve the existing five-class Pass", async () => {
  const original = await db.passPlan.findUniqueOrThrow({
    where: { id: fiveClassId },
  });
  const [a, b] = await Promise.all([
    prepareTestMonthlyPass(args()),
    prepareTestMonthlyPass(args()),
  ]);
  const again = await prepareTestMonthlyPass(args());
  expect([a.action, b.action].sort()).toEqual(["CREATED", "REUSED"]);
  expect(new Set([a.pass.id, b.pass.id, again.pass.id]).size).toBe(1);
  expect(again.action).toBe("REUSED");
  expect(again.pass.version).toBe(1);
  expect(
    await db.passPlan.count({
      where: {
        shopId,
        credits: 12,
        validityMonths: 1,
        requestedPriceCents: 29900,
        introOnly: false,
      },
    }),
  ).toBe(1);
  expect(await db.productMapping.count({ where: { shopId } })).toBe(1);
  expect(await db.outboxEvent.count({ where: { shopId } })).toBe(1);
  expect(
    await db.auditLog.count({ where: { shopId, entityId: again.pass.id } }),
  ).toBe(1);
  expect(
    await db.passPlan.findUniqueOrThrow({ where: { id: fiveClassId } }),
  ).toEqual(original);
});

test("reuses an existing exact monthly Pass without renaming it or rewriting its data", async () => {
  const existing = await createMonthly({
    name: "Previously prepared correct monthly Pass",
  });
  const result = await prepareTestMonthlyPass(args());
  expect(result.action).toBe("REUSED");
  expect(result.pass.id).toBe(existing.id);
  expect(
    await db.passPlan.findUniqueOrThrow({ where: { id: existing.id } }),
  ).toEqual(existing);
  expect(await db.outboxEvent.count({ where: { shopId } })).toBe(1);
});

test("a same-name Pass with different commercial terms is neither overwritten nor duplicated", async () => {
  const existing = await createMonthly({
    credits: 5,
    requestedPriceCents: 22000,
  });
  await expect(prepareTestMonthlyPass(args())).rejects.toThrow(
    "differently configured",
  );
  expect(
    await db.passPlan.findUniqueOrThrow({ where: { id: existing.id } }),
  ).toEqual(existing);
  expect(await db.passPlan.count({ where: { shopId } })).toBe(2);
});

test("multiple equivalent monthly Passes fail closed without selecting or creating another", async () => {
  await createMonthly();
  await createMonthly({ name: "Duplicate existing month" });
  await expect(prepareTestMonthlyPass(args())).rejects.toThrow(
    "Multiple A$299",
  );
  expect(await db.passPlan.count({ where: { shopId } })).toBe(3);
});

test.each([
  "saleable",
  "standalonePurchaseEnabled",
  "autoRenewEnabled",
  "sellingPlanGid",
] as const)(
  "existing %s configuration is preserved for explicit Admin review",
  async (field) => {
    const pass = await createMonthly();
    const existing = await db.passPlan.update({
      where: { id: pass.id },
      data: {
        [field]:
          field === "sellingPlanGid" ? "gid://shopify/SellingPlan/123" : true,
      },
    });
    await expect(prepareTestMonthlyPass(args())).rejects.toThrow(
      "selling or renewal configuration",
    );
    expect(
      await db.passPlan.findUniqueOrThrow({ where: { id: pass.id } }),
    ).toEqual(existing);
  },
);

test("different eligibility on an existing monthly Pass is preserved for review", async () => {
  const pass = await createMonthly();
  await db.passEligibility.deleteMany({ where: { passPlanId: pass.id } });
  await expect(prepareTestMonthlyPass(args())).rejects.toThrow(
    "different eligible classes",
  );
  expect(
    await db.passEligibility.count({ where: { passPlanId: pass.id } }),
  ).toBe(0);
  expect(await db.passPlan.count({ where: { shopId } })).toBe(2);
});

test("an ACTIVE Shopify mapping cannot be reused as a closed local fixture", async () => {
  const pass = await createMonthly();
  await db.productMapping.update({
    where: {
      shopId_ownerType_ownerId: {
        shopId: shopId!,
        ownerType: "PASS_PLAN",
        ownerId: pass.id,
      },
    },
    data: {
      productGid: "gid://shopify/Product/123",
      variantGid: "gid://shopify/ProductVariant/456",
      productStatus: "ACTIVE",
      syncStatus: "SYNCED",
    },
  });
  await expect(prepareTestMonthlyPass(args())).rejects.toThrow(
    "ACTIVE in Shopify",
  );
  expect(
    await db.passPlan.findUniqueOrThrow({ where: { id: pass.id } }),
  ).toEqual(pass);
  expect(await db.passPlan.count({ where: { shopId } })).toBe(2);
});

test("an incomplete existing mapping fails without creating a second monthly Pass", async () => {
  const pass = await createMonthly();
  await db.productMapping.deleteMany({ where: { shopId, ownerId: pass.id } });
  await expect(prepareTestMonthlyPass(args())).rejects.toThrow(
    "no catalogue mapping",
  );
  expect(await db.passPlan.count({ where: { shopId } })).toBe(2);
});

test("an inactive development shop cannot be prepared or reactivated", async () => {
  await db.shop.update({
    where: { id: shopId! },
    data: { status: "INACTIVE" },
  });
  await expect(prepareTestMonthlyPass(args())).rejects.toThrow(
    "shop must be ACTIVE",
  );
  expect(
    (await db.shop.findUniqueOrThrow({ where: { id: shopId! } })).status,
  ).toBe("INACTIVE");
  expect(await db.passPlan.count({ where: { shopId } })).toBe(1);
});

test.each([{ role: "OPERATIONS" }, { role: "COACH" }, { status: "INACTIVE" }])(
  "requires an existing ACTIVE ADMIN in this shop (%j)",
  async (data) => {
    await db.staffAccount.update({ where: { id: staffId }, data });
    await expect(prepareTestMonthlyPass(args())).rejects.toThrow(
      "ACTIVE development-shop ADMIN",
    );
    expect(await db.passPlan.count({ where: { shopId } })).toBe(1);
    expect(await db.auditLog.count({ where: { shopId } })).toBe(
      previousAuditCount,
    );
  },
);

test("unknown staff IDs cannot bootstrap a new Admin or create a Pass", async () => {
  await expect(
    prepareTestMonthlyPass({ ...args(), actorId: randomUUID() }),
  ).rejects.toThrow("ACTIVE development-shop ADMIN");
  expect(await db.staffAccount.count({ where: { shopId } })).toBe(1);
  expect(await db.passPlan.count({ where: { shopId } })).toBe(1);
});

test.each([{ kind: "APPOINTMENT", capacity: 1 }, { status: "INACTIVE" }])(
  "requires existing ACTIVE group classes (%j)",
  async (data) => {
    await db.service.update({ where: { id: serviceId }, data });
    await expect(prepareTestMonthlyPass(args())).rejects.toThrow(
      "ACTIVE group classes",
    );
    expect(await db.passPlan.count({ where: { shopId } })).toBe(1);
  },
);

test("rejects a foreign or absent eligible service ID before writing", async () => {
  await expect(
    prepareTestMonthlyPass({ ...args(), serviceIds: [randomUUID()] }),
  ).rejects.toThrow("ACTIVE group classes");
  expect(await db.passPlan.count({ where: { shopId } })).toBe(1);
});

test("rejects production, another shop, and remote or alternate databases", async () => {
  await expect(
    prepareTestMonthlyPass({
      ...args(),
      shopDomain: "mf0n6s-zg.myshopify.com",
    }),
  ).rejects.toThrow();
  const badTargets = [
    "postgresql://test:secret@database.example:55432/skyra_booking",
    "postgresql://test:secret@127.0.0.1:5432/skyra_booking",
    "postgresql://test:secret@127.0.0.1:55432/production",
    "postgresql://test:secret@127.0.0.1:55432/skyra_booking?schema=private",
    "postgresql://test:secret@127.0.0.1:55432/skyra_booking?host=remote",
  ];
  for (const target of badTargets)
    expect(() => assertLocalPreparationDatabase(target, "development")).toThrow(
      "never production",
    );
  expect(() =>
    assertLocalPreparationDatabase(process.env.DATABASE_URL, "production"),
  ).toThrow("never production");
  expect(() =>
    assertLocalPreparationDatabase(process.env.DATABASE_URL, "development"),
  ).toThrow("never production");
  expect(await db.passPlan.count({ where: { shopId } })).toBe(1);
});
