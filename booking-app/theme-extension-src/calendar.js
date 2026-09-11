window.SkyraBookingDateKey = function (date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return values.year + "-" + values.month + "-" + values.day;
};
window.SkyraBookingSelectControl = function (
  element,
  labelText,
  allText,
  items,
  selectedValue,
  dataName,
) {
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
};
window.SkyraBookingCalendar = function ({ today, selected, end, pick }) {
  const panel = document.createElement("details");
  panel.className = "skyra-booking__calendar";
  const summary = document.createElement("summary");
  summary.textContent = "Full calendar";
  panel.append(summary);
  const body = document.createElement("div");
  body.className = "skyra-booking__calendar-body";
  panel.append(body);
  let month = selected.slice(0, 7);
  function render() {
    body.replaceChildren();
    const header = document.createElement("div");
    header.className = "skyra-booking__calendar-nav";
    const title = document.createElement("strong");
    title.textContent = new Intl.DateTimeFormat("en-AU", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(month + "-01T12:00:00Z"));
    function nav(amount, label) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      const d = new Date(month + "-01T12:00:00Z");
      d.setUTCMonth(d.getUTCMonth() + amount);
      const next = d.toISOString().slice(0, 7);
      button.disabled = next < today.slice(0, 7) || next > end.slice(0, 7);
      button.addEventListener("click", () => {
        month = next;
        render();
        body.querySelector("strong").tabIndex = -1;
        body.querySelector("strong").focus();
      });
      return button;
    }
    header.append(nav(-1, "Previous month"), title, nav(1, "Next month"));
    body.append(header);
    const grid = document.createElement("div");
    grid.className = "skyra-booking__calendar-grid";
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((day) => {
      const label = document.createElement("span");
      label.textContent = day;
      grid.append(label);
    });
    const first = new Date(month + "-01T12:00:00Z"),
      offset = (first.getUTCDay() + 6) % 7;
    for (let i = 0; i < offset; i++)
      grid.append(document.createElement("span"));
    const last = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    for (let day = 1; day <= last; day++) {
      const key = month + "-" + String(day).padStart(2, "0"),
        button = document.createElement("button");
      button.type = "button";
      button.textContent = String(day);
      button.dataset.calendarDate = key;
      button.disabled = key < today || key > end;
      button.setAttribute(
        "aria-label",
        new Intl.DateTimeFormat("en-AU", {
          dateStyle: "full",
          timeZone: "UTC",
        }).format(new Date(key + "T12:00:00Z")),
      );
      button.setAttribute("aria-pressed", String(key === selected));
      button.addEventListener("click", () => pick(key));
      grid.append(button);
    }
    body.append(grid);
    const note = document.createElement("p");
    note.textContent =
      "Browse the next 31 days. Bookings open 14 days before class.";
    body.append(note);
  }
  render();
  return panel;
};
document.dispatchEvent(new Event("skyra:features-ready"));

window.SkyraBookingDateRail = function ({today, selected, end, pick, element}) {
  const add = (key, days) => new Date(new Date(key + "T12:00:00Z").getTime() + days * 86400000).toISOString().slice(0, 10);
  const offset = Math.floor((new Date(selected) - new Date(today)) / 86400000 / 7) * 7;
  const start = add(today, offset);
  const last = [add(start, 6), end].sort()[0];
  const dates = Array.from({length: Math.min(7, 31 - offset)}, (_, i) => add(start, i));
  const format = (key, options) => new Intl.DateTimeFormat("en-AU", {timeZone:"UTC", ...options}).format(new Date(key + "T12:00:00Z"));
  const rail = element("div"), nav = element("div", "skyra-booking__week-nav");
  const label = element("strong", "", format(start, {month:"long",year:"numeric"}) + (start.slice(0,7) === last.slice(0,7) ? "" : " – " + format(last, {month:"long",year:"numeric"})));
  label.setAttribute("aria-live", "polite");
  function arrow(amount, text, symbol) {
    const button = element("button", "", symbol);
    button.type = "button";
    button.setAttribute("aria-label", text);
    button.disabled = amount < 0 ? offset === 0 : add(start, 7) > end;
    button.addEventListener("click", () => pick(add(start, amount)));
    return button;
  }
  nav.append(arrow(-7, "Previous 7 days", "‹"), label, arrow(7, "Next 7 days", "›"));
  const days = element("div", "skyra-booking__days");
  days.setAttribute("role", "group");
  days.setAttribute("aria-label", "Schedule dates");
  dates.forEach(key => {
    const button = element("button", "skyra-booking__day" + (key === selected ? " is-active" : ""));
    button.type = "button";
    button.dataset.bookingDate = key;
    button.setAttribute("aria-pressed", String(key === selected));
    button.setAttribute("aria-label", format(key, {dateStyle:"full"}));
    button.append(element("span", "", key === today ? "Today" : format(key, {weekday:"short"})), element("strong", "", format(key, {day:"numeric"})));
    button.addEventListener("click", () => pick(key));
    days.append(button);
  });
  rail.append(nav, days);
  return rail;
};
