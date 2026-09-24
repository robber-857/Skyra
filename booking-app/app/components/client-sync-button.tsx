import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

type BatchResult = {
  synced?: number;
  nextCursor?: string | null;
  error?: string;
};

export function ClientSyncButton() {
  const fetcher = useFetcher<BatchResult>();
  const processed = useRef<BatchResult>();
  const running = useRef(false);
  const cursor = useRef("");
  const [active, setActive] = useState(false);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (
      !running.current ||
      fetcher.state !== "idle" ||
      !fetcher.data ||
      processed.current === fetcher.data
    )
      return;
    processed.current = fetcher.data;
    const batch = fetcher.data;
    if (batch.error || typeof batch.synced !== "number") {
      running.current = false;
      setActive(false);
      setFailed(true);
      setMessage(batch.error || "Sync could not be completed. Please retry.");
      return;
    }
    setTotal((count) => count + batch.synced!);
    cursor.current = batch.nextCursor || "";
    if (batch.nextCursor) {
      fetcher.submit(
        { intent: "sync", after: batch.nextCursor },
        { method: "post", action: "/app/clients" },
      );
    } else {
      running.current = false;
      setActive(false);
      setMessage("All Shopify customers synced.");
    }
  }, [fetcher]);

  function start() {
    if (running.current) return;
    if (!failed) {
      cursor.current = "";
      setTotal(0);
    }
    processed.current = fetcher.data;
    running.current = true;
    setActive(true);
    setFailed(false);
    setMessage("");
    fetcher.submit(
      { intent: "sync", after: cursor.current },
      { method: "post", action: "/app/clients" },
    );
  }

  return (
    <div>
      <button type="button" disabled={active} onClick={start}>
        {active
          ? `Syncing… ${total} synced`
          : failed
            ? "Retry customer sync"
            : "Sync all Shopify customers"}
      </button>
      {(active || message) && (
        <p
          className={failed ? "feedback error" : "muted"}
          role={failed ? "alert" : "status"}
          aria-live="polite"
        >
          {active
            ? `${total} customers synced. Keep this page open until complete.`
            : `${message} ${total} customers synced in this run.`}
        </p>
      )}
    </div>
  );
}
