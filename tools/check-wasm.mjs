import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "kaspa/kaspa.js")) || !existsSync(join(root, "kaspa/kaspa_bg.wasm"))) {
  console.error("Missing kaspa/kaspa.js or kaspa/kaspa_bg.wasm.");
  console.error("These are normally committed to the repo, so this shouldn't happen.");
  console.error("  - If your clone is incomplete or shallow, re-clone the repo.");
  console.error("  - If you deleted them intentionally, rebuild from source with:");
  console.error("      npm run setup:wasm");
  process.exit(1);
}
