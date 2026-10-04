# Admin renewal Pass production rollout - 2026-10-04

The backend release adds admin-owned monthly selling plan creation and verification, explicit course eligibility, first-attendance membership accounting, and immutable receipts with the actual paid amount. A 100% first-order discount retains the original agreed price and records paidPriceCents=0. Discounted later billing cycles remain rejected.

Production preflight: mf0n6s-zg.myshopify.com reports shopifyPlus=false and eligibleForSubscriptions=true. It currently lacks subscription-contract and validation scopes. Shopify restricts custom apps containing Function APIs to Plus stores: https://shopify.dev/docs/apps/build/functions . Consequently this is an admin/backend release, not activation of recurring purchases or proof of live free checkout. Keep all production membership enablement and guard verification flags off. Do not publish the membership-test app configuration as a workaround.

Existing unconfigured one-time monthly Passes retain their existing checkout path while this rollout is off. Configured renewal Passes remain blocked without verified checkout protection. The existing store has active SKYRA Lifestyle 1 month and Drop In Yoga 1 class Passes; do not change their products, course mappings, or customer entitlements during this release.

Validation: 75 Vitest files / 1001 tests passed before final legacy-checkout compatibility addition; the final targeted booking suite and production checks are recorded in the release handoff. Shopify Function official runner: 11/11 synthetic fixtures passed, including a free checkout. Python import regressions: 8/8 passed. No live payment or subscription billing was executed.

CI test Postgres maps localhost:55432 to container:5432 to match the safety checks used by local fixture scripts. Isolated schemas prefixed skyra_test_ are accepted only under NODE_ENV=test in the dedicated localhost skyra_booking_test database; existing local data is preserved.
## Basic-compatible checkout preparation (2026-10-05)

- Shopify app version skyra-basic-memberships-20261005 released with subscription contract, payment method, inventory and location scopes explicitly authorized by the owner. No Plus Function is included.
- Backend candidate uses one UNLISTED, tracked, DENY-inventory product per durable first-purchase claim. It is published only to Online Store, never replenished. UNLISTED limits discovery; it is not an access-control boundary. Native inventory must be verified in real-store free-order UAT before enabling billing.
- Existing BookingCheckout context remains immutable. Only an exact settled PassPurchase and READY checkout resource can supply its payment product identity.
- Basic mode: SKYRA_MEMBERSHIPS_CHECKOUT_PROTECTION=INVENTORY and SKYRA_MEMBERSHIPS_INVENTORY_LOCATION_GID. Actual recurring submission additionally requires SKYRA_MEMBERSHIPS_BILLING_ENABLED=true; leave off for free-order UAT. Reconciliation remains allowed while submissions are off.
- Local evidence: full suite 1015 passed; after replacing unavailable app publication with UNLISTED Online Store products, affected 68 tests, check (types/lint/production build), and worker build passed. GraphQL schema validated 2026-07; Publication.name has a deprecation warning.
- Owner selected SKYRA Lifestyle 1 month, AUD 299, 12 classes and existing eligible course scope, with Elton account. 100% first-order discount and real-store checkout/attendance/stock-exclusion proof remain pending.
