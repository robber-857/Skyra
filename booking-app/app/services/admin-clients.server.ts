import { z } from "zod";
import db from "../db.server";
import { requireOperations, type Actor } from "./authorization";
import { DomainError } from "../lib/errors.server";
import { databaseNow } from "./booking.server";
import { clientName } from "./client-identity";

const query = z
  .object({
    q: z.string().trim().max(160).default(""),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
export function clientPassState(
  pass: { status: string; startsAt: Date; expiresAt: Date },
  remaining: number,
  now: Date,
) {
  if (pass.status !== "ACTIVE") return pass.status;
  if (pass.expiresAt <= now) return "EXPIRED";
  if (pass.startsAt > now) return "UPCOMING";
  if (remaining <= 0) return "EXHAUSTED";
  return "ACTIVE";
}
async function shopFor(actor: Actor) {
  requireOperations(actor);
  const shop = await db.shop.findFirst({
    where: { id: actor.shopId, status: "ACTIVE" },
  });
  if (!shop) throw new DomainError("NOT_FOUND", "Studio not found.", 404);
  return shop;
}
export async function adminClients(actor: Actor, raw: unknown) {
  const shop = await shopFor(actor),
    input = query.parse(raw);
  return db.$transaction(
    async (tx) => {
      const now = await databaseNow(tx);
      const where = {
        shopId: shop.id,
        ...(input.q
          ? {
              OR: ["preferredName", "shopifyName", "email"].map((field) => ({
                [field]: { contains: input.q, mode: "insensitive" as const },
              })),
            }
          : {}),
      };
      const total = await tx.customerProfile.count({ where });
      const pages = Math.max(1, Math.ceil(total / 50)),
        page = Math.min(input.page, pages);
      const clients = await tx.customerProfile.findMany({
        where,
        orderBy: [
          { shopifyName: "asc" },
          { preferredName: "asc" },
          { id: "asc" },
        ],
        skip: (page - 1) * 50,
        take: 50,
        select: {
          id: true,
          preferredName: true,
          shopifyName: true,
          email: true,
          createdAt: true,
          _count: { select: { bookings: { where: { shopId: shop.id } } } },
        },
      });
      const balances = await tx.entitlementLedgerEntry.groupBy({
        by: ["entitlementId"],
        where: {
          shopId: shop.id,
          entitlement: {
            shopId: shop.id,
            customerId: { in: clients.map((c) => c.id) },
            status: "ACTIVE",
            startsAt: { lte: now },
            expiresAt: { gt: now },
          },
        },
        _sum: { availableDelta: true, reservedDelta: true },
      });
      const passes = await tx.entitlement.findMany({
        where: {
          shopId: shop.id,
          id: { in: balances.map((b) => b.entitlementId) },
        },
        select: { id: true, customerId: true, expiresAt: true },
      });
      return {
        q: input.q,
        page,
        pages,
        total,
        timezone: shop.timezone,
        clients: clients.map((c) => {
          const active = passes
            .filter((p) => p.customerId === c.id)
            .map((p) => ({
              ...p,
              balance: balances.find((b) => b.entitlementId === p.id)!,
            }))
            .filter(
              (p) =>
                (p.balance._sum.availableDelta || 0) +
                  (p.balance._sum.reservedDelta || 0) >
                0,
            );
          return {
            id: c.id,
            name: clientName(c),
            email: c.email,
            joinedAt: c.createdAt.toISOString(),
            bookings: c._count.bookings,
            activePasses: active.length,
            remaining: active.reduce(
              (sum, p) =>
                sum +
                (p.balance._sum.availableDelta || 0) +
                (p.balance._sum.reservedDelta || 0),
              0,
            ),
            nextExpiry: active.length
              ? new Date(
                  Math.min(...active.map((p) => p.expiresAt.getTime())),
                ).toISOString()
              : null,
          };
        }),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
export async function adminClientDetail(
  actor: Actor,
  rawId: unknown,
  raw: unknown = {},
) {
  const shop = await shopFor(actor),
    id = z.string().uuid().parse(rawId);
  const input = z
    .object({ passPage: z.coerce.number().int().min(1).max(100000).default(1) })
    .strict()
    .parse(raw);
  return db.$transaction(
    async (tx) => {
      const now = await databaseNow(tx);
      const client = await tx.customerProfile.findFirst({
        where: { shopId: shop.id, id },
        select: {
          id: true,
          preferredName: true,
          shopifyName: true,
          email: true,
          signature: true,
          trainingGoals: true,
          avatarBytes: true,
          avatarMimeType: true,
          createdAt: true,
          contactSyncedAt: true,
        },
      });
      if (!client) throw new DomainError("NOT_FOUND", "Client not found.", 404);
      const where = { shopId: shop.id, customerId: id };
      const total = await tx.entitlement.count({ where }),
        pages = Math.max(1, Math.ceil(total / 25)),
        page = Math.min(input.passPage, pages);
      const passes = await tx.entitlement.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * 25,
        take: 25,
        include: {
          passPlan: { select: { name: true } },
          service: { select: { name: true } },
        },
      });
      const ledger = await tx.entitlementLedgerEntry.groupBy({
        by: ["entitlementId"],
        where: {
          shopId: shop.id,
          entitlementId: { in: passes.map((p) => p.id) },
        },
        _sum: {
          availableDelta: true,
          reservedDelta: true,
          consumedDelta: true,
        },
      });
      const bookingCount = await tx.booking.count({ where });
      const bookings = await tx.booking.findMany({
        where,
        take: 10,
        orderBy: [{ session: { startsAt: "desc" } }, { id: "desc" }],
        select: {
          id: true,
          status: true,
          checkedInAt: true,
          customerComment: true,
          session: {
            select: {
              startsAt: true,
              timezone: true,
              service: { select: { name: true } },
              coach: { select: { name: true } },
            },
          },
        },
      });
      return {
        client: {
          id: client.id,
          name: clientName(client),
          preferredName: client.preferredName,
          shopifyName: client.shopifyName,
          email: client.email,
          signature: client.signature,
          trainingGoals: client.trainingGoals,
          joinedAt: client.createdAt.toISOString(),
          syncedAt: client.contactSyncedAt?.toISOString() || null,
          avatarDataUrl:
            client.avatarBytes && client.avatarMimeType
              ? `data:${client.avatarMimeType};base64,${Buffer.from(client.avatarBytes).toString("base64")}`
              : null,
        },
        timezone: shop.timezone,
        asOf: now.toISOString(),
        page,
        pages,
        total,
        passes: passes.map((p) => {
          const sum = ledger.find((l) => l.entitlementId === p.id)?._sum;
          const available = sum?.availableDelta || 0,
            reserved = sum?.reservedDelta || 0,
            used = sum?.consumedDelta || 0;
          return {
            id: p.id,
            name: p.passPlan?.name || p.service?.name || "Class credit",
            granted: p.grantedUnits,
            available,
            reserved,
            used,
            remaining: available + reserved,
            status: clientPassState(p, available + reserved, now),
            startsAt: p.startsAt.toISOString(),
            expiresAt: p.expiresAt.toISOString(),
            validityDays: Math.round(
              (p.expiresAt.getTime() - p.startsAt.getTime()) / 86400000,
            ),
            daysLeft: Math.max(
              0,
              Math.ceil((p.expiresAt.getTime() - now.getTime()) / 86400000),
            ),
          };
        }),
        bookingCount,
        bookings: bookings.map((b) => ({
          id: b.id,
          status: b.status,
          checkedIn: !!b.checkedInAt,
          comment: b.customerComment,
          className: b.session.service.name,
          coachName: b.session.coach.name,
          startsAt: b.session.startsAt.toISOString(),
          timezone: b.session.timezone,
        })),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
