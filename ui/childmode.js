// Child Mode for KaChat desktop — port of iOS ChildModeService +
// ChildModeSettingsView + the WelcomeGuide "Who will use KaChat?" step.
//
// While Child Mode is ON the app is strictly Chats, Group Chats, Portfolio,
// Cold Storage and Profile/Settings: Swaps, KaPosts and Broadcasts are removed
// everywhere. The actual gating lives at app.js's single choke point
// (setActiveAppTab + dockVisibleTabs) using `isChildModeEnabled()` and
// `CHILD_HIDDEN_TABS` from here — derived at render time, never written into
// the per-account dock prefs (the iOS lesson: persisting while ON permanently
// baked tabs hidden).
//
// Storage design (GLOBAL localStorage keys, deliberately NOT account-scoped:
// child mode governs the whole app, consistent with desktop's trust model
// where the wallet itself lives in localStorage):
// - kachat-child-mode-record-v1   JSON { salt, hash } (hex) — a random 16-byte
//   salt plus SHA-256(salt || UTF-8 password). The password itself is NEVER
//   stored, mirroring the iOS Keychain record.
// - kachat-child-mode-enabled-v1  "1"/"0" — the fast flag every gate reads.
//   Turning OFF only ever happens after `verifyChildModePassword` succeeds.
// - kachat-user-type-choice-v1    "pending"/"chosen" — the onboarding
//   Adult/Child question. "pending" makes the setup guide unskippable and
//   re-presents the choice after a reload mid-setup; existing installs (no
//   marker) are never forced through it.
//
// Deliberately NO biometrics concepts (nothing to bypass on desktop anyway):
// only the password turns Child Mode off.

const RECORD_KEY = "kachat-child-mode-record-v1";
const ENABLED_KEY = "kachat-child-mode-enabled-v1";
const USER_TYPE_KEY = "kachat-user-type-choice-v1";

/** Tabs removed everywhere while Child Mode is on (dock, programmatic switches,
 * the Customize Dock page). */
export const CHILD_HIDDEN_TABS = ["swaps", "kaposts", "broadcasts"];

let deps = {
  escapeHtml: (value) => String(value ?? ""),
  showToast: null,
  onChildModeChanged: null,
};

// ---------------------------------------------------------------------------
// Password record: salted SHA-256, constant-time-ish verify
// ---------------------------------------------------------------------------

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const clean = String(hex || "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

async function hashPassword(password, saltBytes) {
  const pw = new TextEncoder().encode(String(password));
  const input = new Uint8Array(saltBytes.length + pw.length);
  input.set(saltBytes, 0);
  input.set(pw, saltBytes.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

function loadRecord() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECORD_KEY) || "null");
    if (parsed && typeof parsed.salt === "string" && typeof parsed.hash === "string") return parsed;
  } catch { /* corrupted record = no record */ }
  return null;
}

/** A password has been set at some point — drives set-up vs. manage UI. */
export function hasChildModePassword() {
  return Boolean(loadRecord());
}

/** The fast flag every gate reads (dock, tab switches, dock customization). */
export function isChildModeEnabled() {
  return localStorage.getItem(ENABLED_KEY) === "1";
}

function setChildModeEnabled(value) {
  localStorage.setItem(ENABLED_KEY, value ? "1" : "0");
  try { deps.onChildModeChanged?.(Boolean(value)); } catch { /* gate re-render is best-effort */ }
}

/** Hashes and stores `password` (free-form; refuses only the empty case). */
export async function setChildModePassword(password) {
  const value = String(password || "");
  if (!value) throw new Error("Child Mode password cannot be empty");
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await hashPassword(value, salt);
  localStorage.setItem(RECORD_KEY, JSON.stringify({ salt: bytesToHex(salt), hash: bytesToHex(hash) }));
}

/** Constant-time-ish check against the stored record; false when none exists. */
export async function verifyChildModePassword(password) {
  const record = loadRecord();
  if (!record) return false;
  const candidate = bytesToHex(await hashPassword(String(password || ""), hexToBytes(record.salt)));
  const expected = String(record.hash);
  if (candidate.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < candidate.length; i++) difference |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

/** Traditional change flow: wrong current password = false, nothing changes. */
export async function changeChildModePassword(current, next) {
  if (!(await verifyChildModePassword(current))) return false;
  await setChildModePassword(next);
  return true;
}

/** Full reset to never-configured: verify, delete the record AND turn the flag
 * off through the standard path (so the dock gate reacts like a normal OFF). */
export async function clearChildModeConfiguration(password) {
  if (!(await verifyChildModePassword(password))) return false;
  localStorage.removeItem(RECORD_KEY);
  setChildModeEnabled(false);
  return true;
}

// ---------------------------------------------------------------------------
// Onboarding Adult/Child marker
// ---------------------------------------------------------------------------

/** The Adult/Child choice is still owed: the setup guide must be unskippable. */
export function isUserTypePending() {
  return localStorage.getItem(USER_TYPE_KEY) === "pending";
}

/** Called at the start of the first-run experience (account creation opens the
 * guide). No-ops once chosen, so existing users are never re-asked by force. */
export function markUserTypePending() {
  if (localStorage.getItem(USER_TYPE_KEY) === "chosen") return;
  localStorage.setItem(USER_TYPE_KEY, "pending");
}

export function markUserTypeChosen() {
  localStorage.setItem(USER_TYPE_KEY, "chosen");
}

// ---------------------------------------------------------------------------
// Onboarding-run pending marker (extends the Adult/Child machinery above):
// EVERY account-onboarding run — create or import — is fully unskippable end
// to end, and an interrupted run (reload/kill mid-guide) re-presents on the
// next launch. The marker stores the run kind ("create" | "import") so the
// re-presented guide keeps its import-only affordances (the funding step's
// "Change Chatting Address" picker). Cleared only by Finish on the last step.
// Help replays never set this and stay skippable.
// ---------------------------------------------------------------------------

const ONBOARDING_RUN_KEY = "kachat-onboarding-run-pending-v1";

export function pendingOnboardingRunKind() {
  const value = localStorage.getItem(ONBOARDING_RUN_KEY);
  return value === "create" || value === "import" ? value : null;
}

export function isOnboardingRunPending() {
  return pendingOnboardingRunKind() !== null;
}

export function markOnboardingRunPending(kind) {
  localStorage.setItem(ONBOARDING_RUN_KEY, kind === "import" ? "import" : "create");
}

export function clearOnboardingRunPending() {
  localStorage.removeItem(ONBOARDING_RUN_KEY);
}

// ---------------------------------------------------------------------------
// Eye toggle (password reveal) — reusable via markup convention:
// <span class="password-field-wrap"><input type="password" …>
//   <button data-eye-toggle>…</button></span>
// A single document-level delegated handler (installed by initChildMode)
// serves every such field, including Nextcloud's app-password input.
// ---------------------------------------------------------------------------

export const EYE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.3 12.3C4.4 7.7 8 5.2 12 5.2s7.6 2.5 9.7 7.1a.9.9 0 0 1 0 .8c-2.1 4.6-5.7 7.1-9.7 7.1s-7.6-2.5-9.7-7.1a.9.9 0 0 1 0-.8Z"/><circle cx="12" cy="12.7" r="3.1"/></svg>';
export const EYE_SLASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 4 20.5 21"/><path d="M9.9 5.7A9.7 9.7 0 0 1 12 5.5c4 0 7.6 2.5 9.7 7.1a.9.9 0 0 1 0 .8 15.6 15.6 0 0 1-2.8 4M6.2 7.2a15.1 15.1 0 0 0-3.9 5.4.9.9 0 0 0 0 .8c2.1 4.6 5.7 7.1 9.7 7.1 1.5 0 3-.4 4.3-1.1"/><path d="M9.9 10.8a3.1 3.1 0 0 0 4.3 4.3"/></svg>';

function passwordFieldHtml(name, placeholder) {
  return `<span class="password-field-wrap"><input class="field-input" type="password" data-cm-field="${name}" placeholder="${deps.escapeHtml(placeholder)}" autocomplete="off" /><button class="password-eye-btn" type="button" data-eye-toggle aria-label="Show password">${EYE_SVG}</button></span>`;
}

let eyeToggleInstalled = false;

function installEyeToggleDelegation() {
  if (eyeToggleInstalled) return;
  eyeToggleInstalled = true;
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-eye-toggle]");
    if (!button) return;
    const input = button.closest(".password-field-wrap")?.querySelector("input");
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.innerHTML = reveal ? EYE_SLASH_SVG : EYE_SVG;
    button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
  });
}

// ---------------------------------------------------------------------------
// Setup guide "Who will use KaChat?" step (renders into the guide's extra slot)
// ---------------------------------------------------------------------------

let guideChoice = "adult";
let guidePassword = "";
let guideConfirm = "";
let guideError = "";
let guideContainer = null;

function setGuideError(message) {
  guideError = message || "";
  const el = guideContainer?.querySelector('[data-cm-error="guide"]');
  if (!el) return;
  el.textContent = guideError;
  el.hidden = !guideError;
  // The guide's extra area scrolls — make sure a fresh error is actually seen.
  if (guideError) el.scrollIntoView({ block: "nearest" });
}

export function renderUserTypeGuideStep(container) {
  if (!container) return;
  guideContainer = container;
  if (isChildModeEnabled()) {
    // Replay with Child Mode already on: informational only — offering "Adult"
    // here would be a password-free way out.
    container.innerHTML = `<p class="setup-usertype-note">Child Mode is on. Chats, Group Chats, Portfolio and Cold Storage are available; Swap, KaPosts and Broadcasts are hidden. Manage this in Settings &gt; Security &gt; Child Mode.</p>`;
    return;
  }
  const rows = [
    { key: "adult", title: "Adult", sub: "The full app, everything available." },
    { key: "child", title: "Child", sub: "Chats, Portfolio and Cold Storage only. An adult sets a password to unlock the rest later." },
  ];
  container.innerHTML = `
    <p class="setup-usertype-note">A child gets a simpler, safer KaChat: just Chats, Group Chats, Portfolio and Cold Storage. Swap, KaPosts and Broadcasts stay hidden until an adult unlocks them.</p>
    <div class="setup-choice-list">
      ${rows.map((row) => `<button type="button" class="setup-node-row${guideChoice === row.key ? " selected" : ""}" data-cm-usertype="${row.key}"><span class="setup-node-dot"></span><span class="setup-node-copy"><strong>${row.title}</strong><small>${row.sub}</small></span></button>`).join("")}
    </div>
    ${guideChoice === "child" ? `
    <div class="setup-child-password">
      ${passwordFieldHtml("guide-password", "Password")}
      ${passwordFieldHtml("guide-confirm", "Confirm password")}
      <p class="field-hint">4 digits, 8 digits, or anything you like. Just don't forget it, it's needed to turn Child Mode off.</p>
    </div>` : ""}
    <p class="field-error" data-cm-error="guide" ${guideError ? "" : "hidden"}></p>`;
  setGuideError(guideError);
  // Preserve typed values across selection re-renders.
  const passwordInput = container.querySelector('[data-cm-field="guide-password"]');
  const confirmInput = container.querySelector('[data-cm-field="guide-confirm"]');
  if (passwordInput) {
    passwordInput.value = guidePassword;
    passwordInput.addEventListener("input", () => { guidePassword = passwordInput.value; setGuideError(""); });
  }
  if (confirmInput) {
    confirmInput.value = guideConfirm;
    confirmInput.addEventListener("input", () => { guideConfirm = confirmInput.value; setGuideError(""); });
  }
  container.querySelectorAll("[data-cm-usertype]").forEach((button) => {
    button.addEventListener("click", () => {
      guideChoice = button.dataset.cmUsertype;
      guideError = "";
      renderUserTypeGuideStep(container);
    });
  });
}

function resetGuideScratch() {
  guidePassword = "";
  guideConfirm = "";
  guideError = "";
}

/** The guide's Next on the user-type step. Returns true to advance. Adult just
 * marks the choice answered; Child validates + stores the password and turns
 * Child Mode ON immediately (persisted right here at the step, not deferred to
 * the end of the guide, so the choice survives however the wizard ends). */
export async function applyUserTypeGuideChoice() {
  if (isChildModeEnabled()) {
    // Informational replay: continuing still counts as answered — Child Mode
    // being on IS the standing choice.
    markUserTypeChosen();
    return true;
  }
  if (guideChoice !== "child") {
    markUserTypeChosen();
    resetGuideScratch();
    return true;
  }
  const password = guidePassword;
  if (!password) { setGuideError("Enter a password first."); return false; }
  if (password !== guideConfirm) { setGuideError("Passwords don't match."); return false; }
  try {
    await setChildModePassword(password);
  } catch {
    setGuideError("Couldn't save the password. Please try again.");
    return false;
  }
  setChildModeEnabled(true);
  resetGuideScratch();
  markUserTypeChosen();
  renderChildModeSettingsPage();
  deps.showToast?.("Child Mode is on");
  return true;
}

// ---------------------------------------------------------------------------
// Settings > Security > Child Mode page (renders into [data-child-mode-page])
// ---------------------------------------------------------------------------

let pageEl = null;
let pageWired = false;
let changeSucceeded = false;

const ABOUT_CARD_HTML = `
  <div class="settings-list-card">
    <div class="settings-page-form">
      <p class="child-mode-heading">What stays available</p>
      <p class="child-mode-keeps"><strong>Chats &amp; Group Chats · Portfolio · Cold Storage</strong></p>
      <p class="field-hint">While Child Mode is on, Swap, KaPosts and Broadcasts are removed everywhere — the dock, the Customize Dock page and every other entry point. Only the password turns it off.</p>
    </div>
  </div>`;

export function renderChildModeSettingsPage() {
  if (!pageEl) pageEl = document.querySelector("[data-child-mode-page]");
  if (!pageEl) return;
  const hasPassword = hasChildModePassword();
  const enabled = isChildModeEnabled();

  if (!hasPassword) {
    pageEl.innerHTML = `
      <div class="settings-list-card">
        <div class="settings-page-form">
          <p class="child-mode-heading">Set a Password</p>
          ${passwordFieldHtml("setup-password", "Password")}
          ${passwordFieldHtml("setup-confirm", "Confirm password")}
          <p class="field-hint">4 digits, 8 digits, or anything you like — just don't forget it. It's needed to turn Child Mode off later.</p>
          <p class="field-error" data-cm-error="setup" hidden></p>
          <button class="primary-button" type="button" data-cm-action="setup">Set Password &amp; Turn On</button>
        </div>
      </div>
      ${ABOUT_CARD_HTML}`;
  } else {
    pageEl.innerHTML = `
      <div class="settings-list-card">
        <div class="settings-toggle-row"><span><strong>Child Mode</strong><small>${enabled
          ? "Child Mode is on. Turning it off requires the password."
          : "A password is already set — turning Child Mode on doesn't ask for it."}</small></span><label class="switch-control"><input type="checkbox" data-cm-toggle${enabled ? " checked" : ""}><span></span></label></div>
        <div class="settings-page-form child-mode-prompt" data-cm-turnoff-prompt hidden>
          ${passwordFieldHtml("turnoff-password", "Password")}
          <p class="field-hint">Enter the Child Mode password to turn it off.</p>
          <p class="field-error" data-cm-error="turnoff" hidden></p>
          <div class="child-mode-prompt-actions">
            <button class="secondary-button" type="button" data-cm-action="turnoff-cancel">Cancel</button>
            <button class="primary-button" type="button" data-cm-action="turnoff-confirm">Turn Off</button>
          </div>
        </div>
      </div>
      <div class="settings-list-card">
        <div class="settings-page-form">
          <p class="child-mode-heading">Change Password</p>
          ${passwordFieldHtml("change-current", "Current password")}
          ${passwordFieldHtml("change-new", "New password")}
          ${passwordFieldHtml("change-confirm", "Confirm new password")}
          <p class="field-error" data-cm-error="change" hidden></p>
          <p class="child-mode-success" data-cm-change-ok${changeSucceeded ? "" : " hidden"}>Password changed.</p>
          <button class="primary-button" type="button" data-cm-action="change">Change Password</button>
        </div>
      </div>
      <div class="settings-list-card">
        <button class="settings-list-row danger-row" type="button" data-cm-action="clear-open"><span class="settings-row-copy"><strong>Clear Password</strong><small>Deletes the Child Mode password and turns Child Mode off, returning it to a never-set-up state. Requires the current password.</small></span></button>
        <div class="settings-page-form child-mode-prompt" data-cm-clear-prompt hidden>
          ${passwordFieldHtml("clear-password", "Password")}
          <p class="field-hint">Enter the Child Mode password to delete it and turn Child Mode off.</p>
          <p class="field-error" data-cm-error="clear" hidden></p>
          <div class="child-mode-prompt-actions">
            <button class="secondary-button" type="button" data-cm-action="clear-cancel">Cancel</button>
            <button class="primary-button danger" type="button" data-cm-action="clear-confirm">Clear Password</button>
          </div>
        </div>
      </div>
      ${ABOUT_CARD_HTML}`;
  }
  changeSucceeded = false;
  wirePage();
}

function pageError(name, message) {
  const el = pageEl?.querySelector(`[data-cm-error="${name}"]`);
  if (el) { el.textContent = message || ""; el.hidden = !message; }
}

function pageField(name) {
  return pageEl?.querySelector(`[data-cm-field="${name}"]`);
}

function fieldValue(name) {
  return String(pageField(name)?.value || "");
}

function showPrompt(selector) {
  const prompt = pageEl?.querySelector(selector);
  if (!prompt) return;
  prompt.hidden = false;
  const input = prompt.querySelector("input");
  if (input) { input.value = ""; input.focus(); }
}

async function handlePageAction(action) {
  if (action === "setup") {
    const password = fieldValue("setup-password");
    const confirm = fieldValue("setup-confirm");
    if (!password) { pageError("setup", "Enter a password first."); return; }
    if (password !== confirm) { pageError("setup", "Passwords don't match."); return; }
    try {
      await setChildModePassword(password);
    } catch {
      pageError("setup", "Couldn't save the password. Please try again.");
      return;
    }
    setChildModeEnabled(true);
    renderChildModeSettingsPage();
    deps.showToast?.("Child Mode is on");
  } else if (action === "turnoff-cancel") {
    const prompt = pageEl?.querySelector("[data-cm-turnoff-prompt]");
    if (prompt) prompt.hidden = true;
    pageError("turnoff", "");
  } else if (action === "turnoff-confirm") {
    const input = pageField("turnoff-password");
    if (!(await verifyChildModePassword(fieldValue("turnoff-password")))) {
      pageError("turnoff", "Wrong password. Child Mode stays on.");
      if (input) input.value = "";
      return;
    }
    setChildModeEnabled(false);
    renderChildModeSettingsPage();
    deps.showToast?.("Child Mode is off");
  } else if (action === "change") {
    const current = fieldValue("change-current");
    const next = fieldValue("change-new");
    const confirm = fieldValue("change-confirm");
    if (!current || !next || !confirm) { pageError("change", "Fill in every field first."); return; }
    if (next !== confirm) { pageError("change", "New passwords don't match."); return; }
    let changed = false;
    try {
      changed = await changeChildModePassword(current, next);
    } catch {
      pageError("change", "Couldn't save the new password. Please try again.");
      return;
    }
    if (!changed) {
      pageError("change", "Wrong current password. Nothing changed.");
      const input = pageField("change-current");
      if (input) input.value = "";
      return;
    }
    changeSucceeded = true;
    renderChildModeSettingsPage();
  } else if (action === "clear-open") {
    showPrompt("[data-cm-clear-prompt]");
  } else if (action === "clear-cancel") {
    const prompt = pageEl?.querySelector("[data-cm-clear-prompt]");
    if (prompt) prompt.hidden = true;
    pageError("clear", "");
  } else if (action === "clear-confirm") {
    let cleared = false;
    try {
      cleared = await clearChildModeConfiguration(fieldValue("clear-password"));
    } catch {
      pageError("clear", "Couldn't clear the password. Please try again.");
      return;
    }
    if (!cleared) {
      pageError("clear", "Wrong password. Nothing changed.");
      const input = pageField("clear-password");
      if (input) input.value = "";
      return;
    }
    // Back to the first-time state (the service already turned the flag off).
    renderChildModeSettingsPage();
    deps.showToast?.("Child Mode password cleared");
  }
}

function wirePage() {
  if (pageWired || !pageEl) return;
  pageWired = true;
  pageEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-cm-action]");
    if (!button) return;
    void handlePageAction(button.dataset.cmAction);
  });
  pageEl.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-cm-toggle]");
    if (!toggle) return;
    if (toggle.checked) {
      // Turning ON with a password already set needs no password.
      setChildModeEnabled(true);
      renderChildModeSettingsPage();
      deps.showToast?.("Child Mode is on");
    } else {
      // Turning OFF requires the password — don't change anything yet.
      toggle.checked = true;
      pageError("turnoff", "");
      showPrompt("[data-cm-turnoff-prompt]");
    }
  });
  pageEl.addEventListener("input", (event) => {
    // Typing anywhere clears that flow's error (mirrors the iOS onChange resets).
    if (!event.target.closest("[data-cm-field]")) return;
    pageEl.querySelectorAll("[data-cm-error]").forEach((el) => { el.hidden = true; });
    const ok = pageEl.querySelector("[data-cm-change-ok]");
    if (ok) ok.hidden = true;
  });
}

// ---------------------------------------------------------------------------
// Init (wired from app.js like the other deps-injected modules)
// ---------------------------------------------------------------------------

export function initChildMode(injected = {}) {
  deps = { ...deps, ...injected };
  installEyeToggleDelegation();
  renderChildModeSettingsPage();
}
