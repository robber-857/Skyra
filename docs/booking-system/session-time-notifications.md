# Session time changes and email visibility

Admin edits of a future published session now queue `SESSION_TIME_CHANGED_V1` for each confirmed booking's Customer, current Coach and Admin, in the same transaction as the edit. Capacity-only edits do not send this email. Booking and Pass ledger records are not altered.

- Each session version is a separate idempotent event. The email freezes the old/new dates, times, timezone and class details; previews retain that snapshot. A later edit suppresses pending older time-change emails. Cancelled, past or superseded bookings are checked again before delivery.
- Pending 12-hour reminders move to the new start minus 12 hours (or now if already within that window). Imported bookings get a missing reminder. Already accepted or ambiguous reminders are never blindly resent. A per-session advisory lock serializes mail delivery and schedule edits.
- Weekly Schedule → session details → Student emails shows each student's queued, accepted, failed, suppressed or unknown jobs, attempt counts and provider receipt. Check delivery makes a read-only Resend request; the worker also checks recent accepted emails. Delivered means receipt by the recipient mail server, not human reading. Missing provider read permissions remain visible without inventing delivery.
- Missing recipient addresses or failed lookups defer a job by 15 minutes and expose the reason, allowing newer jobs to proceed. Unknown sends remain held for reconciliation.

For historical time changes, session details shows the latest matching audit's old/new time and the names/count of confirmed students booked before that edit who have no time-change record. **Send missing time-change emails** queues only those missing events, also notifying Coach/Admin; repeated submission does not duplicate mail. It rejects a stale audit selection. Deployment alone does not backfill historical mail.

Migration: `202609290001_session_time_notifications` adds immutable snapshots, event keys and provider status fields; `202609290002_session_time_template` permits the new template. Deploy Web and Worker together after applying migrations. The replaced unique key means old binaries should not be retained during the migration rollout.

Provider reference: https://resend.com/docs/api-reference/emails/retrieve-email. Sending-only API keys need read access before provider delivery status can be retrieved. This feature does not change API key permissions automatically.

Local validation: PostgreSQL regression tests cover repeated edits, immutable previews, no-op edits, duplicate workers, cancellation, historical repair, tenant/role isolation, reminder timing, in-flight send serialization, provider receipts and queue deferral. Live inbox receipt must be verified separately.
