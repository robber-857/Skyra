import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import {
  processPaidBookingEvent,
  recordPaidBookingFailure,
} from "../app/services/paid-booking.server";
import {
  deliverBookingNotification,
  previewBookingNotification,
  renderBookingEmail,
} from "../app/services/booking-notifications.server";
import {
  expireBookingWork,
  resumeAttempt,
} from "../app/services/booking.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());

for (const kind of ["NEW_PASS", "DROP_IN"] as const)
  test(`${kind}: payment atomically grants, reserves, confirms and enqueues two emails`, async () => {
    const f = await paidFixture(kind);
    const event = await queuePaid(f);
    expect(await processPaidBookingEvent(event.id)).toMatchObject({
      status: "CONFIRMED",
    });
    const entries = await db.entitlementLedgerEntry.findMany({
      where: { shopId: f.shop.id },
    });
    expect(entries.map((e) => e.kind).sort()).toEqual(["GRANT", "RESERVE"]);
    expect(entries.reduce((sum, e) => sum + e.availableDelta, 0)).toBe(
      kind === "NEW_PASS" ? 4 : 0,
    );
    expect(entries.reduce((sum, e) => sum + e.consumedDelta, 0)).toBe(0);
    expect(
      await db.booking.count({
        where: { shopId: f.shop.id, status: "CONFIRMED" },
      }),
    ).toBe(1);
    expect(
      await db.bookingNotification.count({ where: { shopId: f.shop.id } }),
    ).toBe(2);
    expect(
      (await db.bookingHold.findUniqueOrThrow({ where: { id: f.hold.id } }))
        .status,
    ).toBe("CONSUMED");
    expect(
      (
        await db.bookingAttempt.findUniqueOrThrow({
          where: { id: f.attempt.id },
        })
      ).status,
    ).toBe("CONFIRMED");
  });

test("10 worker executions and different delivery IDs do not duplicate any side effects", async () => {
  const f = await paidFixture();
  const events = await Promise.all(
    Array.from({ length: 10 }, () => queuePaid(f)),
  );
  await Promise.all(events.map((e) => processPaidBookingEvent(e.id)));
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    await db.bookingNotification.count({ where: { shopId: f.shop.id } }),
  ).toBe(2);
  expect(
    await db.webhookReceipt.count({
      where: { shopId: f.shop.id, status: "PROCESSED" },
    }),
  ).toBe(10);
});

test("second paid order cannot reuse a checkout", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  expect(
    await processPaidBookingEvent((await queuePaid(f, "1002")).id),
  ).toMatchObject({ reason: "PAYMENT_SOURCE_ALREADY_USED" });
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(1);
});

test("expired hold with available capacity recovers even after expiry sweep", async () => {
  const f = await paidFixture("NEW_PASS", true);
  expect(await processPaidBookingEvent((await queuePaid(f)).id)).toMatchObject({
    status: "CONFIRMED",
  });
});

test("expired hold with full class grants purchased pass but reserves no credit and sends no confirmation", async () => {
  const f = await paidFixture("NEW_PASS", true);
  await db.classSession.update({
    where: { id: f.session.id },
    data: { capacity: 1 },
  });
  const customer = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/222",
    },
  });
  await db.booking.create({
    data: {
      shopId: f.shop.id,
      customerId: customer.id,
      sessionId: f.session.id,
    },
  });
  expect(await processPaidBookingEvent((await queuePaid(f)).id)).toMatchObject({
    reason: "SOLD_OUT",
  });
  expect(
    await db.entitlementLedgerEntry.count({
      where: { shopId: f.shop.id, kind: "GRANT" },
    }),
  ).toBe(1);
  expect(
    await db.entitlementLedgerEntry.count({
      where: { shopId: f.shop.id, kind: "RESERVE" },
    }),
  ).toBe(0);
  expect(
    await db.bookingNotification.count({ where: { shopId: f.shop.id } }),
  ).toBe(0);
});

test("changed pass grants frozen purchased terms, not latest catalogue terms", async () => {
  const f = await paidFixture();
  await db.passPlan.update({
    where: { id: f.plan.id },
    data: { credits: 99, validityDays: 365 },
  });
  await processPaidBookingEvent((await queuePaid(f)).id);
  expect(
    await db.entitlement.findFirst({ where: { shopId: f.shop.id } }),
  ).toMatchObject({ grantedUnits: 5 });
});

test("changed session and expired attempt retain entitlement and enter review", async () => {
  for (const change of ["session", "attempt"]) {
    const f = await paidFixture();
    if (change === "session")
      await db.classSession.update({
        where: { id: f.session.id },
        data: { timezone: "Australia/Brisbane" },
      });
    else
      await db.bookingAttempt.update({
        where: { id: f.attempt.id },
        data: { status: "EXPIRED" },
      });
    const result = await processPaidBookingEvent((await queuePaid(f)).id);
    expect(result.status).toBe("NEEDS_ATTENTION");
    expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(
      1,
    );
    expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
  }
});

test("invalid purchase time and cross-shop checkout produce review without grants", async () => {
  const f = await paidFixture();
  const event = await queuePaid(f);
  const other = await paidFixture();
  for (const patch of [
    { purchasedAt: "invalid" },
    { checkoutId: other.checkout.id },
  ]) {
    const receipt = await db.webhookReceipt.create({
      data: {
        shopId: f.shop.id,
        webhookId: randomUUID(),
        topic: "orders/paid",
        payloadHash: "a".repeat(64),
        status: "QUEUED",
      },
    });
    const next = await db.outboxEvent.create({
      data: {
        shopId: f.shop.id,
        kind: "ORDER_PAID_RECEIVED",
        aggregateId: receipt.id,
        version: 1,
        payload: {
          ...(event.payload as object),
          ...patch,
          receiptId: receipt.id,
        },
      },
    });
    expect((await processPaidBookingEvent(next.id)).status).toBe(
      "NEEDS_ATTENTION",
    );
  }
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(0);
});

test("database failure rolls back grant, booking, hold and notification together", async () => {
  const f = await paidFixture();
  const event = await queuePaid(f);
  await db.$executeRawUnsafe(
    `CREATE FUNCTION test_notification_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."shopId" = '${f.shop.id}'::uuid THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER test_notification_failure BEFORE INSERT ON "BookingNotification" FOR EACH ROW EXECUTE FUNCTION test_notification_failure()',
  );
  try {
    await expect(processPaidBookingEvent(event.id)).rejects.toThrow();
    expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(
      0,
    );
    expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
    expect(
      (await db.bookingHold.findUniqueOrThrow({ where: { id: f.hold.id } }))
        .status,
    ).toBe("ACTIVE");
  } finally {
    await db.$executeRawUnsafe(
      'DROP TRIGGER test_notification_failure ON "BookingNotification"',
    );
    await db.$executeRawUnsafe("DROP FUNCTION test_notification_failure()");
  }
  expect((await processPaidBookingEvent(event.id)).status).toBe("CONFIRMED");
});

test("five processing failures become visible and success is not downgraded by stale failure", async () => {
  const f = await paidFixture();
  const event = await queuePaid(f);
  for (let i = 0; i < 5; i++) await recordPaidBookingFailure(event.id);
  expect(
    await db.outboxEvent.findUnique({ where: { id: event.id } }),
  ).toMatchObject({ status: "FAILED", attempts: 5 });
  expect(
    await db.webhookReceipt.findUnique({ where: { id: event.aggregateId } }),
  ).toMatchObject({ status: "FAILED" });
  const other = await paidFixture();
  const success = await queuePaid(other);
  await processPaidBookingEvent(success.id);
  await recordPaidBookingFailure(success.id);
  expect(
    await db.outboxEvent.findUnique({ where: { id: success.id } }),
  ).toMatchObject({ status: "DONE", attempts: 0 });
});

test("notification concurrent delivery sends once, with minimal recipient IDs", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const notification = await db.bookingNotification.findFirstOrThrow({
    where: { shopId: f.shop.id, recipientKind: "COACH" },
  });
  const send = vi.fn(async () => ({
    status: "ACCEPTED" as const,
    messageId: "provider-test",
  }));
  await Promise.all(
    Array.from({ length: 10 }, () =>
      deliverBookingNotification(notification.id, send),
    ),
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toBeDefined();
  expect(
    await db.bookingNotification.findUnique({ where: { id: notification.id } }),
  ).toMatchObject({ status: "ACCEPTED", attempts: 1 });
});

test("unknown email result is not automatically resent and does not reverse booking", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const n = await db.bookingNotification.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const send = vi.fn(async () => {
    throw new Error("private email/network data");
  });
  await deliverBookingNotification(n.id, send);
  await deliverBookingNotification(n.id, send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    await db.bookingNotification.findUnique({ where: { id: n.id } }),
  ).toMatchObject({ status: "UNKNOWN", lastError: "DELIVERY_OUTCOME_UNKNOWN" });
  expect(
    await db.booking.count({
      where: { shopId: f.shop.id, status: "CONFIRMED" },
    }),
  ).toBe(1);
});

test("cancelled booking suppresses unsent confirmation", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const n = await db.bookingNotification.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  await db.booking.update({
    where: { id: n.bookingId },
    data: { status: "CANCELLED" },
  });
  const send = vi.fn(async () => ({
    status: "ACCEPTED" as const,
    messageId: "test",
  }));
  await deliverBookingNotification(n.id, send);
  expect(send).not.toHaveBeenCalled();
  expect(
    await db.bookingNotification.findUnique({ where: { id: n.id } }),
  ).toMatchObject({ status: "SUPPRESSED" });
});

test("templates escape user content and show correct Sydney timezone", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const n = await db.bookingNotification.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  expect((await previewBookingNotification(f.shop.id, n.id)).text).toContain(
    "Australia/Sydney",
  );
  const rendered = renderBookingEmail({
    recipientKind: "COACH",
    className: '<script>alert("x")</script>',
    coachName: "Coach",
    locationName: "Studio",
    startsAt: new Date("2026-10-05T00:00:00Z"),
    endsAt: new Date("2026-10-05T01:00:00Z"),
    timezone: "Australia/Sydney",
    bookingReference: "test",
    confirmedCount: 2,
    capacity: 8,
  });
  expect(rendered.html).not.toContain("<script>");
  expect(rendered.html).toContain("&lt;script&gt;");
  expect(rendered.text).toContain("11:00 AM");
});

test("expiry sweeper never overwrites confirmed attempts", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  await expireBookingWork();
  expect(
    (await db.bookingAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } }))
      .status,
  ).toBe("CONFIRMED");
});

test("two expired paid holds race for the last seat without overselling", async () => {
  const f = await paidFixture("NEW_PASS", true);
  await db.classSession.update({
    where: { id: f.session.id },
    data: { capacity: 1 },
  });
  const customer = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/333",
    },
  });
  const attempt = await db.bookingAttempt.create({
    data: {
      shopId: f.shop.id,
      sessionId: f.session.id,
      customerId: customer.id,
      tokenHash: randomUUID(),
      surface: "HOME",
      status: "RECOVERY",
      expiresAt: new Date(Date.now() + 1800000),
    },
  });
  const hold = await db.bookingHold.create({
    data: {
      shopId: f.shop.id,
      sessionId: f.session.id,
      customerId: customer.id,
      attemptId: attempt.id,
      purchaseKind: "NEW_PASS",
      passPlanId: f.plan.id,
      idempotencyKey: randomUUID(),
      status: "EXPIRED",
      createdAt: f.hold.createdAt,
      expiresAt: f.hold.expiresAt,
    },
  });
  const checkout = await db.bookingCheckout.create({
    data: {
      ...f.checkout,
      id: randomUUID(),
      holdId: hold.id,
      reference: (randomUUID() + randomUUID()).replaceAll("-", "").slice(0, 43),
      cartId: `gid://shopify/Cart/${randomUUID()}?key=test`,
      purchaseTerms: f.checkout.purchaseTerms ?? undefined,
    },
  });
  const second = {
    ...f,
    customer,
    attempt,
    hold,
    checkout,
    payload: {
      ...f.payload,
      customer: { admin_graphql_api_id: customer.shopifyCustomerGid },
      line_items: [
        {
          ...f.payload.line_items[0],
          properties: [
            { name: "_skyra_booking_ref", value: checkout.reference },
          ],
        },
      ],
    },
  };
  const events = [await queuePaid(f), await queuePaid(second, "1002")];
  const results = await Promise.all(
    events.map((e) => processPaidBookingEvent(e.id)),
  );
  expect(results.filter((r) => r.status === "CONFIRMED")).toHaveLength(1);
  expect(results.filter((r) => r.reason === "SOLD_OUT")).toHaveLength(1);
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(2);
  expect(
    await db.bookingNotification.count({ where: { shopId: f.shop.id } }),
  ).toBe(2);
});

test("confirmed recovery does not become unconfirmed when the class closes", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  await db.classSession.update({
    where: { id: f.session.id },
    data: { status: "CANCELLED" },
  });
  const recovered = await resumeAttempt(
    { shopId: f.shop.id, customerGid: f.customer.shopifyCustomerGid },
    f.token,
  );
  expect(recovered.status).toBe("CONFIRMED");
});

test("email definite rejections retry to a bounded terminal state", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const n = await db.bookingNotification.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  for (let i = 0; i < 5; i++) {
    await db.bookingNotification.update({
      where: { id: n.id },
      data: { availableAt: new Date(0) },
    });
    await deliverBookingNotification(n.id, async () => ({ status: "RETRY" }));
  }
  expect(
    await db.bookingNotification.findUnique({ where: { id: n.id } }),
  ).toMatchObject({ status: "FAILED", attempts: 5 });
});
