# Admin scheduling preparation — 2026-09-22

Target: `mf0n6s-zg.myshopify.com`, branch `bookingdev`.

The owner confirmed that the existing 20 course definitions are the operating catalog. Admin will choose teachers and create dated sessions; no complete future Mindbody export is required. The additional Legacy MV COURSE is migration-only. The imported six sessions and eight reservations are retained, and this change does not modify customer profiles or Pass balances.

## Admin workflow

1. Open **Classes & Passes**, edit an existing class, confirm price and eligible teachers, then set it to ACTIVE. Missing prices may remain blank in DRAFT; zero placeholders are shown as **Price pending** and cannot be activated/published. Eligibility is configured by Admin, with a specific eligible teacher selected for each session.
2. Open **Weekly Schedule**. Its pending-course list links directly to each class that still needs configuration. Choose **Add session**, a ready class, teacher, date and time. The class supplies its duration and capacity: Aerial group 55 minutes / 6 places; Dance 60 minutes / 15 places. Save as DRAFT.
3. Review the week and publish the intended sessions when ready. The same published sessions supply the homepage Booking section; the existing flow supports class/session selection, login, eligible existing Pass, a new Pass or Drop-in, then review and confirmation/checkout. No duplicate course catalog or purchase flow was created.

Date selection is limited to **2026-01-01 through 2099-12-31**. Boundary weeks may straddle those dates for viewing; new sessions must still start in the future and every repeated/copied date must be within the bounds. This is not a Pass-validity change and does not pre-generate a timetable.

## Production protection

The public sessions endpoint must withhold production sessions unless the exact production target is configured, release approval is true, online bookings is explicitly true and emergency stop is off. This applies even if Admin has published sessions during preparation. The gate is independent of temporary checkout/owned-Pass switches after release. Development-store behavior is retained.

All production release, payment, owned-Pass and email protections remain closed. Activating a configured class does not open production sales: the Shopify product gate continues to keep its product DRAFT until checkout is approved. Real Customer Account, payment/orders-paid, Coach/Admin and Resend acceptance remain outstanding.

## Verification

- Local targeted tests passed: 46 tests across schedule range, foundation, schedule origin and appointment comments; 19 tests across production public-schedule and commerce capabilities (65 total).
- Production authenticated read-only check before deployment: Classes & Passes shows 21 definitions, including the 20 operating courses and additional migration-only service, still DRAFT.
- Release approval, checkout and owned-Pass runtime environment flags remain false; mail flag absent means disabled. No production catalog/session/customer mutation was performed for this change.
- Type checks, lint and app build passed. Deployment and post-deployment UI evidence will be added after release. Only synthetic fixtures are used for schedule mutation tests; production verification is read-only.
