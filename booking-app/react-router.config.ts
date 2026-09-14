import type { Config } from "@react-router/dev/config";

// Shopify CLI forwards public HTTPS actions to a local HTTP server. Trust only
// this deployment's configured host; never all Shopify or tunnel subdomains.
const appUrl =
  process.env.SHOPIFY_APP_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : process.env.HOST);

export default {
  allowedActionOrigins: appUrl ? [new URL(appUrl).host] : [],
} satisfies Config;
