/* eslint-env node */
// Browser fixtures verify UI state and request contracts; they do not prove Shopify payment integration.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const app = path.resolve(__dirname, "..");
const output = path.resolve(app, "../output/playwright/membership");
fs.mkdirSync(output, { recursive: true });
const pass = { kind: "NEW_PASS", id: "monthly", version: 1, name: "SKYRA Lifestyle 1 month", priceCents: 29900, currency: "AUD", credits: 12, validityMonths: 1, autoRenew: { available: true, termsVersion: "2026-10-02.v1" } };
const pack = { kind: "NEW_PASS", id: "pack", version: 1, name: "5 Aerial Access", priceCents: 22000, currency: "AUD", credits: 5, validityMonths: 2 };
let state;
const membershipRequests = [];
const reset = () => { state = { authenticated: true, checkoutAvailable: true, passes: [pass, pack], memberships: [], purchases: [], resultRequests: [], checkoutRequests: [], result: "PENDING", loseResponse: false }; };
reset();
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const assets = {
    "/membership.js": "../shopify-theme/assets/skyra-memberships.js",
    "/membership.css": "../shopify-theme/assets/skyra-membership.css",
    "/transaction.js": "extensions/skyra-booking-embed/assets/transaction.js",
    "/attempt.js": "extensions/skyra-booking-embed/assets/attempt.js",
    "/booking.css": "extensions/skyra-booking-embed/assets/booking.css",
  };
  if (assets[pathname]) {
    res.setHeader("Content-Type", pathname.endsWith("css") ? "text/css" : "text/javascript");
    return res.end(fs.readFileSync(path.resolve(app, assets[pathname])));
  }
  if (pathname.startsWith("/apps/skyra-booking/")) {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    const route = pathname.slice("/apps/skyra-booking/".length);
    if (route.startsWith("memberships")) membershipRequests.push({ method: req.method, pathname });
    res.setHeader("Content-Type", "application/json");
    const json = (data) => res.end(JSON.stringify(data));
    if (route === "memberships/catalog") {
      if (state.catalogError) { res.statusCode = 503; return json({ code: "UNAVAILABLE", error: "Passes are temporarily unavailable." }); }
      return json({ passes: state.passes, memberships: state.memberships, authenticated: state.authenticated, checkoutAvailable: state.checkoutAvailable });
    }
    if (route === "memberships/purchase") {
      state.purchases.push(body);
      if (state.loseResponse) { req.socket.destroy(); return; }
      return json({ status: "PAID", purchaseId: "purchase-fixture", name: pass.name });
    }
    if (route === "memberships/result") {
      state.resultRequests.push(body);
      return json({ status: state.result, name: pass.name, ...(state.actionUrl ? { actionUrl: state.actionUrl } : {}) });
    }
    if (route === "memberships/cancel") {
      assert.equal(body.membershipId, "existing");
      state.memberships[0].autoRenew = false;
      return json({ status: "CANCELLED", message: "Future renewals are off. Your paid pass is still available." });
    }
    if (route === "result") return json({ status: "NOT_CONFIRMED" });
    if (route === "pass-options") return json({ passes: state.passes, selected: body.passPlanId ? state.passes.find((item) => item.id === body.passPlanId) : null, checkoutAvailable: true, ownedPassesAvailable: true });
    if (route === "comment") return json({ saved: true });
    if (route === "checkout") { state.checkoutRequests.push(body); return json({ status: "CHECKOUT_READY", checkoutUrl: "https://checkout.invalid/test" }); }
    res.statusCode = 404; return json({ error: "Unknown fixture route" });
  }
  res.setHeader("Content-Type", "text/html");
  if (pathname === "/booking-ui") return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/booking.css"><script src="/attempt.js" defer></script><script src="/transaction.js" defer></script></head><body style="font-family:Arial;padding:20px"><main id="booking" class="skyra-booking" data-proxy-base="/apps/skyra-booking"></main><script>document.addEventListener('DOMContentLoaded',()=>{const root=document.querySelector('main');window.SkyraBookingTransaction({root,attempt:{token:()=> 'a'.repeat(43),remember:()=>{}},session:{service:{name:'Aerial class',durationMin:55},startsAt:'2026-10-08T09:00:00Z',endsAt:'2026-10-08T09:55:00Z',coach:{name:'Test coach'},location:{name:'Test studio'}},timezone:'Australia/Sydney',back:()=>{},shell:host=>root.replaceChildren(host),restart:()=>{},signIn:()=>{}})});</script></body></html>`);
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/membership.css"><script src="/membership.js" defer></script></head><body style="margin:0"><main class="membership-page" style="padding:20px"><p style="font:12px Arial">LOCAL UI FIXTURE · No live payment</p><div class="membership-main"><section class="membership-catalog"><div id="membership" class="membership-shop" data-skyra-memberships data-shop-domain="skyra-booking-dev.myshopify.com" data-theme-id="192227082532"></div></section></div></main></body></html>`);
});

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const outcomes = [];
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      for (const surface of ["membership", "booking"]) {
        reset();
        state.passes = [{ ...pass, oneTimePurchaseEnabled: false }];
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        await page.route("https://checkout.invalid/test", (route) => route.fulfill({ body: "fixture checkout" }));
        await page.goto(base + (surface === "membership" ? "/pages/membership" : "/booking-ui"));
        if (surface === "booking") await page.locator('.skyra-booking__pass input[value="NEW_PASS:monthly"]').check();
        const renewal = page.getByRole("radio", { name: "Automatically renew when this pass expires" });
        await renewal.waitFor();
        assert.equal(await renewal.isChecked(), true);
        assert.equal(await page.getByRole("radio", { name: "One-time purchase", exact: true }).count(), 0);
        await page.screenshot({ path: path.join(output, `renewal-only-${surface}-${viewport.width}.png`), fullPage: true });
        await page.getByRole("button", { name: surface === "membership" ? "Review pass" : "Continue", exact: true }).click();
        const checkout = page.getByRole("button", { name: "Continue to Shopify Checkout" });
        await checkout.waitFor();
        assert.equal(await page.getByRole("checkbox").count(), 2);
        assert.equal(await page.getByRole("checkbox").nth(1).isChecked(), false);
        await page.getByRole("checkbox").nth(0).check();
        assert.equal(await checkout.isDisabled(), true);
        await page.getByRole("checkbox").nth(1).check();
        await checkout.click();
        if (surface === "membership") await page.getByRole("heading", { name: "Your pass is ready" }).waitFor();
        else await page.waitForURL("https://checkout.invalid/test");
        const request = surface === "membership" ? state.purchases[0] : state.checkoutRequests[0];
        assert.equal(request.autoRenew, true);
        assert.deepEqual(request.autoRenewAcceptance, { accepted: true, version: "2026-10-02.v1" });
        outcomes.push(`${viewport.width}px ${surface}: renewal-only hides one-time purchase and requires explicit renewal consent`);
        await context.close();
      }
    }
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      reset();
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base + "/pages/membership");
      const monthly = page.locator(".membership-shop__card").filter({ hasText: pass.name });
      await monthly.waitFor();
      assert.equal(await monthly.getByRole("radio", { name: "One-time purchase", exact: true }).isChecked(), true);
      await page.screenshot({ path: path.join(output, `catalog-${viewport.width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Catalog must fit viewport");
      await monthly.getByRole("radio", { name: "Automatically renew when this pass expires" }).check();
      await monthly.getByRole("button", { name: "Review pass" }).click();
      const checkout = page.getByRole("button", { name: "Continue to Shopify Checkout" });
      assert.equal(await checkout.isDisabled(), true);
      await page.getByRole("checkbox").nth(0).check();
      assert.equal(await checkout.isDisabled(), true, "Terms alone cannot authorise renewal");
      await page.getByRole("checkbox").nth(1).check();
      assert.equal(await checkout.isEnabled(), true);
      await page.screenshot({ path: path.join(output, `review-${viewport.width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Review must fit viewport");
      state.loseResponse = true;
      await checkout.click();
      await page.getByRole("button", { name: "Check the same purchase again" }).waitFor();
      await page.reload();
      await page.getByRole("button", { name: "Check existing purchase" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Review pass" }).first().isDisabled(), true, "Unknown payment prevents a new local purchase");
      state.loseResponse = false;
      await page.getByRole("button", { name: "Check existing purchase" }).click();
      await page.getByRole("heading", { name: "Your pass is ready" }).waitFor();
      assert.ok(state.purchases.length >= 2);
      assert.equal(new Set(state.purchases.map((item) => item.idempotencyKey)).size, 1, "Reload retry must reuse exact original key");
      assert.deepEqual(state.purchases[0].autoRenewAcceptance, { accepted: true, version: "2026-10-02.v1" });
      assert.equal(state.purchases[0].autoRenew, true);
      assert.equal(state.purchases[0].expectedVersion, 1);
      assert.equal(state.purchases[0].expectedPriceCents, 29900);
      assert.deepEqual(errors, []);
      outcomes.push(`${viewport.width}px: catalog, renewal opt-in, separate consent, response-loss/reload key reuse, no overflow`);
      await context.close();
    }
    reset();
    let context = await browser.newContext(); let page = await context.newPage();
    state.passes = [{ ...pass, autoRenew: { ...pass.autoRenew, available: false, reason: "Automatic renewal is not configured for online purchase yet." } }];
    await page.goto(base + "/pages/membership");
    assert.equal(await page.getByRole("radio", { name: "Automatically renew when this pass expires" }).isDisabled(), true);
    await page.getByRole("button", { name: "Review pass" }).click();
    assert.equal(await page.getByRole("checkbox").count(), 1);
    await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "Continue to Shopify Checkout" }).click();
    await page.getByRole("heading", { name: "Your pass is ready" }).waitFor();
    assert.equal(state.purchases[0].autoRenew, false); assert.equal(state.purchases[0].autoRenewAcceptance, undefined);
    outcomes.push("Unavailable automatic renewal stays disabled; one-time purchase remains independent");
    await context.close();

    reset(); state.memberships = [{ id: "existing", passPlanId: "monthly", name: pass.name, status: "AWAITING_ACTIVATION", autoRenew: true, canCancel: true, hasPendingPayment: false }];
    context = await browser.newContext(); page = await context.newPage();
    await page.goto(base + "/pages/membership");
    await page.getByRole("button", { name: "View your current pass" }).waitFor();
    assert.equal(await page.locator(".membership-shop__card").filter({ hasText: pass.name }).getByRole("button", { name: "Review pass" }).count(), 0);
    await page.getByRole("button", { name: "Turn off automatic renewal" }).click();
    await page.getByRole("button", { name: "Confirm cancellation" }).click();
    await page.getByRole("heading", { name: "Automatic renewal is off" }).waitFor();
    outcomes.push("Existing pass redirects to management and cancellation uses server result");
    await context.close();

    reset(); state.memberships = [{ id: "existing", passPlanId: "monthly", name: pass.name, status: "WAITING_PAYMENT", autoRenew: false, autoRenewRequested: true, canCancel: true, hasPendingPayment: true, blocksPurchase: true }];
    context = await browser.newContext(); page = await context.newPage();
    await page.goto(base + "/pages/membership");
    await page.getByText("Automatic renewal is awaiting setup. You can turn off future renewals below.").waitFor();
    await page.getByRole("button", { name: "Turn off automatic renewal" }).click();
    await page.getByRole("button", { name: "Confirm cancellation" }).click();
    await page.getByRole("heading", { name: "Automatic renewal is off" }).waitFor();
    outcomes.push("Pending renewal authorisation can be cancelled before contract setup finishes");
    await context.close();

    reset();
    state.result = "ACTION_REQUIRED"; state.actionUrl = "https://verification.invalid/existing-payment";
    state.memberships = [{ id: "existing", purchaseId: "verification-purchase", passPlanId: "monthly", name: pass.name, status: "WAITING_PAYMENT", autoRenew: true, paymentStatus: "ACTION_REQUIRED", hasPendingPayment: true, blocksPurchase: true }];
    context = await browser.newContext({ viewport: { width: 390, height: 844 } }); page = await context.newPage();
    await context.route("https://verification.invalid/existing-payment", (route) => route.fulfill({ body: "Bank verification fixture" }));
    await page.goto(base + "/pages/membership");
    await page.getByRole("button", { name: "Complete payment verification" }).click();
    const verification = page.getByRole("link", { name: "Continue payment verification" });
    await verification.waitFor();
    await page.screenshot({ path: path.join(output, "payment-verification-390.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Verification must fit viewport");
    assert.equal(await verification.getAttribute("href"), state.actionUrl);
    assert.equal(await verification.getAttribute("rel"), "noopener noreferrer");
    const popupPromise = page.waitForEvent("popup"); await verification.click(); const popup = await popupPromise;
    await popup.waitForURL(state.actionUrl); await popup.close();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("skyra-memberships:purchase")), null, "Challenge must not create a purchase intent or persist an action URL");
    state.actionUrl = "javascript:alert(1)";
    await page.getByRole("button", { name: "Check payment status" }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("link", { name: "Continue payment verification" }).count(), 0, "Unsafe action URL must never be linked");
    state.result = "PAID";
    await page.getByRole("button", { name: "Check payment status" }).click();
    await page.getByRole("heading", { name: "Your pass is ready" }).waitFor();
    assert.equal(state.purchases.length, 0, "Verification must never create another payment");
    assert.ok(state.resultRequests.length >= 3);
    assert.ok(state.resultRequests.every((item) => item.purchaseId === "verification-purchase"), "All verification checks use the original purchase");
    outcomes.push("Bank challenge uses server-verified HTTPS action in new tab, rejects unsafe URLs, checks same purchase and never repurchases");
    await context.close();

    reset(); state.authenticated = false;
    context = await browser.newContext(); page = await context.newPage();
    await page.route("https://skyra-booking-dev.myshopify.com/customer_authentication/login?*", (route) => route.fulfill({ body: "Shopify sign-in fixture" }));
    await page.goto(base + "/pages/membership");
    await page.getByRole("button", { name: "Sign in to buy" }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Review pass" }).count(), 0);
    await page.getByRole("button", { name: "Sign in to buy" }).first().click();
    await page.waitForURL("https://skyra-booking-dev.myshopify.com/customer_authentication/login?*");
    const login = new URL(page.url());
    assert.equal(login.searchParams.get("return_to"), "/pages/membership?preview_theme_id=192227082532#membership-options");
    outcomes.push("Signed-out local membership uses canonical Shopify login and preserves preview theme plus membership return anchor");
    await context.close();

    reset(); state.catalogError = true;
    context = await browser.newContext(); page = await context.newPage();
    await page.goto(base + "/pages/membership");
    await page.getByRole("alert").waitFor();
    state.catalogError = false; state.passes = [];
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByRole("button", { name: "Check availability again" }).waitFor();
    state.passes = [pass];
    state.memberships = [{ id: "expired", passPlanId: "monthly", name: pass.name, status: "ACTIVE", blocksPurchase: false, autoRenew: false, expiresAt: "2026-01-02T00:00:00Z", canCancel: false, hasPendingPayment: false }];
    await page.getByRole("button", { name: "Check availability again" }).click();
    await page.getByRole("button", { name: "Review pass" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Review pass" }).isEnabled(), true);
    outcomes.push("Catalog error/empty retries recover; server permits repurchase of an expired one-time pass");
    await context.close();

    reset(); context = await browser.newContext(); page = await context.newPage();
    await page.route("https://checkout.invalid/test", (route) => route.fulfill({ body: "fixture checkout" }));
    await page.goto(base + "/booking-ui");
    await page.locator('.skyra-booking__pass input[value="NEW_PASS:monthly"]').check();
    await page.getByRole("radio", { name: "Automatically renew when this pass expires" }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: "Review your booking" }).waitFor();
    assert.equal(await page.getByRole("checkbox").count(), 2);
    await page.getByRole("checkbox").nth(0).check();
    assert.equal(await page.getByRole("button", { name: "Continue to Shopify Checkout" }).isDisabled(), true);
    await page.getByRole("checkbox").nth(1).check();
    await page.getByRole("button", { name: "Continue to Shopify Checkout" }).click();
    await page.waitForURL("https://checkout.invalid/test");
    assert.equal(state.checkoutRequests[0].autoRenew, true);
    assert.deepEqual(state.checkoutRequests[0].autoRenewAcceptance, { accepted: true, version: "2026-10-02.v1" });
    outcomes.push("Booking selected-pass path submits explicit renewal consent and existing checkout contract");
    await context.close();
    assert.deepEqual([...new Set(membershipRequests.map((request) => request.pathname))].sort(), [
      "/apps/skyra-booking/memberships/cancel",
      "/apps/skyra-booking/memberships/catalog",
      "/apps/skyra-booking/memberships/purchase",
      "/apps/skyra-booking/memberships/result",
    ], "Membership requests must match the generated slash-separated app proxy routes");
    assert.ok(membershipRequests.every((request) => request.method === "POST"));
    outcomes.push("All four membership operations use exact POST /apps/skyra-booking/memberships/{operation} routes");
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ passed: true, evidence: "Local deterministic browser API fixtures only; no live Shopify payment", outcomes }, null, 2));
    console.log(JSON.stringify({ passed: true, outcomes }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; server.close(); });
