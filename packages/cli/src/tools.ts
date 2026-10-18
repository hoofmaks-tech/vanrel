/**
 * The builtin tools factory moved to ./tools/ (pi-vendor, W9). This module is a shim
 * preserving the existing `./tools.ts` imports (wiring.ts, index.ts) and the public API.
 */
export type { BuiltinToolsDeps, QcHooks } from "./tools/index.ts";
export { createBuiltinTools } from "./tools/index.ts";
