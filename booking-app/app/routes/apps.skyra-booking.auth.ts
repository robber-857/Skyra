import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store, max-age=0",
};

// Customer identity is only read after Shopify verifies the proxy signature.
// Keep it out of the public, cacheable schedule response.
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    await authenticate.public.appProxy(request);
  } catch (error) {
    if (error instanceof Response) {
      error.headers.set("Cache-Control", headers["Cache-Control"]);
    }
    throw error;
  }

  const params = new URL(request.url).searchParams;
  const domains = params.getAll("shop");
  const customers = params.getAll("logged_in_customer_id");
  if (domains.length !== 1 || customers.length > 1) {
    return new Response(JSON.stringify({ error: "Invalid shop context." }), { status: 400, headers });
  }
  const shop = await db.shop.findUnique({
    where: { domain: domains[0] },
    select: { status: true },
  });
  if (shop?.status !== "ACTIVE") {
    return new Response(JSON.stringify({ error: "Booking is unavailable for this store." }), { status: 404, headers });
  }
  const authenticated = /^[1-9]\d*$/.test(customers[0] || "");
  return new Response(JSON.stringify({ authenticated }), { headers });
}
