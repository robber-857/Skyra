# Production course and contact preparation — 2026-09-22

Target: `mf0n6s-zg.myshopify.com`, branch `bookingdev`.

## Confirmed source rules

- The owner accepts the 2026-09-21 snapshot; subsequent purchases will be reconciled manually. This is not evidence of a fresh Mindbody cutoff.
- The owner confirms 20 course/service definitions. Aerial group classes are 55 minutes with capacity 6; Dance classes are 60 minutes with capacity 15. Private appointments retain capacity 1.
- Five supplied exports were compared with the private reconciliation workbook. All 63 raw balance rows match the existing source values, including 20 current-at-Sep-21 and 43 archived rows. The eight future reservations match individually.
- At Sep 22, 18 source balance rows remain eligible: 155 available credits plus 8 reserved. The prior private no-show correction remains consumed; it is not returned to available credit. The active Lifestyle customer has three $299 sales under one sale, preserved as three 12-credit calendar-month entitlements.
- The actual supplied Mailing List has 286 clients, not the earlier recorded 287. Four duplicate-email groups involve nine clients; none intersects the current eligible balance customers. One eligible-balance customer lacks an email. No customer records should be merged by name or email automatically.
- Attendance Analysis has 384 paid visits, matching the 384 signed-in schedule rows. It is an aggregate report, not evidence to debit individual opening balances again.
- The source schedule provides coach associations for 11 of the 20 services. Nine remain unassigned drafts. It does not establish a complete future timetable with unbooked classes.

## Implementation

- Add nullable coach phone storage and a scoped, audited Admin phone editor. Preserve absent values and source phone formatting. Contact updates do not authorize login or send invitations.
- Allow unassigned service drafts; activation still requires an eligible coach. This avoids invented coach assignments during catalogue preparation.
- Fix named MV legacy project matching in the migration converter so a source name with a parenthesized project suffix retains restricted COURSE eligibility.
- All supplied customer/teacher contact data, hashes, prepared mappings, backups and reconciliation details remain outside Git in the private migration directory.

## Verification before synchronization

- Dedicated PostgreSQL suite: 44 files / 424 tests passed.
- Type checks, lint and production build passed.
- Worker and importer builds passed.
- Python migration conversion tests: 4 passed.
- Public session and booking-attempt response code selects coach ID/name only; private contact fields are not included.

Runtime synchronization evidence will be recorded separately after deployment and read-back. Courses remain DRAFT and public checkout/booking gates remain closed. Source comparison and tests are not production migration or real-user UAT.
