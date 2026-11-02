# Configurable private appointment capacity

Status: validated locally; production release authorized and in progress.

## Incident

On 2 November 2026, the production application log at 19:49:45 Australia/Sydney
recorded `PrismaClientUnknownRequestError` with PostgreSQL `P0001` and
`Appointment capacity must be one`. The admin reported an Application Error
while arranging a new `2:1 Private Aerial Class`.

Read-only inspection confirmed that the class exists, is ACTIVE and SYNCED,
and currently has capacity 1. Weekly Schedule and its Add session form loaded
successfully during diagnosis. No production class, Pass or session was changed.

The catalogue service silently replaced every APPOINTMENT capacity with 1.
The database independently enforced a Service check constraint and a ClassSession
trigger requiring the same. Schedule editing accepted capacity 2, then failed at
the database trigger; the unexpected exception reached the application error page.

## Change

- Preserve the configured private class capacity and remove only the two obsolete
  appointment-specific database restrictions via a new migration.
- Keep the general capacity bounds, occupancy protections, coach/location conflicts,
  immutable scheduled service type and Pass eligibility checks.
- Default newly selected private appointments to one place; explain capacity 1 for
  1:1, capacity 2 for 2:1 and capacity 3 for 3:1 in the catalogue editor.
- Display actual session capacity in the storefront private-class label.
- Align the Mindbody importer with configurable private capacity.

Each student booking still consumes one place. Prices, payment rules and Pass
credit consumption are unchanged. This does not introduce a single booking for
two attendees or bundled pair pricing.

## Validation

The new two-seat booking regression failed against the old database constraint.
After applying `202611020001_private_appointment_capacity` to the dedicated local
`skyra_booking_test` database, all 80 files / 1,119 tests passed. Coverage includes
catalogue capacity persistence, draft creation and retry, editing from one to two
places, publishing, copying, preserving existing session snapshots, and ten
concurrent hold requests yielding exactly two successful reservations. Capacity
cannot be reduced beneath occupancy; private coach/location conflicts and service
type protections remain covered.

After the request to support three-student private sessions, the concurrent-hold
regression was parameterized for capacities 2 and 3. All 36 booking-engine tests
and the app/customer type checks, lint and production build passed again.

Application/customer type checks, ESLint, production build and worker build passed.
The changed storefront asset was rebuilt with esbuild (9.8 KB). No authenticated
production write or end-to-end production booking was performed.

## Release and operational follow-up

Deploy the app and its database migration together, and publish the rebuilt
Booking theme extension asset. Existing capacities are not automatically rewritten.
After release, set the specific `2:1 Private Aerial Class` capacity to 2 through
the catalogue editor. Existing dated sessions retain their saved capacity and
must be reviewed/edited separately. Do not recreate the class or its Pass merely
to work around this incident. Confirm the live migration and actual admin save
before claiming production resolution.
