import { useFetcher } from "react-router";
import type { CatalogPurchaseReport } from "../services/shopify-purchasability.server";

export function CatalogAvailability({ mappingId }: { mappingId: string }) {
  const fetcher = useFetcher<{
    availability?: CatalogPurchaseReport;
    error?: string;
  }>();
  const busy = fetcher.state !== "idle";
  const result = busy ? undefined : fetcher.data;
  return (
    <div className="catalog-availability">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="check-availability" />
        <input type="hidden" name="id" value={mappingId} />
        <button
          disabled={busy}
          title="Check the linked Shopify product's sale configuration for Australia / AUD"
        >
          {busy ? "Checking…" : "Check product"}
        </button>
      </fetcher.Form>
      <small className="muted catalog-check-help">
        Shopify sale setup · Does not check class places or enable checkout.
      </small>
      <div role="status" aria-live="polite">
        {result?.error && <p className="sync-error">{result.error}</p>}
        {result?.availability && (
          <>
            <p className="muted">
              {result.availability.ready
                ? "Product checks passed (Australia / AUD)."
                : "Product checks need attention."}{" "}
              Checked {new Date(result.availability.checkedAt).toLocaleString()}
              .
            </p>
            {result.availability.issues.map((issue) => (
              <p className="sync-error" key={issue.code}>
                {issue.message}
              </p>
            ))}
            <small className="muted">
              This check does not enable checkout or reserve a place.
            </small>
          </>
        )}
      </div>
    </div>
  );
}
