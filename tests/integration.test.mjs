import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTINUE_MESSAGE, RECOVERY_ENTRY, registerErrorRetry } from "../index.ts";
import { waitForRetry } from "../src/rules.ts";
import { aiHost, piHost } from "./host.mjs";

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = piHost;
const { createAssistantMessageEventStream } = aiHost;
const mockedTests = new WeakSet();

async function fixture(t, responses, options = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-error-retry-integration-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const configPath = join(directory, "error-retry.json");
	writeFileSync(configPath, JSON.stringify({ rules: options.rules ?? [{ mode: "contains", pattern: "retry-me" }] }));
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false }, retry: { enabled: false }, ...options.settings,
		...(options.packageExtension ? { packages: [new URL("..", import.meta.url).pathname] } : {}),
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"), modelsPath: null,
		modelsStorePath: join(directory, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false,
	});
	const requests = [];
	const errors = [];
	const delays = [];
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const provider = {
		api: "openai-completions", baseUrl: "http://invalid.test", apiKey: "FAUX-NOT-A-REAL-KEY",
		models: [{ id: "faux", name: "Faux", reasoning: false, input: ["text"], cost, contextWindow: 1000000, maxTokens: 1000 }],
		streamSimple(model, context, streamOptions) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				try {
					if (streamOptions?.signal?.aborted) {
						const message = assistant(model, { stopReason: "aborted", errorMessage: "Request was aborted" });
						stream.push({ type: "error", reason: "aborted", error: message });
						return;
					}
					requests.push(structuredClone(context.messages));
					const response = typeof responses === "function" ? await responses(requests.length, context) : responses[requests.length - 1];
					if (!response) throw new Error("模拟响应已耗尽，可能出现多余恢复请求");
					await streamOptions?.onPayload?.({ messages: context.messages }, model);
					await streamOptions?.onResponse?.({ status: response.status ?? 200, headers: response.headers ?? {} }, model);
					const message = assistant(model, response);
					stream.push({ type: "start", partial: message });
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						stream.push({ type: "error", reason: message.stopReason, error: message });
					} else {
						stream.push({ type: "done", reason: message.stopReason, message });
					}
				} catch (error) {
					errors.push(error);
					const message = assistant(model, { stopReason: "error", errorMessage: String(error) });
					stream.push({ type: "error", reason: "error", error: message });
				}
			});
			return stream;
		},
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: options.fileExtension ? [new URL("../index.ts", import.meta.url).pathname] : [],
		extensionFactories: [
			(pi) => pi.registerProvider("faux-error-retry", provider),
			...(options.fileExtension || options.packageExtension || options.skipRecovery ? [] : [(pi) => registerErrorRetry(pi, configPath)]),
			...(options.extensionFactories ?? []),
		],
	});
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	if (options.fileExtension || options.packageExtension) process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await resourceLoader.reload();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: directory, agentDir: directory, resourceLoader, modelRuntime, settingsManager,
		sessionManager: SessionManager.inMemory(directory),
		model: { ...provider.models[0], provider: "faux-error-retry", api: provider.api, baseUrl: provider.baseUrl, type: "chat" },
		thinkingLevel: "off", tools: options.customTools?.map((tool) => tool.name) ?? [], customTools: options.customTools,
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ onError: (error) => errors.push(error), mode: "json" });
	if (!options.realTimers && !mockedTests.has(t)) {
		// 同一用例的多个 fixture 只替换一次，避免多层 mock 的恢复留下旧的定时器替身。
		mockedTests.add(t);
		const original = globalThis.setTimeout;
		t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
			delays.push(delay);
			return original(callback, 0, ...args);
		});
		t.mock.method(Math, "random", () => 0.5);
	}
	return { session, requests, errors, delays, configPath, directory };
}

function assistant(model, response) {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: response.content ?? [{ type: "text", text: response.text ?? "" }],
		stopReason: response.stopReason ?? "stop", timestamp: Date.now(),
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
	};
}

function recovery(session, kind) {
	return session.sessionManager.getBranch().filter((entry) => entry.type === "custom" &&
		entry.customType === RECOVERY_ENTRY && entry.data.kind === kind);
}

test("真实 Pi SDK：连续 101 次错误无限重试，输入不插入继续且失败保留在原始历史", async (t) => {
	const f = await fixture(t, (n) => n <= 101 ? { stopReason: "error", errorMessage: "retry-me", text: "失败中的残缺回复" } : { text: "完成" });
	await f.session.prompt("原始任务");
	assert.equal(f.requests.length, 102);
	for (const request of f.requests) assert.deepEqual(request, f.requests[0]);
	const records = recovery(f.session, "retry");
	assert.equal(records.length, 101);
	assert.deepEqual(records.map((entry) => entry.data.retry), Array.from({ length: 101 }, (_, i) => i + 1));
	assert.equal(new Set(records.map((entry) => entry.data.retryId)).size, 1);
	assert.deepEqual(f.delays.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 30000]);
	assert.equal(recovery(f.session, "retry-started").length, 101);
	assert.equal(f.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.stopReason === "error").length, 101);
	assert.ok(!f.session.messages.some((message) => message.role === "assistant" && message.stopReason === "error"));
	assert.deepEqual(f.errors, []);
});

test("真实 Pi SDK：长度截断保留前文并续写，连续两次只请求三次，不计为 retry", async (t) => {
	const f = await fixture(t, [{ stopReason: "length", text: "第一段" }, { stopReason: "length", text: "第二段" }, { text: "结尾" }],
		{ settings: { compaction: { enabled: true } } });
	await f.session.prompt("长任务");
	assert.equal(f.requests.length, 3);
	assert.ok(f.requests[1].some((message) => message.role === "assistant" && message.content[0].text === "第一段"));
	assert.ok(f.requests[1].some((message) => message.role === "user" && message.content[0].text === CONTINUE_MESSAGE));
	assert.ok(f.requests[2].some((message) => message.role === "assistant" && message.content[0].text === "第二段"));
	assert.equal(recovery(f.session, "continue").length, 2);
	assert.equal(recovery(f.session, "retry").length, 0);
	assert.equal(f.session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit").length, 0);
	assert.deepEqual(f.errors, []);
});

test("截断续写后发生错误：重试保留续写提示和前文，而不是重跑原任务", async (t) => {
	const f = await fixture(t, [{ stopReason: "length", text: "保留前文" }, { stopReason: "error", errorMessage: "retry-me" }, { text: "后续完成" }]);
	await f.session.prompt("任务");
	assert.equal(f.requests.length, 3);
	assert.deepEqual(f.requests[2], f.requests[1]);
	assert.equal(recovery(f.session, "continue").length, 1);
	assert.equal(recovery(f.session, "retry").length, 1);
	assert.deepEqual(f.errors, []);
});

test("内置有限重试先行，耗尽后扩展继续无限重试，不双重请求", async (t) => {
	const f = await fixture(t, (n) => n <= 5 ? { stopReason: "error", errorMessage: "503 retry-me" } : { text: "完成" }, {
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
	});
	await f.session.prompt("任务");
	assert.equal(f.requests.length, 6);
	assert.equal(recovery(f.session, "retry").length, 1);
	assert.deepEqual(f.delays, [1, 2, 1000, 1, 2]);
	for (const request of f.requests) assert.deepEqual(request, f.requests[0]);
	assert.deepEqual(f.errors, []);
});

test("未匹配错误、空规则和用户取消不被无限重试；空规则不关闭长度续写", async (t) => {
	for (const options of [{ response: { stopReason: "error", errorMessage: "permanent failure" } },
		{ response: { stopReason: "error", errorMessage: "retry-me" }, rules: [] },
		{ response: { stopReason: "aborted", errorMessage: "retry-me" } }]) {
		const f = await fixture(t, [options.response], options.rules ? { rules: options.rules } : {});
		await f.session.prompt("任务");
		assert.equal(f.requests.length, 1);
		assert.equal(recovery(f.session, "retry").length, 0);
		assert.deepEqual(f.errors, []);
	}
	const f = await fixture(t, [{ stopReason: "length", text: "前文" }, { text: "完成" }], { rules: [] });
	await f.session.prompt("任务");
	assert.equal(f.requests.length, 2);
	assert.deepEqual(f.errors, []);
});

test("等待服从服务端 Retry-After，标准 abort 立即取消且没有新请求", async (t) => {
	const f = await fixture(t, [{ stopReason: "error", errorMessage: "retry-me", headers: { "retry-after": "3600" } }], { realTimers: true });
	const waiting = new Promise((resolve) => {
		f.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "custom" &&
				event.entry.customType === RECOVERY_ENTRY && event.entry.data.kind === "retry") resolve();
		});
	});
	const run = f.session.prompt("任务");
	await waiting;
	await new Promise(setImmediate);
	const start = Date.now();
	await f.session.abort();
	await run;
	assert.ok(Date.now() - start < 1000);
	assert.equal(f.requests.length, 1);
	assert.equal(recovery(f.session, "retry")[0].data.delayMs, 3600000);
	assert.equal(recovery(f.session, "retry-started").length, 0);
	assert.deepEqual(f.errors, []);
});

test("保存热更新且不卸载：下一次错误使用新规则", async (t) => {
	let f;
	f = await fixture(t, (n) => {
		if (n === 1) return { stopReason: "error", errorMessage: "retry-me" };
		writeFileSync(f.configPath, '{"rules":[]}');
		return { stopReason: "error", errorMessage: "retry-me" };
	});
	await f.session.prompt("任务");
	assert.equal(f.requests.length, 2);
	assert.equal(recovery(f.session, "retry").length, 1);
	assert.deepEqual(f.errors, []);
});

test("成功步骤和新用户回合重置重试计数", async (t) => {
	const f = await fixture(t, [{ stopReason: "error", errorMessage: "retry-me" }, { text: "完成一" },
		{ stopReason: "error", errorMessage: "retry-me" }, { text: "完成二" }]);
	await f.session.prompt("第一任务");
	await f.session.prompt("第二任务");
	assert.deepEqual(recovery(f.session, "retry").map((entry) => entry.data.retry), [1, 1]);
	assert.notEqual(recovery(f.session, "retry")[0].data.retryId, recovery(f.session, "retry")[1].data.retryId);
	assert.deepEqual(f.errors, []);
});

function counterTool(calls) {
	return {
		name: "counter", label: "Counter", description: "模拟有副作用工具",
		parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
		execute: async (_id, args) => {
			calls.push(args.value);
			return { content: [{ type: "text", text: `完成 ${args.value}` }], details: {} };
		},
	};
}

function toolCall(id, value) {
	return { type: "toolCall", id, name: "counter", arguments: { value } };
}

test("有副作用工具不重放；每个新工具步骤的重试计数重置", async (t) => {
	const calls = [];
	const f = await fixture(t, [
		{ stopReason: "toolUse", content: [toolCall("tool-one", "一")] },
		{ stopReason: "error", errorMessage: "retry-me" },
		{ stopReason: "toolUse", content: [toolCall("tool-two", "二")] },
		{ stopReason: "error", errorMessage: "retry-me" },
		{ text: "完成" },
	], { customTools: [counterTool(calls)] });
	await f.session.prompt("任务");
	assert.deepEqual(calls, ["一", "二"]);
	assert.equal(f.requests.length, 5);
	assert.deepEqual(f.requests[1], f.requests[2]);
	assert.deepEqual(f.requests[3], f.requests[4]);
	assert.deepEqual(recovery(f.session, "retry").map((entry) => entry.data.retry), [1, 1]);
	assert.deepEqual(f.errors, []);
});

test("截断工具不执行；只续写一次，并仅执行重新生成的完整调用", async (t) => {
	const calls = [];
	const f = await fixture(t, [
		{ stopReason: "length", content: [{ type: "text", text: "保留说明" }, toolCall("partial", "残缺")] },
		{ stopReason: "toolUse", content: [toolCall("complete", "完整")] },
		{ text: "完成" },
	], { customTools: [counterTool(calls)] });
	await f.session.prompt("任务");
	assert.deepEqual(calls, ["完整"]);
	assert.equal(f.requests.length, 3);
	assert.ok(f.requests[1].some((message) => message.role === "assistant" && message.content[0].text === "保留说明"));
	assert.ok(f.requests[1].some((message) => message.role === "toolResult" && message.toolCallId === "partial" && message.isError));
	assert.equal(recovery(f.session, "continue").length, 1);
	assert.equal(recovery(f.session, "retry").length, 0);
	assert.deepEqual(f.errors, []);
});

test("规则变化隔离旧计数，规范化等价规则不重置", async (t) => {
	let f;
	f = await fixture(t, (n) => {
		if (n === 2) writeFileSync(f.configPath, JSON.stringify({ rules: [{ mode: "contains", pattern: "retry-me" }, { mode: "contains", pattern: "new" }] }));
		if (n === 3) writeFileSync(f.configPath, JSON.stringify({ rules: [{ mode: "contains", pattern: "new" }, { mode: "contains", pattern: "retry-me" }, { mode: "contains", pattern: "new" }] }));
		return n <= 3 ? { stopReason: "error", errorMessage: "retry-me" } : { text: "完成" };
	});
	await f.session.prompt("任务");
	assert.deepEqual(recovery(f.session, "retry").map((entry) => entry.data.retry), [1, 1, 2]);
	assert.deepEqual(f.errors, []);
});

test("用户排队输入优先，长度截断不会另塞继续请求", async (t) => {
	let f;
	f = await fixture(t, async (n) => {
		if (n === 1) {
			await f.session.followUp("改做新任务");
			return { stopReason: "length", text: "前文" };
		}
		return { text: "新任务完成" };
	});
	await f.session.prompt("任务");
	assert.equal(f.requests.length, 2);
	assert.equal(recovery(f.session, "continue").length, 0);
	assert.equal(f.requests[1].at(-1).content[0].text, "改做新任务");
	assert.deepEqual(f.errors, []);
});

test("未命中的错误仍允许 Pi 原生有限重试", async (t) => {
	const f = await fixture(t, (n) => n <= 3 ? { stopReason: "error", errorMessage: "503 unrelated" } : { text: "完成" },
		{ rules: [], settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
	await f.session.prompt("任务");
	assert.equal(f.requests.length, 3);
	assert.equal(recovery(f.session, "retry").length, 0);
	assert.deepEqual(f.errors, []);
});

test("修改规则不取消已排定等待，只在后续失败时生效", async (t) => {
	const f = await fixture(t, [
		{ stopReason: "error", errorMessage: "retry-me", headers: { "retry-after-ms": "50" } },
		{ stopReason: "error", errorMessage: "retry-me" },
	], { realTimers: true });
	const scheduled = new Promise((resolve) => {
		f.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "custom" &&
				event.entry.customType === RECOVERY_ENTRY && event.entry.data.kind === "retry") resolve();
		});
	});
	const run = f.session.prompt("任务");
	await scheduled;
	const scheduledAt = Date.now();
	await new Promise(setImmediate);
	writeFileSync(f.configPath, '{"rules":[]}');
	await run;
	assert.ok(Date.now() - scheduledAt >= 40, "应真正等待服务端指定的 50ms，而不是遗留的定时器替身");
	assert.equal(f.requests.length, 2);
	assert.equal(recovery(f.session, "retry").length, 1);
	assert.equal(recovery(f.session, "retry-started").length, 1);
	assert.deepEqual(f.errors, []);
});

test("标准 dispose 取消正在等待的重试，卸载后没有定时唤醒", async (t) => {
	const f = await fixture(t, [{ stopReason: "error", errorMessage: "retry-me", headers: { "retry-after": "3600" } }], { realTimers: true });
	const scheduled = new Promise((resolve) => {
		f.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "custom" &&
				event.entry.customType === RECOVERY_ENTRY && event.entry.data.kind === "retry") resolve();
		});
	});
	const run = f.session.prompt("任务");
	await scheduled;
	await new Promise(setImmediate);
	f.session.dispose();
	await run;
	assert.equal(f.requests.length, 1);
	assert.equal(recovery(f.session, "retry-started").length, 0);
	// 主动 dispose 在宿主取消消息持久化前解绑订阅；下方无本扩展的对照测试单独复现该报错。
	assert.deepEqual(f.errors, [{ extensionPath: "<boundary>", event: "turn_end", error: "turn_end could not resolve the persisted assistant entry ID" }]);
});

test("宿主对照：不加载错误重试扩展，活动 dispose 仍出现相同边界报错", async (t) => {
	let started;
	const active = new Promise((resolve) => { started = resolve; });
	const f = await fixture(t, [], {
		realTimers: true, skipRecovery: true,
		extensionFactories: [(pi) => {
			pi.on("turn_end", () => {});
			pi.on("agent_start", async (_event, ctx) => {
				const signal = ctx.signal;
				started();
				await waitForRetry(3600000, signal);
			});
		}],
	});
	const run = f.session.prompt("任务");
	await active;
	f.session.dispose();
	await run;
	assert.equal(f.requests.length, 0);
	assert.deepEqual(f.errors, [{ extensionPath: "<boundary>", event: "turn_end", error: "turn_end could not resolve the persisted assistant entry ID" }]);
});

test("真正通过 Pi 的 TypeScript 文件加载器加载扩展", async (t) => {
	const f = await fixture(t, [{ stopReason: "error", errorMessage: "retry-me" }, { stopReason: "length", text: "前文" }, { text: "完成" }], { fileExtension: true });
	await f.session.prompt("任务");
	assert.equal(f.requests.length, 3);
	assert.equal(recovery(f.session, "retry").length, 1);
	assert.equal(recovery(f.session, "continue").length, 1);
	assert.deepEqual(f.errors, []);
});

test("按本地包清单加载已注册扩展", async (t) => {
	const f = await fixture(t, [{ stopReason: "error", errorMessage: "retry-me" }, { text: "完成" }], { packageExtension: true });
	await f.session.prompt("任务");
	assert.equal(f.requests.length, 2);
	assert.equal(recovery(f.session, "retry").length, 1);
	assert.deepEqual(f.errors, []);
});
