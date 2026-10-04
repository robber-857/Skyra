import { expect, test, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

vi.mock("../app/services/context.server", () => ({
  adminContext: async () => ({
    actor: { shopId: "shop-one" },
    shop: { domain: "dev.myshopify.com" },
  }),
}));
vi.mock("../app/services/catalog.server", () => ({
  catalogData: async () => ({
    services: [{ id: "class-one" }],
    passes: [{ id: "pass-one" }],
    mappings: [],
  }),
  retrySync: vi.fn(),
  savePass: vi.fn(),
  saveService: vi.fn(),
}));
vi.mock("../app/shopify.server", () => ({ unauthenticated: {} }));
vi.mock("../app/services/storefront-access.server", () => ({
  authenticatedStorefrontClient: vi.fn(),
}));
vi.mock("../app/services/shopify-purchasability.server", () => ({
  checkCatalogPurchase: vi.fn(),
}));
import { loader } from "../app/routes/app.catalog";

const open = (query: string) =>
  loader({
    request: new Request("https://app.example/app/catalog" + query),
    params: {},
    context: {},
  } as LoaderFunctionArgs);

test("Membership edit link opens the requested shop Pass rather than a class", async () => {
  expect(await open("?tab=pass&edit=pass-one&from=memberships")).toMatchObject({
    initialTab: "pass",
    editId: "pass-one",
    openEditor: true,
    fromMemberships: true,
  });
});
test("Membership create link opens a blank Pass editor", async () => {
  expect(await open("?tab=pass&new=1&from=memberships")).toMatchObject({
    initialTab: "pass",
    editId: null,
    openEditor: true,
  });
});
test("Unrecognized Pass IDs cannot open another shop record or a class", async () => {
  for (const id of ["other-shop-pass", "class-one"]) {
    expect(await open("?tab=pass&edit=" + id)).toMatchObject({
      editId: null,
      openEditor: false,
    });
  }
});
test("Existing class editor links remain compatible", async () => {
  expect(await open("?edit=class-one")).toMatchObject({
    initialTab: "service",
    editId: "class-one",
    openEditor: true,
    fromMemberships: false,
  });
});
