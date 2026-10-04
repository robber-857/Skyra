import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { MembershipCheckoutAuthorization } from "./membership-checkout-authorization.server";
import { DomainError } from "../lib/errors.server";
import type { GraphQL } from "./shopify-catalog.server";
import { priceInCents } from "./purchase-mapping.server";
import {
  CART_CREATE,
  CART_READ,
  BOOKING_REFERENCE_KEY,
  assertBookingCart,
  type BookingCart,
} from "./shopify-cart.server";

// The caller persists a purchase claim before invoking this adapter. Cart IDs
// and payment authentication URLs are secrets: never log or expose raw results.
export const PASS_PURCHASE_REFERENCE_KEY = "_skyra_pass_purchase_ref";
export type MembershipCartTarget = {
  reference: string;
  productGid: string;
  variantGid: string;
  priceCents: number;
  sellingPlanGid?: string | null;
  bookingReference?: string | null;
  authorization?: MembershipCheckoutAuthorization;
};

export const MEMBERSHIP_CART_CREATE = CART_CREATE.replace(
  "cart { id checkoutUrl",
  'cart { authorization: metafield(namespace: "$app", key: "membership_checkout") { value } id checkoutUrl',
);
export const MEMBERSHIP_CART_READ = CART_READ.replace(
  "{ id checkoutUrl",
  '{ authorization: metafield(namespace: "$app", key: "membership_checkout") { value } id checkoutUrl',
);

const money = z.object({ amount: z.string(), currencyCode: z.string() });
const cartSchema = z.object({
  authorization: z
    .object({ value: z.string() })
    .transform(({ value }) => {
      try {
        return { jsonValue: JSON.parse(value) as unknown };
      } catch {
        return { jsonValue: undefined };
      }
    })
    .nullable()
    .optional(),
  id: z.string(),
  checkoutUrl: z.string(),
  totalQuantity: z.number().int(),
  buyerIdentity: z.object({ countryCode: z.string().nullable() }),
  lines: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        quantity: z.number().int(),
        attributes: z.array(z.object({ key: z.string(), value: z.string() })),
        merchandise: z.object({
          id: z.string(),
          product: z.object({ id: z.string() }),
        }),
        sellingPlanAllocation: z
          .object({ sellingPlan: z.object({ id: z.string() }) })
          .nullable(),
        cost: z.object({ amountPerQuantity: money }),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
const userErrors = z.array(
  z.object({ code: z.string().nullable().optional(), message: z.string() }),
);

function unknownResult(kind: "read" | "cart" | "mutation") {
  return new DomainError(
    kind === "cart"
      ? "CART_REQUEST_UNKNOWN"
      : kind === "mutation"
        ? "MEMBERSHIP_REQUEST_UNKNOWN"
        : "UNAVAILABLE",
    kind === "read"
      ? "We could not verify the membership with Shopify. Please try again."
      : "Shopify has not confirmed this request. Do not start another payment while we check it.",
    503,
  );
}

async function request(
  client: GraphQL,
  query: string,
  variables: Record<string, unknown>,
  kind: "read" | "cart" | "mutation",
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        // Never let SDK retries create a second cart or a new payment attempt.
        const response = await client(query, {
          variables,
          tries: 1,
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok || payload.errors?.length || !payload.data)
          throw unknownResult(kind);
        return payload.data as Record<string, unknown>;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(unknownResult(kind));
        }, 6000);
      }),
    ]);
  } catch {
    // Upstream exception text can contain tokens, full cart IDs and customer data.
    throw unknownResult(kind);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function attributes(target: MembershipCartTarget) {
  return [
    { key: PASS_PURCHASE_REFERENCE_KEY, value: target.reference },
    ...(target.bookingReference
      ? [{ key: BOOKING_REFERENCE_KEY, value: target.bookingReference }]
      : []),
  ];
}

export function assertMembershipCart(
  cart: BookingCart & { authorization?: { jsonValue: unknown } | null },
  target: MembershipCartTarget,
  domain: string,
) {
  const line = cart.lines.nodes[0];
  const expected = attributes(target);
  if (
    (target.authorization &&
      !isDeepStrictEqual(
        cart.authorization?.jsonValue,
        target.authorization,
      )) ||
    !line ||
    (line.sellingPlanAllocation?.sellingPlan.id ?? null) !==
      (target.sellingPlanGid ?? null) ||
    line.attributes.length !== expected.length ||
    expected.some(
      (attribute) =>
        line.attributes.filter(
          (a) => a.key === attribute.key && a.value === attribute.value,
        ).length !== 1,
    )
  ) {
    throw new DomainError(
      "CART_CHANGED",
      "This membership cart changed. Please contact the studio before paying.",
      409,
    );
  }
  // Reuse all existing quantity, merchandise, amount, currency, AU buyer and
  // allowlisted checkout-host checks after validating membership-only fields.
  return assertBookingCart(
    {
      ...cart,
      lines: {
        ...cart.lines,
        nodes: cart.lines.nodes.map((item, index) =>
          index
            ? item
            : {
                ...item,
                sellingPlanAllocation: null,
                attributes: [
                  { key: BOOKING_REFERENCE_KEY, value: target.reference },
                ],
              },
        ),
      },
    },
    target,
    domain,
  );
}

export async function createMembershipCart(
  client: GraphQL,
  target: MembershipCartTarget,
  domain: string,
) {
  const data = await request(
    client,
    target.authorization ? MEMBERSHIP_CART_CREATE : CART_CREATE,
    {
      input: {
        // A customer GID is not a customerAccessToken. Payment ownership must be
        // checked against the signed-in purchase owner when the verified order arrives.
        buyerIdentity: { countryCode: "AU" },
        ...(target.authorization
          ? {
              metafields: [
                {
                  key: "membership_checkout",
                  type: "json",
                  value: JSON.stringify(target.authorization),
                },
              ],
            }
          : {}),
        lines: [
          {
            merchandiseId: target.variantGid,
            quantity: 1,
            attributes: attributes(target),
            ...(target.sellingPlanGid
              ? { sellingPlanId: target.sellingPlanGid }
              : {}),
          },
        ],
      },
    },
    "cart",
  );
  const parsed = z
    .object({
      cart: cartSchema.nullable(),
      userErrors,
      warnings: z.array(z.object({ message: z.string() })),
    })
    .safeParse(data.cartCreate);
  if (!parsed.success) throw unknownResult("cart");
  if (!parsed.data.cart) {
    if (parsed.data.userErrors.length)
      throw new DomainError(
        "CART_REJECTED",
        "Shopify did not accept this membership cart.",
        409,
      );
    throw unknownResult("cart");
  }
  try {
    assertMembershipCart(parsed.data.cart, target, domain);
  } catch {
    // A cart was created even if its contents are unexpected. Losing its result
    // must not authorize a second cart; keep the original purchase unresolved.
    throw unknownResult("cart");
  }
  return {
    cart: parsed.data.cart,
    clean: !parsed.data.userErrors.length && !parsed.data.warnings.length,
  };
}

export async function readMembershipCart(
  client: GraphQL,
  id: string,
  target: MembershipCartTarget,
  domain: string,
) {
  const data = await request(
    client,
    target.authorization ? MEMBERSHIP_CART_READ : CART_READ,
    { id },
    "read",
  );
  const parsed = cartSchema.safeParse(data.cart);
  if (!parsed.success || parsed.data.id !== id)
    throw new DomainError(
      "CART_CHANGED",
      "This membership cart is unavailable. Please contact the studio before paying.",
      409,
    );
  assertMembershipCart(parsed.data, target, domain);
  return parsed.data;
}

export const MEMBERSHIP_CONTRACT_READ = `#graphql
query SkyraMembershipContract($id: ID!) {
  currentAppInstallation { app { id } }
  subscriptionContract(id: $id) {
    id status nextBillingDate currencyCode
    app { id }
    customer { id }
    originOrder { id }
    customerPaymentMethod { id revokedAt }
    deliveryPrice { amount currencyCode }
    billingPolicy { interval intervalCount }
    discounts(first: 10) { nodes { id ... on SubscriptionManualDiscount { recurringCycleLimit usageCount } } pageInfo { hasNextPage } }
    lines(first: 2) {
      nodes {
        id productId variantId quantity sellingPlanId requiresShipping
        currentPrice { amount currencyCode }
        lineDiscountedPrice { amount currencyCode }
        pricingPolicy {
          basePrice { amount currencyCode }
          cycleDiscounts { afterCycle computedPrice { amount currencyCode } }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

const gid = (kind: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${kind}/[^/?#]+$`));
const contractSchema = z.object({
  id: gid("SubscriptionContract"),
  status: z.string(),
  nextBillingDate: z.string().nullable(),
  currencyCode: z.string(),
  app: z.object({ id: gid("App") }).nullable(),
  customer: z.object({ id: gid("Customer") }).nullable(),
  originOrder: z.object({ id: gid("Order") }).nullable(),
  customerPaymentMethod: z
    .object({
      id: gid("CustomerPaymentMethod"),
      revokedAt: z.string().nullable(),
    })
    .nullable(),
  deliveryPrice: money,
  billingPolicy: z.object({
    interval: z.string(),
    intervalCount: z.number().int(),
  }),
  discounts: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        recurringCycleLimit: z.number().int().nullable().optional(),
        usageCount: z.number().int().nonnegative().optional(),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
  lines: z.object({
    nodes: z.array(
      z.object({
        id: gid("SubscriptionLine"),
        productId: gid("Product").nullable(),
        variantId: gid("ProductVariant").nullable(),
        quantity: z.number().int(),
        sellingPlanId: gid("SellingPlan").nullable(),
        requiresShipping: z.boolean(),
        currentPrice: money,
        lineDiscountedPrice: money,
        pricingPolicy: z
          .object({
            basePrice: money,
            cycleDiscounts: z.array(
              z.object({
                afterCycle: z.number().int().nonnegative(),
                computedPrice: money,
              }),
            ),
          })
          .nullable(),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
export type MembershipContract = z.infer<typeof contractSchema>;

export const MEMBERSHIP_ORDER_READ = `#graphql
query SkyraMembershipOrder($id: ID!) {
  order(id: $id) {
    id displayFinancialStatus currencyCode cancelledAt test
    customer { id }
    totalReceivedSet { shopMoney { amount currencyCode } }
    totalRefundedSet { shopMoney { amount currencyCode } }
    totalPriceSet { shopMoney { amount currencyCode } }
    totalDiscountsSet { shopMoney { amount currencyCode } }
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    lineItems(first: 2) {
      nodes {
        id quantity currentQuantity requiresShipping
        product { id }
        variant { id }
        contract { id }
        sellingPlan { sellingPlanId }
        customAttributes { key value }
        originalUnitPriceSet { shopMoney { amount currencyCode } }
        discountedTotalSet(withCodeDiscounts: true) { shopMoney { amount currencyCode } }
      }
      pageInfo { hasNextPage }
    }
  }
}`;
const moneyBag = z.object({ shopMoney: money });
const membershipOrderSchema = z.object({
  id: gid("Order"),
  displayFinancialStatus: z.string(),
  currencyCode: z.string(),
  cancelledAt: z.string().nullable(),
  test: z.boolean(),
  customer: z.object({ id: gid("Customer") }).nullable(),
  totalReceivedSet: moneyBag,
  totalRefundedSet: moneyBag,
  totalPriceSet: moneyBag,
  totalDiscountsSet: moneyBag,
  totalShippingPriceSet: moneyBag,
  lineItems: z.object({
    nodes: z.array(
      z.object({
        id: gid("LineItem"),
        quantity: z.number().int(),
        currentQuantity: z.number().int(),
        requiresShipping: z.boolean(),
        product: z.object({ id: gid("Product") }).nullable(),
        variant: z.object({ id: gid("ProductVariant") }).nullable(),
        contract: z.object({ id: gid("SubscriptionContract") }).nullable(),
        sellingPlan: z
          .object({ sellingPlanId: gid("SellingPlan").nullable() })
          .nullable(),
        customAttributes: z.array(
          z.object({ key: z.string(), value: z.string() }),
        ),
        originalUnitPriceSet: moneyBag,
        discountedTotalSet: moneyBag,
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
export type VerifiedMembershipPayment = {
  paidPriceCents?: number;
  orderGid: string;
  lineItemGid: string;
  customerGid: string;
  productGid: string;
  variantGid: string;
  priceCents: number;
  currency: "AUD";
  quantity: 1;
  contractGid: string | null;
  sellingPlanGid: string | null;
};

export async function readMembershipOrder(
  client: GraphQL,
  orderGid: string,
): Promise<VerifiedMembershipPayment | null> {
  if (!gid("Order").safeParse(orderGid).success)
    throw new DomainError("INVALID_ORDER", "Invalid membership order.", 400);
  const data = await request(
    client,
    MEMBERSHIP_ORDER_READ,
    { id: orderGid },
    "read",
  );
  const parsed = membershipOrderSchema.safeParse(data.order);
  if (!parsed.success || parsed.data.id !== orderGid)
    throw unknownResult("read");
  const order = parsed.data;
  const line = order.lineItems.nodes[0];
  if (
    order.displayFinancialStatus !== "PAID" ||
    order.cancelledAt ||
    !order.customer ||
    order.currencyCode !== "AUD" ||
    order.lineItems.nodes.length !== 1 ||
    order.lineItems.pageInfo.hasNextPage ||
    !line ||
    line.quantity !== 1 ||
    line.currentQuantity !== 1 ||
    line.requiresShipping ||
    !line.product ||
    !line.variant
  )
    return null;
  const priceCents = priceInCents(line.originalUnitPriceSet.shopMoney.amount);
  const paidPriceCents = priceInCents(order.totalReceivedSet.shopMoney.amount);
  const discountCents = priceInCents(order.totalDiscountsSet.shopMoney.amount);
  const sameAmount = [
    order.totalReceivedSet,
    order.totalPriceSet,
    line.discountedTotalSet,
  ];
  const zeroAmount = [order.totalRefundedSet, order.totalShippingPriceSet];
  if (
    priceCents === null ||
    priceCents <= 0 ||
    paidPriceCents === null ||
    discountCents === null ||
    paidPriceCents + discountCents !== priceCents ||
    line.originalUnitPriceSet.shopMoney.currencyCode !== "AUD" ||
    order.totalDiscountsSet.shopMoney.currencyCode !== "AUD" ||
    sameAmount.some(
      (bag) =>
        bag.shopMoney.currencyCode !== "AUD" ||
        priceInCents(bag.shopMoney.amount) !== paidPriceCents,
    ) ||
    zeroAmount.some(
      (bag) =>
        bag.shopMoney.currencyCode !== "AUD" ||
        priceInCents(bag.shopMoney.amount) !== 0,
    )
  )
    return null;
  // Bind this verified order to the claimed billing attempt and customer in the
  // caller. Ignore inherited first-order attributes when choosing a renewal cycle.
  return {
    orderGid: order.id,
    lineItemGid: line.id,
    customerGid: order.customer.id,
    productGid: line.product.id,
    variantGid: line.variant.id,
    priceCents,
    paidPriceCents,
    currency: "AUD",
    quantity: 1,
    contractGid: line.contract?.id ?? null,
    sellingPlanGid: line.sellingPlan?.sellingPlanId ?? null,
  };
}

export async function readSubscriptionContract(
  client: GraphQL,
  contractGid: string,
): Promise<MembershipContract> {
  if (!gid("SubscriptionContract").safeParse(contractGid).success)
    throw new DomainError(
      "INVALID_CONTRACT",
      "Invalid membership contract.",
      400,
    );
  const data = await request(
    client,
    MEMBERSHIP_CONTRACT_READ,
    { id: contractGid },
    "read",
  );
  const parsed = z
    .object({
      currentAppInstallation: z.object({ app: z.object({ id: gid("App") }) }),
      subscriptionContract: contractSchema.nullable(),
    })
    .safeParse(data);
  if (!parsed.success) throw unknownResult("read");
  const contract = parsed.data.subscriptionContract;
  if (
    !contract ||
    contract.id !== contractGid ||
    contract.app?.id !== parsed.data.currentAppInstallation.app.id
  ) {
    throw new DomainError(
      "CONTRACT_NOT_OWNED",
      "This membership is not managed by Skyra Booking.",
      409,
    );
  }
  return contract;
}

export const MEMBERSHIP_BILLING_CYCLE_READ = `#graphql
query SkyraMembershipBillingCycle($contractId: ID!, $date: DateTime!) {
  subscriptionBillingCycle(billingCycleInput: { contractId: $contractId, selector: { date: $date } }) {
    cycleIndex cycleStartAt cycleEndAt billingAttemptExpectedDate status edited skipped
    sourceContract { id }
    editedContract { __typename }
    billingAttempts(first: 1) { nodes { id } pageInfo { hasNextPage } }
  }
}`;
const cycleSchema = z.object({
  cycleIndex: z.number().int().positive().safe(),
  cycleStartAt: z.string(),
  cycleEndAt: z.string(),
  billingAttemptExpectedDate: z.string(),
  status: z.enum(["BILLED", "UNBILLED"]),
  edited: z.boolean(),
  skipped: z.boolean(),
  sourceContract: z.object({ id: gid("SubscriptionContract") }),
  editedContract: z.object({ __typename: z.string().min(1) }).nullable(),
  billingAttempts: z.object({
    nodes: z.array(z.object({ id: gid("SubscriptionBillingAttempt") })),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
export type MembershipBillingCycleSelector = { index: number };
export type MembershipBillingContext = {
  contract: MembershipContract;
  nextBillingDate: Date;
  billingCycleSelector: MembershipBillingCycleSelector;
};
function unsafeBillingContext() {
  return new DomainError(
    "BILLING_CONTEXT_UNSAFE",
    "The Shopify renewal terms or billing cycle need review before charging.",
    409,
  );
}

// Apply only before the first submission. Existing attempts must remain readable
// and reconcilable after cancellation or later changes to contract terms.
export async function readMembershipBillingContext(
  client: GraphQL,
  contractGid: string,
  now: Date,
): Promise<MembershipBillingContext> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw unsafeBillingContext();
  const contract = await readSubscriptionContract(client, contractGid);
  const nextBillingDate = new Date(contract.nextBillingDate ?? "");
  const line = contract.lines.nodes[0];
  if (
    contract.status !== "ACTIVE" ||
    contract.billingPolicy.interval !== "MONTH" ||
    contract.billingPolicy.intervalCount !== 1 ||
    contract.discounts.nodes.some(
      (discount) =>
        discount.recurringCycleLimit !== 1 || (discount.usageCount ?? 0) < 1,
    ) ||
    contract.discounts.pageInfo.hasNextPage ||
    !Number.isFinite(nextBillingDate.getTime()) ||
    nextBillingDate > now ||
    contract.currencyCode !== "AUD" ||
    contract.lines.nodes.length !== 1 ||
    contract.lines.pageInfo.hasNextPage ||
    !line ||
    line.quantity !== 1
  )
    throw unsafeBillingContext();
  const cents = priceInCents(line.currentPrice.amount);
  const prices = [
    line.currentPrice,
    line.lineDiscountedPrice,
    ...(line.pricingPolicy
      ? [
          line.pricingPolicy.basePrice,
          ...line.pricingPolicy.cycleDiscounts.map(
            (change) => change.computedPrice,
          ),
        ]
      : []),
  ];
  // The pricing policy is app-managed metadata, not an automatic price lock.
  // This fixed-price Pass accepts no recorded future price change or discount.
  if (
    cents === null ||
    cents <= 0 ||
    prices.some(
      (price) =>
        price.currencyCode !== "AUD" || priceInCents(price.amount) !== cents,
    )
  )
    throw unsafeBillingContext();
  const data = await request(
    client,
    MEMBERSHIP_BILLING_CYCLE_READ,
    { contractId: contractGid, date: nextBillingDate.toISOString() },
    "read",
  );
  const parsed = cycleSchema.safeParse(data.subscriptionBillingCycle);
  if (!parsed.success) throw unknownResult("read");
  const cycle = parsed.data;
  const start = new Date(cycle.cycleStartAt);
  const end = new Date(cycle.cycleEndAt);
  const expected = new Date(cycle.billingAttemptExpectedDate);
  if (
    cycle.sourceContract.id !== contractGid ||
    cycle.status !== "UNBILLED" ||
    cycle.edited ||
    cycle.editedContract ||
    cycle.skipped ||
    cycle.billingAttempts.nodes.length ||
    cycle.billingAttempts.pageInfo.hasNextPage ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    !Number.isFinite(expected.getTime()) ||
    start > nextBillingDate ||
    end < nextBillingDate ||
    start >= end ||
    expected > now ||
    expected.getTime() !== nextBillingDate.getTime()
  )
    throw unsafeBillingContext();
  // The Shopify cycle index can differ from the app's attendance-based period.
  return {
    contract,
    nextBillingDate,
    billingCycleSelector: { index: cycle.cycleIndex },
  };
}

const BILLING_FIELDS = `id idempotencyKey ready order { id } errorCode nextActionUrl subscriptionContract { id }`;
export const MEMBERSHIP_BILLING_CREATE = `#graphql
mutation SkyraMembershipBill($contractId: ID!, $input: SubscriptionBillingAttemptInput!) {
  subscriptionBillingAttemptCreate(subscriptionContractId: $contractId, subscriptionBillingAttemptInput: $input) {
    subscriptionBillingAttempt { ${BILLING_FIELDS} }
    userErrors { code message }
  }
}`;
export const MEMBERSHIP_BILLING_READ = `#graphql
query SkyraMembershipBilling($id: ID!) { subscriptionBillingAttempt(id: $id) { ${BILLING_FIELDS} } }`;
const billingSchema = z.object({
  id: gid("SubscriptionBillingAttempt"),
  idempotencyKey: z.string().min(1),
  ready: z.boolean(),
  order: z.object({ id: gid("Order") }).nullable(),
  errorCode: z.string().nullable(),
  nextActionUrl: z.string().url().nullable(),
  subscriptionContract: z.object({ id: gid("SubscriptionContract") }),
});
export type MembershipBilling = {
  id: string;
  contractGid: string;
  idempotencyKey: string;
  ready: boolean;
  orderGid: string | null;
  errorCode: string | null;
  nextActionUrl: string | null;
};
function billingResult(
  input: unknown,
  kind: "read" | "mutation",
): MembershipBilling {
  const parsed = billingSchema.safeParse(input);
  if (!parsed.success) throw unknownResult(kind);
  const value = parsed.data;
  // nextActionUrl is provider-generated and must only be surfaced in an
  // authenticated owner-only response. Never forward an insecure redirect.
  if (value.nextActionUrl) {
    const url = new URL(value.nextActionUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      throw unknownResult(kind);
  }
  return {
    id: value.id,
    contractGid: value.subscriptionContract.id,
    idempotencyKey: value.idempotencyKey,
    ready: value.ready,
    orderGid: value.order?.id ?? null,
    errorCode: value.errorCode,
    nextActionUrl: value.nextActionUrl,
  };
}

export async function submitMembershipBilling(
  client: GraphQL,
  input: {
    contractGid: string;
    idempotencyKey: string;
    originTime: Date | string;
    billingCycleSelector: MembershipBillingCycleSelector;
    inventoryProtected?: boolean;
  },
): Promise<MembershipBilling> {
  const originTime = new Date(input.originTime);
  if (
    !gid("SubscriptionContract").safeParse(input.contractGid).success ||
    !input.idempotencyKey.trim() ||
    !Number.isFinite(originTime.getTime()) ||
    !Number.isSafeInteger(input.billingCycleSelector?.index) ||
    input.billingCycleSelector.index <= 0 ||
    Object.keys(input.billingCycleSelector).length !== 1
  )
    throw new DomainError(
      "INVALID_BILLING_ATTEMPT",
      "Membership billing is not ready.",
      400,
    );
  const data = await request(
    client,
    MEMBERSHIP_BILLING_CREATE,
    {
      contractId: input.contractGid,
      input: {
        idempotencyKey: input.idempotencyKey,
        originTime: originTime.toISOString(),
        billingCycleSelector: { index: input.billingCycleSelector.index },
        inventoryPolicy: input.inventoryProtected
          ? "ALLOW_OVERSELLING"
          : "PRODUCT_VARIANT_INVENTORY_POLICY",
        paymentProcessingPolicy: "FAIL_UNLESS_VALID_PAYMENT_METHOD",
      },
    },
    "mutation",
  );
  const parsed = z
    .object({
      subscriptionBillingAttempt: billingSchema.nullable(),
      userErrors,
    })
    .safeParse(data.subscriptionBillingAttemptCreate);
  if (!parsed.success) throw unknownResult("mutation");
  if (!parsed.data.subscriptionBillingAttempt) {
    if (parsed.data.userErrors.length)
      throw new DomainError(
        "BILLING_REJECTED",
        "Shopify rejected this billing request. The existing attempt must be reviewed before retrying.",
        409,
      );
    throw unknownResult("mutation");
  }
  const result = billingResult(
    parsed.data.subscriptionBillingAttempt,
    "mutation",
  );
  if (
    result.contractGid !== input.contractGid ||
    result.idempotencyKey !== input.idempotencyKey
  )
    throw unknownResult("mutation");
  return result;
}

export async function readMembershipBilling(
  client: GraphQL,
  id: string,
): Promise<MembershipBilling> {
  if (!gid("SubscriptionBillingAttempt").safeParse(id).success)
    throw new DomainError(
      "INVALID_BILLING_ATTEMPT",
      "Invalid membership billing attempt.",
      400,
    );
  const data = await request(client, MEMBERSHIP_BILLING_READ, { id }, "read");
  const result = billingResult(data.subscriptionBillingAttempt, "read");
  if (result.id !== id) throw unknownResult("read");
  return result;
}

export const MEMBERSHIP_CONTRACT_CANCEL = `#graphql
mutation SkyraMembershipCancel($id: ID!) { subscriptionContractCancel(subscriptionContractId: $id) { contract { id status } userErrors { code message } } }`;
export const MEMBERSHIP_CONTRACT_PAUSE = `#graphql
mutation SkyraMembershipPause($id: ID!) { subscriptionContractPause(subscriptionContractId: $id) { contract { id status } userErrors { code message } } }`;
export const MEMBERSHIP_CONTRACT_ACTIVATE = `#graphql
mutation SkyraMembershipActivate($id: ID!) { subscriptionContractActivate(subscriptionContractId: $id) { contract { id status } userErrors { code message } } }`;
export const MEMBERSHIP_NEXT_BILLING_DATE = `#graphql
mutation SkyraMembershipBillingDate($id: ID!, $date: DateTime!) { subscriptionContractSetNextBillingDate(contractId: $id, date: $date) { contract { id nextBillingDate } userErrors { code message } } }`;

async function updateContract(
  client: GraphQL,
  query: string,
  field: string,
  id: string,
  variables: Record<string, unknown> = {},
) {
  if (!gid("SubscriptionContract").safeParse(id).success)
    throw new DomainError(
      "INVALID_CONTRACT",
      "Invalid membership contract.",
      400,
    );
  const data = await request(client, query, { id, ...variables }, "mutation");
  const parsed = z
    .object({
      contract: z
        .object({
          id: gid("SubscriptionContract"),
          status: z.string().optional(),
          nextBillingDate: z.string().nullable().optional(),
        })
        .nullable(),
      userErrors,
    })
    .safeParse(data[field]);
  if (!parsed.success) throw unknownResult("mutation");
  if (parsed.data.userErrors.length)
    throw new DomainError(
      "CONTRACT_UPDATE_REJECTED",
      "Shopify could not update this membership. Please try again after checking its status.",
      409,
    );
  if (!parsed.data.contract || parsed.data.contract.id !== id)
    throw unknownResult("mutation");
  return parsed.data.contract;
}

async function setContractStatus(
  client: GraphQL,
  id: string,
  query: string,
  field: string,
  status: string,
) {
  const contract = await updateContract(client, query, field, id);
  if (contract.status !== status) throw unknownResult("mutation");
  return contract;
}

export const cancelSubscriptionContract = (client: GraphQL, id: string) =>
  setContractStatus(
    client,
    id,
    MEMBERSHIP_CONTRACT_CANCEL,
    "subscriptionContractCancel",
    "CANCELLED",
  );
export const pauseSubscriptionContract = (client: GraphQL, id: string) =>
  setContractStatus(
    client,
    id,
    MEMBERSHIP_CONTRACT_PAUSE,
    "subscriptionContractPause",
    "PAUSED",
  );
export const activateSubscriptionContract = (client: GraphQL, id: string) =>
  setContractStatus(
    client,
    id,
    MEMBERSHIP_CONTRACT_ACTIVATE,
    "subscriptionContractActivate",
    "ACTIVE",
  );
export async function setNextBillingDate(
  client: GraphQL,
  id: string,
  date: Date | string,
) {
  const value = new Date(date);
  if (!Number.isFinite(value.getTime()))
    throw new DomainError(
      "INVALID_BILLING_DATE",
      "Invalid membership billing date.",
      400,
    );
  const contract = await updateContract(
    client,
    MEMBERSHIP_NEXT_BILLING_DATE,
    "subscriptionContractSetNextBillingDate",
    id,
    { date: value.toISOString() },
  );
  if (
    !contract.nextBillingDate ||
    new Date(contract.nextBillingDate).getTime() !== value.getTime()
  )
    throw unknownResult("mutation");
  return contract;
}
