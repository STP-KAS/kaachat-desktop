import QRCode from "qrcode";
import jsQR from "jsqr";

export function makeQrPayload(address) {
  if (!address) throw new Error("Generate or import a private key first.");
  return address;
}

export async function drawKaspaQr(canvas, payload, { dark = "#effcf7", light = "#071415" } = {}) {
  await QRCode.toCanvas(canvas, payload, {
    errorCorrectionLevel: "M",
    margin: 3,
    width: 512,
    color: { dark, light }
  });
}

// --- Decoding ---------------------------------------------------------------
// jsQR rather than the browser's BarcodeDetector: BarcodeDetector is missing from
// Chromium on Linux and from Firefox entirely, and it only ever returns strings, so
// it cannot round-trip the binary KSPT frames the cold storage flow scans. jsQR is
// already bundled for that flow, so text scanning reuses the same decoder.

/**
 * Decodes a single QR code out of one canvas frame.
 * @param {ImageData|null} imageData Pixels from `ctx.getImageData(...)`.
 * @returns {string|null} The trimmed decoded text, or null when no code was found.
 */
export function decodeQrFromImageData(imageData) {
  if (!imageData?.data || !imageData.width || !imageData.height) return null;
  const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
  const value = typeof code?.data === "string" ? code.data.trim() : "";
  return value || null;
}

/**
 * Normalizes a scanned/pasted Kaspa address: trims, and for a `kaspa:` / `kaspatest:`
 * URI drops any query string (`?amount=...`) so only the address itself survives.
 * Port of the shared `handleScannedQRCode` normalization on iOS.
 * @param {string} text
 * @returns {string}
 */
export function normalizeScannedKaspaAddress(text) {
  let value = String(text || "").trim();
  const lower = value.toLowerCase();
  if (lower.startsWith("kaspa:") || lower.startsWith("kaspatest:")) {
    const query = value.indexOf("?");
    if (query !== -1) value = value.slice(0, query);
  }
  return value.trim();
}
