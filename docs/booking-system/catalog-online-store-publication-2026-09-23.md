# Class and Pass automatic Online Store publication

Saving a saleable, priced ACTIVE Class or Pass now queues both the existing
Shopify product synchronization and Online Store publication. The worker checks
the publication again before marking the mapping SYNCED. Drafts, inactive items,
zero-price items, legacy-only Passes, and production items whose checkout release
gate is closed do not enter the publication step.

Only this shop's Online Store publication is selected. No Shop or POS publication
is added. Publication failure keeps the outbox retryable and exposes an actionable
error in Classes & Passes. Replaying a failed create uses the existing deterministic
product handle. The change does not alter bookings, entitlement balances, payment
processing, or the production release switches.

## Deployment requirements

- Release the updated Shopify app configuration, including `read_publications`
  and `write_publications`, and obtain merchant approval for the new scopes.
- Deploy the web and worker code together. Runtime scope defaults also include
  both scopes so a stale SCOPES environment variable cannot omit them.
- Confirm the installed application's offline session has the granted scopes;
  use the existing authenticated refresh/reconnect flow if required.
- Saving an existing eligible Class or Pass again queues publication. This change
  does not bulk-publish the existing catalog automatically.
- In Classes & Passes, wait for SYNCED, then use Check product to verify current
  Australian storefront availability. SYNCED establishes publication at sync time,
  not permanently valid market configuration or class capacity.
- Confirm a real signed-in selection proceeds through Continue to the booking
  review. Payment testing is a separate user action.

Manual channel setting: Shopify Products → select product → Publishing → Manage
→ Online Store → Save.

## Local validation

- `npm.cmd run test:db`: 50 test files, 499 tests passed.
- `npm.cmd run check`: passed (type checks, lint, web build).
- `npm.cmd run build:worker`: passed.
- `shopify app config validate --json`: valid, no issues.
- Official GraphQL validation: all catalog operations passed after explicit user
  authorization. `Publication.name` remains supported in the pinned API version
  but is deprecated; the actual catalog title is generated text, so it is not
  interchangeable with the Online Store channel name.
- Shopify configuration released as `skyra-booking-17` (version 1140294090753).
  This config release is separate from the web/worker deployment and merchant
  approval of the new scopes. No completed payment is claimed by these checks.
