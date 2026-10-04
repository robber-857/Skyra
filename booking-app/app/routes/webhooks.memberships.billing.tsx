import { createHash } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = () => new Response(null, { status: 405 });
export async function action({ request }: ActionFunctionArgs) {
  const rawBody = await request.clone().text();
  const { shop, payload, topic, webhookId } = await authenticate.webhook(request);
  if (!["SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS", "SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE", "SUBSCRIPTION_BILLING_ATTEMPTS_CHALLENGED"].includes(String(topic))) return new Response(null, { status: 400 });
  const numericId = String(payload.id || "");
  const attemptGid = payload.admin_graphql_api_id || (/^[1-9]\d*$/.test(numericId) ? `gid://shopify/SubscriptionBillingAttempt/${numericId}` : "");
  if (!/^gid:\/\/shopify\/SubscriptionBillingAttempt\/[1-9]\d*$/.test(attemptGid)) return new Response(null, { status: 400 });
  const installed = await db.shop.findUnique({ where: { domain: shop } });
  if (!installed) return new Response(null, { status: 503 });
  const hash = createHash("sha256").update(rawBody).digest("hex");
  await db.$transaction(async (tx) => {
    const receipt = await tx.webhookReceipt.upsert({ where: { shopId_webhookId: { shopId: installed.id, webhookId } }, create: { shopId: installed.id, webhookId, topic: String(topic), payloadHash: hash, status: "QUEUED" }, update: {} });
    if (receipt.payloadHash !== hash) throw new Error("Conflicting subscription webhook");
    await tx.outboxEvent.upsert({ where: { shopId_kind_aggregateId_version: { shopId: installed.id, kind: "MEMBERSHIP_BILLING_RECEIVED", aggregateId: receipt.id, version: 1 } }, create: { shopId: installed.id, kind: "MEMBERSHIP_BILLING_RECEIVED", aggregateId: receipt.id, version: 1, payload: { attemptGid } }, update: {} });
  });
  return new Response(null, { status: 200 });
}
