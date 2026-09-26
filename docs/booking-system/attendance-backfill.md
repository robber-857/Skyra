# Record past attendance

Admin / Operations can open **Clients → client profile → Record past attendance**,
choose a studio calendar date and an ended class, select an eligible existing
Pass, enter a reason, and confirm that the client attended.

- The new booking is immediately `ATTENDED`. One credit is reserved and consumed
  in the same transaction, leaving no outstanding reservation.
- There is no additional instruction to add a Pass. With no eligible Pass the
  selector and submit button are disabled. Existing Pass / cash credit tools are
  unchanged.
- Published and completed classes are supported after their end time. Draft,
  cancelled, future and ongoing classes are rejected. Normal future booking
  windows remain unchanged.
- Pass ownership, service eligibility, validity at the class date and current
  credit balance are checked. Existing first-class activation rules apply to an
  unactivated Pass; its validity begins on the historical class day.
- An existing non-cancelled booking, including no-show or late cancellation,
  blocks a second record and charge. Staff should correct that existing record.
- Historical attendance can be recorded for a full class: the form displays an
  explicit capacity notice because this operation records actual attendance.
- Idempotent retries and concurrent submissions cannot double-charge. Competing
  requests for the final credit leave only the successful booking.
- Actual class time remains on the session. Booking creation, credit entries and
  audit timestamps record when staff entered the correction. No historical
  check-in timestamp is fabricated.
- The booking timeline records `BACKFILL_ATTENDANCE`, staff actor and reason.
  Normal booking history, rosters and attendance reports read the new booking.
  Existing credit-restoring cancellation works with its linked ledger entries.
- No booking confirmation or class reminder is queued by backfill.

## Deployment and verification

Apply `202609260001_attendance_backfill` before using the feature; it extends the
booking timeline action constraint without changing existing records.

Database coverage lives in `booking-app/tests/attendance-backfill.test.ts`. Use
`npm.cmd run test:db` for the dedicated local PostgreSQL test database and
`npm.cmd run check` for types, lint and production build.

Local synthetic browser verification covers 390px and 1440px widths, confirmation
reset on class change, empty Pass selection, submitted fields, date filtering and
horizontal overflow. These checks do not replace authenticated Shopify Admin UAT.
