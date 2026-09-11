// UI gate only: reservation and Pass APIs must authenticate every server request.
function loginGate(root, copy, { save, cancel, proceed, url, check, recover }) {
  copy = Object.assign({
    signInTitle: "Sign in to continue",
    signInBody: "Use your Skyra account to select a pass and book this class.",
    signIn: "Sign in with Shopify",

    loginClose: "Close sign in",
    loginChecking: "Checking your sign-in status…",
    loginWaiting: "Complete sign in in the window that opened, then return here. Your class is saved.",
    loginBlocked: "Your browser blocked the sign-in window. Continue in this tab to sign in.",
    loginSameTab: "Continue in this tab",
    loginCheckAgain: "Check sign-in status",
    loginError: "We could not verify your sign-in status. Please check your connection and try again.",
  }, copy);
  let dialog, popup, timer, trigger, previousOverflow;
  let checking = false;
  let generation = 0;
  function node(tag, className, text) {
    const item = document.createElement(tag);
    item.className = className;
    item.textContent = text;
    return item;
  }
  async function authenticated() {
    if (check) return check();
    const response = await fetch((root.dataset.proxyBase || "/apps/skyra-booking") + "/auth?_=" + Date.now(), {
      credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("Sign-in check failed");
    const result = await response.json();
    if (typeof result.authenticated !== "boolean") throw new Error("Invalid sign-in response");
    return result.authenticated;
  }
  function stop() {
    generation++;
    clearInterval(timer);
    window.removeEventListener("focus", refresh);
    if (popup && !popup.closed) popup.close();
    popup = null;
    if (dialog) {
      dialog.close();
      dialog.remove();
      dialog = null;
      document.documentElement.style.overflow = previousOverflow;
    }
    checking = false;
  }
  function dismiss() {
    stop(); cancel(); trigger?.focus({ preventScroll: true });
  }
  function finish() { stop(); proceed(); }
  function showStatus(message, canSignIn = false) {
    if (!dialog) return;
    dialog.querySelector("[data-login-status]").textContent = message;
    dialog.querySelector("[data-login-open]").hidden = !canSignIn;
    const fallback = dialog.querySelector("[data-login-same-tab]");
    if (canSignIn) fallback.href = url();
    fallback.hidden = !canSignIn;
  }
  async function refresh() {
    if (!dialog || checking) return;
    const current = generation;
    checking = true;
    try {
      const signedIn = await authenticated();
      if (current !== generation || !root.isConnected) return;
      if (signedIn) return finish();
      showStatus(popup && !popup.closed ? copy.loginWaiting : copy.signInBody, true);
    } catch (error) {
      if (current === generation) {
        if (error.restartRequired && recover) { stop(); recover(error); }
        else showStatus(error.bookingError ? error.message : copy.loginError);
      }
    } finally {
      if (current === generation) checking = false;
    }
  }
  function openPopup() {
    save(true);
    if (window.matchMedia("(max-width: 720px)").matches) {
      window.location.assign(url());
      return;
    }
    // Synchronous user gesture; Shopify owns credential entry in a top-level window.
    const width = Math.min(520, window.screen.availWidth);
    const height = Math.min(760, window.screen.availHeight);
    popup = window.open(url(), "skyra-booking-login", "popup=yes,width=" + width + ",height=" + height +
      ",left=" + Math.max(0, window.screenX + (window.outerWidth - width) / 2) +
      ",top=" + Math.max(0, window.screenY + (window.outerHeight - height) / 2));
    showStatus(popup ? copy.loginWaiting : copy.loginBlocked, true);
    window.addEventListener("focus", refresh);
    clearInterval(timer);
    const started = Date.now();
    timer = setInterval(() => {
      if (!root.isConnected) return dismiss();
      // COOP may sever the handle: closing a window is never proof of login.
      if (!popup || popup.closed || Date.now() - started > 120000) clearInterval(timer);
      void refresh();
    }, 1500);
  }
  function show(session, origin) {
    if (dialog) return;
    trigger = origin;
    save(false);
    dialog = node("dialog", "skyra-booking__login", "");
    dialog.setAttribute("aria-labelledby", root.id + "-login-title");
    dialog.setAttribute("aria-describedby", root.id + "-login-status");
    const close = node("button", "skyra-booking__login-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", copy.loginClose);
    close.addEventListener("click", dismiss);
    const brand = node("p", "skyra-booking__login-brand", "SKYRA");
    const title = node("h3", "", copy.signInTitle);
    title.id = root.id + "-login-title";
    const summary = node("p", "skyra-booking__login-summary", session.service.name);
    const status = node("p", "skyra-booking__login-status", copy.loginChecking);
    status.id = root.id + "-login-status";
    status.dataset.loginStatus = "";
    status.setAttribute("role", "status");
    const signIn = node("button", "skyra-booking__primary", copy.signIn);
    signIn.type = "button";
    signIn.dataset.loginOpen = "";
    signIn.hidden = true;
    signIn.addEventListener("click", openPopup);
    const sameTab = node("a", "skyra-booking__login-link", copy.loginSameTab);
    sameTab.href = url();
    sameTab.dataset.loginSameTab = "";
    sameTab.hidden = true;
    sameTab.addEventListener("click", () => save(true));
    const retry = node("button", "skyra-booking__login-link", copy.loginCheckAgain);
    retry.type = "button";
    retry.addEventListener("click", refresh);
    dialog.append(close, brand, title, summary, status, signIn, sameTab, retry);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll("button:not(:disabled), a[href]")].filter(item => !item.hidden);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    root.append(dialog);
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
    close.focus();
    void refresh();
  }
  return { show, authenticated };
}

window.SkyraBookingLogin = loginGate;
document.dispatchEvent(new Event("skyra:login-ready"));
