// Read-only readiness audit. Never changes scopes, app config, contracts or charges.
import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { transactionalMailReady } from "../app/services/transactional-mail.server";

const domain = "skyra-booking-dev.myshopify.com";
const database = new URL(process.env.DATABASE_URL || "");
if (
  !["127.0.0.1", "localhost"].includes(database.hostname) ||
  database.pathname !== "/skyra_booking"
)
  throw new Error("Preflight must use the local development database.");
const db = new PrismaClient();
const query = `query MembershipTestReadiness {
  shop { myshopifyDomain currencyCode features { eligibleForSubscriptions } }
  currentAppInstallation { accessScopes { handle } }
}`;
const requiredScopes = [
  "read_own_subscription_contracts",
  "write_own_subscription_contracts",
  "read_customer_payment_methods",
  "read_validations",
  "write_validations",
  "unauthenticated_read_product_listings",
  "unauthenticated_write_checkouts",
  "unauthenticated_read_selling_plans",
];
try {
  const shop = await db.shop.findUnique({
    where: { domain },
    select: { id: true, status: true },
  });
  const session = await db.session.findFirst({
    where: { shop: domain, isOnline: false },
    select: { accessToken: true, scope: true },
  });
  if (!shop || !session)
    throw new Error(
      "The local development shop or authenticated installation is missing.",
    );
  const response = await fetch(
    `https://${domain}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query }),
    },
  );
  const payload = await response.json();
  const granted = (
    payload.data?.currentAppInstallation?.accessScopes || []
  ).map((scope: { handle: string }) => scope.handle);
  const effective = granted.length ? granted : (session.scope || "").split(",");
  const liveAuthenticatedRead =
    response.ok &&
    !payload.errors &&
    payload.data?.shop?.myshopifyDomain === domain;
  const plans = await db.passPlan.findMany({
    where: { shopId: shop.id, standalonePurchaseEnabled: true },
    select: {
      name: true,
      status: true,
      saleable: true,
      validityMonths: true,
      autoRenewEnabled: true,
      sellingPlanGid: true,
    },
  });
  const configFile = process.argv[2] || "shopify.app.membership-test.toml";
  if (
    !["shopify.app.toml", "shopify.app.membership-test.toml"].includes(
      configFile,
    )
  )
    throw new Error(
      "Only the known local app configuration files may be checked.",
    );
  const config = await fs.readFile(configFile, "utf8");
  const result = {
    checkedAt: new Date().toISOString(),
    domain,
    readOnly: true,
    liveAuthenticatedRead,
    httpStatus: response.status,
    scopeEvidence: granted.length ? "LIVE_INSTALLATION" : "SAVED_SESSION_ONLY",
    missingScopes: requiredScopes.filter((scope) => !effective.includes(scope)),
    subscriptionGateway: {
      eligibilityEvidence: liveAuthenticatedRead
        ? "LIVE_SHOP_FEATURE"
        : "UNVERIFIED",
      eligibleForSubscriptions: liveAuthenticatedRead
        ? payload.data.shop.features.eligibleForSubscriptions
        : null,
      currencyCode: liveAuthenticatedRead
        ? payload.data.shop.currencyCode
        : null,
      testModeEvidence:
        "Must verify Shopify Payments test mode in Admin and test transactions; the Shop feature does not prove test mode",
    },
    localConfigurationFile: configFile,
    subscriptionWebhooksInLocalConfiguration:
      /subscription_contracts/.test(config) &&
      /subscription_billing_attempts/.test(config),
    plans: plans.map(({ sellingPlanGid, ...plan }) => ({
      ...plan,
      hasSellingPlan: Boolean(sellingPlanGid),
    })),
    mailPreflight: {
      blocksBillingTests: false,
      providerConfigured: transactionalMailReady(),
      membershipSendingEnabled:
        process.env.SKYRA_MEMBERSHIP_MAIL_ENABLED === "true",
      testRecipientConfigured: Boolean(process.env.SKYRA_MAIL_TEST_RECIPIENT),
      shopMatchesTestStore: process.env.SKYRA_BOOKING_MAIL_SHOP === domain,
      retainedWithoutProvider:
        "Payment receipt and pending email content remain in the application database; this does not prove an email was sent",
    },
    releaseFlagEvidence:
      "This process environment; not app-dev runtime or production",
    processReleaseFlags: Object.fromEntries(
      [
        "SKYRA_BOOKING_CHECKOUT_ENABLED",
        "SKYRA_MEMBERSHIPS_TEST_ENABLED",
        "SKYRA_MEMBERSHIPS_SUBSCRIPTIONS_READY",
        "SKYRA_MEMBERSHIPS_ENABLED",
        "SKYRA_MEMBERSHIPS_CHECKOUT_EXCLUSION_VERIFIED",
        "SKYRA_MEMBERSHIPS_CHECKOUT_GUARD_READY",
      ].map((key) => [key, process.env[key] === "true"]),
    ),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.$disconnect();
}
