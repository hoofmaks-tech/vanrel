// Minimal vendored declaration for cross-spawn@7: the package bundles no types and
// @types/cross-spawn is not installed in this workspace. Covers only the default
// export used by src/transports/stdio.ts.
declare module "cross-spawn" {
	import type { ChildProcess, SpawnOptions } from "node:child_process";
	function crossSpawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
	export default crossSpawn;
}
