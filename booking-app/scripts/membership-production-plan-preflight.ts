// Read-only: use the application's existing local installation, never CLI token caches.
import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
const domain = "mf0n6s-zg.myshopify.com";
const database = new URL(process.env.DATABASE_URL || "");
if (
  !["127.0.0.1", "localhost"].includes(database.hostname) ||
  database.pathname !== "/skyra_booking"
)
  throw new Error("Only the local development installation may be inspected.");
const db = new PrismaClient();
try {
  const session = await db.session.findFirst({
    where: { shop: domain, isOnline: false },
    select: { accessToken: true },
  });
  let result: Record<string, unknown> = {
    checkedAt: new Date().toISOString(),
    domain,
    readOnly: true,
    status: "NO_LOCAL_INSTALLATION",
  };
  if (session) {
    const response = await fetch(
      `https://${domain}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({
          query: await fs.readFile(
            "../output/local-preview/membership-shop-plan.graphql",
            "utf8",
          ),
        }),
      },
    );
    const payload = await response.json();
    result = {
      ...result,
      status:
        response.ok &&
        !payload.errors &&
        payload.data?.shop?.myshopifyDomain === domain
          ? "VERIFIED"
          : "UNVERIFIED",
      httpStatus: response.status,
      ...(response.ok &&
      !payload.errors &&
      payload.data?.shop?.myshopifyDomain === domain
        ? { plan: payload.data.shop.plan }
        : {}),
    };
  }
  await fs.writeFile(
    "../output/local-preview/membership-production-plan-20261003.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.$disconnect();
}
