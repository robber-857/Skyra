import { type LoaderFunctionArgs } from "react-router";
import { adminContext } from "../services/context.server";
export async function loader({ request }: LoaderFunctionArgs) {
  await adminContext(request);
  return null;
}
export default function Bookings() {
  return (
    <main className="workspace">
      <h1>Bookings</h1>
      <p className="feedback">
        Customer booking operations will become available after the booking
        engine and policy checks are complete.
      </p>
    </main>
  );
}
