import { afterEach, expect, test, vi } from "vitest";
import { fetchReportFile } from "../app/lib/report-download";
afterEach(() => vi.unstubAllGlobals());
test("uses fetch instead of document navigation and preserves filters", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response("customer,amount\r\nTest,300", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="skyra-purchases.csv"',
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const url =
    "/app/reports/export?type=purchases&from=2026-07-01&to=2026-09-30&q=Test";
  const file = await fetchReportFile(url);
  expect(fetcher).toHaveBeenCalledWith(
    url,
    expect.objectContaining({ cache: "no-store" }),
  );
  expect(file.filename).toBe("skyra-purchases.csv");
  expect(await file.blob.text()).toContain("Test,300");
});
test.each([200, 401, 403])(
  "rejects Shopify auth HTML (%s) rather than downloading a blank report",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('<script src="app-bridge.js"></script>', {
          status,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );
    await expect(
      fetchReportFile("/app/reports/export?type=both"),
    ).rejects.toThrow("session");
  },
);
test("rejects server errors, empty CSV and failed network requests", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("error", { status: 500 }))
    .mockResolvedValueOnce(
      new Response("", { headers: { "Content-Type": "text/csv" } }),
    )
    .mockRejectedValueOnce(new Error("Network unavailable"));
  vi.stubGlobal("fetch", fetcher);
  await expect(fetchReportFile("/app/reports/export")).rejects.toThrow(
    "could not be exported",
  );
  await expect(fetchReportFile("/app/reports/export")).rejects.toThrow(
    "empty file",
  );
  await expect(fetchReportFile("/app/reports/export")).rejects.toThrow(
    "Network unavailable",
  );
});
