# Skyra Shopify theme

This directory is the source of truth for the custom Skyra Shopify theme. It contains the complete theme snapshot based on Horizon plus all Skyra page designs and integrations.

## Store and repository

- Store: `mf0n6s-zg.myshopify.com`
- Managed live theme: `Skyra Website – Managed`
- Theme ID: `155942944935`
- Active development branch: `dev`
- Stable branch: `main`

## Safety rules

1. Do not pull Horizon or the live theme directly into this directory.
2. Pull remote themes into a new temporary directory and compare before merging.
3. Never upload or commit `config/settings_data.json`.
4. Keep `nodelete = true` so remote-only theme and app files are not deleted.
5. Use the code-only environment for routine changes. Templates and section groups require an intentional structural push.
6. Run Theme Check before every live upload.

Both `.shopifyignore` and `.gitignore` protect `config/settings_data.json`, preserving settings managed in Shopify Theme Editor.

## Validation and deployment

Run commands from `D:\Skyra\shopify-theme`.

Routine code-only update:

```powershell
shopify theme check
shopify theme push --environment skyra_live_code --allow-live --strict
```

Targeted file update:

```powershell
shopify theme push --environment skyra_live_code --allow-live --strict --only sections/skyra-home.liquid --only assets/skyra.css
```

Intentional template or section-group update:

```powershell
shopify theme push --environment skyra_live_structure --allow-live --strict --only templates/index.json
```

Before a structural push, pull the current remote theme into a temporary directory and merge its Theme Editor and app block configuration into the local template. Never blindly overwrite the remote `templates/index.json`.

## Implemented page templates

| Page | Template | Storefront path |
| --- | --- | --- |
| Home | `templates/index.json` | `/` |
| Programs | `templates/page.programs.json` | `/pages/programs` |
| Membership | `templates/page.membership.json` | `/pages/membership` |
| MV Project | `templates/page.mv-project.json` | `/pages/mv-project` |
| About us | `templates/page.about-us.json` | `/pages/about-us` |
| Contact | `templates/page.contact.json` | `/pages/contact` |
| Functions & Studio Hire | `templates/page.functions-studio-hire.json` | `/pages/functions-studio-hire` |

All six Shopify Page resources are assigned to their matching templates. Permanent navigation and canonical URLs must use the clean `/pages/...` paths without `?view=` parameters.

## Instafeed community integration

The `skyra-home` section accepts one Shopify app block in the existing `Our community` feed position.

- Without an app block, the four original static images remain as a safe fallback.
- With the Instafeed block, the live Instagram feed replaces the static images.
- Add Instafeed inside `Skyra home`, not as a separate top-level Apps section.
- Leave the main feed ID blank.
- Keep the app title blank, margins at `0`, Instagram link off, and background transparent.
- Use Grid layout, `4 columns × 1 row` on desktop and `2 columns × 1 row` on mobile.
- Use the `4:5` media ratio and newest-own-posts ordering.
- Remove pinned posts when the feed must always show the latest Instagram posts.

The app block selection is Theme Editor data stored remotely. Routine `skyra_live_code` pushes exclude JSON templates so the Instafeed placement is preserved.

## Git workflow

Work on `dev` and stage only the intended files:

```powershell
git add -- <files>
git diff --cached --check
git diff --cached --stat
git commit -m "<message>"
git push origin dev
```

The separate untracked `docs/` directory is outside the Shopify theme and must not be included unless explicitly requested.

## References

- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli)
- [Shopify theme app blocks](https://shopify.dev/docs/storefronts/themes/architecture/blocks/app-blocks)
- [Mintt Instafeed post sizing](https://docs.minttstudio.com/instafeed/docs/feed-layout-display/post-size)