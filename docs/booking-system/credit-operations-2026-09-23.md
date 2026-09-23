# Booking credit operations and pre-launch acceptance — 2026-09-23

## Current scope

The user is testing https://mf0n6s-zg.myshopify.com/ before launch. Domain cutover is not part of this change. Receiving confirmations/reminders and seeing Shopify customers verifies those individual paths, not complete booking acceptance.

Read-only live checks on September 23 returned five published sessions across three services: Aerial Flow x Stretching x Inversions, Aerial Flow Basic+, and Aerial Pilates. A fresh storefront browser also showed all three class-filter options. No Private session was returned in the September 23–October 23 window. The earlier single-option screenshot was not reproduced; its cause remains unconfirmed.

## Changes (local until deployed)

- The existing 30-second worker sweep now consumes a confirmed booking's reserved credit after its session end, without the previous 24-hour delay. Pass and paid single-class bookings use the same ledger path. Overdue bookings are picked up on the next worker sweep after deployment. Session status and end time are rechecked under lock.
- Default attendance remains ATTENDED as in the existing system; this is an operational default, not independent proof that the customer attended. Staff/assigned coach can record NO_SHOW after automatic completion without a second charge.
- Admin/Operations can use Bookings > booking detail > Cancel and release credit for confirmed, attended, no-show, or late-cancelled bookings. Used credits receive an append-only RESTORE entry; the original payment and CONSUME records remain unchanged. A reason is mandatory, retries are idempotent, and customers/coaches cannot restore credits.
- Existing pre-class cancellation policy remains unchanged. Credit restoration preserves the original expiry and does not issue a money refund. In particular, an expired single-class entitlement stays expired; returning its historical balance does not grant a fresh usable validity window.
- Clients > client profile > Add credits — cash payment records class/Pass, units, cash received, reason/receipt, and staff actor. Cash grants use MANUAL_CASH with no fake Shopify order. Pass validity starts at the first booked class; service credits use the explicitly entered days from today (default 30). The client profile shows cash amount and reference. The existing Shopify spending report is not a cash reconciliation report.
- Service-specific available credits can now be selected for the same service's bookings. Pass eligibility remains scoped to its configured services and shop.

## Add A$140 Private and other purchase options

1. Classes & Passes > Classes > Add class (or edit the existing production class): choose Private appointment, Price (AUD) 140, correct duration, location and eligible coach; activate. Private appointments have capacity one.
2. Confirm catalog synchronization/purchasability for the production shop. Use the app's catalog workflow; adding an unrelated Shopify product alone does not create a Booking service.
3. Weekly Schedule > Add session: select the Private service, coach and agreed available time, then publish. The class filter derives from published sessions within the displayed 31-day range.
4. Classes & Passes > Passes: create/edit each intended saleable Pass, set price, credits, validity and eligible classes. Activate, allow new purchases (not existing-entitlements-only), and verify its sync/purchasability.
5. Select the corresponding Private session on the storefront. Its single-class option should show A$140 and only matching Passes. Aerial group bookings should not offer unrelated Private/MV Passes. Intro offers are restricted to eligible new customers.

## Acceptance before launch

- Real user on desktop/mobile: new Pass purchase, single-class purchase and existing-credit booking; correct price/eligibility/credit count, booking and notification exactly once.
- End-time settlement for Pass and single class: reserved decreases by one, used increases by one, available remains unchanged. Repeat worker/reload must not deduct again. Mark no-show after settlement and verify unchanged balance.
- Staff restoration before and after consumption, correct reason/history, duplicate submission, expired entitlement behavior, and separate handling of any money refund.
- Cash grant to the intended client, exact amount/units/validity/eligibility, duplicate click protection, then book with those credits without checkout.
- Full class/last-seat concurrency, payment abandoned/failed, delayed or duplicate paid webhook, cancellation/rescheduling inside/outside the policy window.
- Pass first-class activation, calendar-month expiry, expired credit rejection, customer/coach permissions, real 12-hour reminder and cancellation/reschedule suppression.

## Validation and release status

- Dedicated skyra_booking_test database: 49 files, 486 tests passed (including new cash/settlement/restoration cases).
- npm run check: app and Customer Account typechecks, lint, production build passed.
- Fresh live storefront browser: three class-filter options verified.
- Synthetic browser UI: Private selection changes to one credit and exposes validity days; confirmation gates submission; 390px layout has no horizontal overflow. This does not replace authenticated Shopify Admin UAT.
- No production customer balances, catalog, schema or release flags changed. No commit, push, deployment or database migration outside the dedicated test DB was performed.
- Deployment must apply migration 202609230001_booking_credit_operations before the updated web/worker code. Confirm worker is running, inspect an ended real booking and reconcile ledger totals after deployment. The current live store still uses the prior behavior until that release.
