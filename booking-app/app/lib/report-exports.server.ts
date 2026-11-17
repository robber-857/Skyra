import { DateTime } from "luxon";
import type { bookingReports } from "../services/booking-reports.server";
type Report = Awaited<ReturnType<typeof bookingReports>>;
const csv = (rows: (string | number)[][]) =>
  "\uFEFF" +
  rows
    .map((row) =>
      row
        .map((value) => {
          let text = String(value);
          if (/^\s*[=+\-@]/.test(text)) text = String.fromCharCode(39) + text;
          return `"${text.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
export function reportCsv(
  report: Report,
  kind: "spending" | "unused" | "purchases",
) {
  const date = (value: string) =>
    DateTime.fromISO(value, { zone: report.range.timezone }).toISODate()!;
  if (kind === "purchases")
    return csv([
      [
        "Customer",
        "Purchase date",
        "Date basis",
        "Pass / class",
        "Purchase amount (AUD; before refunds)",
        "Purchased classes",
        "Used classes",
        "Remaining classes (including reserved)",
        "Unit price (AUD)",
        "Reserved classes",
        "Source",
        "Purchase reference",
        "Usage cutoff (exclusive)",
        "Timezone",
        "Refunds",
        "Amount basis",
      ],
      ...report.purchaseUsage.rows.map((row) => [
        row.customerName,
        date(row.purchasedAt),
        row.dateBasis,
        row.passName,
        row.amountCents == null
          ? "Not recorded"
          : (row.amountCents / 100).toFixed(2),
        row.purchased ?? "Not recorded",
        row.used ?? "Not linked",
        row.remaining ?? "Not linked",
        row.unitPriceCents == null
          ? "Not recorded"
          : (row.unitPriceCents / 100).toFixed(2),
        row.reserved ?? "Not linked",
        row.source,
        row.reference,
        report.purchaseUsage.cutoff,
        report.range.timezone,
        "Not connected",
        row.source === "Booking online"
          ? "Checkout price snapshot; verify discounts against payment records"
          : row.source === "Membership"
            ? "Membership payment receipt"
            : "Manually recorded Cash amount",
      ]),
    ]);
  return kind === "spending"
    ? csv([
        [
          "Customer",
          "Total spend (AUD; Booking online and Cash purchases)",
          "Pass purchases",
          "Refunds (AUD)",
          "Last purchase",
        ],
        ...report.spending.rows.map((row) => [
          row.customerName,
          (row.totalSpendCents / 100).toFixed(2),
          row.passPurchases,
          "Not connected",
          date(row.lastPurchase),
        ]),
      ])
    : csv([
        ["Customer", "Pass", "Purchased", "Used", "Remaining", "Expiry"],
        ...report.unusedPasses.rows.map((row) => [
          row.customerName,
          row.passName,
          row.purchased,
          row.used,
          row.remaining,
          row.expiresAt ? date(row.expiresAt) : "Not activated",
        ]),
      ]);
}
const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
// Uncompressed CSV entries in one standard ZIP. No browser multi-download
// permission, archive dependencies or temporary files required.
export function reportZip(report: Report, includePurchases = false) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  const kinds: ("spending" | "unused" | "purchases")[] = includePurchases
    ? ["spending", "unused", "purchases"]
    : ["spending", "unused"];
  for (const kind of kinds) {
    const filename = Buffer.from(
      `skyra-${kind}-${report.range.from}-to-${report.range.to}.csv`,
    );
    const bytes = Buffer.from(reportCsv(report, kind), "utf8"),
      crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(0x800, 8);
    index.writeUInt16LE(33, 14);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(bytes.length, 20);
    index.writeUInt32LE(bytes.length, 24);
    index.writeUInt16LE(filename.length, 28);
    index.writeUInt32LE(offset, 42);
    central.push(index, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(kinds.length, 8);
  end.writeUInt16LE(kinds.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
