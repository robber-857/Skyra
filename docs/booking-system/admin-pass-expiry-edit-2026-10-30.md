# Admin Pass expiry and available-credit editing

Client profile → each Pass record → **Edit credits & expiry**.

- Set an absolute available-credit balance (0–10,000), a new expiry date, or both. Reserved and consumed credits remain separate ledger balances.
- Expiry dates use the shop timezone and include the selected day; the stored exclusive cutoff is midnight on the next local calendar day. The profile shows the exact cutoff and timezone.
- An empty expiry field preserves the exact stored instant. Giving an unactivated Pass an explicit expiry starts it immediately. An expired Pass can be reopened with a future expiry and the desired available balance; expired credits are never silently re-granted.
- Pending/revoked Passes cannot be reopened through this form. Existing reservations block shortening expiry. Every edit requires a reason and confirmation.

## Transaction guarantees

`updateClientPass` checks operations permission and shop/customer ownership, locks the shop and entitlement, checks the displayed balance, expiry and database-managed revision, then writes the expiry/status, optional ADJUST ledger entry and audit receipt in one PostgreSQL transaction.

The request UUID has a unique audit receipt per shop for `PASS_UPDATED`, including expiry-only edits. An identical retry returns without writing. Reusing a UUID with another payload or actor fails. Receipt lookup precedes snapshot checks, so a delayed successful retry cannot overwrite later edits. Different requests based on an old revision fail with a refresh instruction. Ledger failure rolls the entire edit back.

Migration `202610300001_admin_pass_edit` adds the revision column and receipt index, and permits expiry changes while retaining the source, ownership, granted-units and activation-history protections. Deploy this migration before the updated app. No Shopify API or payment records are changed.

## Verification and delivery

The migration was applied to the local dedicated `skyra_booking_test` database. Fourteen targeted database tests passed, including concurrent retries, expiry-only writes, expired reopening, stale edits, delayed retries, authorization, rollback and unactivated Passes. Full regression passed: 80 files / 1,110 tests. App/customer TypeScript, lint and production build passed. The final checks ran outside the Windows sandbox after sandbox temporary-file/output permission failures. Production deployment and authenticated production UI verification have not been performed.
