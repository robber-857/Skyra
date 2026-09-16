import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import { bookingReports } from "../app/services/booking-reports.server";
import { reportCsv, reportZip } from "../app/lib/report-exports.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
async function report() {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  return bookingReports(
    { shopId: f.shop.id, actorId: "ADMIN_TEST", role: "ADMIN" },
    { range: "month" },
  );
}
test("CSV fields match the two prototype tables and unavailable refunds are not zero", async () => {
  const data = await report();
  expect(reportCsv(data, "spending").split("\r\n")[0]).toContain(
    '"Pass purchases","Refunds (AUD)","Last purchase"',
  );
  expect(reportCsv(data, "spending")).toContain('"Not connected"');
  expect(reportCsv(data, "unused").split("\r\n")[0]).toBe(
    '\uFEFF"Customer","Pass","Purchased","Used","Remaining","Expiry"',
  );
});
test("CSV escapes commas, quotes and whitespace-prefixed formulas", async () => {
  const data = await report();
  data.spending.rows[0].customerName = '  =SUM(1,2) "test"';
  expect(reportCsv(data, "spending")).toContain('"\'  =SUM(1,2) ""test"""');
});
test("Export both creates one ZIP with two CRC-protected CSV entries", async () => {
  const data = await report(),
    zip = reportZip(data);
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  expect(zip.readUInt16LE(zip.length - 12)).toBe(2);
  const text = zip.toString("utf8");
  expect(text).toContain(
    `skyra-spending-${data.range.from}-to-${data.range.to}.csv`,
  );
  expect(text).toContain(
    `skyra-unused-${data.range.from}-to-${data.range.to}.csv`,
  );
  expect(text).toContain(reportCsv(data, "spending"));
  expect(text).toContain(reportCsv(data, "unused"));
});
