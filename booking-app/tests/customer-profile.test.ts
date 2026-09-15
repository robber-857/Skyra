import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import {
  customerProfileData,
  updateCustomerProfile,
} from "../app/services/customer-profile.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});

afterAll(() => db.$disconnect());

async function fixture() {
  const shop = await db.shop.create({
    data: { domain: crypto.randomUUID() + ".myshopify.com" },
  });
  return {
    shop,
    actor: {
      shopId: shop.id,
      customerGid: "gid://shopify/Customer/123",
    },
  };
}

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6l9sAAAAASUVORK5CYII=";

test("customer profile is private, customer-scoped and round-trips a safe avatar", async () => {
  const f = await fixture();
  expect(await customerProfileData(f.actor)).toEqual({
    preferredName: "",
    avatarDataUrl: null,
    signature: "",
    trainingGoals: "",
  });
  const saved = await updateCustomerProfile(f.actor, {
    preferredName: "  Queenie  ",
    avatarDataUrl: tinyPng,
    signature: "  Stronger every week.  ",
    trainingGoals: "  Build shoulder strength and confidence.  ",
  });
  expect(saved).toEqual({
    preferredName: "Queenie",
    avatarDataUrl: tinyPng,
    signature: "Stronger every week.",
    trainingGoals: "Build shoulder strength and confidence.",
  });
  expect(JSON.stringify(saved)).not.toContain(f.actor.customerGid);
  expect(
    await customerProfileData({
      ...f.actor,
      customerGid: "gid://shopify/Customer/999",
    }),
  ).toEqual({
    preferredName: "",
    avatarDataUrl: null,
    signature: "",
    trainingGoals: "",
  });
});

test("customer can remove an avatar without changing Shopify identity", async () => {
  const f = await fixture();
  await updateCustomerProfile(f.actor, {
    preferredName: "Skyra member",
    avatarDataUrl: tinyPng,
    signature: "",
    trainingGoals: "",
  });
  const saved = await updateCustomerProfile(f.actor, {
    preferredName: "Skyra member",
    avatarDataUrl: null,
    signature: "",
    trainingGoals: "",
  });
  expect(saved.avatarDataUrl).toBeNull();
  expect(
    await db.customerProfile.findUniqueOrThrow({
      where: {
        shopId_shopifyCustomerGid: {
          shopId: f.shop.id,
          shopifyCustomerGid: f.actor.customerGid,
        },
      },
    }),
  ).toMatchObject({ avatarBytes: null, avatarMimeType: null });
});

test("profile rejects unsafe files, oversized avatars and untrusted text", async () => {
  const f = await fixture();
  const validText = {
    preferredName: "",
    signature: "",
    trainingGoals: "",
  };
  await expect(
    updateCustomerProfile(f.actor, {
      ...validText,
      avatarDataUrl:
        "data:image/png;base64," +
        Buffer.from("<svg onload=alert(1)>").toString("base64"),
    }),
  ).rejects.toMatchObject({ code: "INVALID_AVATAR" });
  await expect(
    updateCustomerProfile(f.actor, {
      ...validText,
      avatarDataUrl:
        "data:image/png;base64," + Buffer.alloc(524289).toString("base64"),
    }),
  ).rejects.toMatchObject({ code: "INVALID_AVATAR" });
  await expect(
    updateCustomerProfile(f.actor, {
      ...validText,
      preferredName: "Bad\u0000name",
      avatarDataUrl: null,
    }),
  ).rejects.toThrow();
  await expect(
    customerProfileData({ ...f.actor, customerGid: null }),
  ).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
});
