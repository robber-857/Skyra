// Closed development-store setup only. Never enables sales or submits a payment.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOfficialTestAppEnvironment,
  assertTestAccessEnvironment,
} from "./membership-test-access-preflight";
import { syncClosedTestMonthlyPass } from "./membership-sync-test-pass";
import { assertMembershipSellingPlan } from "../app/services/membership-selling-plan.server";
import { audit, lockShop } from "../app/services/catalog.server";
import type { GraphQL } from "../app/services/shopify-catalog.server";

const domain = "skyra-booking-dev.myshopify.com";
const appKey = "c9d266a38e2f11a1240139974253b3a1";
const passId = "76141c49-2407-4c74-b138-16204bf6162c";
const adminId = "a8d90c13-66f4-4bda-a6ac-7cb533e4d300";
const appPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = resolve(
  appPath,
  "../output/local-preview/monthly-test-setup-20261004",
);
const reportPrefix = "SKYRA_CLOSED_TEST_SETUP=";
let stage = "ENVIRONMENT";
const createPlanQuery = `mutation SkyraMonthlySellingPlanCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput!) {
  sellingPlanGroupCreate(input: $input, resources: $resources) {
    sellingPlanGroup { id sellingPlans(first: 10) { nodes { id name category } pageInfo { hasNextPage } } }
    userErrors { field code message }
  }
}`;
function monthlyPlanVariables(variantGid: string) {
  if (!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(variantGid))
    throw new Error("Invalid mapped variant");
  return {
    input: {
      name: "SKYRA Lifestyle monthly Pass",
      merchantCode: "skyra-lifestyle-monthly-managed-uat-v1",
      description:
        "AUD 299 per Pass, with 12 class credits. Each paid Pass starts on its first attended class and remains valid for one calendar month. Renewal is charged only after the preceding Pass is activated and expires; the renewed Pass waits for its own first attended class. Cancel to stop future renewals.",
      options: ["Pass renewal"],
      sellingPlansToCreate: [
        {
          name: "Automatically renew when this Pass expires",
          options: ["Monthly Pass renewal"],
          category: "SUBSCRIPTION",
          billingPolicy: {
            recurring: { interval: "MONTH", intervalCount: 1, minCycles: 1 },
          },
          deliveryPolicy: {
            recurring: {
              interval: "MONTH",
              intervalCount: 1,
              intent: "FULFILLMENT_BEGIN",
              preAnchorBehavior: "ASAP",
            },
          },
          pricingPolicies: [
            {
              fixed: {
                adjustmentType: "PERCENTAGE",
                adjustmentValue: { percentage: 0 },
              },
            },
          ],
          inventoryPolicy: { reserve: "ON_SALE" },
        },
      ],
    },
    resources: { productVariantIds: [variantGid] },
  };
}
const ownGroupsQuery = `query ClosedTestOwnGroups($after: String) {
  shop { myshopifyDomain currencyCode features { eligibleForSubscriptions } }
  currentAppInstallation { app { apiKey } }
  sellingPlanGroups(first: 20, after: $after, query: "app_id:CURRENT") {
    nodes { id sellingPlans(first: 100) { nodes { id } pageInfo { hasNextPage } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const productQuery = `query ClosedTestMonthlyProduct($id: ID!) {
  product(id: $id) { id status
    owner: metafield(namespace: "$app", key: "booking_owner_id") { jsonValue }
    monthly: metafield(namespace: "$app", key: "managed_monthly_pass") { jsonValue }
    variants(first: 2) { nodes { id price inventoryItem { requiresShipping } } }
  }
}`;

async function configureChild() {
  assertTestAccessEnvironment({
    shopDomain: domain,
    databaseUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    configClientId: appKey,
  });
  const { default: db } = await import("../app/db.server");
  try {
    stage = "SDK_IDENTITY";
    const { unauthenticated } = await import("../app/shopify.server");
    const context = await unauthenticated.admin(domain);
    if (context.session.shop !== domain || context.session.isOnline)
      throw new Error("Wrong context");
    const graphql: GraphQL = (
      query: string,
      options: { variables: Record<string, unknown> },
    ) =>
      context.admin.graphql(query, {
        ...options,
        tries: 1,
        signal: AbortSignal.timeout(12000),
      });
    const readData = async (
      query: string,
      variables: Record<string, unknown>,
    ) => {
      const response = await graphql(query, { variables });
      const payload = await response.json();
      if (!response.ok || payload.errors?.length || !payload.data)
        throw new Error("API result not verified");
      return payload.data;
    };
    const shop = await db.shop.findUniqueOrThrow({ where: { domain } });
    const pass = await db.passPlan.findFirstOrThrow({
      where: { id: passId, shopId: shop.id },
    });
    const staff = await db.staffAccount.findFirst({
      where: { id: adminId, shopId: shop.id, role: "ADMIN", status: "ACTIVE" },
    });
    if (
      shop.status !== "ACTIVE" ||
      !staff ||
      pass.status !== "DRAFT" ||
      pass.saleable ||
      pass.autoRenewEnabled ||
      pass.standalonePurchaseEnabled ||
      pass.requestedPriceCents !== 29900 ||
      pass.credits !== 12 ||
      pass.validityMonths !== 1 ||
      pass.introOnly
    )
      throw new Error("Test Pass is not closed");
    let after: string | null = null;
    let eligibility: boolean | null = null;
    const ownIds: string[] = [];
    for (let page = 0; page < 50; page++) {
      const data = await readData(ownGroupsQuery, { after });
      if (
        data.shop?.myshopifyDomain !== domain ||
        data.shop.currencyCode !== "AUD" ||
        data.currentAppInstallation?.app?.apiKey !== appKey
      )
        throw new Error("App identity not verified");
      eligibility = data.shop.features.eligibleForSubscriptions;
      for (const group of data.sellingPlanGroups.nodes) {
        if (group.sellingPlans.pageInfo.hasNextPage)
          throw new Error("Incomplete plan list");
        ownIds.push(group.id);
      }
      if (!data.sellingPlanGroups.pageInfo.hasNextPage) break;
      if (
        page === 49 ||
        !data.sellingPlanGroups.pageInfo.endCursor ||
        after === data.sellingPlanGroups.pageInfo.endCursor
      )
        throw new Error("Incomplete group list");
      after = data.sellingPlanGroups.pageInfo.endCursor;
    }
    stage = "DRAFT_CATALOG_SYNC";
    if (!pass.sellingPlanGid)
      await syncClosedTestMonthlyPass({ passId }, { graphql });
    const mapping = await db.productMapping.findUniqueOrThrow({
      where: {
        shopId_ownerType_ownerId: {
          shopId: shop.id,
          ownerType: "PASS_PLAN",
          ownerId: passId,
        },
      },
    });
    if (
      mapping.syncStatus !== "SYNCED" ||
      mapping.productStatus !== "DRAFT" ||
      mapping.requestedVersion !== pass.version ||
      mapping.shopifyVersion !== pass.version ||
      !mapping.productGid ||
      !mapping.variantGid
    )
      throw new Error("Mapping not verified");
    stage = "DRAFT_PRODUCT_READBACK";
    const product = (await readData(productQuery, { id: mapping.productGid }))
      .product;
    if (
      product?.id !== mapping.productGid ||
      product.status !== "DRAFT" ||
      product.owner?.jsonValue !== passId ||
      product.monthly?.jsonValue !== true ||
      product.variants.nodes.length !== 1 ||
      product.variants.nodes[0].id !== mapping.variantGid ||
      product.variants.nodes[0].price !== "299.00" ||
      product.variants.nodes[0].inventoryItem.requiresShipping !== false
    )
      throw new Error("Monthly product not verified");
    await fs.mkdir(evidencePath, { recursive: true });
    const responseFile = resolve(
      evidencePath,
      "selling-plan-create.response.json",
    );
    const submittedFile = resolve(
      evidencePath,
      "selling-plan-create.submitted.json",
    );
    let created: {
      id: string;
      sellingPlans: {
        nodes: { id: string }[];
        pageInfo: { hasNextPage: boolean };
      };
    };
    try {
      const retained = JSON.parse(await fs.readFile(responseFile, "utf8"));
      if (
        retained.domain !== domain ||
        retained.appKey !== appKey ||
        retained.passId !== passId ||
        retained.variantGid !== mapping.variantGid
      )
        throw new Error("Creator evidence mismatch");
      created = retained.response.sellingPlanGroupCreate.sellingPlanGroup;
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      if (ownIds.length || pass.sellingPlanGid)
        throw new Error("Existing plan requires reconciliation");
      // Persist before the external mutation. A lost response never permits another create.
      const variables = monthlyPlanVariables(mapping.variantGid);
      stage = "SELLING_PLAN_CREATE";
      await fs.writeFile(
        submittedFile,
        JSON.stringify(
          {
            domain,
            appKey,
            passId,
            variantGid: mapping.variantGid,
            submittedAt: new Date().toISOString(),
            variables,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      const data = await readData(createPlanQuery, variables);
      await fs.writeFile(
        responseFile,
        JSON.stringify(
          {
            domain,
            appKey,
            passId,
            variantGid: mapping.variantGid,
            retainedAt: new Date().toISOString(),
            response: data,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      if (data.sellingPlanGroupCreate.userErrors?.length) {
        process.exitCode = 1;
        return {
          configured: false,
          stage: "SELLING_PLAN_REJECTED",
          domain,
          passId,
          productGid: mapping.productGid,
          variantGid: mapping.variantGid,
          eligibleForSubscriptions: eligibility,
          checkout: "CLOSED",
          paymentSubmitted: false,
          emailSent: false,
          codes: data.sellingPlanGroupCreate.userErrors.map(
            (item: { code: string }) => item.code,
          ),
        };
      }
      created = data.sellingPlanGroupCreate.sellingPlanGroup;
    }
    if (
      !/^gid:\/\/shopify\/SellingPlanGroup\/[1-9]\d*$/.test(
        created?.id ?? "",
      ) ||
      created.sellingPlans.pageInfo.hasNextPage ||
      created.sellingPlans.nodes.length !== 1
    )
      throw new Error("Creation result needs reconciliation");
    const sellingPlanGid = created.sellingPlans.nodes[0].id;
    stage = "SELLING_PLAN_READBACK";
    await assertMembershipSellingPlan(graphql, {
      trustedGroupGid: created.id,
      productGid: mapping.productGid,
      variantGid: mapping.variantGid,
      sellingPlanGid,
      priceCents: 29900,
      currency: "AUD",
    });
    stage = "LOCAL_PLAN_ASSOCIATION";
    await db.$transaction(async (tx) => {
      await lockShop(tx, shop.id);
      const current = await tx.passPlan.findUniqueOrThrow({
        where: { id: passId },
      });
      if (
        current.shopId !== shop.id ||
        current.status !== "DRAFT" ||
        current.version !== pass.version ||
        current.saleable ||
        current.autoRenewEnabled ||
        current.standalonePurchaseEnabled ||
        (current.sellingPlanGid !== null &&
          current.sellingPlanGid !== sellingPlanGid) ||
        (current.sellingPlanGid === null &&
          current.updatedAt.getTime() !== pass.updatedAt.getTime())
      )
        throw new Error("Pass changed; keep closed");
      if (current.sellingPlanGid === sellingPlanGid) return;
      await tx.passPlan.update({
        where: { id: passId },
        data: { sellingPlanGid },
      });
      await audit(
        tx,
        { shopId: shop.id, actorId: staff.id, role: "ADMIN" },
        "MEMBERSHIP_PLAN_CONFIGURED",
        passId,
        {
          sellingPlanGid: null,
          standalonePurchaseEnabled: false,
          autoRenewEnabled: false,
        },
        {
          sellingPlanGid,
          standalonePurchaseEnabled: false,
          autoRenewEnabled: false,
        },
      );
    });
    const envFile = resolve(appPath, ".env");
    const env = await fs.readFile(envFile, "utf8");
    const setting = "SKYRA_MEMBERSHIPS_TEST_SELLING_PLAN_GROUP_GID";
    const line = new RegExp(`^${setting}=(.*)$`, "m").exec(env);
    if (
      line &&
      line[1].trim().replace(/^["']|["']$/g, "") &&
      line[1].trim().replace(/^["']|["']$/g, "") !== created.id
    )
      throw new Error("Existing trusted group differs; keep closed");
    stage = "TEST_TRUST_CONFIGURATION";
    // Append the test-only setting; never rewrite other processes' settings.
    if (line && line[1].trim().replace(/^["']|["']$/g, "") !== created.id)
      throw new Error(
        "Existing test setting needs review; do not overwrite the environment",
      );
    if (!line) await fs.appendFile(envFile, `\n${setting}=${created.id}\n`);
    return {
      configured: true,
      domain,
      passId,
      productGid: mapping.productGid,
      variantGid: mapping.variantGid,
      sellingPlanGroupGid: created.id,
      sellingPlanGid,
      eligibleForSubscriptions: eligibility,
      checkout: "CLOSED",
      productStatus: "DRAFT",
      paymentSubmitted: false,
      emailSent: false,
      retainedCreatorResponse: responseFile,
    };
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  try {
    if (process.argv[2] === "--sdk-child") {
      console.log(reportPrefix + JSON.stringify(await configureChild()));
      return;
    }
    if (
      process.argv[2] !== "--configure-closed-test-pass" ||
      process.argv.length !== 3
    )
      throw new Error("Closed test setup mode required");
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
      throw new Error("Official environment unavailable");
    const credentials = parseOfficialTestAppEnvironment(official.stdout);
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "--sdk-child"],
      {
        cwd: appPath,
        encoding: "utf8",
        timeout: 120000,
        windowsHide: true,
        env: { ...process.env, ...credentials },
      },
    );
    const report = child.stdout
      ?.split(/\r?\n/)
      .find((line) => line.startsWith(reportPrefix));
    if (!report)
      throw new Error("Closed setup stopped; reconcile retained results");
    console.log(
      JSON.stringify(JSON.parse(report.slice(reportPrefix.length)), null, 2),
    );
    if (child.status !== 0) process.exitCode = 1;
  } catch (error) {
    const failureObject =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    const response =
      failureObject.response && typeof failureObject.response === "object"
        ? (failureObject.response as Record<string, unknown>)
        : {};
    const cause =
      failureObject.cause && typeof failureObject.cause === "object"
        ? (failureObject.cause as Record<string, unknown>)
        : {};
    const safeCode = (value: unknown) =>
      typeof value === "string" && /^[A-Z][A-Z0-9_]{1,70}$/.test(value)
        ? value
        : null;
    const failure = {
      configured: false,
      checkout: "CLOSED",
      automaticRetry: false,
      stage,
      httpStatus: typeof response.status === "number" ? response.status : null,
      errorCode: safeCode(failureObject.code) ?? safeCode(cause.code),
      timedOut:
        failureObject.name === "AbortError" ||
        failureObject.name === "TimeoutError",
      paymentSubmitted: false,
      emailSent: false,
      reason:
        "Closed setup stopped; inspect retained evidence before another creation",
    };
    console.log(
      process.argv[2] === "--sdk-child"
        ? reportPrefix + JSON.stringify(failure)
        : JSON.stringify(failure, null, 2),
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
