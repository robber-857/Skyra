import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { customerAccountRequest } from "../services/customer-account-auth.server";
import { customerAccountData } from "../services/customer-account.server";
import { customerChangeBooking } from "../services/booking-lifecycle.server";
export function loader({ request }: LoaderFunctionArgs) {
  return customerAccountRequest(request, customerAccountData);
}
export function action({ request }: ActionFunctionArgs) {
  return customerAccountRequest(request, customerChangeBooking);
}
