import bookingTerms from "../app/lib/booking-terms.json";
import { passValidity, renewalChoice, renewalDescription, renewalTermsVersion } from "./pass-purchase-ui.js";
import { storefrontLoginUrl } from "./storefront-login.js";

const storageKey = "skyra-memberships:purchase";
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const button = (text, action, secondary = false) => {
  const element = node("button", secondary ? "membership-shop__secondary" : "membership-shop__button", text);
  element.type = "button";
  element.addEventListener("click", action);
  return element;
};
const money = (pass) => new Intl.NumberFormat("en-AU", { style: "currency", currency: pass.currency }).format(pass.priceCents / 100);
const date = (value) => new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric" }).format(new Date(value));

function mount(root) {
  if (root.dataset.membershipsMounted) return;
  root.dataset.membershipsMounted = "true";
  let catalog;
  let pending;
  let revision = 0;
  const base = root.dataset.proxyBase || "/apps/skyra-booking";
  const returnPath = "/pages/membership#membership-options";
  const signIn = () => {
    try {
      window.location.assign(storefrontLoginUrl({ returnPath, expectedPath: "/pages/membership", shopDomain: root.dataset.shopDomain, themeId: root.dataset.themeId }));
    } catch (error) { failure(error); }
  };
  const remember = () => {
    try {
      if (pending) sessionStorage.setItem(storageKey, JSON.stringify(pending));
      else sessionStorage.removeItem(storageKey);
    } catch { /* The server still prevents another purchase for the same membership. */ }
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (saved && typeof saved.passPlanId === "string" && /^[0-9a-f-]{36}$/i.test(saved.idempotencyKey || "") && typeof saved.autoRenew === "boolean") pending = saved;
  } catch { /* Storage is optional; the catalog remains authoritative. */ }

  async function request(path, body) {
    const response = await fetch(base + "/memberships/" + path, {
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Skyra-Booking": "1" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "We could not check your pass. Please try again.");
      error.code = data.code;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function frame(title) {
    root.replaceChildren();
    const heading = node("h3", "membership-shop__title", title);
    heading.tabIndex = -1;
    root.append(heading);
    return root;
  }

  function notice(text, alert = false) {
    const element = node("p", "membership-shop__notice", text);
    element.setAttribute("role", alert ? "alert" : "status");
    return element;
  }

  function failure(error, retry = load) {
    frame("Your passes");
    root.append(notice(error.message || "The connection was interrupted. Please try again.", true));
    root.append(button(error.code === "LOGIN_REQUIRED" ? "Sign in to continue" : "Try again", error.code === "LOGIN_REQUIRED" ? signIn : retry));
  }

  async function load() {
    const current = ++revision;
    frame("Membership passes").append(notice("Loading passes and checking your account…"));
    try {
      const data = await request("catalog", {});
      if (current !== revision || !root.isConnected) return;
      if (!Array.isArray(data.passes) || !Array.isArray(data.memberships) || typeof data.authenticated !== "boolean") throw new Error("Pass availability could not be verified. Please try again.");
      catalog = data;
      renderCatalog();
    } catch (error) {
      if (current === revision && root.isConnected) failure(error);
    }
  }

  function renderMembership(item) {
    const card = node("article", "membership-shop__owned");
    card.id = root.id + "-membership-" + item.id;
    card.append(node("h4", "", item.name));
    const paymentMessage = {
      FAILED: "The payment could not be completed. Contact Skyra Studio to review it before purchasing this pass again.",
      ACTION_REQUIRED: "Your bank needs payment verification. Complete the verification for this existing payment before purchasing again.",
      REVIEW: "Your payment needs to be checked by Skyra Studio. Please do not make another payment for this pass.",
      UNKNOWN: "The payment result has not been confirmed. Please contact Skyra Studio before trying another payment.",
    }[item.paymentStatus];
    const status = paymentMessage || (item.hasPendingPayment ? "Payment is being checked. Please do not buy this pass again." : item.expiresAt ? `${item.blocksPurchase === false ? "Previous pass expired" : "Current pass expires"} ${date(item.expiresAt)}.` : "Waiting for your first attended class. Your pass dates will be set when attendance is confirmed.");
    card.append(node("p", "", status), node("p", "", item.autoRenew ? "Automatic renewal is on." : item.autoRenewRequested ? "Automatic renewal is awaiting setup. You can turn off future renewals below." : "Automatic renewal is off."));
    const schedule = node("a", "membership-shop__secondary", "Book a class");
    schedule.href = "/pages/programs#skyra-booking-programs";
    card.append(schedule);
    if (item.paymentStatus === "ACTION_REQUIRED" && typeof item.purchaseId === "string") {
      card.append(button("Complete payment verification", () => result(item.purchaseId)));
    }
    if (paymentMessage) {
      const contact = node("a", "membership-shop__secondary", "Contact Skyra Studio");
      contact.href = "mailto:hello@skyrastudio.com.au";
      card.append(contact);
    }
    if (item.canCancel) {
      card.append(button("Turn off automatic renewal", () => {
        const confirmPanel = node("div", "membership-shop__confirmation");
        confirmPanel.append(notice("Turn off future renewals? Your already paid pass stays available under its current terms."));
        confirmPanel.append(button("Confirm cancellation", () => cancel(item)), button("Keep renewal on", () => renderCatalog(), true));
        card.replaceChildren(node("h4", "", item.name), confirmPanel);
      }, true));
    }
    return card;
  }

  function renderCatalog() {
    frame("Choose your pass");
    root.append(node("p", "membership-shop__intro", "Buy a pass now and choose your classes later. Available passes, prices and renewal options are checked before payment."));
    if (!catalog.authenticated) root.append(notice("Sign in to check your existing passes before purchasing."), button("Sign in", signIn));
    if (catalog.authenticated && pending) {
      const recovery = node("div", "membership-shop__recovery");
      recovery.append(notice("You have a purchase to check. Continue the existing payment or check its result before starting another purchase."));
      recovery.append(button("Check existing purchase", () => pending.purchaseId ? result() : purchase(pending)));
      root.append(recovery);
    }
    if (catalog.memberships.length) {
      const owned = node("section", "membership-shop__current");
      owned.append(node("h4", "membership-shop__subtitle", "Your current passes"));
      catalog.memberships.forEach((item) => owned.append(renderMembership(item)));
      root.append(owned);
    }
    if (!catalog.passes.length) {
      root.append(notice("No passes are available to purchase online right now. Please contact Skyra Studio."), button("Check availability again", load, true));
      return;
    }
    if (!catalog.checkoutAvailable) root.append(notice("Online pass checkout is not available yet. Please contact Skyra Studio to purchase a pass."));
    const grid = node("div", "membership-shop__grid");
    for (const pass of catalog.passes) {
      const card = node("article", "membership-shop__card");
      const title = node("div", "membership-shop__card-title");
      title.append(node("h4", "", pass.name), node("strong", "", money(pass)));
      card.append(title, node("p", "membership-shop__validity", passValidity(pass)));
      let autoRenew = false;
      const renewal = renewalChoice({ pass, name: root.id + "-" + pass.id + "-renewal", className: "membership-shop__renewal", onChange: (value) => { autoRenew = value; } });
      if (renewal) card.append(renewal);
      const current = catalog.memberships.find((item) => item.passPlanId === pass.id && (typeof item.blocksPurchase === "boolean" ? item.blocksPurchase : item.hasPendingPayment || item.autoRenew || !["CANCELLED", "EXPIRED"].includes(item.status)));
      if (current) {
        card.append(notice("You already have this pass or a payment in progress. Check your current pass above before buying again."));
        card.append(button("View your current pass", () => document.getElementById(root.id + "-membership-" + current.id)?.scrollIntoView({ behavior: "smooth", block: "center" }), true));
      } else {
        const proceed = button(catalog.authenticated ? "Review pass" : "Sign in to buy", () => catalog.authenticated ? review(pass, autoRenew) : signIn());
        proceed.disabled = catalog.authenticated && (!catalog.checkoutAvailable || !!pending);
        card.append(proceed);
      }
      grid.append(card);
    }
    root.append(grid);
  }

  function review(pass, autoRenew) {
    if (pending) { renderCatalog(); return; }
    if (autoRenew && !pass.autoRenew?.available) { load(); return; }
    frame("Review your pass");
    root.append(button("Back to passes", renderCatalog, true));
    const summary = node("div", "membership-shop__review");
    summary.append(node("h4", "", pass.name), node("p", "", passValidity(pass)), node("strong", "membership-shop__price", money(pass)));
    summary.append(notice(autoRenew ? renewalDescription(pass, money(pass)) : "One-time purchase. No automatic renewal payment will be taken. This purchase does not reserve a class."));
    root.append(summary);
    const proceed = button("Continue to Shopify Checkout", () => {
      if (!terms.checked || (renewal && !renewal.checked)) return;
      pending = { passPlanId: pass.id, expectedVersion: pass.version, expectedPriceCents: pass.priceCents, autoRenew, idempotencyKey: crypto.randomUUID(), termsAcceptance: { accepted: true, version: bookingTerms.version }, ...(autoRenew ? { autoRenewAcceptance: { accepted: true, version: pass.autoRenew.termsVersion || renewalTermsVersion } } : {}) };
      remember();
      purchase(pending);
    });
    const consent = (text) => {
      const label = node("label", "membership-shop__consent");
      const input = node("input"); input.type = "checkbox"; input.required = true;
      const copy = node("span", "", text);
      label.append(input, copy); root.append(label);
      return { input, copy };
    };
    const agreement = consent("I have read and agree to the ");
    const terms = agreement.input;
    const termsLink = node("a", "", "Terms & Conditions");
    termsLink.href = bookingTerms.url; termsLink.target = "_blank"; termsLink.rel = "noopener noreferrer";
    agreement.copy.append(termsLink, document.createTextNode("."));
    const renewal = autoRenew ? consent("I authorise the renewal payment at each pass expiry and understand that no further payment is taken while the next pass awaits activation.").input : null;
    const update = () => { proceed.disabled = !terms.checked || (renewal && !renewal.checked); };
    terms.addEventListener("change", update); renewal?.addEventListener("change", update); update();
    root.append(proceed);
    root.querySelector("h3")?.focus({ preventScroll: true });
  }

  async function purchase(input) {
    const current = ++revision;
    frame("Checking your existing payment").append(notice("Please wait while we prepare your secure Shopify checkout. This request uses the same purchase reference if you retry."));
    try {
      const body = { ...input };
      delete body.purchaseId;
      const data = await request("purchase", body);
      if (current !== revision || !root.isConnected) return;
      if (typeof data.purchaseId === "string") { pending = { ...input, purchaseId: data.purchaseId }; remember(); }
      if (data.status === "CHECKOUT_READY") {
        const url = new URL(data.checkoutUrl);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("Checkout could not be verified. Please check the existing purchase again.");
        window.location.assign(url.href);
        return;
      }
      showResult(data, data.purchaseId || input.purchaseId);
    } catch (error) {
      if (current !== revision || !root.isConnected) return;
      frame("Check your purchase before paying again");
      root.append(notice(error.message || "The connection was interrupted. We need to check the existing purchase before you try again.", true));
      root.append(button(error.code === "LOGIN_REQUIRED" ? "Sign in to check" : "Check the same purchase again", error.code === "LOGIN_REQUIRED" ? signIn : () => purchase(input)));
      const noPurchase = ["AUTO_RENEW_UNAVAILABLE", "MEMBERSHIP_UNAVAILABLE", "PASS_UNAVAILABLE", "TERMS_REQUIRED", "AUTO_RENEW_TERMS_REQUIRED", "VALIDATION", "PASS_ALREADY_OWNED", "PASS_PAYMENT_IN_PROGRESS", "PASS_QUOTE_CHANGED"].includes(error.code);
      if (noPurchase && !input.purchaseId) root.append(button("Return to passes", () => { pending = null; remember(); load(); }, true));
      const contact = node("a", "membership-shop__secondary", "Contact Skyra Studio");
      contact.href = "mailto:hello@skyrastudio.com.au";
      root.append(contact);
    }
  }

  function showResult(data, purchaseId = pending?.purchaseId) {
    const paid = data.status === "PAID";
    const needsVerification = data.status === "ACTION_REQUIRED";
    frame(paid ? "Your pass is ready" : needsVerification ? "Verify your existing payment" : data.status === "NEEDS_ATTENTION" ? "Your payment needs a check" : "Checking your payment");
    if (data.name) root.append(node("h4", "", data.name));
    root.append(notice(paid ? "Payment is confirmed. Your pass is ready to use. Book a class to get started." : needsVerification ? "Complete your bank's verification for the existing payment. A secure verification page opens in a new tab. Return here afterwards to check your payment status; do not start another purchase." : "We have not yet confirmed this purchase. Please do not make another payment. Check again or contact Skyra Studio."));
    if (needsVerification) {
      try {
        const action = new URL(data.actionUrl);
        if (action.protocol !== "https:" || action.username || action.password) throw new Error("Invalid verification URL");
        const link = node("a", "membership-shop__button", "Continue payment verification");
        link.href = action.href; link.target = "_blank"; link.rel = "noopener noreferrer";
        root.append(link);
      } catch {
        root.append(notice("The payment verification link could not be verified. Check the payment status again or contact Skyra Studio.", true));
      }
    }
    if (paid) {
      if (pending?.purchaseId === purchaseId) { pending = null; remember(); }
      root.append(button("View your passes", load));
    }
    else {
      root.append(button("Check payment status", () => result(purchaseId)));
      if (data.status === "PENDING" && pending?.purchaseId === purchaseId) root.append(button("Continue existing checkout", () => purchase(pending), true));
    }
    const contact = node("a", "membership-shop__secondary", "Contact Skyra Studio");
    contact.href = "mailto:hello@skyrastudio.com.au"; root.append(contact);
  }

  async function result(purchaseId = pending?.purchaseId) {
    if (typeof purchaseId !== "string") { if (pending) return purchase(pending); return load(); }
    const current = ++revision;
    frame("Checking your payment").append(notice("Checking your original purchase…"));
    try {
      const data = await request("result", { purchaseId });
      if (current === revision && root.isConnected) showResult(data, purchaseId);
    } catch (error) {
      if (current === revision && root.isConnected) failure(error, () => result(purchaseId));
    }
  }

  async function cancel(item) {
    const current = ++revision;
    frame("Updating automatic renewal").append(notice("Checking whether a renewal payment is already in progress…"));
    try {
      const data = await request("cancel", { membershipId: item.id });
      if (current !== revision || !root.isConnected) return;
      frame(data.status === "CANCELLED" ? "Automatic renewal is off" : "Check your renewal");
      root.append(notice(data.message || "Your renewal settings have been updated."), button("View your passes", load));
    } catch (error) {
      if (current === revision && root.isConnected) failure(error);
    }
  }
  void load();
}

function initialize() { document.querySelectorAll("[data-skyra-memberships]").forEach(mount); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
else initialize();
document.addEventListener("shopify:section:load", initialize);
