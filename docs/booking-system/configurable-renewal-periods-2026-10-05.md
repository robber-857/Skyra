# Admin-configurable renewal periods

Date: 2026-10-05. Implementation based on production commit `8ed6e5c`.
Status: implementation prepared for Git delivery on 2026-10-10; deployment and production Pass enablement are not verified by this delivery.

## Admin operation

1. Create a Pass in Classes & Passes. Set its full-period price, credits and eligible classes.
2. Set Calendar months: 1 monthly, 3 quarterly, 6 half-yearly, 12 yearly. The existing input supports whole numbers 1–120. Calendar months override validity days.
3. Save and wait for product synchronization.
4. Open Membership purchases, choose Configure automatic renewal, and wait for Verified.
5. Enable Offer automatic renewal. Allow one-time purchase is independent; turn it off for renewal-only offers. Offer this Pass on Membership controls listing.
6. Save purchase settings. No existing Pass is automatically opted into renewal by this release.

Intro-only and days-only Passes remain ineligible for automatic renewal. An already configured Pass cannot change its duration in place; create a new Pass. Admin access is required for renewal setup and settings.

## Behavior and implementation

- Shopify billing and delivery use MONTH with intervalCount equal to the Pass calendar-month duration. Provider readback and pre-charge contract verification must match the stored purchase duration.
- First payment buys a complete period. Automatic-renewal Passes wait for staff-confirmed first attendance. Sydney calendar-month expiry gates the next charge; using all credits early does not trigger it.
- Each renewal copies the previous purchase terms and grants one new Pass waiting for its own first attendance. Further billing is blocked while awaiting activation. Existing agreement snapshots remain unchanged.
- Legacy one-time non-monthly activation remains first booked class. One-time monthly activation remains first attendance.
- Both Membership and Booking enforce availability, explicit renewal consent and one-time-purchase restrictions.
- Every auto-renew period uses checkout protection. One-time purchases of a configured renewal Pass also use it. Basic/private-inventory flow keeps one stock unit and requires a selling plan only for the automatic-renew purchase. Function flow retains the stable `managed_monthly_pass` metadata key, sets it during verification, and fails closed if that write is unconfirmed.
- No Prisma schema or migration is required: PassPlan, PassPurchase and Entitlement already store calendar months.
- Existing storefront purchase descriptions already render the server-provided month count; no theme asset changes are needed.

## Verification

Regression coverage includes Admin configuration for 3/6/12 months, immutable configured duration, mismatched Shopify billing/delivery intervals, checkout consent and renewal-only restrictions in both entrypoints, private inventory protection, retryable provider verification, attendance activation, expiry gating, exactly-once renewal issuance, and waiting for next activation.

Local checks passed: npm run check (types, customer extension types, lint, production build); npm run build:worker; 77 Vitest files / 1,061 tests; 8 Python import tests. Final full Vitest run completed at 16:28 Sydney on 2026-10-05. Python tests on Windows use tzdata installed only under ignored output/python-test-deps.
Shopify GraphQL operations validated against API 2026-07 using the Shopify Admin skill. Actual Shopify quarterly/half-yearly/yearly setup, paid checkout and a real renewal charge have not been exercised.

API reference: https://shopify.dev/docs/api/admin-graphql/2026-07/enums/SellingPlanInterval

## Git delivery checks — 2026-10-10

- `npm run check` passed (application and customer extension types, lint, production build).
- `npm run build:worker` passed.
- Four affected suites that do not require a database passed: 142 tests covering the Membership Admin route, checkout guard, selling-plan verification, and Shopify membership responses.
- The full database regression could not be rerun because the local Docker engine was unavailable. The 2026-10-05 full-suite results above are historical evidence, not a fresh full-suite run.
- Live deployment, paid checkout, and real multi-period renewal remain unverified in this delivery.
