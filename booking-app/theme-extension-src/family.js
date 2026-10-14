const selectionKey = "skyra-family:member";
const memberId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : "";

export function rememberedFamilyMember() {
  const requested = memberId(new URL(window.location.href).searchParams.get("skyra_member"));
  if (requested) return requested;
  try { return memberId(sessionStorage.getItem(selectionKey)); } catch { return ""; }
}

export function rememberFamilyMember(id) {
  try { if (id) sessionStorage.setItem(selectionKey, id); else sessionStorage.removeItem(selectionKey); } catch { /* Selection is also attached to every authenticated request. */ }
}

export function familyController(root, initial = rememberedFamilyMember()) {
  let selected = memberId(initial), data;
  return {
    id: () => selected,
    data: () => data,
    member: () => data?.members.find((item) => item.id === selected) || data?.members.find((item) => item.relationship === "SELF"),
    restore(id) { selected = memberId(id); rememberFamilyMember(selected); },
    select(id) {
      const member = data?.members.find((item) => item.id === id);
      if (!member) throw new Error("Choose a member of your family account.");
      selected = member.relationship === "CHILD" ? member.id : "";
      rememberFamilyMember(selected);
    },
    async load(lockedId) {
      const response = await fetch((root.dataset.proxyBase || "/apps/skyra-booking") + "/family", {
        method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Skyra-Booking": "1" },
        body: "{}", signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error || "We could not load your family account."); error.code = result.code; error.status = response.status; error.bookingError = true; throw error; }
      if (!result.account?.id || !Array.isArray(result.members) || !result.members.some((item) => item.relationship === "SELF")) throw new Error("Your family account could not be verified. Please try again.");
      data = result;
      if (lockedId !== undefined) selected = memberId(lockedId);
      if (selected === data.account.id) selected = "";
      if (selected && !data.members.some((item) => item.id === selected && item.relationship === "CHILD")) {
        if (lockedId) throw new Error("This purchase belongs to a family member who is no longer available. Please contact Skyra Studio.");
        selected = "";
      }
      rememberFamilyMember(selected);
      return result;
    },
    control({ element, className, onChange, disabled = false, label = "Booking for" }) {
      if (!data) return null;
      const wrapper = element("label", className);
      wrapper.style.display = "grid";
      wrapper.style.gap = "8px";
      wrapper.append(element("span", "", label));
      const select = element("select");
      select.dataset.familyMember = "";
      select.setAttribute("aria-label", label);
      select.disabled = disabled;
      select.style.minWidth = "0";
      select.style.maxWidth = "100%";
      select.style.minHeight = "44px";
      select.style.font = "inherit";
      data.members.forEach((member) => { const option = element("option", "", (member.name || member.email) + (member.relationship === "SELF" ? " (you)" : "")); option.value = member.id; option.selected = member.id === (selected || data.account.id); select.append(option); });
      select.addEventListener("change", () => onChange(select.value));
      wrapper.append(select);
      return wrapper;
    },
  };
}
