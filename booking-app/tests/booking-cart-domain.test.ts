import { expect, test } from "vitest";
import {
  assertBookingCart,
  BOOKING_REFERENCE_KEY,
  type BookingCart,
} from "../app/services/shopify-cart.server";
import { PRODUCTION_BOOKING_SHOP } from "../app/services/commerce-capabilities.server";

const target = {
  reference: "synthetic-booking-reference",
  productGid: "gid://shopify/Product/1",
  variantGid: "gid://shopify/ProductVariant/2",
  priceCents: 4900,
};

function cart(checkoutUrl: string): BookingCart {
  return {
    id: "gid://shopify/Cart/synthetic?key=test-only",
    checkoutUrl,
    totalQuantity: 1,
    buyerIdentity: { countryCode: "AU" },
    lines: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: "gid://shopify/CartLine/synthetic",
          quantity: 1,
          attributes: [{ key: BOOKING_REFERENCE_KEY, value: target.reference }],
          merchandise: {
            id: target.variantGid,
            product: { id: target.productGid },
          },
          sellingPlanAllocation: null,
          cost: { amountPerQuantity: { amount: "49.0", currencyCode: "AUD" } },
        },
      ],
    },
  };
}

test.each([
  "https://skyrastudio.com.au/cart/synthetic",
  "https://skyrastudio.com.au/checkouts/synthetic",
  `https://${PRODUCTION_BOOKING_SHOP}/checkouts/synthetic`,
  "https://checkout.shopify.com/checkouts/synthetic",
])("accepts the production shop's trusted checkout: %s", (url) => {
  expect(assertBookingCart(cart(url), target, PRODUCTION_BOOKING_SHOP)).toBe(
    url,
  );
});

test.each([
  "https://skyrastudio.com.au.evil.example/cart/synthetic",
  "https://evil.example/cart/synthetic",
  "https://www.skyrastudio.com.au/cart/synthetic",
  "http://skyrastudio.com.au/cart/synthetic",
  "https://user@skyrastudio.com.au/cart/synthetic",
  "https://skyrastudio.com.au:8443/cart/synthetic",
  "https://skyrastudio.com.au/account",
])("rejects untrusted checkout URLs: %s", (url) => {
  expect(() =>
    assertBookingCart(cart(url), target, PRODUCTION_BOOKING_SHOP),
  ).toThrow("This cart changed");
});

test("does not trust Skyra's custom domain for another shop", () => {
  expect(() =>
    assertBookingCart(
      cart("https://skyrastudio.com.au/cart/synthetic"),
      target,
      "another-shop.myshopify.com",
    ),
  ).toThrow("This cart changed");
});

test.each(["price", "reference", "quantity"])(
  "still rejects a changed %s on the trusted custom domain",
  (field) => {
    const value = cart("https://skyrastudio.com.au/cart/synthetic");
    const line = value.lines.nodes[0];
    if (field === "price") line.cost.amountPerQuantity.amount = "1.00";
    if (field === "reference") line.attributes[0].value = "another-booking";
    if (field === "quantity") line.quantity = 2;
    expect(() =>
      assertBookingCart(value, target, PRODUCTION_BOOKING_SHOP),
    ).toThrow("This cart changed");
  },
);
