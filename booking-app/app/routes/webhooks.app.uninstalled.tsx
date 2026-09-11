import { createHash } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
export const action = async ({ request }: ActionFunctionArgs) => {
  const raw = await request.clone().text();
  const {
    shop: domain,
    topic,
    webhookId,
  } = await authenticate.webhook(request);
  await db.$transaction(async (tx) => {
    const shop = await tx.shop.findUnique({ where: { domain } });
    await tx.session.deleteMany({ where: { shop: domain } });
    if (shop) {
      await tx.shop.update({
        where: { id: shop.id },
        data: { status: "UNINSTALLED" },
      });
      await tx.webhookReceipt.upsert({
        where: { shopId_webhookId: { shopId: shop.id, webhookId } },
        create: {
          shopId: shop.id,
          webhookId,
          topic,
          payloadHash: createHash("sha256").update(raw).digest("hex"),
          status: "PROCESSED",
        },
        update: {},
      });
    }
  });
  return new Response(null, { status: 200 });
};
