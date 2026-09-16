import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";

const navigation = [
  { key: "today", label: "Today", href: "/coach#today" },
  {
    key: "schedule",
    label: "My schedule",
    href: "/coach#schedule",
  },
] as const;

export function CoachPortalShell({
  coachName,
  active,
  children,
}: {
  coachName: string;
  active?: "today" | "schedule";
  children: ReactNode;
}) {
  const [current, setCurrent] = useState(active);

  useEffect(() => {
    const syncHash = () => {
      if (window.location.pathname !== "/coach") return;
      setCurrent(window.location.hash === "#schedule" ? "schedule" : "today");
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  return (
    <div className="coach-portal">
      <header className="coach-portal-header">
        <div className="coach-portal-bar">
          <Link className="coach-brand" to="/coach#today">
            <span className="coach-brand-mark" aria-hidden="true">
              S
            </span>
            <span>
              <strong>Skyra</strong>
              <small>Coach portal</small>
            </span>
          </Link>
          <div className="coach-account">
            <span className="coach-avatar" aria-hidden="true">
              {coachName.trim().charAt(0).toUpperCase() || "C"}
            </span>
            <span className="coach-account-name">
              <small>Signed in as</small>
              <strong>{coachName}</strong>
            </span>
            <form method="post" action="/coach/logout">
              <button className="coach-sign-out">Sign out</button>
            </form>
          </div>
        </div>
        <nav className="coach-nav" aria-label="Coach portal">
          {navigation.map((item) => {
            const isCurrent = current === item.key;
            return (
              <Link
                className={isCurrent ? "active" : undefined}
                aria-current={isCurrent ? "page" : undefined}
                to={item.href}
                key={item.key}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="workspace coach-workspace">{children}</main>
      <footer className="coach-portal-footer">
        This portal only shows your assigned sessions and the customer details
        needed to run them.
      </footer>
    </div>
  );
}
