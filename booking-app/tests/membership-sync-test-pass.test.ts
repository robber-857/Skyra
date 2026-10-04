import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { savePass } from "../app/services/catalog.server";
import {
  MAPPING_READ,
  METAFIELDS_SET,
  PRODUCT_SET,
  type GraphQL,
} from "../app/services/shopify-catalog.server";
import { assertLocalPreparationDatabase } from "../scripts/membership-prepare-test-pass";
import {
  createTestCliGraphql,
  normalizeTestCliOutput,
  syncClosedTestMonthlyPass,
  TEST_APP_DIRECTORY,
  TEST_APP_KEY,
  TEST_CLI_ENTRY,
  TEST_SYNC_HANDLE_READ,
  TEST_SYNC_IDENTITY,
} from "../scripts/membership-sync-test-pass";

const execMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execMock }));

const domain = "skyra-booking-dev.myshopify.com";
const productGid = "gid://shopify/Product/991";
const variantGid = "gid://shopify/ProductVariant/992";
let shopId: string | undefined;
let staffId: string;
let serviceId: string;
let passId: string;
const filesRoot = resolve(
  "D:/Skyra/output/membership-sync-unit-evidence",
  randomUUID(),
);

const identity = () => ({
  shop: {
    myshopifyDomain: domain,
    currencyCode: "AUD",
    plan: { partnerDevelopment: true },
  },
  currentAppInstallation: { app: { apiKey: TEST_APP_KEY } },
});
const product = () => ({
  id: productGid,
  title: "[DEV] SKYRA Lifestyle 1 month",
  status: "DRAFT",
  handle: "skyra-booking-" + passId,
  bookingOwner: { jsonValue: passId },
  variants: { nodes: [{ id: variantGid, price: "299.00" }] },
});

function provider(
  overrides: {
    identity?: ReturnType<typeof identity>;
    product?: ReturnType<typeof product> | null;
    handleProduct?: ReturnType<typeof product>;
    productSetError?: boolean;
  } = {},
) {
  return vi.fn<GraphQL>(async (query) => {
    let data: unknown;
    if (query === TEST_SYNC_IDENTITY) data = overrides.identity ?? identity();
    else if (query === TEST_SYNC_HANDLE_READ)
      data = { product: overrides.handleProduct ?? overrides.product ?? null };
    else if (query === PRODUCT_SET) {
      if (overrides.productSetError)
        throw new Error("Provider response unknown");
      data = { productSet: { product: product(), userErrors: [] } };
    } else if (query === METAFIELDS_SET)
      data = { metafieldsSet: { metafields: [], userErrors: [] } };
    else if (query === MAPPING_READ)
      data = { product: overrides.product ?? product() };
    else throw new Error("An unapproved provider operation was requested");
    return new Response(JSON.stringify({ data }));
  });
}

beforeAll(async () => {
  assertLocalPreparationDatabase(process.env.DATABASE_URL, "test");
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Only the dedicated local test database is allowed.");
  if (await db.shop.findUnique({ where: { domain } }))
    throw new Error(
      "Preserve the existing fixed-domain fixture and investigate before testing.",
    );
  shopId = (
    await db.shop.create({
      data: { domain, rules: { draftCatalogSyncFixture: true } },
    })
  ).id;
  staffId = (
    await db.staffAccount.create({
      data: {
        shopId,
        subject: randomUUID(),
        role: "ADMIN",
        displayName: "Test administrator",
      },
    })
  ).id;
  const locationId = (
    await db.location.create({ data: { shopId, name: "Fixture studio" } })
  ).id;
  serviceId = (
    await db.service.create({
      data: {
        shopId,
        locationId,
        name: "Fixture group class",
        kind: "CLASS",
        status: "ACTIVE",
        durationMin: 60,
        capacity: 8,
        requestedPriceCents: 4900,
      },
    })
  ).id;
});

beforeEach(async () => {
  execMock.mockReset();
  await db.outboxEvent.deleteMany({ where: { shopId } });
  await db.productMapping.deleteMany({ where: { shopId } });
  await db.passEligibility.deleteMany({ where: { shopId } });
  await db.passPlan.deleteMany({ where: { shopId } });
  passId = (
    await savePass(
      { shopId: shopId!, actorId: staffId, role: "ADMIN" },
      {
        name: "[DEV] SKYRA Lifestyle 1 month",
        status: "DRAFT",
        saleable: false,
        requestedPriceCents: 29900,
        credits: 12,
        validityDays: 30,
        validityMonths: 1,
        introOnly: false,
        serviceIds: [serviceId],
      },
    )
  ).id;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (shopId) {
    await db.outboxEvent.deleteMany({ where: { shopId } });
    await db.productMapping.deleteMany({ where: { shopId } });
    await db.passEligibility.deleteMany({ where: { shopId } });
    await db.passPlan.deleteMany({ where: { shopId } });
    await db.service.deleteMany({ where: { shopId } });
    await db.location.deleteMany({ where: { shopId } });
    await db.staffAccount.deleteMany({ where: { shopId } });
    await db.shop.update({
      where: { id: shopId },
      data: {
        domain: `retired-draft-sync-fixture-${shopId}.myshopify.com`,
        status: "INACTIVE",
      },
    });
  }
  await db.$disconnect();
});

test("uses the actual catalogue transaction and retains a closed DRAFT mapping without publishing", async () => {
  const graphql = provider();
  const result = await syncClosedTestMonthlyPass({ passId }, { graphql });
  expect(result).toMatchObject({
    action: "DRAFT_SYNCED",
    productStatus: "DRAFT",
    checkout: "CLOSED",
    automaticRetry: false,
  });
  expect(graphql.mock.calls.map(([query]) => query)).toEqual([
    TEST_SYNC_IDENTITY,
    TEST_SYNC_HANDLE_READ,
    PRODUCT_SET,
    METAFIELDS_SET,
    MAPPING_READ,
    MAPPING_READ,
  ]);
  expect(
    graphql.mock.calls.find(([query]) => query === PRODUCT_SET)?.[1].variables,
  ).toMatchObject({
    identifier: { handle: "skyra-booking-" + passId },
    input: {
      status: "DRAFT",
      variants: [
        { price: "299.00", inventoryItem: { requiresShipping: false } },
      ],
    },
  });
  expect(
    graphql.mock.calls.find(([query]) => query === METAFIELDS_SET)?.[1]
      .variables,
  ).toMatchObject({
    metafields: expect.arrayContaining([
      {
        ownerId: productGid,
        namespace: "$app",
        key: "managed_monthly_pass",
        type: "boolean",
        value: "true",
      },
    ]),
  });
  expect(
    await db.outboxEvent.findFirst({ where: { aggregateId: passId } }),
  ).toMatchObject({ status: "DONE" });
  expect(await db.passPlan.findUnique({ where: { id: passId } })).toMatchObject(
    {
      status: "DRAFT",
      saleable: false,
      autoRenewEnabled: false,
      standalonePurchaseEnabled: false,
      sellingPlanGid: null,
    },
  );
  expect(execMock).not.toHaveBeenCalled();
});

test("a later invocation reads the original completed mapping and makes no mutation", async () => {
  await syncClosedTestMonthlyPass({ passId }, { graphql: provider() });
  const graphql = provider();
  const result = await syncClosedTestMonthlyPass({ passId }, { graphql });
  expect(result.action).toBe("DRAFT_ALREADY_SYNCED");
  expect(graphql.mock.calls.map(([query]) => query)).toEqual([
    TEST_SYNC_IDENTITY,
    MAPPING_READ,
  ]);
});

test.each(["app", "domain", "currency", "development"])(
  "rejects the wrong authenticated %s before any mutation",
  async (field) => {
    const wrong = identity();
    if (field === "app")
      wrong.currentAppInstallation.app.apiKey = "different-app";
    if (field === "domain")
      wrong.shop.myshopifyDomain = "mf0n6s-zg.myshopify.com";
    if (field === "currency") wrong.shop.currencyCode = "USD";
    if (field === "development") wrong.shop.plan.partnerDevelopment = false;
    const graphql = provider({ identity: wrong });
    await expect(
      syncClosedTestMonthlyPass({ passId }, { graphql }),
    ).rejects.toThrow("does not match");
    expect(graphql.mock.calls.map(([query]) => query)).toEqual([
      TEST_SYNC_IDENTITY,
    ]);
    expect(
      await db.outboxEvent.findFirst({ where: { aggregateId: passId } }),
    ).toMatchObject({ status: "PENDING" });
  },
);

test.each([
  "status",
  "saleable",
  "autoRenewEnabled",
  "standalonePurchaseEnabled",
  "sellingPlanGid",
] as const)(
  "rejects an already-open or differently configured %s without contacting Shopify",
  async (field) => {
    await db.passPlan.update({
      where: { id: passId },
      data: {
        [field]:
          field === "status"
            ? "ACTIVE"
            : field === "sellingPlanGid"
              ? "gid://shopify/SellingPlan/5"
              : true,
      },
    });
    const graphql = provider();
    await expect(
      syncClosedTestMonthlyPass({ passId }, { graphql }),
    ).rejects.toThrow("closed DRAFT");
    expect(graphql).not.toHaveBeenCalled();
  },
);

test("an ACTIVE mapping is preserved without contacting Shopify", async () => {
  await db.productMapping.updateMany({
    where: { shopId },
    data: { productStatus: "ACTIVE" },
  });
  const graphql = provider();
  await expect(
    syncClosedTestMonthlyPass({ passId }, { graphql }),
  ).rejects.toThrow("not DRAFT");
  expect(graphql).not.toHaveBeenCalled();
});

test("a remote ACTIVE mapped product is preserved even when the saved mapping claims DRAFT", async () => {
  await db.productMapping.updateMany({
    where: { shopId },
    data: { productGid, variantGid, productStatus: "DRAFT" },
  });
  const graphql = provider({ product: { ...product(), status: "ACTIVE" } });
  await expect(
    syncClosedTestMonthlyPass({ passId }, { graphql }),
  ).rejects.toThrow("live mapped product is not DRAFT");
  expect(graphql.mock.calls.map(([query]) => query)).toEqual([
    TEST_SYNC_IDENTITY,
    MAPPING_READ,
  ]);
});

test("a remote ACTIVE product found by deterministic handle cannot be overwritten", async () => {
  const graphql = provider({ product: { ...product(), status: "ACTIVE" } });
  await expect(
    syncClosedTestMonthlyPass({ passId }, { graphql }),
  ).rejects.toThrow("non-DRAFT product");
  expect(graphql.mock.calls.map(([query]) => query)).toEqual([
    TEST_SYNC_IDENTITY,
    TEST_SYNC_HANDLE_READ,
  ]);
});

test("an unknown create result makes one call, rolls back the local event, and a manual run reuses its handle", async () => {
  const graphql = provider({ productSetError: true });
  await expect(
    syncClosedTestMonthlyPass({ passId }, { graphql }),
  ).rejects.toThrow("unknown");
  expect(
    graphql.mock.calls.filter(([query]) => query === PRODUCT_SET),
  ).toHaveLength(1);
  expect(
    await db.outboxEvent.findFirst({ where: { aggregateId: passId } }),
  ).toMatchObject({ status: "PENDING", attempts: 0 });
  expect(
    await db.productMapping.findFirst({ where: { shopId } }),
  ).toMatchObject({ productGid: null });
  const recovered = provider({
    handleProduct: {
      ...product(),
      bookingOwner: undefined as unknown as { jsonValue: string },
    },
  });
  await syncClosedTestMonthlyPass({ passId }, { graphql: recovered });
  expect(
    recovered.mock.calls.find(([query]) => query === PRODUCT_SET)?.[1]
      .variables,
  ).toMatchObject({ identifier: { handle: "skyra-booking-" + passId } });
});

test("local flags changed during CLI authentication stop before product mutation", async () => {
  const original = provider();
  const graphql = vi.fn<GraphQL>(async (query, options) => {
    const response = await original(query, options);
    if (query === TEST_SYNC_IDENTITY)
      await db.passPlan.update({
        where: { id: passId },
        data: { standalonePurchaseEnabled: true },
      });
    return response;
  });
  await expect(
    syncClosedTestMonthlyPass({ passId }, { graphql }),
  ).rejects.toThrow("closed DRAFT");
  expect(graphql.mock.calls.map(([query]) => query)).toEqual([
    TEST_SYNC_IDENTITY,
  ]);
});

test("missing events and unapproved fields cannot invent a catalogue mutation", async () => {
  await db.outboxEvent.deleteMany({ where: { shopId } });
  const graphql = provider();
  await expect(
    syncClosedTestMonthlyPass({ passId }, { graphql }),
  ).rejects.toThrow("No pending");
  expect(graphql.mock.calls.some(([query]) => query === PRODUCT_SET)).toBe(
    false,
  );
  await expect(
    syncClosedTestMonthlyPass(
      { passId, shopDomain: "other.myshopify.com" },
      { graphql },
    ),
  ).rejects.toThrow();
});

test("CLI adapter executes only fixed Node/CLI targets with file arguments and no shell payload", async () => {
  const directory = resolve(filesRoot, randomUUID());
  const assertedClosed = vi.fn(async () => {});
  execMock.mockImplementation((_file, args, _options, callback) => {
    const outputFile = args[args.indexOf("--output-file") + 1];
    void fs
      .writeFile(outputFile, JSON.stringify(identity()))
      .then(() => callback(null, "Done", ""));
    return {};
  });
  const graphql = createTestCliGraphql(directory, assertedClosed);
  const variables = { literalText: "`$(Write-Output injected)` & exit" };
  const response = await graphql(TEST_SYNC_IDENTITY, { variables, tries: 5 });
  expect(await response.json()).toEqual({ data: identity() });
  const [binary, args, settings] = execMock.mock.calls[0];
  expect(binary).toBe(process.execPath);
  expect(args[0]).toBe(TEST_CLI_ENTRY);
  expect(args).toContain(TEST_APP_DIRECTORY);
  expect(args).toContain(domain);
  expect(args).not.toContain("--query");
  expect(args).not.toContain("--variables");
  expect(
    args.some((argument: string) => argument.includes("Write-Output")),
  ).toBe(false);
  expect(settings).toMatchObject({
    shell: false,
    windowsHide: true,
    timeout: 30000,
  });
  expect(
    JSON.parse(
      await fs.readFile(resolve(directory, "01.variables.json"), "utf8"),
    ),
  ).toEqual(variables);
  expect(assertedClosed).toHaveBeenCalledOnce();
  expect(execMock).toHaveBeenCalledOnce();
});

test("a CLI timeout or missing response is retained as UNKNOWN and never automatically retried", async () => {
  const directory = resolve(filesRoot, randomUUID());
  execMock.mockImplementation((_file, _args, _options, callback) => {
    callback(new Error("Timeout"), "", "Timed out");
    return {};
  });
  const graphql = createTestCliGraphql(directory, async () => {});
  await expect(
    graphql(PRODUCT_SET, {
      variables: { input: { status: "DRAFT" } },
      tries: 4,
    }),
  ).rejects.toThrow("No automatic retry");
  expect(execMock).toHaveBeenCalledOnce();
  expect(
    JSON.parse(
      await fs.readFile(resolve(directory, "01.failure.json"), "utf8"),
    ),
  ).toMatchObject({ outcome: "UNKNOWN_OR_REJECTED", automaticRetry: false });
});

test("the CLI adapter forbids publish mutations and ACTIVE product writes", async () => {
  const graphql = createTestCliGraphql(
    resolve(filesRoot, randomUUID()),
    async () => {},
  );
  await expect(
    graphql("mutation { publishablePublish { userErrors { message } } }", {
      variables: {},
    }),
  ).rejects.toThrow("Only the closed");
  await expect(
    graphql(PRODUCT_SET, { variables: { input: { status: "ACTIVE" } } }),
  ).rejects.toThrow("cannot create or activate");
  expect(execMock).not.toHaveBeenCalled();
});

test("CLI result normalization preserves top-level GraphQL errors and fails closed on incomplete output", () => {
  expect(normalizeTestCliOutput({ data: identity() }, "shop")).toEqual({
    data: identity(),
  });
  expect(normalizeTestCliOutput(identity(), "shop")).toEqual({
    data: identity(),
  });
  const errors = { errors: [{ message: "Denied" }] };
  expect(normalizeTestCliOutput(errors, "shop")).toBe(errors);
  expect(() => normalizeTestCliOutput({}, "shop")).toThrow("incomplete");
  expect(() => normalizeTestCliOutput("text", "shop")).toThrow("unrecognized");
});
