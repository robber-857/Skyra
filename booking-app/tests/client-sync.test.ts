import { beforeEach, expect, test, vi } from "vitest";

const storage = vi.hoisted(() => ({
  shop: { findFirst: vi.fn() },
  customerProfile: { upsert: vi.fn() },
  $transaction: vi.fn(async (writes: Promise<unknown>[]) =>
    Promise.all(writes),
  ),
}));
vi.mock("../app/db.server", () => ({ default: storage }));
import {
  addAdminClient,
  importShopifyClients,
} from "../app/services/client-contacts.server";

const actor = { role: "ADMIN" as const, shopId: "test-shop", actorId: "admin" };
const newClient = {
  firstName: "Mandy",
  lastName: "Wu",
  email: "mandy@example.com",
};
const customer = {
  id: "gid://shopify/Customer/123",
  firstName: "Mandy",
  lastName: "Wu",
  defaultEmailAddress: { emailAddress: "mandy@example.com" },
};

test("adding an existing Shopify email links the customer without creating or overwriting profile content", async () => {
  storage.customerProfile.upsert.mockResolvedValue({ id: "local-client" });
  const graphql = vi.fn(async () =>
    Response.json({
      data: {
        customers: { nodes: [customer], pageInfo: { hasNextPage: false } },
      },
    }),
  );
  expect(
    await addAdminClient(actor, graphql, {
      ...newClient,
      email: " MANDY@example.com ",
    }),
  ).toEqual({ id: "local-client" });
  expect(graphql).toHaveBeenCalledTimes(1);
  const write = storage.customerProfile.upsert.mock.calls[0][0];
  expect(write.where.shopId_shopifyCustomerGid).toEqual({
    shopId: actor.shopId,
    shopifyCustomerGid: customer.id,
  });
  expect(write.update).not.toHaveProperty("preferredName");
  expect(write.update).not.toHaveProperty("trainingGoals");
});

test("adding a new client validates input, creates Shopify identity and surfaces mutation errors", async () => {
  const graphql = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: { customers: { nodes: [], pageInfo: { hasNextPage: false } } },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ data: { customerCreate: { customer, userErrors: [] } } }),
    );
  await addAdminClient(actor, graphql, newClient);
  expect(graphql.mock.calls[1][1].variables.input).toEqual(newClient);
  await expect(
    addAdminClient(actor, graphql, { ...newClient, email: "invalid" }),
  ).rejects.toThrow();
  await expect(
    addAdminClient({ ...actor, role: "COACH" }, graphql, newClient),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const rejected = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: { customers: { nodes: [], pageInfo: { hasNextPage: false } } },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: {
          customerCreate: {
            customer: null,
            userErrors: [{ message: "Email has already been taken" }],
          },
        },
      }),
    );
  await expect(
    addAdminClient(actor, rejected, newClient),
  ).rejects.toMatchObject({ code: "CLIENT_CREATE_FAILED" });
  expect(storage.customerProfile.upsert).toHaveBeenCalledTimes(1);
});
beforeEach(() => {
  vi.clearAllMocks();
  storage.shop.findFirst.mockResolvedValue({ id: actor.shopId });
  storage.customerProfile.upsert.mockResolvedValue({});
});

test("205 customers are imported across three pages, stopping at the final cursor", async () => {
  const graphql = vi.fn(
    async (
      _query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      const offset = Number(options?.variables?.after || 0);
      const count = Math.min(100, 205 - offset);
      return Response.json({
        data: {
          customers: {
            nodes: Array.from({ length: count }, (_, i) => ({
              id: `gid://shopify/Customer/${offset + i + 1}`,
              firstName: "Test",
              lastName: "Client",
              defaultEmailAddress: null,
            })),
            pageInfo: {
              hasNextPage: offset + count < 205,
              endCursor: String(offset + count),
            },
          },
        },
      });
    },
  );
  let after: string | null = null,
    total = 0;
  do {
    const batch = await importShopifyClients(
      actor,
      graphql,
      after ? { after } : {},
    );
    total += batch.synced;
    after = batch.nextCursor;
  } while (after);
  expect(total).toBe(205);
  expect(graphql.mock.calls.map((call) => call[1]?.variables?.after)).toEqual([
    null,
    "100",
    "200",
  ]);
  expect(storage.customerProfile.upsert).toHaveBeenCalledTimes(205);
  expect(
    storage.customerProfile.upsert.mock.calls[0][0].where
      .shopId_shopifyCustomerGid.shopId,
  ).toBe(actor.shopId);
});

test("API failures and stalled cursors never write a partial batch", async () => {
  for (const graphql of [
    async () => {
      throw new Error("network failure");
    },
    async () =>
      Response.json({
        data: {
          customers: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "100" },
          },
        },
      }),
  ]) {
    await expect(
      importShopifyClients(actor, graphql, { after: "100" }),
    ).rejects.toMatchObject({ code: "CUSTOMER_DATA_UNAVAILABLE" });
  }
  expect(storage.customerProfile.upsert).not.toHaveBeenCalled();
});

test("empty stores finish and coaches cannot initiate a sync", async () => {
  const graphql = vi.fn(async () =>
    Response.json({
      data: {
        customers: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
  );
  expect(await importShopifyClients(actor, graphql, {})).toMatchObject({
    synced: 0,
    nextCursor: null,
  });
  await expect(
    importShopifyClients({ ...actor, role: "COACH" }, graphql, {}),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(graphql).toHaveBeenCalledTimes(1);
});
