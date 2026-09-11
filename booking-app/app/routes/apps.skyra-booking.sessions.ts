import type { LoaderFunctionArgs } from "react-router";
import { DateTime } from "luxon";
import db from "../db.server";
import { authenticate } from "../shopify.server";

import {
  classAvailability,
  bookingWindow,
  databaseNow,
} from "../services/booking.server";

const MAX_RANGE_DAYS = 31;
const DEFAULT_RANGE_DAYS = 7;

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store, max-age=0");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function parseBoundary(
  value: string | null,
  fallback: DateTime,
  zone: string,
  end = false,
) {
  if (!value) return fallback;
  const parsed = DateTime.fromISO(value, { zone });
  if (!parsed.isValid) return null;
  return end ? parsed.endOf("day") : parsed.startOf("day");
}

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop");
  if (!shopDomain)
    return json({ error: "Shop context is missing." }, { status: 400 });

  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || shop.status !== "ACTIVE") {
    return json(
      { error: "Booking is unavailable for this store." },
      { status: 404 },
    );
  }

  const clock = await databaseNow(db);
  const now = DateTime.fromJSDate(clock).setZone(shop.timezone);
  const from = parseBoundary(
    url.searchParams.get("from"),
    now.startOf("day"),
    shop.timezone,
  );
  const to = parseBoundary(
    url.searchParams.get("to"),
    now.plus({ days: DEFAULT_RANGE_DAYS - 1 }).endOf("day"),
    shop.timezone,
    true,
  );

  if (
    !from ||
    !to ||
    to < from ||
    to.diff(from, "days").days > MAX_RANGE_DAYS
  ) {
    return json(
      { error: "Choose a valid date range of 31 days or less." },
      { status: 400 },
    );
  }

  const sessions = await db.classSession.findMany({
    where: {
      shopId: shop.id,
      status: "PUBLISHED",
      startsAt: { gte: from.toUTC().toJSDate(), lte: to.toUTC().toJSDate() },
      service: { status: "ACTIVE" },
      coach: { status: "ACTIVE" },
    },
    include: { service: true, coach: true, location: true },
    orderBy: { startsAt: "asc" },
  });

  const availability = await classAvailability(
    shop.id,
    sessions.map((session) => session.id),
  );
  return json({
    timezone: shop.timezone,
    generatedAt: new Date().toISOString(),
    sessions: sessions.map((session) => ({
      id: session.id,
      startsAt: session.startsAt.toISOString(),
      endsAt: session.endsAt.toISOString(),
      capacity: session.capacity,
      spotsRemaining: availability.get(session.id) || 0,
      bookingStatus: bookingWindow(shop, session, clock),
      service: {
        id: session.service.id,
        name: session.service.name,
        description: session.service.description,
        level: session.service.level,
        durationMin: session.service.durationMin,
        categoryId: session.service.categoryId,
      },
      coach: { id: session.coach.id, name: session.coach.name },
      location: { id: session.location.id, name: session.location.name },
    })),
  });
}
