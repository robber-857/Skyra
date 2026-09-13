import type { Api } from "@shopify/ui-extensions/customer-account.page.render";
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

type View = "upcoming" | "history" | "passes";
type Target = {
  id: string;
  startsAt: string;
  timezone: string;
  coachName: string;
  locationName: string;
};
type Booking = {
  canReschedule: boolean;
  rescheduledTo?: string | null;
  id: string;
  status: string;
  version: number;
  className: string;
  coachName: string;
  locationName: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  canCancel: boolean;
  cancellationOutcome: string;
  cancellationKey: string;
};
type Pass = {
  id: string;
  name: string;
  status: string;
  startsAt: string;
  expiresAt: string;
  available: number;
  reserved: number;
  used: number;
  eligibleClasses: string[];
  history: {
    id: string;
    kind: string;
    availableDelta: number;
    reservedDelta: number;
    consumedDelta: number;
    createdAt: string;
  }[];
  historyTruncated: boolean;
};
type Account = {
  view: View;
  timezone: string;
  bookings: Booking[];
  passes: Pass[];
  nextCursor: string | null;
};

export default async () => {
  render(<AccountPage />, document.body);
};
const labels: Record<string, string> = {
  CONFIRMED: "Confirmed",
  CANCELLED: "Cancelled",
  LATE_CANCEL: "Late cancellation",
  ATTENDED: "Attended",
  NO_SHOW: "Missed class",
  ACTIVE: "Active",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
  GRANT: "Credits added",
  RESERVE: "Reserved for a class",
  RELEASE: "Reservation released",
  CONSUME: "Class credit used",
  ADJUST: "Balance adjustment",
  EXPIRE: "Credits expired",
  REVOKE: "Credits revoked",
};
function date(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
async function api(
  view: View,
  cursor?: string,
  body?: unknown,
  rescheduleBookingId?: string,
): Promise<Account & { options?: Target[] }> {
  // Bind the host global to this extension target; the SDK also exports legacy globals.
  const accountApi = shopify as unknown as Api;
  const configured = accountApi.settings.value.api_url;
  if (typeof configured !== "string" || !configured)
    throw Error(
      "Your booking account is temporarily unavailable. Please contact the studio.",
    );
  const base = new URL(configured);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error(
      "Your booking account is temporarily unavailable. Please contact the studio.",
    );
  const url = new URL(
    rescheduleBookingId ? "/api/customer-reschedule" : "/api/customer-bookings",
    base,
  );
  if (rescheduleBookingId)
    url.searchParams.set("bookingId", rescheduleBookingId);
  else url.searchParams.set("view", view);
  if (cursor) url.searchParams.set("cursor", cursor);
  const token = await accountApi.sessionToken.get();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: abort.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Error(
        response.status === 401
          ? "Please sign in again to view your account."
          : data.error ||
              "We could not update your account. Please refresh and try again.",
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
function AccountPage() {
  const [view, setView] = useState<View>("upcoming");
  const [data, setData] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Booking | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [moving, setMoving] = useState<Booking | null>(null),
    [targets, setTargets] = useState<Target[]>([]),
    [target, setTarget] = useState<Target | null>(null);
  const generation = useRef(0);
  async function load(nextView: View, cursor?: string) {
    const run = ++generation.current;
    setBusy(true);
    setError("");
    setSelected(null);
    setMoving(null);
    setTarget(null);
    try {
      const next = await api(nextView, cursor);
      if (run === generation.current) {
        setData((prev) =>
          cursor && prev?.view === nextView
            ? {
                ...next,
                bookings: [...prev.bookings, ...next.bookings],
                passes: [...prev.passes, ...next.passes],
              }
            : next,
        );
        setUncertain(false);
      }
    } catch (e) {
      if (run === generation.current)
        setError(
          e instanceof Error ? e.message : "Unable to load your account.",
        );
    } finally {
      if (run === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setData(null);
    setNotice("");
    void load(view);
    return () => {
      // This is a request generation counter, not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [view]);
  async function cancel() {
    if (!selected || busy || uncertain) return;
    setBusy(true);
    setError("");
    try {
      await api(view, undefined, {
        bookingId: selected.id,
        expectedVersion: selected.version,
        action: "CANCEL",
        reason: "Customer requested cancellation in their account",
        idempotencyKey: selected.cancellationKey,
      });
      setUncertain(true);
      setNotice(
        "Your booking has been cancelled. You can find it in booking history.",
      );
      await load(view);
    } catch (e) {
      setUncertain(true);
      setError(
        `${e instanceof Error ? e.message : "The cancellation could not be confirmed."} Refresh your account to check the booking before trying again.`,
      );
    } finally {
      setSelected(null);
      setBusy(false);
    }
  }
  async function chooseTime(booking: Booking) {
    setSelected(null);
    setMoving(null);
    setTarget(null);
    setBusy(true);
    setError("");
    try {
      const response = await api(view, undefined, undefined, booking.id);
      setTargets(response.options || []);
      setMoving(booking);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load class times.");
    } finally {
      setBusy(false);
    }
  }
  async function moveBooking() {
    if (!moving || !target || busy || uncertain) return;
    setBusy(true);
    setError("");
    try {
      await api(
        view,
        undefined,
        {
          action: "RESCHEDULE",
          bookingId: moving.id,
          targetSessionId: target.id,
          expectedVersion: moving.version,
          idempotencyKey: moving.cancellationKey,
          reason: "Customer requested another class time",
        },
        moving.id,
      );
      setUncertain(true);
      setNotice("Your booking has moved to the new class time.");
      await load(view);
    } catch (e) {
      setUncertain(true);
      setError(
        (e instanceof Error ? e.message : "Unable to confirm the change.") +
          " Refresh your account to check the booking before trying again.",
      );
    } finally {
      setMoving(null);
      setTarget(null);
      setBusy(false);
    }
  }
  return (
    <s-page heading="My bookings and passes">
      <s-stack gap="base">
        <s-stack direction="inline" gap="small">
          <s-button
            disabled={busy}
            variant={view === "upcoming" ? "primary" : "secondary"}
            onClick={() => setView("upcoming")}
          >
            Upcoming bookings
          </s-button>
          <s-button
            disabled={busy}
            variant={view === "history" ? "primary" : "secondary"}
            onClick={() => setView("history")}
          >
            Booking history
          </s-button>
          <s-button
            disabled={busy}
            variant={view === "passes" ? "primary" : "secondary"}
            onClick={() => setView("passes")}
          >
            My passes
          </s-button>
          <s-button disabled={busy} onClick={() => void load(view)}>
            Refresh
          </s-button>
        </s-stack>
        {error && <s-banner tone="critical">{error}</s-banner>}
        {notice && <s-banner tone="success">{notice}</s-banner>}
        {busy && <s-text>Loading your account…</s-text>}
        {moving && (
          <s-section heading="Choose another class time">
            <s-stack gap="base">
              <s-text>
                Changes are available at least 12 hours before your current
                class. Your credit keeps its original expiry date. If the new
                class cannot be reserved, your current booking stays in place.
              </s-text>
              {targets.length === 0 && (
                <s-text>
                  No other eligible class times are currently available. Your
                  booking is unchanged.
                </s-text>
              )}
              {targets.map((t) => (
                <s-button
                  key={t.id}
                  disabled={busy || uncertain}
                  variant={target?.id === t.id ? "primary" : "secondary"}
                  onClick={() => setTarget(t)}
                >
                  {date(t.startsAt, t.timezone)} · {t.coachName} ·{" "}
                  {t.locationName}
                </s-button>
              ))}
              {target && (
                <s-button
                  variant="primary"
                  disabled={busy || uncertain}
                  onClick={() => void moveBooking()}
                >
                  Confirm new class time
                </s-button>
              )}
              <s-button
                disabled={busy}
                onClick={() => {
                  setMoving(null);
                  setTarget(null);
                }}
              >
                Keep current class
              </s-button>
            </s-stack>
          </s-section>
        )}
        {selected && (
          <s-section heading="Cancel this booking?">
            <s-stack gap="base">
              <s-text>
                {selected.className} ·{" "}
                {date(selected.startsAt, selected.timezone)}
              </s-text>
              <s-text>
                {selected.cancellationOutcome === "CANCELLED"
                  ? "Cancelling at least 12 hours before class releases your reserved credit. Its original expiry date stays the same."
                  : "This is within 12 hours of class. Cancelling uses your reserved class credit."}{" "}
                No payment refund is issued here. The policy is checked again
                when you confirm.
              </s-text>
              <s-stack direction="inline" gap="small">
                <s-button
                  variant="primary"
                  disabled={busy || uncertain}
                  onClick={() => void cancel()}
                >
                  Confirm cancellation
                </s-button>
                <s-button disabled={busy} onClick={() => setSelected(null)}>
                  Keep booking
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        )}
        {data && view !== "passes" && data.bookings.length === 0 && (
          <s-section
            heading={
              view === "upcoming"
                ? "No upcoming bookings"
                : "No booking history yet"
            }
          >
            <s-text>
              Your bookings will appear here once they are confirmed.
            </s-text>
          </s-section>
        )}
        {data &&
          view !== "passes" &&
          data.bookings.map((b) => (
            <s-section key={b.id} heading={b.className}>
              <s-stack gap="small">
                <s-text>
                  {date(b.startsAt, b.timezone)} · {b.timezone}
                </s-text>
                <s-text>
                  {b.coachName} · {b.locationName}
                </s-text>
                <s-badge>
                  {b.rescheduledTo
                    ? "Rescheduled"
                    : labels[b.status] || b.status}
                </s-badge>
                <s-text>Booking {b.id.slice(-8).toUpperCase()}</s-text>
                {b.rescheduledTo && (
                  <s-text>
                    Moved to booking {b.rescheduledTo.slice(-8).toUpperCase()}.
                  </s-text>
                )}
                {b.canReschedule && (
                  <s-button
                    disabled={busy || uncertain}
                    onClick={() => void chooseTime(b)}
                  >
                    Change class time
                  </s-button>
                )}
                {b.canCancel && (
                  <s-button
                    disabled={busy || uncertain}
                    onClick={() => {
                      setMoving(null);
                      setSelected(b);
                    }}
                  >
                    Cancel booking
                  </s-button>
                )}
              </s-stack>
            </s-section>
          ))}
        {data && view === "passes" && data.passes.length === 0 && (
          <s-section heading="No passes yet">
            <s-text>
              Your class passes and credits will appear here after purchase.
            </s-text>
          </s-section>
        )}
        {data &&
          view === "passes" &&
          data.passes.map((p) => (
            <s-section key={p.id} heading={p.name}>
              <s-stack gap="small">
                <s-badge>{labels[p.status] || p.status}</s-badge>
                <s-text>
                  {p.available} available · {p.reserved} reserved · {p.used}{" "}
                  used
                </s-text>
                <s-text>
                  Valid from {date(p.startsAt, data.timezone)} until{" "}
                  {date(p.expiresAt, data.timezone)}
                </s-text>
                <s-text>
                  Eligible classes: {p.eligibleClasses.join(", ")}
                </s-text>
                <s-heading>Recent activity</s-heading>
                {p.history.map((h) => (
                  <s-text key={h.id}>
                    {date(h.createdAt, data.timezone)} ·{" "}
                    {labels[h.kind] || h.kind} · available{" "}
                    {h.availableDelta > 0 ? "+" : ""}
                    {h.availableDelta}, reserved{" "}
                    {h.reservedDelta > 0 ? "+" : ""}
                    {h.reservedDelta}, used {h.consumedDelta > 0 ? "+" : ""}
                    {h.consumedDelta}
                  </s-text>
                ))}
                {p.historyTruncated && (
                  <s-text>
                    Showing the 20 most recent entries. Contact the studio for
                    older activity.
                  </s-text>
                )}
              </s-stack>
            </s-section>
          ))}
        {data?.nextCursor && (
          <s-button
            disabled={busy}
            onClick={() => void load(view, data.nextCursor!)}
          >
            Load more
          </s-button>
        )}
      </s-stack>
    </s-page>
  );
}
