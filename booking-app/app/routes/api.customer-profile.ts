import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { customerAccountRequest } from "../services/customer-account-auth.server";
import {
  customerProfileData,
  updateCustomerProfile,
} from "../services/customer-profile.server";

export function loader({ request }: LoaderFunctionArgs) {
  return customerAccountRequest(request, (actor) => customerProfileData(actor));
}

export function action({ request }: ActionFunctionArgs) {
  return customerAccountRequest(request, updateCustomerProfile, {
    maxBodyBytes: 768 * 1024,
  });
}
