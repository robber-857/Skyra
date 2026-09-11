(() => {
  const fallbackCopy = {
    title: "Find a Class",
    subtitle: "Choose a date, then explore live classes from the Skyra schedule.",
    account: "My account",
    classType: "Class type",
    allClasses: "All classes",
    instructor: "Instructor",
    allInstructors: "All instructors",
    loading: "Loading live classes",
    empty: "No published classes are available for this date.",
    error: "We could not load the schedule right now.",
    retry: "Try again",
    spots: "spots left",
    spot: "spot left",
    full: "Full",
    details: "View details",
    back: "Back to schedule",
    continue: "Continue to booking",
    book: "Book",
    passTitle: "Select a Pass",
    passUnavailable: "Pass selection is not available yet. Please contact Skyra Studio to book.",
    studioTimezone: "Times are shown in the studio timezone."
  };

  function readCopy() {
    const source = document.querySelector("[data-skyra-booking-config]");
    if (!source) return fallbackCopy;
    try {
      return Object.assign({}, fallbackCopy, JSON.parse(source.textContent || "{}").copy);
    } catch {
      return fallbackCopy;
    }
  }

  const copy = readCopy();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function dateKey(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return values.year + "-" + values.month + "-" + values.day;
  }

  function addDays(key, amount) {
    const parts = key.split("-").map(Number);
    const next = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + amount));
    return next.toISOString().slice(0, 10);
  }

  function dateFromKey(key) {
    return new Date(key + "T12:00:00Z");
  }

  function formatDate(key, timeZone, options) {
    return new Intl.DateTimeFormat("en-AU", Object.assign({ timeZone: timeZone }, options)).format(dateFromKey(key));
  }

  function formatTime(value, timeZone) {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: timeZone,
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(value));
  }

  function mount(root) {
    if (root.dataset.skyraMounted || !window.SkyraBookingLogin || !window.SkyraBookingAttempt) return;
    root.dataset.skyraMounted = "true";
    root.classList.add("skyra-booking");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", copy.title);

    const state = {
      status: "loading",
      timezone: "Australia/Sydney",
      sessions: [],
      selectedDate: "",
      service: "all",
      coach: "all",
      view: "browse",
      selectedId: ""
    };
    const surface = root.dataset.surface || "programs";
    const storageKey = "skyra-booking:" + surface + ":selection";
    const attempt = window.SkyraBookingAttempt(root);
    let savedSelection;
    let restoredAttempt;
    function saveSelection(pending = false) {
      if (pending) attempt.remember();
      savedSelection = {
        id: state.selectedId, date: state.selectedDate, service: state.service,
        coach: state.coach, view: state.view, pending,
        path: window.location.pathname, expires: Date.now() + 30 * 60 * 1000
      };
      try { sessionStorage.setItem(storageKey, JSON.stringify(savedSelection)); } catch { /* In-memory selection still works. */ }
    }
    function clearSelection() {
      savedSelection = null;
      try { sessionStorage.removeItem(storageKey); } catch { /* Storage can be disabled. */ }
    }
    const login = window.SkyraBookingLogin(root, copy, {
      save: saveSelection,
      cancel: () => { attempt.forget(true); saveSelection(false); },
      check: () => attempt.check(),
      url: () => attempt.loginUrl(),
      proceed: () => {
        state.view = "pass";
        clearSelection();
        attempt.forget();
        render();
        const heading = root.querySelector(".skyra-booking__message h3");
        heading?.setAttribute("tabindex", "-1");
        heading?.focus();
      }
    });
    function book(session, trigger) {
      state.selectedId = session.id;
      attempt.select(session.id);
      login.show(session, trigger);
    }

    function appendShell(content, statusText) {
      root.replaceChildren();
      const header = element("div", "skyra-booking__header");
      const heading = element("div");
      heading.append(element("h2", "", copy.title), element("p", "", copy.subtitle));
      const account = element("a", "skyra-booking__account", copy.account);
      account.href = "/account";
      header.append(heading, account);
      root.append(header, content);
      const live = element("p", "skyra-booking__live", statusText || "");
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      root.append(live);
    }

    function visibleSessions() {
      return state.sessions.filter((session) => {
        const matchesDate = dateKey(new Date(session.startsAt), state.timezone) === state.selectedDate;
        const matchesService = state.service === "all" || session.service.id === state.service;
        const matchesCoach = state.coach === "all" || session.coach.id === state.coach;
        return matchesDate && matchesService && matchesCoach;
      });
    }

    function selectedSession() {
      return state.sessions.find((session) => session.id === state.selectedId);
    }

    function selectControl(labelText, allText, items, selectedValue, dataName) {
      const label = element("label");
      label.append(element("span", "", labelText));
      const select = element("select");
      select.dataset[dataName] = "";
      const allOption = element("option", "", allText);
      allOption.value = "all";
      select.append(allOption);
      const unique = [...new Map(items.map((item) => [item.id, item])).values()];
      unique.forEach((item) => {
        const option = element("option", "", item.name);
        option.value = item.id;
        select.append(option);
      });
      select.value = selectedValue;
      label.append(select);
      return label;
    }

    function renderLoading() {
      const loading = element("div", "skyra-booking__loading");
      loading.setAttribute("aria-hidden", "true");
      loading.append(element("span"), element("span"), element("span"));
      appendShell(loading, copy.loading);
    }

    function renderError() {
      const message = element("div", "skyra-booking__message");
      message.append(element("p", "", copy.error));
      const retry = element("button", "", copy.retry);
      retry.type = "button";
      retry.addEventListener("click", load);
      message.append(retry);
      appendShell(message);
    }

    function renderBrowse(focusName) {
      const today = dateKey(new Date(), state.timezone);
      const dates = Array.from({ length: 7 }, (_, index) => addDays(today, index));
      if (!state.selectedDate || !dates.includes(state.selectedDate)) state.selectedDate = dates[0];

      const content = element("div");
      const toolbar = element("div", "skyra-booking__toolbar");
      const serviceSelect = selectControl(
        copy.classType,
        copy.allClasses,
        state.sessions.map((session) => session.service),
        state.service,
        "bookingService"
      );
      const coachSelect = selectControl(
        copy.instructor,
        copy.allInstructors,
        state.sessions.map((session) => session.coach),
        state.coach,
        "bookingCoach"
      );
      toolbar.append(serviceSelect, coachSelect);

      const days = element("div", "skyra-booking__days");
      days.setAttribute("role", "group");
      days.setAttribute("aria-label", "Schedule dates");
      dates.forEach((key, index) => {
        const active = key === state.selectedDate;
        const button = element("button", "skyra-booking__day" + (active ? " is-active" : ""));
        button.type = "button";
        button.dataset.bookingDate = key;
        button.setAttribute("aria-pressed", String(active));
        button.append(
          element("span", "", index === 0 ? "Today" : formatDate(key, state.timezone, { weekday: "short" })),
          element("strong", "", formatDate(key, state.timezone, { day: "numeric" }))
        );
        button.addEventListener("click", () => {
          state.selectedDate = key;
          renderBrowse("date:" + key);
        });
        days.append(button);
      });

      const dateHeading = element("div", "skyra-booking__date-heading");
      dateHeading.append(
        element("strong", "", formatDate(state.selectedDate, state.timezone, {
          weekday: "long",
          day: "numeric",
          month: "long"
        })),
        element("span", "", copy.studioTimezone)
      );

      const list = element("div", "skyra-booking__sessions");
      const sessions = visibleSessions();
      if (!sessions.length) {
        const empty = element("div", "skyra-booking__message skyra-booking__message--empty");
        empty.append(element("p", "", copy.empty));
        list.append(empty);
      } else {
        sessions.forEach((session) => {
          const spots = Number(session.spotsRemaining);
          const closed = session.bookingStatus && session.bookingStatus !== "OPEN";
          const row = element("article", "skyra-booking__session");
          const time = element("time");
          time.dateTime = session.startsAt;
          time.append(
            element("strong", "", formatTime(session.startsAt, state.timezone)),
            element("span", "", session.service.durationMin + " min")
          );
          const sessionCopy = element("div", "skyra-booking__session-copy");
          sessionCopy.append(
            element("h3", "", session.service.name),
            element("p", "", session.coach.name + " · " + session.location.name)
          );
          const availability = element(
            "span",
            "skyra-booking__availability" + (spots <= 0 ? " is-full" : ""),
            spots <= 0 ? copy.full : spots + " " + (spots === 1 ? copy.spot : copy.spots)
          );
          const details = element("button", "", copy.details);
          details.type = "button";
          details.dataset.bookingDetails = session.id;
          details.addEventListener("click", () => {
            state.selectedId = session.id;
            state.view = "details";
            saveSelection();
            render();
            root.querySelector("[data-booking-back]")?.focus();
          });
          const bookButton = element("button", "skyra-booking__primary", closed ? "Booking closed" : spots <= 0 ? copy.full : copy.book);
          bookButton.type = "button";
          bookButton.dataset.bookingBook = session.id;
          bookButton.disabled = spots <= 0 || Boolean(closed);
          bookButton.addEventListener("click", () => book(session, bookButton));
          sessionCopy.append(details);
          row.append(time, sessionCopy, availability, bookButton);
          list.append(row);
        });
      }

      content.append(toolbar, days, dateHeading, list);
      appendShell(content);

      root.querySelector("[data-booking-service]")?.addEventListener("change", (event) => {
        state.service = event.currentTarget.value;
        renderBrowse("service");
      });
      root.querySelector("[data-booking-coach]")?.addEventListener("change", (event) => {
        state.coach = event.currentTarget.value;
        renderBrowse("coach");
      });
      if (focusName === "service") root.querySelector("[data-booking-service]")?.focus();
      if (focusName === "coach") root.querySelector("[data-booking-coach]")?.focus();
      if (focusName && focusName.startsWith("date:")) {
        const key = focusName.slice(5);
        [...root.querySelectorAll("[data-booking-date]")].find((button) => button.dataset.bookingDate === key)?.focus();
      }
    }

    function backButton(action) {
      const back = element("button", "skyra-booking__back", copy.back);
      back.type = "button";
      back.dataset.bookingBack = "";
      back.addEventListener("click", action);
      return back;
    }

    function renderDetails(session) {
      const content = element("div");
      content.append(backButton(() => {
        state.view = "browse";
        clearSelection();
        renderBrowse();
        [...root.querySelectorAll("[data-booking-details]")].find((button) => button.dataset.bookingDetails === state.selectedId)?.focus();
      }));

      const detail = element("div", "skyra-booking__detail");
      const introduction = element("div");
      introduction.append(
        element("p", "skyra-booking__detail-date", formatDate(dateKey(new Date(session.startsAt), state.timezone), state.timezone, {
          weekday: "long",
          day: "numeric",
          month: "long"
        })),
        element("h3", "", session.service.name),
        element("p", "", session.service.description || "")
      );
      const list = element("dl");
      [
        ["Time", formatTime(session.startsAt, state.timezone)],
        ["Coach", session.coach.name],
        ["Location", session.location.name],
        ["Duration", session.service.durationMin + " minutes"],
        ...(session.service.level ? [["Level", session.service.level]] : []),
        ["Availability", session.spotsRemaining + " " + (Number(session.spotsRemaining) === 1 ? copy.spot : copy.spots)]
      ].forEach((entry) => {
        const item = element("div");
        item.append(element("dt", "", entry[0]), element("dd", "", entry[1]));
        list.append(item);
      });
      const continueButton = element("button", "skyra-booking__primary", copy.continue);
      continueButton.type = "button";
      continueButton.dataset.bookingContinue = "";
      continueButton.disabled = Number(session.spotsRemaining) <= 0 || Boolean(session.bookingStatus && session.bookingStatus !== "OPEN");
      continueButton.addEventListener("click", () => book(session, continueButton));
      detail.append(introduction, list, continueButton);
      content.append(detail);
      appendShell(content);
    }

    function renderAction(session) {
      const content = element("div");
      content.append(backButton(() => {
        state.view = "details";
        render();
        root.querySelector("[data-booking-continue]")?.focus();
      }));
      const message = element("div", "skyra-booking__message skyra-booking__message--action");
      message.append(
        element("p", "skyra-booking__eyebrow", session.service.name),
        element("h3", "", copy.passTitle),
        element("p", "", copy.passUnavailable)
      );
      content.append(message);
      appendShell(content);
    }

    function render() {
      if (state.status === "loading") return renderLoading();
      if (state.status === "error") return renderError();
      const session = selectedSession();
      if (!session || state.view === "browse") return renderBrowse();
      if (state.view === "details") return renderDetails(session);
      renderAction(session);
    }

    async function load() {
      restoredAttempt = null;
      state.status = "loading";
      render();
      try {
        const response = await fetch((root.dataset.proxyBase || "/apps/skyra-booking") + "/sessions", {
          headers: { Accept: "application/json" },
          credentials: "same-origin"
        });
        if (!response.ok) throw new Error("Schedule request failed.");
        const payload = await response.json();
        state.timezone = payload.timezone || state.timezone;
        state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        state.selectedDate = dateKey(new Date(), state.timezone);
        try {
          savedSelection = JSON.parse(sessionStorage.getItem(storageKey) || "null");
        } catch { clearSelection(); }
        if (savedSelection && savedSelection.expires > Date.now() && typeof savedSelection.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(savedSelection.date) && savedSelection.path === window.location.pathname &&
            state.sessions.some((session) => session.id === savedSelection.id)) {
          state.selectedId = savedSelection.id;
          state.selectedDate = savedSelection.date;
          state.service = savedSelection.service || "all";
          state.coach = savedSelection.coach || "all";
          state.view = savedSelection.view === "details" ? "details" : "browse";
        } else {
          clearSelection();
        }
        restoredAttempt = await attempt.restore();
        if (restoredAttempt) {
          const restored = restoredAttempt.session;
          state.sessions = state.sessions.filter(session => session.id !== restored.id).concat(restored);
          state.selectedId = restored.id;
          state.selectedDate = dateKey(new Date(restored.startsAt), restored.timezone);
          state.view = "details";
        }
        state.status = "ready";
      } catch {
        state.status = "error";
      }
      render();
      if (state.status === "ready" && restoredAttempt) {
        // Storage is a UI hint, never proof of identity or a reservation.
        if (window.name === "skyra-booking-login" && window.opener) {
          try {
            if (await login.authenticated()) {
              window.opener.focus();
              window.close();
              return;
            }
          } catch { /* Fall back to the gate when the opener cannot be used. */ }
        }
        root.scrollIntoView({ block: "center" });
        login.show(selectedSession(), root.querySelector("[data-booking-continue]"));
      }
    }

    render();
    load();
  }

  function boot(scope) {
    (scope || document).querySelectorAll("[data-skyra-booking-root]").forEach(mount);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => boot(document), { once: true });
  } else {
    boot(document);
  }
  document.addEventListener("skyra:attempt-ready", () => boot(document));
  document.addEventListener("skyra:login-ready", () => boot(document));
  document.addEventListener("shopify:section:load", (event) => boot(event.target));
})();