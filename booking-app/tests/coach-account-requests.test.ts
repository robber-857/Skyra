import { beforeAll, afterAll, afterEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import {
  requestCoachAccount,
  reviewCoachAccount,
} from "../app/services/coach-account-requests.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const f = await paidFixture();
  vi.stubEnv("SKYRA_COACH_LOGIN_SHOP", f.shop.domain);
  const actor = {
    shopId: f.shop.id,
    actorId: "ADMIN_TEST",
    role: "ADMIN" as const,
  };
  await requestCoachAccount({ name: "Karen", email: " KAREN@example.com " });
  const request = await db.coachAccountRequest.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  return { f, actor, request };
}
test("coach supplies email without creating a coach identity or access token", async () => {
  const { f, request } = await setup();
  expect(request).toMatchObject({
    name: "Karen",
    email: "karen@example.com",
    status: "PENDING",
    approvedCoachId: null,
  });
  expect(await db.coach.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    await db.coachAccessToken.count({ where: { shopId: f.shop.id } }),
  ).toBe(0);
});
test("Admin approves by linking existing coach; course assignments stay unchanged", async () => {
  const { f, actor, request } = await setup();
  await reviewCoachAccount(actor, {
    requestId: request.id,
    decision: "approve",
    coachId: f.coach.id,
  });
  expect(
    await db.coach.findUniqueOrThrow({ where: { id: f.coach.id } }),
  ).toMatchObject({
    loginEmail: request.email,
    notificationEmail: request.email,
    loginVerifiedAt: null,
  });
  expect(
    (await db.classSession.findUniqueOrThrow({ where: { id: f.session.id } }))
      .coachId,
  ).toBe(f.coach.id);
  expect(await db.coach.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    (
      await db.coachAccountRequest.findUniqueOrThrow({
        where: { id: request.id },
      })
    ).status,
  ).toBe("APPROVED");
});
test("duplicate and concurrent applications do not create extra pending requests", async () => {
  const { f } = await setup();
  await Promise.all(
    Array.from({ length: 10 }, () =>
      requestCoachAccount({ name: "Karen", email: "karen@example.com" }),
    ),
  );
  expect(
    await db.coachAccountRequest.count({ where: { shopId: f.shop.id } }),
  ).toBe(1);
});
test("only Admin in the same shop can review and link an active coach", async () => {
  const { f, actor, request } = await setup();
  const other = await paidFixture();
  const input = {
    requestId: request.id,
    decision: "approve",
    coachId: f.coach.id,
  };
  await expect(
    reviewCoachAccount({ ...actor, role: "OPERATIONS" }, input),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    reviewCoachAccount({ ...actor, shopId: other.shop.id }, input),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    reviewCoachAccount(actor, { ...input, coachId: other.coach.id }),
  ).rejects.toMatchObject({ status: 404 });
  await db.coach.update({
    where: { id: f.coach.id },
    data: { status: "INACTIVE" },
  });
  await expect(reviewCoachAccount(actor, input)).rejects.toMatchObject({
    status: 404,
  });
});
test("a new request cannot replace another coach email; rejection grants no access", async () => {
  const { f, actor, request } = await setup();
  await db.coach.update({
    where: { id: f.coach.id },
    data: { loginEmail: "someone-else@example.com" },
  });
  await expect(
    reviewCoachAccount(actor, {
      requestId: request.id,
      decision: "approve",
      coachId: f.coach.id,
    }),
  ).rejects.toMatchObject({ code: "COACH_ALREADY_BOUND" });
  await reviewCoachAccount(actor, {
    requestId: request.id,
    decision: "reject",
  });
  await expect(
    reviewCoachAccount(actor, {
      requestId: request.id,
      decision: "approve",
      coachId: f.coach.id,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await db.coach.findUniqueOrThrow({ where: { id: f.coach.id } }))
      .loginEmail,
  ).toBe("someone-else@example.com");
});
