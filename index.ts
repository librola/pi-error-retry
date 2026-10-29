import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { readConfig, saveConfig } from "./src/config.ts";
import { matchesRules, policyKey, providerRetryAfter, retryDelay, waitForRetry } from "./src/rules.ts";

export const RECOVERY_ENTRY = "pi-error-retry.recovery";
export const CONTINUE_MESSAGE =
	"上一条回复因单次输出长度限制被截断。请从停止处继续完成原任务，不要重述已输出内容，不要重复已完成的工具操作。如果工具调用被截断，请重新生成完整参数，仅重发尚未执行的调用。";

interface RetryRecord {
	kind: "retry";
	retryId: string;
	retry: number;
	policyKey: string;
	provider: string;
	model: string;
	messageEntryId: string;
	delayMs: number;
	errorMessage: string;
}

export function previousRetry(branch: SessionEntry[], key: string, provider: string, model: string): RetryRecord | undefined {
	// 仅重建当前分支的当前请求步骤；成功、用户新输入或续写消息均开启新步骤。
	for (const entry of [...branch].reverse()) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user" || (message.role === "assistant" && message.stopReason !== "error")) return;
		}
		if (entry.type === "custom_message") return;
		if (entry.type !== "custom" || entry.customType !== RECOVERY_ENTRY) continue;
		const record = entry.data as Partial<RetryRecord> | undefined;
		if (record?.kind !== "retry" || record.provider !== provider || record.model !== model) continue;
		if (record.policyKey !== key) return;
		if (typeof record.retry === "number" && Number.isSafeInteger(record.retry) && record.retry > 0 &&
			typeof record.retryId === "string") return record as RetryRecord;
		return;
	}
}

export function registerErrorRetry(pi: ExtensionAPI, configPath: string): void {
	let lifetime = new AbortController();
	let lastTurn: { event: TurnEndEvent; responseDelay: number | undefined } | undefined;
	let responseDelay: number | undefined;
	let pendingRetry: RetryRecord | undefined;

	pi.on("session_start", () => {
		lifetime = new AbortController();
		lastTurn = undefined;
		pendingRetry = undefined;
	});
	pi.on("session_shutdown", () => lifetime.abort());
	pi.on("before_agent_start", () => {
		// 加载扩展不会唤醒旧错误；新的用户请求也不能继承旧的排队等待。
		lastTurn = undefined;
		pendingRetry = undefined;
	});
	pi.on("turn_start", () => { responseDelay = undefined; });
	pi.on("after_provider_response", (event) => { responseDelay = providerRetryAfter(event.headers); });

	pi.on("agent_start", async (_event, ctx) => {
		const record = pendingRetry;
		pendingRetry = undefined;
		if (!record) return;
		const signal = ctx.signal;
		if (!signal || signal.aborted || lifetime.signal.aborted) return;
		const cancellation = AbortSignal.any([signal, lifetime.signal]);
		const cancel = () => {
			// 在取消事件的同步阶段清理，dispose 随后会使 ctx 失效，不能在 await 后再访问它。
			lastTurn = undefined;
			pendingRetry = undefined;
			ctx.ui.setStatus("error-retry", undefined);
			if (!signal.aborted) ctx.abort();
		};
		cancellation.addEventListener("abort", cancel, { once: true });
		ctx.ui.setStatus("error-retry", `无限重试 #${record.retry}，等待 ${(record.delayMs / 1000).toFixed(1)} 秒`);
		try {
			// 最终边界没有运行信号：把等待放到下一次 agent_start，才能被标准停止按钮取消。
			if (!await waitForRetry(record.delayMs, cancellation)) return;
			pi.appendEntry(RECOVERY_ENTRY, {
				kind: "retry-started", retryId: record.retryId, retry: record.retry,
				messageEntryId: record.messageEntryId,
			});
		} finally {
			cancellation.removeEventListener("abort", cancel);
			if (!cancellation.aborted) ctx.ui.setStatus("error-retry", undefined);
		}
	});

	pi.on("turn_end", (event, ctx) => {
		lastTurn = { event, responseDelay };
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "length" || event.outcome === "aborted" ||
			ctx.signal?.aborted || lifetime.signal.aborted || event.continue || ctx.hasPendingMessages() ||
			event.context.pendingMessages.length > 0) return;
		// length 不是错误重试：保留回复和 Pi 的截断工具失败结果，追加明确续写提示。
		// turn_end 的一次 continuation 与自然工具后续共用调度，不会额外请求两次。
		return {
			continue: true,
			entries: [
				{
					type: "custom" as const, customType: RECOVERY_ENTRY,
					data: { kind: "continue", messageEntryId: event.messageEntryId },
				},
				{
					type: "custom_message" as const, customType: "pi-error-retry.continue",
					content: CONTINUE_MESSAGE, display: true,
				},
			],
		};
	});

	pi.on("agent_before_settle", (event, ctx) => {
		const turn = lastTurn?.event;
		const message = turn?.message;
		if (!turn || message?.role !== "assistant" || message.stopReason !== "error" || event.outcome !== "error" ||
			lifetime.signal.aborted || event.continue || ctx.hasPendingMessages() ||
			event.context.pendingMessages.length > 0) return;
		// 内置有限重试与溢出恢复先行；已被其他恢复省略的失败不再接管。
		if (!event.context.contextEntries.some((entry) => entry.sourceEntry.id === turn.messageEntryId)) return;
		let key: string;
		try {
			const { config } = readConfig(configPath);
			if (!config.rules.length || !matchesRules(config.rules, message.errorMessage ?? "")) return;
			key = policyKey(config.rules);
		} catch (error) {
			ctx.ui.notify(`错误重试未接管：${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
		const previous = previousRetry(ctx.sessionManager.getBranch(), key, message.provider, message.model);
		const retry = (previous?.retry ?? 0) + 1;
		const record: RetryRecord = {
			kind: "retry", retryId: previous?.retryId ?? randomUUID(), retry, policyKey: key,
			provider: message.provider, model: message.model, messageEntryId: turn.messageEntryId,
			delayMs: retryDelay(retry, lastTurn?.responseDelay), errorMessage: message.errorMessage ?? "",
		};
		pendingRetry = record;
		// 追加省略记录而非删除历史；原失败及用量保留，模型上下文回到失败前的请求。
		// 没有“继续”或伪用户消息，因此不会从头重放已经完成的工具。
		return {
			continue: true,
			entries: [
				{ type: "context_edit" as const, targetId: turn.messageEntryId, replacement: null },
				{ type: "custom" as const, customType: RECOVERY_ENTRY, data: record },
			],
		};
	});

	pi.registerCommand("error-retry", {
		description: "查看错误重试规则；/error-retry edit 编辑规则，/error-retry stop 停止当前请求",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "stop") {
				pendingRetry = undefined;
				ctx.abort();
				return;
			}
			if (action && action !== "edit") {
				ctx.ui.notify("用法：/error-retry [edit|stop]", "warning");
				return;
			}
			try {
				const snapshot = readConfig(configPath);
				if (action !== "edit") {
					ctx.ui.notify(`错误规则：${snapshot.config.rules.length} 条（命中后无限重试）；长度截断：自动继续。配置：${configPath}`, "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(`当前模式没有编辑器，请手动编辑 ${configPath}`, "warning");
					return;
				}
				let draft = JSON.stringify(snapshot.config, null, 2);
				while (true) {
					const edited = await ctx.ui.editor("错误重试规则（JSON）；保存不会取消已排定的等待", draft);
					if (edited === undefined) return;
					draft = edited;
					try {
						const config = saveConfig(configPath, JSON.parse(draft), snapshot.revision);
						ctx.ui.notify(`已保存 ${config.rules.length} 条规则；下次错误判定自动生效`, "info");
						return;
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						// 保存失败保留草稿；发生版本冲突时不更新旧 revision，禁止覆盖他人的修改。
						const choice = await ctx.ui.select("规则尚未保存", ["继续修改草稿", "放弃草稿并读取最新配置", "取消"]);
						if (choice === "继续修改草稿") continue;
						if (choice !== "放弃草稿并读取最新配置") return;
						const latest = readConfig(configPath);
						snapshot.revision = latest.revision;
						draft = JSON.stringify(latest.config, null, 2);
					}
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

export default function (pi: ExtensionAPI): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	registerErrorRetry(pi, join(agentDir, "error-retry.json"));
}
