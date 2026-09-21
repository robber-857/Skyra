import { z } from "zod";
import type { LoaderFunctionArgs } from "react-router";
import { adminContext } from "../services/context.server";
import { bookingReports } from "../services/booking-reports.server";
import { reportCsv, reportZip } from "../lib/report-exports.server";
export async function loader({ request }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  const url = new URL(request.url),
    kind = z
      .enum(["spending", "unused", "both"])
      .parse(url.searchParams.get("type"));
  const raw = Object.fromEntries(
    ["range", "from", "to", "customer", "q"].flatMap((key) => {
      const value = url.searchParams.get(key);
      return value ? [[key, value]] : [];
    }),
  );
  const report = await bookingReports(actor, raw);
  return new Response(
    kind === "both"
      ? new Uint8Array(reportZip(report))
      : reportCsv(report, kind),
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type":
          kind === "both" ? "application/zip" : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="skyra-${kind}-${report.range.from}-to-${report.range.to}.${kind === "both" ? "zip" : "csv"}"`,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
