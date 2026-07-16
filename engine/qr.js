import QRCode from "qrcode";

export function makeQrPayload(address) {
  if (!address) throw new Error("Generate or import a private key first.");
  return address;
}

export async function drawKaspaQr(canvas, payload) {
  await QRCode.toCanvas(canvas, payload, {
    errorCorrectionLevel: "M",
    margin: 3,
    width: 512,
    color: {
      dark: "#effcf7",
      light: "#071415"
    }
  });
}
