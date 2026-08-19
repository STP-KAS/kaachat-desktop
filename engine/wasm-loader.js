export async function loadKaspaModule() {
  try {
    const mod = await import("../kaspa/kaspa.js");
    // wasm-bindgen deprecated positional init params — pass the single-object form
    // (silences the "using deprecated parameters for the initialization function" warning).
    await mod.default({ module_or_path: "../kaspa/kaspa_bg.wasm" });
    return mod;
  } catch (firstError) {
    try {
      // Legacy fallback bundle: predates the object-form init, keep the positional param.
      const mod = await import("../kaspa/kaspa-wasm.js");
      await mod.default("../kaspa/kaspa-wasm_bg.wasm");
      return mod;
    } catch {
      throw firstError;
    }
  }
}
