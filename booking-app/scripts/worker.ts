import "dotenv/config";
import { markStaleNotificationsUnknown } from "../app/services/booking-notifications.server";
import {
  processPaidBookingEvent,
  recordPaidBookingFailure,
} from "../app/services/paid-booking.server";
import { Queue, Worker } from "bullmq";
import db from "../app/db.server";
import { unauthenticated } from "../app/shopify.server";
import {
  syncCatalogEvent,
  recordSyncFailure,
} from "../app/services/shopify-catalog.server";
import { log } from "../app/lib/log.server";
import { expireBookingWork } from "../app/services/booking.server";
const connection = {
  url: process.env.REDIS_URL || "redis://127.0.0.1:56379",
  maxRetriesPerRequest: null,
};
const queue = new Queue("skyra-catalog", { connection });
const worker = new Worker(
  "skyra-catalog",
  async (job) => {
    const event = await db.outboxEvent.findUniqueOrThrow({
      where: { id: job.data.id },
    });
    if (event.kind === "ORDER_PAID_RECEIVED") {
      try {
        await processPaidBookingEvent(event.id);
      } catch {
        await recordPaidBookingFailure(event.id);
        log.warn({ eventId: event.id }, "Paid booking processing failed");
      }
      return;
    }
    const shop = await db.shop.findUniqueOrThrow({
      where: { id: event.shopId },
    });
    try {
      const { admin } = await unauthenticated.admin(shop.domain);
      await syncCatalogEvent(event.id, admin.graphql);
    } catch (error) {
      await recordSyncFailure(event.id);
      log.warn(
        { err: error, eventId: event.id },
        "Catalogue synchronization failed",
      );
    }
  },
  { connection, concurrency: 2 },
);
let dispatching = false;
async function dispatch() {
  if (dispatching) return;
  dispatching = true;
  try {
    const events = await db.outboxEvent.findMany({
      where: {
        kind: { in: ["CATALOG_SYNC", "ORDER_PAID_RECEIVED"] },
        status: "PENDING",
        availableAt: { lte: new Date() },
      },
      take: 50,
      orderBy: { createdAt: "asc" },
    });
    for (const event of events)
      await queue.add(
        "sync",
        { id: event.id },
        {
          jobId: event.id + "-" + event.attempts,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
  } catch {
    log.error("Outbox dispatch failed");
  } finally {
    dispatching = false;
  }
}
worker.on("error", () => log.error("Queue worker error"));
let sweeping = false;
async function sweepBookings() {
  if (sweeping) return;
  sweeping = true;
  try {
    await expireBookingWork();
    await markStaleNotificationsUnknown();
  } catch {
    log.error("Booking expiry sweep failed");
  } finally {
    sweeping = false;
  }
}
const bookingTimer = setInterval(() => void sweepBookings(), 30000);
await sweepBookings();
const timer = setInterval(() => void dispatch(), 5000);
await dispatch();
async function shutdown() {
  clearInterval(timer);
  clearInterval(bookingTimer);
  await worker.close();
  await queue.close();
  await db.$disconnect();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
