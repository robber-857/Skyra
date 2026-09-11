import { type LoaderFunctionArgs } from "react-router";
import { adminContext } from "../services/context.server";
export async function loader({ request }: LoaderFunctionArgs) {
  await adminContext(request);
  return null;
}
export default function Reports() {
  return (
    <main className="workspace">
      <h1>Reports</h1>
      <p className="feedback">
        Spending and unused-pass reports will become available after order and
        entitlement integration.
      </p>
    </main>
  );
}
