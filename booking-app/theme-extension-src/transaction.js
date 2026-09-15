import {
  prepareNativeBookingCart,
  submitNativeCheckout,
} from "./native-cart.js";

// Selection and Review stay inside the originating Home/Programs section.
window.SkyraBookingTransaction = function ({
  root,
  attempt,
  session,
  timezone,
  back,
  shell,
  restart,
  signIn,
}) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const button = (text, cls, action) => {
    const b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  };
  const money = (pass) => kind(pass) === "OWNED_PASS" ? "1 class credit" :
    new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: pass.currency,
    }).format(pass.priceCents / 100);
  const kind = (option) => option.kind || "NEW_PASS";
  const key = (option) => kind(option) + ":" + option.id;
  const options = (data) => [
    ...(data.ownedPasses || []),
    ...(data.dropIn ? [data.dropIn] : []),
    ...data.passes,
  ];
  const terms = (option) =>
    kind(option) === "OWNED_PASS" ? option.availableUnits + " credits available · Expires " + format(option.expiresAt, {day:"numeric",month:"short",year:"numeric"}) : kind(option) === "DROP_IN"
      ? "One booking · This class only"
      : option.credits +
        " classes · Valid for " +
        option.validityDays +
        " days";
  const format = (value, options) =>
    new Intl.DateTimeFormat("en-AU", { timeZone: timezone, ...options }).format(
      new Date(value),
    );
  const host = el("div", "skyra-booking__transaction");
  let comment = attempt.customerComment || "", commentLoaded = false;
  let payload,
    selectedId,
    revision = 0;
  shell(host);
  const exit = () => {
    revision++;
    back();
  };
  function aside() {
    const panel = el("details", "skyra-booking__summary");
    panel.open = matchMedia("(min-width: 721px)").matches;
    panel.append(el("summary", "", "Booking Details"));
    const content = el("div");
    content.append(
      el("h3", "", session.service.name),
      el(
        "p",
        "",
        format(session.startsAt, {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        }),
      ),
      el(
        "p",
        "",
        format(session.startsAt, { hour: "numeric", minute: "2-digit" }) +
          " – " +
          format(session.endsAt, { hour: "numeric", minute: "2-digit" }),
      ),
      el("p", "", session.coach.name),
      el(
        "p",
        "",
        session.service.durationMin + " min · " + session.location.name,
      ),
    );
    panel.append(content);
    return panel;
  }
  function frame(title) {
    host.replaceChildren(
      button("Back to schedule", "skyra-booking__back", exit),
    );
    const layout = el("div", "skyra-booking__transaction-grid"),
      main = el("div");
    const heading = el("h3", "skyra-booking__step-title", title);
    heading.tabIndex = -1;
    main.append(heading);
    layout.append(main, aside());
    host.append(layout);
    heading.focus({ preventScroll: true });
    return main;
  }
  function errorView(error, retry) {
    const main = frame("Choose a Pass");
    window.SkyraBookingRecovery({
      host: main,
      error,
      retry,
      restart: () => {
        revision++;
        restart();
      },
      signIn,
    });
  }

  async function request(option) {
    const response = await fetch(
      (root.dataset.proxyBase || "/apps/skyra-booking") + "/pass-options",
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Skyra-Booking": "1",
        },
        body: JSON.stringify({
          token: attempt.token(),
          ...(option
            ? kind(option) === "OWNED_PASS" ? {purchaseKind:"OWNED_PASS", entitlementId:option.id} : kind(option) === "DROP_IN"
              ? { purchaseKind: "DROP_IN" }
              : { purchaseKind: "NEW_PASS", passPlanId: option.id }
            : {}),
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(
        data.error || "We could not load Passes. Please try again.",
      );
      error.code = data.code;
      error.status = response.status;
      error.bookingError = true;
      throw error;
    }
    if (!Array.isArray(data.passes))
      throw new Error("We could not load Passes. Please try again.");
    return data;
  }
  function choices() {
    const main = frame("Select a Pass");
    main.append(
      el(
        "p",
        "skyra-booking__notice",
        "Choose a single class or a Pass for this booking. Your place is not reserved yet.",
      ),
    );
    if (!options(payload).length) {
      main.append(
        el(
          "p",
          "skyra-booking__message",
          "No booking options are available for this class. Please contact Skyra Studio.",
        ),
      );
      return;
    }
    const group = el("fieldset", "skyra-booking__passes");
    group.append(
      el("legend", "skyra-booking__live", "Available booking options"),
    );
    options(payload).forEach((pass) => {
      const label = el("label", "skyra-booking__pass"),
        input = el("input");
      input.type = "radio";
      input.name = root.id + "-pass";
      input.value = key(pass);
      input.dataset.purchaseKind = kind(pass);
      input.checked = key(pass) === selectedId;
      const content = el("span", "skyra-booking__pass-copy"),
        top = el("span", "skyra-booking__pass-top");
      top.append(el("strong", "", pass.name), el("span", "", money(pass)));
      content.append(top, el("span", "skyra-booking__pass-meta", terms(pass)));
      label.append(input, content);
      group.append(label);
      input.addEventListener("change", () => {
        selectedId = key(pass);
        next.disabled = false;
      });
    });
    const next = button("Continue", "skyra-booking__primary", review);
    next.disabled = !selectedId;
    next.dataset.passContinue = "";
    main.append(group, next);
  }
  async function resultRequest(path, body = {}) {
    const response = await fetch((root.dataset.proxyBase || "/apps/skyra-booking") + path, {
      method:"POST", credentials:"same-origin", cache:"no-store", referrerPolicy:"no-referrer",
      headers:{"Content-Type":"application/json", Accept:"application/json", "X-Skyra-Booking":"1"},
      body:JSON.stringify({token:attempt.token(), ...body}), signal:AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || "We could not check your booking."); error.code=data.code; error.status=response.status; error.bookingError=true; throw error; }
    return data;
  }
  function resultView(data, retry) {
    const copy = {
      CONFIRMED:["Booking confirmed", "Your place is reserved. You can find the class details here."],
      PROCESSING:["Confirming your booking", "Your payment has been received. We are confirming your place. Check again shortly; please do not pay again."],
      AWAITING_PAYMENT:["Checking your payment", "We have not received a verified payment confirmation yet. If you have paid, check again shortly or contact Skyra Studio before making another payment."],
      NEEDS_ATTENTION:["We need to check your booking", "Your place is not confirmed. Please contact Skyra Studio so we can resolve your booking. Do not make another payment for this booking."],
      NOT_CONFIRMED:["Booking not confirmed", "No place has been reserved for this attempt. Check your Pass and try again."],
      CANCELLED:["Booking cancelled", "This booking is cancelled. Contact Skyra Studio if you need help."],
      ATTENDED:["Class attended", "Attendance has been recorded for this booking."],
      LATE_CANCEL:["Booking cancelled", "This booking was cancelled after the cancellation deadline."],
      NO_SHOW:["Class missed", "This booking is recorded as a missed class."],
    };
    const text = copy[data.status] || ["Check your booking", "We could not confirm your booking status. Check again or contact Skyra Studio before booking again."];
    const main=frame(text[0]);
    main.dataset.bookingResult=data.status || "UNKNOWN";
    main.append(el("p", "skyra-booking__notice", text[1]));
    if(data.bookingReference) main.append(el("p", "", "Booking reference: " + data.bookingReference));
    if (!["CONFIRMED","ATTENDED","CANCELLED","LATE_CANCEL","NO_SHOW"].includes(data.status))
      main.append(button("Check booking status", "skyra-booking__primary", ()=>checkResult(false, retry)));
    if(data.status === "NOT_CONFIRMED" && retry) main.append(button("Try this Pass again", "skyra-booking__primary", retry));
    if(data.status === "NOT_CONFIRMED") main.append(button("Choose another Pass", "skyra-booking__back", load));
    if(data.status === "NEEDS_ATTENTION") {
      const contact=el("a", "skyra-booking__back", "Contact Skyra Studio");
      contact.href="mailto:hello@skyrastudio.com.au"; main.append(contact);
    }
  }
  async function checkResult(allowSelection = false, retry) {
    const version=++revision;
    frame("Checking your booking").append(el("p", "skyra-booking__notice", "Checking the latest booking status…"));
    try {
      const data=await resultRequest("/result");
      if(version!==revision || !root.contains(host)) return;
      if(data.status==="NOT_CONFIRMED" && allowSelection) return load();
      resultView(data, retry);
    } catch(error) {
      if(version!==revision || !root.contains(host)) return;
      resultView({status:"UNKNOWN"}, retry);
      if(error.code==="LOGIN_REQUIRED") host.querySelector("[data-booking-result]").append(button("Sign in to check", "skyra-booking__primary", signIn));
    }
  }
  async function openCheckout(pass, idempotencyKey = crypto.randomUUID()) {
    const version=++revision;
    attempt.remember();
    frame("Opening Shopify Checkout").append(el("p", "skyra-booking__notice", "Creating a secure checkout and holding your place…"));
    try {
      await resultRequest("/comment", {comment});
      const purchaseKind=kind(pass);
      const data=await resultRequest("/checkout", {
        purchaseKind,
        idempotencyKey,
        ...(purchaseKind === "NEW_PASS" ? {passPlanId:pass.id} : {}),
      });
      if(version!==revision || !root.contains(host)) return;
      if(data.status === "NATIVE_CART_READY") {
        const checkoutAction = await prepareNativeBookingCart(data);
        if(version!==revision || !root.contains(host)) return;
        submitNativeCheckout(checkoutAction);
        return;
      }
      if(data.status !== "CHECKOUT_READY" || typeof data.checkoutUrl !== "string")
        throw new Error("Shopify Checkout is not ready. Please try again.");
      const checkoutUrl=new URL(data.checkoutUrl);
      if(checkoutUrl.protocol !== "https:" || checkoutUrl.username || checkoutUrl.password)
        throw new Error("Shopify returned an invalid Checkout URL.");
      window.location.assign(checkoutUrl.href);
    } catch(error) {
      if(version===revision && root.contains(host)) errorView(error, ()=>openCheckout(pass, idempotencyKey));
    }
  }
  async function confirm(pass) {
    const version=++revision;
    attempt.remember();
    frame("Confirming your booking").append(el("p", "skyra-booking__notice", "Reserving your place with one class credit…"));
    try {
      await resultRequest("/comment", {comment});
      const result=await resultRequest("/confirm", {entitlementId:pass.id});
      if(version===revision && root.contains(host)) resultView(result);
    } catch(error) {
      if(version!==revision || !root.contains(host)) return;
      // A lost response may follow a committed booking. Query before offering any retry.
      await checkResult(false, ()=>confirm(pass));
    }
  }
  async function load() {
    const version = ++revision;
    frame("Select a Pass").append(
      el("p", "skyra-booking__notice", "Loading available Passes…"),
    );
    try {
      const data = await request();
      if (version !== revision || !root.contains(host)) return;
      payload = data;
      if(!commentLoaded){comment = data.customerComment ?? comment;commentLoaded=true;}
      if (!options(data).some((p) => key(p) === selectedId)) selectedId = null;
      choices();
    } catch (error) {
      if (version === revision && root.contains(host)) errorView(error, load);
    }
  }
  async function review() {
    if (!selectedId) return;
    const version = ++revision;
    const next = host.querySelector("[data-pass-continue]");
    if (next) {
      next.disabled = true;
      next.textContent = "Checking availability…";
    }
    try {
      const option = options(payload).find((p) => key(p) === selectedId);
      if (!option) return load();
      const data = await request(option);
      if (version !== revision || !root.contains(host)) return;
      payload = data;
      const pass = data.selected;
      if (!pass || key(pass) !== selectedId)
        throw new Error(
          "This booking option has changed. Please choose again.",
        );
      const main = frame("Review your booking");
      const summary = el("div", "skyra-booking__review");
      summary.append(
        el("h4", "", "Summary"),
        el("p", "", session.service.name),
        el(
          "p",
          "",
          (kind(pass) === "OWNED_PASS" ? "Your Pass: " : kind(pass) === "DROP_IN" ? "Single class: " : "New Pass: ") +
            pass.name,
        ),
        el("p", "skyra-booking__pass-meta", terms(pass)),
      );
      const total = el("div", "skyra-booking__review-total");
      total.append(
        el(
          "strong",
          "",
          kind(pass) === "OWNED_PASS" ? "Booking uses" : kind(pass) === "DROP_IN" ? "Class price" : "Pass price",
        ),
        el("strong", "", money(pass)),
      );
      summary.append(total);
      const noteLabel=el("label","skyra-booking__note","Note for your coach (optional)");
      const note=el("textarea");note.maxLength=1000;note.rows=3;note.value=comment;note.placeholder="For this session, I would like to work on…";note.addEventListener("input",()=>{comment=note.value;});noteLabel.append(note);
      const noteStatus=el("p","skyra-booking__notice");noteStatus.setAttribute("role","status");
      const saveNote=button("Save note","skyra-booking__back",async()=>{saveNote.disabled=true;try{await resultRequest("/comment",{comment});attempt.customerComment=comment;noteStatus.textContent="Note saved for this booking.";}catch(error){noteStatus.textContent=error.message||"Your note could not be saved. Try again before continuing.";}finally{saveNote.disabled=false;}});
      summary.append(noteLabel,saveNote,noteStatus);
      main.append(
        summary,
        button(
          kind(pass) === "DROP_IN" ? "Edit selection" : "Edit Pass",
          "skyra-booking__back",
          choices,
        ),
        el(
          "p",
          "skyra-booking__notice",
          kind(pass) === "OWNED_PASS"
            ? (data.ownedPassesAvailable ? "Confirm to reserve your place using one credit from your Pass." : "Booking with an existing Pass is not available yet. Your credits have not changed.")
            : (data.checkoutAvailable ? "Shopify Checkout will open securely. Your booking is confirmed only after Shopify reports a verified payment." : "Online checkout is not available yet. Your place has not been reserved and no payment has been taken."),
        ),
      );
      const ownedPass=kind(pass) === "OWNED_PASS";
      const checkout = button(
        ownedPass ? "Confirm booking" : "Continue to Shopify Checkout",
        "skyra-booking__primary",
        () => {
          if(ownedPass && data.ownedPassesAvailable) confirm(pass);
          if(!ownedPass && data.checkoutAvailable) openCheckout(pass);
        },
      );
      checkout.disabled = ownedPass ? !data.ownedPassesAvailable : !data.checkoutAvailable;
      main.append(checkout);
    } catch (error) {
      if (version === revision && root.contains(host)) errorView(error, load);
    }
  }
  checkResult(true);
};
document.dispatchEvent(new Event("skyra:features-ready"));
