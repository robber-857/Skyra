# Pass purchase modes — 2026-10-05

Status: implemented and verified locally; not deployed to production in this change.

## Administrator settings

- **Offer this Pass on Membership** controls whether the offer appears on the Membership page.
- **Allow one-time purchase** controls new one-time purchases through both Membership and Booking.
- **Offer automatic renewal** controls new renewal purchases through both surfaces and still requires a verified eligible monthly plan.

For SKYRA Lifestyle 1 month (AUD 299, 12 classes, one calendar month), leave Membership visibility and automatic renewal on, and turn one-time purchase off. The migration sets oneTimePurchaseEnabled=false only for the exact matching offer in mf0n6s-zg.myshopify.com. Other offers default to true, preserving existing purchase behavior. No existing customer entitlements or subscription agreements change.

Renewal-only offers hide the one-time radio option and select renewal as the purchase mode. The renewal consent checkbox remains unchecked and required. If no enabled mode is available, the server omits the new offer, while existing memberships remain visible for management and cancellation.

## Enforcement and evidence

- Membership rejects a one-time request before creating a payment/cart, including an old request replay after configuration changes.
- Booking rejects one-time review and checkout requests, and includes the setting in its catalogue fingerprint.
- Database migration applied successfully to the dedicated local skyra_booking_test database.
- 155 tests passed across Membership admin, Membership checkout, Booking checkout and membership lifecycle suites.
- npm run check passed (app/customer type checking, lint, production build).
- Storefront bundles rebuilt. Local Chrome fixture checks passed at 1440px and 390px on both purchase surfaces, including hidden one-time options and mandatory explicit renewal consent. Evidence: output/playwright/membership/results.json.

## Release requirements

Deploy the app and migration, publish the updated Membership theme asset and Booking transaction extension asset, then read back the exact production Pass setting and both customer surfaces. This workspace contains unrelated pre-existing changes; release only the intended delta against the deployed baseline.

No production setting, live checkout, payment, or subscription was modified during this implementation. Previously issued native Shopify checkout URLs were not invalidated by this change; inspect and close any outstanding one-time checkout using existing provider reconciliation procedures before claiming those historical links are blocked. The new server rule rejects attempts to obtain them again through the application.
