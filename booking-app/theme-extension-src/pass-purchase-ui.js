export const renewalTermsVersion = "2026-10-02.v1";

export function passValidity(pass) {
  const count = pass.validityMonths ?? pass.validityDays;
  const unit = pass.validityMonths ? "calendar month" : "day";
  return `${pass.credits} classes · Valid for ${count} ${unit}${count === 1 ? "" : "s"} from first class`;
}

export function renewalDescription(pass, price) {
  const count = pass.validityMonths ?? 1;
  return `${price} per pass, with the first payment today. Each pass starts on its first attended class and lasts ${count} calendar month${count === 1 ? "" : "s"}. At expiry, one renewal payment buys your next pass. No further renewal payment is taken while that pass awaits its first class. Cancel future renewals at any time.`;
}

export function renewalChoice({ pass, value = false, name, className, onChange }) {
  if (!pass.autoRenew) return null;
  const group = document.createElement("fieldset");
  group.className = className;
  const legend = document.createElement("legend");
  legend.textContent = "How would you like to buy this pass?";
  group.append(legend);
  for (const [autoRenew, text] of [[false, "One-time purchase"], [true, "Automatically renew when this pass expires"]]) {
    if (!autoRenew && pass.oneTimePurchaseEnabled === false) continue;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = autoRenew ? "auto-renew" : "one-time";
    input.checked = value === autoRenew;
    input.disabled = autoRenew && !pass.autoRenew.available;
    input.addEventListener("change", () => onChange(autoRenew));
    label.append(input, document.createTextNode(text));
    group.append(label);
  }
  if (!pass.autoRenew.available) {
    const message = document.createElement("p");
    message.textContent = pass.autoRenew.reason || "Automatic renewal is not available for this pass yet.";
    group.append(message);
  }
  return group;
}
