import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import db from "../app/db.server.ts";
import { paidFixture, queuePaid } from "../tests/paid-fixture.ts";
import { processPaidBookingEvent } from "../app/services/paid-booking.server.ts";
import { reviewCoachAccount } from "../app/services/coach-account-requests.server.ts";
import { deliverCoachLogin } from "../app/services/coach-self-service.server.ts";
import { bookingReports } from "../app/services/booking-reports.server.ts";
import { AdminReportsView } from "../app/components/admin-reports-view.tsx";
import { reportCsv, reportZip } from "../app/lib/report-exports.server.ts";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
if (new URL(process.env.DATABASE_URL).pathname !== "/skyra_booking_test") throw new Error("Dedicated test DB required");
const out = resolve("../output/playwright/coach-registration-reports");
await mkdir(out, { recursive: true });
const fixture = await paidFixture();
await db.customerProfile.update({ where: { id: fixture.customer.id }, data: { preferredName: "Queenie Loh" } });
await processPaidBookingEvent((await queuePaid(fixture)).id);
const actor = { shopId: fixture.shop.id, actorId: "SMOKE_ADMIN", role: "ADMIN" };
const report = await bookingReports(actor, { range: "month" });
const css = await readFile("app/styles/admin.css", "utf8");
const router = createMemoryRouter([{ path: "/app/reports", element: createElement(AdminReportsView, { data: report, error: null }) }], { initialEntries: ["/app/reports"] });
const markup = renderToString(createElement(RouterProvider, { router }));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body>${markup}</body></html>`;
const preview = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:3315");
  if (url.pathname === "/app/reports/export") {
    const kind = url.searchParams.get("type");
    response.writeHead(200, { "Content-Type": kind === "both" ? "application/zip" : "text/csv", "Content-Disposition": `attachment; filename="reports.${kind === "both" ? "zip" : "csv"}"` });
    response.end(kind === "both" ? reportZip(report) : reportCsv(report, kind === "unused" ? "unused" : "spending"));
  } else { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); }
});
await new Promise(resolve => preview.listen(3315, "127.0.0.1", resolve));
// Fake configuration in a dedicated fixture process. No Worker is started,
// every delivery uses an injected mock, and no provider HTTP request is made.
process.env.SKYRA_COACH_LOGIN_SHOP = fixture.shop.domain;
process.env.SKYRA_COACH_MAIL_KEY = "12".repeat(32);
process.env.SHOPIFY_APP_URL = "https://coach-smoke.example.com";
const app = spawn(process.execPath, ["node_modules/@react-router/serve/bin.js", "build/server/index.js"], { env: { ...process.env, PORT: "3314", HOST: "127.0.0.1", NODE_ENV: "production", SHOPIFY_API_KEY: "fixture-only", SHOPIFY_API_SECRET: "fixture-only", SKYRA_MAIL_ENABLED: "true", SKYRA_MAIL_PROVIDER: "resend", RESEND_API_KEY: "fake-key-not-used", SKYRA_MAIL_FROM: "hello@example.com" }, stdio: "pipe" });
let logs = ""; app.stdout.on("data", chunk => { logs += chunk; }); app.stderr.on("data", chunk => { logs += chunk; });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch("http://127.0.0.1:3314/coach/login")).status === 200) { ready = true; break; } } catch { /* booting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const results = [];
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1100 } }), page = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://127.0.0.1:3315/app/reports");
    assert.deepEqual(await page.locator("table").nth(0).locator("th").allTextContents(), ["Customer", "Total spend", "Pass purchases", "Refunds", "Last purchase"]);
    assert.deepEqual(await page.locator("table").nth(1).locator("th").allTextContents(), ["Customer", "Pass", "Purchased", "Used", "Remaining", "Expiry"]);
    assert.equal(await page.locator(".report-block").count(), 2);
    assert.equal(await page.locator(".report-metrics article").count(), 6);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(out, `reports-${width}.png`), fullPage: true });
    await page.locator(".report-date-picker summary").click();
    await page.getByLabel("From", { exact: true }).waitFor({ state: "visible" });
    await page.locator(".report-date-picker summary").click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export both reports", exact: true }).click();
    const download = await downloadPromise; await download.saveAs(resolve(out, `reports-${width}.zip`));
    assert.equal(await download.failure(), null);
    await page.goto("http://127.0.0.1:3314/coach/login");
    await page.getByLabel("Your name", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(out, `login-${width}.png`), fullPage: true });
    if (width === 390) {
      await page.getByLabel("Your name", { exact: true }).fill("Karen");
      await page.getByLabel("Your email", { exact: true }).fill("karen@example.com");
      await page.getByRole("button", { name: "Request coach account", exact: true }).click();
      const requestDialog = page.getByRole("dialog");
      await requestDialog.waitFor(); await requestDialog.getByText("Your account request is with Skyra", { exact: true }).waitFor();
      await page.screenshot({ path: resolve(out, "login-request-success-390.png"), fullPage: true });
      await requestDialog.getByRole("button", { name: "Close", exact: true }).click(); await requestDialog.waitFor({ state: "hidden" });
      await page.getByLabel("Your name", { exact: true }).evaluate(input => input.removeAttribute("minlength"));
      await page.getByLabel("Your name", { exact: true }).fill("K");
      await page.getByRole("button", { name: "Request coach account", exact: true }).click();
      await requestDialog.waitFor(); await requestDialog.getByText("We could not submit your request", { exact: true }).waitFor();
      await page.screenshot({ path: resolve(out, "login-request-error-390.png"), fullPage: true });
      await requestDialog.getByRole("button", { name: "Close", exact: true }).click(); await requestDialog.waitFor({ state: "hidden" });
      const request = await db.coachAccountRequest.findFirstOrThrow({ where: { shopId: fixture.shop.id } });
      assert.equal(request.status, "PENDING"); assert.equal((await db.coach.findUniqueOrThrow({ where: { id: fixture.coach.id } })).loginEmail, null);
      await reviewCoachAccount(actor, { requestId: request.id, decision: "approve", coachId: fixture.coach.id });
      await page.getByLabel("Email", { exact: true }).fill("karen@example.com");
      await page.getByRole("button", { name: "Email me a sign-in link", exact: true }).click();
      await page.getByText("If this email is authorized", { exact: false }).waitFor();
      const job = await db.coachLoginDelivery.findFirstOrThrow({ where: { shopId: fixture.shop.id, status: "PENDING" } });
      let hash = "";
      await deliverCoachLogin(job.id, async mail => { assert.equal(mail.to, "karen@example.com"); hash = new URL(mail.text.split("\n")[1]).hash; return { status: "ACCEPTED", messageId: "mock-accepted" }; });
      await page.goto("http://127.0.0.1:3314/coach/login" + hash);
      await page.getByRole("button", { name: "Continue to my schedule" }).click();
      await page.waitForURL("http://127.0.0.1:3314/coach");
      assert.ok((await db.coach.findUniqueOrThrow({ where: { id: fixture.coach.id } })).loginVerifiedAt);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []); results.push({ width, reportsTables: true, csvZipDownload: true, registrationForm: true, noOverflow: true, pageErrors: errors });
    await context.close();
  }
  await writeFile(resolve(out, "results.json"), JSON.stringify({ results, mockEmailFlow: true, realEmailSent: false, realKarenUat: false }, null, 2));
  console.log(JSON.stringify({ status: "REGISTRATION_REPORTS_OK", results, mockEmailFlow: true, realEmailSent: false, realKarenUat: false, output: out }));
} catch (error) { await writeFile(resolve(out, "server.log"), logs); throw error; }
finally { if (browser) await browser.close(); app.kill(); await new Promise(resolve => preview.close(resolve)); await db.$disconnect(); }
