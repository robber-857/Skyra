import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

type FamilyClient = { id: string; name: string; email: string | null };

export function AdminFamilySection({
  client,
  family,
  idempotencyKey,
  result,
}: {
  client: FamilyClient;
  family: { parent: FamilyClient | null; members: FamilyClient[] };
  idempotencyKey: string;
  result?: { error?: string; intent?: string; code?: string };
}) {
  const [adding, setAdding] = useState(false);
  const [emailPrefix, setEmailPrefix] = useState("");
  const [familyKey, setFamilyKey] = useState(idempotencyKey);
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const submitting =
    busy && navigation.formData?.get("intent") === "add-family-member";
  const canRestartRequest =
    !!result?.code &&
    [
      "VALIDATION",
      "FAMILY_EMAIL_IN_USE",
      "FAMILY_EMAIL_TOO_LONG",
      "FAMILY_CREATE_FAILED",
    ].includes(result.code);
  const retryOnly =
    !!result?.code &&
    [
      "FAMILY_PROVIDER_UNAVAILABLE",
      "FAMILY_SAVE_UNAVAILABLE",
      "FAMILY_CREATE_IN_PROGRESS",
    ].includes(result.code);
  const contact = family.parent ?? client;
  const members = family.members.filter((member) => member.id !== client.id);
  const at = contact.email?.lastIndexOf("@") ?? -1;
  const alias =
    contact.email && at > 0 && emailPrefix
      ? `${contact.email.slice(0, at)}+${emailPrefix}${contact.email.slice(at)}`
      : null;

  return (
    <section
      className="panel client-family"
      id="client-family"
      aria-labelledby="client-family-title"
    >
      <div className="report-block-head">
        <h2 id="client-family-title">
          {family.parent ? "Family account" : "Family members"}
        </h2>
        {!family.parent && (
          <button
            type="button"
            disabled={busy || !client.email}
            aria-expanded={adding}
            aria-controls="add-family-member"
            onClick={() => setAdding(!adding)}
          >
            Add family member
          </button>
        )}
      </div>
      {family.parent && (
        <p>
          Parent account:{" "}
          <Link to={`/app/clients/${family.parent.id}#client-family`}>
            {family.parent.name}
          </Link>
        </p>
      )}
      <p className="muted">
        Each family member has their own Client profile, bookings and Pass
        balance. This page manages {client.name}’s classes and Passes.
      </p>
      {contact.email ? (
        <p className="client-family-contact">
          Family booking emails go to{" "}
          <a href={`mailto:${contact.email}`}>{contact.email}</a>.
        </p>
      ) : (
        <p className="muted">
          Add an email to this client before creating family members.
        </p>
      )}
      {family.parent && members.length > 0 && <h3>Other family members</h3>}
      {!members.length && !family.parent && (
        <p className="empty">No family members added yet.</p>
      )}
      {members.length > 0 && (
        <ul className="client-family-members">
          {members.map((member) => (
            <li className="client-family-member" key={member.id}>
              <div>
                <Link className="client-name" to={`/app/clients/${member.id}`}>
                  {member.name}
                </Link>
                <p className="muted">Account email: {member.email}</p>
              </div>
              <div className="catalog-page-controls">
                <Link
                  to={`/app/clients/${member.id}/edit`}
                  aria-label={`Edit ${member.name}`}
                >
                  Edit
                </Link>
                <Link
                  to={`/app/clients/${member.id}#client-book-class`}
                  aria-label={`Book a class for ${member.name}`}
                >
                  Book class
                </Link>
                <Link
                  to={`/app/clients/${member.id}#client-passes-title`}
                  aria-label={`Manage Passes for ${member.name}`}
                >
                  Manage Passes
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!family.parent && (
        <div
          className="client-family-add"
          id="add-family-member"
          hidden={!adding}
        >
          <h3>Add family member for {client.name}</h3>
          <p className="muted">
            Create a separate Client with an email alias based on this parent’s
            account. Booking notifications use the parent’s contact email.
          </p>
          {result?.intent === "add-family-member" && result.error && (
            <p className="feedback error" role="alert">
              {result.error}
            </p>
          )}
          {retryOnly && (
            <p className="muted">
              Keep these details unchanged and retry to confirm whether this
              member was saved.
            </p>
          )}
          <Form
            method="post"
            className="form-grid"
            onChange={() => {
              if (canRestartRequest) setFamilyKey(idempotencyKey);
            }}
          >
            <input type="hidden" name="intent" value="add-family-member" />
            <input type="hidden" name="idempotencyKey" value={familyKey} />
            <label className="field">
              First name
              <input
                name="firstName"
                required
                maxLength={100}
                disabled={busy}
                readOnly={retryOnly}
              />
            </label>
            <label className="field">
              Last name (optional)
              <input
                name="lastName"
                maxLength={100}
                disabled={busy}
                readOnly={retryOnly}
              />
            </label>
            <label className="field">
              Email prefix
              <input
                name="emailPrefix"
                required
                pattern={"[a-z0-9][a-z0-9\\-]{0,39}"}
                maxLength={40}
                value={emailPrefix}
                onChange={(event) =>
                  setEmailPrefix(event.target.value.toLowerCase())
                }
                placeholder="child1"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                readOnly={retryOnly}
                aria-describedby="family-email-preview"
              />
              <small id="family-email-preview">
                {alias ? `Account email: ${alias}. ` : ""}Use lowercase letters,
                numbers or hyphens. Choose a unique prefix for each family
                member.
              </small>
            </label>
            <label className="field">
              Phone (optional)
              <input
                name="phone"
                type="tel"
                maxLength={40}
                placeholder="+61 412 345 678"
                disabled={busy}
                readOnly={retryOnly}
              />
              <small>Include the country code if provided.</small>
            </label>
            <div className="catalog-page-controls">
              <button
                className="primary"
                aria-busy={submitting}
                disabled={busy}
              >
                {submitting
                  ? "Creating…"
                  : retryOnly
                    ? "Retry family member"
                    : "Create family member"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                }}
              >
                Cancel
              </button>
            </div>
          </Form>
        </div>
      )}
    </section>
  );
}
