import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form } from "react-router";
import styles from "./styles.module.css";
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop"))
    throw redirect("/app?" + url.searchParams.toString());
  return null;
};
export default function App() {
  return (
    <main className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Skyra Booking</h1>
        <p className={styles.text}>
          Manage classes, passes and your studio timetable.
        </p>
        <Form className={styles.form} method="post" action="/auth/login">
          <label className={styles.label}>
            <span>Shop domain</span>
            <input
              className={styles.input}
              type="text"
              name="shop"
              required
              placeholder="your-store.myshopify.com"
            />
          </label>
          <button className={styles.button} type="submit">
            Open in Shopify
          </button>
        </Form>
      </div>
    </main>
  );
}
