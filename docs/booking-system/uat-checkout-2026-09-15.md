# Development-store Checkout UAT — 2026-09-15

## Outcome

Development-store booking reached the signed-in Drop-in review step, but the first Checkout hand-off did not create a Shopify cart. The app returned `503`; the guarded retry returned `409 CART_RECOVERY_REQUIRED`. No order, payment, entitlement, or confirmed booking was created.

## Test setup

- Store: `skyra-booking-dev.myshopify.com`
- Development theme: `preview_theme_id=192227082532`
- Product path tested: Programs → `[DEV] Aerial Foundations` → Single class (Drop-in), A$49
- Test discount: `SKYRAUATFREE915`
  - 100% product discount
  - once per customer
  - usage limit 5
  - active only in the development store
  - expires 2026-09-22 UTC

The discount exists for payment-loop UAT only. It has not yet been redeemed because Shopify Checkout did not open.

## Evidence

- Render logged the initial checkout POST as `503`, followed by a guarded retry as `409`.
- The durable Checkout record remained `UNKNOWN`, with no `cartId` and no payment URL.
- The related seat Hold was `ACTIVE` when inspected and was expected to expire normally.
- No Shopify order and no booking confirmation were produced.

## Root cause and local fix

The Storefront API client had product-read access only. Shopify `cartCreate` also requires `unauthenticated_write_checkouts`.

Local changes now:

- add `unauthenticated_write_checkouts` to the Shopify app configuration and example environment;
- require both product-read and checkout-write scopes for the checkout route;
- keep catalog reads limited to product-read access;
- fail closed if the required scope set is incomplete;
- add a regression test for the route-specific scope contract.

## Verification completed locally

- Database test suite: 28 files, 351 tests passed.
- Typecheck, Customer Account typecheck, ESLint, and production build passed.
- Shopify app configuration validation returned `valid: true` with no issues.

## Deployment status

- Checkout scope fix and this UAT record were committed as `9b355267de5aa496c3b149e626bfc3e1828e165c`; the remote `origin/bookingdev` ref matched exactly.
- GitHub Actions run `34918665617` completed successfully for that commit.
- The missing Render Blueprint scope was corrected in `4ce2015ab8feadd4df2a708f638b2a16f8ecfc2e` and pushed to `origin/bookingdev`.
- Render deploy `dep-dakaij5g1s2s73bkofpg` is live on commit `4ce2015ab8feadd4df2a708f638b2a16f8ecfc2e`; `/health` returns `status=ok`.
- A post-deploy one-off Job verified `hasProduct=true`, `hasCheckout=true`, and `hasOrders=true` in the live runtime.
- Shopify app version `skyra-booking-7` was released successfully with `unauthenticated_write_checkouts`.
- The development store still needs the merchant to approve the new permission once. The OAuth approval page has been opened; no session scope or token was edited manually.

## Next steps, in order

1. Approve `unauthenticated_write_checkouts` on the development-store OAuth page.
2. Reopen Skyra Booking once so Shopify refreshes the app's offline installation session.
3. Verify the stored offline session contains the exact checkout scope.
4. Start a fresh booking attempt after the old Hold expires; do not reuse the recovery-blocked attempt.
5. Reach Shopify Checkout, apply `SKYRAUATFREE915`, and submit the zero-total test order.
6. Verify `orders/paid` receipt and deduplication, Worker/Outbox processing, entitlement creation, Hold conversion, and confirmed Booking.
7. Verify Customer Account booking visibility and the separate entitlements for Group Class, Private, and Workshop products.

Checkout and public booking gates must remain development-only until steps 1–7 are verified end to end.
