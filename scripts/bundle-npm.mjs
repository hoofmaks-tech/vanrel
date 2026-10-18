/**
 * Release bundler: builds the workspace, bundles @vanrel/cli dist into a
 * single zero-dependency ESM file, and stages the npm package in dist-npm/.
 *
 * Usage: node scripts/bundle-npm.mjs [version]
 * Then:  cd dist-npm && npm publish --access public
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-npm");
const version = process.argv[2];
if (!version) {
	console.error("usage: node scripts/bundle-npm.mjs <version>");
	process.exit(1);
}

execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync(
	"npx",
	[
		"esbuild",
		"packages/cli/dist/main.js",
		"--bundle",
		"--platform=node",
		"--format=esm",
		"--target=node22",
		`--outfile=${join(out, "vanrel.js")}`,
		"--banner:js=import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
	],
	{ cwd: root, stdio: "inherit" },
);
cpSync(join(root, "packages/cli/dist/interactive/theme/dark.json"), join(out, "dark.json"));
cpSync(join(root, "packages/cli/dist/interactive/theme/light.json"), join(out, "light.json"));
for (const f of ["README.md", "LICENSE", "NOTICE"]) cpSync(join(root, f), join(out, f));

writeFileSync(
	join(out, "package.json"),
	`${JSON.stringify(
		{
			name: "vanrel",
			version,
			description:
				"Terminal AI harness on subscription OAuth (Claude Code, Antigravity, Codex). Zero-dependency single-file build.",
			license: "Apache-2.0",
			type: "module",
			bin: { vanrel: "./vanrel.js" },
			files: ["vanrel.js", "dark.json", "light.json", "README.md", "LICENSE", "NOTICE"],
			engines: { node: ">=22" },
			repository: { type: "git", url: "https://github.com/shleder/vanrel.git" },
			keywords: ["ai", "cli", "llm", "agent", "terminal", "claude", "codex", "antigravity"],
		},
		null,
		2,
	)}\n`,
);
console.log(`staged ${out} (vanrel@${version})`);
