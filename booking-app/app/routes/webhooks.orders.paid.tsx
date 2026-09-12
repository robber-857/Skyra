import type { ActionFunctionArgs } from "react-router";
import { log } from "../lib/log.server";
import { receiveOrderPaidWebhook } from "../services/order-paid-webhook.server";
import { authenticate } from "../shopify.server";

function isOrdersPaid(topic: string) {
  return topic.toLowerCase().replaceAll("_", "/") === "orders/paid";
}

export async function action({ request }: ActionFunctionArgs) {
  const rawBody = await request.clone().text();
  const { payload, shop, topic, webhookId } =
    await authenticate.webhook(request);
  const normalizedTopic = String(topic);
  if (!isOrdersPaid(normalizedTopic))
    return new Response(null, { status: 400 });
  const result = await receiveOrderPaidWebhook({
    shopDomain: shop,
    webhookId,
    topic: "orders/paid",
    rawBody,
    payload,
  });
  if (result.status === "CONFLICT")
    log.warn({ receiptId: result.receiptId }, "Webhook delivery ID conflict");
  return new Response(null, { status: 200 });
}

export const loader = () => new Response(null, { status: 405 });
