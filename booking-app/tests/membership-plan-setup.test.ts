import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { savePass } from "../app/services/catalog.server";
import { configureMonthlyPlan } from "../app/services/membership-plan-setup.server";
import {
  eligibleEntitlements,
  grantEntitlement,
} from "../app/services/entitlements.server";
import { DomainError } from "../app/lib/errors.server";
import { paidFixture } from "./paid-fixture";

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../app/services/membership-selling-plan.server", () => ({
  assertMembershipSellingPlan: mocks.verify,
}));
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Test database required");
});
beforeEach(() => {
  mocks.verify.mockReset();
  mocks.verify.mockResolvedValue({});
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());

test("Basic plan creation leaves the public template variant detached", async () => {
  vi.stubEnv("SKYRA_MEMBERSHIPS_CHECKOUT_PROTECTION", "INVENTORY");
  const f = await fixture();
  await f.run();
  expect(f.admin).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    variables: expect.objectContaining({ resources: { productVariantIds: [] } }),
  }));
  expect(mocks.verify).toHaveBeenCalledWith(f.admin, expect.objectContaining({ association: "DETACHED" }));
});

async function fixture() {
  const f = await paidFixture("NEW_PASS", false, "APPOINTMENT", 1);
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  await db.productMapping.update({
    where: { id: f.mapping.id },
    data: {
      syncStatus: "SYNCED",
      requestedVersion: 1,
      shopifyVersion: 1,
      publishedPrice: "220.00",
      productStatus: "ACTIVE",
    },
  });
  const admin = vi.fn(async () =>
    Response.json({
      data: {
        sellingPlanGroupCreate: {
          sellingPlanGroup: {
            id: "gid://shopify/SellingPlanGroup/700",
            sellingPlans: {
              nodes: [{ id: "gid://shopify/SellingPlan/701" }],
              pageInfo: { hasNextPage: false },
            },
          },
          userErrors: [],
        },
      },
    }),
  );
  const current = () =>
    db.passPlan.findUniqueOrThrow({ where: { id: f.plan.id } });
  const run = async () => {
    const pass = await current();
    return configureMonthlyPlan(
      actor,
      {
        id: pass.id,
        version: pass.version,
        updatedAt: pass.updatedAt.toISOString(),
      },
      admin,
      f.shop.domain,
    );
  };
  return { ...f, actor, admin, run, current };
}

test("admin creates the plan for exactly the mapped variant, verifies it and retains per-Pass trust", async () => {
  const f = await fixture();
  await f.run();
  expect(f.admin).toHaveBeenCalledTimes(1);
  expect(f.admin).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      tries: 1,
      variables: expect.objectContaining({
        resources: { productVariantIds: [f.mapping.variantGid] },
      }),
    }),
  );
  expect(mocks.verify).toHaveBeenCalledWith(
    f.admin,
    expect.objectContaining({
      trustedGroupGid: "gid://shopify/SellingPlanGroup/700",
      sellingPlanGid: "gid://shopify/SellingPlan/701",
      priceCents: 22000,
    }),
  );
  expect(await f.current()).toMatchObject({
    renewalSetupState: "READY",
    sellingPlanGroupGid: "gid://shopify/SellingPlanGroup/700",
    autoRenewEnabled: false,
  });
  await f.run();
  expect(f.admin).toHaveBeenCalledTimes(1);
});

test("concurrent submissions create only one Shopify plan", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.run(), f.run()]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(f.admin).toHaveBeenCalledTimes(1);
});

test("readback failure retains creator IDs and retries verification without another creation", async () => {
  const f = await fixture();
  mocks.verify.mockRejectedValueOnce(
    new DomainError("MEMBERSHIP_SELLING_PLAN_UNAVAILABLE", "Unavailable"),
  );
  await expect(f.run()).rejects.toMatchObject({
    code: "MEMBERSHIP_SELLING_PLAN_UNAVAILABLE",
  });
  expect(await f.current()).toMatchObject({
    renewalSetupState: "VERIFYING",
    autoRenewEnabled: false,
  });
  await f.run();
  expect(f.admin).toHaveBeenCalledTimes(1);
  expect((await f.current()).renewalSetupState).toBe("READY");
});

test("lost creation response blocks any blind retry", async () => {
  const f = await fixture();
  f.admin.mockRejectedValueOnce(new Error("Network lost"));
  await expect(f.run()).rejects.toMatchObject({
    code: "RENEWAL_SETUP_UNKNOWN",
  });
  await expect(f.run()).rejects.toMatchObject({
    code: "RENEWAL_SETUP_PENDING",
  });
  expect(f.admin).toHaveBeenCalledTimes(1);
  expect(await f.current()).toMatchObject({
    renewalSetupState: "UNKNOWN",
    sellingPlanGid: null,
    autoRenewEnabled: false,
  });
});

test("Shopify's explicit rejection is safely retryable", async () => {
  const f = await fixture();
  f.admin.mockResolvedValueOnce(
    Response.json({
      data: {
        sellingPlanGroupCreate: {
          sellingPlanGroup: null,
          userErrors: [{ message: "Denied" }],
        },
      },
    }),
  );
  await expect(f.run()).rejects.toMatchObject({
    code: "RENEWAL_SETUP_REJECTED",
  });
  expect((await f.current()).renewalSetupState).toBe("REJECTED");
  await f.run();
  expect((await f.current()).renewalSetupState).toBe("READY");
});

test.each(["empty", "inactive", "mixed", "foreign"])(
  "invalid course selection (%s) cannot create a renewal plan",
  async (kind) => {
    const f = await fixture();
    if (kind === "empty")
      await db.passEligibility.deleteMany({ where: { passPlanId: f.plan.id } });
    if (kind === "inactive")
      await db.service.update({
        where: { id: f.service.id },
        data: { status: "INACTIVE" },
      });
    if (kind === "mixed") {
      const service = await db.service.create({
        data: {
          shopId: f.shop.id,
          locationId: f.location.id,
          name: "Group",
          kind: "CLASS",
          requestedPriceCents: 5000,
          durationMin: 60,
          capacity: 8,
          status: "ACTIVE",
        },
      });
      await expect(
        savePass(f.actor, {
          ...(await f.current()),
          serviceIds: [f.service.id, service.id],
        }),
      ).rejects.toMatchObject({ code: "PASS_TYPE_MISMATCH" });
      expect(f.admin).not.toHaveBeenCalled();
      return;
    }
    if (kind === "foreign") f.actor.shopId = randomUUID();
    await expect(f.run()).rejects.toHaveProperty(
      "code",
      kind === "foreign" ? "NOT_FOUND" : "INVALID_RENEWAL_PLAN",
    );
    expect(f.admin).not.toHaveBeenCalled();
  },
);

test("unsynchronized product cannot create a plan", async () => {
  const f = await fixture();
  await db.productMapping.update({
    where: { id: f.mapping.id },
    data: { syncStatus: "PENDING" },
  });
  await expect(f.run()).rejects.toMatchObject({ code: "SYNC_REQUIRED" });
  expect(f.admin).not.toHaveBeenCalled();
});

test("a retained draft course does not block renewal setup for an otherwise active course scope", async () => {
  const f = await fixture();
  const draft = await db.service.create({data: {
    shopId: f.shop.id, locationId: f.location.id, name: "Draft private class",
    kind: "APPOINTMENT", requestedPriceCents: 5000, durationMin: 60, capacity: 1, status: "DRAFT",
  }});
  await db.passPlan.update({where: {id:f.plan.id},data:{services:{create:{serviceId:draft.id}}}});
  await f.run();
  expect((await f.current()).renewalSetupState).toBe("READY");
  expect(await db.passPlan.findUnique({where: {id:f.plan.id},include:{services:true}})).toMatchObject({services:expect.arrayContaining([expect.objectContaining({serviceId:draft.id})])});
});

test("configured Pass changes require re-verification and preserve existing terms", async () => {
  const f = await fixture();
  await f.run();
  const pass = await f.current();
  await db.passPlan.update({
    where: { id: pass.id },
    data: { autoRenewEnabled: true },
  });
  await savePass(f.actor, {
    ...pass,
    requestedPriceCents: 23000,
    serviceIds: [f.service.id],
  });
  expect(await f.current()).toMatchObject({
    renewalSetupState: "VERIFYING",
    autoRenewEnabled: false,
    sellingPlanGid: pass.sellingPlanGid,
  });
  await expect(f.run()).rejects.toMatchObject({ code: "SYNC_REQUIRED" });
});

test("existing renewal members prevent changing eligible classes", async () => {
  const f = await fixture();
  await f.run();
  await db.passMembership.create({
    data: {
      shopId: f.shop.id,
      customerId: f.customer.id,
      passPlanId: f.plan.id,
    },
  });
  const other = await db.service.create({
    data: {
      shopId: f.shop.id,
      locationId: f.location.id,
      name: "Other private",
      kind: "APPOINTMENT",
      requestedPriceCents: 5000,
      durationMin: 60,
      capacity: 1,
      status: "ACTIVE",
    },
  });
  await expect(
    savePass(f.actor, { ...(await f.current()), serviceIds: [other.id] }),
  ).rejects.toMatchObject({ code: "RENEWAL_CLASSES_LOCKED" });
});

test("paid private monthly credits are usable only for explicitly selected courses", async () => {
  const f = await fixture();
  await f.run();
  await grantEntitlement({
    shopId: f.shop.id,
    customerId: f.customer.id,
    passPlanId: f.plan.id,
    productMappingId: f.mapping.id,
    sourceOrderGid: "gid://shopify/Order/700",
    sourceLineItemGid: "gid://shopify/LineItem/701",
    startsAt: null,
    expiresAt: null,
    validityMonths: 1,
    grantedUnits: 5,
    idempotencyKey: randomUUID(),
  });
  const eligible = (serviceId: string) =>
    eligibleEntitlements(db, {
      shopId: f.shop.id,
      customerId: f.customer.id,
      serviceId,
      sessionStartsAt: f.session.startsAt,
      now: new Date(),
    });
  expect(await eligible(f.service.id)).toHaveLength(1);
  for (const kind of ["APPOINTMENT", "CLASS"]) {
    const other = await db.service.create({
      data: {
        shopId: f.shop.id,
        locationId: f.location.id,
        name: "Not selected",
        kind,
        requestedPriceCents: 5000,
        durationMin: 60,
        capacity: 1,
        status: "ACTIVE",
      },
    });
    expect(await eligible(other.id)).toHaveLength(0);
  }
});
