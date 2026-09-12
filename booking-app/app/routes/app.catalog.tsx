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
import {
  checkCatalogPurchase,
  storefrontReadClient,
} from "../services/shopify-purchasability.server";
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
            storefront: storefrontReadClient(shop.domain),
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
  const service = data.services.find((x) => x.id === edit);
  const pass = data.passes.find((x) => x.id === edit);
  const item = tab === "service" ? service : pass;
  const records = tab === "service" ? data.services : data.passes;
  function switchTab(value: "service" | "pass") {
    setTab(value);
    setEdit(null);
    setOpen(false);
  }
  return (
    <main className="workspace">
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
                  <Field label="Eligible classes">
                    <select
                      name="serviceIds"
                      multiple
                      required
                      defaultValue={
                        pass?.services.map((x) => x.serviceId) || []
                      }
                    >
                      {data.services.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
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
        className="panel record-list"
        aria-label={tab === "service" ? "Classes" : "Passes"}
      >
        {records.length === 0 && (
          <p className="empty">
            No {tab === "service" ? "classes" : "passes"} yet. Add your first
            one to get started.
          </p>
        )}
        {records.map((record) => {
          const mapping = data.mappings.find((x) => x.ownerId === record.id);
          return (
            <article className="record" key={record.id}>
              <div>
                <h3>{record.name}</h3>
                <p className="muted">
                  {"durationMin" in record
                    ? record.durationMin +
                      " min · " +
                      record.capacity +
                      " places"
                    : record.credits +
                      " credits · " +
                      record.validityDays +
                      " days"}{" "}
                  · {"A$" + (record.requestedPriceCents / 100).toFixed(2)}
                </p>
                <Status>{record.status}</Status>{" "}
                <Status>{mapping?.syncStatus || "PENDING"}</Status>
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
    </main>
  );
}
