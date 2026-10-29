import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig, saveConfig } from "../src/config.ts";
import { DEFAULT_RULES, matchesRules, policyKey, providerRetryAfter, retryDelay, validateConfig, waitForRetry } from "../src/rules.ts";

function temporary(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-error-retry-rules-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("默认两句、自定义替换、OR、空列表和大小写", () => {
	const defaults = validateConfig({}).rules;
	assert.equal(defaults.length, 2);
	for (const rule of DEFAULT_RULES) assert.ok(matchesRules(defaults, `prefix ${rule.pattern} suffix`));
	const rules = validateConfig({ rules: [{ mode: "contains", pattern: " custom " }, { mode: "regex", pattern: "^OVERLOAD$", flags: "i" }] }).rules;
	assert.ok(matchesRules(rules, "overload"));
	assert.ok(matchesRules(rules, "a custom b"));
	assert.ok(!matchesRules(rules, "custom"));
	assert.ok(!matchesRules(rules, DEFAULT_RULES[0].pattern));
	assert.ok(!matchesRules([{ mode: "contains", pattern: "ABC" }], "abc"));
	assert.ok(!matchesRules([], "anything"));
	for (let i = 0; i < 4; i++) assert.ok(matchesRules(rules, "OVERLOAD"));
});

test("拒绝非法配置、正则和有状态 flags", () => {
	for (const value of [null, [], { rules: null }, { rules: [{ mode: "contains", pattern: " " }] },
		{ rules: [{ mode: "contains", pattern: "ok", flags: "i" }] },
		{ rules: [{ mode: "regex", pattern: "[" }] },
		...['g', 'y', 'ii', 'd', 'v'].map((flags) => ({ rules: [{ mode: "regex", pattern: "ok", flags }] })),
		{ rules: [{ mode: "other", pattern: "ok" }] }, { rules: [], extra: true }]) {
		assert.throws(() => validateConfig(value));
	}
});

test("策略键规范化，但不忽略有效空白和真正的配置变化", () => {
	const a = [{ mode: "regex", pattern: "abc", flags: "mi" }, { mode: "contains", pattern: "ok" }];
	const b = [{ mode: "contains", pattern: "ok" }, { mode: "regex", pattern: "abc", flags: "im" }, { mode: "contains", pattern: "ok" }];
	assert.equal(policyKey(a), policyKey(b));
	assert.notEqual(policyKey(a), policyKey([{ mode: "contains", pattern: " ok " }]));
});

test("恶意回溯在 25ms 预算内终止而不是命中", () => {
	assert.throws(() => matchesRules([{ mode: "regex", pattern: "^(a+)+$" }], `${"a".repeat(100000)}!`),
		(error) => error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT");
});

test("指数退避、抖动、30 秒上限和服务端长等待", () => {
	assert.deepEqual([1, 2, 3, 4, 5, 6, 101].map((retry) => retryDelay(retry, undefined, () => 0.5)),
		[1000, 2000, 4000, 8000, 16000, 30000, 30000]);
	assert.equal(retryDelay(1, undefined, () => 0), 900);
	assert.equal(retryDelay(1, undefined, () => 1), 1100);
	assert.equal(retryDelay(101, undefined, () => 1), 30000);
	assert.equal(retryDelay(1, 2147483648), 2147483648);
	for (const invalid of [NaN, Infinity, 0, -1]) assert.equal(retryDelay(1, invalid, () => 0.5), 1000);
});

test("Retry-After 支持毫秒、秒、HTTP 日期、大小写和无效值", () => {
	assert.equal(providerRetryAfter({ "Retry-After-Ms": "75000", "retry-after": "2" }), 75000);
	assert.equal(providerRetryAfter({ "Retry-After": "70.5" }), 70500);
	const now = Date.UTC(2026, 0, 1);
	assert.equal(providerRetryAfter({ "retry-after": new Date(now + 120000).toUTCString() }, now), 120000);
	assert.equal(providerRetryAfter({ "retry-after-ms": "bad", "retry-after": "60" }), 60000);
	for (const value of ["", " ", "-1", "0", "bad", "Infinity"]) assert.equal(providerRetryAfter({ "retry-after": value }), undefined);
});

test("长等待分段，等待取消和零等待", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const controller = new AbortController();
	const waiting = waitForRetry(2147483648, controller.signal);
	t.mock.timers.tick(2147483647);
	await Promise.resolve();
	let done = false;
	waiting.then(() => { done = true; });
	assert.equal(done, false);
	t.mock.timers.tick(1);
	assert.equal(await waiting, true);
	const cancelled = new AbortController();
	const pending = waitForRetry(10000, cancelled.signal);
	cancelled.abort();
	assert.equal(await pending, false);
	assert.equal(await waitForRetry(0, cancelled.signal), false);
	assert.equal(await waitForRetry(0, new AbortController().signal), true);
});

test("原子保存、权限、冲突和非法保存不覆盖文件", (t) => {
	const directory = temporary(t);
	const path = join(directory, "rules.json");
	const first = readConfig(path);
	assert.equal(first.revision, null);
	saveConfig(path, { rules: [] }, first.revision);
	const snapshot = readConfig(path);
	assert.deepEqual(snapshot.config.rules, []);
	assert.throws(() => saveConfig(path, {}, first.revision), /其他窗口修改/);
	assert.throws(() => saveConfig(path, { rules: [{ mode: "regex", pattern: "[" }] }, snapshot.revision));
	assert.equal(readFileSync(path, "utf8"), snapshot.revision);
	assert.deepEqual(readdirSync(directory), ["rules.json"]);
	writeFileSync(`${path}.lock`, "");
	assert.throws(() => saveConfig(path, {}, snapshot.revision), /正在保存/);
});

test("非法文件不降级成默认规则，外部有效修改下一次读取生效", (t) => {
	const path = join(temporary(t), "rules.json");
	writeFileSync(path, "broken");
	assert.throws(() => readConfig(path));
	writeFileSync(path, '{"rules":[]}');
	assert.deepEqual(readConfig(path).config.rules, []);
});
