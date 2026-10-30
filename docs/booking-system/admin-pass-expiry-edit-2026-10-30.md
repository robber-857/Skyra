# Admin Pass expiry and available-credit editing

Client profile → each Pass record → **Edit credits & expiry**.

- Set an absolute available-credit balance (0–10,000), a new expiry date, or both. Reserved and consumed credits remain separate ledger balances.
- Expiry dates use the fixed Australia/Sydney timezone and include the selected day; the stored exclusive cutoff is midnight on the next local calendar day. The profile shows the exact cutoff with Sydney time and AEST/AEDT.
- An empty expiry field preserves the exact stored instant. Giving an unactivated Pass an explicit expiry starts it immediately. An expired Pass can be reopened with a future expiry and the desired available balance; expired credits are never silently re-granted.
- Pending/revoked Passes cannot be reopened through this form. Existing reservations block shortening expiry. Every edit requires a reason and confirmation.

## Transaction guarantees

`updateClientPass` checks operations permission and shop/customer ownership, locks the shop and entitlement, checks the displayed balance, expiry and database-managed revision, then writes the expiry/status, optional ADJUST ledger entry and audit receipt in one PostgreSQL transaction.

The request UUID has a unique audit receipt per shop for `PASS_UPDATED`, including expiry-only edits. An identical retry returns without writing. Reusing a UUID with another payload or actor fails. Receipt lookup precedes snapshot checks, so a delayed successful retry cannot overwrite later edits. Different requests based on an old revision fail with a refresh instruction. Ledger failure rolls the entire edit back.

Migration `202610300001_admin_pass_edit` adds the revision column and receipt index, and permits expiry changes while retaining the source, ownership, granted-units and activation-history protections. Deploy this migration before the updated app. No Shopify API or payment records are changed.

## Verification and delivery

The migration was applied to the local dedicated `skyra_booking_test` database. Fourteen targeted database tests passed, including concurrent retries, expiry-only writes, expired reopening, stale edits, delayed retries, authorization, rollback and unactivated Passes. Full regression passed: 80 files / 1,110 tests. App/customer TypeScript, lint and production build passed. The final checks ran outside the Windows sandbox after sandbox temporary-file/output permission failures. Production release details are recorded below. No real customer Pass was edited as a production test.


## Production release — 2026-10-30

- User explicitly authorized deployment. Release commit: [`de8d8fc`](https://github.com/robber-857/Skyra/commit/de8d8fc2ef27b67555c9808b8bd4c5a7e72b850e), pushed to `bookingdev`.
- [Render deployment `dep-dbhv0rnavr4c73d60ok0`](https://dashboard.render.com/web/srv-dajsoofqj5pc73euugi0/deploys/dep-dbhv0rnavr4c73d60ok0) is **Live**. Pre-deploy logs confirm `202610300001_admin_pass_edit` successfully applied to the production `skyra_booking` database at 12:21:42 Australia/Sydney. Service live logged at 12:22:10.
- [GitHub CI 40985069019](https://github.com/robber-857/Skyra/actions/runs/40985069019) passed: database setup, app/customer type checks, lint, production build, full Vitest regression, Worker build and Python import tests.
- Post-deploy `/health`: HTTP 200, `{"status":"ok"}`.
- Both deployed Admin JavaScript files match the locally tested build byte-for-byte (SHA-256):
  - `admin-clients-view-6uUqoBBT.js`: `22EEBD102E75787A313932964C2CE7AEA4DF538BBD49C9D6C80EADC89D5303E4`
  - `app.clients._clientId-CWgHy83x.js`: `DC618AEB166B0285AA8F8FFD1E2B54EF5A2169A78702D21526A49B61E100F31B`
- No Shopify theme, extension, app permissions, business release flags or customer Pass balances were changed during deployment verification.
- Evidence is under ignored `output/pass-edit-release-2026-10-30/`, including the Render Live screenshot and downloaded public assets.
- Previous backend release: `a964100f7a621d68a88449848e85f791f2e36553`. If an application rollback is needed, retain the additive database migration and all audit/ledger records; do not undo customer adjustments.


## Sydney-time follow-up

Expiry editing and the client directory/detail expiry displays now explicitly use `Australia/Sydney`, independent of shop or browser timezone. AEST/AEDT changes automatically with the date. Existing expiry instants are preserved. Local checks passed, including 16 Pass adjustment database tests and summer/winter conversions with a UTC-configured shop, plus app/customer types, lint and production build.
