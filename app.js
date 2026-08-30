document.documentElement.classList.add("js");

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const staticMode = new URLSearchParams(window.location.search).has("static");
const body = document.body;
const menuToggle = document.querySelector(".menu-toggle");
const menuLabel = document.querySelector(".menu-toggle__label");
const primaryNav = document.querySelector(".primary-nav");
const heroImage = document.querySelector(".hero-media__image");
const mainContent = document.querySelector("main");
const siteFooter = document.querySelector("footer");

function applyMotionPreference() {
  body.classList.toggle("motion-enabled", !prefersReducedMotion.matches && !staticMode);
}

applyMotionPreference();
prefersReducedMotion.addEventListener?.("change", applyMotionPreference);

heroImage?.addEventListener("animationend", (event) => {
  if (event.animationName === "studio-zoom-out") body.classList.add("hero-motion-complete");
});

function closedMenuLabel() {
  return window.innerWidth <= 1024 ? "Menu" : "More";
}

if (menuLabel) menuLabel.textContent = closedMenuLabel();

function setMenu(open) {
  if (!menuToggle || !primaryNav) return;
  menuToggle.setAttribute("aria-expanded", String(open));
  if (menuLabel) menuLabel.textContent = open ? "Close" : closedMenuLabel();
  primaryNav.classList.toggle("is-open", open);
  primaryNav.setAttribute("aria-hidden", String(!open));
  primaryNav.inert = !open;
  body.classList.toggle("is-menu-open", open);

  [mainContent, siteFooter].forEach((region) => {
    if (!region) return;
    region.inert = open;
    region.setAttribute("aria-hidden", String(open));
  });

  if (open) {
    requestAnimationFrame(() => primaryNav.querySelector("a")?.focus());
  } else if (primaryNav.contains(document.activeElement)) {
    menuToggle.focus();
  }
}

menuToggle?.addEventListener("click", () => {
  setMenu(menuToggle.getAttribute("aria-expanded") !== "true");
});

primaryNav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setMenu(false));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMenu(false);

  if (event.key !== "Tab" || !primaryNav?.classList.contains("is-open")) return;

  const menuFocusables = [menuToggle, ...primaryNav.querySelectorAll("a")];
  const firstFocusable = menuFocusables[0];
  const lastFocusable = menuFocusables.at(-1);

  if (event.shiftKey && document.activeElement === firstFocusable) {
    event.preventDefault();
    lastFocusable.focus();
  } else if (!event.shiftKey && document.activeElement === lastFocusable) {
    event.preventDefault();
    firstFocusable.focus();
  }
});

window.addEventListener("resize", () => {
  if (menuLabel && menuToggle?.getAttribute("aria-expanded") !== "true") {
    menuLabel.textContent = closedMenuLabel();
  }
});

const heroSection = document.querySelector(".hero");

document.addEventListener("visibilitychange", () => {
  body.classList.toggle("motion-page-hidden", document.hidden);
});

if (heroSection && "IntersectionObserver" in window) {
  const heroMotionObserver = new IntersectionObserver(
    ([entry]) => body.classList.toggle("hero-offscreen", !entry.isIntersecting),
    { threshold: 0.04 },
  );
  heroMotionObserver.observe(heroSection);
}

const revealItems = [...document.querySelectorAll(".reveal")];

if (prefersReducedMotion.matches || staticMode || !("IntersectionObserver" in window)) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.16 },
  );

  revealItems.forEach((item) => revealObserver.observe(item));
}

const gallery = document.querySelector("[data-gallery]");
const galleryCards = [...document.querySelectorAll("[data-gallery-card]")];

let galleryPosition = 0;
let galleryDragStart = 0;
let galleryStartPosition = 0;
let galleryDragging = false;
let galleryAutoplay = 0;

function wrapGalleryIndex(index) {
  const length = galleryCards.length;
  return ((index % length) + length) % length;
}

function signedGalleryDistance(index, active) {
  const length = galleryCards.length;
  let distance = index - active;
  if (distance > length / 2) distance -= length;
  if (distance < -length / 2) distance += length;
  return distance;
}

function renderGallery() {
  if (!gallery || !galleryCards.length) return;
  const active = wrapGalleryIndex(galleryPosition);
  const cardGap = Math.min(window.innerWidth < 768 ? 158 : 220, gallery.clientWidth * 0.27);

  galleryCards.forEach((card, index) => {
    const distance = signedGalleryDistance(index, active);
    const x = distance * cardGap;
    const y = Math.abs(distance) * 28 + distance * distance * 8;
    const rotate = distance * -8;
    const scale = Math.max(0.72, 1 - Math.abs(distance) * 0.09);
    const opacity = Math.max(0.22, 1 - Math.abs(distance) * 0.2);

    card.style.transform = `translate3d(calc(-50% + ${x}px), calc(-50% + ${y}px), ${-Math.abs(distance) * 55}px) rotateY(${rotate}deg) rotateZ(${distance * 1.4}deg) scale(${scale})`;
    card.style.opacity = String(opacity);
    card.style.filter = `saturate(${Math.max(0.7, 1 - Math.abs(distance) * 0.08)})`;
    card.style.zIndex = String(20 - Math.abs(distance));
    card.setAttribute("aria-hidden", String(Math.abs(distance) > 2));
  });
}

function moveGallery(delta) {
  galleryPosition = wrapGalleryIndex(Math.round(galleryPosition + delta));
  renderGallery();
  restartGalleryAutoplay();
}

function stopGalleryAutoplay() {
  window.clearInterval(galleryAutoplay);
}

function restartGalleryAutoplay() {
  stopGalleryAutoplay();
  if (prefersReducedMotion.matches || staticMode) return;
  galleryAutoplay = window.setInterval(() => moveGallery(1), 2500);
}

gallery?.addEventListener("pointerdown", (event) => {
  galleryDragging = true;
  galleryDragStart = event.clientX;
  galleryStartPosition = galleryPosition;
  gallery.classList.add("is-dragging");
  gallery.setPointerCapture(event.pointerId);
  stopGalleryAutoplay();
});

gallery?.addEventListener("pointermove", (event) => {
  if (!galleryDragging) return;
  const dragDistance = galleryDragStart - event.clientX;
  galleryPosition = galleryStartPosition + dragDistance / 150;
  renderGallery();
});

function endGalleryDrag(event) {
  if (!galleryDragging || !gallery) return;
  galleryDragging = false;
  gallery.releasePointerCapture?.(event.pointerId);
  gallery.classList.remove("is-dragging");
  galleryPosition = wrapGalleryIndex(Math.round(galleryPosition));
  renderGallery();
  restartGalleryAutoplay();
}

gallery?.addEventListener("pointerup", endGalleryDrag);
gallery?.addEventListener("pointercancel", endGalleryDrag);
gallery?.addEventListener("focusin", stopGalleryAutoplay);
gallery?.addEventListener("focusout", restartGalleryAutoplay);
gallery?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") {
    event.preventDefault();
    moveGallery(1);
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveGallery(-1);
  }
});

renderGallery();
restartGalleryAutoplay();
window.addEventListener("resize", renderGallery);
window.addEventListener("pagehide", stopGalleryAutoplay, { once: true });

const filterButtons = [...document.querySelectorAll("[data-filter]")];
const sessionRows = [...document.querySelectorAll(".session-row")];
const scheduleEmpty = document.querySelector("[data-schedule-empty]");
const resetFilter = document.querySelector("[data-reset-filter]");

function applySessionFilter(filter) {
  let visibleCount = 0;

  filterButtons.forEach((button) => {
    const active = button.dataset.filter === filter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  sessionRows.forEach((row) => {
    const visible = filter === "all" || row.dataset.time === filter;
    row.hidden = !visible;
    if (visible) visibleCount += 1;
  });

  if (scheduleEmpty) scheduleEmpty.hidden = visibleCount > 0;
}

filterButtons.forEach((button) => {
  button.addEventListener("click", () => applySessionFilter(button.dataset.filter || "all"));
});

resetFilter?.addEventListener("click", () => applySessionFilter("all"));

const bookingPreview = document.querySelector("[data-booking-preview]");
const bookingName = document.querySelector("[data-booking-name]");

document.querySelectorAll("[data-session]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!bookingPreview || !bookingName) return;
    bookingName.textContent = button.dataset.session || "Session";
    bookingPreview.hidden = false;
    bookingPreview.focus();
  });
});

document.querySelector("[data-close-preview]")?.addEventListener("click", () => {
  if (bookingPreview) bookingPreview.hidden = true;
});
const communityForm = document.querySelector("[data-community-form]");
const communityEmail = document.querySelector("[data-community-email]");
const communityStatus = document.querySelector("[data-community-status]");

function setCommunityStatus(message, success = false) {
  if (!communityStatus) return;
  communityStatus.textContent = message;
  communityStatus.hidden = false;
  communityStatus.classList.toggle("is-success", success);
}

communityForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!communityEmail) return;

  const email = communityEmail.value.trim();
  communityEmail.value = email;

  if (!email || !communityEmail.checkValidity()) {
    communityEmail.setAttribute("aria-invalid", "true");
    communityEmail.classList.add("is-invalid");
    setCommunityStatus(
      email
        ? "Enter a complete email address, such as name@example.com."
        : "Enter your email address to continue.",
    );
    communityEmail.focus();
    return;
  }

  communityEmail.removeAttribute("aria-invalid");
  communityEmail.classList.remove("is-invalid");
  setCommunityStatus("Signup preview complete — no email has been stored yet.", true);
  communityForm.reset();
});

communityEmail?.addEventListener("input", () => {
  communityEmail.removeAttribute("aria-invalid");
  communityEmail.classList.remove("is-invalid");
  if (communityStatus) communityStatus.hidden = true;
});
