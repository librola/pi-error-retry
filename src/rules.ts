import { Script, createContext } from "node:vm";

export type RetryRule =
	| { mode: "contains"; pattern: string }
	| { mode: "regex"; pattern: string; flags?: string };

export interface RetryConfig {
	rules: RetryRule[];
}

export const DEFAULT_RULES: readonly RetryRule[] = [
	{
		mode: "contains",
		pattern:
			"Requests have exceeded the throughput limit on your Provisioned-Managed deployment. If you continue to exceed your limit, consider increasing the number of provisioned throughput units deployed.",
	},
	{
		mode: "contains",
		pattern: "Your request exceeds the maximum size allowed by your deployment's quota.",
	},
];

export function validateConfig(value: unknown): RetryConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("配置必须是 JSON 对象");
	}
	const object = value as Record<string, unknown>;
	if (Object.keys(object).some((key) => key !== "rules")) throw new Error("配置仅接受 rules 字段");
	if (object.rules === undefined) return { rules: DEFAULT_RULES.map((rule) => ({ ...rule })) };
	if (!Array.isArray(object.rules)) throw new Error("rules 必须是数组");
	const rules = object.rules.map((value: unknown, index): RetryRule => {
		const prefix = `规则 ${index + 1}：`;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${prefix}必须是对象`);
		const rule = value as Record<string, unknown>;
		if (Object.keys(rule).some((key) => !["mode", "pattern", "flags"].includes(key))) {
			throw new Error(`${prefix}仅接受 mode、pattern、flags`);
		}
		if (typeof rule.pattern !== "string" || !/\S/.test(rule.pattern)) {
			throw new Error(`${prefix}pattern 不能为空`);
		}
		if (rule.mode === "contains") {
			if (rule.flags !== undefined) throw new Error(`${prefix}contains 不接受 flags`);
			return { mode: "contains", pattern: rule.pattern };
		}
		if (rule.mode !== "regex") throw new Error(`${prefix}mode 必须是 contains 或 regex`);
		if (rule.flags !== undefined && (typeof rule.flags !== "string" || !/^[imsu]*$/.test(rule.flags))) {
			throw new Error(`${prefix}flags 仅支持 i/m/s/u`);
		}
		const flags = rule.flags as string | undefined;
		try {
			new RegExp(rule.pattern, flags);
		} catch (error) {
			throw new Error(`${prefix}${error instanceof Error ? error.message : String(error)}`);
		}
		return { mode: "regex", pattern: rule.pattern, ...(flags === undefined ? {} : { flags }) };
	});
	return { rules };
}

export function policyKey(rules: RetryRule[]): string {
	// OR 规则的排序、重复项和正则标志顺序不改变策略；有效空白不能丢失。
	const normalized = rules.map((rule) => JSON.stringify(rule.mode === "contains"
		? rule
		: { mode: rule.mode, pattern: rule.pattern, flags: new RegExp(rule.pattern, rule.flags).flags }));
	return JSON.stringify(["pi-error-retry", 1, [...new Set(normalized)].sort()]);
}

const matchScript = new Script(`rules.some(rule => rule.mode === "contains"
	? message.includes(rule.pattern)
	: new RegExp(rule.pattern, rule.flags).test(message))`);

export function matchesRules(rules: RetryRule[], message: string): boolean {
	// 整组规则共享 25ms 预算；异常由调用方交回 Pi，不把超时当成命中。
	return matchScript.runInContext(createContext({ rules, message }), { timeout: 25 }) === true;
}

export function retryDelay(retry: number, providerDelay?: number, random = Math.random): number {
	if (providerDelay !== undefined && Number.isFinite(providerDelay) && providerDelay > 0) return providerDelay;
	const base = Math.min(1000 * 2 ** Math.min(retry - 1, 5), 30000);
	return Math.min(30000, Math.round(base * (0.9 + random() * 0.2)));
}

export function providerRetryAfter(headers: Record<string, string>, now = Date.now()): number | undefined {
	const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const millis = normalized["retry-after-ms"];
	if (millis !== undefined && millis.trim() && Number.isFinite(Number(millis)) && Number(millis) > 0) {
		return Number(millis);
	}
	const value = normalized["retry-after"];
	if (!value?.trim()) return undefined;
	const seconds = Number(value);
	const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
	return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

export async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
	let remaining = delayMs;
	while (remaining > 0) {
		if (signal.aborted) return false;
		// 服务端长等待不截短，分段避免 Node 定时器溢出。
		const slice = Math.min(remaining, 2147483647);
		const completed = await new Promise<boolean>((resolve) => {
			const finish = (result: boolean) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				resolve(result);
			};
			const abort = () => finish(false);
			const timer = setTimeout(() => finish(true), slice);
			signal.addEventListener("abort", abort, { once: true });
		});
		if (!completed) return false;
		remaining -= slice;
	}
	return !signal.aborted;
}
