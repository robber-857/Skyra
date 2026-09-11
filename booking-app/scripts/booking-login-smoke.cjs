/* eslint-env node */
// Real-browser UI checks against deterministic local API fixtures; no Shopify login is simulated as a live integration.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const app = path.resolve(__dirname, "..");
const output = path.resolve(app, "../output/playwright/booking-login");
fs.mkdirSync(output, { recursive: true });
const session = {
  id: "qa-class", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), spotsRemaining: 4,
  service: { id: "aerial", name: "Aerial Flow x Stretching x Inversions (Open Level)", description: "A guided aerial class.", durationMin: 55 },
  coach: { id: "karen", name: "Karen Song" }, location: { id: "studio", name: "Skyra Studio" }
};
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (["/booking.js", "/login.js", "/attempt.js", "/calendar.js", "/transaction.js", "/booking.css"].includes(pathname)) {
    res.setHeader("Content-Type", pathname.endsWith("css") ? "text/css" : "text/javascript");
    return res.end(fs.readFileSync(path.join(app, "extensions/skyra-booking-embed/assets", pathname.slice(1))));
  }
  if (pathname === "/theme.css") { res.setHeader("Content-Type", "text/css"); return res.end(fs.readFileSync(path.resolve(app, "../shopify-theme/assets/skyra.css"))); }
  res.setHeader("Content-Type", "text/html");
  const surface = pathname === "/" ? "home" : "programs";
  const template = fs.readFileSync(path.resolve(app, "../shopify-theme/sections/skyra-" + surface + ".liquid"), "utf8");
  const prefix = template.slice(0, template.indexOf('id="skyra-booking-' + surface + '"'));
  const wrapper = [...prefix.matchAll(/<section[^>]*class="([^"]+)"/g)].at(-1)[1];
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/booking.css"><style>body{margin:0;padding:24px;background:#f3f2ef;font-family:Arial,sans-serif}.qa-label{font:12px Arial;color:#666;margin:0 0 24px}.qa-panel{max-width:1400px;margin:auto;padding:clamp(16px,4vw,60px);background:white;border-radius:20px}h2,h3,p{overflow-wrap:break-word}@media(max-width:720px){body{padding:12px}}</style></head><body><p class="qa-label">LOCAL UI TEST · Sample schedule · No live booking or payment</p><main class="${wrapper}"><div id="skyra-booking-${surface}" data-skyra-booking-root data-surface="${surface}"></div></main><script src="/calendar.js" defer></script><script src="/transaction.js" defer></script><script src="/booking.js" defer></script><script src="/login.js" defer></script><script src="/attempt.js" defer></script></body></html>`);
});
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const results = [];
  try {
    for (const surface of ["home", "programs"]) {
      for (const width of [320, 390, 430, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        let signedIn = false, authError = false, delay = 0, calls = 0, attemptEnded = false;
        const errors = [];
        page.on("pageerror", e => errors.push(e.message));
        await context.route("**/apps/skyra-booking/sessions?*", route => route.fulfill({ json: { timezone: "Australia/Sydney", sessions: [session] } }));
        const attemptSurface = surface.toUpperCase();
        const fixtureToken = "a".repeat(43);
        const snapshot = () => ({ token: fixtureToken, surface: attemptSurface, status: attemptEnded ? "EXPIRED" : signedIn ? "STARTED" : "LOGIN_REQUIRED", requiresLogin: !signedIn, session: { ...session, timezone: "Australia/Sydney", bookingStatus: "OPEN" }, returnPath: (surface === "home" ? "/" : "/pages/programs") + "?skyra_attempt=" + fixtureToken + "#skyra-booking-" + surface });
        await context.route("**/apps/skyra-booking/{start,attempt}", async route => {
          calls++;
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          await route.fulfill({ status: authError ? 503 : 200, json: authError ? { error: "We could not verify your sign-in status. Please try again." } : snapshot() });
        });
        let passPrice = 22000, passError = null;
        await context.route("**/apps/skyra-booking/pass-options", route => {
          if (passError) return route.fulfill({status:passError.status, json:{code:passError.code,error:passError.message}});
          const pass = {id:"test-pass",name:"5 Aerial Classes",credits:5,validityDays:90,priceCents:passPrice,currency:"AUD"};
          return route.fulfill({json:{passes:[pass],selected:route.request().postDataJSON().passPlanId ? pass : null,checkoutAvailable:false}});
        });
        const url = base + (surface === "home" ? "/" : "/pages/programs");
        const key = "skyra-booking:" + surface + ":selection";
        await page.goto(url);
        const book = page.locator("[data-booking-book]");
        await book.waitFor();
        const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
          elements: [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => [el.tagName, el.className, el.getBoundingClientRect().width]) }));
        assert(overflow.scroll <= width, JSON.stringify(overflow));
        const rootBox = await page.locator("[data-skyra-booking-root]").boundingBox();
        if(width === 1440) assert(rootBox.width > 1000, "Desktop Booking must span the wide panel");
        assert.equal(await page.getByRole("button",{name:"Previous 7 days"}).isDisabled(),true);
        const firstDate = await page.locator("[data-booking-date]").first().getAttribute("data-booking-date");
        for(let week=0;week<4;week++) await page.getByRole("button",{name:"Next 7 days"}).click();
        assert.equal(await page.getByRole("button",{name:"Next 7 days"}).isDisabled(),true);
        assert.equal(await page.locator("[data-booking-date]").count(),3);
        for(let week=0;week<4;week++) await page.getByRole("button",{name:"Previous 7 days"}).click();
        assert.equal(await page.locator("[data-booking-date][aria-pressed=true]").getAttribute("data-booking-date"),firstDate);
        await page.getByText("Full calendar",{exact:true}).click();
        const futureDate = await page.locator("[data-calendar-date]:not([disabled])").nth(7).getAttribute("data-calendar-date");
        await page.locator(`[data-calendar-date="${futureDate}"]`).click();
        await page.getByText("No published classes",{exact:false}).waitFor();
        await page.getByText("Full calendar",{exact:true}).click();
        await page.locator("[data-calendar-date]:not([disabled])").first().click();
        await page.locator("[data-booking-service]").selectOption("aerial");
        await page.locator("[data-booking-coach]").selectOption("karen");
        await book.click();
        const dialog = page.getByRole("dialog");
        await dialog.locator("[data-login-open]").waitFor({ state: "visible" });
        assert.equal(await dialog.count(), 1);
        assert.equal(await page.locator("[data-booking-service]").inputValue(), "aerial");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const box = await dialog.boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 901);
        for (let i = 0; i < 7; i++) {
          await page.keyboard.press("Tab");
          assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
        }
        await page.screenshot({ path: path.join(output, `${surface}-${width}.png`), fullPage: true });
        await page.keyboard.press("Escape");
        assert.equal(await dialog.count(), 0);
        assert.equal(await book.evaluate(el => el === document.activeElement), true);
        assert.equal(await page.locator("[data-booking-coach]").inputValue(), "karen");
        // A late authentication response must not reopen a cancelled flow.
        delay = 200;
        await book.click();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        assert.equal(await dialog.count(), 0);
        delay = 0;
        // Fail closed, then retry against the server rather than infer login.
        authError = true;
        await book.click();
        await page.getByText("We could not verify your sign-in status.", { exact: false }).waitFor();
        assert.equal(await dialog.locator("[data-login-open]").isVisible(), false);
        authError = false;
        await dialog.getByRole("button", { name: "Check sign-in status" }).click();
        await dialog.locator("[data-login-open]").waitFor({ state: "visible" });
        if (width === 1440) {
          await page.evaluate(() => { window.open = () => null; });
          await dialog.locator("[data-login-open]").click();
          await page.getByText("Your browser blocked", { exact: false }).waitFor();
          const href = await dialog.locator("[data-login-same-tab]").getAttribute("href");
          assert.equal(new URL(href, base).pathname, "/customer_authentication/login");
          assert.equal(new URL(href, base).searchParams.get("return_to"), new URL(url).pathname + "?skyra_attempt=" + fixtureToken + "#skyra-booking-" + surface);
        }
        // Identity changes while the page is open are detected on retry.
        signedIn = true;
        await dialog.getByRole("button", { name: "Check sign-in status" }).click();
        await page.getByRole("heading", { name: "Select a Pass" }).waitFor();
        assert.equal(await dialog.count(), 0);
        await page.getByRole("radio").check();
        passPrice = 22500;
        await page.locator("[data-pass-continue]").click();
        await page.getByRole("heading", { name: "Review your booking" }).waitFor();
        assert.equal(await page.getByRole("button", {name:"Continue to Shopify Checkout"}).isDisabled(),true);
        await page.getByText("$225.00", {exact:true}).waitFor();
        await page.screenshot({path:path.join(output, `${surface}-${width}-review.png`),fullPage:true});
        await page.getByRole("button",{name:"Edit Pass"}).click();
        assert.equal(await page.getByRole("radio").isChecked(),true);
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), null);
        await page.getByRole("button", { name: "Back to schedule" }).click();
        assert.equal(await book.evaluate(el=>el===document.activeElement),true);
        assert.equal(await page.locator("[data-booking-service]").inputValue(),"aerial");
        await page.locator("[data-booking-details]").click();
        // The details CTA uses the same gate, including a session that expired.
        signedIn = false;
        await page.locator("[data-booking-continue]").click();
        await dialog.locator("[data-login-open]").waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        // Same-tab Shopify return: restore selection and verify independently.
        await page.evaluate(({ key, id, pathname }) => {
          const saved = JSON.parse(sessionStorage.getItem(key));
          saved.pending = true;
          sessionStorage.setItem(key, JSON.stringify(saved));
          history.replaceState(null, "", pathname + "?skyra_attempt=" + "a".repeat(43) + "#skyra-booking-" + id);
        }, { key, id: surface, pathname: new URL(url).pathname });
        signedIn = true;
        await page.reload();
        await page.getByRole("heading", { name: "Select a Pass" }).waitFor();
        assert.equal(await page.locator("[data-skyra-booking-root]").count(), 1);
        const currentFilter = "all"; // A fresh document starts with the default filters.
        // A server outage during restoration preserves the opaque token for retry.
        authError = true;
        await page.reload();
        await page.getByRole("button",{name:"Try again",exact:true}).waitFor();
        assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),"skyra-booking:"+surface+":attempt"),fixtureToken);
        authError = false;
        await page.getByRole("button",{name:"Try again",exact:true}).click();
        await page.getByRole("heading",{name:"Select a Pass"}).waitFor();
        // Pass selection re-authenticates after the Shopify session expires.
        await page.getByRole("radio").check();
        signedIn = false;
        passError = {status:401,code:"LOGIN_REQUIRED",message:"Sign in with Shopify to choose a Pass."};
        await page.locator("[data-pass-continue]").click();
        await page.getByRole("button",{name:"Sign in again",exact:true}).click();
        await dialog.locator("[data-login-open]").waitFor({state:"visible"});
        signedIn = true; passError = null;
        await dialog.getByRole("button",{name:"Check sign-in status"}).click();
        await page.getByRole("radio").check();
        passError = {status:409,code:"PASS_UNAVAILABLE",message:"This Pass changed. Choose another Pass."};
        await page.locator("[data-pass-continue]").click();
        await page.getByRole("button",{name:"Choose another Pass",exact:true}).waitFor();
        passError = null;
        await page.getByRole("button",{name:"Choose another Pass",exact:true}).click();
        await page.getByRole("radio").check();
        passError = {status:409,code:"ATTEMPT_EXPIRED",message:"This booking needs to be restarted. Choose the class again."};
        await page.locator("[data-pass-continue]").click();
        await page.getByRole("button",{name:"Choose a class",exact:true}).click();
        await book.waitFor();
        assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),"skyra-booking:"+surface+":attempt"),null);
        assert.equal(await page.locator("[data-booking-service]").inputValue(),currentFilter);
        // A terminal 200 response on Shopify return must leave the login retry loop.
        await page.evaluate(k=>sessionStorage.setItem(k,"a".repeat(43)),"skyra-booking:"+surface+":attempt");
        attemptEnded = true;
        await page.reload();
        await page.getByRole("button",{name:"Choose a class",exact:true}).waitFor();
        assert.equal(await dialog.count(),0);
        assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),"skyra-booking:"+surface+":attempt"),null);
        attemptEnded = false;
        await page.getByRole("button",{name:"Choose a class",exact:true}).click();
        await book.waitFor();
        assert(calls >= 6);
        assert.deepEqual(errors, []);
        results.push({ surface, width, overflow: false, dialog: true, keyboard: true, cancellation: true, retry: true, returnRecovery: true, weekBoundaries:true, recoveryRetry:true, expiredAttempt:true, passChanged:true, passReauth:true });
        await context.close();
      }
    }
    // Follow real browser navigation/window behavior with a controlled Shopify redirect fixture.
    for (const { width, blockedStorage } of [{ width: 390, blockedStorage: false }, { width: 1440, blockedStorage: false }, { width: 390, blockedStorage: true }]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      if (blockedStorage) await context.addInitScript(() => {
        Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("Storage blocked", "SecurityError"); } });
      });
      let signedIn = false;
      await context.route("**/apps/skyra-booking/sessions?*", route => route.fulfill({ json: { timezone: "Australia/Sydney", sessions: [session] } }));
      await context.route("**/apps/skyra-booking/{start,attempt}", route => route.fulfill({ json: {
        token: "b".repeat(43), surface: "PROGRAMS", status: signedIn ? "STARTED" : "LOGIN_REQUIRED", requiresLogin: !signedIn,
        session: { ...session, timezone: "Australia/Sydney", bookingStatus: "OPEN" }, returnPath: "/pages/programs?skyra_attempt=" + "b".repeat(43) + "#skyra-booking-programs"
      } }));
      await context.route("**/customer_authentication/login?*", route => {
        signedIn = true;
        const destination = new URL(route.request().url()).searchParams.get("return_to");
        return route.fulfill({ status: 302, headers: { location: destination } });
      });
      await context.route("**/apps/skyra-booking/pass-options", route => route.fulfill({json:{passes:[],selected:null,checkoutAvailable:false}}));
      const page = await context.newPage();
      await page.goto(base + "/pages/programs");
      await page.locator("[data-booking-book]").click();
      await page.getByRole("dialog").locator("[data-login-open]").click();
      await page.getByRole("heading", { name: "Select a Pass" }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/pages/programs");
      if (width === 1440) {
        await page.waitForTimeout(200);
        assert.equal(context.pages().length, 1);
      }
      results.push({ width, navigation: width === 1440 ? "popup-return" : "same-tab-return", verified: true, fixture: true, blockedStorage });
      await context.close();
    }
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
    console.log("BOOKING_LOGIN_UI_OK " + JSON.stringify(results));
  } finally {
    await browser.close(); server.close();
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
