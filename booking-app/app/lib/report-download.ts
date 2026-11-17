// Use App Bridge's patched fetch so the embedded request carries its session token.
// Never navigate the iframe to a protected attachment URL.
export async function fetchReportFile(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "text/csv, application/zip" },
    cache: "no-store",
  });
  const type = response.headers.get("Content-Type")?.split(";")[0].trim();
  if (!response.ok || !["text/csv", "application/zip"].includes(type || "")) {
    throw new Error(
      response.status === 401 || response.status === 403 || type === "text/html"
        ? "Your session could not download this report. Reopen Skyra Booking and try again."
        : "The report could not be exported. Please try again or contact support.",
    );
  }
  const blob = await response.blob();
  if (!blob.size)
    throw new Error("The server returned an empty file. Please try again.");
  const filename = response.headers
    .get("Content-Disposition")
    ?.match(/filename="([^"\r\n]+)"/)?.[1];
  return {
    blob,
    filename:
      filename?.replace(/[\\/]/g, "_") ||
      `skyra-report.${type === "application/zip" ? "zip" : "csv"}`,
  };
}
export async function downloadReport(url: string) {
  const { blob, filename } = await fetchReportFile(url);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
}
