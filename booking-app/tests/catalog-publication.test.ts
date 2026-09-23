import { expect, test, vi } from "vitest";
import {
  publishCatalogProduct,
  ONLINE_STORE_PUBLICATIONS,
  PUBLISH_ONLINE_STORE,
  ONLINE_STORE_PUBLICATION_READ,
} from "../app/services/catalog-publication.server";

const id = "gid://shopify/Product/111";
const publicationId = "gid://shopify/Publication/222";
const ready = {
  id,
  status: "ACTIVE",
  publishedAt: "2026-01-01T00:00:00Z",
  publishedOnPublication: true,
};
const reply = (data: unknown) => Response.json({ data });

test("finds Online Store on a later page, publishes only there, and reads back", async () => {
  const graphql = vi
    .fn()
    .mockResolvedValueOnce(
      reply({
        publications: {
          nodes: [{ id: "pos", name: "Point of Sale" }],
          pageInfo: { hasNextPage: true, endCursor: "page2" },
        },
      }),
    )
    .mockResolvedValueOnce(
      reply({
        publications: {
          nodes: [
            { id: publicationId, name: "Online Store" },
            { id: "shop", name: "Shop" },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    )
    .mockResolvedValueOnce(reply({ publishablePublish: { userErrors: [] } }))
    .mockResolvedValueOnce(reply({ product: ready }));
  await publishCatalogProduct(graphql, id);
  expect(graphql.mock.calls).toEqual([
    [ONLINE_STORE_PUBLICATIONS, { variables: { after: null } }],
    [ONLINE_STORE_PUBLICATIONS, { variables: { after: "page2" } }],
    [PUBLISH_ONLINE_STORE, { variables: { id, input: [{ publicationId }] } }],
    [ONLINE_STORE_PUBLICATION_READ, { variables: { id, publicationId } }],
  ]);
});

test.each(
  [
    [],
    [{ id: "pos", name: "Point of Sale" }],
    [
      { id: "one", name: "Online Store" },
      { id: "two", name: "Online Store" },
    ],
  ].map((nodes) => ({ nodes })),
)("never guesses a missing or ambiguous sales channel", async ({ nodes }) => {
  const graphql = vi.fn().mockResolvedValue(
    reply({
      publications: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
  );
  await expect(publishCatalogProduct(graphql, id)).rejects.toThrow(
    "identify the Online Store",
  );
  expect(graphql).toHaveBeenCalledTimes(1);
});

test.each([
  { ...ready, status: "DRAFT" },
  { ...ready, publishedOnPublication: false },
  { ...ready, publishedAt: null },
  { ...ready, publishedAt: "2099-01-01T00:00:00Z" },
  { ...ready, id: "another-product" },
])(
  "requires immediate publication of the exact active product",
  async (product) => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        reply({
          publications: {
            nodes: [{ id: publicationId, name: "Online Store" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      )
      .mockResolvedValueOnce(reply({ publishablePublish: { userErrors: [] } }))
      .mockResolvedValueOnce(reply({ product }));
    await expect(publishCatalogProduct(graphql, id)).rejects.toThrow(
      "not confirmed",
    );
  },
);

test("missing permission returns an actionable, sanitized sync failure", async () => {
  const graphql = vi
    .fn()
    .mockResolvedValue(
      Response.json({ errors: [{ message: "Access denied" }] }),
    );
  await expect(publishCatalogProduct(graphql, id)).rejects.toThrow(
    "publication permissions",
  );
});

test("a Shopify publish rejection prevents a successful read-back", async () => {
  const graphql = vi
    .fn()
    .mockResolvedValueOnce(
      reply({
        publications: {
          nodes: [{ id: publicationId, name: "Online Store" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    )
    .mockResolvedValueOnce(
      reply({ publishablePublish: { userErrors: [{ message: "Rejected" }] } }),
    );
  await expect(publishCatalogProduct(graphql, id)).rejects.toThrow(
    "publication failed",
  );
  expect(graphql).toHaveBeenCalledTimes(2);
});
