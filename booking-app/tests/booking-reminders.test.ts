import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  deliverBookingNotification,
  enqueueBookingNotifications,
  previewBookingNotification,
} from "../app/services/booking-notifications.server";
import {
  CUSTOMER_NOTIFICATION_EMAIL_QUERY,
  resolveShopifyCustomerEmail,
} from "../app/services/customer-notification-email.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());

test("confirmed booking queues one Customer reminder exactly 12 hours before class", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const booking = await db.booking.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const reminder = await db.bookingNotification.findFirstOrThrow({
    where: {
      shopId: f.shop.id,
      bookingId: booking.id,
      recipientKind: "CUSTOMER",
      template: "BOOKING_REMINDER_V1",
    },
  });
  expect(reminder.availableAt.toISOString()).toBe(
    new Date(f.session.startsAt.getTime() - 12 * 60 * 60 * 1000).toISOString(),
  );
  expect(
    await db.bookingNotification.count({
      where: { bookingId: booking.id, template: "BOOKING_REMINDER_V1" },
    }),
  ).toBe(1);
  const preview = await previewBookingNotification(f.shop.id, reminder.id);
  expect(preview.subject).toContain("Class reminder");
  expect(preview.text).toContain("starts in about 12 hours");
  expect(preview.text).toContain("Drop-in payments are not refunded");
  const send = vi.fn().mockResolvedValue({
    status: "ACCEPTED" as const,
    messageId: "too-early",
  });
  await deliverBookingNotification(reminder.id, send);
  expect(send).not.toHaveBeenCalled();
});

test("a booking made inside 12 hours queues its reminder immediately", async () => {
  const f = await paidFixture();
  const startsAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  await db.classSession.update({
    where: { id: f.session.id },
    data: { startsAt, endsAt, busyStartsAt: startsAt, busyEndsAt: endsAt },
  });
  const customer = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/456",
    },
  });
  const before = new Date();
  await db.$transaction(async (tx) => {
    const booking = await tx.booking.create({
      data: {
        shopId: f.shop.id,
        sessionId: f.session.id,
        customerId: customer.id,
      },
    });
    await enqueueBookingNotifications(tx, f.shop.id, booking.id);
  });
  const reminder = await db.bookingNotification.findFirstOrThrow({
    where: { shopId: f.shop.id, template: "BOOKING_REMINDER_V1" },
  });
  expect(reminder.availableAt.getTime()).toBeGreaterThanOrEqual(
    before.getTime() - 1000,
  );
  expect(reminder.availableAt.getTime()).toBeLessThan(startsAt.getTime());
});

test("Customer email lookup uses the validated Customer GID and default email", async () => {
  const graphql = vi.fn(async (query: string, options: { variables: Record<string, unknown> }) => {
    expect(query).toBe(CUSTOMER_NOTIFICATION_EMAIL_QUERY);
    expect(options.variables).toEqual({ id: "gid://shopify/Customer/123" });
    return new Response(
      JSON.stringify({
        data: {
          customer: {
            id: "gid://shopify/Customer/123",
            defaultEmailAddress: { emailAddress: "customer@example.com" },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  await expect(
    resolveShopifyCustomerEmail(graphql, "gid://shopify/Customer/123"),
  ).resolves.toBe("customer@example.com");
});

test("Customer email lookup rejects mismatched or partial Shopify data", async () => {
  const graphql = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: {
          customer: {
            id: "gid://shopify/Customer/999",
            defaultEmailAddress: { emailAddress: "wrong@example.com" },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  await expect(
    resolveShopifyCustomerEmail(graphql, "gid://shopify/Customer/123"),
  ).rejects.toThrow("invalid data");
});
