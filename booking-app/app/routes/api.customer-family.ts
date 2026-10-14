import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { customerAccountRequest } from "../services/customer-account-auth.server";
import { familyAccountData, addCustomerFamilyMember } from "../services/family-accounts.server";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";

async function clients(actor: { shopId: string }) {
  const shop = await db.shop.findFirstOrThrow({ where: { id: actor.shopId, status: "ACTIVE" }, select: { domain: true } });
  return (await unauthenticated.admin(shop.domain)).admin.graphql;
}
export function loader({ request }: LoaderFunctionArgs) {
  return customerAccountRequest(request, async (actor) => familyAccountData(actor, await clients(actor)), { resolveMember: false });
}
export function action({ request }: ActionFunctionArgs) {
  return customerAccountRequest(request, async (actor, input) => addCustomerFamilyMember(actor, await clients(actor), input), { resolveMember: false });
}
