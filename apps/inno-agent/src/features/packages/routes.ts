import type { RuntimePaths } from "../../runtime.js";
import { createGeneratedPreset, type GeneratedPresetResult } from "../../presets/preset-store.js";
import { generateAgentPreset, importAgentPresetZip, type AgentPresetDocument } from "./package-service.js";
import { logger } from "../../logger.js";

/*
 * Agent Builder 路由处理器（移植自 EduClaw-js 的 features/packages/routes.ts）。
 *
 * inno-agent 的 HTTP 服务是裸 http.createServer（无 express/router），
 * 所以这里只导出纯函数，由 server.ts 的内联路由调用：
 * - POST /api/presets/generate → handleGeneratePreset
 * - POST /api/presets/import   → handleImportPreset
 *
 * 参考实现中的版本管理 / 优化 / 诊断路由不在 LiteAgentBuilder 的能力面内，
 * 暂不移植。
 */

export interface GeneratePresetBody {
	instruction: string;
	documents: AgentPresetDocument[];
}

/** 归一化请求体（宽松解析，缺字段用空值兜底）。 */
export function parseGeneratePresetBody(body: Record<string, unknown>): GeneratePresetBody {
	const instruction = typeof body.instruction === "string" ? body.instruction : "";
	const documents = Array.isArray(body.documents)
		? body.documents.map((doc, index) => {
			const value = doc && typeof doc === "object" ? doc as Record<string, unknown> : {};
			return {
				name: typeof value.name === "string" ? value.name : `Document ${index + 1}`,
				content: typeof value.content === "string" ? value.content : "",
			};
		})
		: [];
	return { instruction, documents };
}

/**
 * 生成 agent preset：优先走 LLM 三段式流水线；模型不可用或中途失败时
 * 回退到 preset-store 的模板拼接生成，保证端点总能给出可用的结果。
 */
export async function handleGeneratePreset(
	paths: RuntimePaths,
	body: Record<string, unknown>,
	onPhase?: (label: string) => void,
): Promise<GeneratedPresetResult> {
	const input = parseGeneratePresetBody(body);
	try {
		return await generateAgentPreset(paths, input, onPhase);
	} catch (err) {
		logger.warn({ err }, "LLM agent preset generation failed; falling back to template preset");
		return createGeneratedPreset(paths, input);
	}
}

/** 导入 agent 包 ZIP（JSON base64 载荷，与 /api/skills/upload 同风格）。 */
export function handleImportPreset(paths: RuntimePaths, body: Record<string, unknown>): GeneratedPresetResult {
	const fileName = typeof body.fileName === "string" ? body.fileName : "";
	const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
	if (!fileName || !dataBase64) {
		throw new Error("Missing fileName or dataBase64");
	}
	return importAgentPresetZip(paths, fileName, Buffer.from(dataBase64, "base64"));
}
