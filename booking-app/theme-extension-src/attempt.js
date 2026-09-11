// Server-owned recovery context; storage remembers only the opaque token.
window.SkyraBookingAttempt = function (root) {
  const surface = (root.dataset.surface || "programs").toUpperCase();
  const storageKey = "skyra-booking:" + surface.toLowerCase() + ":attempt";
  let current, sessionId, generation = 0;
  const terminal = data => ["EXPIRED", "RECOVERY"].includes(data.status);
  async function request(path, body) {
    const response = await fetch((root.dataset.proxyBase || "/apps/skyra-booking") + path, {
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Skyra-Booking": "1" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "We could not restore your booking. Please try again.");
      error.bookingError = true;
      throw error;
    }
    if (data.surface !== surface || !data.session?.id || !/^[A-Za-z0-9_-]{43}$/.test(data.token) || typeof data.requiresLogin !== "boolean") throw new Error("Invalid booking response");
    return data;
  }
  function cleanUrl() {
    const url = new URL(window.location.href);
    if (url.searchParams.has("skyra_attempt")) {
      url.searchParams.delete("skyra_attempt");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }
  }
  function forget(reset = false) {
    if (reset) { generation++; current = null; }
    try { sessionStorage.removeItem(storageKey); } catch { /* Recovery still works from the return URL. */ }
    cleanUrl();
  }
  return {
    select(id) {
      generation++;
      if (sessionId !== id || (current && terminal(current))) current = null;
      sessionId = id;
    },
    async check() {
      const revision = generation;
      const data = await request(current ? "/attempt" : "/start", current ? { token: current.token } : { sessionId, surface });
      if (revision !== generation) throw new Error("Booking selection changed");
      current = data;
      if (terminal(data)) {
        const error = new Error(data.status === "EXPIRED" ? "Your booking attempt expired. Close this window and choose the class again." : "This booking needs to be restarted. Close this window and check the latest class availability.");
        error.bookingError = true;
        throw error;
      }
      return !data.requiresLogin;
    },
    loginUrl() {
      if (!current) return "";
      const destination = new URL(current.returnPath, window.location.origin);
      const expectedPath = surface === "HOME" ? "/" : "/pages/programs";
      if (destination.origin !== window.location.origin || destination.pathname !== expectedPath) throw new Error("Invalid booking return path");
      return "/customer_authentication/login?return_to=" + encodeURIComponent(destination.pathname + destination.search + destination.hash);
    },
    remember() {
      if (!current) return;
      try { sessionStorage.setItem(storageKey, current.token); } catch { /* Token also travels in the server-generated Shopify return URL. */ }
    },
    forget,
    token: () => current?.token,
    async restore() {
      const url = new URL(window.location.href);
      // A page with two mounts restores only the originating surface.
      if (url.hash && url.hash !== "#" + root.id) return null;
      let token = url.searchParams.get("skyra_attempt");
      try { token ||= sessionStorage.getItem(storageKey); } catch { /* Storage is optional. */ }
      if (!token) return null;
      try {
        current = await request("/attempt", { token });
        sessionId = current.session.id;
        // Strip bearer material from the visible URL after the server resolves it.
        this.remember();
        cleanUrl();
        return current;
      } catch (error) {
        forget();
        throw error;
      }
    }
  };
};
document.dispatchEvent(new Event("skyra:attempt-ready"));
