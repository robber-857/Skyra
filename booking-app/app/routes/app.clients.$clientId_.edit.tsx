import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { adminContext } from "../services/context.server";
import {
  adminClientEdit,
  updateAdminClient,
} from "../services/client-contacts.server";
import { publicError } from "../lib/errors.server";
import { Feedback } from "../components/admin-ui";
import { adminClientDetail } from "../services/admin-clients.server";

export const headers = () => ({ "Cache-Control": "private, no-store" });

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { actor, admin } = await adminContext(request);
  return {
    client: await adminClientEdit(actor, admin.graphql, params.clientId),
    family: (await adminClientDetail(actor, params.clientId)).family,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { actor, admin } = await adminContext(request);
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  const form = await request.formData();
  try {
    await updateAdminClient(actor, admin.graphql, params.clientId, {
      firstName: form.get("firstName"),
      lastName: form.get("lastName"),
      email: form.get("email"),
      phone: form.get("phone"),
      preferredName: form.get("preferredName"),
    });
    return redirect(`/app/clients/${params.clientId}?updated=1`);
  } catch (error) {
    return publicError(error);
  }
}

export default function EditClient() {
  const { client, family } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <main className="workspace clients-workspace">
      <Link className="client-back" to={`/app/clients/${client.id}`}>
        ← Client profile
      </Link>
      <header className="page-head">
        <div>
          <p className="page-kicker">Admin · Clients</p>
          <h1>
            Edit{" "}
            {client.preferredName ||
              [client.firstName, client.lastName].filter(Boolean).join(" ") ||
              "client"}
          </h1>
        </div>
      </header>
      <section className="panel">
        <p className="muted">
          Name, email and phone are saved to Shopify. Preferred name is used in
          Booking.
        </p>
        {family.parent && (
          <p className="muted">
            Family member of{" "}
            <Link to={`/app/clients/${family.parent.id}#client-family`}>
              {family.parent.name}
            </Link>
            . This member’s account email identifies their separate Client
            profile. Booking emails go to the parent’s contact email:{" "}
            {family.parent.email || "not available"}.
          </p>
        )}
        <Feedback result={result} />
        <Form method="post" className="form-grid">
          <label className="field">
            First name
            <input
              name="firstName"
              autoComplete="given-name"
              defaultValue={client.firstName}
              required
              maxLength={100}
            />
          </label>
          <label className="field">
            Last name (optional)
            <input
              name="lastName"
              autoComplete="family-name"
              defaultValue={client.lastName}
              maxLength={100}
            />
          </label>
          <label className="field">
            Preferred name (optional)
            <input
              name="preferredName"
              defaultValue={client.preferredName}
              maxLength={100}
            />
          </label>
          <label className="field">
            {family.parent ? "Account email" : "Email"}
            <input
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={client.email}
              required
              maxLength={254}
              readOnly={!!family.parent}
            />
            {family.parent && (
              <small>
                This alias stays with the member’s profile. Update the parent’s
                email in their own Client profile to change booking contact.
              </small>
            )}
          </label>
          <label className="field">
            Phone (optional)
            <input
              name="phone"
              type="tel"
              autoComplete="tel"
              defaultValue={client.phone}
              placeholder="+61 412 345 678"
              maxLength={40}
            />
            <small>
              Include the country code. Leaving this blank removes the current
              phone number.
            </small>
          </label>
          <div className="catalog-page-controls">
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
            {!busy && (
              <Link className="button" to={`/app/clients/${client.id}`}>
                Cancel
              </Link>
            )}
          </div>
        </Form>
      </section>
    </main>
  );
}
