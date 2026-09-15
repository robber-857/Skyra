const REFERENCE_KEY = "_skyra_booking_ref";

function bookingError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.bookingError = true;
  return error;
}

export function normalizeNativeCartHandoff(data) {
  if (
    data?.status !== "NATIVE_CART_READY" ||
    !Number.isSafeInteger(data.variantId) ||
    data.variantId <= 0 ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.bookingReference || "") ||
    !Number.isSafeInteger(data.priceCents) ||
    data.priceCents < 0 ||
    data.currency !== "AUD"
  )
    throw bookingError(
      "CART_RESPONSE_INVALID",
      "Shopify Cart is not ready. Please try again.",
    );
  return {
    variantId: data.variantId,
    bookingReference: data.bookingReference,
    priceCents: data.priceCents,
    currency: data.currency,
  };
}

function exactProperties(properties, reference) {
  return (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.keys(properties).length === 1 &&
    properties[REFERENCE_KEY] === reference
  );
}

export function inspectNativeBookingCart(cart, handoff) {
  if (
    !cart ||
    typeof cart !== "object" ||
    !Number.isSafeInteger(cart.item_count) ||
    !Array.isArray(cart.items) ||
    cart.currency !== handoff.currency
  )
    throw bookingError(
      "CART_RESPONSE_INVALID",
      "Shopify returned an invalid Cart. Please try again.",
    );
  if (
    cart.item_count === 0 &&
    cart.items.length === 0 &&
    cart.total_price === 0
  )
    return "EMPTY";
  const item = cart.items[0];
  if (
    cart.item_count === 1 &&
    cart.items.length === 1 &&
    String(item?.variant_id) === String(handoff.variantId) &&
    item.quantity === 1 &&
    item.final_price === handoff.priceCents &&
    cart.total_price === handoff.priceCents &&
    exactProperties(item.properties, handoff.bookingReference)
  )
    return "READY";
  throw bookingError(
    "CART_NOT_EMPTY",
    "Your Shopify Cart contains another item. Open Cart, remove it, then return and try again.",
  );
}

function nativeRoutes(location, shopify) {
  const origin = location.origin;
  const root = typeof shopify?.routes?.root === "string"
    ? shopify.routes.root
    : "/";
  const rootUrl = new URL(root, origin);
  if (
    rootUrl.origin !== origin ||
    rootUrl.search ||
    rootUrl.hash ||
    !rootUrl.pathname.startsWith("/") ||
    !rootUrl.pathname.endsWith("/")
  )
    throw bookingError(
      "CART_RESPONSE_INVALID",
      "Shopify Cart routes are not available. Please reload the page.",
    );
  return {
    cart: new URL(rootUrl.pathname + "cart.js", origin).href,
    add: new URL(rootUrl.pathname + "cart/add.js", origin).href,
    checkout: new URL(rootUrl.pathname + "cart", origin).href,
  };
}

async function json(fetchImpl, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "same-origin",
      ...options,
      headers: { Accept: "application/json", ...options.headers },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw bookingError(
      "CART_UNAVAILABLE",
      "Shopify Cart could not be reached. Please try again.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw bookingError(
      "CART_RESPONSE_INVALID",
      "Shopify returned an invalid Cart response. Please try again.",
    );
  }
  if (!response.ok)
    throw bookingError(
      "CART_UNAVAILABLE",
      typeof data?.description === "string"
        ? data.description
        : "Shopify Cart could not be updated. Please try again.",
    );
  return data;
}

export async function prepareNativeBookingCart(data, runtime = {}) {
  const handoff = normalizeNativeCartHandoff(data);
  const location = runtime.location || window.location;
  const shopify = runtime.shopify || window.Shopify;
  const fetchImpl = runtime.fetchImpl || window.fetch.bind(window);
  const routes = nativeRoutes(location, shopify);
  const current = await json(fetchImpl, routes.cart);
  if (inspectNativeBookingCart(current, handoff) === "EMPTY") {
    await json(fetchImpl, routes.add, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            id: handoff.variantId,
            quantity: 1,
            properties: { [REFERENCE_KEY]: handoff.bookingReference },
          },
        ],
      }),
    });
    inspectNativeBookingCart(await json(fetchImpl, routes.cart), handoff);
  }
  return routes.checkout;
}

export function submitNativeCheckout(action, documentRef = document) {
  const form = documentRef.createElement("form");
  form.method = "post";
  form.action = action;
  form.hidden = true;
  const checkout = documentRef.createElement("input");
  checkout.type = "hidden";
  checkout.name = "checkout";
  checkout.value = "Checkout";
  form.append(checkout);
  documentRef.body.append(form);
  form.submit();
}
