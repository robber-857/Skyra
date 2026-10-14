/* eslint-env node */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

// Source-bundle browser fixtures exercise attendee and payment context. They do not prove Shopify login or payment.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = resolve("../output/playwright/family-storefront");
await mkdir(output, { recursive: true });
const bundles = Object.fromEntries(await Promise.all(["attempt", "transaction", "membership"].map(async (name) => {
  const result = await build({ entryPoints: [resolve(`theme-extension-src/${name}.js`)], bundle: true, write: false, format: "iife" });
  return [`/${name}.js`, result.outputFiles[0].text];
})));
const parent = "11111111-1111-4111-8111-111111111111";
const first = "22222222-2222-4222-8222-222222222222";
const second = "33333333-3333-4333-8333-333333333333";
const family = { account: { id: parent, name: "Parent", email: "parent@example.com" }, members: [
  { id: parent, name: "Parent", email: "parent@example.com", relationship: "SELF" },
  { id: first, name: "Child One", email: "child1.parent@example.com", relationship: "CHILD" },
  { id: second, name: "Child Two", email: "child2.parent@example.com", relationship: "CHILD" },
] };
const session = { id: "test-session", startsAt: new Date(Date.now() + 3 * 3600000).toISOString(), endsAt: new Date(Date.now() + 4 * 3600000).toISOString(), timezone: "Australia/Sydney", spotsRemaining: 6, bookingStatus: "OPEN", service: { id: "test-service", name: "Family Aerial Class", durationMin: 55 }, coach: { name: "Test coach" }, location: { name: "Studio" } };
const pass = { id: "monthly", version: 1, name: "Monthly Pass", priceCents: 29900, currency: "AUD", credits: 12, validityMonths: 1, autoRenew: { available: false }, oneTimePurchaseEnabled: true };
let state;
function reset() { state = { signedIn: true, next: 0, attempts: new Map(), starts: [], confirmations: [], purchases: [], losePayment: false }; }
reset();
function member(id) { return family.members.find((item) => item.id === id); }
function snapshot(attempt) { return { token: attempt.token, surface: "PROGRAMS", status: attempt.confirmed ? "CONFIRMED" : state.signedIn ? "STARTED" : "LOGIN_REQUIRED", requiresLogin: !state.signedIn, familyMemberId: state.signedIn ? attempt.owner : null, attendeeName: state.signedIn ? member(attempt.owner)?.name : null, resultAvailable: !!attempt.confirmed || !!attempt.hold, session, returnPath: "/pages/programs?skyra_attempt=" + attempt.token + "#skyra-booking-programs" }; }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  if (bundles[path]) { res.setHeader("Content-Type", "text/javascript"); return res.end(bundles[path]); }
  if (path === "/booking.css" || path === "/membership.css") {
    res.setHeader("Content-Type", "text/css"); return res.end(path === "/booking.css" ? await readFile(resolve("extensions/skyra-booking-embed/assets/booking.css")) : (await readFile(resolve("../shopify-theme/assets/skyra-membership.css"))) + "\n" + (await readFile(resolve("../shopify-theme/assets/skyra-membership-purchase.css"))));
  }
  if (path.startsWith("/apps/skyra-booking/")) {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    const route = path.slice("/apps/skyra-booking/".length);
    res.setHeader("Content-Type", "application/json");
    const json = (data) => res.end(JSON.stringify(data));
    if (route === "family") { assert.equal(body.familyMemberId, undefined); return json(family); }
    if (route === "start") {
      state.starts.push(body);
      if (!state.signedIn) assert.equal(body.familyMemberId, undefined, "Anonymous start must omit a child UUID");
      const token = String.fromCharCode(97 + state.next++).repeat(43);
      const attempt = { token, owner: state.signedIn ? body.familyMemberId || parent : null };
      state.attempts.set(token, attempt); return json(snapshot(attempt));
    }
    const attempt = state.attempts.get(body.token);
    if (route === "attempt") {
      if (state.signedIn && !attempt.owner) attempt.owner = body.familyMemberId || parent;
      return json(snapshot(attempt));
    }
    if (["result", "pass-options", "comment", "confirm"].includes(route)) {
      assert.equal(body.familyMemberId || parent, attempt.owner, "Every booking request must use the attempt's attendee");
      if (route === "result") return json({ status: attempt.confirmed ? "CONFIRMED" : "NOT_CONFIRMED", bookingReference: attempt.confirmed ? attempt.owner.slice(-8) : null });
      if (route === "comment") return json({ saved: true });
      if (route === "confirm") { assert.equal(body.entitlementId, "owned-" + attempt.owner); state.confirmations.push({ owner: attempt.owner, sessionId: session.id }); attempt.confirmed = true; return json({ status: "CONFIRMED", bookingReference: "BOOKED" }); }
      const owned = { id: "owned-" + attempt.owner, kind: "OWNED_PASS", name: member(attempt.owner).name + " Pass", availableUnits: 5, expiresAt: null };
      return json({ passes: [], ownedPasses: [owned], selected: body.entitlementId ? owned : null, checkoutAvailable: true, ownedPassesAvailable: true });
    }
    if (route === "memberships/catalog") {
      const owner = body.familyMemberId || parent;
      return json({ authenticated: true, checkoutAvailable: true, passes: [pass], memberships: state.purchases.filter((purchase) => purchase.owner === owner && purchase.paid).map((purchase) => ({ id: purchase.id, name: member(owner).name + " Monthly Pass", passPlanId: pass.id, status: "ACTIVE", autoRenew: false, blocksPurchase: true })) });
    }
    if (route === "memberships/purchase") {
      let purchase = state.purchases.find((item) => item.key === body.idempotencyKey);
      if (!purchase) { purchase = { id: "purchase-" + state.purchases.length, key: body.idempotencyKey, owner: body.familyMemberId || parent, paid: false }; state.purchases.push(purchase); }
      assert.equal(body.familyMemberId || parent, purchase.owner, "A retry must retain its original Pass owner");
      if (state.losePayment) { req.socket.destroy(); return; }
      purchase.paid = true; return json({ status: "PAID", purchaseId: purchase.id, name: pass.name });
    }
    if (route === "memberships/result") { const purchase = state.purchases.find((item) => item.id === body.purchaseId); assert.equal(body.familyMemberId || parent, purchase.owner); return json({ status: purchase.paid ? "PAID" : "PENDING", name: pass.name }); }
    res.statusCode = 404; return json({ error: "Unknown fixture route: " + route });
  }
  res.setHeader("Content-Type", "text/html");
  if (path === "/booking" || path === "/attempt-only") return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/booking.css"><main class="skyra-booking" id="skyra-booking-programs" data-surface="programs"></main><script src="/attempt.js"></script><script src="/transaction.js"></script><script>const root=document.querySelector('main'),attempt=window.SkyraBookingAttempt(root);window.fixtureAttempt=attempt;window.fixtureReady=(async()=>{const restored=await attempt.restore();if(!restored)attempt.select('test-session');window.fixtureAuthenticated=await attempt.check();if(window.fixtureAuthenticated && ${JSON.stringify(path !== "/attempt-only")})window.SkyraBookingTransaction({root,attempt,session:${JSON.stringify(session)},timezone:'Australia/Sydney',shell:host=>root.replaceChildren(host),back:()=>{},restart:()=>{},signIn:()=>{}});})();</script>`);
  return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/membership.css"><main class="membership-page" style="padding:20px"><div id="membership" class="membership-shop" data-skyra-memberships></div></main><script src="/membership.js"></script>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const results = [];
try {
  for (const width of [390, 1440]) {
    reset(); const context = await browser.newContext({ viewport: { width, height: 1000 } }); const page = await context.newPage(); const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + "/booking"); await page.getByRole("combobox", { name: "Booking for" }).waitFor();
    await page.getByRole("combobox", { name: "Booking for" }).selectOption(first); await page.getByRole("radio").check(); await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText("Attendee: Child One", { exact: true }).first().waitFor(); await page.getByRole("button", { name: "Confirm booking", exact: true }).click(); await page.getByRole("heading", { name: "Booking confirmed", exact: true }).waitFor();
    await page.getByRole("button", { name: "Book for another family member", exact: true }).click(); await page.getByRole("combobox", { name: "Booking for" }).waitFor(); await page.getByRole("combobox", { name: "Booking for" }).selectOption(second);
    await page.getByRole("radio").check(); await page.getByRole("button", { name: "Continue", exact: true }).click(); await page.getByText("Attendee: Child Two", { exact: true }).first().waitFor(); await page.getByRole("button", { name: "Confirm booking", exact: true }).click(); await page.getByRole("heading", { name: "Booking confirmed", exact: true }).waitFor();
    assert.deepEqual(state.confirmations.map((item) => item.owner), [first, second]); assert.equal(new Set(state.confirmations.map((item) => item.sessionId)).size, 1);
    // A return URL without an attendee hint must recover the server-owned child, even if the shared selection changed.
    const token = await page.evaluate(() => { window.fixtureAttempt.remember(); const token = window.fixtureAttempt.token(); sessionStorage.removeItem('skyra-booking:programs:attempt:member'); sessionStorage.setItem('skyra-family:member','22222222-2222-4222-8222-222222222222'); return token; });
    await page.goto(base + "/booking?skyra_attempt=" + token); await page.getByRole("heading", { name: "Booking confirmed", exact: true }).waitFor(); await page.getByText("Attendee: Child Two", { exact: true }).waitFor(); assert.equal(await page.evaluate(() => window.fixtureAttempt.familyMemberId()), second);
    await page.screenshot({ path: resolve(output, `booking-restored-${width}.png`), fullPage: true });
    reset(); await page.evaluate(() => sessionStorage.clear()); await page.goto(base + "/membership"); await page.getByRole("combobox", { name: "Passes for" }).waitFor(); await page.getByRole("combobox", { name: "Passes for" }).selectOption(first); await page.getByRole("button", { name: "Review pass", exact: true }).click(); await page.getByText("Pass owner: Child One", { exact: true }).waitFor(); await page.getByRole("checkbox").check();
    state.losePayment = true; await page.getByRole("button", { name: "Continue to Shopify Checkout", exact: true }).click(); await page.getByRole("button", { name: "Check the same purchase again", exact: true }).waitFor(); await page.evaluate(() => sessionStorage.setItem('skyra-family:member','33333333-3333-4333-8333-333333333333')); await page.reload();
    await page.getByRole("button", { name: "Check existing purchase", exact: true }).waitFor(); const selector = page.getByRole("combobox", { name: "Passes for" }); assert.equal(await selector.inputValue(), first); assert.equal(await selector.isDisabled(), true); assert.equal(state.purchases.length, 1);
    state.losePayment = false; await page.getByRole("button", { name: "Check existing purchase", exact: true }).click(); await page.getByRole("heading", { name: "Your pass is ready", exact: true }).waitFor(); await page.getByRole("button", { name: "View your passes", exact: true }).click(); await page.getByRole("combobox", { name: "Passes for" }).selectOption(second);
    await page.getByRole("button", { name: "Review pass", exact: true }).waitFor(); assert.equal(await page.getByText("Child One Monthly Pass", { exact: true }).count(), 0); await page.getByRole("button", { name: "Review pass", exact: true }).click(); await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "Continue to Shopify Checkout", exact: true }).click(); await page.getByRole("heading", { name: "Your pass is ready", exact: true }).waitFor(); assert.deepEqual(state.purchases.map((item) => item.owner), [first, second]); assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(output, `membership-second-child-${width}.png`), fullPage: true });
    reset(); state.signedIn = false; await page.evaluate(() => sessionStorage.clear()); await page.goto(base + "/attempt-only?skyra_member=" + first); await page.evaluate(() => window.fixtureReady); assert.equal(await page.evaluate(() => window.fixtureAuthenticated), false); assert.equal(state.starts[0].familyMemberId, undefined);
    state.signedIn = true; assert.equal(await page.evaluate(() => window.fixtureAttempt.check()), true); assert.equal(await page.evaluate(() => window.fixtureAttempt.familyMemberId()), first); assert.equal(state.attempts.get(await page.evaluate(() => window.fixtureAttempt.token())).owner, first); assert.deepEqual(errors, []);
    results.push({ width, sameClassIndependentBookings: true, tokenOnlyRestore: true, pendingPurchaseOwnerLocked: true, independentPassPurchase: true, anonymousSelectionAfterLogin: true, pageErrors: errors }); await context.close();
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify({ mode: "Local source-bundle browser fixture; no real login or payment", results }, null, 2)); console.log("FAMILY_STOREFRONT_FIXTURE_OK " + JSON.stringify(results));
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
