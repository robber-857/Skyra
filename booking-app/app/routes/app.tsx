import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { adminContext } from "../services/context.server";
import "../styles/admin.css";
import { NavMenu } from "@shopify/app-bridge-react";
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await adminContext(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};
export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <a href="/app">Overview</a>
        <a href="/app/people">People</a>
        <a href="/app/catalog">Classes &amp; Passes</a>
        <a href="/app/schedule">Weekly Schedule</a>
        <a href="/app/bookings">Bookings</a>
        <a href="/app/reports">Reports</a>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
