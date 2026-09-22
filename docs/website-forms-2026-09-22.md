# Skyra website submissions — 2026-09-22

Contact and Careers are live Shopify Forms submissions. Each submission creates a Shopify Forms archive entry and triggers an internal email to `hello@skyrastudio.com.au` through Shopify Flow.

## Where to find submissions

In Shopify Admin, open **Apps → Forms → Skyra Contact / Skyra Careers → View submissions**. Open an entry to see all fields; Careers entries also include the uploaded resume.

| Form | Public page | Admin configuration | Form ID |
| --- | --- | --- | --- |
| Skyra Contact | https://mf0n6s-zg.myshopify.com/pages/contact | https://admin.shopify.com/store/mf0n6s-zg/apps/shopify-forms/forms/1164434 | 1164434 |
| Skyra Careers | https://mf0n6s-zg.myshopify.com/pages/about-us | https://admin.shopify.com/store/mf0n6s-zg/apps/shopify-forms/forms/1164437 | 1164437 |

**Domain status:** The working pages above are on the Shopify storefront domain. A live check of `https://skyrastudio.com.au/pages/contact` still showed the old website and a Page Not Found response. This task did not migrate the main domain or change DNS.

Both forms are **Active**. Email is required; other fields are optional, matching the previous form requirements. Contact captures Name, Email, Phone, I'm interested in, and Other notes. Careers captures Name, Email, Phone, Message, and Resume. Continue with Shop is off. Marketing consent is set to **Don't subscribe customers to marketing**. Shopify Forms still creates/updates a customer profile and attaches the submission; the form's custom message fields are stored on the individual submission rather than overwriting customer metafields.

The Careers form asks for a **PDF, maximum 20 MB**. Shopify Forms also accepts supported images; Word files are not supported by this native upload field. No paid app plan was purchased.

## Email workflows

| Workflow | Trigger definition | Email subject | Configuration |
| --- | --- | --- | --- |
| Skyra Contact - email submissions to hello | app--6171699--shopify-forms1164434 | [Skyra Contact] New enquiry | https://admin.shopify.com/store/mf0n6s-zg/apps/flow/overview/01a0c758-a5cf-7331-a952-89fa44bf1845 |
| Skyra Careers - email applications to hello | app--6171699--shopify-forms1164437 | [Skyra Careers] New application | https://admin.shopify.com/store/mf0n6s-zg/apps/flow/overview/01a0c761-300b-79d6-82bf-6f23947daca1 |

Both workflows are **Active** and use `Metaobject entry created → Send internal email`. The recipient is explicitly `hello@skyrastudio.com.au`. Emails include submitted fields, submission time, record ID, and a Shopify Admin entry point. Text values are escaped before inclusion in the HTML email; multiline content retains line breaks. Careers emails include a PDF download link when the file is a generic file; other supported upload types can be opened from the submission in Admin.

The default Forms notification to the store owner's address is disabled. No store-wide email setting was changed. Customer confirmation emails are not configured; the page shows a success message after Shopify accepts the submission. To reply to the customer, use the customer email included in the notification.

**Resume access limitation:** Shopify Forms stores uploads at a randomly named Shopify CDN URL. Anyone who has that URL can download the file without signing in. The submission record itself is in Shopify Admin, but the uploaded file is not protected by Admin authentication. The notification contains a link, not an email attachment. A requirement for private, authenticated resume downloads would need a different storage/upload implementation.

## Theme integration and deployment

Store: `mf0n6s-zg.myshopify.com`. Live theme: **Skyra Website – Managed**, ID `155942944935`.

Scoped local changes deployed directly to that live theme:

- `shopify-theme/sections/skyra-contact.liquid`: replaces the fake preview form with one supported app block, with an email fallback when no block is configured.
- `shopify-theme/sections/skyra-about-us.liquid`: the same integration in the Careers application area.
- `shopify-theme/templates/page.contact.json`: binds Contact form 1164434.
- `shopify-theme/templates/page.about-us.json`: binds Careers form 1164437.
- `shopify-theme/assets/skyra-site.js`: removes only the two fake submission handlers. The preceding JavaScript matches the original live file.

The existing, unchanged `snippets/skyra-account-url.liquid` was also uploaded because the local sections already depended on it and the live theme lacked it. This resolved an observed Liquid error in the account link. The **Forms app embed was enabled and saved through Shopify Admin**. Local `config/settings_data.json` was not pushed; unrelated merchant settings and theme files were preserved.

Final remote pull verified both sections, JavaScript, and snippet match local content; both templates match semantically (Shopify adds a generated header). The remote Forms app embed has `disabled: false`. Backup before changes: `tmp/forms-theme-before`. Final verification snapshot: `tmp/forms-theme-final`.

## Live verification

- Shopify Liquid validator passed for both changed sections, both templates, and JavaScript; `node --check` and scoped `git diff --check` passed.
- Live storefront tested at 1440 px and 390 px. Both forms load, controls fit, and no horizontal overflow or Liquid errors were observed. Contact rejects an empty required Email field.
- Both synthetic customer profiles show **Not subscribed to any channels** under Marketing subscriptions.
- One clearly marked synthetic Contact submission and one synthetic Careers application were sent. Both showed the correct success message and were found in Admin with the expected contents.
- Careers uploaded a synthetic 757-byte PDF. A credential-free download returned HTTP 200 / application/pdf, with SHA256 matching the original: `F810C02460FF97A2A20088B3383ABD4D6633857B3F00B2A2F7E4A39DB47C130E`.
- Both Flow runs completed; each **Send internal email** action succeeded with the intended recipient and rendered content. The user subsequently confirmed receipt of the actual notification emails on 2026-09-22, completing mailbox delivery verification.

| Synthetic test | Admin record | Successful Flow execution |
| --- | --- | --- |
| SKYRA TEST - Contact setup; SKYRA-CONTACT-QA-20260922 | https://admin.shopify.com/store/mf0n6s-zg/content/metaobjects/entries/app--6171699--shopify-forms1164434/306540609703 | https://admin.shopify.com/store/mf0n6s-zg/apps/flow/activity/01M33PGY6BCHA8RYZ6JMKVRFQK:01a0c758-a5cf-7331-a952-89fa44bf1845:v2 |
| SKYRA TEST - Careers setup; SKYRA-CAREERS-QA-20260922 | https://admin.shopify.com/store/mf0n6s-zg/content/metaobjects/entries/app--6171699--shopify-forms1164437/306541035687 | https://admin.shopify.com/store/mf0n6s-zg/apps/flow/activity/01M33PXBQJC84SFW12D6HQ3JE1:01a0c761-300b-79d6-82bf-6f23947daca1:v2 |

Synthetic records/customers and the test PDF were left in place, clearly labelled. No existing customer records were deleted. Screenshots and the synthetic PDF are under `output/playwright/skyra-*-forms-*` / `output/playwright/skyra-forms-test-resume.pdf`. The scoped source changes and this record are included in the forms integration Git commit. Shopify Forms and Flow settings live in Shopify Admin; they are documented here and are not deployed by Git.
