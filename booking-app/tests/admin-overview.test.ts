import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import { adminOverview } from "../app/services/admin-overview.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());

test("Overview derives action and Pass-expiry metrics from operational records", async () => {
  const fixture = await paidFixture();
  await processPaidBookingEvent((await queuePaid(fixture)).id);
  const overview = await adminOverview({
    shopId: fixture.shop.id,
    actorId: randomUUID(),
    role: "ADMIN",
  });
  expect(overview.metrics.attention).toBe(0);
  expect(overview.metrics.expiringPasses).toBe(0);
  expect(overview.metrics.expiringCredits).toBe(0);
  expect(overview.expiringPasses).toEqual([]);
});
