import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { bookingOperationsData } from "../app/services/booking-operations.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
test("bookings paginate all records beyond 50, preserve stable order and isolate shops", async () => {
  const f = await paidFixture();
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  await db.classSession.update({
    where: { id: f.session.id },
    data: { capacity: 60 },
  });
  const time = new Date();
  const ids = Array.from({ length: 57 }, () => randomUUID());
  await db.customerProfile.createMany({
    data: ids.map((id, index) => ({
      id,
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/" + (1000 + index),
    })),
  });
  const bookingIds = Array.from({ length: 57 }, () => randomUUID())
    .sort()
    .reverse();
  await db.booking.createMany({
    data: bookingIds.map((id, i) => ({
      id,
      shopId: f.shop.id,
      sessionId: f.session.id,
      customerId: ids[i],
      createdAt: time,
    })),
  });
  const foreign = await paidFixture();
  await db.bookingHold.update({
    where: { id: foreign.hold.id },
    data: { status: "EXPIRED" },
  });
  await db.booking.create({
    data: {
      shopId: foreign.shop.id,
      sessionId: foreign.session.id,
      customerId: foreign.customer.id,
    },
  });
  const pages = await Promise.all(
    Array.from({ length: 8 }, (_, i) => bookingOperationsData(actor, i + 1)),
  );
  expect(pages.map((p) => p.bookings.length)).toEqual([8, 8, 8, 8, 8, 8, 8, 1]);
  expect(pages.flatMap((p) => p.bookings.map((b) => b.id))).toEqual(bookingIds);
  expect(pages[7].pagination).toEqual({
    page: 8,
    pageSize: 8,
    totalCount: 57,
    totalPages: 8,
  });
  expect((await bookingOperationsData(actor, 999)).pagination.page).toBe(8);
  for (const page of [0, -1, 1.5, NaN, Infinity])
    expect((await bookingOperationsData(actor, page)).pagination.page).toBe(1);
  await expect(
    bookingOperationsData({ ...actor, role: "COACH" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const empty = await paidFixture();
  const result = await bookingOperationsData({
    ...actor,
    shopId: empty.shop.id,
  });
  expect(result.bookings).toEqual([]);
  expect(result.pagination).toEqual({
    page: 1,
    pageSize: 8,
    totalCount: 0,
    totalPages: 1,
  });
});
