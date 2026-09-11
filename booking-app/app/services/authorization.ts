import { DomainError } from "../lib/errors.server";
export type Actor = {
  shopId: string;
  actorId: string;
  role: "ADMIN" | "OPERATIONS" | "COACH";
};
export function requireOperations(actor: Actor) {
  if (!["ADMIN", "OPERATIONS"].includes(actor.role))
    throw new DomainError("FORBIDDEN", "Operations access required.", 403);
}
