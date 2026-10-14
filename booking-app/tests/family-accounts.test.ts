import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import {
  addAdminFamilyMember,
  addCustomerFamilyMember,
  familyAccountData,
  familyEmailAlias,
  resolveFamilyActor,
} from "../app/services/family-accounts.server";
import {
  adminClientDetail,
  adminClients,
} from "../app/services/admin-clients.server";
import {
  importShopifyClients,
  refreshClientContacts,
  updateAdminClient,
} from "../app/services/client-contacts.server";
import { resolveShopifyCustomerEmail } from "../app/services/customer-notification-email.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import { grantCashCredits } from "../app/services/manual-credits.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());

type Contact = {
  id: string;
  firstName: string;
  lastName: string;
  defaultEmailAddress: { emailAddress: string };
  defaultPhoneNumber: { phoneNumber: string } | null;
  tags: string[];
};
async function fixture() {
  const shop = await db.shop.create({
    data: { domain: `family-${randomUUID()}.myshopify.com` },
  });
  const parentNode: Contact = {
    id: "gid://shopify/Customer/900",
    firstName: "Parent",
    lastName: "Chen",
    defaultEmailAddress: { emailAddress: "parent@example.com" },
    defaultPhoneNumber: null,
    tags: [],
  };
  const parent = await db.customerProfile.create({
    data: {
      shopId: shop.id,
      shopifyCustomerGid: parentNode.id,
      shopifyName: "Parent Chen",
      email: parentNode.defaultEmailAddress.emailAddress,
    },
  });
  const nodes = new Map([[parentNode.id, parentNode]]);
  let nextGid = 901,
    uncertainCreate = false;
  const graphql = vi.fn(
    async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      const variables = options?.variables || {};
      if (query.includes("customerCreate(")) {
        const input = variables.input as {
          firstName: string;
          lastName: string;
          email: string;
          tags: string[];
          phone?: string;
        };
        const child: Contact = {
          id: `gid://shopify/Customer/${nextGid++}`,
          firstName: input.firstName,
          lastName: input.lastName,
          defaultEmailAddress: { emailAddress: input.email },
          defaultPhoneNumber: input.phone ? { phoneNumber: input.phone } : null,
          tags: input.tags,
        };
        nodes.set(child.id, child);
        if (uncertainCreate) {
          uncertainCreate = false;
          throw new Error("Provider reply lost after creation");
        }
        return Response.json({
          data: { customerCreate: { customer: child, userErrors: [] } },
        });
      }
      if (query.includes("customerUpdate(")) {
        const input = variables.input as {
          id: string;
          firstName: string;
          lastName: string;
          email: string;
          phone?: string;
        };
        const child = {
          ...nodes.get(input.id)!,
          firstName: input.firstName,
          lastName: input.lastName,
          defaultEmailAddress: { emailAddress: input.email },
          defaultPhoneNumber: input.phone ? { phoneNumber: input.phone } : null,
        };
        nodes.set(child.id, child);
        return Response.json({
          data: { customerUpdate: { customer: child, userErrors: [] } },
        });
      }
      if (query.includes("ClientImport"))
        return Response.json({
          data: {
            customers: {
              nodes: [...nodes.values()],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      if (query.includes("ClientContacts"))
        return Response.json({
          data: {
            nodes: (variables.ids as string[]).map(
              (id) => nodes.get(id) || null,
            ),
          },
        });
      if (query.includes("customers(first:")) {
        const email = (variables.query as string).slice(7, -1);
        return Response.json({
          data: {
            customers: {
              nodes: [...nodes.values()].filter(
                (node) => node.defaultEmailAddress.emailAddress === email,
              ),
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      return Response.json({
        data: { customer: nodes.get(variables.id as string) || null },
      });
    },
  );
  return {
    shop,
    parent,
    parentNode,
    nodes,
    graphql,
    actor: { shopId: shop.id, customerGid: parent.shopifyCustomerGid },
    admin: { shopId: shop.id, actorId: "admin", role: "ADMIN" as const },
    loseCreateReply: () => {
      uncertainCreate = true;
    },
  };
}
const memberInput = (prefix: string) => ({
  firstName: prefix,
  lastName: "Chen",
  emailPrefix: prefix,
  idempotencyKey: randomUUID(),
});
const creations = (graphql: ReturnType<typeof vi.fn>) =>
  graphql.mock.calls.filter(([query]) => query.includes("customerCreate("));

test("first-time signed accounts get a local root profile and current contact details", async () => {
  const f = await fixture();
  await db.customerProfile.delete({ where: { id: f.parent.id } });
  const data = await familyAccountData(f.actor, f.graphql);
  expect(data.account).toMatchObject({
    name: "Parent Chen",
    email: "parent@example.com",
  });
  expect(data.canAddMembers).toBe(true);
  expect(data.members).toEqual([{ ...data.account, relationship: "SELF" }]);
  await expect(
    familyAccountData({ ...f.actor, customerGid: null }),
  ).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
});

test("two children are separate clients with explicit family links and independent Admin data", async () => {
  const f = await fixture();
  const first = await addCustomerFamilyMember(
    f.actor,
    f.graphql,
    memberInput("child1"),
  );
  const second = await addAdminFamilyMember(
    f.admin,
    f.graphql,
    f.parent.id,
    memberInput("child2"),
  );
  const children = await db.customerProfile.findMany({
    where: { shopId: f.shop.id, familyParentId: f.parent.id },
  });
  expect(children.map((child) => child.email).sort()).toEqual([
    "parent+child1@example.com",
    "parent+child2@example.com",
  ]);
  expect(new Set(children.map((child) => child.shopifyCustomerGid)).size).toBe(
    2,
  );
  const data = await familyAccountData(f.actor);
  expect(data.members.map((member) => member.id)).toEqual([
    f.parent.id,
    first.id,
    second.id,
  ]);
  const detail = await adminClientDetail(f.admin, first.id);
  expect(detail.family.parent).toEqual({
    id: f.parent.id,
    name: "Parent Chen",
    email: "parent@example.com",
  });
  expect(detail.family.members.map((member) => member.id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(detail.passes).toEqual([]);
  const directory = await adminClients(f.admin, {});
  expect(
    directory.clients.find((client) => client.id === first.id),
  ).toMatchObject({
    familyParentId: f.parent.id,
    familyParentName: "Parent Chen",
  });
});

test("selection is explicit, tenant scoped and gives child logins access only to themselves", async () => {
  const f = await fixture(),
    foreign = await fixture();
  const child = await addCustomerFamilyMember(
    f.actor,
    f.graphql,
    memberInput("child1"),
  );
  const childProfile = await db.customerProfile.findUniqueOrThrow({
    where: { id: child.id },
  });
  expect(await resolveFamilyActor(f.actor, child.id)).toMatchObject({
    customerGid: childProfile.shopifyCustomerGid,
    accountCustomerGid: f.parent.shopifyCustomerGid,
  });
  await expect(
    resolveFamilyActor(f.actor, foreign.parent.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const unrelated = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/999",
      email: "parent+unrelated@example.com",
    },
  });
  await expect(resolveFamilyActor(f.actor, unrelated.id)).rejects.toMatchObject(
    { code: "FORBIDDEN" },
  );
  const childActor = {
    ...f.actor,
    customerGid: childProfile.shopifyCustomerGid,
  };
  expect((await familyAccountData(childActor)).members).toHaveLength(1);
  expect((await familyAccountData(childActor)).canAddMembers).toBe(false);
  expect(await resolveFamilyActor(childActor, child.id)).toMatchObject({
    customerGid: childProfile.shopifyCustomerGid,
  });
  await expect(
    resolveFamilyActor(childActor, f.parent.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    addCustomerFamilyMember(childActor, f.graphql, memberInput("nested")),
  ).rejects.toMatchObject({ code: "FAMILY_PARENT_REQUIRED" });
  await expect(
    addAdminFamilyMember(f.admin, f.graphql, child.id, memberInput("nested")),
  ).rejects.toMatchObject({ code: "FAMILY_PARENT_REQUIRED" });
  await expect(
    addAdminFamilyMember(
      f.admin,
      f.graphql,
      foreign.parent.id,
      memberInput("foreign"),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    addAdminFamilyMember(
      { ...f.admin, role: "COACH" },
      f.graphql,
      f.parent.id,
      memberInput("nope"),
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    db.customerProfile.create({
      data: {
        shopId: f.shop.id,
        shopifyCustomerGid: "gid://shopify/Customer/998",
        familyParentId: foreign.parent.id,
      },
    }),
  ).rejects.toThrow();
});

test("family aliases cannot claim existing Shopify customers and retries preserve provenance", async () => {
  const f = await fixture();
  f.nodes.set("gid://shopify/Customer/950", {
    ...f.parentNode,
    id: "gid://shopify/Customer/950",
    defaultEmailAddress: { emailAddress: "parent+existing@example.com" },
  });
  await expect(
    addCustomerFamilyMember(f.actor, f.graphql, memberInput("existing")),
  ).rejects.toMatchObject({ code: "FAMILY_EMAIL_IN_USE" });
  expect(creations(f.graphql)).toHaveLength(0);
  expect(await db.customerProfile.count({ where: { shopId: f.shop.id } })).toBe(
    1,
  );
  const raw = memberInput("retry");
  f.loseCreateReply();
  await expect(
    addCustomerFamilyMember(f.actor, f.graphql, raw),
  ).rejects.toMatchObject({ code: "FAMILY_PROVIDER_UNAVAILABLE" });
  const saved = await addCustomerFamilyMember(f.actor, f.graphql, raw);
  expect(await addCustomerFamilyMember(f.actor, f.graphql, raw)).toEqual(saved);
  expect(creations(f.graphql)).toHaveLength(1);
  await expect(
    addCustomerFamilyMember(f.actor, f.graphql, {
      ...raw,
      firstName: "Different",
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    addCustomerFamilyMember(f.actor, f.graphql, memberInput("retry")),
  ).rejects.toMatchObject({ code: "FAMILY_EMAIL_IN_USE" });
});

test("concurrent retries create at most one provider identity and one linked child", async () => {
  const f = await fixture(),
    raw = memberInput("same");
  const results = await Promise.allSettled([
    addCustomerFamilyMember(f.actor, f.graphql, raw),
    addCustomerFamilyMember(f.actor, f.graphql, raw),
  ]);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect(creations(f.graphql)).toHaveLength(1);
  expect(
    await db.customerProfile.count({
      where: { shopId: f.shop.id, familyParentId: f.parent.id },
    }),
  ).toBe(1);
});

test("Shopify sync preserves child identity, family link and local content", async () => {
  const f = await fixture();
  const child = await addCustomerFamilyMember(
    f.actor,
    f.graphql,
    memberInput("sync"),
  );
  await db.customerProfile.update({
    where: { id: child.id },
    data: {
      preferredName: "Kid",
      trainingGoals: "Aerial",
      contactSyncedAt: null,
    },
  });
  await importShopifyClients(f.admin, f.graphql, {});
  await db.customerProfile.update({
    where: { id: child.id },
    data: { contactSyncedAt: null },
  });
  await refreshClientContacts(f.admin, f.graphql, [child.id]);
  expect(
    await db.customerProfile.findUnique({ where: { id: child.id } }),
  ).toMatchObject({
    familyParentId: f.parent.id,
    preferredName: "Kid",
    trainingGoals: "Aerial",
    email: "parent+sync@example.com",
  });
});

test("Admin child edits stay independent and notification email follows the parent's current Shopify contact", async () => {
  const f = await fixture();
  const first = await addCustomerFamilyMember(
    f.actor,
    f.graphql,
    memberInput("edit"),
  );
  const second = await addCustomerFamilyMember(
    f.actor,
    f.graphql,
    memberInput("sibling"),
  );
  const profile = await db.customerProfile.findUniqueOrThrow({
    where: { id: first.id },
  });
  const edits = {
    firstName: "New",
    lastName: "Kid",
    email: profile.email!,
    phone: "",
    preferredName: "Nickname",
  };
  await updateAdminClient(f.admin, f.graphql, first.id, edits);
  expect((await adminClientDetail(f.admin, first.id)).client.name).toBe(
    "Nickname",
  );
  expect((await adminClientDetail(f.admin, second.id)).client.name).toBe(
    "sibling Chen",
  );
  await expect(
    updateAdminClient(f.admin, f.graphql, first.id, {
      ...edits,
      email: "different@example.com",
    }),
  ).rejects.toMatchObject({ code: "FAMILY_EMAIL_LOCKED" });
  f.parentNode.defaultEmailAddress.emailAddress = "new-parent@example.com";
  expect(
    await resolveShopifyCustomerEmail(
      f.graphql,
      profile.shopifyCustomerGid,
      f.shop.id,
    ),
  ).toBe("new-parent@example.com");
  expect(f.graphql.mock.lastCall?.[1]?.variables?.id).toBe(
    f.parent.shopifyCustomerGid,
  );
  expect(
    (await db.customerProfile.findUniqueOrThrow({ where: { id: first.id } }))
      .email,
  ).toBe("parent+edit@example.com");
});

test("parent and sibling Pass and booking balances remain owned by their individual client", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const admin = { shopId: f.shop.id, actorId: "admin", role: "ADMIN" as const };
  const children = await Promise.all(
    [1, 2].map((index) =>
      db.customerProfile.create({
        data: {
          shopId: f.shop.id,
          shopifyCustomerGid: `gid://shopify/Customer/${990 + index}`,
          shopifyName: `Child ${index}`,
          email: `parent+child${index}@example.com`,
          familyParentId: f.customer.id,
        },
      }),
    ),
  );
  await grantCashCredits(admin, {
    customerId: children[0].id,
    target: `PASS_PLAN:${f.plan.id}`,
    units: 7,
    validityDays: 30,
    amount: "100",
    reason: "Independent child Pass test",
    idempotencyKey: randomUUID(),
  });
  const parent = await adminClientDetail(admin, f.customer.id),
    first = await adminClientDetail(admin, children[0].id),
    second = await adminClientDetail(admin, children[1].id);
  expect(parent.passes).toHaveLength(1);
  expect(parent.bookingCount).toBe(1);
  expect(first.passes[0]).toMatchObject({ remaining: 7 });
  expect(first.bookingCount).toBe(0);
  expect(second.passes).toEqual([]);
  expect(second.bookingCount).toBe(0);
});

test("aliases preserve existing parent plus-addresses and reject an oversized localpart", () => {
  expect(familyEmailAlias("Parent+home@example.com", "child1")).toBe(
    "parent+home+child1@example.com",
  );
  expect(() =>
    familyEmailAlias(`${"a".repeat(60)}@example.com`, "child1"),
  ).toThrow("shorter");
});
