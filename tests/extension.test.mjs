import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { previousRetry, RECOVERY_ENTRY, registerErrorRetry } from "../index.ts";
import { policyKey } from "../src/rules.ts";

function commandFixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-error-retry-command-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "rules.json");
	const handlers = new Map();
	let command;
	registerErrorRetry({
		on: (name, handler) => { handlers.set(name, handler); },
		registerCommand: (name, definition) => { assert.equal(name, "error-retry"); command = definition.handler; },
	}, path);
	const notices = [];
	const ctx = { hasUI: true, ui: { notify: (message, type) => notices.push({ message, type }) } };
	return { path, handlers, command, notices, ctx };
}

test("Pi 规则编辑器保存校验失败保留草稿，保存成功后才通知", async (t) => {
	const f = commandFixture(t);
	const invalid = '{"rules":[{"mode":"regex","pattern":"["}]}';
	const valid = '{"rules":[{"mode":"contains","pattern":"custom"}]}';
	let edits = 0;
	f.ctx.ui.editor = async (_title, draft) => {
		if (edits++ === 0) return invalid;
		assert.equal(draft, invalid);
		return valid;
	};
	f.ctx.ui.select = async () => "继续修改草稿";
	await f.command("edit", f.ctx);
	assert.equal(edits, 2);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), JSON.parse(valid));
	assert.equal(f.notices.filter((notice) => notice.type === "error").length, 1);
	assert.equal(f.notices.filter((notice) => notice.message.startsWith("已保存")).length, 1);
});

test("其他窗口修改发生冲突，不覆盖；用户主动读最新后才能保存", async (t) => {
	const f = commandFixture(t);
	let edits = 0;
	f.ctx.ui.editor = async (_title, draft) => {
		if (edits++ === 0) writeFileSync(f.path, '{"rules":[]}');
		else assert.deepEqual(JSON.parse(draft), { rules: [] });
		return '{"rules":[{"mode":"contains","pattern":"new"}]}';
	};
	f.ctx.ui.select = async () => {
		assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { rules: [] });
		return "放弃草稿并读取最新配置";
	};
	await f.command("edit", f.ctx);
	assert.ok(f.notices.some((notice) => notice.message.includes("其他窗口修改")));
	assert.equal(JSON.parse(readFileSync(f.path, "utf8")).rules[0].pattern, "new");
});

test("取消编辑不保存，非 UI 模式不打开编辑器，stop 调用标准 abort", async (t) => {
	const f = commandFixture(t);
	let aborts = 0;
	f.ctx.abort = () => { aborts++; };
	f.ctx.ui.editor = async () => undefined;
	await f.command("edit", f.ctx);
	assert.equal(f.notices.length, 0);
	f.ctx.hasUI = false;
	f.ctx.ui.editor = () => { throw new Error("不应打开编辑器"); };
	await f.command("edit", f.ctx);
	assert.ok(f.notices[0].message.includes("没有编辑器"));
	await f.command("stop", f.ctx);
	assert.equal(aborts, 1);
});

test("持久日志只恢复当前分支、provider 和策略的计数", () => {
	const rules = [{ mode: "contains", pattern: "retry-me" }];
	const key = policyKey(rules);
	const record = { kind: "retry", retry: 17, retryId: "chain", policyKey: key, provider: "p", model: "m" };
	const log = { type: "custom", customType: RECOVERY_ENTRY, data: record };
	const error = { type: "message", message: { role: "assistant", stopReason: "error" } };
	assert.deepEqual(previousRetry([log, error], key, "p", "m"), record);
	assert.equal(previousRetry([log, error], "changed", "p", "m"), undefined);
	assert.equal(previousRetry([log, error], key, "other", "m"), undefined);
	for (const boundary of [{ type: "message", message: { role: "assistant", stopReason: "length" } },
		{ type: "message", message: { role: "assistant", stopReason: "stop" } },
		{ type: "message", message: { role: "user" } }, { type: "custom_message" }]) {
		assert.equal(previousRetry([log, boundary, error], key, "p", "m"), undefined);
	}
	assert.equal(previousRetry([], key, "p", "m"), undefined);
});

test("已结束错误加载扩展不会自动唤醒；非法规则和正则超时不接管", (t) => {
	const f = commandFixture(t);
	const error = { role: "assistant", stopReason: "error", provider: "p", model: "m", errorMessage: `${"a".repeat(100000)}!` };
	const event = { outcome: "error", continue: false, context: { pendingMessages: [], contextEntries: [{ sourceEntry: { id: "failure" } }] } };
	const ctx = { ...f.ctx, hasPendingMessages: () => false, sessionManager: { getBranch: () => [] } };
	f.handlers.get("session_start")();
	assert.equal(f.handlers.get("agent_before_settle")(event, ctx), undefined);
	f.handlers.get("turn_end")({ message: error, messageEntryId: "failure" }, ctx);
	writeFileSync(f.path, '{"rules":[{"mode":"regex","pattern":"^(a+)+$"}]}');
	assert.equal(f.handlers.get("agent_before_settle")(event, ctx), undefined);
	assert.ok(f.notices[0].message.includes("timed out"));
	writeFileSync(f.path, "invalid JSON");
	assert.equal(f.handlers.get("agent_before_settle")(event, ctx), undefined);
	assert.equal(f.notices.length, 2);
});
