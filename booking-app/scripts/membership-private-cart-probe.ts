import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  assertTestAccessEnvironment,
  parseOfficialTestAppEnvironment,
} from "./membership-test-access-preflight";
import { assertLocalPreparationDatabase } from "./membership-prepare-test-pass";
import { assertNoPublicMembershipStorefrontTokens } from "../app/services/membership-checkout-authorization.server";
import {
  STOREFRONT_CHECKOUT_SCOPE,
  STOREFRONT_PRODUCT_SCOPE,
  STOREFRONT_SELLING_PLAN_SCOPE,
} from "../app/services/storefront-access.server";
import type { GraphQL } from "../app/services/shopify-catalog.server";

const domain = "skyra-booking-dev.myshopify.com";
const appKey = "c9d266a38e2f11a1240139974253b3a1";
const appPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(
  appPath,
  "output/local-preview/membership-private-cart-probe-20261004.json",
);
const reportPrefix = "SKYRA_PRIVATE_CART_PROBE=";
const probeValue = '{"kind":"PRIVATE_ACCESS_PROBE"}';
const requiredScopes = [
  STOREFRONT_PRODUCT_SCOPE,
  STOREFRONT_CHECKOUT_SCOPE,
  STOREFRONT_SELLING_PLAN_SCOPE,
];

// Query-only app-owned definition metadata avoids deriving namespaces from GIDs.
// No customer record or customer checkout authorization is read or written.
export const PRIVATE_CART_IDENTITY_QUERY = `#graphql
query MembershipPrivateCartIdentity {
  shop { id myshopifyDomain currencyCode }
  currentAppInstallation { app { id apiKey } accessScopes { handle } }
  metafieldDefinitions(first: 2, ownerType: CUSTOMER, namespace: "$app", key: "membership_checkout") {
    nodes { namespace key type { name } }
    pageInfo { hasNextPage }
  }
}`;
export const PRIVATE_CART_SHOP_QUERY = `#graphql
query MembershipPrivateCartShop { shop { id } }
`;
export const PRIVATE_CART_CREATE = `#graphql
mutation MembershipPrivateEmptyCartProbe($input: CartInput!) {
  cartCreate(input: $input) {
    cart {
      id totalQuantity
      authorization: metafield(namespace: "$app", key: "membership_checkout") {
        namespace key type value
      }
    }
    userErrors { code field }
  }
}`;
export const PRIVATE_CART_READ = `#graphql
query MembershipPrivateEmptyCartProbeRead($cartId: ID!, $namespace: String!) {
  cart(id: $cartId) {
    totalQuantity
    authorization: metafield(namespace: "$app", key: "membership_checkout") {
      namespace key type value
    }
    implicitAuthorization: metafield(key: "membership_checkout") {
      namespace key type value
    }
    resolvedAuthorization: metafield(namespace: $namespace, key: "membership_checkout") {
      namespace key type value
    }
  }
}`;

const namespace = z.string().regex(/^app--[1-9]\d*$/);
const identitySchema = z.object({
  shop: z.object({
    id: z.string().regex(/^gid:\/\/shopify\/Shop\/[1-9]\d*$/),
    myshopifyDomain: z.literal(domain),
    currencyCode: z.literal("AUD"),
  }),
  currentAppInstallation: z.object({
    app: z.object({
      id: z.string().regex(/^gid:\/\/shopify\/App\/[1-9]\d*$/),
      apiKey: z.literal(appKey),
    }),
    accessScopes: z.array(z.object({ handle: z.string() })),
  }),
  metafieldDefinitions: z.object({
    nodes: z
      .array(
        z.object({
          namespace,
          key: z.literal("membership_checkout"),
          type: z.object({ name: z.literal("json") }),
        }),
      )
      .length(1),
    pageInfo: z.object({ hasNextPage: z.literal(false) }),
  }),
});
const cartAuthorization = z.object({
  namespace,
  key: z.literal("membership_checkout"),
  type: z.literal("json"),
  value: z.string(),
});
const cartSchema = z.object({
  totalQuantity: z.literal(0),
  authorization: cartAuthorization.nullable(),
});
const createSchema = z.object({
  cartCreate: z.object({
    cart: cartSchema.extend({
      id: z.string().regex(/^gid:\/\/shopify\/Cart\/[^\s]+\?key=[^\s]+$/),
    }),
    userErrors: z.array(z.unknown()).length(0),
  }),
});

type Context = { session: { shop: string; isOnline: boolean } };
type Dependencies = {
  offlineSessionExists: () => Promise<boolean>;
  adminContext: (
    shop: string,
  ) => Promise<Context & { admin: { graphql: GraphQL } }>;
  storefrontContext: (
    shop: string,
  ) => Promise<Context & { storefront: { graphql: GraphQL } }>;
};

export function privateCartProbeVariables() {
  return {
    input: {
      lines: [],
      metafields: [
        { key: "membership_checkout", type: "json", value: probeValue },
      ],
    },
  };
}

function sameOfflineContext(context: Context) {
  if (context.session.shop !== domain || context.session.isOnline)
    throw new Error("PROBE_IDENTITY_REJECTED");
}

async function jsonData(
  graphql: GraphQL,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await graphql(query, { variables, tries: 1 });
  const payload = await response.json();
  if (!response.ok || payload?.errors || !payload?.data)
    throw new Error("PROBE_PROVIDER_RESPONSE_REJECTED");
  return payload.data;
}

function probeMatches(value: string) {
  const result = z
    .object({ kind: z.literal("PRIVATE_ACCESS_PROBE") })
    .strict()
    .safeParse(JSON.parse(value));
  return result.success;
}

const safeProviderCodes = new Set([
  "ACCESS_DENIED",
  "BAD_REQUEST",
  "GRAPHQL_VALIDATION_FAILED",
  "THROTTLED",
  "INTERNAL_SERVER_ERROR",
  "INVALID",
  "INVALID_METAFIELDS",
  "INVALID_MERCHANDISE_LINE",
  "MAXIMUM_EXCEEDED",
  "MISSING_CUSTOMER_ACCESS_TOKEN",
  "TOO_MANY_METAFIELDS",
]);
function safeProviderCode(value: unknown) {
  return typeof value === "string" && safeProviderCodes.has(value)
    ? value
    : "UNRECOGNIZED_PROVIDER_CODE";
}
function sdkErrorCodes(error: unknown) {
  const parsed = z
    .object({
      body: z.object({
        errors: z.object({
          graphQLErrors: z.array(
            z.object({
              extensions: z.object({ code: z.unknown() }).nullish(),
            }),
          ),
        }),
      }),
    })
    .safeParse(error);
  return parsed.success
    ? parsed.data.body.errors.graphQLErrors.map((entry) =>
        safeProviderCode(entry.extensions?.code),
      )
    : [];
}
function sdkFailureClass(error: unknown) {
  const permitted = new Set([
    "Error",
    "TypeError",
    "GraphqlQueryError",
    "HttpRequestError",
    "HttpResponseError",
    "HttpMaxRetriesError",
    "HttpThrottlingError",
    "SessionNotFoundError",
    "Response",
  ]);
  const name = error && typeof error === "object" ? error.constructor.name : "";
  return permitted.has(name) ? name : "UNRECOGNIZED_EXCEPTION_CLASS";
}
function sdkKnownFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return {
    networkFailure: /fetch failed|network|no response available/i.test(message),
    throttled: /throttl|max.*retr/i.test(message),
    accessDenied: /access denied/i.test(message),
    graphqlFieldRejected:
      /field.*doesn.t exist|undefinedfield|unknown argument/i.test(message),
  };
}
function safeHttpStatus(error: unknown) {
  if (error instanceof Response) return error.status;
  const response = z
    .object({
      response: z.object({
        status: z.number().optional(),
        code: z.number().optional(),
      }),
    })
    .safeParse(error);
  const status = response.success
    ? (response.data.response.status ?? response.data.response.code)
    : undefined;
  return status && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}
function safeRedirectMetadata(error: unknown) {
  if (!(error instanceof Response)) return null;
  const location = error.headers.get("location");
  return {
    hasLocation: location !== null,
    isOAuthRedirect: Boolean(
      location && /\/auth(?:\/|\?|$)|\/oauth(?:\/|\?|$)/i.test(location),
    ),
    reauthorizationRequested:
      error.headers.get("x-shopify-api-request-failure-reauthorize") === "1",
  };
}

/**
 * Exactly one non-payment cart mutation after identity and public-token checks.
 * No caller may supply cart input, customer identity, or a payment grant.
 * A timeout or rejected result never retries creation, even when no cart ID was
 * returned. Only a redacted report leaves this function; the cart key stays here.
 */
export async function probeMembershipPrivateCart(
  dependencies: Dependencies,
  options: { identityOnly?: boolean } = {},
) {
  const report = {
    checkedAt: new Date().toISOString(),
    shopDomain: domain,
    probeOnly: true,
    identityOnly: options.identityOnly === true,
    identityProbeVerified: false,
    identityResponseReceived: false,
    identityHttpOk: false,
    identityHttpStatus: null as number | null,
    identityGraphqlErrors: false,
    identityValidationIssues: [] as { path: string[]; code: string }[],
    adminVerified: false,
    sameAppVerified: false,
    storefrontVerified: false,
    publicStorefrontTokensAbsent: false,
    cartCreateSubmitted: false,
    createResponseReceived: false,
    createHttpOk: false,
    createHttpStatus: null as number | null,
    createCartPresent: false,
    createAuthorizationPresent: false,
    createIdHasKey: false,
    createShapeValid: false,
    createGraphqlErrors: false,
    createUserErrors: false,
    createValidationIssues: [] as { path: string[]; code: string }[],
    cartCreated: false,
    emptyCart: false,
    noBuyerIdentitySubmitted: true,
    expectedAppNamespace: null as string | null,
    writeAppNamespace: null as string | null,
    readAppNamespace: null as string | null,
    implicitAppNamespace: null as string | null,
    resolvedAppNamespace: null as string | null,
    explicitValueMatches: false,
    implicitValueMatches: false,
    resolvedValueMatches: false,
    explicitAppAliasRead: false,
    implicitAppDefaultRead: false,
    resolvedAppNamespaceRead: false,
    namespaceMatchesApp: false,
    probeValueMatches: false,
    readbackVerified: false,
    noCustomerProofWritten: true,
    paymentSubmitted: false,
    emailSent: false,
    publicTokenCreated: false,
    financialFlagsChanged: false,
    automaticRetry: false,
    cartSecretsRetained: false,
    nativeGuardCompletion: "DENIED_MALFORMED_GRANT_IF_ENABLED",
    failedStage: null as string | null,
    errorCodes: [] as string[],
    sdkHttpStatus: null as number | null,
    sdkExceptionClass: null as string | null,
    sdkKnownFailure: null as ReturnType<typeof sdkKnownFailure> | null,
    sdkRedirect: null as ReturnType<typeof safeRedirectMetadata> | null,
  };
  let stage = "OFFLINE_SESSION";
  try {
    if (!(await dependencies.offlineSessionExists()))
      throw new Error("PROBE_OFFLINE_SESSION_REQUIRED");
    stage = "ADMIN_CONTEXT";
    const admin = await dependencies.adminContext(domain);
    sameOfflineContext(admin);
    stage = "ADMIN_IDENTITY";
    const identityResponse = await admin.admin.graphql(
      PRIVATE_CART_IDENTITY_QUERY,
      {
        variables: {},
        tries: 1,
      },
    );
    report.identityResponseReceived = true;
    report.identityHttpOk = identityResponse.ok;
    report.identityHttpStatus = identityResponse.status;
    const identityPayload = await identityResponse.json();
    report.identityGraphqlErrors = Boolean(identityPayload?.errors);
    if (
      !identityResponse.ok ||
      identityPayload?.errors ||
      !identityPayload?.data
    )
      throw new Error("PROBE_IDENTITY_RESPONSE_REJECTED");
    const parsedIdentity = identitySchema.safeParse(identityPayload.data);
    if (!parsedIdentity.success) {
      report.identityValidationIssues = parsedIdentity.error.issues.map(
        (issue) => ({
          path: issue.path.filter(
            (part): part is string => typeof part === "string",
          ),
          code: issue.code,
        }),
      );
      report.errorCodes.push("ADMIN_IDENTITY_RESPONSE_SHAPE_REJECTED");
      throw new Error("PROBE_IDENTITY_RESPONSE_SHAPE_REJECTED");
    }
    const identity = parsedIdentity.data;
    const liveScopes = new Set(
      identity.currentAppInstallation.accessScopes.map((scope) => scope.handle),
    );
    if (requiredScopes.some((scope) => !liveScopes.has(scope)))
      throw new Error("PROBE_STOREFRONT_SCOPES_REQUIRED");
    report.adminVerified = true;
    report.sameAppVerified = true;
    report.expectedAppNamespace =
      identity.metafieldDefinitions.nodes[0].namespace;
    stage = "PUBLIC_STOREFRONT_TOKENS";
    await assertNoPublicMembershipStorefrontTokens(admin.admin.graphql);
    report.publicStorefrontTokensAbsent = true;
    stage = "STOREFRONT_CONTEXT";
    const storefront = await dependencies.storefrontContext(domain);
    sameOfflineContext(storefront);
    stage = "STOREFRONT_IDENTITY";
    const storefrontIdentity = z
      .object({
        shop: z.object({ id: z.literal(identity.shop.id) }),
      })
      .parse(
        await jsonData(
          storefront.storefront.graphql,
          PRIVATE_CART_SHOP_QUERY,
          {},
        ),
      );
    report.storefrontVerified = Boolean(storefrontIdentity.shop.id);
    report.identityProbeVerified = true;
    if (options.identityOnly) return report;
    stage = "EMPTY_CART_CREATE";
    report.cartCreateSubmitted = true;
    const createResponse = await storefront.storefront.graphql(
      PRIVATE_CART_CREATE,
      {
        variables: privateCartProbeVariables(),
        tries: 1,
      },
    );
    report.createResponseReceived = true;
    report.createHttpOk = createResponse.ok;
    report.createHttpStatus = createResponse.status;
    const createPayload = await createResponse.json();
    report.createGraphqlErrors = Boolean(createPayload?.errors);
    const diagnostic = z
      .object({
        data: z.object({
          cartCreate: z.object({
            cart: z.unknown(),
            userErrors: z.array(z.object({ code: z.unknown() })),
          }),
        }),
      })
      .safeParse(createPayload);
    if (diagnostic.success) {
      const result = diagnostic.data.data.cartCreate;
      report.createUserErrors = result.userErrors.length > 0;
      report.errorCodes = result.userErrors.map((entry) =>
        safeProviderCode(entry.code),
      );
      const diagnosticCart = z
        .object({
          id: z.string(),
          authorization: z.unknown(),
        })
        .safeParse(result.cart);
      if (diagnosticCart.success) {
        report.createCartPresent = true;
        report.createAuthorizationPresent =
          diagnosticCart.data.authorization !== null &&
          diagnosticCart.data.authorization !== undefined;
        report.createIdHasKey = diagnosticCart.data.id.includes("?key=");
      }
    }
    if (!createResponse.ok || createPayload?.errors || !createPayload?.data)
      throw new Error("PROBE_PROVIDER_RESPONSE_REJECTED");
    const parsedCreate = createSchema.safeParse(createPayload.data);
    report.createShapeValid = parsedCreate.success;
    if (!parsedCreate.success) {
      report.createValidationIssues = parsedCreate.error.issues.map(
        (issue) => ({
          path: issue.path.filter(
            (part): part is string => typeof part === "string",
          ),
          code: issue.code,
        }),
      );
      report.errorCodes.push("CART_CREATE_RESPONSE_SHAPE_REJECTED");
      throw new Error("PROBE_CART_RESPONSE_SHAPE_REJECTED");
    }
    const created = parsedCreate.data.cartCreate.cart;
    report.cartCreated = true;
    report.emptyCart = created.totalQuantity === 0;
    report.writeAppNamespace = created.authorization?.namespace ?? null;
    stage = "EMPTY_CART_READBACK";
    const read = z
      .object({
        cart: cartSchema.extend({
          implicitAuthorization: cartAuthorization.nullable(),
          resolvedAuthorization: cartAuthorization.nullable(),
        }),
      })
      .parse(
        await jsonData(storefront.storefront.graphql, PRIVATE_CART_READ, {
          cartId: created.id,
          namespace: report.expectedAppNamespace,
        }),
      ).cart;
    report.readAppNamespace = read.authorization?.namespace ?? null;
    report.implicitAppNamespace = read.implicitAuthorization?.namespace ?? null;
    report.resolvedAppNamespace = read.resolvedAuthorization?.namespace ?? null;
    report.explicitAppAliasRead = read.authorization !== null;
    report.implicitAppDefaultRead = read.implicitAuthorization !== null;
    report.resolvedAppNamespaceRead = read.resolvedAuthorization !== null;
    report.explicitValueMatches = Boolean(
      read.authorization && probeMatches(read.authorization.value),
    );
    report.implicitValueMatches = Boolean(
      read.implicitAuthorization &&
      probeMatches(read.implicitAuthorization.value),
    );
    report.resolvedValueMatches = Boolean(
      read.resolvedAuthorization &&
      probeMatches(read.resolvedAuthorization.value),
    );
    report.namespaceMatchesApp =
      report.readAppNamespace === report.expectedAppNamespace &&
      report.implicitAppNamespace === report.expectedAppNamespace &&
      report.resolvedAppNamespace === report.expectedAppNamespace;
    report.probeValueMatches =
      report.explicitValueMatches &&
      report.implicitValueMatches &&
      report.resolvedValueMatches;
    if (!report.namespaceMatchesApp || !report.probeValueMatches)
      throw new Error("PROBE_READ_NAMESPACE_OR_VALUE_MISMATCH");
    report.readbackVerified = true;
  } catch (error) {
    report.failedStage = stage;
    report.sdkHttpStatus = safeHttpStatus(error);
    report.sdkExceptionClass = sdkFailureClass(error);
    report.sdkKnownFailure = sdkKnownFailure(error);
    report.sdkRedirect = safeRedirectMetadata(error);
    // Exception messages can contain provider bodies, tokens, or a full Cart ID.
    // The fixed stage is all the operator needs before inspecting safe SDK state.
    report.errorCodes = [
      ...new Set([
        ...report.errorCodes,
        ...sdkErrorCodes(error),
        report.cartCreateSubmitted && !report.readbackVerified
          ? "EMPTY_CART_PROBE_UNVERIFIED_NO_AUTOMATIC_RETRY"
          : "EMPTY_CART_PROBE_PRECONDITION_REJECTED",
      ]),
    ];
  }
  return report;
}

async function readConfigClientId() {
  return /^client_id\s*=\s*"([^"]+)"/m.exec(
    await readFile(
      resolve(appPath, "shopify.app.membership-test.toml"),
      "utf8",
    ),
  )?.[1];
}

async function runSdkChild() {
  assertTestAccessEnvironment({
    shopDomain: domain,
    databaseUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    configClientId: await readConfigClientId(),
  });
  const { default: db } = await import("../app/db.server");
  try {
    const shop = await db.shop.findUnique({
      where: { domain },
      select: { status: true },
    });
    if (shop?.status !== "ACTIVE") throw new Error("PROBE_TEST_SHOP_INACTIVE");
    const { unauthenticated } = await import("../app/shopify.server");
    const report = await probeMembershipPrivateCart(
      {
        offlineSessionExists: async () => {
          const session = await db.session.findUnique({
            where: { id: `offline_${domain}` },
            select: { id: true, shop: true, isOnline: true },
          });
          return session?.shop === domain && session.isOnline === false;
        },
        adminContext: unauthenticated.admin,
        storefrontContext: unauthenticated.storefront,
      },
      { identityOnly: process.env.SKYRA_PRIVATE_CART_IDENTITY_ONLY === "true" },
    );
    console.log(reportPrefix + JSON.stringify(report));
    if (
      !(report.identityOnly
        ? report.identityProbeVerified
        : report.readbackVerified)
    )
      process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  try {
    if (process.argv[2] === "--sdk-child") return await runSdkChild();
    const identityOnly =
      process.argv[2] === "--check-private-identity" &&
      process.argv.length === 3;
    const createMode =
      process.argv[2] === "--probe-empty-test-cart" &&
      (process.argv.length === 3 ||
        (process.argv.length === 4 &&
          process.argv[3] === "--new-probe-after-review"));
    if (!identityOnly && !createMode)
      throw new Error("PROBE_EXPLICIT_MODE_REQUIRED");
    const existingReport = await readFile(reportPath, "utf8").catch(() => null);
    if (
      !identityOnly &&
      existingReport &&
      process.argv[3] !== "--new-probe-after-review"
    )
      throw new Error("PROBE_EXISTING_EVIDENCE_REQUIRES_MANUAL_REVIEW");
    assertLocalPreparationDatabase(process.env.DATABASE_URL, "development");
    if (
      process.env.NODE_ENV === "production" ||
      (await readConfigClientId()) !== appKey
    )
      throw new Error("PROBE_TEST_APP_REQUIRED");
    // Only this fixed official app-credentials command is allowed. No merchant
    // access token, CLI cache token, or raw stdout/stderr is printed or saved.
    const official = spawnSync(
      "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        `shopify.cmd app env show --config membership-test --path "${appPath}" --no-color`,
      ],
      { cwd: appPath, encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    if (official.error || official.status !== 0)
      throw new Error("PROBE_OFFICIAL_ENVIRONMENT_UNAVAILABLE");
    const credentials = parseOfficialTestAppEnvironment(official.stdout);
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "--sdk-child"],
      {
        cwd: appPath,
        encoding: "utf8",
        timeout: 45000,
        windowsHide: true,
        env: {
          ...process.env,
          ...credentials,
          SKYRA_PRIVATE_CART_IDENTITY_ONLY: String(identityOnly),
        },
      },
    );
    const reportLine = child.stdout
      ?.split(/\r?\n/)
      .find((line) => line.startsWith(reportPrefix));
    if (!reportLine) throw new Error("PROBE_CHILD_STOPPED_NO_AUTOMATIC_RETRY");
    const report = JSON.parse(reportLine.slice(reportPrefix.length));
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      identityOnly
        ? reportPath.replace(/\.json$/, "-identity.json")
        : reportPath,
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    );
    console.log(JSON.stringify(report, null, 2));
    if (
      child.status !== 0 ||
      !(identityOnly ? report.identityProbeVerified : report.readbackVerified)
    )
      process.exitCode = 1;
  } catch {
    const report = {
      probeOnly: true,
      shopDomain: domain,
      readbackVerified: false,
      paymentSubmitted: false,
      emailSent: false,
      automaticRetry: false,
      cartSecretsRetained: false,
      errorCodes: ["EMPTY_CART_PROBE_BLOCKED_NO_AUTOMATIC_RETRY"],
    };
    if (process.argv[2] === "--sdk-child")
      console.log(reportPrefix + JSON.stringify(report));
    else console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
