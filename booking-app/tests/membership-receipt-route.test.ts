import { beforeEach, expect, test, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
const fixture = vi.hoisted(() => ({ role: "ADMIN", find: vi.fn() }));
vi.mock("../app/services/context.server", () => ({
  adminContext: async () => ({
    actor: { shopId: "shop-one", role: fixture.role },
  }),
}));
vi.mock("../app/db.server", () => ({
  default: { membershipReceipt: { findFirst: fixture.find } },
}));
import { loader } from "../app/routes/app.memberships.receipts.$id";
const id = "11111111-1111-4111-8111-111111111111";
const open = (receiptId = id) =>
  loader({
    request: new Request(
      `https://app.example/app/memberships/receipts/${receiptId}`,
    ),
    url: new URL(`https://app.example/app/memberships/receipts/${receiptId}`),
    pattern: "/app/memberships/receipts/:id",
    params: { id: receiptId },
    context: {},
  } as LoaderFunctionArgs);
beforeEach(() => {
  vi.clearAllMocks();
  fixture.role = "ADMIN";
  fixture.find.mockResolvedValue({
    id,
    passName: "Original monthly pass",
    cycle: 2,
    priceCents: 29900,
    currency: "AUD",
    credits: 12,
    validityMonths: 1,
    validityDays: 30,
    sourceOrderGid: "gid://shopify/Order/3",
    sourceLineItemGid: "gid://shopify/LineItem/4",
    issuedAt: new Date("2026-10-03T02:00:00Z"),
    paidAt: null,
    termsVersion: "test-v1",
    snapshotHash: "retained-hash",
  });
});
test("retained receipt exports original price and period without inventing a tax invoice or provider paid timestamp", async () => {
  const response = await open();
  const text = await response.text();
  expect(text).toContain("Amount: AUD 299.00");
  expect(text).toContain("Period: 2");
  expect(text).toContain("Original monthly pass");
  expect(text).toContain("not a tax invoice");
  expect(text).not.toContain("Verified payment timestamp:");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Content-Disposition")).toContain(id + ".txt");
  expect(fixture.find).toHaveBeenCalledWith({
    where: { id, shopId: "shop-one" },
  });
});
test("receipt cannot expose another shop's data", async () => {
  fixture.find.mockResolvedValue(null);
  await expect(open()).rejects.toMatchObject({ status: 404 });
});

test("legacy non-monthly one-time receipt retains first-booking activation wording", async () => {
  const original = await fixture.find();
  fixture.find.mockResolvedValue({
    ...original,
    mode: "ONCE",
    validityMonths: 2,
  });
  const response = await open();
  const text = await response.text();
  expect(text).toContain("Pass validity begins at the first booked class.");
  expect(text).not.toContain("staff-confirmed attendance");
});
test("coaches cannot export customer payment records", async () => {
  fixture.role = "COACH";
  await expect(open()).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(fixture.find).not.toHaveBeenCalled();
});
test("invalid receipt identifiers are rejected before any lookup", async () => {
  await expect(open("not-a-uuid")).rejects.toMatchObject({ status: 404 });
  expect(fixture.find).not.toHaveBeenCalled();
});
