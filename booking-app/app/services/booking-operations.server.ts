import db from "../db.server";
import { requireOperations, type Actor } from "./authorization";
export async function bookingOperationsData(actor: Actor) {
  requireOperations(actor);
  const [bookings, receipts, notifications] = await Promise.all([
    db.booking.findMany({
      where: { shopId: actor.shopId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        status: true,
        createdAt: true,
        session: {
          select: {
            startsAt: true,
            timezone: true,
            service: { select: { name: true } },
          },
        },
      },
    }),
    db.webhookReceipt.findMany({
      where: {
        shopId: actor.shopId,
        status: { in: ["NEEDS_ATTENTION", "FAILED"] },
      },
      orderBy: { receivedAt: "desc" },
      take: 50,
    }),
    db.bookingNotification.findMany({
      where: { shopId: actor.shopId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        bookingId: true,
        recipientKind: true,
        status: true,
        attempts: true,
        lastError: true,
      },
    }),
  ]);
  const events = await db.outboxEvent.findMany({
    where: {
      shopId: actor.shopId,
      aggregateId: { in: receipts.map((r) => r.id) },
      kind: { in: ["ORDER_PAID_REVIEW", "ORDER_PAID_RECEIVED"] },
    },
    select: { aggregateId: true, payload: true, lastError: true },
  });
  return {
    bookings,
    notifications,
    attention: receipts.map((r) => ({
      id: r.id,
      status: r.status,
      receivedAt: r.receivedAt,
      codes: [
        ...new Set(
          events
            .filter((e) => e.aggregateId === r.id)
            .flatMap((e) => {
              const codes = (e.payload as { codes?: unknown }).codes;
              return [
                ...(Array.isArray(codes)
                  ? codes.filter(
                      (c): c is string =>
                        typeof c === "string" && /^[A-Z_]+$/.test(c),
                    )
                  : []),
                ...(e.lastError ? [e.lastError] : []),
              ];
            }),
        ),
      ],
    })),
  };
}
