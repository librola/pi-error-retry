import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type RetryConfig, validateConfig } from "./rules.ts";

export interface ConfigSnapshot {
	config: RetryConfig;
	// 使用文件原文检测其他窗口的保存，缺失文件与空文件必须区分。
	revision: string | null;
}

export function readConfig(path: string): ConfigSnapshot {
	let revision: string | null;
	try {
		revision = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		revision = null;
	}
	return { config: validateConfig(revision === null ? {} : JSON.parse(revision)), revision };
}

export function saveConfig(path: string, value: unknown, expectedRevision: string | null): RetryConfig {
	const config = validateConfig(value);
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("其他窗口正在保存，请稍后重试");
		throw error;
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		if (readConfig(path).revision !== expectedRevision) {
			throw new Error("规则已被其他窗口修改；草稿未保存，请读取最新配置后重新编辑");
		}
		writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
		return config;
	} finally {
		try {
			unlinkSync(temporary);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		} finally {
			closeSync(lock);
			unlinkSync(lockPath);
		}
	}
}
