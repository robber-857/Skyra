import { CashCreditForm } from "../components/cash-credit-form";
import { StaffBookingForm } from "../components/staff-booking-form";
import { AttendanceBackfillForm } from "../components/attendance-backfill-form";
import {
  attendanceBackfillOptions,
  backfillAttendance,
} from "../services/attendance-backfill.server";
import {
  bookClientIntoSession,
  staffBookingOptions,
} from "../services/staff-booking.server";
import { PassCreditAdjustmentForm } from "../components/pass-credit-adjustment-form";
import { updateClientPass } from "../services/pass-credit-adjustment.server";
import { randomUUID } from "node:crypto";
import {
  redirect,
  useActionData,
  useLoaderData,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { Feedback } from "../components/admin-ui";
import {
  grantCashCredits,
  manualCreditOptions,
} from "../services/manual-credits.server";
import { adminContext } from "../services/context.server";
import { adminClientDetail } from "../services/admin-clients.server";
import { refreshClientContacts } from "../services/client-contacts.server";
import { publicError } from "../lib/errors.server";
import { AdminClientDetailView } from "../components/admin-clients-view";
import { AdminFamilySection } from "../components/admin-family-section";
import { addAdminFamilyMember } from "../services/family-accounts.server";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { actor, admin } = await adminContext(request),
    url = new URL(request.url);
  const query = { passPage: url.searchParams.get("passPage") || 1 };
  // Verify the profile belongs to this shop before requesting any contact data.
  await adminClientDetail(actor, params.clientId, query);
  let warning: string | null = null;
  try {
    await refreshClientContacts(actor, admin.graphql, [params.clientId!]);
  } catch (error) {
    warning = publicError(error).error;
  }
  return {
    data: await adminClientDetail(actor, params.clientId, query),
    warning,
    creditOptions: await manualCreditOptions(actor),
    bookingOptions: await staffBookingOptions(actor, params.clientId!),
    canBookUntilStart: actor.role === "ADMIN",
    attendanceOptions: await attendanceBackfillOptions(
      actor,
      params.clientId!,
      url.searchParams.get("attendanceDate"),
    ),
    idempotencyKey: randomUUID(),
  };
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export async function action({ request, params }: ActionFunctionArgs) {
  const { actor, admin } = await adminContext(request);
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  const form = await request.formData();
  try {
    if (form.get("intent") === "add-family-member") {
      const member = await addAdminFamilyMember(
        actor,
        admin.graphql,
        params.clientId,
        {
          firstName: form.get("firstName"),
          lastName: form.get("lastName"),
          emailPrefix: form.get("emailPrefix"),
          phone: form.get("phone"),
          idempotencyKey: form.get("idempotencyKey"),
        },
      );
      return redirect(`/app/clients/${member.id}?familyCreated=1`);
    }
    if (form.get("intent") === "backfill-attendance") {
      if (form.get("confirmed") !== "on")
        return {
          error: "Confirm attendance and the selected Pass before recording.",
        };
      const bookingId = await backfillAttendance(actor, {
        customerId: params.clientId,
        sessionId: form.get("sessionId"),
        entitlementId: form.get("entitlementId"),
        reason: form.get("reason"),
        idempotencyKey: form.get("idempotencyKey"),
      });
      return {
        message: `Attendance recorded. One Pass credit used. Reference: ${bookingId}`,
      };
    }
    if (form.get("intent") === "book-class") {
      if (form.get("confirmed") !== "on")
        return { error: "Confirm the client, class and Pass before booking." };
      const bookingId = await bookClientIntoSession(actor, {
        customerId: params.clientId,
        sessionId: form.get("sessionId"),
        entitlementId: form.get("entitlementId"),
        reason: form.get("reason"),
        idempotencyKey: form.get("idempotencyKey"),
      });
      return {
        message: `Booking confirmed. One Pass credit reserved. Reference: ${bookingId}`,
      };
    }
    if (form.get("intent") === "adjust-pass") {
      if (form.get("confirmed") !== "on")
        return { error: "Confirm the Pass credits and expiry." };
      await updateClientPass(actor, {
        customerId: params.clientId,
        entitlementId: form.get("entitlementId"),
        available: form.get("available"),
        expectedAvailable: form.get("expectedAvailable"),
        expectedRevision: form.get("expectedRevision"),
        expectedExpiresAt: form.get("expectedExpiresAt") || null,
        expiryDate: form.get("expiryDate"),
        reason: form.get("reason"),
        idempotencyKey: form.get("idempotencyKey"),
      });
      return {
        message:
          "Pass credits and expiry saved. The adjustment and reason have been recorded.",
      };
    }
    if (form.get("confirmed") !== "on")
      return { error: "Confirm the cash payment and credit grant." };
    await grantCashCredits(actor, {
      customerId: params.clientId,
      target: form.get("target"),
      units: form.get("units"),
      validityDays: form.get("validityDays"),
      amount: form.get("amount"),
      reason: form.get("reason"),
      idempotencyKey: form.get("idempotencyKey"),
    });
    return {
      message:
        "Cash payment recorded and credits added. No Shopify checkout was created.",
    };
  } catch (error) {
    return { ...publicError(error), intent: String(form.get("intent") ?? "") };
  }
}

export default function Client() {
  const data = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const result = useActionData<typeof action>();
  const familyResult =
    result && "intent" in result && result.intent === "add-family-member"
      ? result
      : undefined;
  return (
    <AdminClientDetailView
      {...data}
      familySection={
        <AdminFamilySection
          key={data.data.client.id}
          client={data.data.client}
          family={data.data.family}
          idempotencyKey={data.idempotencyKey}
          result={familyResult}
        />
      }
      passAdjustmentForm={(pass) => (
        <PassCreditAdjustmentForm
          key={`${pass.id}:${data.idempotencyKey}`}
          pass={pass}
          idempotencyKey={data.idempotencyKey}
        />
      )}
      creditForm={
        <>
          <Feedback
            result={
              (familyResult ? undefined : result) ??
              (searchParams.get("familyCreated") === "1"
                ? {
                    message:
                      "Family member created. Book classes and manage Passes for this client below.",
                  }
                : searchParams.get("updated") === "1"
                  ? { message: "Client details updated." }
                  : undefined)
            }
          />
          <div id="client-book-class">
            <StaffBookingForm
              key={`booking:${data.idempotencyKey}`}
              options={data.bookingOptions}
              clientName={data.data.client.name}
              idempotencyKey={data.idempotencyKey}
              canBookUntilStart={data.canBookUntilStart}
            />
          </div>
          <AttendanceBackfillForm
            key={`attendance:${data.idempotencyKey}`}
            data={data.attendanceOptions}
            clientName={data.data.client.name}
            idempotencyKey={data.idempotencyKey}
          />
          <CashCreditForm
            key={data.idempotencyKey}
            options={data.creditOptions}
            idempotencyKey={data.idempotencyKey}
          />
        </>
      }
    />
  );
}
