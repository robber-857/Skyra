import db from "../db.server";
import { requireOperations, type Actor } from "./authorization";
export async function bookingOperationsData(
  actor: Actor,
  requestedPage = 1,
  options: { notificationPage?: number; notificationKind?: string } = {},
) {
  requireOperations(actor);
  const pageSize = 8;
  const notificationKind = ["ADMIN", "COACH", "CUSTOMER"].includes(
    options.notificationKind || "",
  )
    ? options.notificationKind!
    : "ALL";
  const notificationWhere = {
    shopId: actor.shopId,
    ...(notificationKind === "ALL" ? {} : { recipientKind: notificationKind }),
  };
  const [totalCount, notificationCount] = await Promise.all([
    db.booking.count({ where: { shopId: actor.shopId } }),
    db.bookingNotification.count({ where: notificationWhere }),
  ]);
  const notificationPages = Math.max(
    1,
    Math.ceil(notificationCount / pageSize),
  );
  const requestedNotificationPage = options.notificationPage ?? 1;
  const notificationPage = Math.min(
    Number.isSafeInteger(requestedNotificationPage) &&
      requestedNotificationPage > 0
      ? requestedNotificationPage
      : 1,
    notificationPages,
  );
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1,
    totalPages,
  );
  const [bookings, receipts, notifications] = await Promise.all([
    db.booking.findMany({
      where: { shopId: actor.shopId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
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
      where: notificationWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (notificationPage - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        bookingId: true,
        createdAt: true,
        template: true,
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
    pagination: { page, pageSize, totalCount, totalPages },
    notifications,
    notificationPagination: {
      page: notificationPage,
      pageSize,
      totalCount: notificationCount,
      totalPages: notificationPages,
      kind: notificationKind,
    },
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
