import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostPath } from "../tests/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "pi-error-retry-check-"));
try {
	const path = join(temporary, "tsconfig.json");
	writeFileSync(path, JSON.stringify({
		extends: join(root, "tsconfig.json"),
		compilerOptions: {
			baseUrl: root,
			typeRoots: [join(root, "node_modules/@types")],
			paths: { "@earendil-works/pi-coding-agent": [hostPath.replace(/\.js$/, ".d.ts")] },
		},
	}));
	const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", path], {
		cwd: root, stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
