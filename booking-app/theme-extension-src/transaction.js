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
  const money = (pass) =>
    new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: pass.currency,
    }).format(pass.priceCents / 100);
  const kind = (option) => option.kind || "NEW_PASS";
  const key = (option) => kind(option) + ":" + option.id;
  const options = (data) => [
    ...(data.dropIn ? [data.dropIn] : []),
    ...data.passes,
  ];
  const terms = (option) =>
    kind(option) === "DROP_IN"
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
            ? kind(option) === "DROP_IN"
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
  async function load() {
    const version = ++revision;
    frame("Select a Pass").append(
      el("p", "skyra-booking__notice", "Loading available Passes…"),
    );
    try {
      const data = await request();
      if (version !== revision || !root.contains(host)) return;
      payload = data;
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
          (kind(pass) === "DROP_IN" ? "Single class: " : "New Pass: ") +
            pass.name,
        ),
        el("p", "skyra-booking__pass-meta", terms(pass)),
      );
      const total = el("div", "skyra-booking__review-total");
      total.append(
        el(
          "strong",
          "",
          kind(pass) === "DROP_IN" ? "Class price" : "Pass price",
        ),
        el("strong", "", money(pass)),
      );
      summary.append(total);
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
          "Online checkout is not available yet. Your place has not been reserved and no payment has been taken.",
        ),
      );
      const checkout = button(
        "Continue to Shopify Checkout",
        "skyra-booking__primary",
        () => {},
      );
      checkout.disabled = true;
      main.append(checkout);
    } catch (error) {
      if (version === revision && root.contains(host)) errorView(error, load);
    }
  }
  load();
};
document.dispatchEvent(new Event("skyra:features-ready"));
