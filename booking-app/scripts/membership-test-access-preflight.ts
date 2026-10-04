import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalPreparationDatabase } from "./membership-prepare-test-pass";

const domain = "skyra-booking-dev.myshopify.com";
const clientId = "c9d266a38e2f11a1240139974253b3a1";
const reportPrefix = "SKYRA_TEST_ACCESS_REPORT=";
const appPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ADMIN_TEST_ACCESS_QUERY = `#graphql
query MembershipTestAccess {
  shop { id myshopifyDomain currencyCode }
  currentAppInstallation { app { id apiKey } accessScopes { handle } }
}`;
export const STOREFRONT_TEST_ACCESS_QUERY = `#graphql
query MembershipTestStorefrontAccess { shop { id } }
`;

export function parseOfficialTestAppEnvironment(output: string) {
  const environment: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^(SHOPIFY_API_KEY|SHOPIFY_API_SECRET|SCOPES)\s*=\s*(.*)$/.exec(
        line.trim(),
      );
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (environment[match[1]] !== undefined)
      throw new Error(
        "Official app environment contains an ambiguous setting.",
      );
    environment[match[1]] = value;
  }
  if (
    environment.SHOPIFY_API_KEY !== clientId ||
    !environment.SHOPIFY_API_SECRET?.trim()
  )
    throw new Error(
      "The official test-app credentials are unavailable or mismatched.",
    );
  return environment;
}

export function assertTestAccessEnvironment(input: {
  shopDomain: string;
  databaseUrl: string | undefined;
  nodeEnv: string | undefined;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  configClientId: string | undefined;
}) {
  assertLocalPreparationDatabase(input.databaseUrl, "development");
  if (
    input.nodeEnv === "production" ||
    input.shopDomain !== domain ||
    input.apiKey !== clientId ||
    input.configClientId !== clientId ||
    !input.apiSecret?.trim()
  )
    throw new Error(
      "Only the configured test app and development shop are permitted.",
    );
}

export type OfflineSessionMetadata = {
  id: string;
  shop: string;
  isOnline: boolean;
  scope: string | null;
  expires: Date | null;
  hasRefreshToken: boolean;
  refreshTokenExpires: Date | null;
};
type GraphQL = (
  query: string,
  options: {
    variables: Record<string, unknown>;
    tries: number;
    signal?: AbortSignal;
  },
) => Promise<Response>;
type SessionIdentity = { shop: string; isOnline: boolean };
type AccessDependencies = {
  loadOfflineMetadata: () => Promise<OfflineSessionMetadata | null>;
  adminContext: (
    shop: string,
  ) => Promise<{ session: SessionIdentity; admin: { graphql: GraphQL } }>;
  storefrontContext: (
    shop: string,
  ) => Promise<{ session: SessionIdentity; storefront: { graphql: GraphQL } }>;
};

function safeFailureStatus(error: unknown): number | null {
  if (error instanceof Response) return error.status;
  if (error && typeof error === "object" && "response" in error) {
    const response = error.response as
      { status?: unknown; code?: unknown } | undefined;
    const status = response?.status ?? response?.code;
    if (typeof status === "number" && status >= 100 && status <= 599)
      return status;
  }
  return null;
}

function sessionMetadata(session: OfflineSessionMetadata | null) {
  return session
    ? {
        expires: session.expires?.toISOString() ?? null,
        hasRefreshToken: session.hasRefreshToken,
        refreshTokenExpires: session.refreshTokenExpires?.toISOString() ?? null,
        savedScopeHandles: (session.scope ?? "")
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => /^[a-z_]+$/.test(scope)),
      }
    : null;
}

export async function checkTestSdkAccess(dependencies: AccessDependencies) {
  const before = await dependencies.loadOfflineMetadata();
  if (
    !before ||
    before.shop !== domain ||
    before.isOnline ||
    before.id !== `offline_${domain}`
  )
    throw new Error(
      "The development shop has no normal saved offline session.",
    );
  const refreshExpected =
    before.hasRefreshToken &&
    Boolean(before.expires && before.expires.getTime() <= Date.now() + 300000);
  const missingRefresh =
    !before.hasRefreshToken &&
    Boolean(before.expires && before.expires.getTime() <= Date.now());
  let stage = "ADMIN_CONTEXT";
  let adminVerified = false;
  let appId: string | null = null;
  let liveScopeHandles: string[] = [];
  try {
    const admin = await dependencies.adminContext(domain);
    if (admin.session.shop !== domain || admin.session.isOnline)
      throw new Error("Wrong offline context.");
    stage = "ADMIN_READ";
    const response = await admin.admin.graphql(ADMIN_TEST_ACCESS_QUERY, {
      variables: {},
      tries: 1,
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    const data = payload?.data;
    if (
      !response.ok ||
      payload.errors ||
      data?.shop?.myshopifyDomain !== domain ||
      data?.currentAppInstallation?.app?.apiKey !== clientId ||
      data?.shop?.currencyCode !== "AUD" ||
      !/^gid:\/\/shopify\/Shop\/\d+$/.test(data?.shop?.id ?? "") ||
      !/^gid:\/\/shopify\/App\/\d+$/.test(
        data?.currentAppInstallation?.app?.id ?? "",
      )
    )
      throw new Response(undefined, {
        status: response.ok ? 403 : response.status,
      });
    adminVerified = true;
    appId = data.currentAppInstallation.app.id;
    liveScopeHandles = (data.currentAppInstallation.accessScopes ?? [])
      .map((scope: { handle?: unknown }) => scope.handle)
      .filter(
        (scope: unknown): scope is string =>
          typeof scope === "string" && /^[a-z_]+$/.test(scope),
      );
    stage = "STOREFRONT_CONTEXT";
    const storefront = await dependencies.storefrontContext(domain);
    if (storefront.session.shop !== domain || storefront.session.isOnline)
      throw new Error("Wrong offline context.");
    stage = "STOREFRONT_READ";
    const storefrontResponse = await storefront.storefront.graphql(
      STOREFRONT_TEST_ACCESS_QUERY,
      { variables: {}, tries: 1 },
    );
    const storefrontPayload = await storefrontResponse.json();
    if (
      !storefrontResponse.ok ||
      storefrontPayload.errors ||
      storefrontPayload.data?.shop?.id !== data.shop.id
    )
      throw new Response(undefined, {
        status: storefrontResponse.ok ? 403 : storefrontResponse.status,
      });
    const after = await dependencies.loadOfflineMetadata();
    return {
      checkedAt: new Date().toISOString(),
      shopDomain: domain,
      providerBusinessMutations: false,
      adminVerified: true,
      storefrontVerified: true,
      sameAppVerified: true,
      appId,
      sdkRefresh:
        refreshExpected &&
        after?.expires &&
        after.expires.getTime() > Date.now()
          ? "SUCCEEDED"
          : "NOT_NEEDED",
      requiresInteractiveLogin: false,
      liveScopeHandles,
      offlineSessionBefore: sessionMetadata(before),
      offlineSessionAfter: sessionMetadata(after),
    };
  } catch (error) {
    const after = await dependencies.loadOfflineMetadata();
    return {
      checkedAt: new Date().toISOString(),
      shopDomain: domain,
      providerBusinessMutations: false,
      adminVerified,
      storefrontVerified: false,
      sameAppVerified: adminVerified,
      appId,
      sdkRefresh:
        refreshExpected &&
        after?.expires &&
        after.expires.getTime() > Date.now()
          ? "SUCCEEDED"
          : refreshExpected
            ? "FAILED_OR_UNVERIFIED"
            : missingRefresh
              ? "UNAVAILABLE_NO_REFRESH_TOKEN"
              : "NOT_NEEDED",
      requiresInteractiveLogin: true,
      failedStage: stage,
      httpStatus: safeFailureStatus(error),
      failureReason: "NORMAL_SDK_ACCESS_FAILED_RECONNECT_TEST_INSTALLATION",
      liveScopeHandles,
      offlineSessionBefore: sessionMetadata(before),
      offlineSessionAfter: sessionMetadata(after),
    };
  }
}

async function readConfigClientId() {
  const config = await readFile(
    resolve(appPath, "shopify.app.membership-test.toml"),
    "utf8",
  );
  return /^client_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
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
    if (shop?.status !== "ACTIVE")
      throw new Error("The development shop must already be ACTIVE.");
    const { unauthenticated } = await import("../app/shopify.server");
    const report = await checkTestSdkAccess({
      loadOfflineMetadata: async () => {
        const rows = await db.$queryRaw<
          OfflineSessionMetadata[]
        >`SELECT id, shop, "isOnline", scope, expires, COALESCE(length("refreshToken"), 0) > 0 AS "hasRefreshToken", "refreshTokenExpires" FROM "Session" WHERE id = ${`offline_${domain}`} AND shop = ${domain} AND "isOnline" = false`;
        return rows[0] ?? null;
      },
      adminContext: unauthenticated.admin,
      storefrontContext: unauthenticated.storefront,
    });
    console.log(reportPrefix + JSON.stringify(report));
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  try {
    if (process.argv[2] === "--sdk-child") return await runSdkChild();
    if (process.argv[2] !== "--sdk-check")
      throw new Error(
        "Use --sdk-check for the isolated normal SDK access check.",
      );
    assertLocalPreparationDatabase(process.env.DATABASE_URL, "development");
    if (
      process.env.NODE_ENV === "production" ||
      (await readConfigClientId()) !== clientId
    )
      throw new Error(
        "Only the local configured test application is permitted.",
      );
    // The fixed official command supplies app credentials only. Its raw output
    // and errors stay in memory; no merchant CLI/cache token is ever accepted.
    const official = spawnSync(
      "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        `shopify.cmd app env show --config membership-test --path "${appPath}" --no-color`,
      ],
      {
        cwd: appPath,
        encoding: "utf8",
        timeout: 20000,
        windowsHide: true,
      },
    );
    if (official.error || official.status !== 0)
      throw new Error("The official test-app environment could not be loaded.");
    const credentials = parseOfficialTestAppEnvironment(official.stdout);
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "--sdk-child"],
      {
        cwd: appPath,
        encoding: "utf8",
        timeout: 45000,
        windowsHide: true,
        env: { ...process.env, ...credentials },
      },
    );
    const reportLine = child.stdout
      ?.split(/\r?\n/)
      .find((line) => line.startsWith(reportPrefix));
    if (!reportLine)
      throw new Error(
        "Normal SDK check failed or timed out; reconnect the test installation.",
      );
    console.log(
      JSON.stringify(
        JSON.parse(reportLine.slice(reportPrefix.length)),
        null,
        2,
      ),
    );
  } catch {
    const blocked = {
      shopDomain: domain,
      adminVerified: false,
      storefrontVerified: false,
      failureReason: "TEST_ACCESS_PREFLIGHT_BLOCKED_USE_NORMAL_TEST_APP_AUTH",
      requiresInteractiveLogin: true,
      rawProviderErrorsSuppressed: true,
    };
    if (process.argv[2] === "--sdk-child")
      console.log(reportPrefix + JSON.stringify(blocked));
    else console.log(JSON.stringify(blocked, null, 2));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
