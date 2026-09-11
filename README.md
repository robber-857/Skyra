# Skyra Studio Homepage Concept

Interactive, responsive homepage prototype for Skyra Studio.

## Included

- One-time cinematic Hero zoom-out
- Responsive navigation matching the current Skyra page structure
- Drag-enabled movement gallery with 2.5-second autoplay
- Programs, studio story, a temporary static booking preview, and membership sections
- Reduced-motion and keyboard-accessible interaction states

## Booking development

The static homepage preview is not the production Booking System. The approved implementation replaces it and the Programs page's hard-coded Mindbody schedule with one shared Theme App Extension Booking component mounted on both pages.

The current architecture, flow, data model, prototype and executable backlog live in [docs/booking-system/README.md](./docs/booking-system/README.md).

The Shopify App source and setup instructions are in [booking-app/README.md](./booking-app/README.md). See [development status](./docs/booking-system/development-status.md) for verified work, prerequisites and remaining implementation.

## Preview

Open `index.html` directly, or serve the folder with any static web server.

For example:

```powershell
npx serve .
```
