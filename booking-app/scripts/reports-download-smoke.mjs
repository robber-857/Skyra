import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import db from "../app/db.server.ts";
import { paidFixture, queuePaid } from "../tests/paid-fixture.ts";
import { processPaidBookingEvent } from "../app/services/paid-booking.server.ts";
import { bookingReports } from "../app/services/booking-reports.server.ts";
import { reportCsv, reportZip } from "../app/lib/report-exports.server.ts";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
if (new URL(process.env.DATABASE_URL).pathname !== "/skyra_booking_test")
  throw Error("Dedicated test DB required");
const out = resolve("../output/playwright/reports-download");
await mkdir(out, { recursive: true });
const f = await paidFixture();
await processPaidBookingEvent((await queuePaid(f)).id);
await db.customerProfile.update({
  where: { id: f.customer.id },
  data: { preferredName: "Report Demo" },
});
const report = await bookingReports(
  { shopId: f.shop.id, actorId: "SMOKE", role: "ADMIN" },
  { range: "month" },
);
const css = await readFile("app/styles/admin.css", "utf8");
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {createMemoryRouter,RouterProvider} from 'react-router';import {AdminReportsView} from './app/components/admin-reports-view';const router=createMemoryRouter([{path:'/app/reports',element:<AdminReportsView data={${JSON.stringify(report)}} error={null}/> }],{initialEntries:['/app/reports']});createRoot(document.getElementById('root')).render(<RouterProvider router={router}/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
let mode = "file";
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/bundle.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(bundle.outputFiles[0].contents);
    return;
  }
  if (url.pathname === "/app/reports/export") {
    requests.push(url);
    if (mode === "html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<script></script>");
      return;
    }
    const all = url.searchParams.get("type") === "all";
    res.writeHead(200, {
      "Content-Type": all ? "application/zip" : "text/csv",
      "Content-Disposition": `attachment; filename="report.${all ? "zip" : "csv"}"`,
    });
    res.end(
      all
        ? reportZip(report, true)
        : reportCsv(report, url.searchParams.get("type")),
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}/app/reports`;
    await page.goto(url);
    const button = page.getByRole("button", {
      name: "Export purchase & usage CSV",
      exact: true,
    });
    await button.waitFor();
    mode = "html";
    await button.click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Reopen Skyra Booking" })
      .waitFor();
    assert.equal(page.url(), url);
    mode = "file";
    const waiting = page.waitForEvent("download");
    await button.click();
    const download = await waiting;
    const path = resolve(out, `purchase-${width}.csv`);
    await download.saveAs(path);
    const csv = await readFile(path, "utf8");
    assert.match(csv, /Report Demo/);
    assert.match(csv, /220.00/);
    assert.match(csv, /44.00/);
    assert.equal(requests.at(-1).searchParams.get("from"), report.range.from);
    assert.equal(requests.at(-1).searchParams.get("to"), report.range.to);
    assert.equal(page.url(), url);
    await page
      .getByRole("button", { name: "Export all reports", exact: true })
      .waitFor();
    const zipWaiting = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export all reports", exact: true })
      .click();
    const zip = await zipWaiting;
    const zipPath = resolve(out, `all-${width}.zip`);
    await zip.saveAs(zipPath);
    const bytes = await readFile(zipPath);
    assert.equal(bytes.readUInt16LE(bytes.length - 12), 3);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "Page must not overflow",
    );
    await page.screenshot({
      path: resolve(out, `reports-${width}.png`),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "PASS: hydrated desktop/tablet/mobile CSV + ZIP downloads; auth HTML stays inline; filters preserved; no page errors or page overflow. App Bridge authentication itself is not simulated.",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await db.$disconnect();
}
