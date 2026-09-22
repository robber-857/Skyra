import type { LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEVELOPMENT_BOOKING_SHOP,
  PRODUCTION_BOOKING_SHOP,
  publicScheduleAvailable,
} from "../app/services/commerce-capabilities.server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  shop: vi.fn(),
  sessions: vi.fn(),
  clock: vi.fn(),
  availability: vi.fn(),
  bookingWindow: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { appProxy: mocks.auth } },
}));
vi.mock("../app/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shop },
    classSession: { findMany: mocks.sessions },
  },
}));
vi.mock("../app/services/booking.server", () => ({
  databaseNow: mocks.clock,
  classAvailability: mocks.availability,
  bookingWindow: mocks.bookingWindow,
}));

import { loader } from "../app/routes/apps.skyra-booking.sessions";

const gateEnvs = [
  "SKYRA_BOOKING_PRODUCTION_SHOP",
  "SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED",
  "SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED",
  "SKYRA_BOOKING_PRODUCTION_OWNED_PASSES_ENABLED",
  "SKYRA_BOOKING_EMERGENCY_STOP",
];
const publishedSession = {
  id: "published-session",
  status: "PUBLISHED",
  startsAt: new Date("2026-09-23T00:00:00Z"),
  endsAt: new Date("2026-09-23T00:55:00Z"),
  capacity: 6,
  service: {
    id: "service",
    status: "ACTIVE",
    kind: "CLASS",
    name: "Fixture Aerial",
    description: "",
    level: "",
    durationMin: 55,
    categoryId: null,
  },
  coach: { id: "coach", status: "ACTIVE", name: "Fixture Coach" },
  location: { id: "location", name: "Fixture Studio" },
};

function approveProduction() {
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_SHOP", PRODUCTION_BOOKING_SHOP);
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED", "true");
}

function setShop(
  domain = PRODUCTION_BOOKING_SHOP,
  rules: Record<string, unknown> = { onlineBookingsEnabled: true },
) {
  mocks.shop.mockResolvedValue({
    id: "shop",
    domain,
    status: "ACTIVE",
    timezone: "Australia/Sydney",
    rules,
  });
}

function request(domain = PRODUCTION_BOOKING_SHOP) {
  return loader({
    request: new Request(
      `https://app.example/apps/skyra-booking/sessions?shop=${domain}&from=2026-09-22&to=2026-09-28`,
    ),
  } as LoaderFunctionArgs);
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const name of gateEnvs) vi.stubEnv(name, undefined);
  mocks.auth.mockResolvedValue({});
  setShop();
  mocks.sessions.mockResolvedValue([publishedSession]);
  mocks.clock.mockResolvedValue(new Date("2026-09-22T00:00:00Z"));
  mocks.availability.mockResolvedValue(new Map([[publishedSession.id, 6]]));
  mocks.bookingWindow.mockReturnValue("OPEN");
});

afterEach(() => vi.unstubAllEnvs());

describe("production public schedule release", () => {
  test.each([
    "no production environment",
    "missing target",
    "wrong target",
    "approval missing",
    "approval false",
    "emergency stop",
    "online false",
    "online missing",
    "online string true",
  ])("hides existing published sessions with %s", async (condition) => {
    approveProduction();
    if (condition === "no production environment") {
      vi.stubEnv("SKYRA_BOOKING_PRODUCTION_SHOP", undefined);
      vi.stubEnv("SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED", undefined);
    }
    if (condition === "missing target")
      vi.stubEnv("SKYRA_BOOKING_PRODUCTION_SHOP", undefined);
    if (condition === "wrong target")
      vi.stubEnv("SKYRA_BOOKING_PRODUCTION_SHOP", DEVELOPMENT_BOOKING_SHOP);
    if (condition === "approval missing")
      vi.stubEnv("SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED", undefined);
    if (condition === "approval false")
      vi.stubEnv("SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED", "false");
    if (condition === "emergency stop")
      vi.stubEnv("SKYRA_BOOKING_EMERGENCY_STOP", "true");
    if (condition === "online false")
      setShop(PRODUCTION_BOOKING_SHOP, { onlineBookingsEnabled: false });
    if (condition === "online missing") setShop(PRODUCTION_BOOKING_SHOP, {});
    if (condition === "online string true")
      setShop(PRODUCTION_BOOKING_SHOP, { onlineBookingsEnabled: "true" });

    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      timezone: "Australia/Sydney",
      generatedAt: expect.any(String),
      sessions: [],
    });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(mocks.sessions).not.toHaveBeenCalled();
    expect(mocks.availability).not.toHaveBeenCalled();
  });

  test("returns the approved schedule independently of purchase switches", async () => {
    approveProduction();
    vi.stubEnv("SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED", "false");
    vi.stubEnv("SKYRA_BOOKING_PRODUCTION_OWNED_PASSES_ENABLED", "false");

    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      timezone: "Australia/Sydney",
      sessions: [
        {
          id: publishedSession.id,
          capacity: 6,
          spotsRemaining: 6,
          bookingStatus: "OPEN",
        },
      ],
    });
    expect(mocks.sessions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shopId: "shop",
          status: "PUBLISHED",
          service: { status: "ACTIVE" },
          coach: { status: "ACTIVE" },
        }),
      }),
    );
  });

  test.each([DEVELOPMENT_BOOKING_SHOP, "other.myshopify.com"])(
    "preserves existing public schedule behavior for %s",
    async (domain) => {
      setShop(domain, { onlineBookingsEnabled: false });
      vi.stubEnv("SKYRA_BOOKING_EMERGENCY_STOP", "true");

      const response = await request(domain);
      expect(response.status).toBe(200);
      expect((await response.json()).sessions).toHaveLength(1);
      expect(mocks.sessions).toHaveBeenCalledOnce();
    },
  );

  test("authenticates App Proxy requests before returning a closed schedule", async () => {
    const denied = new Response("", { status: 401 });
    mocks.auth.mockRejectedValue(denied);
    await expect(request()).rejects.toBe(denied);
    expect(mocks.shop).not.toHaveBeenCalled();
    expect(mocks.sessions).not.toHaveBeenCalled();
  });
});

test("the fixed production domain remains protected when the target is absent", () => {
  vi.stubEnv("SKYRA_BOOKING_TEST_SHOP", PRODUCTION_BOOKING_SHOP);
  expect(publicScheduleAvailable(PRODUCTION_BOOKING_SHOP, true)).toBe(false);
  expect(
    publicScheduleAvailable(` ${PRODUCTION_BOOKING_SHOP.toUpperCase()} `, true),
  ).toBe(false);
  approveProduction();
  expect(publicScheduleAvailable(PRODUCTION_BOOKING_SHOP, true)).toBe(true);
});
