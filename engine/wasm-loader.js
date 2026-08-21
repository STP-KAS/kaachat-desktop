export async function loadKaspaModule() {
  const mod = await import("../kaspa/kaspa.js");
  // wasm-bindgen deprecated positional init params — pass the single-object form
  // (silences the "using deprecated parameters for the initialization function" warning).
  await mod.default({ module_or_path: "../kaspa/kaspa_bg.wasm" });
  return mod;
  // The old kaspa-wasm.js/kaspa-wasm_bg.wasm "legacy fallback" was deleted: it was a
  // byte-identical copy of the files above (12.5 MB of duplicated repo weight), so the
  // fallback could only ever load the exact same bytes that just failed.
}
