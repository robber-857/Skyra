import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import db from "../app/db.server.ts";
import { paidFixture, queuePaid } from "../tests/paid-fixture.ts";
import { processPaidBookingEvent } from "../app/services/paid-booking.server.ts";
import { issueCoachLogin } from "../app/services/coach-auth.server.ts";
import { previewBookingNotification } from "../app/services/booking-notifications.server.ts";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
if (new URL(process.env.DATABASE_URL).pathname !== "/skyra_booking_test") throw new Error("Coach smoke requires dedicated test database.");
const base = "http://127.0.0.1:3312";
const output = resolve("../output/playwright/coach-booking");
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["node_modules/@react-router/serve/bin.js", "build/server/index.js"], {
  env: { ...process.env, PORT: "3312", HOST: "127.0.0.1", NODE_ENV: "production", SHOPIFY_API_KEY: "local-coach-test", SHOPIFY_API_SECRET: "local-coach-test-only", SHOPIFY_APP_URL: base }, stdio: "pipe",
});
let logs = "";
server.stdout.on("data", (chunk) => { logs += chunk.toString(); });
server.stderr.on("data", (chunk) => { logs += chunk.toString(); });
let browser;
try {
  let ready = false;
  for (let i=0;i<40;i++) {
    try { if ((await fetch(base+"/coach/login")).status===200) { ready=true; break; } } catch { /* booting */ }
    await new Promise(resolve => setTimeout(resolve,250));
  }
  assert.ok(ready, "Production server must start");
  const f = await paidFixture(); await processPaidBookingEvent((await queuePaid(f)).id);
  for (const n of await db.bookingNotification.findMany({ where: { shopId: f.shop.id } })) {
    const email = await previewBookingNotification(f.shop.id, n.id);
    await writeFile(resolve(output, `${n.recipientKind.toLowerCase()}-email.html`), email.html);
  }
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const results = [];
  for (const width of [390,1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const pageErrors=[];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(base+"/coach");
    assert.ok(page.url().endsWith("/coach/login"));
    const login = await issueCoachLogin({ shopId: f.shop.id, actorId: "SMOKE_ADMIN", role: "ADMIN" }, f.coach.id);
    await page.goto(base+"/coach/login#token="+login);
    await page.getByRole("button", { name: "Continue to my schedule" }).click();
    await page.waitForURL(base+"/coach");
    await page.getByRole("heading", { name: "Your classes" }).waitFor();
    await page.getByLabel("Show classes").selectOption("month");
    await page.getByRole("button", { name: "Apply dates" }).click();
    await page.waitForURL(/range=month/);
    assert.ok((await page.locator("body").innerText()).includes("Aerial Foundations"));
    await page.screenshot({ path: resolve(output,`coach-${width}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
    await page.getByLabel("Show classes").selectOption("custom");
    await page.getByLabel("From (custom dates)").fill("2020-01-01");
    await page.getByLabel("To (custom dates)").fill("2020-01-02");
    await page.getByRole("button", { name: "Apply dates" }).click();
    await page.getByText("No classes in this date range.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(base+"/coach/login");
    await page.goto(base+"/coach"); assert.ok(page.url().endsWith("/coach/login"));
    assert.deepEqual(pageErrors,[]);
    results.push({ width, login:true, monthFilter:true, customEmptyState:true, logout:true, noHorizontalOverflow:!overflow, pageErrors });
    await context.close();
  }
  await writeFile(resolve(output,"results.json"),JSON.stringify(results,null,2));
  console.log(JSON.stringify({ status:"COACH_BROWSER_OK", results, output }));
} catch (error) {
  await writeFile(resolve(output,"server.log"), logs);
  throw error;
} finally {
  if(browser) await browser.close();
  server.kill();
  await db.$disconnect();
}
