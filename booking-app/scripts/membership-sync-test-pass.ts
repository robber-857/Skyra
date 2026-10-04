import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import db from "../app/db.server";
import { DEVELOPMENT_BOOKING_SHOP } from "../app/services/commerce-capabilities.server";
import {
  MAPPING_READ,
  METAFIELDS_SET,
  PRODUCT_SET,
  syncCatalogEvent,
  type GraphQL,
} from "../app/services/shopify-catalog.server";
import { assertLocalPreparationDatabase } from "./membership-prepare-test-pass";

export const TEST_APP_KEY = "c9d266a38e2f11a1240139974253b3a1";
export const TEST_APP_DIRECTORY = "D:/Skyra/booking-app";
export const TEST_CLI_ENTRY =
  "C:/Users/28068/AppData/Roaming/npm/node_modules/@shopify/cli/bin/run.js";
const evidenceRoot = "D:/Skyra/output/membership-catalog-sync";
const callTimeoutMs = 12000;
const preparationReadTimeoutMs = 30000;
const transactionRemoteBudgetMs = 49000;

export const TEST_SYNC_IDENTITY = `#graphql
query MembershipTestSyncIdentity {
  shop { myshopifyDomain currencyCode plan { partnerDevelopment } }
  currentAppInstallation { app { apiKey } }
}`;
export const TEST_SYNC_HANDLE_READ = `#graphql
query MembershipTestDraftByHandle($identifier: ProductIdentifierInput!) {
  product: productByIdentifier(identifier: $identifier) {
    id handle title status
    bookingOwner: metafield(namespace: "$app", key: "booking_owner_id") { jsonValue }
    variants(first: 2) { nodes { id price } }
  }
}`;

const inputSchema = z.object({ passId: z.string().uuid() }).strict();
const allowedQueries = new Map([
  [TEST_SYNC_IDENTITY, "shop"],
  [TEST_SYNC_HANDLE_READ, "product"],
  [MAPPING_READ, "product"],
  [PRODUCT_SET, "productSet"],
  [METAFIELDS_SET, "metafieldsSet"],
]);

/** CLI output-file contains the operation's data, not necessarily { data }. */
export function normalizeTestCliOutput(raw: unknown, expectedField: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      "The CLI returned an unrecognized response; reconcile before retrying.",
    );
  const value = raw as Record<string, unknown>;
  if (Array.isArray(value.errors) && value.errors.length) return value;
  const data = Object.hasOwn(value, "data") ? value.data : value;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Object.hasOwn(data, expectedField)
  )
    throw new Error(
      "The CLI returned an incomplete response; reconcile before retrying.",
    );
  return { data };
}

type CliFailurePhase = "EXECUTE" | "READ_RESPONSE" | "VALIDATE_RESPONSE";

/** Record bounded OS/process metadata, never exception messages or commands. */
export function classifyTestCliFailure(
  error: unknown,
  phase: CliFailurePhase,
  stderr: string,
) {
  const value =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const errorCode =
    typeof value.code === "number" && Number.isInteger(value.code)
      ? value.code
      : typeof value.code === "string" && /^[A-Z0-9_]{1,64}$/.test(value.code)
        ? value.code
        : null;
  const signal =
    typeof value.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(value.signal)
      ? value.signal
      : null;
  const killed = value.killed === true;
  let category = "CLI_OPERATION_FAILED";
  if (value.name === "AbortError" || errorCode === "ABORT_ERR")
    category = "CLI_ABORTED";
  else if (killed && signal === "SIGTERM") category = "CLI_TIMEOUT";
  else if (killed) category = "CLI_PROCESS_TERMINATED";
  else if (
    errorCode === "EPERM" ||
    errorCode === "EACCES" ||
    /\b(?:EPERM|EACCES)\b/.test(stderr)
  )
    category = "CLI_OS_PERMISSION";
  else if (phase === "READ_RESPONSE" && errorCode === "ENOENT")
    category = "CLI_RESPONSE_MISSING";
  else if (phase === "READ_RESPONSE" && value.name === "SyntaxError")
    category = "CLI_RESPONSE_INVALID_JSON";
  else if (phase === "VALIDATE_RESPONSE")
    category = "CLI_RESPONSE_REJECTED_OR_INCOMPLETE";
  else if (errorCode === "ENOENT") category = "CLI_RUNTIME_MISSING";
  else if (typeof errorCode === "number") category = "CLI_EXIT_NONZERO";
  return { category, phase, errorCode, killed, signal };
}

/**
 * Invoke Node and the known installed CLI entry directly. No shell, .cmd,
 * inline GraphQL, session-token extraction, or automatic command retry.
 */
export function createTestCliGraphql(
  evidenceDirectory: string,
  assertStillClosed: () => Promise<void>,
): GraphQL {
  let sequence = 0;
  let syncStartedAt: number | undefined;
  return async (query, options) => {
    const timeoutMs = [TEST_SYNC_IDENTITY, TEST_SYNC_HANDLE_READ].includes(
      query,
    )
      ? preparationReadTimeoutMs
      : callTimeoutMs;
    const expectedField = allowedQueries.get(query);
    if (!expectedField)
      throw new Error(
        "Only the closed test Pass catalogue operations are allowed.",
      );
    await assertStillClosed();
    if (
      query === PRODUCT_SET &&
      options.variables.input &&
      (options.variables.input as Record<string, unknown>).status !== "DRAFT"
    )
      throw new Error(
        "This helper cannot create or activate a saleable product.",
      );
    if ([MAPPING_READ, PRODUCT_SET, METAFIELDS_SET].includes(query)) {
      syncStartedAt ??= Date.now();
      if (
        Date.now() - syncStartedAt + callTimeoutMs >
        transactionRemoteBudgetMs
      )
        throw new Error(
          "The bounded catalogue sync budget expired; reconcile this run before retrying.",
        );
    }
    const prefix = resolve(
      evidenceDirectory,
      String(++sequence).padStart(2, "0"),
    );
    const queryFile = prefix + ".graphql";
    const variableFile = prefix + ".variables.json";
    const outputFile = prefix + ".response.json";
    await fs.mkdir(evidenceDirectory, { recursive: true });
    await fs.writeFile(queryFile, query, { flag: "wx" });
    await fs.writeFile(
      variableFile,
      JSON.stringify(options.variables, null, 2),
      { flag: "wx" },
    );
    const args = [
      TEST_CLI_ENTRY,
      "app",
      "execute",
      "--config",
      "membership-test",
      "--path",
      TEST_APP_DIRECTORY,
      "--store",
      DEVELOPMENT_BOOKING_SHOP,
      "--version",
      "2026-07",
      "--query-file",
      queryFile,
      "--variable-file",
      variableFile,
      "--output-file",
      outputFile,
      "--no-color",
    ];
    let stdout = "";
    let stderr = "";
    let phase: CliFailurePhase = "EXECUTE";
    const startedAt = Date.now();
    try {
      await new Promise<void>((accept, reject) => {
        execFile(
          process.execPath,
          args,
          {
            cwd: TEST_APP_DIRECTORY,
            shell: false,
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            signal: options.signal,
            env: {
              ...process.env,
              SHOPIFY_CLI_NO_ANALYTICS: "1",
              OPT_OUT_INSTRUMENTATION: "true",
              NODE_OPTIONS:
                "--dns-result-order=ipv4first --no-network-family-autoselection",
            },
          },
          (error, out, err) => {
            stdout = out;
            stderr = err;
            if (error) reject(error);
            else accept();
          },
        );
      });
      phase = "READ_RESPONSE";
      const raw: unknown = JSON.parse(await fs.readFile(outputFile, "utf8"));
      phase = "VALIDATE_RESPONSE";
      const result = normalizeTestCliOutput(raw, expectedField);
      const data =
        "data" in result ? (result.data as Record<string, unknown>) : undefined;
      if (
        query === MAPPING_READ &&
        data?.product &&
        (data.product as Record<string, unknown>).status !== "DRAFT"
      )
        throw new Error(
          "The live mapped product is not DRAFT; it will not be overwritten.",
        );
      if (query === PRODUCT_SET) {
        const payload = data?.productSet as
          { product?: { status?: string } } | undefined;
        if (payload?.product && payload.product.status !== "DRAFT")
          throw new Error(
            "Shopify did not retain DRAFT status; stop and reconcile.",
          );
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      await fs.writeFile(
        prefix + ".failure.json",
        JSON.stringify(
          {
            outcome: "UNKNOWN_OR_REJECTED",
            automaticRetry: false,
            ...classifyTestCliFailure(error, phase, stderr),
            timeoutMs,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            queryFile,
            variableFile,
            outputFile,
            instruction:
              "Keep this evidence and reconcile the original deterministic product handle before a new manual run.",
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      throw new Error(
        "The test catalogue operation failed or has an unknown result. No automatic retry was made; inspect the retained evidence.",
      );
    } finally {
      await fs.writeFile(prefix + ".stdout.txt", stdout, { flag: "wx" });
      await fs.writeFile(prefix + ".stderr.txt", stderr, { flag: "wx" });
    }
  };
}

async function readClosedTestPass(passId: string) {
  assertLocalPreparationDatabase(
    process.env.DATABASE_URL,
    process.env.NODE_ENV,
  );
  const shop = await db.shop.findUniqueOrThrow({
    where: { domain: DEVELOPMENT_BOOKING_SHOP },
  });
  if (shop.status !== "ACTIVE")
    throw new Error("The development shop must be ACTIVE.");
  const pass = await db.passPlan.findFirstOrThrow({
    where: { id: passId, shopId: shop.id },
  });
  if (
    pass.status !== "DRAFT" ||
    pass.saleable ||
    pass.autoRenewEnabled ||
    pass.standalonePurchaseEnabled ||
    pass.sellingPlanGid !== null ||
    pass.requestedPriceCents !== 29900 ||
    pass.credits !== 12 ||
    pass.validityMonths !== 1 ||
    pass.introOnly
  )
    throw new Error(
      "Select the closed DRAFT A$299 / 12-class / one-month test Pass; this helper never changes its terms or enables sales.",
    );
  const mapping = await db.productMapping.findUniqueOrThrow({
    where: {
      shopId_ownerType_ownerId: {
        shopId: shop.id,
        ownerType: "PASS_PLAN",
        ownerId: passId,
      },
    },
  });
  if (mapping.productStatus !== null && mapping.productStatus !== "DRAFT")
    throw new Error(
      "The mapped product is not DRAFT; it will not be overwritten.",
    );
  if (mapping.requestedVersion !== pass.version)
    throw new Error(
      "The Pass and mapping versions differ; review them in Classes & Passes.",
    );
  return { shop, pass, mapping };
}

async function checkedData(
  graphql: GraphQL,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await graphql(query, { variables, tries: 1 });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length || !payload.data)
    throw new Error(
      "The test-store read failed; no catalogue mutation is allowed.",
    );
  return payload.data;
}

export async function syncClosedTestMonthlyPass(
  raw: unknown,
  options: { graphql?: GraphQL; evidenceDirectory?: string } = {},
) {
  const { passId } = inputSchema.parse(raw);
  const initial = await readClosedTestPass(passId);
  const directory =
    options.evidenceDirectory ?? resolve(evidenceRoot, passId, randomUUID());
  const stillClosed = async () => {
    const current = await readClosedTestPass(passId);
    if (
      current.pass.version !== initial.pass.version ||
      current.mapping.id !== initial.mapping.id
    )
      throw new Error(
        "The Pass changed during preparation; no catalogue mutation is allowed.",
      );
  };
  const provider =
    options.graphql ?? createTestCliGraphql(directory, stillClosed);
  const graphql: GraphQL = async (query, callOptions) => {
    await stillClosed();
    if (!allowedQueries.has(query))
      throw new Error(
        "Only the closed test Pass catalogue operations are allowed.",
      );
    if (query === PRODUCT_SET) {
      const input = callOptions.variables.input as
        Record<string, unknown> | undefined;
      const variants = input?.variants as { price?: string }[] | undefined;
      if (
        input?.status !== "DRAFT" ||
        input.handle !== "skyra-booking-" + passId ||
        input.title !== initial.pass.name ||
        variants?.length !== 1 ||
        variants[0].price !== "299.00"
      )
        throw new Error(
          "This helper can synchronize only this closed DRAFT monthly Pass.",
        );
    }
    const response = await provider(query, { ...callOptions, tries: 1 });
    if (query === MAPPING_READ) {
      const result = await response.clone().json();
      if (result.data?.product && result.data.product.status !== "DRAFT")
        throw new Error(
          "The live mapped product is not DRAFT; it will not be overwritten.",
        );
    }
    return response;
  };
  const identity = await checkedData(graphql, TEST_SYNC_IDENTITY, {});
  if (
    identity.shop?.myshopifyDomain !== DEVELOPMENT_BOOKING_SHOP ||
    identity.shop?.currencyCode !== "AUD" ||
    identity.shop?.plan?.partnerDevelopment !== true ||
    identity.currentAppInstallation?.app?.apiKey !== TEST_APP_KEY
  )
    throw new Error(
      "The authenticated CLI app, development shop, or AUD currency does not match; no mutation was made.",
    );
  const handle = "skyra-booking-" + passId;
  if (!initial.mapping.productGid) {
    const data = await checkedData(graphql, TEST_SYNC_HANDLE_READ, {
      identifier: { handle },
    });
    const product = data.product;
    if (
      product &&
      (product.status !== "DRAFT" ||
        product.handle !== handle ||
        product.title !== initial.pass.name ||
        product.variants?.nodes?.length !== 1 ||
        product.variants.nodes[0].price !== "299.00" ||
        (product.bookingOwner?.jsonValue != null &&
          product.bookingOwner.jsonValue !== passId))
    )
      throw new Error(
        "The deterministic handle already belongs to a different or non-DRAFT product; it will not be overwritten.",
      );
  }
  await stillClosed();
  const events = await db.outboxEvent.findMany({
    where: {
      shopId: initial.shop.id,
      aggregateId: passId,
      kind: "CATALOG_SYNC",
      version: initial.pass.version,
      status: "PENDING",
    },
    orderBy: { createdAt: "asc" },
  });
  if (events.length > 1)
    throw new Error(
      "Multiple pending catalogue events exist; select and reconcile them in Admin.",
    );
  const event = events[0];
  if (
    event &&
    (event.payload as Record<string, unknown>).ownerType !== "PASS_PLAN"
  )
    throw new Error("The pending event does not belong to this Pass.");
  if (
    !event &&
    (initial.mapping.syncStatus !== "SYNCED" ||
      initial.mapping.shopifyVersion !== initial.pass.version)
  )
    throw new Error(
      "No pending Pass catalogue event exists; repair the mapping in Classes & Passes.",
    );
  if (event) {
    if (event.availableAt > new Date())
      throw new Error(
        "The existing event backoff has not elapsed; no automatic retry was made.",
      );
    await syncCatalogEvent(event.id, graphql);
  }
  const finished = await readClosedTestPass(passId);
  if (
    finished.mapping.syncStatus !== "SYNCED" ||
    finished.mapping.shopifyVersion !== finished.pass.version ||
    finished.mapping.productStatus !== "DRAFT" ||
    !finished.mapping.productGid ||
    !finished.mapping.variantGid
  )
    throw new Error(
      "DRAFT catalogue synchronization was not verified; keep sales closed and inspect this run.",
    );
  const verified = await checkedData(graphql, MAPPING_READ, {
    id: finished.mapping.productGid,
  });
  if (
    verified.product?.id !== finished.mapping.productGid ||
    verified.product?.status !== "DRAFT" ||
    verified.product?.bookingOwner?.jsonValue !== passId ||
    verified.product?.variants?.nodes?.length !== 1 ||
    verified.product.variants.nodes[0].id !== finished.mapping.variantGid ||
    verified.product.variants.nodes[0].price !== "299.00"
  )
    throw new Error(
      "The live DRAFT mapping read-back did not match; keep sales closed and reconcile.",
    );
  return {
    action: event ? "DRAFT_SYNCED" : "DRAFT_ALREADY_SYNCED",
    domain: DEVELOPMENT_BOOKING_SHOP,
    appKey: TEST_APP_KEY,
    passId,
    eventId: event?.id ?? null,
    productGid: finished.mapping.productGid,
    variantGid: finished.mapping.variantGid,
    productStatus: "DRAFT",
    checkout: "CLOSED",
    evidenceDirectory: directory,
    automaticRetry: false,
  };
}

async function main() {
  const [mode, passId, ...extra] = process.argv.slice(2);
  if (mode !== "--sync-closed-test-pass" || !passId || extra.length)
    throw new Error(
      "Usage: tsx --env-file=.env scripts/membership-sync-test-pass.ts --sync-closed-test-pass <existing-test-pass-uuid>",
    );
  assertLocalPreparationDatabase(process.env.DATABASE_URL, "development");
  try {
    console.log(
      JSON.stringify(await syncClosedTestMonthlyPass({ passId }), null, 2),
    );
  } finally {
    await db.$disconnect();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
