import { authenticate } from "../shopify.server";
import db from "../db.server";

import type { Actor } from "./authorization";
export async function adminContext(request: Request) {
  const auth = await authenticate.admin(request);
  const subject = auth.session.onlineAccessInfo?.associated_user;
  if (!subject)
    throw new Response("An online staff session is required.", { status: 403 });
  const shop = await db.shop.upsert({
    where: { domain: auth.session.shop },
    create: { domain: auth.session.shop },
    // A verified Admin session after reinstallation is the activation signal.
    // The uninstall webhook deletes sessions before marking the shop inactive.
    update: { status: "ACTIVE" },
  });
  if (shop.status !== "ACTIVE")
    throw new Response("App access disabled.", { status: 403 });
  const identity = String(subject.id);
  // Only the verified Shopify account owner can bootstrap an administrator.
  const staff = subject.account_owner
    ? await db.staffAccount.upsert({
        where: { shopId_subject: { shopId: shop.id, subject: identity } },
        create: {
          shopId: shop.id,
          subject: identity,
          role: "ADMIN",
          displayName: "Store owner",
        },
        update: {},
      })
    : await db.staffAccount.findUnique({
        where: { shopId_subject: { shopId: shop.id, subject: identity } },
      });
  if (
    !staff ||
    staff.status !== "ACTIVE" ||
    !["ADMIN", "OPERATIONS"].includes(staff.role)
  )
    throw new Response("Ask the store owner to grant Booking access.", {
      status: 403,
    });
  return {
    ...auth,
    shop,
    actor: { shopId: shop.id, actorId: staff.id, role: staff.role } as Actor,
  };
}
