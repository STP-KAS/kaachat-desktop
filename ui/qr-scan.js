// Shared camera QR scanner for the desktop/PWA build.
//
// Desktop had QR *generation* only (engine/qr.js) plus two bespoke camera loops inside
// the cold storage flow. This module is the single reusable one: it opens a dismissable
// full-screen overlay, streams the camera into a canvas, decodes each frame with jsQR
// (see engine/qr.js for why not BarcodeDetector), and resolves with the decoded text.
//
// Two hard rules drive the shape of the code:
//
//  1. The camera is released on EVERY exit path. There is exactly one idempotent
//     `finish()`/`stopCamera()` pair; cancel, backdrop click, Escape, success, decode
//     error, switching to manual entry, tab-hide and page-hide all funnel through it.
//     A stream that arrives late (the user cancelled while the permission prompt was
//     still up) is stopped the moment it lands, because `state.wantsCamera` is already
//     false by then.
//
//  2. It never dead-ends. Where `getUserMedia` is missing or refused (insecure http on
//     a LAN, no camera, denied permission, camera busy) the overlay says so in plain
//     words and shows a manual entry field instead of a black rectangle.
//
// Styling reuses classes that already exist in ui/styles.css (.cold-scan-modal and
// friends, .contact-modal, .field-*, .primary-button/.secondary-button); the handful of
// rules those do not cover are set inline, since this module may not touch the stylesheet.

import { decodeQrFromImageData, normalizeScannedKaspaAddress } from "../engine/qr.js";

/** Only ever one scanner on screen; opening a second closes the first (and its camera). */
let activeSession = null;

/**
 * Why camera scanning cannot run here, or null when it should be possible.
 * Note this is checked before `getUserMedia` is called at all, so the honest message
 * appears instantly instead of after a rejected promise.
 * @returns {string|null}
 */
export function cameraScanUnavailableReason() {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return "Scanning is not available here.";
  }
  const insecure = window.isSecureContext === false;
  if (!navigator.mediaDevices?.getUserMedia) {
    if (insecure) {
      return "Your browser blocks the camera on pages served over plain http. Open the app over https or on localhost to scan, or enter the value below.";
    }
    return "This browser does not give web pages access to a camera, so scanning is not available. Enter the value below instead.";
  }
  if (insecure) {
    return "Your browser blocks the camera on pages served over plain http. Open the app over https or on localhost to scan, or enter the value below.";
  }
  return null;
}

/** True when a camera scan is worth offering at all (used to hide/enable Scan buttons). */
export function canScanWithCamera() {
  return cameraScanUnavailableReason() === null;
}

/** Plain-language version of a getUserMedia rejection. */
function describeCameraError(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "Camera permission was denied. Allow camera access for this site in your browser settings, then try again, or enter the value below.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return "No camera was found on this device. Enter the value below instead.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The camera is already in use by another app or tab. Close that, then try again, or enter the value below.";
  }
  const detail = error?.message ? ` (${error.message})` : "";
  return `The camera could not be started${detail}. Enter the value below instead.`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Closes whatever scanner is open, releasing its camera. Safe to call when none is.
 * The pending `scanQrCode` promise resolves with null.
 */
export function closeActiveScanner() {
  activeSession?.close();
}

/**
 * Opens the scanner overlay.
 *
 * @param {object} [options]
 * @param {string} [options.title] Heading above the viewfinder.
 * @param {string} [options.hint] Line under the viewfinder while scanning.
 * @param {string} [options.manualTitle] Heading of the manual entry card.
 * @param {string} [options.manualLabel] Field label in the manual entry card.
 * @param {string} [options.manualPlaceholder] Field placeholder.
 * @param {string} [options.manualHint] Extra help text under the manual field.
 * @param {boolean} [options.mono] Render the manual field in the monospace style.
 * @param {(raw: string) => string} [options.normalize] Cleans a decoded value before it
 *        is validated and returned. Defaults to identity.
 * @param {(value: string) => (string|null)} [options.validate] Returns an error message
 *        for a value that must be rejected, or null/undefined to accept it. A camera
 *        frame that fails keeps scanning; a manual entry that fails shows the message.
 * @returns {Promise<string|null>} The accepted value, or null if the user cancelled.
 */
export function scanQrCode(options = {}) {
  closeActiveScanner();
  return new Promise((resolve) => { openSession(options, resolve); });
}

/**
 * Convenience wrapper for the common case: scan a Kaspa address (or a KNS domain),
 * with `kaspa:addr?amount=...` query strings stripped exactly like the paste paths do.
 * @param {object} [options] Same options as `scanQrCode`; `normalize` is preset.
 * @returns {Promise<string|null>}
 */
export function scanKaspaAddress(options = {}) {
  return scanQrCode({
    title: "Scan a Kaspa Address",
    hint: "Line the QR code up inside the square",
    manualTitle: "Enter it manually",
    manualLabel: "Kaspa address or KNS domain",
    manualPlaceholder: "kaspa:qr... or name.kas",
    mono: true,
    ...options,
    normalize: normalizeScannedKaspaAddress,
  });
}

function openSession(options, resolve) {
  const {
    title = "Scan QR Code",
    hint = "Line the QR code up inside the square",
    manualTitle = "Enter it manually",
    manualLabel = "Value",
    manualPlaceholder = "",
    manualHint = "",
    mono = false,
    normalize = (raw) => String(raw || "").trim(),
    validate = null,
  } = options || {};

  const state = {
    closed: false,
    wantsCamera: true, // false once we give up on the camera, so a late stream is dropped
    scanning: false,
    rafId: 0,
    stream: null,
  };

  // --- overlay ---------------------------------------------------------------
  const overlay = el("div", "cold-scan-modal");
  // .cold-scan-modal sits at z-index 500, below .modal-backdrop (2000). This scanner is
  // opened FROM those modals (portfolio import, cold storage send), so it has to outrank them.
  overlay.style.zIndex = "2600";
  overlay.style.padding = "20px";
  overlay.style.overflowY = "auto";

  const heading = el("p", "cold-scan-hint", title);
  heading.style.fontSize = "16px";
  overlay.appendChild(heading);

  const frame = el("div", "cold-scan-frame");
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.setAttribute("autoplay", "");
  video.muted = true;
  video.playsInline = true;
  frame.appendChild(video);
  const target = el("div", "cold-scan-target");
  target.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 4; i += 1) target.appendChild(document.createElement("span"));
  frame.appendChild(target);
  overlay.appendChild(frame);

  const status = el("p", "cold-scan-hint", "Starting the camera...");
  status.setAttribute("role", "status");
  status.style.maxWidth = "min(90vw, 420px)";
  status.style.textAlign = "center";
  overlay.appendChild(status);

  // Manual entry card, hidden until it is needed or the user asks for it.
  const manual = el("div", "contact-modal");
  manual.style.maxWidth = "min(90vw, 420px)";
  manual.hidden = true;
  const manualHeading = el("h2", null, manualTitle);
  manualHeading.style.margin = "0 0 14px";
  manualHeading.style.fontSize = "18px";
  manual.appendChild(manualHeading);
  const manualField = el("label", "field-label", manualLabel);
  const manualInput = document.createElement("input");
  manualInput.type = "text";
  manualInput.className = mono ? "field-input cold-mono-input" : "field-input";
  manualInput.placeholder = manualPlaceholder;
  manualInput.autocomplete = "off";
  manualInput.spellcheck = false;
  manualField.appendChild(manualInput);
  manual.appendChild(manualField);
  if (manualHint) manual.appendChild(el("p", "field-hint", manualHint));
  const manualError = el("p", "field-error", "");
  manualError.hidden = true;
  manual.appendChild(manualError);
  const manualActions = el("div", "modal-actions");
  const retryButton = el("button", "secondary-button", "Try the camera again");
  retryButton.type = "button";
  const useButton = el("button", "primary-button", "Use this value");
  useButton.type = "button";
  manualActions.appendChild(retryButton);
  manualActions.appendChild(useButton);
  manual.appendChild(manualActions);
  overlay.appendChild(manual);

  const controls = el("div");
  controls.style.display = "flex";
  controls.style.gap = "14px";
  controls.style.alignItems = "center";
  const cancelButton = el("button", "secondary-button", "Cancel");
  cancelButton.type = "button";
  const manualToggle = el("button", "cold-inline-link", "Enter it manually");
  manualToggle.type = "button";
  controls.appendChild(cancelButton);
  controls.appendChild(manualToggle);
  overlay.appendChild(controls);

  // --- teardown --------------------------------------------------------------
  // Every path out of the scanner ends here. Idempotent, and it never throws, so a
  // failure while tidying up can't leave a track running.
  function stopCamera() {
    state.scanning = false;
    if (state.rafId) {
      try { cancelAnimationFrame(state.rafId); } catch { /* ignore */ }
      state.rafId = 0;
    }
    const stream = state.stream;
    state.stream = null;
    if (stream) {
      try {
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    try { video.pause(); } catch { /* ignore */ }
    try { video.srcObject = null; } catch { /* ignore */ }
  }

  function finish(value) {
    if (state.closed) return;
    state.closed = true;
    state.wantsCamera = false;
    stopCamera();
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("keydown", onKeyDown, true);
    try { overlay.remove(); } catch { /* ignore */ }
    if (activeSession === session) activeSession = null;
    resolve(value == null ? null : value);
  }

  // --- camera ----------------------------------------------------------------
  const grab = document.createElement("canvas");
  const ctx = grab.getContext("2d", { willReadFrequently: true });

  function showManual(message, { focus = true } = {}) {
    state.wantsCamera = false;
    stopCamera();
    if (state.closed) return;
    frame.hidden = true;
    manual.hidden = false;
    manualError.hidden = true;
    manualError.textContent = "";
    status.textContent = message || "";
    status.hidden = !message;
    manualToggle.hidden = true;
    retryButton.hidden = !canScanWithCamera();
    if (focus) {
      try { manualInput.focus(); } catch { /* ignore */ }
    }
  }

  function showCamera() {
    if (state.closed) return;
    manual.hidden = true;
    frame.hidden = false;
    status.hidden = false;
    manualToggle.hidden = false;
    state.wantsCamera = true;
    startCamera();
  }

  async function startCamera() {
    const reason = cameraScanUnavailableReason();
    if (reason) { showManual(reason); return; }
    status.textContent = "Starting the camera...";
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch (error) {
      if (state.closed) return;
      showManual(describeCameraError(error));
      return;
    }
    // The overlay may have been dismissed while the permission prompt was up. A stream
    // that lands after that is nobody's, so stop it now rather than leaking the camera.
    if (state.closed || !state.wantsCamera) {
      try { stream.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
      return;
    }
    state.stream = stream;
    try { video.srcObject = stream; } catch { /* ignore */ }
    try { await video.play(); } catch { /* autoplay policies; the frame loop still reads it */ }
    if (state.closed || !state.wantsCamera) { stopCamera(); return; }
    status.textContent = hint;
    state.scanning = true;
    tick();
  }

  function tick() {
    if (state.closed || !state.scanning) return;
    state.rafId = requestAnimationFrame(tick);
    let value = null;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        grab.width = video.videoWidth;
        grab.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        value = decodeQrFromImageData(ctx.getImageData(0, 0, grab.width, grab.height));
      }
    } catch (error) {
      // Frame reads can throw (a tainted or torn-down canvas). Release the camera and
      // fall back to typing rather than spinning on a broken loop.
      showManual(`Scanning stopped because a camera frame could not be read${error?.message ? ` (${error.message})` : ""}. Enter the value below instead.`);
      return;
    }
    if (!value) return;
    const normalized = normalize(value);
    const problem = validate ? validate(normalized) : null;
    if (problem) { status.textContent = problem; return; } // keep scanning for a good code
    finish(normalized);
  }

  function submitManual() {
    const normalized = normalize(manualInput.value);
    if (!normalized) {
      manualError.textContent = "Enter a value first.";
      manualError.hidden = false;
      return;
    }
    const problem = validate ? validate(normalized) : null;
    if (problem) {
      manualError.textContent = problem;
      manualError.hidden = false;
      return;
    }
    finish(normalized);
  }

  // --- listeners -------------------------------------------------------------
  function onPageHide() { finish(null); }

  function onVisibilityChange() {
    // Hand the camera back the moment the page stops being visible; the user can pick it
    // up again with "Try the camera again", or just type the value.
    if (document.visibilityState === "hidden" && state.wantsCamera) {
      showManual("The camera was released when this page was hidden. Try the camera again, or enter the value below.", { focus: false });
    }
  }

  function onKeyDown(event) {
    if (event.key !== "Escape" || state.closed) return;
    // Capture phase + stopPropagation so the host page's own Escape handlers (which would
    // close the modal underneath this overlay) do not also fire.
    event.preventDefault();
    event.stopPropagation();
    finish(null);
  }

  cancelButton.addEventListener("click", () => finish(null));
  manualToggle.addEventListener("click", () => showManual("", { focus: true }));
  retryButton.addEventListener("click", () => showCamera());
  useButton.addEventListener("click", submitManual);
  manualInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitManual();
  });
  manualInput.addEventListener("input", () => {
    manualError.hidden = true;
    manualError.textContent = "";
  });
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) finish(null);
  });

  // `pagehide` (not `beforeunload`, which would cost the page its bfcache entry) plus the
  // visibility handler below means the camera is handed back whenever the page goes away.
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("keydown", onKeyDown, true);

  const session = { close: () => finish(null) };
  activeSession = session;

  document.body.appendChild(overlay);

  const blocked = cameraScanUnavailableReason();
  if (blocked) showManual(blocked, { focus: true });
  else startCamera();

  return session;
}
