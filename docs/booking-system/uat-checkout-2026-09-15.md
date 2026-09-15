# Development-store Checkout UAT — 2026-09-15

## Outcome

The development-store Drop-in flow reached signed-in Review, but Shopify did not create a Cart. The final safe diagnostic result was Storefront GraphQL `ACCESS_DENIED`, and a tokenless minimal `cartCreate` returned `Online Store channel is locked.` No order, payment, entitlement, or confirmed booking was created.

## Test setup

- Store: `skyra-booking-dev.myshopify.com`
- Development theme: `preview_theme_id=192227082532`
- Product path: Programs → `[DEV] Aerial Foundations` → Single class (Drop-in), A$49
- Test discount: `SKYRAUATFREE915`
  - 100% product discount
  - once per customer
  - usage limit 5
  - development store only
  - expires 2026-09-22 UTC

The discount exists only for payment-loop UAT. It has not been redeemed because Shopify Checkout did not open.

## Evidence

- The first attempt returned `503`; the guarded retry returned `409 CART_RECOVERY_REQUIRED` and the durable Checkout remained `UNKNOWN` with no `cartId`.
- After deploying safe failure diagnostics, a new attempt logged `BOOKING_CART_REQUEST_FAILED` with operation `create`, kind `SHOPIFY_GRAPHQL`, response status `200`, and GraphQL code `ACCESS_DENIED`.
- A minimal Storefront `cartCreate`, using the real development variant while printing no token, Cart ID, customer field, or secret, returned `hasCart=false` and `Online Store channel is locked.`
- No Checkout URL, Shopify Order, entitlement, ledger reservation, or booking confirmation was produced.

## Root cause

The earlier missing `unauthenticated_write_checkouts` scope was fixed, released in `skyra-booking-7`, approved by the merchant, and verified in the live runtime. The remaining failure is the development store's locked Online Store channel/password protection.

This is not evidence of a Render outage, missing checkout scope, or a frontend selection error.

## Manual unblock

1. Open Shopify Admin.
2. Go to **Online Store → Preferences**.
3. Find **Password protection** or **Restrict store access**.
4. Disable the restriction and Save.
5. Return to Programs and start a brand-new booking attempt. Do not reuse the `UNKNOWN`/recovery-blocked attempt.

If Shopify shows different wording, the required result is that the Online Store sales channel is no longer password protected. The storefront preview bar should no longer say `Password protected`.

## Deployment and verification

- Scope/config fix: `9b355267` and `4ce2015a`; GitHub/Render passed and the live runtime had product, checkout and orders scope.
- Safe cart diagnostic: `cf46c9304b5dca1bb7978500aa02ccdab0401882`; GitHub Actions `34960109742` succeeded and Render deploy `dep-daki5v6k1f9s738584og` is live.
- Final pre-Customer change database suite: 28 files / 351 tests passed; typecheck, Customer Account typecheck, ESLint, build and Shopify app config validation passed.

## Next steps, in order

1. Unlock the development Online Store channel.
2. Start a fresh Group Class Drop-in attempt and reach Shopify Checkout.
3. Apply `SKYRAUATFREE915`.
4. Stop before the final zero-total order submission and obtain explicit user confirmation for that action.
5. Submit once, then verify `orders/paid` deduplication, Outbox/Worker, entitlement creation, Hold conversion and confirmed Booking.
6. Verify the result in Customer Account, then repeat the planned Group Pass, Private and Workshop eligibility cases.

Checkout and public booking gates must remain development-only until the paid transaction loop is verified end to end.
