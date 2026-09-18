import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload.current as string[];
  if (session) {
    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: current.toString(),
      },
    });
  }
  if (!current.includes("read_customers")) {
    const studio = await db.shop.findUnique({ where: { domain: shop } });
    if (studio)
      await db.customerProfile.updateMany({
        where: { shopId: studio.id },
        data: { shopifyName: "", email: null, contactSyncedAt: null },
      });
  }
  return new Response();
};
