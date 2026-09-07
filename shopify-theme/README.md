# Skyra Shopify theme

This directory is the source of truth for Skyra theme development.

- Managed live theme: `155942944935`
- Store: `mf0n6s-zg.myshopify.com`
- Do not pull Horizon or the live theme into this directory.
- If remote comparison is needed, pull into a new temporary directory and compare first.
- `config/settings_data.json` is excluded from synchronization so Theme Editor settings are preserved.
- All configured pushes use `nodelete = true` so remote-only files are not deleted.

Routine code push:

```powershell
shopify theme check
shopify theme push --environment skyra_live_code --allow-live --strict
```

Intentional template or section-group update:

```powershell
shopify theme push --environment skyra_live_structure --allow-live --strict --only templates/index.json
```

## Implemented Skyra templates

- Home: templates/index.json
- Programs: templates/page.programs.json
- Membership: templates/page.membership.json
- MV Project: templates/page.mv-project.json
- About: templates/page.about-us.json
- Contact: templates/page.contact.json
- Functions & Studio Hire: templates/page.functions-studio-hire.json

All six Shopify Page resources are assigned to their matching templates. Permanent navigation must use the clean `/pages/...` URLs without `?view=` query parameters.

For a new page template, upload its section and assets first, then upload the JSON template and explicitly assign the page resource:

    shopify theme push --environment skyra_live_code --allow-live --strict --only sections/skyra-example.liquid --only assets/skyra-example.css
    shopify theme push --environment skyra_live_structure --allow-live --strict --only templates/page.example.json

The live theme is customer-visible. Validate every changed file before using either live environment.