import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, test } from "vitest";
import db from "../app/db.server";
import { saveService, savePass } from "../app/services/catalog.server";
import {
  addSessions,
  publishWeek,
  copyPreviousWeek,
} from "../app/services/schedule.server";
import { localInstant } from "../app/lib/time";
import {
  syncCatalogEvent,
  recordSyncFailure,
  type GraphQL,
} from "../app/services/shopify-catalog.server";
import type { Actor } from "../app/services/authorization";

let actor: Actor;
let other: Actor;
let locationId: string;
let coachId: string;
let serviceId: string;
let service: Awaited<ReturnType<typeof saveService>>;
const input = () => ({
  name: "Integration aerial class",
  status: "ACTIVE",
  durationMin: 60,
  capacity: 8,
  requestedPriceCents: 4900,
  locationId,
  coachIds: [coachId],
});
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.pathname !== "/skyra_booking_test")
    throw new Error("Tests require the dedicated skyra_booking_test database.");
  const shop = await db.shop.create({
    data: { domain: "test-" + randomUUID() + ".myshopify.com" },
  });
  const second = await db.shop.create({
    data: { domain: "test-" + randomUUID() + ".myshopify.com" },
  });
  actor = { shopId: shop.id, actorId: "test-admin", role: "ADMIN" };
  other = { shopId: second.id, actorId: "other-admin", role: "ADMIN" };
  locationId = (
    await db.location.create({ data: { shopId: shop.id, name: "Studio A" } })
  ).id;
  coachId = (
    await db.coach.create({
      data: { shopId: shop.id, name: "Test coach", bufferAfterMin: 15 },
    })
  ).id;
});
afterAll(async () => {
  await db.$disconnect();
});

test("Class save creates a durable mapping, sync outbox and audit atomically", async () => {
  service = await saveService(actor, input());
  serviceId = service.id;
  expect(
    await db.productMapping.count({
      where: { shopId: actor.shopId, ownerId: serviceId },
    }),
  ).toBe(1);
  expect(
    await db.outboxEvent.count({
      where: { shopId: actor.shopId, aggregateId: serviceId },
    }),
  ).toBe(1);
  expect(
    await db.auditLog.count({
      where: { shopId: actor.shopId, entityId: serviceId },
    }),
  ).toBe(1);
});
test("Coach role cannot edit the catalogue", async () => {
  await expect(
    saveService({ ...actor, role: "COACH" }, input()),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
test("Cross-shop foreign references and entity edits are rejected", async () => {
  await expect(saveService(other, input())).rejects.toMatchObject({
    code: "INVALID_REFERENCE",
  });
  await expect(
    saveService(other, { ...input(), id: serviceId, version: 1 }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    db.serviceCoach.create({
      data: { shopId: other.shopId, serviceId, coachId },
    }),
  ).rejects.toThrow();
});
test("Stale catalogue update cannot overwrite a newer edit", async () => {
  service = await saveService(actor, {
    ...input(),
    id: serviceId,
    version: 1,
    name: "Updated class",
  });
  await expect(
    saveService(actor, { ...input(), id: serviceId, version: 1 }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
test("Pass requires eligible services belonging to its shop", async () => {
  const pass = {
    name: "Ten class pass",
    status: "ACTIVE",
    credits: 10,
    validityDays: 90,
    requestedPriceCents: 42000,
    serviceIds: [serviceId],
  };
  await expect(savePass(other, pass)).rejects.toMatchObject({
    code: "INVALID_REFERENCE",
  });
  const saved = await savePass(actor, pass);
  expect(
    await db.passEligibility.count({ where: { passPlanId: saved.id } }),
  ).toBe(1);
});
test("20 simultaneous overlapping schedule requests permit only one", async () => {
  const outcomes = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      addSessions(actor, {
        serviceId,
        coachId,
        localStart: "2030-07-01T10:00",
        requestId: randomUUID(),
      }),
    ),
  );
  expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(19);
});
test("Duplicate schedule request returns the same dated session", async () => {
  const input = {
    serviceId,
    coachId,
    localStart: "2030-07-02T10:00",
    requestId: randomUUID(),
  };
  const a = await addSessions(actor, input);
  const b = await addSessions(actor, input);
  expect(a[0].id).toBe(b[0].id);
});
test("Coach buffers prevent a superficially adjacent booking", async () => {
  await expect(
    addSessions(actor, {
      serviceId,
      coachId,
      localStart: "2030-07-01T11:00",
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
});
test("Weekly repetition stays at local clock time across Sydney DST", async () => {
  const sessions = await addSessions(actor, {
    serviceId,
    coachId,
    localStart: "2030-09-30T18:00",
    weeks: 8,
    requestId: randomUUID(),
  });
  expect(sessions).toHaveLength(8);
  expect(sessions[0].startsAt.getUTCHours()).toBe(8);
  expect(sessions[1].startsAt.getUTCHours()).toBe(7);
});
test("DST gap and ambiguous times are rejected", () => {
  expect(() => localInstant("2030-10-06T02:30", "Australia/Sydney")).toThrow();
  expect(() => localInstant("2030-04-07T02:30", "Australia/Sydney")).toThrow();
});
test("Week publishing creates no extra Shopify mapping/outbox", async () => {
  const before = await db.outboxEvent.count({
    where: { shopId: actor.shopId },
  });
  expect(await publishWeek(actor, "2030-07-01")).toBe(2);
  expect(await publishWeek(actor, "2030-07-01")).toBe(0);
  expect(await db.outboxEvent.count({ where: { shopId: actor.shopId } })).toBe(
    before,
  );
});
test("One conflicting occurrence rolls back the whole repeated batch", async () => {
  const before = await db.classSession.count({
    where: { shopId: actor.shopId },
  });
  await expect(
    addSessions(actor, {
      serviceId,
      coachId,
      localStart: "2030-06-24T10:00",
      weeks: 2,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
  expect(await db.classSession.count({ where: { shopId: actor.shopId } })).toBe(
    before,
  );
});
test("Database exclusion constraints reject overlaps without application checks", async () => {
  const row = await db.classSession.findFirstOrThrow({
    where: { shopId: actor.shopId },
  });
  await expect(
    db.classSession.create({
      data: { ...row, id: randomUUID(), dedupeKey: randomUUID() },
    }),
  ).rejects.toThrow();
});
test("Audit history cannot be edited or deleted", async () => {
  const row = await db.auditLog.findFirstOrThrow({
    where: { shopId: actor.shopId },
  });
  await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
});
test("Obsolete outbox versions are skipped; latest version sync and replay are idempotent", async () => {
  const events = await db.outboxEvent.findMany({
    where: { shopId: actor.shopId, aggregateId: serviceId },
    orderBy: { version: "asc" },
  });
  let calls = 0;
  const product = {
    id: "gid://shopify/Product/123",
    title: service.name,
    status: "ACTIVE",
    bookingOwner: { jsonValue: serviceId },
    variants: {
      nodes: [{ id: "gid://shopify/ProductVariant/456", price: "49.00" }],
    },
  };
  const graphql: GraphQL = async (query) => {
    calls++;
    if (query.includes("mutation BookingProductSet"))
      return Response.json({
        data: { productSet: { product, userErrors: [] } },
      });
    if (query.includes("mutation BookingMetafields"))
      return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
    if (query.includes("query BookingMetaobjectDefinition"))
      return Response.json({ data: { metaobjectDefinitionByType: null } });
    if (query.includes("mutation BookingMetaobjectDefinitionCreate"))
      return Response.json({
        data: {
          metaobjectDefinitionCreate: {
            metaobjectDefinition: { id: "definition" },
            userErrors: [],
          },
        },
      });
    if (query.includes("mutation BookingContent"))
      return Response.json({
        data: {
          metaobjectUpsert: { metaobject: { id: "content" }, userErrors: [] },
        },
      });
    if (query.includes("query BookingContentRead"))
      return Response.json({ data: { metaobjectByHandle: { id: "content" } } });
    return Response.json({ data: { product } });
  };
  await syncCatalogEvent(events[0].id, graphql);
  expect(calls).toBe(0);
  await syncCatalogEvent(events[1].id, graphql);
  expect(calls).toBe(7);
  await syncCatalogEvent(events[1].id, graphql);
  expect(calls).toBe(7);
  expect(
    (
      await db.productMapping.findFirstOrThrow({
        where: { shopId: actor.shopId, ownerId: serviceId },
      })
    ).syncStatus,
  ).toBe("SYNCED");
});
test("API failure records a retryable sync status without losing the saved pass", async () => {
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { shopId: actor.shopId, status: "PENDING" },
  });
  await expect(
    syncCatalogEvent(event.id, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow();
  await recordSyncFailure(event.id);
  expect(
    (await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }))
      .attempts,
  ).toBe(1);
  expect(
    (
      await db.productMapping.findFirstOrThrow({
        where: { shopId: actor.shopId, ownerId: event.aggregateId },
      })
    ).syncStatus,
  ).toBe("ERROR");
});

test("Copy previous week creates drafts once and preserves the source week", async () => {
  const count = await copyPreviousWeek(actor, "2030-07-08");
  expect(count).toBe(2);
  expect(await copyPreviousWeek(actor, "2030-07-08")).toBe(0);
  expect(
    await db.classSession.count({
      where: { shopId: actor.shopId, status: "PUBLISHED" },
    }),
  ).toBe(2);
});
test("Coach role cannot publish or copy a week", async () => {
  await expect(
    publishWeek({ ...actor, role: "COACH" }, "2030-07-08"),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    copyPreviousWeek({ ...actor, role: "COACH" }, "2030-07-08"),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
