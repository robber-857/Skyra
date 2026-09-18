import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { adminClientDetail } from "../app/services/admin-clients.server";
import { customerAccountData } from "../app/services/customer-account.server";
import {
  restoredPassNavigation,
  withPassNavigation,
} from "../extensions/skyra-customer-account/src/pass-navigation";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
async function fixture() {
  const f = await paidFixture(),
    clock = Date.now();
  await db.entitlement.createMany({
    data: Array.from({ length: 12 }, (_, i) => ({
      shopId: f.shop.id,
      customerId: f.customer.id,
      productMappingId: f.mapping.id,
      passPlanId: f.plan.id,
      sourceOrderGid: `gid://shopify/Order/${5000 + i}`,
      sourceLineItemGid: `gid://shopify/LineItem/${6000 + i}`,
      grantedUnits: 5,
      startsAt: new Date(clock - 86400000),
      expiresAt: new Date(clock + 29 * 86400000),
      createdAt: new Date(clock),
    })),
  });
  const passes = await db.entitlement.findMany({
    where: { shopId: f.shop.id },
    orderBy: { id: "desc" },
  });
  await db.entitlementLedgerEntry.createMany({
    data: passes.map((p) => ({
      shopId: f.shop.id,
      entitlementId: p.id,
      kind: "GRANT",
      availableDelta: 5,
      reservedDelta: 0,
      consumedDelta: 0,
      idempotencyKey: randomUUID(),
    })),
  });
  return {
    ...f,
    passes,
    admin: { shopId: f.shop.id, actorId: randomUUID(), role: "ADMIN" as const },
    actor: { shopId: f.shop.id, customerGid: f.customer.shopifyCustomerGid },
  };
}
test("Admin and Customer Pass pages are five items, ordered identically, and jumps and repeated reads stay stable", async () => {
  const f = await fixture();
  const admin = await Promise.all(
    [1, 2, 3].map((passPage) =>
      adminClientDetail(f.admin, f.customer.id, { passPage }),
    ),
  );
  const customer = await Promise.all(
    [1, 2, 3].map((page) =>
      customerAccountData(f.actor, { view: "passes", page }),
    ),
  );
  expect(admin.map((p) => p.passes.length)).toEqual([5, 5, 2]);
  expect(customer.map((p) => p.passes.length)).toEqual([5, 5, 2]);
  expect(customer.map((p) => p.page)).toEqual([1, 2, 3]);
  for (let i = 0; i < 3; i++) {
    expect(customer[i]).toMatchObject({
      totalPages: 3,
      totalPasses: 12,
      nextCursor: null,
    });
    expect(admin[i]).toMatchObject({ pages: 3, total: 12 });
    expect(customer[i].passes.map((p) => p.id)).toEqual(
      admin[i].passes.map((p) => p.id),
    );
    expect(
      customer[i].passes.every(
        (p) => p.available === 5 && p.used === 0 && p.reserved === 0,
      ),
    ).toBe(true);
  }
  expect(new Set(customer.flatMap((p) => p.passes.map((p) => p.id))).size).toBe(
    12,
  );
  expect(
    (
      await customerAccountData(f.actor, { view: "passes", page: "2" })
    ).passes.map((p) => p.id),
  ).toEqual(customer[1].passes.map((p) => p.id));
  expect(
    await customerAccountData(f.actor, { view: "passes", page: 999 }),
  ).toMatchObject({ page: 3, totalPages: 3 });
  expect(
    await adminClientDetail(f.admin, f.customer.id, { passPage: 999 }),
  ).toMatchObject({ page: 3, pages: 3 });
  // Preserve the older cursor contract used by Overview and previously released extensions.
  expect(
    (await customerAccountData(f.actor, { view: "passes" })).passes,
  ).toHaveLength(12);
});
test("Pass pagination stays customer/shop scoped and rejects identity overrides or conflicting cursor/page inputs", async () => {
  const f = await fixture();
  const other = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/456",
    },
  });
  const empty = await customerAccountData(
    { ...f.actor, customerGid: other.shopifyCustomerGid },
    { view: "passes", page: 2 },
  );
  expect(empty).toMatchObject({
    page: 1,
    totalPages: 1,
    totalPasses: 0,
    passes: [],
  });
  expect(
    await customerAccountData(
      { ...f.actor, customerGid: "gid://shopify/Customer/789" },
      { view: "passes", page: 2 },
    ),
  ).toMatchObject({ page: 1, totalPages: 1, totalPasses: 0, passes: [] });
  await expect(
    customerAccountData(
      { ...f.actor, customerGid: other.shopifyCustomerGid },
      { view: "passes", cursor: f.passes[0].id },
    ),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(
    customerAccountData(f.actor, {
      view: "passes",
      page: 2,
      customerId: other.id,
    }),
  ).rejects.toThrow();
  await expect(
    customerAccountData(f.actor, {
      view: "passes",
      page: 2,
      cursor: f.passes[0].id,
    }),
  ).rejects.toMatchObject({ code: "INVALID_PAGE" });
  for (const page of [0, -1, 1.5, "oops", 100001])
    await expect(
      customerAccountData(f.actor, { view: "passes", page }),
    ).rejects.toThrow();
  await expect(
    customerAccountData(f.actor, { view: "upcoming", page: 2 }),
  ).rejects.toMatchObject({ code: "INVALID_PAGE" });
  await expect(
    customerAccountData(
      { ...f.actor, customerGid: null },
      { view: "passes", page: 2 },
    ),
  ).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
  const foreign = await paidFixture();
  await expect(
    adminClientDetail({ ...f.admin, shopId: foreign.shop.id }, f.customer.id, {
      passPage: 2,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
test("Customer navigation state restores the Pass tab and page without trusting invalid state or overwriting host state", () => {
  const state = withPassNavigation({ hostSetting: "keep" }, true, 3);
  expect(state).toMatchObject({
    hostSetting: "keep",
    skyraPasses: { active: true, page: 3 },
  });
  expect(restoredPassNavigation(JSON.parse(JSON.stringify(state)))).toEqual({
    active: true,
    page: 3,
  });
  expect(restoredPassNavigation(withPassNavigation(state, false, 3))).toEqual({
    active: false,
    page: 3,
  });
  for (const value of [
    null,
    {},
    "oops",
    { skyraPasses: { page: -1 } },
    { skyraPasses: { page: "3" } },
    { skyraPasses: { page: Infinity } },
  ])
    expect(restoredPassNavigation(value).page).toBe(1);
});
