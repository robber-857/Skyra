import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import db from "../app/db.server";
import { createSeatHold, releaseSeatHold } from "../app/services/booking.server";

if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test") throw new Error("HTTP smoke requires the test database.");
const base = "http://127.0.0.1:3310";
const shop = await db.shop.findFirstOrThrow({ where: { domain: { endsWith: "-booking-test.myshopify.com" } }, orderBy: { createdAt: "desc" } });
const session = await db.classSession.findFirstOrThrow({ where: { shopId: shop.id, status: "PUBLISHED" } });
const pass = await db.passPlan.findFirstOrThrow({ where: { shopId: shop.id, status: "ACTIVE" } });
function signed(path: string, customer = "", valid = true) {
  const params: Record<string, string> = { shop: shop.domain, logged_in_customer_id: customer, path_prefix: "/apps/skyra-booking", timestamp: String(Math.floor(Date.now() / 1000)) };
  const message = Object.keys(params).sort().map(key => key + "=" + params[key]).join("");
  params.signature = valid ? createHmac("sha256", "local-http-fixture-signing-key").update(message).digest("hex") : "invalid";
  return base + "/apps/skyra-booking/" + path + "?" + new URLSearchParams(params);
}
async function post(path: string, body: unknown, customer = "", valid = true) {
  return fetch(signed(path, customer, valid), { method: "POST", headers: { "Content-Type": "application/json", "X-Skyra-Booking": "1" }, body: JSON.stringify(body), redirect: "manual" });
}
try {
  const denied = await post("start", { sessionId: session.id, surface: "HOME" }, "", false);
  assert.equal(denied.status, 400);
  const begin = await post("start", { sessionId: session.id, surface: "HOME" });
  assert.equal(begin.status, 200);
  const attempt = await begin.json(); assert.equal(attempt.requiresLogin, true);
  const claim = await post("attempt", { token: attempt.token }, "99991");
  assert.equal(claim.status, 200); assert.equal((await claim.json()).requiresLogin, false);
  assert.equal((await post("attempt", { token: attempt.token }, "99992")).status, 403);
  assert.equal((await post("start", { sessionId: session.id, surface: "HOME", customerId: "spoof" }, "99991")).status, 400);
  const hold = await createSeatHold({ shopId: shop.id, customerGid: "gid://shopify/Customer/99991" }, { token: attempt.token, passPlanId: pass.id, idempotencyKey: randomUUID() });
  const availability = await fetch(signed("sessions"));
  assert.equal(availability.status, 200); assert.match(availability.headers.get("Cache-Control") || "", /no-store/);
  const schedule = await availability.json();
  assert.equal(schedule.sessions.find((row: { id: string }) => row.id === session.id).spotsRemaining, session.capacity - 1);
  const restored = await post("attempt", { token: attempt.token }, "99991");
  assert.equal((await restored.json()).hold.id, hold.id);
  await releaseSeatHold({ shopId: shop.id, customerGid: "gid://shopify/Customer/99991" }, attempt.token);
  console.log("BOOKING_HTTP_OK sdkSignature=true anonymousStart=true customerBind=true crossCustomerBlocked=true liveCapacity=true holdRestore=true");
} finally { await db.$disconnect(); }
