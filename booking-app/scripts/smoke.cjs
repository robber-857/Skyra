const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
(async () => {
  const base = "http://127.0.0.1:3301";
  for (const route of [
    "/app",
    "/app/catalog",
    "/app/schedule",
    "/app/people",
    "/app/settings",
    "/app/bookings",
    "/app/reports",
  ]) {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(base + route, {
        method,
        redirect: "manual",
        headers: {
          Authorization: "Bearer invalid",
          "User-Agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36",
        },
        ...(method === "POST"
          ? {
              body: new URLSearchParams({
                intent: "service",
                name: "Unauthorized",
              }),
            }
          : {}),
      });
      if (![302, 303, 401, 403, 405].includes(response.status))
        throw new Error(
          method + " " + route + " unexpectedly returned " + response.status,
        );
    }
  }
  const invalidHook = await fetch(base + "/webhooks/app/uninstalled", {
    method: "POST",
    body: "{}",
  });
  if (![400, 401].includes(invalidHook.status))
    throw new Error("Unsigned webhook was not rejected");
  const health = await fetch(base + "/health").then((r) => r.json());
  if (health.status !== "ok") throw new Error("Database health failed");
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const views = [];
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Skyra Booking" }).waitFor();
      await page.evaluate(() => {
        const root = document.createElement("div");
        root.dataset.skyraBookingRoot = "";
        root.dataset.surface = "home";
        document.body.append(root);
        const programs = root.cloneNode();
        programs.dataset.surface = "programs";
        document.body.append(programs);
      });
      await page.addStyleTag({
        path: "extensions/skyra-booking-embed/assets/booking.css",
      });
      await page.addScriptTag({
        path: "extensions/skyra-booking-embed/assets/booking.js",
      });
      await page.evaluate(() =>
        document.dispatchEvent(new Event("shopify:section:load")),
      );
      const result = await page.evaluate(() => ({
        width: window.innerWidth,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= window.innerWidth,
        mounts: document.querySelectorAll(
          "[data-skyra-booking-root][data-skyra-mounted]",
        ).length,
        messages: document.querySelectorAll(
          "[data-skyra-booking-root] [role=status]",
        ).length,
      }));
      if (
        !result.noHorizontalOverflow ||
        result.mounts !== 2 ||
        result.messages !== 2
      )
        throw new Error(JSON.stringify(result));
      views.push(result);
    }
    if (errors.length) throw new Error(errors.join("; "));
    fs.mkdirSync("../output/booking", { recursive: true });
    await page.screenshot({
      path: "../output/booking/foundation-smoke.png",
      fullPage: true,
    });
    const report = {
      unauthorizedRequestsRejected: 14,
      unsignedWebhookRejected: true,
      health,
      views,
      pageErrors: errors,
    };
    fs.writeFileSync(
      "../output/booking/smoke.json",
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
