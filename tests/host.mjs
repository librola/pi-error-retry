import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
function packageEntry(require, name) {
	for (const root of require.resolve.paths(name) ?? []) {
		const path = join(root, name, "package.json");
		if (existsSync(path)) return join(dirname(path), JSON.parse(readFileSync(path, "utf8")).main);
	}
	throw new Error(`找不到 ${name}，请设置 PI_TEST_PACKAGE 指向已安装 Pi 的 package.json`);
}
export const hostPath = process.env.PI_TEST_PACKAGE
	? join(dirname(process.env.PI_TEST_PACKAGE), "dist", "index.js")
	: packageEntry(require, "@earendil-works/pi-coding-agent");
export const hostRequire = createRequire(hostPath);
export const piHost = await import(pathToFileURL(hostPath).href);
export const aiHost = await import(pathToFileURL(packageEntry(hostRequire, "@earendil-works/pi-ai")).href);
