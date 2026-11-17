import { z } from "zod";
import type { LoaderFunctionArgs } from "react-router";
import { adminContext } from "../services/context.server";
import { bookingReports } from "../services/booking-reports.server";
import { reportCsv, reportZip } from "../lib/report-exports.server";
export async function loader({ request }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  const url = new URL(request.url),
    kind = z
      .enum(["spending", "unused", "both", "purchases", "all"])
      .parse(url.searchParams.get("type"));
  const raw = Object.fromEntries(
    ["range", "from", "to", "customer", "q"].flatMap((key) => {
      const value = url.searchParams.get(key);
      return value ? [[key, value]] : [];
    }),
  );
  const report = await bookingReports(actor, raw);
  const zip = kind === "both" || kind === "all";
  return new Response(
    zip
      ? new Uint8Array(reportZip(report, kind === "all"))
      : reportCsv(report, kind),
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": zip ? "application/zip" : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="skyra-${kind}-${report.range.from}-to-${report.range.to}.${zip ? "zip" : "csv"}"`,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
