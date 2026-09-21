import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEVELOPMENT_BOOKING_SHOP,
  PRODUCTION_BOOKING_SHOP,
  bookingProductStatus,
  commerceCapabilities,
  developmentReleaseReady,
} from "../app/services/commerce-capabilities.server";

afterEach(() => vi.unstubAllEnvs());

describe("development commerce release gates", () => {
  test("remain closed by default", () => {
    expect(commerceCapabilities(DEVELOPMENT_BOOKING_SHOP)).toEqual({
      checkoutAvailable: false,
      ownedPassesAvailable: false,
    });
  });

  test("open independently only for the exact configured development shop", () => {
    vi.stubEnv("SKYRA_BOOKING_TEST_SHOP", DEVELOPMENT_BOOKING_SHOP);
    vi.stubEnv("SKYRA_BOOKING_CHECKOUT_ENABLED", "true");
    vi.stubEnv("SKYRA_BOOKING_OWNED_PASSES_ENABLED", "TRUE");

    expect(commerceCapabilities(DEVELOPMENT_BOOKING_SHOP)).toEqual({
      checkoutAvailable: true,
      ownedPassesAvailable: true,
    });
    expect(developmentReleaseReady(DEVELOPMENT_BOOKING_SHOP)).toBe(true);
    expect(commerceCapabilities("skyrastudio.myshopify.com")).toEqual({
      checkoutAvailable: false,
      ownedPassesAvailable: false,
    });
  });

  test("a production domain cannot be allowlisted through environment variables", () => {
    vi.stubEnv("SKYRA_BOOKING_TEST_SHOP", "skyrastudio.myshopify.com");
    vi.stubEnv("SKYRA_BOOKING_CHECKOUT_ENABLED", "true");
    vi.stubEnv("SKYRA_BOOKING_OWNED_PASSES_ENABLED", "true");

    expect(commerceCapabilities("skyrastudio.myshopify.com")).toEqual({
      checkoutAvailable: false,
      ownedPassesAvailable: false,
    });
  });
});

test("production requires its own exact target, approval and independent gates", () => {
  vi.stubEnv("SKYRA_BOOKING_TEST_SHOP", PRODUCTION_BOOKING_SHOP);
  vi.stubEnv("SKYRA_BOOKING_CHECKOUT_ENABLED", "true");
  vi.stubEnv("SKYRA_BOOKING_OWNED_PASSES_ENABLED", "true");
  expect(commerceCapabilities(PRODUCTION_BOOKING_SHOP).checkoutAvailable).toBe(
    false,
  );
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_SHOP", PRODUCTION_BOOKING_SHOP);
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED", "true");
  expect(commerceCapabilities(PRODUCTION_BOOKING_SHOP).checkoutAvailable).toBe(
    false,
  );
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED", "true");
  expect(commerceCapabilities(PRODUCTION_BOOKING_SHOP)).toEqual({
    checkoutAvailable: true,
    ownedPassesAvailable: false,
  });
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_OWNED_PASSES_ENABLED", "true");
  expect(developmentReleaseReady(PRODUCTION_BOOKING_SHOP)).toBe(true);
  expect(developmentReleaseReady("other.myshopify.com")).toBe(false);
  vi.stubEnv("SKYRA_BOOKING_EMERGENCY_STOP", "true");
  expect(commerceCapabilities(PRODUCTION_BOOKING_SHOP)).toEqual({
    checkoutAvailable: false,
    ownedPassesAvailable: false,
  });
});

test("production catalogue sync keeps products draft until release; legacy Passes are never sold", () => {
  expect(
    bookingProductStatus(PRODUCTION_BOOKING_SHOP, { status: "ACTIVE" }),
  ).toBe("DRAFT");
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_SHOP", PRODUCTION_BOOKING_SHOP);
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED", "true");
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED", "true");
  expect(
    bookingProductStatus(PRODUCTION_BOOKING_SHOP, { status: "ACTIVE" }),
  ).toBe("ACTIVE");
  expect(
    bookingProductStatus(PRODUCTION_BOOKING_SHOP, {
      status: "ACTIVE",
      saleable: false,
    }),
  ).toBe("DRAFT");
  vi.stubEnv("SKYRA_BOOKING_EMERGENCY_STOP", "true");
  expect(
    bookingProductStatus(PRODUCTION_BOOKING_SHOP, { status: "ACTIVE" }),
  ).toBe("DRAFT");
});
