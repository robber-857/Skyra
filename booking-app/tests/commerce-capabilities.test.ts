import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEVELOPMENT_BOOKING_SHOP,
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
