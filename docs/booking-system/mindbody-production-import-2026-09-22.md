# Mindbody production import — 2026-09-22

Target: `mf0n6s-zg.myshopify.com`; branch `bookingdev`.

## Authorized snapshot and preparation

The owner accepts the supplied Sep 21 snapshot and will manually reconcile subsequent purchases. This is not a fresh Mindbody delta export. The cutover timestamp is `2026-09-22T04:26:01Z`. Original exports and all customer/contact data, mappings, reports, manifests, operational scripts with private inputs, job logs and database backups remain outside Git or in ignored local operational output.

- Shopify customer import: 18 imported, zero failed, zero duplicate skips. Existing records were not overwritten. Booking synchronized 19 profiles including one pre-existing customer. The one missing customer email was resolved by an explicit owner-confirmed identity mapping in the private record.
- Created 13 ACTIVE Pass plans with exact reviewed eligibility: seven ordinary saleable plans and six non-saleable plans (two Buddy promotions, three legacy plans and a legacy drop-in plan). All Shopify products remain DRAFT because production checkout is closed.
- Legacy private Passes are restricted to the original private-training service. MV credit is restricted to a dedicated DRAFT COURSE. That migration-only service is additional to the owner's original 20 definitions; its zero price and placeholder duration/capacity must not be published as an approved new offering.
- Ordinary Aerial Passes cover only the six approved ordinary Aerial group services. Private group, private appointments and workshops are excluded.
- The converter now accepts explicitly approved per-service capacity, rejects invalid capacity and capacity below existing reservations, and retains the prior fallback when capacity is unspecified. Eight synthetic converter tests passed.
- Production read-back before import: 13 plans match all reviewed fields and service scopes; 34 product mappings SYNCED, 34 products DRAFT, all real formal-store IDs, zero Product/Variant IDs shared with another shop.

## Dry-run, backup and apply

| Evidence | Result |
| --- | --- |
| Frozen private manifest SHA-256 | `f1772b0578e495d71e8095b32561af31914b9767ccb397a64d89d9b0df421fb1` |
| Canonical importer input hash | `9c5a4dbd3ad46dbd4d5bb18645d53d1601852b20c0b363122644c51968878d41` |
| Independent source review | 42 checks passed, including all source joins, legacy limits and Lifestyle calendar-month boundaries |
| Pre-import backup SHA-256 | `12c9030e67e33a3d0d98c5098493c4b214a6992f1994384954e9a3a15a1ddfcf` |
| Backup | 207,913-byte PostgreSQL custom archive, contents validated; restore drill not performed |
| Production dry-run | Render job `job-dap08200cd8s73b9c370`, succeeded; full transaction rolled back |
| Rollback read-back | Zero entitlements, bookings, sessions, notifications, migration batches and sources |
| Apply | Render job `job-dap09cp42hec738e6mh0`, succeeded at `2026-09-22T04:32:02Z` |

Imported 18 customers' balances as 20 entitlements: **155 available, 8 reserved, 31 consumed**. The unconsumed total is **163**. The 155 available-ledger credits include 24 credits in the two future Lifestyle months; those are not usable before their individual start dates. Three Lifestyle tranches each contain 12 credits and retain consecutive Sydney calendar-month boundaries and DST offsets. Existing legacy expiry/start dates were preserved.

Imported **8 CONFIRMED bookings across 6 DRAFT sessions**, each 55 minutes with capacity 6. Only the reserved sessions evidenced by the export were imported, not a complete unbooked timetable. Historical attendance was not debited again.

Authenticated Shopify Admin UI read-back: 19 customer-directory rows across two pages, 18 with Passes, 20 Passes, 163 classes left including reserved, 8 bookings. The Bookings page shows eight CONFIRMED records without page alerts.

## Post-apply and replay acceptance

Read-only production verification passed for every customer, entitlement owner/plan/product/date/grant, source hash, ledger row, session, booking and reservation link. Evidence: 68 migration sources, 20 OPENING_BALANCE entries, eight RESERVE entries, one completed batch and one import audit; zero booking notifications and zero paid-order results. No fake Shopify order identifiers were created.

Immediate replay of the identical frozen manifest completed successfully in Render job `job-dap0c9e0tbcc73fu9sag` at `2026-09-22T04:38:19Z`. The subsequent read-only comparison confirms that all business/source IDs, ledger balances, dates, statuses, record counts and the single import audit remain unchanged. Both snapshots have SHA-256 `28f912ac3e7f2f33d2b7180062b83e98472e712abfb6a8a65a19bc25cc48aba6`. Private evidence files use exclusive creation and were not overwritten. Temporary database operator network access was restored after every operation.

Do not regenerate or edit this applied manifest to retry it. The importer applies the 24-hour cutoff guard before its replay check; a later stale-cutoff error is not a reason to alter the cutoff or import balances again.

## Launch remains closed

The production release-approval, checkout and owned-Pass environment flags remain false. `SKYRA_MAIL_ENABLED` is absent and therefore disabled by runtime code, rather than explicitly configured false. The web and worker processes inherit the same service environment. `Shop.rules.onlineBookingsEnabled` remains false. No real payments, customer login UAT, transactional mail delivery or public Booking release is claimed by this migration.

Next gates remain: complete the unbooked future timetable and unresolved draft coach/price decisions; verify authenticated Customer Account, controlled payment/orders-paid reconciliation, Coach/Admin workflows and real Resend delivery. Keep the public entry closed until those pass. The additional customers without current balances and duplicate-email groups were not imported or merged in this step.
