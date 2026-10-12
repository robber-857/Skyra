import { beforeEach, expect, test, vi } from "vitest";

const storage = vi.hoisted(() => ({
  shop: { findFirst: vi.fn() },
  customerProfile: { upsert: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(async (writes: Promise<unknown>[]) =>
    Promise.all(writes),
  ),
}));
vi.mock("../app/db.server", () => ({ default: storage }));
import {
  addAdminClient,
  adminClientEdit,
  updateAdminClient,
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
  defaultPhoneNumber: null,
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
              defaultPhoneNumber: null,
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

const withPhone = {
  ...customer,
  defaultPhoneNumber: { phoneNumber: "+61412345678" },
};
const lookup = (nodes: unknown[]) =>
  Response.json({
    data: { customers: { nodes, pageInfo: { hasNextPage: false } } },
  });

test("new client phone is normalized, sent to Shopify and cached from its response", async () => {
  const graphql = vi
    .fn()
    .mockResolvedValueOnce(lookup([]))
    .mockResolvedValueOnce(
      Response.json({
        data: { customerCreate: { customer: withPhone, userErrors: [] } },
      }),
    );
  await addAdminClient(actor, graphql, {
    ...newClient,
    phone: " +61 412-345-678 ",
  });
  expect(graphql.mock.calls[1][1].variables.input.phone).toBe("+61412345678");
  const write = storage.customerProfile.upsert.mock.calls[0][0];
  expect(write.create.phone).toBe("+61412345678");
  expect(write.update.phone).toBe("+61412345678");
});

test("existing client phone is updated without recreating the customer", async () => {
  const graphql = vi
    .fn()
    .mockResolvedValueOnce(lookup([customer]))
    .mockResolvedValueOnce(
      Response.json({
        data: { customerUpdate: { customer: withPhone, userErrors: [] } },
      }),
    );
  await addAdminClient(actor, graphql, { ...newClient, phone: "+61412345678" });
  expect(graphql.mock.calls[1][0]).toContain("customerUpdate");
  expect(graphql.mock.calls[1][1].variables.input).toEqual({
    id: customer.id,
    phone: "+61412345678",
  });
  expect(storage.customerProfile.upsert.mock.calls[0][0].update.phone).toBe(
    "+61412345678",
  );
});

test.each(["", "+61 412 345 678"])(
  "blank or unchanged phone preserves the existing number (%s)",
  async (phone) => {
    const graphql = vi.fn().mockResolvedValueOnce(lookup([withPhone]));
    await addAdminClient(actor, graphql, { ...newClient, phone });
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(storage.customerProfile.upsert.mock.calls[0][0].update.phone).toBe(
      "+61412345678",
    );
  },
);

test("invalid phone is rejected before any Shopify request", async () => {
  const graphql = vi.fn();
  await expect(
    addAdminClient(actor, graphql, { ...newClient, phone: "abc" }),
  ).rejects.toThrow("country code");
  expect(graphql).not.toHaveBeenCalled();
  expect(storage.customerProfile.upsert).not.toHaveBeenCalled();
});

test("Shopify rejects a duplicate phone without overwriting the local contact", async () => {
  const graphql = vi
    .fn()
    .mockResolvedValueOnce(lookup([customer]))
    .mockResolvedValueOnce(
      Response.json({
        data: {
          customerUpdate: {
            customer: null,
            userErrors: [{ message: "Phone has already been taken" }],
          },
        },
      }),
    );
  await expect(
    addAdminClient(actor, graphql, { ...newClient, phone: "+61412345678" }),
  ).rejects.toThrow("Phone has already been taken");
  expect(storage.customerProfile.upsert).not.toHaveBeenCalled();
});

test("sync imports phone numbers and clears a number removed in Shopify", async () => {
  for (const node of [withPhone, customer]) {
    const graphql = vi.fn().mockResolvedValueOnce(
      Response.json({
        data: {
          customers: {
            nodes: [node],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    await importShopifyClients(actor, graphql, {});
    expect(storage.customerProfile.upsert.mock.lastCall?.[0].update.phone).toBe(
      node.defaultPhoneNumber?.phoneNumber || null,
    );
  }
});

const profileId = "10000000-0000-4000-8000-000000000001";
const edits = { ...newClient, phone: "+61 412 345 678", preferredName: "M" };
const storedProfile = {
  id: profileId,
  shopifyCustomerGid: customer.id,
  preferredName: "M",
};

test("edit loads separate Shopify names and the local preferred name", async () => {
  storage.customerProfile.findFirst.mockResolvedValue(storedProfile);
  const graphql = vi
    .fn()
    .mockResolvedValue(Response.json({ data: { nodes: [withPhone] } }));
  expect(await adminClientEdit(actor, graphql, profileId)).toEqual({
    id: profileId,
    ...newClient,
    phone: "+61412345678",
    preferredName: "M",
  });
  expect(storage.customerProfile.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { shopId: actor.shopId, id: profileId } }),
  );
});

test("edit saves to the existing Shopify identity then updates the scoped local profile", async () => {
  storage.customerProfile.findFirst.mockResolvedValue(storedProfile);
  storage.customerProfile.updateMany.mockResolvedValue({ count: 1 });
  const graphql = vi
    .fn()
    .mockResolvedValue(
      Response.json({
        data: { customerUpdate: { customer: withPhone, userErrors: [] } },
      }),
    );
  await updateAdminClient(actor, graphql, profileId, edits);
  expect(graphql.mock.calls[0][1].variables.input).toEqual({
    ...newClient,
    id: customer.id,
    phone: "+61412345678",
  });
  expect(storage.customerProfile.updateMany).toHaveBeenCalledWith({
    where: {
      shopId: actor.shopId,
      id: profileId,
      shopifyCustomerGid: customer.id,
    },
    data: expect.objectContaining({
      phone: "+61412345678",
      preferredName: "M",
    }),
  });
  expect(storage.customerProfile.upsert).not.toHaveBeenCalled();
});

test("editing can explicitly remove a phone number", async () => {
  storage.customerProfile.findFirst.mockResolvedValue(storedProfile);
  storage.customerProfile.updateMany.mockResolvedValue({ count: 1 });
  const graphql = vi
    .fn()
    .mockResolvedValue(
      Response.json({ data: { customerUpdate: { customer, userErrors: [] } } }),
    );
  await updateAdminClient(actor, graphql, profileId, { ...edits, phone: "" });
  expect(graphql.mock.calls[0][1].variables.input.phone).toBeNull();
  expect(
    storage.customerProfile.updateMany.mock.calls[0][0].data.phone,
  ).toBeNull();
});

test("edit rejects other shops and coaches before accessing Shopify", async () => {
  storage.customerProfile.findFirst.mockResolvedValue(null);
  const graphql = vi.fn();
  await expect(
    updateAdminClient(actor, graphql, profileId, edits),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    adminClientEdit(actor, graphql, profileId),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    updateAdminClient({ ...actor, role: "COACH" }, graphql, profileId, edits),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(graphql).not.toHaveBeenCalled();
});

test("edit surfaces Shopify errors without changing the local profile", async () => {
  storage.customerProfile.findFirst.mockResolvedValue(storedProfile);
  const graphql = vi
    .fn()
    .mockResolvedValue(
      Response.json({
        data: {
          customerUpdate: {
            customer: null,
            userErrors: [{ message: "Email has already been taken" }],
          },
        },
      }),
    );
  await expect(
    updateAdminClient(actor, graphql, profileId, edits),
  ).rejects.toThrow("Email has already been taken");
  expect(storage.customerProfile.updateMany).not.toHaveBeenCalled();
});

test("edit validates fields and reports partial save failure", async () => {
  storage.customerProfile.findFirst.mockResolvedValue(storedProfile);
  const graphql = vi
    .fn()
    .mockResolvedValue(
      Response.json({
        data: { customerUpdate: { customer: withPhone, userErrors: [] } },
      }),
    );
  await expect(
    updateAdminClient(actor, graphql, profileId, {
      ...edits,
      email: "invalid",
    }),
  ).rejects.toThrow();
  expect(graphql).not.toHaveBeenCalled();
  storage.customerProfile.updateMany.mockRejectedValueOnce(
    new Error("db unavailable"),
  );
  await expect(
    updateAdminClient(actor, graphql, profileId, edits),
  ).rejects.toMatchObject({ code: "CLIENT_SAVE_FAILED" });
});
