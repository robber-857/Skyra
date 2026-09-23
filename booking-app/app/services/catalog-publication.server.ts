import type { GraphQL } from "./shopify-catalog.server";

export const ONLINE_STORE_PUBLICATIONS = `#graphql
query BookingOnlineStorePublications($after: String) {
  publications(first: 50, after: $after, catalogType: APP) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const PUBLISH_ONLINE_STORE = `#graphql
mutation BookingPublishOnlineStore($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { userErrors { field message } }
}`;
export const ONLINE_STORE_PUBLICATION_READ = `#graphql
query BookingOnlineStorePublication($id: ID!, $publicationId: ID!) {
  product(id: $id) { id status publishedAt publishedOnPublication(publicationId: $publicationId) }
}`;

export class CatalogPublicationError extends Error {}

async function read(
  graphql: GraphQL,
  query: string,
  variables: Record<string, unknown>,
) {
  try {
    const response = await graphql(query, { variables });
    const json = await response.json();
    if (!response.ok || json.errors?.length || !json.data)
      throw new Error("Publication request failed");
    if (json.data.publishablePublish?.userErrors?.length)
      throw new Error("Publication rejected");
    return json.data;
  } catch {
    throw new CatalogPublicationError(
      "Online Store publication failed. Approve Skyra Booking's publication permissions in Shopify, then retry sync. If access is already approved, check the product's Publishing settings.",
    );
  }
}

// Resolve the current shop's channel; never reuse another shop's publication ID.
export async function publishCatalogProduct(
  graphql: GraphQL,
  productId: string,
) {
  let after: string | null = null;
  const seen = new Set<string>();
  const matches: string[] = [];
  do {
    const data = await read(graphql, ONLINE_STORE_PUBLICATIONS, { after });
    const publications = data.publications;
    if (!Array.isArray(publications?.nodes) || !publications.pageInfo)
      throw new CatalogPublicationError(
        "Could not read sales channels. Retry sync.",
      );
    for (const channel of publications.nodes)
      if (channel.name === "Online Store") matches.push(channel.id);
    if (!publications.pageInfo.hasNextPage) break;
    const cursor = publications.pageInfo.endCursor;
    if (!cursor || seen.has(cursor))
      throw new CatalogPublicationError(
        "Could not read all sales channels. Retry sync.",
      );
    seen.add(cursor);
    after = cursor;
  } while (after);
  if (matches.length !== 1)
    throw new CatalogPublicationError(
      "Could not identify the Online Store sales channel. Check Shopify sales channels, then retry sync.",
    );
  const publicationId = matches[0];
  await read(graphql, PUBLISH_ONLINE_STORE, {
    id: productId,
    input: [{ publicationId }],
  });
  const { product } = await read(graphql, ONLINE_STORE_PUBLICATION_READ, {
    id: productId,
    publicationId,
  });
  if (
    product?.id !== productId ||
    product.status !== "ACTIVE" ||
    product.publishedOnPublication !== true ||
    !product.publishedAt ||
    !Number.isFinite(Date.parse(product.publishedAt)) ||
    Date.parse(product.publishedAt) > Date.now()
  )
    throw new CatalogPublicationError(
      "Shopify has not confirmed Online Store publication yet. Retry sync.",
    );
}
