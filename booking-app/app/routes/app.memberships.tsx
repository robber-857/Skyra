import { supportsRenewalPeriod } from "../services/renewal-period";
import { z } from "zod";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import db from "../db.server";
import { DomainError, publicError } from "../lib/errors.server";
import { Feedback, Status } from "../components/admin-ui";
import { configureMonthlyPlan } from "../services/membership-plan-setup.server";
import { adminContext } from "../services/context.server";
import { requireOperations } from "../services/authorization";
import { audit, lockShop } from "../services/catalog.server";
import { membershipCapabilities } from "../services/membership-capabilities.server";
import {
  DEVELOPMENT_BOOKING_SHOP,
  isDevelopmentBookingShop,
} from "../services/commerce-capabilities.server";
import { purchaseMappingReady } from "../services/purchase-mapping.server";
import {
  membershipManagementUrl,
  syncMembershipMailDeliveryStatus,
} from "../services/membership-notifications.server";
import { transactionalMailReady } from "../services/transactional-mail.server";

const attentionStates = [
  "REVIEW",
  "UNKNOWN",
  "FAILED",
  "ACTION_REQUIRED",
  "SUBMITTING",
];
const waitingStates = ["CREATING", "CHECKOUT_READY", "BILLING_PENDING"];
const configInput = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
  updatedAt: z.string().datetime(),
  standalonePurchaseEnabled: z.boolean(),
  oneTimePurchaseEnabled: z.boolean(),
  autoRenewEnabled: z.boolean(),
});

function paymentStatus(status: string) {
  return (
    {
      REVIEW: "Needs review",
      UNKNOWN: "Payment outcome unknown",
      FAILED: "Payment failed",
      ACTION_REQUIRED: "Customer verification needed",
      SUBMITTING: "Payment being submitted",
      CREATING: "Checkout being prepared",
      CHECKOUT_READY: "Awaiting checkout payment",
      BILLING_PENDING: "Renewal being checked",
    }[status] || "Payment being checked"
  );
}

function membershipMailAvailability(domain: string) {
  const providerConfigured =
    process.env.SKYRA_MAIL_PROVIDER === "resend" &&
    Boolean(process.env.RESEND_API_KEY) &&
    z.email().safeParse(process.env.SKYRA_MAIL_FROM).success;
  if (!providerConfigured)
    return {
      state: "NOT_CONFIGURED",
      label: "App payment emails not configured",
    };
  if (
    !transactionalMailReady() ||
    process.env.SKYRA_MEMBERSHIP_MAIL_ENABLED !== "true"
  )
    return { state: "DISABLED", label: "App payment emails disabled" };
  if (
    process.env.SKYRA_BOOKING_MAIL_SHOP !== domain ||
    !membershipManagementUrl(domain)
  )
    return {
      state: "SHOP_DISABLED",
      label: "App payment emails disabled for this store",
    };
  if (
    domain === DEVELOPMENT_BOOKING_SHOP &&
    !z.email().safeParse(process.env.SKYRA_MAIL_TEST_RECIPIENT).success
  )
    return {
      state: "TEST_RECIPIENT_REQUIRED",
      label: "App payment emails need an approved test recipient",
    };
  return { state: "READY", label: "App payment emails configured for sending" };
}

function membershipEmailStatus(status: string, mailState: string) {
  if (status === "PENDING" && mailState !== "READY")
    return mailState === "NOT_CONFIGURED"
      ? "Not sent (email service not configured)"
      : "Not sent (app email sending disabled)";
  return (
    {
      PENDING: "Queued for app email",
      SENDING: "Submitting app email",
      ACCEPTED: "Accepted by provider (delivery unverified)",
      FAILED: "App email failed",
      UNKNOWN: "Send outcome unknown (do not resend)",
    }[status] || "Email status needs review"
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  requireOperations(actor);
  const requestedPage = Number(
    new URL(request.url).searchParams.get("historyPage") || "1",
  );
  const historyPage =
    Number.isSafeInteger(requestedPage) &&
    requestedPage > 0 &&
    requestedPage <= 100000
      ? requestedPage
      : 1;
  const [
    plans,
    mappings,
    purchases,
    attentionCount,
    waitingCount,
    receipts,
    receiptCount,
  ] = await Promise.all([
    db.passPlan.findMany({
      where: { shopId: actor.shopId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        version: true,
        updatedAt: true,
        status: true,
        saleable: true,
        introOnly: true,
        credits: true,
        requestedPriceCents: true,
        validityMonths: true,
        validityDays: true,
        standalonePurchaseEnabled: true,
        oneTimePurchaseEnabled: true,
        autoRenewEnabled: true,
        sellingPlanGid: true,
        renewalSetupState: true,
        services: { select: { service: { select: { name: true } } } },
      },
    }),
    db.productMapping.findMany({
      where: { shopId: actor.shopId, ownerType: "PASS_PLAN" },
    }),
    db.passPurchase.findMany({
      where: {
        shopId: actor.shopId,
        status: { in: [...attentionStates, ...waitingStates] },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 40,
      select: {
        id: true,
        cycle: true,
        status: true,
        priceCents: true,
        currency: true,
        updatedAt: true,
        sourceOrderGid: true,
        membership: { select: { customerId: true, passPlanId: true } },
      },
    }),
    db.passPurchase.count({
      where: { shopId: actor.shopId, status: { in: attentionStates } },
    }),
    db.passPurchase.count({
      where: { shopId: actor.shopId, status: { in: waitingStates } },
    }),
    db.membershipReceipt.findMany({
      where: { shopId: actor.shopId },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      skip: (historyPage - 1) * 40,
      take: 40,
      include: { notification: true },
    }),
    db.membershipReceipt.count({ where: { shopId: actor.shopId } }),
  ]);
  const profiles = await db.customerProfile.findMany({
    where: {
      shopId: actor.shopId,
      id: {
        in: [
          ...purchases.map((p) => p.membership.customerId),
          ...receipts.map((r) => r.customerId),
        ],
      },
    },
    select: { id: true, preferredName: true, shopifyName: true, email: true },
  });
  const nameOf = (customerId: string) => {
    const profile = profiles.find((p) => p.id === customerId);
    return (
      profile?.preferredName.trim() ||
      profile?.shopifyName.trim() ||
      "Name not added"
    );
  };
  const capability = membershipCapabilities(shop.domain);
  const development = isDevelopmentBookingShop(shop.domain);
  const mail = membershipMailAvailability(shop.domain);
  return {
    canEdit: actor.role === "ADMIN",
    mail,
    capabilities: {
      ...capability,
      development,
      subscriptionsReady:
        process.env.SKYRA_MEMBERSHIPS_SUBSCRIPTIONS_READY === "true",
      checkoutExclusionVerified:
        process.env.SKYRA_MEMBERSHIPS_CHECKOUT_EXCLUSION_VERIFIED === "true",
    },
    plans: plans.map((plan) => ({
      ...plan,
      updatedAt: plan.updatedAt.toISOString(),
      mappingReady: purchaseMappingReady(
        mappings.find((m) => m.ownerId === plan.id),
        plan,
      ),
    })),
    attentionCount,
    waitingCount,
    historyPage,
    historyPages: Math.max(1, Math.ceil(receiptCount / 40)),
    receiptCount,
    receipts: receipts.map((receipt) => ({
      id: receipt.id,
      purchaseId: receipt.purchaseId,
      customerName: nameOf(receipt.customerId),
      passName: receipt.passName,
      cycle: receipt.cycle,
      priceCents: receipt.priceCents,
      currency: receipt.currency,
      issuedAt: receipt.issuedAt.toISOString(),
      orderUrl: /^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(
        receipt.sourceOrderGid,
      )
        ? `https://${shop.domain}/admin/orders/${receipt.sourceOrderGid.split("/").pop()}`
        : null,
      notification: receipt.notification
        ? {
            id: receipt.notification.id,
            status: receipt.notification.status,
            statusLabel: membershipEmailStatus(
              receipt.notification.status,
              mail.state,
            ),
            subject: receipt.notification.subject,
            bodyText: receipt.notification.bodyText,
            recipientEmail: receipt.notification.recipientEmail,
            providerMessageId: receipt.notification.providerMessageId,
            acceptedAt: receipt.notification.acceptedAt?.toISOString() ?? null,
            deliveryStatus: receipt.notification.deliveryStatus,
            deliveryError: receipt.notification.deliveryError,
            lastError: receipt.notification.lastError,
          }
        : null,
    })),
    purchases: purchases.map((purchase) => {
      const name = nameOf(purchase.membership.customerId);
      const duplicateName =
        profiles.filter((p) => nameOf(p.id) === name).length > 1;
      const profile = profiles.find(
        (p) => p.id === purchase.membership.customerId,
      );
      const orderId = purchase.sourceOrderGid?.match(
        /^gid:\/\/shopify\/Order\/([1-9]\d*)$/,
      )?.[1];
      return {
        id: purchase.id,
        cycle: purchase.cycle,
        status: purchase.status,
        statusLabel: paymentStatus(purchase.status),
        priceCents: purchase.priceCents,
        currency: purchase.currency,
        updatedAt: purchase.updatedAt.toISOString(),
        customerName: name,
        disambiguation: duplicateName ? profile?.email : null,
        planName:
          plans.find((p) => p.id === purchase.membership.passPlanId)?.name ||
          "Pass",
        attention: attentionStates.includes(purchase.status),
        orderUrl: orderId
          ? `https://${shop.domain}/admin/orders/${orderId}`
          : null,
      };
    }),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { actor, admin, shop } = await adminContext(request);
  if (actor.role !== "ADMIN")
    throw new Response(
      "Only an administrator can change membership purchase settings.",
      { status: 403 },
    );
  try {
    const form = await request.formData();
    if (form.get("intent") === "configure-renewal") {
      await configureMonthlyPlan(
        actor,
        Object.fromEntries(form),
        admin.graphql,
        shop.domain,
      );
      return {
        message:
          "Renewal plan created and verified. You can now enable automatic renewal below.",
      };
    }
    if (form.get("intent") === "refresh-mail-status") {
      const id = z.uuid().parse(form.get("id"));
      await syncMembershipMailDeliveryStatus(actor.shopId, id);
      return {
        message: "Email provider status checked. No email was sent or resent.",
      };
    }
    if (form.get("intent") !== "save-config")
      throw new DomainError(
        "INVALID_ACTION",
        "Unknown membership action.",
        400,
      );
    const input = configInput.parse({
      id: form.get("id"),
      version: form.get("version"),
      updatedAt: form.get("updatedAt"),
      standalonePurchaseEnabled: form.get("standalonePurchaseEnabled") === "on",
      oneTimePurchaseEnabled: form.get("oneTimePurchaseEnabled") === "on",
      autoRenewEnabled: form.get("autoRenewEnabled") === "on",
    });
    await db.$transaction(async (tx) => {
      await lockShop(tx, actor.shopId);
      const current = await tx.passPlan.findFirst({
        where: { id: input.id, shopId: actor.shopId },
      });
      if (!current) throw new DomainError("NOT_FOUND", "Pass not found.", 404);
      if (
        current.version !== input.version ||
        current.updatedAt.toISOString() !== input.updatedAt
      )
        throw new DomainError(
          "CONFLICT",
          "This Pass changed. Refresh the page before saving.",
          409,
        );
      if (
        (input.standalonePurchaseEnabled || input.autoRenewEnabled) &&
        (current.status !== "ACTIVE" ||
          !current.saleable ||
          current.requestedPriceCents <= 0)
      )
        throw new DomainError(
          "PASS_UNAVAILABLE",
          "Activate this Pass and make it available for sale in Classes & Passes first.",
          409,
        );
      if (
        input.autoRenewEnabled &&
        (!supportsRenewalPeriod(current.validityMonths) ||
          current.introOnly ||
          !current.sellingPlanGid ||
          !current.sellingPlanGroupGid ||
          current.renewalSetupState !== "READY")
      )
        throw new DomainError(
          "INVALID_RENEWAL_PLAN",
          "Configure and verify automatic renewal first. A calendar-month Pass without a first-time-customer restriction is required.",
          422,
        );
      // Provider identities are assigned only by the server-side setup flow.
      if (
        form.has("sellingPlanGid") &&
        form.get("sellingPlanGid") !== current.sellingPlanGid
      )
        throw new DomainError(
          "SELLING_PLAN_READ_ONLY",
          "Use Configure automatic renewal to manage this Pass's plan.",
          409,
        );
      const next = {
        standalonePurchaseEnabled: input.standalonePurchaseEnabled,
        oneTimePurchaseEnabled: input.oneTimePurchaseEnabled,
        autoRenewEnabled: input.autoRenewEnabled,
      };
      // These settings do not alter Shopify catalogue content. Keep its version
      // unchanged, but compare updatedAt to reject concurrent configuration edits.
      const updated = await tx.passPlan.updateMany({
        where: {
          id: current.id,
          shopId: actor.shopId,
          version: input.version,
          updatedAt: new Date(input.updatedAt),
        },
        data: next,
      });
      if (updated.count !== 1)
        throw new DomainError(
          "CONFLICT",
          "This Pass changed. Refresh the page before saving.",
          409,
        );
      await audit(
        tx,
        actor,
        "MEMBERSHIP_PLAN_CONFIGURED",
        current.id,
        {
          standalonePurchaseEnabled: current.standalonePurchaseEnabled,
          oneTimePurchaseEnabled: current.oneTimePurchaseEnabled,
          autoRenewEnabled: current.autoRenewEnabled,
          sellingPlanGid: current.sellingPlanGid,
        },
        next,
      );
    });
    return {
      message:
        "Saved for future purchases. Existing subscriptions keep their agreed terms. Store release requirements still apply.",
    };
  } catch (error) {
    return publicError(error);
  }
}

export default function Memberships() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const date = (value: string) =>
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  return (
    <main className="workspace catalog-workspace">
      <header className="page-head">
        <div>
          <h1>Membership purchases</h1>
          <p className="muted">
            Choose which Passes can be bought from Membership and which offer
            automatic renewal during Membership or Booking checkout. Select the
            eligible classes when creating a Pass, then configure automatic
            renewal below. Shopify plans are created and verified automatically.
            Create and edit Pass information here through the shared Classes
            &amp; Passes catalogue. Changes appear in the Membership purchase
            section after product synchronization; the original display section
            is managed in the Shopify theme editor.
          </p>
        </div>
        {data.canEdit && (
          <Link
            className="primary"
            to="/app/catalog?tab=pass&new=1&from=memberships"
          >
            Create a Pass
          </Link>
        )}
      </header>
      <Feedback result={result} />
      <section className="panel" aria-labelledby="membership-release-heading">
        <h2 id="membership-release-heading">Store availability</h2>
        <div className="catalog-statuses">
          <Status>
            {data.capabilities.checkoutAvailable
              ? "Membership checkout enabled"
              : "Membership checkout disabled"}
          </Status>
          <Status>
            {data.capabilities.autoRenewAvailable
              ? "Automatic renewal enabled"
              : "Automatic renewal disabled"}
          </Status>
          <Status>
            {data.capabilities.development
              ? "Development store"
              : "Production store"}
          </Status>
        </div>
        <p className="muted">
          Pass settings below prepare an offer. They do not change the store
          release controls or prove that Shopify permissions and payment tests
          have passed.
        </p>
        <ul>
          <li>
            Subscription access, app-owned contracts and payment gateway:{" "}
            {data.capabilities.subscriptionsReady
              ? "release readiness flag is set"
              : "release readiness flag is not set"}
            .
          </li>
          <li>
            Old checkout links and direct checkout must be blocked before a
            second payment:{" "}
            {data.capabilities.checkoutExclusionVerified
              ? "production verification flag is set"
              : "production verification flag is not set"}
            .
          </li>
          <li>
            Each renewal starts at the first staff-confirmed attendance. No new
            payment is scheduled while that Pass is waiting to start.
          </li>
        </ul>
        {!data.canEdit && (
          <p className="muted">
            You can review these settings. An administrator is required to
            change them.
          </p>
        )}
      </section>
      <section
        className="panel record-list"
        aria-labelledby="membership-plans-heading"
      >
        <h2 id="membership-plans-heading">Pass purchase settings</h2>
        {!data.plans.length && (
          <p className="empty">Create a Pass in Classes &amp; Passes first.</p>
        )}
        {data.plans.map((plan) => (
          <article
            className="record"
            key={plan.id}
            style={{ display: "block" }}
          >
            <h3>{plan.name}</h3>
            <p>
              Eligible classes:{" "}
              {plan.services.map((entry) => entry.service.name).join(", ") ||
                "None selected"}
            </p>
            {data.canEdit && (
              <Link
                to={`/app/catalog?tab=pass&edit=${plan.id}&from=memberships`}
              >
                Edit Pass information
              </Link>
            )}
            <p className="muted">
              {plan.credits} classes ·{" "}
              {plan.validityMonths
                ? `${plan.validityMonths} calendar month${plan.validityMonths === 1 ? "" : "s"}`
                : `${plan.validityDays} days`}{" "}
              · A${(plan.requestedPriceCents / 100).toFixed(2)}
            </p>
            <div className="catalog-statuses">
              <Status>{plan.status}</Status>
              <Status>
                {plan.mappingReady
                  ? "Product synchronized"
                  : "Product synchronization needed"}
              </Status>
            </div>
            <Form method="post">
              <input type="hidden" name="intent" value="configure-renewal" />
              <input type="hidden" name="id" value={plan.id} />
              <input type="hidden" name="version" value={plan.version} />
              <input type="hidden" name="updatedAt" value={plan.updatedAt} />
              <p>
                Renewal setup:{" "}
                {plan.renewalSetupState === "READY"
                  ? "Verified"
                  : plan.renewalSetupState === "VERIFYING"
                    ? "Verification needed — retry below"
                    : ["CREATING", "UNKNOWN"].includes(plan.renewalSetupState)
                      ? "Previous creation needs review; no duplicate will be created"
                      : "Not configured"}
              </p>
              <button
                type="submit"
                disabled={
                  !data.canEdit ||
                  busy ||
                  !supportsRenewalPeriod(plan.validityMonths) ||
                  plan.introOnly ||
                  ["CREATING", "UNKNOWN"].includes(plan.renewalSetupState)
                }
              >
                {plan.sellingPlanGid
                  ? "Verify automatic renewal"
                  : "Configure automatic renewal"}
              </button>
              <p className="muted">
                Save the Pass and wait for product synchronization first. Each
                paid period starts at its first staff-confirmed attendance.
                {supportsRenewalPeriod(plan.validityMonths) && ` Each renewal buys ${plan.credits} classes for ${plan.validityMonths} calendar month${plan.validityMonths === 1 ? "" : "s"} at A$${(plan.requestedPriceCents / 100).toFixed(2)}.`}
              </p>
            </Form>
            <Form method="post" key={`${plan.id}:${plan.updatedAt}`}>
              <input type="hidden" name="intent" value="save-config" />
              <input type="hidden" name="id" value={plan.id} />
              <input type="hidden" name="version" value={plan.version} />
              <input type="hidden" name="updatedAt" value={plan.updatedAt} />
              <fieldset
                disabled={!data.canEdit || busy}
                style={{
                  border: 0,
                  padding: 0,
                  marginTop: "1rem",
                  minWidth: 0,
                }}
              >
                <div className="form-grid">
                  <label>
                    <input
                      type="checkbox"
                      name="standalonePurchaseEnabled"
                      defaultChecked={plan.standalonePurchaseEnabled}
                    />{" "}
                    Offer this Pass on Membership
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="oneTimePurchaseEnabled"
                      defaultChecked={plan.oneTimePurchaseEnabled}
                    />{" "}
                    Allow one-time purchase
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="autoRenewEnabled"
                      defaultChecked={plan.autoRenewEnabled}
                      disabled={
                        !plan.autoRenewEnabled &&
                        plan.renewalSetupState !== "READY"
                      }
                    />{" "}
                    Offer automatic renewal
                  </label>
                </div>
                <p className="muted">
                  Purchase options apply to both Membership and Booking. Turn off one-time purchase to require automatic renewal. Customers must still agree to renewal terms. If neither option is available, new purchases are unavailable.
                </p>
                <p className="muted">
                  Turn off “Offer this Pass on Membership” to remove it from the
                  purchase section. Existing paid Passes and renewal agreements
                  are retained.
                </p>
                {(!supportsRenewalPeriod(plan.validityMonths) || plan.introOnly) && (
                  <p className="muted">
                    Automatic renewal is currently available only for
                    calendar-month Passes without a first-time-customer
                    restriction.
                  </p>
                )}
                <div className="actions">
                  <button className="primary" type="submit">
                    {busy ? "Saving…" : "Save purchase settings"}
                  </button>
                </div>
              </fieldset>
            </Form>
          </article>
        ))}
      </section>
      <section
        className="panel record-list"
        aria-labelledby="membership-payments-heading"
      >
        <h2 id="membership-payments-heading">Payments to check</h2>
        <p className="muted">
          {data.attentionCount} need attention · {data.waitingCount} waiting.
          Showing the latest {data.purchases.length} unresolved purchases. Check
          the original Shopify transaction before collecting another payment.
        </p>
        {!data.purchases.length && (
          <p className="empty">No unresolved membership payments.</p>
        )}
        {data.purchases.map((purchase) => (
          <article className="record" key={purchase.id}>
            <div>
              <h3>{purchase.customerName}</h3>
              {purchase.disambiguation && (
                <p className="muted">{purchase.disambiguation}</p>
              )}
              <p>
                {purchase.planName} · Period {purchase.cycle} ·{" "}
                {purchase.currency} {(purchase.priceCents / 100).toFixed(2)}
              </p>
              <Status>{purchase.statusLabel}</Status>
              <p className="muted">Updated {date(purchase.updatedAt)}</p>
              {purchase.attention && (
                <p className="muted">
                  Reconcile the original payment before changing this
                  customer&apos;s payment or Pass.
                </p>
              )}
            </div>
            {purchase.orderUrl && (
              <a href={purchase.orderUrl} target="_blank" rel="noreferrer">
                View Shopify order
              </a>
            )}
          </article>
        ))}
      </section>
      <section
        className="panel record-list"
        aria-labelledby="membership-history-heading"
      >
        <h2 id="membership-history-heading">
          Payment receipts and renewal email history
        </h2>
        <p className="muted">
          {data.receiptCount} retained receipts. Each confirmed payment keeps
          its original amount and Pass terms. View the Shopify order for
          transaction details; invoices depend on the store&apos;s invoice
          setup. An email marked ACCEPTED has been accepted by the mail
          provider; it does not prove delivery.
        </p>
        <Status>{data.mail.label}</Status>
        <p className="muted">
          Payment checks and receipt retention work without an app email
          service. Unsent email content is retained below. Shopify order
          confirmations are separate; check their status in the Shopify order or
          customer timeline. No Shopify email delivery is inferred here.
        </p>
        {!data.receipts.length && (
          <p className="empty">No confirmed membership payment receipts yet.</p>
        )}
        {data.receipts.map((receipt) => (
          <article
            className="record"
            key={receipt.id}
            style={{ display: "block" }}
          >
            <h3>
              {receipt.customerName} · {receipt.passName}
            </h3>
            <p>
              Period {receipt.cycle} · {receipt.currency}{" "}
              {(receipt.priceCents / 100).toFixed(2)}
            </p>
            <p className="muted">Receipt retained {date(receipt.issuedAt)}</p>
            <div className="actions">
              <a href={`/app/memberships/receipts/${receipt.id}`} download>
                Download payment receipt
              </a>
              {receipt.orderUrl && (
                <a href={receipt.orderUrl} target="_blank" rel="noreferrer">
                  View Shopify order
                </a>
              )}
            </div>
            {receipt.notification && (
              <>
                <Status>Email: {receipt.notification.statusLabel}</Status>
                {receipt.notification.deliveryStatus && (
                  <Status>
                    Provider status: {receipt.notification.deliveryStatus}
                  </Status>
                )}
                {receipt.notification.acceptedAt && (
                  <p className="muted">
                    Provider accepted {date(receipt.notification.acceptedAt)}
                  </p>
                )}
                {receipt.notification.lastError && (
                  <p className="muted">{receipt.notification.lastError}</p>
                )}
                {receipt.notification.deliveryError && (
                  <p className="muted">{receipt.notification.deliveryError}</p>
                )}
                {data.canEdit && receipt.notification.status === "ACCEPTED" && (
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="refresh-mail-status"
                    />
                    <input
                      type="hidden"
                      name="id"
                      value={receipt.notification.id}
                    />
                    <button disabled={busy}>Check email provider status</button>
                  </Form>
                )}
                <details>
                  <summary>Retained email content</summary>
                  <p>
                    Recipient:{" "}
                    {receipt.notification.recipientEmail || "Not submitted"}
                  </p>
                  <p>{receipt.notification.subject}</p>
                  <pre
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {receipt.notification.bodyText}
                  </pre>
                  {receipt.notification.providerMessageId && (
                    <p className="muted">
                      Provider message ID:{" "}
                      {receipt.notification.providerMessageId}
                    </p>
                  )}
                </details>
              </>
            )}
          </article>
        ))}
        {data.historyPages > 1 && (
          <nav className="actions" aria-label="Receipt history pagination">
            {data.historyPage > 1 && (
              <Link to={`?historyPage=${data.historyPage - 1}`}>Previous</Link>
            )}
            <span>
              Page {data.historyPage} / {data.historyPages}
            </span>
            {data.historyPage < data.historyPages && (
              <Link to={`?historyPage=${data.historyPage + 1}`}>Next</Link>
            )}
          </nav>
        )}
      </section>
    </main>
  );
}
