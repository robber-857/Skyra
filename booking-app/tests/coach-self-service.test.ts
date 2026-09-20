import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import {
  bindCoachLoginEmail,
  requestCoachEmailLogin,
  deliverCoachLogin,
  sweepCoachLoginMail,
} from "../app/services/coach-self-service.server";
import {
  coachIdentity,
  exchangeCoachLogin,
} from "../app/services/coach-auth.server";
import { sendTransactionalMail } from "../app/services/transactional-mail.server";
import { deliverInternalBookingMail } from "../app/services/internal-booking-mail.server";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const f = await paidFixture();
  vi.stubEnv("SKYRA_MAIL_ENABLED", "true");
  vi.stubEnv("SKYRA_MAIL_PROVIDER", "resend");
  vi.stubEnv("RESEND_API_KEY", "fake-test-key");
  vi.stubEnv("SKYRA_MAIL_FROM", "hello@example.com");
  vi.stubEnv("SKYRA_COACH_MAIL_KEY", "12".repeat(32));
  vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
  vi.stubEnv("SKYRA_COACH_LOGIN_SHOP", f.shop.domain);
  const actor = {
    shopId: f.shop.id,
    actorId: "TEST_ADMIN",
    role: "ADMIN" as const,
  };
  await bindCoachLoginEmail(actor, f.coach.id, " Karen@Example.com ");
  return { f, actor };
}

test("first verified email login activates the authorized coach; credentials are not plaintext", async () => {
  const { f } = await setup();
  await requestCoachEmailLogin("KAREN@example.com");
  const job = await db.coachLoginDelivery.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  let link = "";
  await deliverCoachLogin(job.id, async (mail) => {
    expect(mail.to).toBe("karen@example.com");
    expect(mail.idempotencyKey).toContain(job.id);
    link = mail.text.split("\n")[1];
    return { status: "ACCEPTED", messageId: "provider-1" };
  });
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
  expect(JSON.stringify(job)).not.toContain(token);
  const session = await exchangeCoachLogin(token);
  expect((await coachIdentity(session)).coachId).toBe(f.coach.id);
  expect(
    (await db.coach.findUniqueOrThrow({ where: { id: f.coach.id } }))
      .loginVerifiedAt,
  ).not.toBeNull();
  expect(
    (await db.coachLoginDelivery.findUniqueOrThrow({ where: { id: job.id } }))
      .encryptedPayload,
  ).toBeNull();
  await expect(exchangeCoachLogin(token)).rejects.toMatchObject({
    status: 401,
  });
});

test("unknown and notification-only emails cannot register a privileged coach", async () => {
  const { f } = await setup();
  await db.coach.update({
    where: { id: f.coach.id },
    data: { notificationEmail: "notify@example.com" },
  });
  const before = await db.coach.count({ where: { shopId: f.shop.id } });
  await requestCoachEmailLogin("unknown@example.com");
  await requestCoachEmailLogin("notify@example.com");
  expect(await db.coach.count({ where: { shopId: f.shop.id } })).toBe(before);
  expect(
    await db.coachLoginDelivery.count({ where: { shopId: f.shop.id } }),
  ).toBe(0);
});

test("concurrent requests issue only one email during cooldown", async () => {
  const { f } = await setup();
  await Promise.all(
    Array.from({ length: 10 }, () =>
      requestCoachEmailLogin("karen@example.com"),
    ),
  );
  expect(
    await db.coachLoginDelivery.count({ where: { shopId: f.shop.id } }),
  ).toBe(1);
});

test("email binding is Admin-only, tenant scoped and unique; changing it revokes sessions", async () => {
  const { f, actor } = await setup();
  await expect(
    bindCoachLoginEmail(
      { ...actor, role: "COACH" },
      f.coach.id,
      "a@example.com",
    ),
  ).rejects.toMatchObject({ status: 403 });
  const other = await paidFixture();
  await expect(
    bindCoachLoginEmail(actor, other.coach.id, "a@example.com"),
  ).rejects.toMatchObject({ status: 404 });
  const second = await db.coach.create({
    data: { shopId: f.shop.id, name: "Another coach" },
  });
  await expect(
    bindCoachLoginEmail(actor, second.id, "karen@example.com"),
  ).rejects.toMatchObject({ code: "EMAIL_ALREADY_BOUND" });
  await requestCoachEmailLogin("karen@example.com");
  const job = await db.coachLoginDelivery.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  let token = "";
  await deliverCoachLogin(job.id, async (mail) => {
    token = new URLSearchParams(
      new URL(mail.text.split("\n")[1]).hash.slice(1),
    ).get("token")!;
    return { status: "ACCEPTED", messageId: "provider-2" };
  });
  const session = await exchangeCoachLogin(token);
  await bindCoachLoginEmail(actor, f.coach.id, "replacement@example.com");
  await expect(coachIdentity(session)).rejects.toMatchObject({ status: 401 });
});

test("expired and changed-email pending deliveries are suppressed", async () => {
  const { f, actor } = await setup();
  await requestCoachEmailLogin("karen@example.com");
  const job = await db.coachLoginDelivery.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const send = vi.fn();
  await bindCoachLoginEmail(actor, f.coach.id, "changed@example.com");
  await deliverCoachLogin(job.id, send);
  expect(send).not.toHaveBeenCalled();
  const old = await db.coachLoginDelivery.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(old.status).toBe("SUPPRESSED");
  expect(old.encryptedPayload).toBeNull();
  // Use an internally consistent historical clock (expiresAt > createdAt).
  await db.coachLoginDelivery.update({
    where: { id: job.id },
    data: {
      status: "PENDING",
      createdAt: new Date(Date.now() - 120000),
      expiresAt: new Date(Date.now() - 60000),
    },
  });
  await sweepCoachLoginMail();
  expect(
    (await db.coachLoginDelivery.findUniqueOrThrow({ where: { id: job.id } }))
      .status,
  ).toBe("SUPPRESSED");
});

test("Booking mail resolves current Admin, assigned Coach and Shopify Customer destinations", async () => {
  const { f } = await setup();
  vi.stubEnv("SKYRA_BOOKING_MAIL_SHOP", f.shop.domain);
  await db.shop.update({
    where: { id: f.shop.id },
    data: { operationsEmail: "studio@example.com" },
  });
  await db.coach.update({
    where: { id: f.coach.id },
    data: { notificationEmail: "coach-notify@example.com" },
  });
  await processPaidBookingEvent((await queuePaid(f)).id);
  const jobs = await db.bookingNotification.findMany({
    where: { shopId: f.shop.id },
  });
  expect(jobs).toHaveLength(4);
  const send = vi
    .fn()
    .mockResolvedValue({ status: "ACCEPTED", messageId: "internal-test" });
  const resolveCustomer = vi.fn().mockResolvedValue("customer@example.com");
  for (const job of jobs)
    await deliverInternalBookingMail(job.id, send, resolveCustomer);
  expect(send.mock.calls.map(([mail]) => mail.to).sort()).toEqual([
    "coach-notify@example.com",
    "customer@example.com",
    "studio@example.com",
  ]);
  expect(resolveCustomer).toHaveBeenCalledWith(
    f.shop.domain,
    f.customer.shopifyCustomerGid,
  );
  const customer = jobs.find(
    (job) => job.template === "BOOKING_CONFIRMED_V1" && job.recipientKind === "CUSTOMER",
  )!;
  expect(
    (
      await db.bookingNotification.findUniqueOrThrow({
        where: { id: customer.id },
      })
    ).status,
  ).toBe("ACCEPTED");
  expect(
    jobs.find((job) => job.template === "BOOKING_REMINDER_V1")?.status,
  ).toBe("PENDING");
});

test("ambiguous login sends are UNKNOWN, wiped and never retried", async () => {
  const { f } = await setup();
  await requestCoachEmailLogin("karen@example.com");
  const job = await db.coachLoginDelivery.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const send = vi.fn().mockRejectedValue(new Error("timeout"));
  await deliverCoachLogin(job.id, send);
  await deliverCoachLogin(job.id, send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    await db.coachLoginDelivery.findUniqueOrThrow({ where: { id: job.id } }),
  ).toMatchObject({ status: "UNKNOWN", encryptedPayload: null });
});

test("mail remains off by default; transport uses configured sender and provider idempotency", async () => {
  await setup();
  const mail = {
    to: "karen@example.com",
    subject: "Sign in",
    text: "test",
    idempotencyKey: "test-123",
  };
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ id: "test-message" }), { status: 200 }),
    );
  vi.stubEnv("SKYRA_MAIL_ENABLED", "false");
  expect(await sendTransactionalMail(mail, send)).toEqual({ status: "FAILED" });
  expect(send).not.toHaveBeenCalled();
  vi.stubEnv("SKYRA_MAIL_ENABLED", "true");
  expect(await sendTransactionalMail(mail, send)).toEqual({
    status: "ACCEPTED",
    messageId: "test-message",
  });
  const options = send.mock.calls[0][1]!;
  expect(JSON.parse(options.body as string)).toMatchObject({
    from: "hello@example.com",
    to: ["karen@example.com"],
  });
  expect(options.headers).toMatchObject({ "Idempotency-Key": "test-123" });
});
