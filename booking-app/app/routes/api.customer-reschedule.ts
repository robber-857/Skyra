import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { customerAccountRequest } from "../services/customer-account-auth.server";
import {
  customerReschedule,
  rescheduleOptions,
} from "../services/booking-reschedule.server";
export function loader({ request }: LoaderFunctionArgs) {
  return customerAccountRequest(request, (actor, input) =>
    rescheduleOptions({ kind: "CUSTOMER", actor }, input),
  );
}
export function action({ request }: ActionFunctionArgs) {
  return customerAccountRequest(request, customerReschedule);
}
