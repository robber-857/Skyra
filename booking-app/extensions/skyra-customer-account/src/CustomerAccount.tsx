import type { Api } from "@shopify/ui-extensions/customer-account.page.render";
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { restoredPassNavigation, withPassNavigation } from "./pass-navigation";

type View =
  "overview" | "upcoming" | "history" | "passes" | "appointments" | "profile";
type DataView = "upcoming" | "history" | "passes";
type Target = {
  id: string;
  startsAt: string;
  timezone: string;
  coachName: string;
  locationName: string;
};
type Booking = {
  customerComment?: string;
  serviceKind?: string;
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
  startsAt: string | null;
  expiresAt: string | null;
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
  view: DataView;
  timezone: string;
  bookings: Booking[];
  passes: Pass[];
  nextCursor: string | null;
  page: number;
  totalPages: number;
  totalPasses: number;
};
type Profile = {
  preferredName: string;
  avatarDataUrl: string | null;
  signature: string;
  trainingGoals: string;
};

const emptyProfile: Profile = {
  preferredName: "",
  avatarDataUrl: null,
  signature: "",
  trainingGoals: "",
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
  RESERVE: "Booked an upcoming class",
  RELEASE: "Booking credit returned",
  CONSUME: "Class credit used",
  ADJUST: "Balance adjustment",
  EXPIRE: "Credits expired",
  REVOKE: "Credits revoked",
};
const viewLabels: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "passes", label: "My passes" },
  { id: "upcoming", label: "Bookings" },
  { id: "profile", label: "Training profile" },
];

export default async () => {
  render(<AccountPage />, document.body);
};

function extensionApi() {
  return shopify as unknown as Api;
}

function apiBase() {
  const configured = extensionApi().settings.value.api_url;
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
  return base;
}

function findClassUrl() {
  const configured = extensionApi().settings.value.booking_url;
  if (typeof configured !== "string" || !configured) return "";
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    url.hash = "skyra-booking-programs";
    return url.href;
  } catch {
    return "";
  }
}

async function request<T>(
  path: string,
  options: { method?: "POST"; body?: unknown } = {},
): Promise<T> {
  const url = new URL(path, apiBase());
  const token = await extensionApi().sessionToken.get();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
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

function accountData(view: DataView, cursor?: string, page?: number) {
  const path = new URL("/api/customer-bookings", apiBase());
  path.searchParams.set("view", view);
  if (cursor) path.searchParams.set("cursor", cursor);
  if (page !== undefined) path.searchParams.set("page", String(page));
  return request<Account>(path.href);
}

function profileData(body?: Profile) {
  return request<Profile>("/api/customer-profile", {
    ...(body ? { method: "POST" as const, body } : {}),
  });
}

function rescheduleOptions(bookingId: string) {
  const path = new URL("/api/customer-reschedule", apiBase());
  path.searchParams.set("bookingId", bookingId);
  return request<Account & { options?: Target[] }>(path.href);
}

function changeBooking(body: unknown, reschedule = false) {
  return request<Account>(
    reschedule ? "/api/customer-reschedule" : "/api/customer-bookings",
    { method: "POST", body },
  );
}

function date(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function shortDate(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    dateStyle: "medium",
  }).format(new Date(value));
}

function isAppointment(booking: Booking) {
  return booking.serviceKind === "APPOINTMENT";
}

function fieldValue(event: Event) {
  return (event.currentTarget as unknown as { value: string }).value;
}

function AccountPage() {
  const initialPassState = restoredPassNavigation(
    navigation.currentEntry.getState(),
  );
  const [view, setView] = useState<View>(
    initialPassState.active ? "passes" : "overview",
  );
  const passPage = useRef(initialPassState.page);
  const [data, setData] = useState<Account | null>(null);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [draft, setDraft] = useState<Profile>(emptyProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [avatarError, setAvatarError] = useState("");
  const [selected, setSelected] = useState<Booking | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [moving, setMoving] = useState<Booking | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const generation = useRef(0);
  const bookingUrl = findClassUrl();

  async function load(
    nextView: View,
    cursor?: string,
    requestedPage = passPage.current,
  ) {
    const run = ++generation.current;
    setBusy(true);
    setError("");
    setSelected(null);
    setMoving(null);
    setTarget(null);
    try {
      if (nextView === "profile") {
        const nextProfile = await profileData();
        if (run === generation.current) {
          setProfile(nextProfile);
          setDraft(nextProfile);
          setData(null);
        }
      } else if (nextView === "overview") {
        const [upcoming, passes, nextProfile] = await Promise.all([
          accountData("upcoming"),
          accountData("passes"),
          profileData(),
        ]);
        if (run === generation.current) {
          setData({ ...upcoming, passes: passes.passes, nextCursor: null });
          setProfile(nextProfile);
          setDraft(nextProfile);
        }
      } else if (nextView === "passes") {
        const next = await accountData("passes", undefined, requestedPage);
        if (run === generation.current) {
          setData(next);
          passPage.current = next.page;
          navigation.updateCurrentEntry({
            state: withPassNavigation(
              navigation.currentEntry.getState(),
              true,
              next.page,
            ),
          });
        }
      } else if (nextView === "appointments") {
        const [upcoming, history] = await Promise.all([
          accountData("upcoming"),
          accountData("history"),
        ]);
        if (run === generation.current)
          setData({
            ...upcoming,
            bookings: [...upcoming.bookings, ...history.bookings].filter(
              isAppointment,
            ),
            nextCursor: null,
          });
      } else {
        const next = await accountData(nextView, cursor);
        if (run === generation.current)
          setData((previous) =>
            cursor && previous?.view === nextView
              ? {
                  ...next,
                  bookings: [...previous.bookings, ...next.bookings],
                  passes: [...previous.passes, ...next.passes],
                }
              : next,
          );
      }
      if (run === generation.current) {
        setUncertain(false);
        if (nextView !== "passes") {
          navigation.updateCurrentEntry({
            state: withPassNavigation(
              navigation.currentEntry.getState(),
              false,
              passPage.current,
            ),
          });
        }
      }
    } catch (caught) {
      if (run === generation.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "Unable to load your account.",
        );
    } finally {
      if (run === generation.current) setBusy(false);
    }
  }

  useEffect(() => {
    setData(null);
    setNotice("");
    setAvatarError("");
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
      await changeBooking({
        bookingId: selected.id,
        expectedVersion: selected.version,
        action: "CANCEL",
        reason: "Customer requested cancellation in their account",
        idempotencyKey: selected.cancellationKey,
      });
      setUncertain(true);
      setNotice(
        "Your booking has been cancelled. You can find it under Past & cancelled.",
      );
      await load(view);
    } catch (caught) {
      setUncertain(true);
      setError(
        `${
          caught instanceof Error
            ? caught.message
            : "The cancellation could not be confirmed."
        } Refresh your account to check the booking before trying again.`,
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
      const response = await rescheduleOptions(booking.id);
      setTargets(response.options || []);
      setMoving(booking);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load class times.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function moveBooking() {
    if (!moving || !target || busy || uncertain) return;
    setBusy(true);
    setError("");
    try {
      await changeBooking(
        {
          action: "RESCHEDULE",
          bookingId: moving.id,
          targetSessionId: target.id,
          expectedVersion: moving.version,
          idempotencyKey: moving.cancellationKey,
          reason: "Customer requested another class time",
        },
        true,
      );
      setUncertain(true);
      setNotice("Your booking has moved to the new class time.");
      await load(view);
    } catch (caught) {
      setUncertain(true);
      setError(
        (caught instanceof Error
          ? caught.message
          : "Unable to confirm the change.") +
          " Refresh your account to check the booking before trying again.",
      );
    } finally {
      setMoving(null);
      setTarget(null);
      setBusy(false);
    }
  }

  async function chooseAvatar(event: Event) {
    const files = (
      event.currentTarget as unknown as { files?: readonly File[] }
    ).files;
    const file = files?.[0];
    if (!file) return;
    setAvatarError("");
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 524288
    ) {
      setAvatarError("Choose a PNG, JPEG or WebP image no larger than 512 KB.");
      return;
    }
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          typeof reader.result === "string"
            ? resolve(reader.result)
            : reject(new Error());
        reader.onerror = () => reject(reader.error || new Error());
        reader.readAsDataURL(file);
      });
      setDraft((current) => ({ ...current, avatarDataUrl: result }));
    } catch {
      setAvatarError("We could not read that image. Choose another file.");
    }
  }

  async function saveProfile() {
    if (busy || avatarError) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await profileData(draft);
      setProfile(saved);
      setDraft(saved);
      setNotice("Profile saved.");
      extensionApi().toast.show("Profile saved");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to save profile.",
      );
    } finally {
      setBusy(false);
    }
  }

  const initials = (draft.preferredName || "Skyra member")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <s-page heading="My Skyra">
      <s-query-container>
        <s-stack direction="block" gap="large-100">
          <s-stack
            id="account-navigation"
            direction="inline"
            gap="small"
            alignItems="center"
          >
            {viewLabels.map((item) => (
              <s-button
                key={item.id}
                disabled={busy}
                variant={
                  view === item.id ||
                  (item.id === "upcoming" &&
                    (view === "history" || view === "appointments"))
                    ? "primary"
                    : "secondary"
                }
                onClick={() => setView(item.id)}
              >
                {item.label}
              </s-button>
            ))}
          </s-stack>
          <s-divider />
          {error && (
            <s-stack direction="block" gap="small">
              <s-banner tone="critical">{error}</s-banner>
              <s-button disabled={busy} onClick={() => void load(view)}>
                Refresh
              </s-button>
            </s-stack>
          )}
          {notice && <s-banner tone="success">{notice}</s-banner>}
          {busy && (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-spinner size="small" accessibilityLabel="Loading account" />
                <s-text color="subdued">Loading your Skyra account…</s-text>
              </s-stack>
            </s-box>
          )}
          {moving && (
            <s-section heading="Choose another class time">
              <s-stack gap="base">
                <s-text>
                  Changes are available at least 12 hours before your current
                  booking. Your credit keeps its original expiry date.
                </s-text>
                {targets.length === 0 && (
                  <s-text>
                    No other eligible times are available. Your booking is
                    unchanged.
                  </s-text>
                )}
                {targets.map((option) => (
                  <s-button
                    key={option.id}
                    disabled={busy || uncertain}
                    variant={target?.id === option.id ? "primary" : "secondary"}
                    onClick={() => setTarget(option)}
                  >
                    {date(option.startsAt, option.timezone)} ·{" "}
                    {option.coachName}
                  </s-button>
                ))}
                {target && (
                  <s-button
                    variant="primary"
                    disabled={busy || uncertain}
                    onClick={() => void moveBooking()}
                  >
                    Confirm new time
                  </s-button>
                )}
                <s-button
                  disabled={busy}
                  onClick={() => {
                    setMoving(null);
                    setTarget(null);
                  }}
                >
                  Keep current booking
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
                    ? "Cancelling at least 12 hours before the start returns the class credit to your pass."
                    : "This is within 12 hours of the start. Cancelling will use the class credit."}{" "}
                  No payment refund is issued here.
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
          {view === "overview" && data && (
            <Overview
              account={data}
              profile={profile}
              bookingUrl={bookingUrl}
              open={setView}
            />
          )}
          {view === "passes" && data && (
            <s-stack gap="base">
              <Passes account={data} />
              <PassPagination
                account={data}
                busy={busy}
                changePage={(page) => void load("passes", undefined, page)}
              />
            </s-stack>
          )}
          {(view === "upcoming" || view === "history") && data && (
            <Bookings
              account={data}
              view={view}
              open={setView}
              busy={busy}
              uncertain={uncertain}
              select={setSelected}
              move={chooseTime}
            />
          )}
          {view === "appointments" && data && (
            <Appointments
              account={data}
              bookingUrl={bookingUrl}
              busy={busy}
              uncertain={uncertain}
              select={setSelected}
              move={chooseTime}
            />
          )}
          {view === "profile" && (
            <s-stack gap="base">
              <s-banner>
                Shopify continues to manage your account name, email and
                addresses. Training profile stores only your Skyra photo,
                preferred name, signature and training goals.
              </s-banner>
              <s-section heading="Training profile">
                <s-stack gap="base">
                  <s-stack
                    direction="inline"
                    gap="base"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <s-stack gap="small">
                      <s-heading>
                        {draft.preferredName || "Skyra member"}
                      </s-heading>
                      {draft.signature && <s-text>{draft.signature}</s-text>}
                    </s-stack>
                    <s-avatar
                      size="large-200"
                      initials={initials}
                      src={draft.avatarDataUrl || undefined}
                      alt="Your Skyra profile avatar"
                    />
                  </s-stack>
                  <s-divider />
                  <s-drop-zone
                    label="Upload profile photo"
                    accessibilityLabel="Upload a PNG, JPEG or WebP profile photo"
                    accept="image/png,image/jpeg,image/webp"
                    error={avatarError || undefined}
                    disabled={busy}
                    onChange={(event) => void chooseAvatar(event)}
                  />
                  {draft.avatarDataUrl && (
                    <s-button
                      disabled={busy}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          avatarDataUrl: null,
                        }))
                      }
                    >
                      Remove photo
                    </s-button>
                  )}
                  <s-text>Maximum 512 KB. PNG, JPEG or WebP only.</s-text>
                  <s-text-field
                    label="Preferred name"
                    value={draft.preferredName}
                    maxLength={80}
                    disabled={busy}
                    onInput={(event) =>
                      setDraft((current) => ({
                        ...current,
                        preferredName: fieldValue(event),
                      }))
                    }
                  />
                  <s-text-area
                    label="Signature"
                    value={draft.signature}
                    maxLength={160}
                    rows={3}
                    disabled={busy}
                    onInput={(event) =>
                      setDraft((current) => ({
                        ...current,
                        signature: fieldValue(event),
                      }))
                    }
                  />
                  <s-text-area
                    label="Training goals"
                    value={draft.trainingGoals}
                    maxLength={1000}
                    rows={6}
                    disabled={busy}
                    onInput={(event) =>
                      setDraft((current) => ({
                        ...current,
                        trainingGoals: fieldValue(event),
                      }))
                    }
                  />
                  <s-button
                    variant="primary"
                    loading={busy}
                    disabled={busy || !!avatarError}
                    onClick={() => void saveProfile()}
                  >
                    Save training profile
                  </s-button>
                </s-stack>
              </s-section>
            </s-stack>
          )}
          {data?.nextCursor && (view === "upcoming" || view === "history") && (
            <s-button
              disabled={busy}
              onClick={() => void load(view, data.nextCursor!)}
            >
              Load more
            </s-button>
          )}
          {!bookingUrl && view !== "profile" && (
            <s-banner tone="warning">
              The studio still needs to configure the Find a class storefront
              URL for this account page.
            </s-banner>
          )}
        </s-stack>
      </s-query-container>
    </s-page>
  );
}

function FindClassButton({ href }: { href: string }) {
  return href ? (
    <s-button variant="primary" href={href} target="_blank">
      Find a class
    </s-button>
  ) : (
    <s-button disabled>Find a class</s-button>
  );
}

function Overview({
  account,
  profile,
  bookingUrl,
  open,
}: {
  account: Account;
  profile: Profile;
  bookingUrl: string;
  open: (view: View) => void;
}) {
  const activePass = account.passes.find((pass) => pass.status === "ACTIVE");
  const nextClass = account.bookings.find((booking) => !isAppointment(booking));
  const nextAppointment = account.bookings.find(isAppointment);
  return (
    <s-stack gap="base">
      <s-section
        heading={
          profile.preferredName
            ? `Welcome, ${profile.preferredName}`
            : "My overview"
        }
      >
        <s-stack
          direction="inline"
          gap="base"
          justifyContent="space-between"
          alignItems="center"
        >
          <s-stack gap="small">
            {profile.signature && <s-text>{profile.signature}</s-text>}
            <FindClassButton href={bookingUrl} />
          </s-stack>
          <s-avatar
            size="large-200"
            initials={(profile.preferredName || "SM").slice(0, 2).toUpperCase()}
            src={profile.avatarDataUrl || undefined}
            alt="Your Skyra profile avatar"
          />
        </s-stack>
      </s-section>
      <s-query-container>
        <s-grid
          gap="base"
          gridTemplateColumns="@container (inline-size > 760px) repeat(3, minmax(0, 1fr)), 1fr"
        >
          <s-section heading="Active pass">
            {activePass ? (
              <s-stack gap="small">
                <s-badge>{labels[activePass.status]}</s-badge>
                <s-heading>{activePass.name}</s-heading>
                <s-text>{activePass.available} ready to book</s-text>
                {activePass.reserved > 0 && (
                  <s-text color="subdued">
                    {activePass.reserved} upcoming booking
                    {activePass.reserved === 1 ? "" : "s"} using this pass
                  </s-text>
                )}
                <s-text>
                  {activePass.expiresAt
                    ? `Expires ${shortDate(activePass.expiresAt, account.timezone)}`
                    : "Activates on first booked class"}
                </s-text>
                <s-button onClick={() => open("passes")}>View passes</s-button>
              </s-stack>
            ) : (
              <s-text>No active pass yet.</s-text>
            )}
          </s-section>
          <s-section heading="Next class">
            {nextClass ? (
              <s-stack gap="small">
                <s-badge>
                  {labels[nextClass.status] || nextClass.status}
                </s-badge>
                <s-heading>{nextClass.className}</s-heading>
                <s-text>{date(nextClass.startsAt, nextClass.timezone)}</s-text>
                <s-text>
                  {nextClass.coachName} · {nextClass.locationName}
                </s-text>
                <s-button onClick={() => open("upcoming")}>
                  View booking
                </s-button>
              </s-stack>
            ) : (
              <s-text>No upcoming class.</s-text>
            )}
          </s-section>
          <s-section heading="Next appointment">
            {nextAppointment ? (
              <s-stack gap="small">
                <s-badge>
                  {labels[nextAppointment.status] || nextAppointment.status}
                </s-badge>
                <s-heading>{nextAppointment.className}</s-heading>
                <s-text>
                  {date(nextAppointment.startsAt, nextAppointment.timezone)}
                </s-text>
                <s-text>
                  {nextAppointment.coachName} · {nextAppointment.locationName}
                </s-text>
                <s-button onClick={() => open("upcoming")}>
                  View booking
                </s-button>
              </s-stack>
            ) : (
              <s-text>No upcoming appointment.</s-text>
            )}
          </s-section>
        </s-grid>
      </s-query-container>
      {profile.trainingGoals && (
        <s-section heading="My training goals">
          <s-text>{profile.trainingGoals}</s-text>
        </s-section>
      )}
    </s-stack>
  );
}

function PassPagination({
  account,
  busy,
  changePage,
}: {
  account: Account;
  busy: boolean;
  changePage: (page: number) => void;
}) {
  const [jump, setJump] = useState(String(account.page));
  useEffect(() => setJump(String(account.page)), [account.page]);
  const target = jump.trim() ? Number(jump) : NaN;
  const valid =
    Number.isInteger(target) && target >= 1 && target <= account.totalPages;
  return (
    <s-section heading="Pass pages">
      <s-stack gap="base">
        <s-text>
          5 Passes or class credits per page · {account.totalPasses} total
        </s-text>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button
            disabled={busy || account.page === 1}
            onClick={() => changePage(account.page - 1)}
          >
            Previous
          </s-button>
          <s-stack accessibilityRole="status">
            <s-text>
              {account.page} / {account.totalPages}
            </s-text>
          </s-stack>
          <s-button
            disabled={busy || account.page === account.totalPages}
            onClick={() => changePage(account.page + 1)}
          >
            Next
          </s-button>
        </s-stack>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-number-field
            label="Go to page"
            value={jump}
            min={1}
            max={account.totalPages}
            step={1}
            disabled={busy}
            onInput={(event) => setJump(fieldValue(event))}
          />
          <s-button
            disabled={busy || !valid}
            onClick={() => {
              if (valid) changePage(target);
            }}
          >
            Go
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
function Passes({ account }: { account: Account }) {
  if (!account.passes.length)
    return (
      <s-section heading="No passes yet">
        <s-text>
          Your class passes and credits will appear here after purchase.
        </s-text>
      </s-section>
    );
  return (
    <s-query-container>
      <s-grid
        gap="base"
        gridTemplateColumns="@container (inline-size > 720px) repeat(2, minmax(0, 1fr)), 1fr"
      >
        {account.passes.map((pass) => (
          <s-section key={pass.id} heading={pass.name}>
            <s-stack direction="block" gap="small">
              <s-badge>{labels[pass.status] || pass.status}</s-badge>
              <s-heading>
                {pass.available} credit{pass.available === 1 ? "" : "s"}{" "}
                available
              </s-heading>
              {pass.reserved > 0 && (
                <s-text color="subdued">
                  {pass.reserved} credit{pass.reserved === 1 ? " is" : "s are"}{" "}
                  assigned to upcoming booking
                  {pass.reserved === 1 ? "" : "s"}
                </s-text>
              )}
              <s-text color="subdued">
                {pass.used} credit{pass.used === 1 ? "" : "s"} used
              </s-text>
              <s-text>
                {pass.expiresAt
                  ? `Valid until ${shortDate(pass.expiresAt, account.timezone)}`
                  : "Activates on first booked class"}
              </s-text>
              <s-text>
                Eligible: {pass.eligibleClasses.filter(Boolean).join(", ")}
              </s-text>
              {pass.history.length > 0 && <s-divider />}
              {pass.history.length > 0 && (
                <s-heading>Recent credit activity</s-heading>
              )}
              {pass.history.map((entry) => (
                <s-text key={entry.id} color="subdued">
                  {shortDate(entry.createdAt, account.timezone)} ·{" "}
                  {labels[entry.kind] || entry.kind}
                </s-text>
              ))}
              {pass.historyTruncated && (
                <s-text color="subdued">
                  Showing the 20 most recent credit entries.
                </s-text>
              )}
            </s-stack>
          </s-section>
        ))}
      </s-grid>
    </s-query-container>
  );
}

function Bookings({
  account,
  view,
  open,
  busy,
  uncertain,
  select,
  move,
}: {
  account: Account;
  view: "upcoming" | "history";
  open: (view: View) => void;
  busy: boolean;
  uncertain: boolean;
  select: (booking: Booking) => void;
  move: (booking: Booking) => Promise<void>;
}) {
  const upcoming = view === "upcoming";
  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="block" gap="small">
        <s-heading>Bookings</s-heading>
        <s-text color="subdued">
          Upcoming contains active class and private-session bookings. Past &
          cancelled keeps completed, cancelled and no-show activity.
        </s-text>
        <s-query-container>
          <s-grid
            gap="small"
            gridTemplateColumns="@container (inline-size > 420px) repeat(2, minmax(0, 1fr)), 1fr"
          >
            <s-button
              disabled={busy}
              variant={upcoming ? "primary" : "secondary"}
              onClick={() => open("upcoming")}
            >
              Upcoming
            </s-button>
            <s-button
              disabled={busy}
              variant={upcoming ? "secondary" : "primary"}
              onClick={() => open("history")}
            >
              Past & cancelled
            </s-button>
          </s-grid>
        </s-query-container>
      </s-stack>
      {account.bookings.length ? (
        account.bookings.map((booking) => (
          <BookingCard
            key={booking.id}
            booking={booking}
            busy={busy}
            uncertain={uncertain}
            select={select}
            move={move}
          />
        ))
      ) : (
        <s-section
          heading={upcoming ? "No upcoming bookings" : "No past activity"}
        >
          <s-text color="subdued">
            {upcoming
              ? "New bookings appear here after checkout has finished processing."
              : "Completed, cancelled and no-show bookings will appear here."}
          </s-text>
        </s-section>
      )}
    </s-stack>
  );
}

function BookingCard({
  booking,
  busy,
  uncertain,
  select,
  move,
}: {
  booking: Booking;
  busy: boolean;
  uncertain: boolean;
  select: (booking: Booking) => void;
  move: (booking: Booking) => Promise<void>;
}) {
  return (
    <s-section heading={booking.className}>
      <s-stack gap="small">
        <s-stack direction="inline" gap="small">
          <s-badge>
            {booking.rescheduledTo
              ? "Rescheduled"
              : labels[booking.status] || booking.status}
          </s-badge>
          {isAppointment(booking) && <s-badge>Private appointment</s-badge>}
        </s-stack>
        <s-text>{date(booking.startsAt, booking.timezone)}</s-text>
        <s-text>
          {booking.coachName} · {booking.locationName}
        </s-text>
        <s-text>Booking {booking.id.slice(-8).toUpperCase()}</s-text>
        {booking.customerComment && (
          <s-text>Your note: {booking.customerComment}</s-text>
        )}
        {booking.canReschedule && (
          <s-button
            disabled={busy || uncertain}
            onClick={() => void move(booking)}
          >
            Change time
          </s-button>
        )}
        {booking.canCancel && (
          <s-button
            disabled={busy || uncertain}
            onClick={() => select(booking)}
          >
            Cancel booking
          </s-button>
        )}
      </s-stack>
    </s-section>
  );
}

function Appointments({
  account,
  bookingUrl,
  busy,
  uncertain,
  select,
  move,
}: {
  account: Account;
  bookingUrl: string;
  busy: boolean;
  uncertain: boolean;
  select: (booking: Booking) => void;
  move: (booking: Booking) => Promise<void>;
}) {
  const upcoming = account.bookings.filter(
    (booking) =>
      booking.status === "CONFIRMED" &&
      new Date(booking.endsAt).getTime() > Date.now(),
  );
  const history = account.bookings.filter(
    (booking) => !upcoming.some((item) => item.id === booking.id),
  );
  return (
    <s-stack direction="block" gap="large-100">
      <s-section heading="Private appointments">
        <s-stack direction="block" gap="base">
          <s-text>
            Review private-session details, change an eligible time, or book
            another appointment from the shared class schedule.
          </s-text>
          <FindClassButton href={bookingUrl} />
        </s-stack>
      </s-section>
      <s-query-container>
        <s-grid
          gap="base"
          gridTemplateColumns="@container (inline-size > 720px) repeat(2, minmax(0, 1fr)), 1fr"
        >
          <s-stack direction="block" gap="base">
            <s-heading>Upcoming</s-heading>
            {upcoming.length ? (
              upcoming.map((booking) => (
                <BookingCard
                  key={booking.id}
                  booking={booking}
                  busy={busy}
                  uncertain={uncertain}
                  select={select}
                  move={move}
                />
              ))
            ) : (
              <s-section>
                <s-text color="subdued">
                  No upcoming private appointment.
                </s-text>
              </s-section>
            )}
          </s-stack>
          <s-stack direction="block" gap="base">
            <s-heading>Appointment history</s-heading>
            {history.length ? (
              history.map((booking) => (
                <BookingCard
                  key={booking.id}
                  booking={booking}
                  busy={busy}
                  uncertain={uncertain}
                  select={select}
                  move={move}
                />
              ))
            ) : (
              <s-section>
                <s-text color="subdued">
                  No private appointment history yet.
                </s-text>
              </s-section>
            )}
          </s-stack>
        </s-grid>
      </s-query-container>
    </s-stack>
  );
}
