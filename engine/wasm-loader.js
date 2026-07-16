export async function loadKaspaModule() {
  try {
    const mod = await import("../kaspa/kaspa.js");
    await mod.default("../kaspa/kaspa_bg.wasm");
    return mod;
  } catch (firstError) {
    try {
      const mod = await import("../kaspa/kaspa-wasm.js");
      await mod.default("../kaspa/kaspa-wasm_bg.wasm");
      return mod;
    } catch {
      throw firstError;
    }
  }
}
