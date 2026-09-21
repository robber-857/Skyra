import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  bookingReports,
  reportDateRange,
} from "../app/services/booking-reports.server";
import { adminContext } from "../app/services/context.server";
import { loader as reportLoader } from "../app/routes/app.reports";
import { loader as exportLoader } from "../app/routes/app.reports.export";
vi.mock("../app/services/context.server", () => ({ adminContext: vi.fn() }));
vi.mock("../app/services/client-contacts.server", () => ({
  refreshClientContacts: vi.fn(),
}));
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());

test("client search filters both reports by partial names or email in this shop without a full customer directory", async () => {
  const f = await paidFixture(),
    other = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  await processPaidBookingEvent((await queuePaid(other)).id);
  await db.customerProfile.update({
    where: { id: f.customer.id },
    data: {
      preferredName: "Ally",
      shopifyName: "Alice O'Connor",
      email: "alice_test@example.com",
    },
  });
  await db.customerProfile.update({
    where: { id: other.customer.id },
    data: { preferredName: "Foreign client" },
  });
  const bob = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/999",
      preferredName: "Bob",
    },
  });
  const pass = await db.entitlement.create({
    data: {
      shopId: f.shop.id,
      customerId: bob.id,
      passPlanId: f.plan.id,
      productMappingId: f.mapping.id,
      sourceOrderGid: "gid://shopify/Order/999",
      sourceLineItemGid: "gid://shopify/LineItem/999",
      grantedUnits: 5,
      startsAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  await db.entitlementLedgerEntry.create({
    data: {
      shopId: f.shop.id,
      entitlementId: pass.id,
      kind: "GRANT",
      availableDelta: 5,
      reservedDelta: 0,
      consumedDelta: 0,
      idempotencyKey: randomUUID(),
    },
  });
  const actor = {
    shopId: f.shop.id,
    actorId: "SEARCH_TEST",
    role: "ADMIN" as const,
  };
  for (const q of [" alLY ", "o'CONNOR", "ALICE_TEST@", "_"]) {
    const result = await bookingReports(actor, { q });
    expect(result.spending.rows.map((r) => r.customerId)).toEqual([
      f.customer.id,
    ]);
    expect(result.spending.totalSpendCents).toBe(22000);
    expect(result.unusedPasses.rows.map((r) => r.customerId)).toEqual([
      f.customer.id,
    ]);
    expect(result.unusedPasses.credits).toBe(5);
    expect(result).not.toHaveProperty("customers");
  }
  for (const q of ["missing", "Foreign client", "%", "' OR 1=1 --"]) {
    const result = await bookingReports(actor, { q });
    expect(result.spending.rows).toEqual([]);
    expect(result.spending.totalSpendCents).toBe(0);
    expect(result.unusedPasses.rows).toEqual([]);
    expect(result.unusedPasses.credits).toBe(0);
  }
  expect(
    (await bookingReports(actor, { q: "   " })).unusedPasses.customers,
  ).toBe(2);
  expect(
    (await bookingReports(actor, { customer: bob.id, q: "Ally" })).spending
      .rows[0].customerId,
  ).toBe(f.customer.id);
  expect(
    (await bookingReports(actor, { customer: bob.id })).unusedPasses.rows[0]
      .customerId,
  ).toBe(bob.id);
  await expect(
    bookingReports({ ...actor, role: "COACH" }, { q: "Ally" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });

  vi.mocked(adminContext).mockResolvedValue({
    actor,
    admin: { graphql: vi.fn() },
  } as unknown as Awaited<ReturnType<typeof adminContext>>);
  const args = (path: string) => ({
    request: new Request(`https://example.com${path}`),
    url: new URL(`https://example.com${path}`),
    params: {},
    context: {},
    pattern: "/app/reports",
  });
  const view = await reportLoader(args("/app/reports?q=Bob"));
  expect(view.data?.spending.rows).toEqual([]);
  expect(view.data?.unusedPasses.rows.map((r) => r.customerId)).toEqual([
    bob.id,
  ]);
  for (const type of ["spending", "unused", "both"]) {
    const response = await exportLoader(
      args(`/app/reports/export?type=${type}&q=Bob`),
    );
    const body = await response.text();
    expect(body).not.toContain("Ally");
    if (type !== "spending") expect(body).toContain("Bob");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  }
});

test("client search trims input, limits query length and preserves custom date ranges", () => {
  expect(
    reportDateRange(
      { q: "  Alice  ", range: "custom", from: "2026-09-01", to: "2026-09-21" },
      "Australia/Sydney",
    ),
  ).toMatchObject({ search: "Alice", from: "2026-09-01", to: "2026-09-21" });
  expect(() =>
    reportDateRange({ q: "a".repeat(161) }, "Australia/Sydney"),
  ).toThrow();
});
