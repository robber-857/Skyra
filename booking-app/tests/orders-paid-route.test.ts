import { beforeEach, expect, test, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  receive: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { webhook: mocks.auth },
}));
vi.mock("../app/services/order-paid-webhook.server", () => ({
  receiveOrderPaidWebhook: mocks.receive,
}));
vi.mock("../app/lib/log.server", () => ({
  log: { warn: mocks.warn },
}));

import { action, loader } from "../app/routes/webhooks.orders.paid";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({
    payload: { id: 1 },
    shop: "dev.myshopify.com",
    topic: "ORDERS_PAID",
    webhookId: "delivery-1",
  });
  mocks.receive.mockResolvedValue({
    status: "QUEUED",
    receiptId: "receipt-1",
    duplicate: false,
  });
});

function post() {
  const request = new Request("https://app.example/webhooks/orders/paid", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"id":1}',
  });
  return action({ request } as ActionFunctionArgs);
}

test("authenticated orders paid delivery is handed to the durable receiver", async () => {
  const response = await post();
  expect(response.status).toBe(200);
  expect(mocks.receive).toHaveBeenCalledWith({
    shopDomain: "dev.myshopify.com",
    webhookId: "delivery-1",
    topic: "orders/paid",
    rawBody: '{"id":1}',
    payload: { id: 1 },
  });
});

test("Shopify authentication failure is not acknowledged", async () => {
  const denied = new Response(null, { status: 401 });
  mocks.auth.mockRejectedValue(denied);
  await expect(post()).rejects.toBe(denied);
  expect(mocks.receive).not.toHaveBeenCalled();
});

test("wrong topic and GET are rejected without intake", async () => {
  mocks.auth.mockResolvedValue({
    payload: {},
    shop: "dev.myshopify.com",
    topic: "ORDERS_CREATE",
    webhookId: "delivery-2",
  });
  expect((await post()).status).toBe(400);
  expect(mocks.receive).not.toHaveBeenCalled();
  expect(loader().status).toBe(405);
});

test("delivery ID conflict is acknowledged and logged without payload", async () => {
  mocks.receive.mockResolvedValue({
    status: "CONFLICT",
    receiptId: "receipt-1",
    duplicate: true,
  });
  expect((await post()).status).toBe(200);
  expect(mocks.warn).toHaveBeenCalledWith(
    { receiptId: "receipt-1" },
    "Webhook delivery ID conflict",
  );
});
