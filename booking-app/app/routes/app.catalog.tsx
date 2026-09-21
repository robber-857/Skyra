import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { adminContext } from "../services/context.server";
import {
  catalogData,
  retrySync,
  savePass,
  saveService,
} from "../services/catalog.server";
import { publicError } from "../lib/errors.server";
import { Feedback, Field, Status } from "../components/admin-ui";
import { CatalogAvailability } from "../components/catalog-availability";
import { unauthenticated } from "../shopify.server";
import { authenticatedStorefrontClient } from "../services/storefront-access.server";
import { checkCatalogPurchase } from "../services/shopify-purchasability.server";

const serviceKindLabel = (kind: string) =>
  ({
    CLASS: "Group class",
    APPOINTMENT: "Private appointment",
    COURSE: "Workshop",
  })[kind] || "Service";

const PAGE_SIZE = 8;

export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  return { ...(await catalogData(actor.shopId)), domain: shop.domain };
}
export async function action({ request }: ActionFunctionArgs) {
  const { actor, admin, shop } = await adminContext(request);
  const form = await request.formData();
  try {
    const intent = String(form.get("intent"));
    if (intent === "check-availability") {
      return {
        availability: await checkCatalogPurchase(
          actor,
          String(form.get("id")),
          {
            admin: admin.graphql,
            storefront: authenticatedStorefrontClient(
              shop.domain,
              unauthenticated.storefront,
            ),
          },
        ),
      };
    }
    if (intent === "retry") await retrySync(actor, String(form.get("id")));
    else {
      const price = String(form.get("price"));
      if (!/^\d+(\.\d{1,2})?$/.test(price))
        return {
          error: "Enter an AUD price with no more than two decimal places.",
        };
      const input = {
        ...Object.fromEntries(form),
        id: form.get("id") || undefined,
        version: form.get("version") || undefined,
        requestedPriceCents: Math.round(Number(price) * 100),
        coachIds: form.getAll("coachIds"),
        serviceIds: form.getAll("serviceIds"),
        introOnly: form.get("introOnly") === "on",
        saleable: form.get("legacyOnly") !== "on",
      };
      if (intent === "service") await saveService(actor, input);
      else if (intent === "pass") await savePass(actor, input);
      else return { error: "Unknown action." };
    }
    return { message: "Saved. Shopify synchronization is queued." };
  } catch (error) {
    return publicError(error);
  }
}
export default function Catalog() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!data.mappings.some((x) => x.syncStatus === "PENDING")) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [data.mappings, revalidator]);
  const busy = useNavigation().state !== "idle";
  const [tab, setTab] = useState<"service" | "pass">("service");
  const [edit, setEdit] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const service = data.services.find((x) => x.id === edit);
  const pass = data.passes.find((x) => x.id === edit);
  const item = tab === "service" ? service : pass;
  const records = tab === "service" ? data.services : data.passes;
  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visibleRecords = records.slice(start, start + PAGE_SIZE);
  useEffect(() => {
    setPage((value) => Math.min(value, totalPages));
  }, [totalPages]);
  function switchTab(value: "service" | "pass") {
    setTab(value);
    setPage(1);
    setEdit(null);
    setOpen(false);
  }
  return (
    <main className="workspace catalog-workspace">
      <header className="page-head">
        <div>
          <h1>Classes &amp; Passes</h1>
          <p className="muted">
            Define what you offer. Assign dates and coaches in Weekly Schedule.
          </p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setEdit(null);
            setOpen(true);
          }}
        >
          Add {tab === "service" ? "class" : "pass"}
        </button>
      </header>
      <div className="tabs">
        <button
          aria-pressed={tab === "service"}
          onClick={() => switchTab("service")}
        >
          Classes
        </button>
        <button aria-pressed={tab === "pass"} onClick={() => switchTab("pass")}>
          Passes
        </button>
      </div>
      <Feedback result={result} />
      {open && (
        <section className="panel">
          <h2>
            {edit ? "Edit" : "New"} {tab === "service" ? "class" : "pass"}
          </h2>
          <Form method="post" key={tab + edit + (item?.version || 0)}>
            <input type="hidden" name="intent" value={tab} />
            <input type="hidden" name="id" value={edit || ""} />
            <input type="hidden" name="version" value={item?.version || ""} />
            <div className="form-grid">
              <Field label="Name">
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={120}
                  defaultValue={item?.name}
                />
              </Field>
              <Field label="Price (AUD)">
                <input
                  name="price"
                  required
                  inputMode="decimal"
                  defaultValue={
                    item ? (item.requestedPriceCents / 100).toFixed(2) : ""
                  }
                />
              </Field>
              <Field label="Status">
                <select name="status" defaultValue={item?.status || "DRAFT"}>
                  <option>DRAFT</option>
                  <option>ACTIVE</option>
                  <option>INACTIVE</option>
                </select>
              </Field>
              {tab === "service" ? (
                <>
                  <Field label="Service type">
                    <select name="kind" defaultValue={service?.kind || "CLASS"}>
                      <option value="CLASS">Group class</option>
                      <option value="APPOINTMENT">
                        Private appointment (one customer)
                      </option>
                      <option value="COURSE">Workshop</option>
                    </select>
                  </Field>
                  <p className="muted">
                    Private appointments always have one place. Workshops keep
                    their configured capacity. Publish all available times in
                    Weekly Schedule; valid bookings confirm directly.
                  </p>
                  <Field label="Duration (minutes)">
                    <input
                      name="durationMin"
                      type="number"
                      min={5}
                      max={480}
                      required
                      defaultValue={service?.durationMin || 60}
                    />
                  </Field>
                  <Field label="Capacity">
                    <input
                      name="capacity"
                      type="number"
                      min={1}
                      max={200}
                      required
                      defaultValue={service?.capacity || 10}
                    />
                  </Field>
                  <Field label="Location">
                    <select
                      name="locationId"
                      required
                      defaultValue={service?.locationId || ""}
                    >
                      <option value="">Choose a location</option>
                      {data.locations.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Eligible coaches">
                    <select
                      name="coachIds"
                      multiple
                      required
                      defaultValue={
                        service?.coaches.map((x) => x.coachId) || []
                      }
                    >
                      {data.coaches.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                    <small>Select one or more coaches.</small>
                  </Field>
                  <Field label="Level">
                    <input
                      name="level"
                      maxLength={80}
                      defaultValue={service?.level || ""}
                    />
                  </Field>
                  <Field label="Description">
                    <textarea
                      name="description"
                      maxLength={4000}
                      defaultValue={service?.description || ""}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Credits">
                    <input
                      name="credits"
                      type="number"
                      min={1}
                      max={1000}
                      required
                      defaultValue={pass?.credits || 10}
                    />
                  </Field>
                  <Field label="Valid for (days)">
                    <input
                      name="validityDays"
                      type="number"
                      min={1}
                      max={3650}
                      required
                      defaultValue={pass?.validityDays || 90}
                    />
                  </Field>
                  <Field label="Calendar months (overrides days)">
                    <input
                      name="validityMonths"
                      type="number"
                      min={1}
                      max={120}
                      defaultValue={pass?.validityMonths ?? ""}
                    />
                    <small>
                      Validity begins on the date of the first booked class.
                    </small>
                  </Field>
                  <label>
                    <input
                      name="legacyOnly"
                      type="checkbox"
                      defaultChecked={pass?.saleable === false}
                    />{" "}
                    Existing entitlements only (not for sale)
                  </label>
                  <Field label="Eligible classes">
                    <select
                      name="serviceIds"
                      multiple
                      required
                      defaultValue={
                        pass?.services.map((x) => x.serviceId) || []
                      }
                    >
                      {(["CLASS", "APPOINTMENT", "COURSE"] as const).map(
                        (kind) => (
                          <optgroup key={kind} label={serviceKindLabel(kind)}>
                            {data.services
                              .filter((service) => service.kind === kind)
                              .map((service) => (
                                <option key={service.id} value={service.id}>
                                  {service.name}
                                </option>
                              ))}
                          </optgroup>
                        ),
                      )}
                    </select>
                    <small>
                      Select services from one type only. Group-class Passes
                      cannot book private appointments or Workshops.
                    </small>
                  </Field>
                  <label>
                    <input
                      name="introOnly"
                      type="checkbox"
                      defaultChecked={pass?.introOnly}
                    />{" "}
                    First-time customers only
                  </label>
                </>
              )}
            </div>
            <div className="actions">
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </Form>
        </section>
      )}
      <section
        className="panel record-list catalog-list"
        aria-label={tab === "service" ? "Classes" : "Passes"}
      >
        <div className="catalog-list-head">
          <h2>{tab === "service" ? "Classes" : "Passes"}</h2>
          <p className="muted" role="status" aria-live="polite">
            {records.length === 0
              ? "0 items"
              : `${start + 1}–${Math.min(start + PAGE_SIZE, records.length)} of ${records.length}`}{" "}
            · 8 per page
          </p>
        </div>
        {records.length === 0 && (
          <p className="empty">
            No {tab === "service" ? "classes" : "passes"} yet. Add your first
            one to get started.
          </p>
        )}
        {visibleRecords.map((record) => {
          const mapping = data.mappings.find((x) => x.ownerId === record.id);
          return (
            <article className="record catalog-record" key={record.id}>
              <div className="catalog-record-details">
                <h3>{record.name}</h3>
                <p className="muted">
                  {"durationMin" in record
                    ? record.durationMin +
                      " min · " +
                      record.capacity +
                      " places"
                    : record.credits +
                      " credits · " +
                      (record.validityMonths ?? record.validityDays) +
                      (record.validityMonths
                        ? " calendar months"
                        : " days")}{" "}
                  · {"A$" + (record.requestedPriceCents / 100).toFixed(2)}
                </p>
                <div className="catalog-statuses">
                  <Status>{record.status}</Status>
                  <Status>
                    {"durationMin" in record
                      ? serviceKindLabel(record.kind)
                      : serviceKindLabel(
                          record.services[0]?.service.kind || "CLASS",
                        ) + " Pass"}
                  </Status>
                  <Status>{mapping?.syncStatus || "PENDING"}</Status>
                </div>
                {mapping?.lastError && (
                  <p className="sync-error">{mapping.lastError}</p>
                )}
                {mapping && (
                  <CatalogAvailability
                    key={[
                      mapping.id,
                      record.version,
                      mapping.syncStatus,
                      mapping.shopifyVersion,
                      mapping.productGid,
                      mapping.variantGid,
                    ].join(":")}
                    mappingId={mapping.id}
                  />
                )}
              </div>
              <div className="record-actions">
                <button
                  onClick={() => {
                    setEdit(record.id);
                    setOpen(true);
                  }}
                >
                  Edit
                </button>
                {mapping?.syncStatus === "ERROR" && (
                  <Form method="post">
                    <input name="intent" type="hidden" value="retry" />
                    <input name="id" type="hidden" value={mapping.id} />
                    <button disabled={busy}>Retry sync</button>
                  </Form>
                )}
                {mapping?.productGid && (
                  <a
                    href={
                      "https://" +
                      data.domain +
                      "/admin/products/" +
                      mapping.productGid.split("/").pop()
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    Shopify product
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </section>
      {records.length > 0 && (
        <nav className="catalog-pagination" aria-label="Catalog pagination">
          <div className="catalog-page-controls">
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </button>
            <span
              className="catalog-page-count"
              role="status"
              aria-live="polite"
            >
              <span className="visually-hidden">Page </span>
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPage === totalPages}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </div>
          <form
            className="catalog-page-jump"
            onSubmit={(event) => {
              event.preventDefault();
              const target = Number(
                new FormData(event.currentTarget).get("page"),
              );
              if (
                Number.isInteger(target) &&
                target >= 1 &&
                target <= totalPages
              )
                setPage(target);
            }}
          >
            <label htmlFor="catalog-page">Go to page</label>
            <input
              key={`${tab}:${currentPage}:${totalPages}`}
              id="catalog-page"
              name="page"
              type="number"
              inputMode="numeric"
              min={1}
              max={totalPages}
              step={1}
              required
              defaultValue={currentPage}
            />
            <button type="submit">Go</button>
          </form>
        </nav>
      )}
    </main>
  );
}
