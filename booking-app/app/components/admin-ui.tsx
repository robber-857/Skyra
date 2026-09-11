import type { ReactNode } from "react";
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Status({ children }: { children: ReactNode }) {
  return <span className="status">{children}</span>;
}
export function Feedback({
  result,
}: {
  result: { error?: string; message?: string } | undefined;
}) {
  return result ? (
    <p
      className={result.error ? "feedback error" : "feedback"}
      role={result.error ? "alert" : "status"}
    >
      {result.error || result.message}
    </p>
  ) : null;
}
