#!/usr/bin/env node
// Enforce dependency direction between @vanrel/* packages (ARCHITECTURE.md §2/§4).
// Forbidden edges (fail exit 1):
//   context -> agent        (cycle; hooks are structural, §4.3.4)
//   context -> telemetry    (zero-context-overhead, §4.1.3)
//   telemetry -> any @vanrel/* (recorder is a leaf)
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgsDir = join(root, "packages");
const forbidden = [
	["context", "agent"],
	["context", "telemetry"],
];
const edges = [];
for (const dir of readdirSync(pkgsDir)) {
	const manifestPath = join(pkgsDir, dir, "package.json");
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		continue; // package without manifest yet — milestone pending
	}
	const deps = Object.keys({
		...manifest.dependencies,
		...manifest.devDependencies,
		...manifest.peerDependencies,
	}).filter((d) => d.startsWith("@vanrel/"));
	for (const dep of deps) edges.push([dir, dep.slice("@vanrel/".length)]);
	if (dir === "telemetry" && deps.length > 0) {
		console.error(`import-graph: telemetry must be a leaf, depends on: ${deps.join(", ")}`);
		process.exit(1);
	}
}
const violations = forbidden.filter(([from, to]) => edges.some(([f, t]) => f === from && t === to));
if (violations.length > 0) {
	for (const [from, to] of violations) console.error(`import-graph: forbidden edge ${from} -> ${to}`);
	process.exit(1);
}
console.log(`import-graph: OK (${edges.length} internal edges checked)`);
