export const NETWORK_ID = "mainnet";

export function stringify(value) {
  try {
    return typeof value === "string"
      ? value
      : JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
  } catch {
    return String(value);
  }
}

export function requireKaspa(kaspa) {
  if (!kaspa) throw new Error("Load Rusty Kaspa WASM first.");
}

export function validatePrivateKeyHex(hex) {
  const clean = String(hex || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("Private key must be 64 hex characters.");
  }
  return clean;
}

export function validateMainnetAddress(address) {
  const clean = String(address || "").trim();
  if (!clean.startsWith("kaspa:")) throw new Error("Destination must be a mainnet kaspa: address.");
  return clean;
}

export function sompiToKaspaDisplay(kaspa, totalSompi) {
  if (kaspa?.sompiToKaspaString) return kaspa.sompiToKaspaString(totalSompi);
  const s = totalSompi.toString().padStart(9, "0");
  return `${s.slice(0, -8) || "0"}.${s.slice(-8).replace(/0+$/, "") || "0"}`;
}
