import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { BOOKING_REFERENCE_KEY } from "./shopify-cart.server";

const shopifyGid = (type: "Order" | "LineItem" | "Customer") =>
  z.string().regex(new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`));
const numericId = z.union([
  z.number().int().positive().safe(),
  z.string().regex(/^[1-9]\d*$/),
]);
const property = z.object({ name: z.string(), value: z.string().nullable() });
const lineItem = z.object({
  admin_graphql_api_id: shopifyGid("LineItem"),
  product_id: numericId,
  variant_id: numericId,
  quantity: z.number().int().positive(),
  price: z.string(),
  properties: z.array(property).default([]),
});
const orderPaid = z.object({
  admin_graphql_api_id: shopifyGid("Order"),
  cancelled_at: z.string().nullable().optional(),
  currency: z.string(),
  current_subtotal_price: z.string(),
  current_total_price: z.string(),
  financial_status: z.string(),
  processed_at: z.string().optional(),
  customer: z
    .object({ admin_graphql_api_id: shopifyGid("Customer") })
    .nullable(),
  line_items: z.array(lineItem),
});

type NormalizedLine = {
  lineItemGid: string;
  productGid: string;
  variantGid: string;
  quantity: number;
  priceCents: number;
  reference: string;
};

type NormalizedOrder = {
  orderGid: string;
  purchasedAt: string | null;
  customerGid: string | null;
  currency: string;
  finalCents: number;
  subtotalCents: number;
  financialStatus: string;
  cancelled: boolean;
  lineCount: number;
  bookingLines: NormalizedLine[];
};

function cents(value: string) {
  if (!/^\d+\.\d{2}$/.test(value)) return null;
  const parsed = Number(value.replace(".", ""));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function resourceGid(type: "Product" | "ProductVariant", id: string | number) {
  return `gid://shopify/${type}/${String(id)}`;
}

export function normalizeOrderPaidPayload(
  payload: unknown,
):
  | { ok: true; order: NormalizedOrder }
  | { ok: false; code: "PAYLOAD_INVALID" } {
  const parsed = orderPaid.safeParse(payload);
  if (!parsed.success) return { ok: false, code: "PAYLOAD_INVALID" };
  const finalCents = cents(parsed.data.current_total_price);
  const subtotalCents = cents(parsed.data.current_subtotal_price);
  if (finalCents === null || subtotalCents === null)
    return { ok: false, code: "PAYLOAD_INVALID" };
  const bookingLines: NormalizedLine[] = [];
  for (const line of parsed.data.line_items) {
    const references = line.properties.filter(
      (item) => item.name === BOOKING_REFERENCE_KEY && item.value,
    );
    if (!references.length) continue;
    const priceCents = cents(line.price);
    if (references.length !== 1 || priceCents === null)
      return { ok: false, code: "PAYLOAD_INVALID" };
    bookingLines.push({
      lineItemGid: line.admin_graphql_api_id,
      productGid: resourceGid("Product", line.product_id),
      variantGid: resourceGid("ProductVariant", line.variant_id),
      quantity: line.quantity,
      priceCents,
      reference: references[0].value!,
    });
  }
  return {
    ok: true,
    order: {
      orderGid: parsed.data.admin_graphql_api_id,
      purchasedAt: parsed.data.processed_at || null,
      customerGid: parsed.data.customer?.admin_graphql_api_id || null,
      currency: parsed.data.currency,
      finalCents,
      subtotalCents,
      financialStatus: parsed.data.financial_status.toLowerCase(),
      cancelled: Boolean(parsed.data.cancelled_at),
      lineCount: parsed.data.line_items.length,
      bookingLines,
    },
  };
}

function payloadHash(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function duplicateResult(
  receipt: { id: string; topic: string; payloadHash: string; status: string },
  topic: string,
  hash: string,
) {
  if (receipt.topic !== topic || receipt.payloadHash !== hash)
    return {
      status: "CONFLICT" as const,
      receiptId: receipt.id,
      duplicate: true,
    };
  return {
    status: receipt.status,
    receiptId: receipt.id,
    duplicate: true,
  };
}

function validationCodes(
  order: NormalizedOrder,
  line: NormalizedLine,
  checkout: {
    status: string;
    productGid: string;
    variantGid: string;
    priceCents: number;
    hold: { customer: { shopifyCustomerGid: string } };
  } | null,
) {
  const codes: string[] = [];
  if (!checkout) codes.push("CHECKOUT_NOT_FOUND");
  if (checkout && checkout.status !== "READY") codes.push("CHECKOUT_NOT_READY");
  if (
    !order.customerGid ||
    order.customerGid !== checkout?.hold.customer.shopifyCustomerGid
  )
    codes.push("CUSTOMER_MISMATCH");
  if (line.productGid !== checkout?.productGid) codes.push("PRODUCT_MISMATCH");
  if (line.variantGid !== checkout?.variantGid) codes.push("VARIANT_MISMATCH");
  if (order.lineCount !== 1 || line.quantity !== 1)
    codes.push("QUANTITY_MISMATCH");
  if (order.currency !== "AUD") codes.push("CURRENCY_MISMATCH");
  if (
    line.priceCents !== checkout?.priceCents ||
    order.subtotalCents !== checkout?.priceCents ||
    order.finalCents !== checkout?.priceCents
  )
    codes.push("AMOUNT_MISMATCH");
  if (order.financialStatus !== "paid") codes.push("NOT_PAID");
  if (order.cancelled) codes.push("ORDER_CANCELLED");
  return [...new Set(codes)];
}

export async function receiveOrderPaidWebhook(input: {
  shopDomain: string;
  webhookId: string;
  topic: string;
  rawBody: string;
  payload: unknown;
}) {
  const hash = payloadHash(input.rawBody);
  const shop = await db.shop.findUnique({
    where: { domain: input.shopDomain },
  });
  if (!shop)
    throw new DomainError(
      "SHOP_NOT_FOUND",
      "Webhook shop is not installed.",
      503,
    );
  const prior = await db.webhookReceipt.findUnique({
    where: {
      shopId_webhookId: { shopId: shop.id, webhookId: input.webhookId },
    },
  });
  if (prior) return duplicateResult(prior, input.topic, hash);
  const normalized = normalizeOrderPaidPayload(input.payload);
  try {
    return await db.$transaction(async (tx) => {
      const receipt = await tx.webhookReceipt.create({
        data: {
          shopId: shop.id,
          webhookId: input.webhookId,
          topic: input.topic,
          payloadHash: hash,
        },
      });
      if (!normalized.ok) {
        await tx.webhookReceipt.update({
          where: { id: receipt.id },
          data: { status: "NEEDS_ATTENTION" },
        });
        await tx.outboxEvent.create({
          data: {
            shopId: shop.id,
            kind: "ORDER_PAID_REVIEW",
            aggregateId: receipt.id,
            version: 1,
            payload: { receiptId: receipt.id, codes: [normalized.code] },
          },
        });
        return {
          status: "NEEDS_ATTENTION",
          receiptId: receipt.id,
          duplicate: false,
        };
      }
      const { order } = normalized;
      if (!order.bookingLines.length) {
        await tx.webhookReceipt.update({
          where: { id: receipt.id },
          data: { status: "PROCESSED" },
        });
        return {
          status: "IGNORED",
          receiptId: receipt.id,
          duplicate: false,
        };
      }
      if (order.bookingLines.length !== 1) {
        await tx.webhookReceipt.update({
          where: { id: receipt.id },
          data: { status: "NEEDS_ATTENTION" },
        });
        await tx.outboxEvent.create({
          data: {
            shopId: shop.id,
            kind: "ORDER_PAID_REVIEW",
            aggregateId: receipt.id,
            version: 1,
            payload: {
              receiptId: receipt.id,
              orderGid: order.orderGid,
              codes: ["MULTIPLE_BOOKING_LINES"],
            },
          },
        });
        return {
          status: "NEEDS_ATTENTION",
          receiptId: receipt.id,
          duplicate: false,
        };
      }
      const line = order.bookingLines[0];
      const checkout = await tx.bookingCheckout.findFirst({
        where: { shopId: shop.id, reference: line.reference },
        include: { hold: { include: { customer: true } } },
      });
      const codes = validationCodes(order, line, checkout);
      const valid = codes.length === 0;
      await tx.webhookReceipt.update({
        where: { id: receipt.id },
        data: { status: valid ? "QUEUED" : "NEEDS_ATTENTION" },
      });
      await tx.outboxEvent.create({
        data: {
          shopId: shop.id,
          kind: valid ? "ORDER_PAID_RECEIVED" : "ORDER_PAID_REVIEW",
          aggregateId: receipt.id,
          version: 1,
          payload: {
            receiptId: receipt.id,
            orderGid: order.orderGid,
            lineItemGid: line.lineItemGid,
            purchasedAt: order.purchasedAt,
            checkoutId: checkout?.id || null,
            codes,
          },
        },
      });
      return {
        status: valid ? "QUEUED" : "NEEDS_ATTENTION",
        receiptId: receipt.id,
        duplicate: false,
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await db.webhookReceipt.findUniqueOrThrow({
        where: {
          shopId_webhookId: {
            shopId: shop.id,
            webhookId: input.webhookId,
          },
        },
      });
      return duplicateResult(raced, input.topic, hash);
    }
    throw error;
  }
}
