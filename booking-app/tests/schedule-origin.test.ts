import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createRequestHandler, type ServerBuild } from "react-router";
import { DateTime } from "luxon";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { adminContext } from "../app/services/context.server";
import { action } from "../app/routes/app.schedule";

// Authentication is replaced only in this isolated test. The real running App
// is separately probed without credentials to verify that Shopify still denies it.
vi.mock("../app/services/context.server", () => ({ adminContext: vi.fn() }));
const origin = "https://booking-regression.trycloudflare.com";
let allowedActionOrigins: string[];
beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test database required");
  vi.stubEnv("SHOPIFY_APP_URL", origin);
  allowedActionOrigins = (await import("../react-router.config")).default
    .allowedActionOrigins;
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.mocked(adminContext).mockReset();
});
afterAll(() => db.$disconnect());

function handler(origins = allowedActionOrigins) {
  // Minimal compiled build fixture exercising the installed React Router's
  // single-fetch CSRF check before our real schedule action and database write.
  const build = {
    allowedActionOrigins: origins,
    basename: "/",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    publicPath: "/",
    assetsBuildDirectory: "build/client",
    routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
    assets: {
      routes: {},
      entry: { module: "/entry.js", imports: [] },
      url: "/manifest.js",
      version: "test",
    },
    entry: {
      module: { default: () => new Response("unused"), handleError: () => {} },
    },
    routes: {
      root: { id: "root", path: "", module: { default: () => null } },
      schedule: {
        id: "schedule",
        parentId: "root",
        path: "app/schedule",
        module: { action, default: () => null },
      },
    },
  } as unknown as ServerBuild;
  return createRequestHandler(build, "test");
}
function request(requestOrigin = origin, fields: Record<string, string> = {}) {
  return new Request("http://localhost:3000/app/schedule.data", {
    method: "POST",
    headers: { Origin: requestOrigin },
    body: new URLSearchParams({ intent: "add", ...fields }),
  });
}

test("reproduces the old Bad Request before the schedule action behind a proxy", async () => {
  const response = await handler([])(request());
  expect(response.status).toBe(400);
  expect(vi.mocked(adminContext)).not.toHaveBeenCalled();
});

test("the exact configured public origin saves a draft and a repeated submission stays idempotent", async () => {
  const f = await paidFixture();
  await db.serviceCoach.create({
    data: { shopId: f.shop.id, serviceId: f.service.id, coachId: f.coach.id },
  });
  vi.mocked(adminContext).mockResolvedValue({
    shop: f.shop,
    actor: { shopId: f.shop.id, actorId: randomUUID(), role: "ADMIN" },
  } as Awaited<ReturnType<typeof adminContext>>);
  const requestId = randomUUID();
  const fields = {
    requestId,
    serviceId: f.service.id,
    coachId: f.coach.id,
    weeks: "1",
    localStart: DateTime.fromJSDate(f.session.startsAt, {
      zone: f.location.timezone,
    })
      .plus({ days: 1 })
      .toFormat("yyyy-MM-dd'T'HH:mm"),
  };
  for (let retry = 0; retry < 2; retry++) {
    const response = await handler()(request(origin, fields));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("1 draft session(s) saved.");
  }
  const drafts = await db.classSession.findMany({
    where: { shopId: f.shop.id, dedupeKey: requestId + "-0" },
  });
  expect(drafts).toHaveLength(1);
  expect(drafts[0].status).toBe("DRAFT");
});

test.each([
  "https://another-app.trycloudflare.com",
  "https://booking-regression.trycloudflare.com.attacker.example",
  "https://admin.shopify.com",
  "https://booking-regression.trycloudflare.com:8443",
  "https://untrusted.example",
])(
  "rejects an unconfigured origin before authentication or writes: %s",
  async (requestOrigin) => {
    const response = await handler()(request(requestOrigin));
    expect(response.status).toBe(400);
    expect(vi.mocked(adminContext)).not.toHaveBeenCalled();
  },
);

test("allowing the public origin does not bypass the schedule authentication gate", async () => {
  vi.mocked(adminContext).mockImplementation(async () => {
    throw new Response("Unauthorized", { status: 401 });
  });
  const response = await handler()(request());
  expect(response.status).toBe(401);
  expect(vi.mocked(adminContext)).toHaveBeenCalledOnce();
});

test("Render external URL supplies the exact action origin", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", "");
  vi.stubEnv("HOST", "");
  vi.stubEnv("RENDER_EXTERNAL_URL", "https://skyra-booking-web.onrender.com");
  vi.stubEnv("RENDER_EXTERNAL_HOSTNAME", "");
  vi.resetModules();
  try {
    const renderOrigins = (await import("../react-router.config")).default
      .allowedActionOrigins;
    expect(renderOrigins).toEqual(["skyra-booking-web.onrender.com"]);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});
