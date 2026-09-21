import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import { DateTime } from "luxon";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { adminSessionDetail } from "../app/services/admin-session.server";
import { scheduleData } from "../app/services/schedule.server";
import { adminContext } from "../app/services/context.server";
import { loader, headers } from "../app/routes/app.schedule_.$id";

vi.mock("../app/services/context.server", () => ({ adminContext: vi.fn() }));
const actorFor = (shopId: string) => ({
  shopId,
  actorId: randomUUID(),
  role: "ADMIN" as const,
});
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());

test("session roster counts enrolments separately from holds and inactive bookings, with safe client links", async () => {
  const f = await paidFixture();
  const actor = actorFor(f.shop.id);
  const alice = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/9999",
      preferredName: "Alice",
      shopifyName: "Alice Chen",
      email: "alice@example.com",
      avatarBytes: Buffer.from("fixture"),
      avatarMimeType: "image/png",
    },
  });
  for (const [i, status] of [
    "CONFIRMED",
    "ATTENDED",
    "NO_SHOW",
    "CANCELLED",
    "LATE_CANCEL",
  ].entries()) {
    const customer =
      i === 0
        ? alice
        : await db.customerProfile.create({
            data: {
              shopId: f.shop.id,
              shopifyCustomerGid: `gid://shopify/Customer/${200 + i}`,
              shopifyName: `Student ${i}`,
            },
          });
    await db.booking.create({
      data: {
        shopId: f.shop.id,
        sessionId: f.session.id,
        customerId: customer.id,
        status,
        customerComment: i === 0 ? "First class" : "",
        checkedInAt: status === "ATTENDED" ? new Date() : null,
      },
    });
  }
  const detail = await adminSessionDetail(actor, f.session.id);
  expect(detail).toMatchObject({
    enrolled: 3,
    attended: 1,
    noShows: 1,
    holds: 1,
    canEdit: true,
  });
  expect(detail.bookings.filter((b) => b.enrolled)).toHaveLength(3);
  expect(detail.bookings.filter((b) => !b.enrolled)).toHaveLength(2);
  expect(detail.bookings[0]).toMatchObject({
    customerComment: "First class",
    customer: {
      id: alice.id,
      name: "Alice",
      avatarDataUrl: "data:image/png;base64,Zml4dHVyZQ==",
    },
  });
  const output = JSON.stringify(detail);
  for (const forbidden of [
    "avatarBytes",
    "shopifyCustomerGid",
    "sourceOrderGid",
    "cartId",
    "email",
  ])
    expect(output).not.toContain(forbidden);
  const week = await scheduleData(
    f.shop.id,
    DateTime.fromJSDate(f.session.startsAt, {
      zone: f.shop.timezone,
    }).toISODate()!,
  );
  expect(week.sessions.find((s) => s.id === f.session.id)).toMatchObject({
    enrolled: 3,
    occupied: 2,
  });
  await db.bookingHold.update({
    where: { id: f.hold.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  expect((await adminSessionDetail(actor, f.session.id)).holds).toBe(0);
});

test("session details isolate shops and disallow coach access while allowing operations", async () => {
  const f = await paidFixture(),
    other = await paidFixture();
  await expect(
    adminSessionDetail(actorFor(other.shop.id), f.session.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    adminSessionDetail({ ...actorFor(f.shop.id), role: "COACH" }, f.session.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(
    (
      await adminSessionDetail(
        { ...actorFor(f.shop.id), role: "OPERATIONS" },
        f.session.id,
      )
    ).id,
  ).toBe(f.session.id);
  for (const id of [undefined, "invalid", randomUUID()])
    await expect(
      adminSessionDetail(actorFor(f.shop.id), id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("empty and past sessions remain readable with editing disabled for past or cancelled sessions", async () => {
  const f = await paidFixture(),
    actor = actorFor(f.shop.id);
  expect(await adminSessionDetail(actor, f.session.id)).toMatchObject({
    enrolled: 0,
    bookings: [],
  });
  await db.classSession.update({
    where: { id: f.session.id },
    data: { status: "CANCELLED" },
  });
  expect((await adminSessionDetail(actor, f.session.id)).canEdit).toBe(false);
  await db.classSession.update({
    where: { id: f.session.id },
    data: {
      status: "COMPLETED",
      busyStartsAt: new Date(Date.now() - 7200000),
      busyEndsAt: new Date(Date.now() - 3500000),
      startsAt: new Date(Date.now() - 7200000),
      endsAt: new Date(Date.now() - 3600000),
    },
  });
  expect((await adminSessionDetail(actor, f.session.id)).canEdit).toBe(false);
});

test("detail loader requires Admin authentication, returns shop-local week, and marks customer data private", async () => {
  const f = await paidFixture();
  const args = {
    request: new Request(`https://example.com/app/schedule/${f.session.id}`),
    params: { id: f.session.id },
    context: {},
    url: new URL(`https://example.com/app/schedule/${f.session.id}`),
    pattern: "/app/schedule/:id",
  };
  vi.mocked(adminContext).mockRejectedValueOnce(
    new Response("Sign in", { status: 401 }),
  );
  await expect(loader(args)).rejects.toMatchObject({ status: 401 });
  vi.mocked(adminContext).mockResolvedValue({
    actor: actorFor(f.shop.id),
    shop: f.shop,
  } as Awaited<ReturnType<typeof adminContext>>);
  const data = await loader(args);
  expect(data.session.id).toBe(f.session.id);
  expect(data.week).toBe(
    DateTime.fromJSDate(f.session.startsAt, { zone: f.shop.timezone })
      .startOf("week")
      .toISODate(),
  );
  expect(headers()).toEqual({ "Cache-Control": "private, no-store" });
  await expect(
    loader({ ...args, params: { id: randomUUID() } }),
  ).rejects.toMatchObject({ status: 404 });
});
