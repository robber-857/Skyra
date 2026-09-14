import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import {
  canTestCoachPortal,
  coachTestLogin,
} from "../app/services/coach-test-access.server";
import {
  coachIdentity,
  exchangeCoachLogin,
  requireCoachFormOrigin,
} from "../app/services/coach-auth.server";
import type { Actor } from "../app/services/authorization";

let fixture: Awaited<ReturnType<typeof paidFixture>>;
let other: Awaited<ReturnType<typeof paidFixture>>;
let actor: Actor;
const origin = "https://coach-test.example";
beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test database required");
  // Only isolated test records can be retired; never run against the dev store DB.
  await db.shop.updateMany({
    where: { domain: "skyra-booking-dev.myshopify.com" },
    data: { domain: `retired-${randomUUID()}.myshopify.com` },
  });
  fixture = await paidFixture();
  other = await paidFixture();
  await db.shop.update({
    where: { id: fixture.shop.id },
    data: { domain: "skyra-booking-dev.myshopify.com" },
  });
  actor = { shopId: fixture.shop.id, actorId: randomUUID(), role: "ADMIN" };
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (fixture)
    await db.shop.update({
      where: { id: fixture.shop.id },
      data: { domain: fixture.shop.domain },
    });
  await db.$disconnect();
});
function development() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SHOPIFY_APP_URL", origin);
}

test("dev Admin issues a fragment-only one-time link for the selected coach, with audit and no stored plaintext", async () => {
  development();
  const url = new URL(await coachTestLogin(actor, fixture.coach.id));
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe("/coach/login");
  expect(url.search).toBe("");
  const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const identity = await coachIdentity(await exchangeCoachLogin(token));
  expect(identity.coachId).toBe(fixture.coach.id);
  await expect(exchangeCoachLogin(token)).rejects.toMatchObject({
    code: "COACH_LINK_EXPIRED",
  });
  expect(
    JSON.stringify(
      await db.coachAccessToken.findMany({
        where: { shopId: fixture.shop.id },
      }),
    ),
  ).not.toContain(token);
  expect(
    await db.auditLog.count({
      where: {
        shopId: fixture.shop.id,
        actorId: actor.actorId,
        action: "COACH_LOGIN_ISSUED",
      },
    }),
  ).toBe(1);
});

test.each(["production", "test"])(
  "test access cannot issue credentials in %s",
  async (mode) => {
    development();
    vi.stubEnv("NODE_ENV", mode);
    expect(canTestCoachPortal(actor, "skyra-booking-dev.myshopify.com")).toBe(
      false,
    );
    await expect(coachTestLogin(actor, fixture.coach.id)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
  },
);
test.each(["OPERATIONS", "COACH"] as const)(
  "%s cannot open another coach's test portal",
  async (role) => {
    development();
    await expect(
      coachTestLogin({ ...actor, role }, fixture.coach.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  },
);
test("another shop and another shop's coach are rejected", async () => {
  development();
  await expect(
    coachTestLogin({ ...actor, shopId: other.shop.id }, other.coach.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(coachTestLogin(actor, other.coach.id)).rejects.toMatchObject({
    code: "COACH_NOT_FOUND",
  });
});
test("a disabled coach cannot receive a test credential", async () => {
  development();
  await db.coach.update({
    where: { id: fixture.coach.id },
    data: { status: "INACTIVE" },
  });
  try {
    await expect(coachTestLogin(actor, fixture.coach.id)).rejects.toMatchObject(
      { code: "COACH_NOT_FOUND" },
    );
  } finally {
    await db.coach.update({
      where: { id: fixture.coach.id },
      data: { status: "ACTIVE" },
    });
  }
});
test.each(["http://localhost:3000", "https://user:password@example.com"])(
  "invalid portal origin cannot issue credentials: %s",
  async (url) => {
    development();
    vi.stubEnv("SHOPIFY_APP_URL", url);
    const before = await db.coachAccessToken.count({
      where: { shopId: fixture.shop.id },
    });
    await expect(coachTestLogin(actor, fixture.coach.id)).rejects.toMatchObject(
      { code: "APP_URL_REQUIRED" },
    );
    expect(
      await db.coachAccessToken.count({ where: { shopId: fixture.shop.id } }),
    ).toBe(before);
  },
);
test("coach form accepts the exact configured public origin forwarded to localhost", () => {
  development();
  expect(() =>
    requireCoachFormOrigin(
      new Request("http://localhost:3000/coach/login", {
        method: "POST",
        headers: { Origin: origin },
      }),
    ),
  ).not.toThrow();
});
test.each([
  "https://attacker.example",
  "https://coach-test.example.attacker.example",
  "null",
  "",
])("coach form rejects unrelated or missing origin: %s", (untrusted) => {
  development();
  try {
    requireCoachFormOrigin(
      new Request("http://localhost:3000/coach/login", {
        method: "POST",
        headers: untrusted ? { Origin: untrusted } : {},
      }),
    );
    expect.fail("Untrusted origin must be denied");
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(403);
  }
});

test("coach form accepts the Render external URL when no explicit App URL is set", () => {
  development();
  vi.stubEnv("SHOPIFY_APP_URL", "");
  vi.stubEnv("RENDER_EXTERNAL_URL", "https://skyra-booking-web.onrender.com");
  expect(() =>
    requireCoachFormOrigin(
      new Request("http://localhost:3000/coach/login", {
        method: "POST",
        headers: { Origin: "https://skyra-booking-web.onrender.com" },
      }),
    ),
  ).not.toThrow();
});
