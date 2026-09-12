# Skyra Booking

Booking V3 application for the Skyra Shopify storefront. Generated from the official Shopify React Router TypeScript template; PostgreSQL + Prisma, Redis + BullMQ.

**Current state:** foundation, Admin catalogue/schedule, storefront Browse/Details and Shopify login handoff, server-backed Booking Attempts, computed capacity and internal 15-minute Holds. Not a production-ready booking system. Full Calendar and new-Pass selection/Review are implemented. Confirmed booking, payment, owned-Pass entitlement ledger and role portals are not implemented yet. See [development status](../docs/booking-system/development-status.md) and [preview and testing](../docs/booking-system/preview-testing.md).

## Shopify identity

- Name: **Skyra Booking**
- Organization: **Skyra** (232832637)
- Client ID: `c9d266a38e2f11a1240139974253b3a1` (public app identifier, not a secret)
- Linked configuration: `shopify.app.toml`
- Development store: `skyra-booking-dev.myshopify.com`; the app is installed and OAuth has been verified.
- Released configuration: `v3-m1-20260909-3` in the Shopify Dev Dashboard.

## Local setup (PowerShell)

Use Node 24 and Docker Desktop. From this directory:

```powershell
npm.cmd ci
Copy-Item .env.example .env # First setup only; do not overwrite an existing .env
docker compose up -d
npm.cmd run setup
npm.cmd run test:db
npm.cmd run check
```

PostgreSQL listens only on 127.0.0.1:55432; Redis on 127.0.0.1:56379. These are separate from other project containers. The checked-in Docker credentials are local-development-only. Never use them for hosted environments. Production must provide managed PostgreSQL/Redis, secrets and backups.

The CLI supplies app credentials during `shopify app dev`. For a separately running worker, configure the app's actual credentials securely in the ignored `.env`, then run `npm.cmd run worker`. Do not paste secrets into chat or commit them. The worker requires an installed app's offline Shopify session in the database.

The application deliberately has no development authentication bypass. Open the embedded Admin through Shopify. Only the verified Shopify account owner can bootstrap the first ADMIN; other staff require a matching active StaffAccount. Customer login uses Shopify hosted sign-in; completed sign-in and cookie restoration still need real-customer E2E verification. The Coach portal is pending.

## First operational workflow

1. Settings: add a location/timezone.
2. People: add a coach and before/after buffers.
3. Classes & Passes: add an active class, price, duration, capacity, location and eligible coaches.
4. Add a Pass with credits, validity days and eligible classes.
5. The catalogue save and outbox commit together. Start the worker to synchronize Shopify. Mapping status is refreshed in the editor; errors have an explicit retry.
6. Weekly Schedule: select actual date/time/coach, save draft, repeat for up to 13 weeks, or copy the previous week.
7. Publish week. Sessions remain in PostgreSQL; they never create per-session Shopify products.

This slice treats a location as an exclusive room. Shared locations, resource quantities, appointment availability and persistent editable recurrence series are not yet implemented. Draft/PUBLISHED session snapshots preserve dates and capacity independently of later class defaults.

New Class/Pass/Coach creation forms have no automatic network retry. An uncertain save should be checked in the list before submitting again; database-backed creation-request idempotency remains to implement. Session creation, week copying, week publishing, sync replay and catalogue updates already have replay/concurrency protections.

## Tests and validation

- `npm.cmd run test:db`: creates/uses only `skyra_booking_test` and runs 64 tests, including PostgreSQL integration and proxy/auth unit tests. Tests refuse any other database name.
- `npm.cmd run build:theme-extension`: builds `theme-extension-src/booking.js`, `login.js`, `attempt.js`, `calendar.js` and `transaction.js` into five minified Theme App Extension assets, each under Shopify's 10 KB limit.
- npm.cmd run check: typecheck, ESLint, production build.
- `shopify app config validate --json`: official app and extension config validation.
- `scripts/validate-graphql.ts`: uses the installed Shopify AI Toolkit validator specified in `SHOPIFY_GRAPHQL_VALIDATOR`; all seven catalogue operations were validated.
- `scripts/dev-store-worker-smoke.ts`: dev-store-only save → Redis/BullMQ Worker → Shopify sync check.
- `scripts/dev-store-catalog-smoke.ts`: dev-store-only Service/Pass Product, Variant, Metafield and Metaobject read-back check.
- `scripts/dev-store-definition-check.ts`: read-only dev-store diagnostic for Booking Metaobject definitions.
- `scripts/smoke.cjs`: built-server auth/webhook/health checks plus browser checks of the login entry and disabled extension mounts. Supply `PLAYWRIGHT_MODULE` when using the bundled Playwright package. This does **not** certify authenticated Admin screens or a live booking flow.
- CI is in the repository root at `../.github/workflows/booking-ci.yml`; it has not run remotely yet.

## Extension and release boundary

The Theme App Extension now loads one shared storefront bundle into explicit Home and Programs mounts. It reads published PostgreSQL Sessions through the signed /apps/skyra-booking/sessions App Proxy and renders Browse, filters, Details, Shopify sign-in guidance, and full loading/empty/error states. Availability subtracts confirmed bookings and unexpired Holds. The signed `/pass-options` endpoint supplies eligible synchronized new Passes and revalidates Review prices; checkout remains disabled. Owned Passes and confirmed booking are still unavailable.

The local Home/Programs templates now use the shared mounts and no longer contain static availability, preview handlers, or Mindbody URLs. These theme changes are not deployed to the production store. The existing dirty shopify-theme/assets/skyra.css remains untouched. The development store must approve write_app_proxy and save the app embed before storefront visual testing.
## Sources

- https://github.com/Shopify/shopify-app-template-react-router
- https://shopify.dev/docs/api/shopify-app-react-router/latest/authenticate/admin
- https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productSet
- https://shopify.dev/docs/apps/build/custom-data
- https://shopify.dev/docs/apps/build/online-store/theme-app-extensions



## Class Booking foundation — 2026-09-10

- Apply the additive `202609100001_booking_foundation` migration before running the updated app/worker: `npm run setup`.
- `POST /apps/skyra-booking/start` and `/attempt` use verified App Proxy identity and JSON + `X-Skyra-Booking: 1`. Public `/sessions` now returns computed availability and booking-window status without caching.
- `app/services/booking.server.ts` owns attempts, customer binding, capacity, internal seat holds and expiration. The Worker sweeps every 30 seconds; expired holds stop counting immediately even if the Worker is offline.
- New Pass hold creation remains an internal primitive. Do not enable `onlineBookingsEnabled` until Pass/Review, Cart, orders/paid, entitlement and booking confirmation/recovery are integrated.
- `npm run test:db` runs all tests against `skyra_booking_test`; the Booking Engine tests include 20-way last-seat races and direct database constraint checks.
- `scripts/booking-login-smoke.cjs` exercises the built theme assets with local API fixtures. Set PLAYWRIGHT_MODULE to the installed Playwright module path, build the theme extension first, then run it with Node.
- `scripts/booking-http-smoke.ts` is an optional built-app test. It requires a dedicated test-database server on 127.0.0.1:3310, test Shopify API key, the script's local fixture signing key, and data from `npm run test:db`. Never point it at a live database or use real Shopify signing credentials.
- Real Shopify hosted login and storefront cookies still need development-store E2E. No production deployment or complete purchase flow is claimed.

### Development preview diagnostics (2026-09-11)

Run `npm run preview:check` to sample the local theme, app host, Booking sessions and Shopify upstream separately. Programs is now a required check; its Page resource has been created. `npm run preview:app` and `npm run preview:theme` pin the development theme 192227082532; stop the existing process before restarting. These commands do not publish Horizon.

The shared frontend now has month/week navigation and pre-payment recovery for transient failures, expired attempts, changed Passes and sign-in expiry. Eleven browser fixture scenarios cover both mounts and mobile/desktop; they are not real Shopify login or payment acceptance. Programs Page 167140557092 is configured. Drop-in selection/Review is implemented; Drop-in Hold is not. Checkout, paid webhooks, entitlements and post-payment recovery remain incomplete. Development scripts use IPv4-first with Node network family autoselection disabled for this Windows network; they do not change system networking or TLS. Final live-page/customer-login verification and this batch's push are deferred while the user's connection is slow.
