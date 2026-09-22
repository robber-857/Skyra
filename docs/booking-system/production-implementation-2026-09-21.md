# Production implementation and operator runbook — 2026-09-21

2026-09-22 最新迁移证据见 [Mindbody 正式店导入记录](mindbody-production-import-2026-09-22.md)。已导入 18 位客户的 20 条权益及 8 条预约；账面 155 available + 8 reserved。原始个人资料和备份均在 Git 外。真实付款、公开 Booking 和邮件仍关闭，迁移成功不代表真实用户 UAT 通过。

## Release decision

**No-Go for public Booking and real payments.** Code preparation does not constitute production OAuth, Customer Account, payment, email or migration acceptance. The existing public theme remains the rollback/current entry; no public Booking entry was enabled.

Target: `mf0n6s-zg.myshopify.com`; branch: `bookingdev`. Never import development customer/order/catalog records or reuse development Product/Variant GIDs.

## Implemented

- Independent production shop allowlist, approval gate, Checkout/Owned Pass switches and global emergency stop. Existing development variables cannot enable production. Admin can enable its online-booking rule only after both relevant environment gates are open and rules are approved.
- Production catalogue sync emits Draft products while the production Checkout gate is closed. `saleable=false` keeps legacy Pass products Draft even after release. Existing published products need explicit unpublishing during a rollback; the emergency flag immediately blocks new Booking transactions but is not a Shopify-wide payment switch.
- A paid new Pass is granted with null activation/expiry. The first successful reservation locks the entitlement, fixes the Sydney course date and expiry, and writes RESERVE in the same transaction. A failed booking leaves the Pass unactivated. Month arithmetic clamps month-end dates and respects Sydney DST; end dates are exclusive. Cancellation/replay never moves the original window. Old activated entitlements keep their dates. Drop-in retains its class-end expiry and no-refund/no-show settlement.
- `PassPlan.validityMonths` overrides legacy `validityDays`; Admin exposes months and the existing-entitlements-only checkbox. Purchase snapshots freeze months/days. Customer/Admin/report views handle unactivated and future-dated balances.
- Mindbody source identifiers, atomic batch import, append-only OPENING_BALANCE and linked RESERVE entries, failure envelope/retry counts, explicit customer aliases approved for merge, and hashed source keys. No fake Shopify Order/LineItem IDs. Import creates no notification/outbox tasks. Imported Sessions remain Draft.
- Imported passes must fit the mapped plan's credits and eligible service kind. Legacy private/MV manifests require a non-saleable plan. Shopify mappings belonging to another shop are rejected. All catalog/customer targets must already exist in the production shop.

## Production variables: keep closed

```dotenv
SKYRA_BOOKING_PRODUCTION_SHOP=mf0n6s-zg.myshopify.com
SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED=false
SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED=false
SKYRA_BOOKING_PRODUCTION_OWNED_PASSES_ENABLED=false
SKYRA_BOOKING_EMERGENCY_STOP=false
```

Set emergency stop to `true` to block new Booking commerce for both allowlisted shops. Do not enable approval or either production capability during installation/migration preparation. `Shop.rules.onlineBookingsEnabled` must remain false. `.env.example` and `render.yaml` describe defaults; they do not prove live Render environment values.

## Source workbook audit

The workbook was read locally, not copied into Git or a cloud service. On September 21: 20 current/future source balance rows, 161 available, 8 reserved, 8 bookings for 7 customers across **6 actual Sessions** (3 service names). Three Lifestyle tranches replace one aggregated row, producing **22 entitlements**. On September 22, expiry filtering removes two Intro rows: 18 source rows, 155 available, 8 reserved, **20 entitlements**. This is a source-file audit, not a production database dry-run or final cutoff delta.

Use the latest source snapshot after freezing Mindbody activity. Historical Sales/Attendance are not imported. Expiration columns in the reconciliation workbook are inclusive civil dates and become the following Sydney midnight internally; Lifestyle ends are already explicitly exclusive.

## Prepare private mappings and manifest

Run from `D:\Skyra\booking-app`. The workbook, mapping and manifest must stay in `D:\Skyra-migration-private\mindbody-2026-09-21` (or another private directory outside the repo).

1. Install the production App and create formal Location, Coach, Service and PassPlan records. Configure confirmed calendar-month plans (Aerial 5/2 months, 10/6, 30/10; Lifestyle 12/1; Dance 10/3, 20/6, Monthly 4/1). Create active but **non-saleable** private 10/5 and restricted MV legacy plans, with explicit eligible services. Duration/capacity remain editable; imported Sessions remain unpublished.
2. Import/deduplicate Shopify customers and run Sync Shopify clients. Use the resulting production CustomerProfile UUIDs. Missing contacts and shared emails require operator decisions; never infer merges from names.
3. A private template is available at `D:\Skyra-migration-private\mindbody-2026-09-21\production-mapping-template-20260921.json`. Fill production shop/location UUIDs, source Client ID to CustomerProfile UUID, PassPlan/service/coach maps. `legacyMappingsConfirmed` must explicitly be true after reviewing scope and saleability. For deliberately merged Client IDs, list **all aliases** in `approvedCustomerMerges`.
4. Generate a new reviewed manifest using a fresh, timezone-qualified cutoff. The converter refuses to overwrite existing outputs. Do not re-date a stale source snapshot to bypass cutoff checks.

```powershell
python scripts/audit_mindbody_workbook.py --workbook 'D:\Skyra-migration-private\mindbody-2026-09-21\Skyra_Mindbody_Booking_Reconciliation_2026-09-21.xlsx' --cutoff-date 2026-09-21
python scripts/prepare-mindbody.py --workbook '<private workbook>' --cutoff '<ISO timestamp with Sydney offset>' --mapping '<private reviewed mapping.json>' --out '<private new manifest.json>' --batch-key '<stable batch name>'
```

The converter splits Lifestyle into sequential 12-credit tranches, applies the documented 11-reported-to-10-private correction with 7 available / 3 consumed, preserves private 5/MV restrictions, and assigns only current future reservations. The exact source values are held only in private files. Mapping template generation alone does not imply approved mappings.

## Database dry-run and apply

Use the correct database connection through the controlled runtime; do not point this at the development store. The importer requires explicit domain **and** matching Shop UUID. It binds to previously synced customers/catalog, creates source aliases rather than duplicate customers, and verifies tenant ownership. Dates, credits, scopes and future reservations are validated before completion. Stable row-key changes are a new source identity: review any corrected activation/source identifiers before rerunning.

```powershell
npm.cmd run migration:mindbody -- --file '<private manifest.json>' --shop mf0n6s-zg.myshopify.com --actor '<operator>' --dry-run
```

Dry-run executes the same transaction and database constraints, then rolls everything back, including audit/source/batch rows. It prints only counts, mode and input hash. Apply requires `--apply --cutoff-approved --backup-reference '<verified restore point>'`; only use these after the actual backup, final delta and operator reconciliation signoff. Apply rejects future cutoffs and cutoffs older than 24 hours. The backup reference is an attestation, not an automatic backup-verification service.

Production image entry point: `node build/ops/import-mindbody.js` with the same arguments. Source files must be transferred privately to a directory outside `/app` (for example a controlled `/tmp` location), never committed into the image. Reusing an identical batch returns replay; changing any approved batch input is a conflict. A new batch can reuse unchanged source rows without resetting current balances. Returned counts describe the opening manifest; separately reconcile current ledger totals after import.

A failed apply rolls back every business record and retains a batch error code. A corrected catalog dependency can retry the same input. Changed source data requires a new batch and explicit conflict review; the importer intentionally does not rewrite historical opening balances or delete bookings as a delta mechanism.

## Validation and operational evidence

- Code commit: `cf4b398b90893532cba417a9ee12ffc3884d87d7`; separate handoff documentation commit: `6a0b892`. Both pushed to `origin/bookingdev`, remote SHA verified.
- Dedicated local PostgreSQL `skyra_booking_test`: 44 files / **422 tests passed**. Three synthetic Python converter tests passed. Type checks, lint, web build, Worker/importer build, Theme extension build and Shopify App build passed.
- [GitHub CI run 35595607133](https://github.com/robber-857/Skyra/actions/runs/35595607133) passed, including fresh-database migrations, checks, tests, Worker/importer build and Python converter tests.
- Render `srv-dajsoofqj5pc73euugi0`: code deploy `dep-daohgrh7lnhs73f1jri0` became live at 11:45:31 UTC. Both new Prisma migrations applied successfully; Worker startup observed. `/health` returned `200 {"status":"ok"}`.
- Production allowlist and three production release switches were written individually through the [Render environment-variable API](https://api-docs.render.com/reference/update-env-var), with all three switches explicitly `false`. Configuration deploy `dep-daohl63tqb8s73fcnb8g` became live at 11:53:56 UTC on the same code commit.
- Read-only runtime job `job-daohlqajnfac7390vce0` succeeded: target domain matches, production Shop ACTIVE, offline access token present, required commerce/customer scopes present; approval/Checkout/Owned Pass switches and `onlineBookingsEnabled` all false. It reports no customers, services, Passes, coaches, locations, synced products or bookings in this new production tenant. No development data was copied.
- Shopify App `skyra-booking-14` released and confirmed active, [version 1137176248321](https://dev.shopify.com/dashboard/232832637/apps/420648878081/versions/1137176248321). Configuration validation returned no issues.
- Production installation/OAuth completed through the authenticated Shopify Admin. Embedded Overview loaded and explicitly showed online bookings closed.
- Production App Proxy `/apps/skyra-booking/sessions` returned HTTP 200, `Australia/Sydney`, and an empty session list. `orders/paid` is declared in the active App configuration; an unsigned request was rejected with HTTP 400. **Actual Shopify paid-event delivery and reconciliation remain unverified.**
- Hidden theme `156227535015` (Copy of Skyra Website – Managed) has the Skyra Booking embed enabled and saved. Home/Programs sections and required shared assets/snippet were synced with `--only` and `--nodelete`. Existing files were backed up under ignored `output/production-theme-156227535015`; no theme was published.
- Hidden Home and Programs loaded the production calendar's empty state at 1440px and 390px. Document width did not exceed the viewport. The inspected Home console error was a missing favicon, not a Booking error. This is empty-state preview verification, not full UAT.
- Customer Account **draft** configuration `7418773671` (Copy of My Store 3 configuration) was created from the active configuration. Skyra bookings and passes was added, API URL set to `https://skyra-booking-web.onrender.com`, and Find a class URL set to `https://mf0n6s-zg.myshopify.com/pages/programs?preview_theme_id=156227535015`. Reload confirmed saved values, Draft status, and disabled Save. No navigation link or public configuration was published. Editor displays My Skyra and the sign-in-required state; authenticated customer UAT remains pending. Replace the preview URL with the canonical storefront URL only at approved release.
- Final theme inventory: `155942944935` remains live; `156227535015` and `156252799143` remain unpublished. An independent request to the public homepage confirmed the live theme ID and no Booking root/embed.
- All seven required mail environment variables and production operations email are absent in the runtime report. No email delivery test has been performed.
- Private workbook/source balances were audited only. Production catalog/customer UUID mapping, production transaction dry-run, backup/final cutoff and real import have **not** been completed.

## Remaining launch acceptance

Create the approved production catalog and customer mappings; configure Resend credentials/domain and operations email, and prove actual delivery; verify a genuine orders/paid event and Needs Attention/reconciliation; perform the production DB dry-run, final backup/cutoff delta and signed import; then complete controlled payment, authenticated Customer Account, Coach/Admin and mobile/desktop UAT. The source workbook cannot substitute for current cutoff approval. Keep all release and public entry switches closed until that evidence exists. The two prepared drafts are not published launch acceptance.

Shopify operational reference: [Custom distribution and installation](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method). The app install flow and configuration validation use Shopify Toolkit/CLI guidance, not development database copying.
