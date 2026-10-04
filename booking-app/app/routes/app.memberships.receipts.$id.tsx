import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import db from "../db.server";
import { adminContext } from "../services/context.server";
import { requireOperations } from "../services/authorization";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  requireOperations(actor);
  const id = z.uuid().safeParse(params.id);
  if (!id.success) throw new Response("Not found", { status: 404 });
  const receipt = await db.membershipReceipt.findFirst({
    where: { id: id.data, shopId: actor.shopId },
  });
  if (!receipt) throw new Response("Not found", { status: 404 });
  const text = [
    "SKYRA Membership payment receipt",
    `Receipt reference: ${receipt.id}`,
    `Pass: ${receipt.passName}`,
    `Period: ${receipt.cycle}`,
    `Amount: ${receipt.currency} ${(receipt.priceCents / 100).toFixed(2)}`,
    `Classes: ${receipt.credits}`,
    `Validity: ${receipt.validityMonths ? `${receipt.validityMonths} calendar month(s)` : `${receipt.validityDays} days`}`,
    receipt.mode === "AUTO_RENEW" || receipt.validityMonths === 1
      ? "Monthly membership validity begins at that period's first staff-confirmed attendance."
      : "Pass validity begins at the first booked class.",
    `Shopify order: ${receipt.sourceOrderGid}`,
    `Shopify line: ${receipt.sourceLineItemGid}`,
    `Payment record confirmed and receipt retained at: ${receipt.issuedAt.toISOString()}`,
    ...(receipt.paidAt
      ? [`Verified payment timestamp: ${receipt.paidAt.toISOString()}`]
      : []),
    `Terms version: ${receipt.termsVersion}`,
    `Snapshot hash: ${receipt.snapshotHash}`,
    "This is a retained payment receipt. It is not a tax invoice; the Shopify order and store invoice are the authoritative financial documents.",
  ].join("\n");
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="skyra-payment-receipt-${receipt.id}.txt"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
