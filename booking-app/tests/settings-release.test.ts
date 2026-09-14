import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adminContext: vi.fn(),
  transaction: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
  lockShop: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../app/services/context.server", () => ({
  adminContext: mocks.adminContext,
}));
vi.mock("../app/db.server", () => ({
  default: {
    $transaction: mocks.transaction,
    location: { findMany: vi.fn() },
  },
}));
vi.mock("../app/services/catalog.server", () => ({
  lockShop: mocks.lockShop,
  audit: mocks.audit,
}));

import { action } from "../app/routes/app.settings";
import type { ActionFunctionArgs } from "react-router";

const domain = "skyra-booking-dev.myshopify.com";
const actor = { shopId: "shop-id", actorId: "admin-id", role: "ADMIN" };
const approvedShop = {
  id: "shop-id",
  domain,
  status: "ACTIVE",
  rulesApprovedAt: new Date(),
  rules: {
    bookingWindowDays: 14,
    bookingClosesBeforeMinutes: 120,
    seatHoldMinutes: 15,
    onlineBookingsEnabled: false,
  },
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  mocks.adminContext.mockResolvedValue({ actor, shop: approvedShop });
  mocks.findUniqueOrThrow.mockResolvedValue(approvedShop);
  mocks.transaction.mockImplementation((run) =>
    run({
      shop: {
        findUniqueOrThrow: mocks.findUniqueOrThrow,
        update: mocks.update,
      },
    }),
  );
});

function releaseRequest(enabled: boolean) {
  return action({
    request: new Request("https://app.example/app/settings", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        intent: "development-booking",
        enabled: String(enabled),
      }),
    }),
  } as ActionFunctionArgs);
}

test("online booking cannot open before both Render gates are open", async () => {
  vi.stubEnv("SKYRA_BOOKING_TEST_SHOP", domain);
  expect(await releaseRequest(true)).toMatchObject({
    code: "RELEASE_GATE_CLOSED",
  });
  expect(mocks.update).not.toHaveBeenCalled();
});

test("the development store owner can enable online booking with an audit", async () => {
  vi.stubEnv("SKYRA_BOOKING_TEST_SHOP", domain);
  vi.stubEnv("SKYRA_BOOKING_CHECKOUT_ENABLED", "true");
  vi.stubEnv("SKYRA_BOOKING_OWNED_PASSES_ENABLED", "true");

  expect(await releaseRequest(true)).toEqual({
    message: "Development-store online booking enabled.",
  });
  expect(mocks.update).toHaveBeenCalledWith({
    where: { id: actor.shopId },
    data: {
      rules: { ...approvedShop.rules, onlineBookingsEnabled: true },
    },
  });
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.anything(),
    actor,
    "DEVELOPMENT_BOOKING_ENABLED",
    actor.shopId,
    approvedShop.rules,
    { ...approvedShop.rules, onlineBookingsEnabled: true },
  );
});

test("another store cannot use the development release control", async () => {
  vi.stubEnv("SKYRA_BOOKING_TEST_SHOP", domain);
  mocks.adminContext.mockResolvedValue({
    actor,
    shop: { ...approvedShop, domain: "skyrastudio.myshopify.com" },
  });
  expect(await releaseRequest(true)).toMatchObject({ code: "FORBIDDEN" });
  expect(mocks.update).not.toHaveBeenCalled();
});
