export async function loadKaspaModule() {
  const mod = await import("../kaspa/kaspa.js");
  // Resolve the .wasm relative to THIS module (not the document), so it's correct no matter what
  // path the app is served under.
  const wasmUrl = new URL("../kaspa/kaspa_bg.wasm", import.meta.url);
  // Fetch the bytes ourselves and hand them to wasm-bindgen as a BufferSource. This deliberately
  // avoids WebAssembly.instantiateStreaming, which HARD-FAILS when a reverse proxy (e.g. the
  // Nginx/DuckDNS front end for the test site) serves the .wasm with a Content-Type other than
  // application/wasm, or gzip-encodes it. Streaming works on localhost/Vite but breaks behind the
  // proxy — instantiating from an ArrayBuffer sidesteps both. wasm-bindgen deprecated positional
  // init params, so pass the single-object form.
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Could not fetch Kaspa WASM (HTTP ${response.status}) from ${wasmUrl.pathname}`);
  const bytes = await response.arrayBuffer();
  await mod.default({ module_or_path: bytes });
  return mod;
  // The old kaspa-wasm.js/kaspa-wasm_bg.wasm "legacy fallback" was deleted: it was a
  // byte-identical copy of the files above (12.5 MB of duplicated repo weight), so the
  // fallback could only ever load the exact same bytes that just failed.
}
