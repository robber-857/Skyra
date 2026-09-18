import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  adminClients,
  adminClientDetail,
  clientPassState,
} from "../app/services/admin-clients.server";
import {
  refreshClientContacts,
  importShopifyClients,
} from "../app/services/client-contacts.server";
import { clientName } from "../app/services/client-identity";
import { bookingReports } from "../app/services/booking-reports.server";
const actorFor = (shopId: string) => ({
  shopId,
  actorId: randomUUID(),
  role: "ADMIN" as const,
});
const node = (id = "gid://shopify/Customer/123", firstName = "Alice") => ({
  id,
  firstName,
  lastName: "Chen",
  defaultEmailAddress: { emailAddress: "alice@example.com" },
});
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());

test("display names use preferred or Shopify names, then email without exposing IDs", () => {
  expect(
    clientName({
      preferredName: " Ally ",
      shopifyName: "Alice Chen",
      email: "a@example.com",
    }),
  ).toBe("Ally");
  expect(
    clientName({ preferredName: " ", shopifyName: "Alice Chen", email: null }),
  ).toBe("Alice Chen");
  expect(
    clientName({ preferredName: "", shopifyName: "", email: "a@example.com" }),
  ).toBe("a@example.com");
  expect(clientName({ preferredName: "", shopifyName: "", email: null })).toBe(
    "Unnamed client",
  );
});
test("Pass states respect expiry boundaries, future starts, exhaustion and revocation", () => {
  const now = new Date("2026-09-18T00:00:00Z"),
    pass = {
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 1),
      expiresAt: new Date(now.getTime() + 1),
    };
  expect(clientPassState(pass, 1, now)).toBe("ACTIVE");
  expect(clientPassState(pass, 0, now)).toBe("EXHAUSTED");
  expect(clientPassState({ ...pass, expiresAt: now }, 1, now)).toBe("EXPIRED");
  expect(
    clientPassState({ ...pass, startsAt: new Date(now.getTime() + 1) }, 1, now),
  ).toBe("UPCOMING");
  expect(clientPassState({ ...pass, status: "REVOKED" }, 1, now)).toBe(
    "REVOKED",
  );
});
test("directory and profiles isolate shops, reject Coaches and derive reserved/remaining credits from ledger", async () => {
  const f = await paidFixture(),
    other = await paidFixture(),
    actor = actorFor(f.shop.id);
  await processPaidBookingEvent((await queuePaid(f)).id);
  await db.customerProfile.update({
    where: { id: f.customer.id },
    data: {
      shopifyName: "Alice Chen",
      email: "alice@example.com",
      trainingGoals: "Strength",
      signature: "Hello",
    },
  });
  const list = await adminClients(actor, {});
  expect(list.total).toBe(1);
  expect(list.clients[0]).toMatchObject({
    name: "Alice Chen",
    email: "alice@example.com",
    activePasses: 1,
    remaining: 5,
    bookings: 1,
  });
  expect((await adminClients(actor, { q: "ALICE@" })).total).toBe(1);
  expect((await adminClients(actor, { q: "Chen" })).total).toBe(1);
  expect((await adminClients(actor, { q: "nobody" })).clients).toEqual([]);
  const detail = await adminClientDetail(actor, f.customer.id);
  expect(detail.client).toMatchObject({
    name: "Alice Chen",
    trainingGoals: "Strength",
    signature: "Hello",
  });
  expect(detail.passes[0]).toMatchObject({
    name: "Five Class Pass",
    granted: 5,
    available: 4,
    reserved: 1,
    used: 0,
    remaining: 5,
    status: "ACTIVE",
    validityDays: 30,
  });
  expect(detail.bookings).toHaveLength(1);
  expect(JSON.stringify(detail)).not.toContain("?key=");
  await expect(
    adminClientDetail(actor, other.customer.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    adminClients({ ...actor, role: "COACH" }, {}),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    adminClientDetail({ ...actor, role: "COACH" }, f.customer.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const reports = await bookingReports(actor, {});
  expect(reports.spending.rows[0].customerName).toBe("Alice Chen");
  expect(reports.unusedPasses.rows[0].customerName).toBe("Alice Chen");
  await db.entitlement.update({
    where: { id: detail.passes[0].id },
    data: { status: "REVOKED" },
  });
  const expired = await db.entitlement.create({
    data: {
      shopId: f.shop.id,
      customerId: f.customer.id,
      passPlanId: f.plan.id,
      productMappingId: f.mapping.id,
      sourceOrderGid: "gid://shopify/Order/1002",
      sourceLineItemGid: "gid://shopify/LineItem/2002",
      grantedUnits: 5,
      startsAt: new Date(Date.now() - 31 * 86400000),
      expiresAt: new Date(Date.now() - 86400000),
    },
  });
  await db.entitlementLedgerEntry.create({
    data: {
      shopId: f.shop.id,
      entitlementId: expired.id,
      kind: "GRANT",
      availableDelta: 5,
      reservedDelta: 0,
      consumedDelta: 0,
      idempotencyKey: randomUUID(),
    },
  });
  expect(
    (await adminClientDetail(actor, f.customer.id)).passes.find(
      (p) => p.id === expired.id,
    ),
  ).toMatchObject({ status: "EXPIRED", remaining: 5, daysLeft: 0 });
  expect((await adminClients(actor, {})).clients[0]).toMatchObject({
    activePasses: 0,
    remaining: 0,
  });
});
test("contact refresh uses recorded shop identities and never updates a different shop or profile content", async () => {
  const f = await paidFixture(),
    other = await paidFixture(),
    actor = actorFor(f.shop.id);
  await db.customerProfile.update({
    where: { id: f.customer.id },
    data: { preferredName: "Ally", trainingGoals: "Strength" },
  });
  const graphql = vi.fn(async () =>
    Response.json({ data: { nodes: [node()] } }),
  );
  await refreshClientContacts(actor, graphql, [
    f.customer.id,
    other.customer.id,
  ]);
  expect(graphql.mock.calls).toHaveLength(1);
  expect(
    await db.customerProfile.findUniqueOrThrow({
      where: { id: f.customer.id },
    }),
  ).toMatchObject({
    shopifyName: "Alice Chen",
    email: "alice@example.com",
    preferredName: "Ally",
    trainingGoals: "Strength",
  });
  expect(
    await db.customerProfile.findUniqueOrThrow({
      where: { id: other.customer.id },
    }),
  ).toMatchObject({ shopifyName: "", email: null });
  await refreshClientContacts(actor, graphql);
  expect(graphql.mock.calls).toHaveLength(1);
  await expect(
    refreshClientContacts({ ...actor, role: "COACH" }, graphql),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
test("permission errors, redacted and mismatched results preserve contact data and remain recoverable", async () => {
  const f = await paidFixture(),
    actor = actorFor(f.shop.id);
  await db.customerProfile.update({
    where: { id: f.customer.id },
    data: { shopifyName: "Original", email: "original@example.com" },
  });
  for (const payload of [
    { data: { nodes: [node()] }, errors: [{ message: "denied" }] },
    { data: { nodes: [node("gid://shopify/Customer/999")] } },
    { data: { nodes: [] } },
  ]) {
    await expect(
      refreshClientContacts(actor, async () => Response.json(payload)),
    ).rejects.toMatchObject({ code: "CUSTOMER_DATA_UNAVAILABLE" });
    expect(
      await db.customerProfile.findUniqueOrThrow({
        where: { id: f.customer.id },
      }),
    ).toMatchObject({ shopifyName: "Original", email: "original@example.com" });
  }
  await expect(
    refreshClientContacts(actor, async () => {
      throw new Error("secret access token");
    }),
  ).rejects.toThrow("Shopify customer details could not be read");
  await refreshClientContacts(actor, async () =>
    Response.json({ data: { nodes: [null] } }),
  );
  expect(
    await db.customerProfile.findUniqueOrThrow({
      where: { id: f.customer.id },
    }),
  ).toMatchObject({ shopifyName: "", email: null });
});
test("Shopify import upserts clients idempotently, retains profiles and returns a continuation cursor", async () => {
  const f = await paidFixture(),
    actor = actorFor(f.shop.id);
  await db.customerProfile.update({
    where: { id: f.customer.id },
    data: { preferredName: "Ally" },
  });
  const graphql = vi.fn(async () =>
    Response.json({
      data: {
        customers: {
          nodes: [node(), node("gid://shopify/Customer/999", "Bob")],
          pageInfo: { hasNextPage: true, endCursor: "next-page" },
        },
      },
    }),
  );
  expect(await importShopifyClients(actor, graphql, {})).toMatchObject({
    nextCursor: "next-page",
  });
  await importShopifyClients(actor, graphql, { after: "next-page" });
  expect((await adminClients(actor, {})).total).toBe(2);
  expect((await adminClientDetail(actor, f.customer.id)).client.name).toBe(
    "Ally",
  );
  await expect(
    importShopifyClients({ ...actor, role: "COACH" }, graphql, {}),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
test("client pagination clamps empty/out-of-range pages and retains deterministic boundaries", async () => {
  const f = await paidFixture(),
    actor = actorFor(f.shop.id);
  await db.customerProfile.createMany({
    data: Array.from({ length: 52 }, (_, i) => ({
      shopId: f.shop.id,
      shopifyCustomerGid: `gid://shopify/Customer/${1000 + i}`,
      shopifyName: `Client ${String(i).padStart(3, "0")}`,
    })),
  });
  const a = await adminClients(actor, {}),
    b = await adminClients(actor, { page: 999 });
  expect(a.clients).toHaveLength(50);
  expect(b.clients).toHaveLength(3);
  expect(b.page).toBe(2);
  expect(new Set([...a.clients, ...b.clients].map((c) => c.id)).size).toBe(53);
  await expect(adminClients(actor, { page: "oops" })).rejects.toThrow();
});
