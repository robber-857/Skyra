import { expect, test, vi } from "vitest";
import {
  inspectNativeBookingCart,
  normalizeNativeCartHandoff,
  prepareNativeBookingCart,
} from "../theme-extension-src/native-cart.js";

const handoff = {
  status: "NATIVE_CART_READY",
  variantId: 654,
  bookingReference: "a".repeat(43),
  priceCents: 22000,
  currency: "AUD",
};
const item = {
  variant_id: 654,
  quantity: 1,
  final_price: 22000,
  properties: { _skyra_booking_ref: handoff.bookingReference },
};

test("accepts only a strict development native-cart handoff", () => {
  expect(normalizeNativeCartHandoff(handoff)).toMatchObject({ variantId: 654 });
  for (const invalid of [
    { ...handoff, status: "CHECKOUT_READY" },
    { ...handoff, variantId: "654" },
    { ...handoff, bookingReference: "short" },
    { ...handoff, currency: "USD" },
  ])
    expect(() => normalizeNativeCartHandoff(invalid)).toThrow(
      "Shopify Cart is not ready",
    );
});

test("accepts only an empty cart or the exact idempotent booking line", () => {
  expect(
    inspectNativeBookingCart(
      { item_count: 0, items: [], total_price: 0, currency: "AUD" },
      handoff,
    ),
  ).toBe("EMPTY");
  expect(
    inspectNativeBookingCart(
      { item_count: 1, items: [item], total_price: 22000, currency: "AUD" },
      handoff,
    ),
  ).toBe("READY");
  for (const cart of [
    { item_count: 2, items: [item], total_price: 44000, currency: "AUD" },
    { item_count: 1, items: [{ ...item, quantity: 2 }], total_price: 44000, currency: "AUD" },
    { item_count: 1, items: [{ ...item, properties: {} }], total_price: 22000, currency: "AUD" },
    { item_count: 1, items: [{ ...item, final_price: 0 }], total_price: 0, currency: "AUD" },
  ])
    expect(() => inspectNativeBookingCart(cart, handoff)).toThrow(
      "contains another item",
    );
});

test("adds once, verifies the final cart, and retries without duplicating", async () => {
  const empty = { item_count: 0, items: [], total_price: 0, currency: "AUD" };
  const ready = { item_count: 1, items: [item], total_price: 22000, currency: "AUD" };
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(Response.json(empty))
    .mockResolvedValueOnce(Response.json({ items: [item] }))
    .mockResolvedValueOnce(Response.json(ready))
    .mockResolvedValueOnce(Response.json(ready));
  const runtime = {
    fetchImpl,
    location: { origin: "https://skyra-booking-dev.myshopify.com" },
    shopify: { routes: { root: "/en/" } },
  };
  await expect(prepareNativeBookingCart(handoff, runtime)).resolves.toBe(
    "https://skyra-booking-dev.myshopify.com/en/cart",
  );
  expect(fetchImpl.mock.calls[1][0]).toContain("/en/cart/add.js");
  expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
    items: [
      {
        id: 654,
        quantity: 1,
        properties: { _skyra_booking_ref: handoff.bookingReference },
      },
    ],
  });
  await expect(prepareNativeBookingCart(handoff, runtime)).resolves.toContain(
    "/en/cart",
  );
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});
