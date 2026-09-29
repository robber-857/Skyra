# Payment terms and public contact email

- Approved policy: https://skyrastudio.com.au/pages/term-conditions. Public contact: hello@skyrastudio.com.au.
- Booking paid review and resume both start unchecked. The booking backend requires literal `true` and the current policy version before creating a hold or returning a checkout. Existing Pass credit confirmation is unchanged.
- `CHECKOUT_TERMS_ACCEPTED` audit receipts bind authenticated customer, shop, checkout, policy URL/version, displayed statement and server timestamp. Retrying a checkout retains its first receipt. The version identifies this consent release; updating policy content requires a new version in `app/lib/booking-terms.json` and the storefront consent attribute, plus extension deployment.
- Standard cart and product accelerated-checkout UI require an unchecked checkbox. Accelerated buttons stay hidden/inert until selected. The cart sends a terms attribute. These theme controls do not impose a Shopify-wide server validation on manually accessed checkout URLs or external sales channels.
- Footer links now use the approved page rather than the unset Shopify Terms of Service policy (404).
- The Shopify automated Privacy policy used the Store email. Store contact email was changed and the public Privacy policy was verified to show hello@skyrastudio.com.au. Login identity is separate.

Validation: 580 tests, app typechecks/lint/build, theme validation; synthetic browser checks for unchecked/checked/uncheck and resume, and 390px layout. No actual payment or legal acceptance made during testing.

Release must preserve active Shopify scopes (no new write_customers permission). Remote theme sections contained newer merchant edits; the selective theme release is based on their downloaded originals, changing only the Terms link. Backup: `tmp/terms-live-backup/`; staged release: `tmp/terms-theme-release/` (both ignored).

Released: backend commit `701c2c6`, CI run `36566225826` success, Render `dep-datqknrrjlhs73c0d7p0` Live and `/health` 200. Shopify version `skyra-terms-consent-20260929` (`1148188590081`) released. Selective theme upload to live theme `155942944935` succeeded. Live product/cart confirmed unchecked consent and disabled checkout; adding an item requires no consent and the temporary item was removed, restoring the empty cart. Contact and Privacy public pages show hello@skyrastudio.com.au.
