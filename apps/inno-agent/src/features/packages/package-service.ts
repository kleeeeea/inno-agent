import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RuntimePaths } from "../../runtime.js";
import { presetsDir, type GeneratedPresetResult, type PresetMeta } from "../../presets/preset-store.js";
import { completePromptOnce } from "../../agent/pi-runner.js";
import { logger } from "../../logger.js";

/*
 * Agent Builder 后端服务（移植自 EduClaw-js educlaw-server/src/features/packages）。
 *
 * 与参考实现的对应关系：
 * - 参考里的 "package"（sqlite 存储的 agent 包）在 inno-agent 里落地为一个
 *   preset 目录：preset.json + agent.md + rubric.md + .skills/<dir>/SKILL.md，
 *   放进 preset-cache，Simple Mode 一键开场即可用。
 * - LLM 调用从 llm-service 换成 pi-runner 的 completePromptOnce（直连当前
 *   配置的模型，不占用聊天队列）；失败时抛错，由上层回退到模板生成。
 * - 三段式生成流水线（元数据 JSON → agent.md / rubric.md → 逐个 SKILL.md）
 *   与提示词保持与参考实现一致。
 */

export interface AgentPresetDocument {
	name: string;
	content: string;
}

export interface AgentPresetGenerateInput {
	instruction: string;
	documents?: AgentPresetDocument[];
}

interface PresetBaseGenerationResult {
	name: string;
	description: string;
	skills: Array<{
		dirName: string;
		name: string;
		description: string;
	}>;
}

interface GeneratedSkill {
	dirName: string;
	name: string;
	description: string;
	skillMd: string;
}

const MAX_BASE_DOCUMENT_CHARS = 12_000;
const MAX_SKILL_DOCUMENT_CHARS = 8_000;
const MAX_GENERATED_SKILLS = 2;

/* ── 小工具（与参考实现一致） ── */

function slugify(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || `skill-${Math.random().toString(36).slice(2, 8)}`;
}

function compactText(value: string, maxLength: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function buildDocumentContext(
	documents?: AgentPresetDocument[],
	maxChars = MAX_BASE_DOCUMENT_CHARS,
): string {
	if (!documents || documents.length === 0) return "";

	const parts = ["", "Uploaded documents:"];
	let remaining = maxChars;

	for (let index = 0; index < documents.length; index += 1) {
		const document = documents[index];
		const name = String(document?.name || `Document ${index + 1}`);
		const content = String(document?.content || "");

		if (remaining <= 0) {
			parts.push(`[Document ${index + 1}: ${name}]\n[内容已因长度限制省略]`);
			continue;
		}

		const chunk = content.slice(0, remaining);
		remaining -= chunk.length;
		const truncated = chunk.length < content.length ? "\n[内容已截断以控制单次模型请求长度]" : "";
		parts.push(`[Document ${index + 1}: ${name}]\n${chunk}${truncated}`);
	}

	return parts.join("\n");
}

function sanitizeSkillDescription(description: string | undefined): string {
	return (
		(description || "用于处理该智能体的核心任务")
			.replace(/\s+/g, " ")
			.replace(/[<>]/g, "")
			.trim()
			.slice(0, 180) || "用于处理该智能体的核心任务"
	);
}

function normalizeSkillMetadata(skills: PresetBaseGenerationResult["skills"]) {
	const used = new Set<string>();
	return skills.slice(0, MAX_GENERATED_SKILLS).map((skill, index) => {
		const baseDirName = slugify(skill.dirName || skill.name || `skill-${index + 1}`);
		let dirName = baseDirName;
		let suffix = 2;
		while (used.has(dirName)) {
			dirName = `${baseDirName}-${suffix}`;
			suffix += 1;
		}
		used.add(dirName);

		return {
			dirName,
			name: (skill.name || `技能 ${index + 1}`).trim(),
			description: sanitizeSkillDescription(skill.description),
		};
	});
}

function stripMarkdownFence(value: string): string {
	const trimmed = value.trim();
	const match = trimmed.match(/^```(?:markdown|md|json)?\s*\n([\s\S]*?)\n```\s*$/i);
	return (match ? match[1] : trimmed).trim();
}

function normalizeSkillMdFrontmatter(skillMd: string, dirName: string, description: string): string {
	const trimmed = stripMarkdownFence(skillMd);
	const safeDescription = sanitizeSkillDescription(description);
	const frontmatter = `---\nname: ${dirName}\ndescription: ${safeDescription}\n---`;
	const match = trimmed.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
	const body = match ? trimmed.slice(match[0].length).trimStart() : trimmed;
	return `${frontmatter}\n\n${body}`.trim();
}

/* ── LLM 提示词（与参考实现一致） ── */

function getBaseOutputSchemaPrompt(): string {
	return [
		"## 输出 JSON 结构",
		"返回一个严格 JSON 对象，不要 Markdown 代码块，不要解释。",
		"{",
		"  \"name\": \"智能体名称\",",
		"  \"description\": \"智能体一句话描述\",",
		"  \"skills\": [",
		"    {",
		"      \"dirName\": \"kebab-case-dir-name\",",
		"      \"name\": \"技能显示名称\",",
		"      \"description\": \"一句话说明该 skill 做什么，以及什么时候使用\"",
		"    }",
		"  ]",
		"}",
		"",
		"要求：",
		"1. JSON 只包含 name、description、skills",
		"2. skills 最多 2 个，选择最能支撑该智能体工作的核心技能",
		"3. dirName 必须是小写英文 kebab-case",
		"4. description 必须包含'当/如果/用于/遇到/针对'等触发词",
		"5. 不要在本步骤生成 agent.md、rubric.md 或 SKILL.md",
	].join("\n");
}

function getCompactSkillTemplatePrompt(): string {
	return [
		"返回完整 SKILL.md 的 Markdown 文本，不要 JSON，不要 Markdown 代码块。",
		"SKILL.md 必须包含：",
		"---",
		"name: <dirName>",
		"description: <一句话说明该 skill 做什么，以及什么时候使用，必须包含触发词如'当/如果/用于/遇到/针对'>",
		"---",
		"# <Skill 显示名称>",
		"## When to use",
		"## When not to use",
		"## Instructions",
		"## Workflow",
		"## Output Format",
		"## Examples",
		"## Common Issues",
		"",
		"要求：",
		"- 内容要精炼，每个章节 2-5 条即可",
		"- frontmatter name 必须等于 dirName",
		"- When to use 只写该 skill 自己负责的触发场景",
		"- When not to use 写清楚应交给其他 skill、普通问答、或安全转介的场景",
		"- Output Format 必须给出固定模板字段，例如：场景判断、处理方案、可用话术、风险提示、后续评估",
		"- 只返回 SKILL.md 文件内容本身，不要解释",
	].join("\n");
}

function createFallbackBase(
	instruction: string,
	documents?: AgentPresetDocument[],
): PresetBaseGenerationResult {
	const firstDocumentName = documents?.[0]?.name?.replace(/\.[^.]+$/, "").trim();
	const source = instruction.trim() || documents?.map((document) => document.content).join("\n").trim() || "";
	const compact = source.replace(/\s+/g, " ").slice(0, 28).trim();
	const name = firstDocumentName || (compact ? `${compact}助手` : "智能体助手");
	const description = compact
		? `用于根据“${compact}”相关需求完成分析、生成与答疑任务。`
		: "用于根据用户需求和上传资料完成分析、生成与答疑任务。";

	return {
		name,
		description,
		skills: [
			{
				dirName: "core-task",
				name: "核心任务处理",
				description: "用于当用户提出核心任务时，分析需求并生成结构化、高质量的回答。",
			},
			{
				dirName: documents?.length ? "document-grounding" : "quality-review",
				name: documents?.length ? "资料理解与引用" : "质量检查",
				description: documents?.length
					? "用于遇到上传资料时，提取关键信息并基于资料完成回答。"
					: "用于在输出前检查内容的准确性、完整性和表达质量。",
			},
		],
	};
}

function normalizeBaseMetadataJson(
	parsed: Partial<PresetBaseGenerationResult>,
	fallback: PresetBaseGenerationResult,
): PresetBaseGenerationResult {
	return {
		name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : fallback.name,
		description: typeof parsed.description === "string" && parsed.description.trim() ? parsed.description : fallback.description,
		skills: Array.isArray(parsed.skills) && parsed.skills.length > 0
			? parsed.skills.map((skill, index) => ({
				dirName: typeof skill?.dirName === "string" ? skill.dirName : `skill-${index + 1}`,
				name: typeof skill?.name === "string" ? skill.name : `技能 ${index + 1}`,
				description: typeof skill?.description === "string" ? skill.description : `用于当用户需要技能 ${index + 1} 时提供支持。`,
			}))
			: fallback.skills,
	};
}

/* ── LLM 调用（inno 适配层：completePromptOnce 直连当前模型） ── */

async function generateText(systemPrompt: string, userPrompt: string, maxTokens: number, timeoutMs: number): Promise<string> {
	// completePromptOnce 只接受单条 user 消息，把 system 约束拼在最前面
	const text = await completePromptOnce(`${systemPrompt}\n\n${userPrompt}`, maxTokens, timeoutMs);
	if (!text.trim()) {
		throw new Error("模型未返回内容（未配置模型或调用失败）");
	}
	return text;
}

function parseJsonLoose<T>(raw: string): T {
	const stripped = stripMarkdownFence(raw);
	try {
		return JSON.parse(stripped) as T;
	} catch {
		// 模型偶尔在 JSON 前后加说明文字——截取第一个 { 到最后一个 } 再试一次
		const start = stripped.indexOf("{");
		const end = stripped.lastIndexOf("}");
		if (start >= 0 && end > start) {
			return JSON.parse(stripped.slice(start, end + 1)) as T;
		}
		throw new Error("模型返回的元数据不是合法 JSON");
	}
}

/* ── preset 目录写入 ── */

function allocatePresetDir(paths: RuntimePaths, name: string): { id: string; dir: string } {
	const ascii = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const baseId = ascii || `agent-${randomUUID().slice(0, 8)}`;
	const root = presetsDir(paths);
	mkdirSync(root, { recursive: true });
	let id = baseId;
	let suffix = 2;
	while (existsSync(join(root, id))) {
		id = `${baseId}-${suffix}`;
		suffix += 1;
	}
	return { id, dir: join(root, id) };
}

interface AgentPresetContent {
	name: string;
	description: string;
	agentMd: string;
	rubricMd?: string;
	skills: GeneratedSkill[];
}

/** 把生成/导入的 agent 包内容写成一个 preset 目录（含 .skills/ 私有技能）。 */
export function writeAgentPreset(paths: RuntimePaths, content: AgentPresetContent): GeneratedPresetResult {
	const name = compactText(content.name, 60) || "自定义 Agent";
	const description = compactText(content.description, 140) || "由 Agent Builder 生成的自定义工作区模板。";
	const { id, dir } = allocatePresetDir(paths, name);
	const meta: PresetMeta = { id, name, description, category: "generated", icon: "sparkles" };

	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "preset.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
	writeFileSync(join(dir, "agent.md"), `${content.agentMd.trim()}\n`, "utf-8");
	if (content.rubricMd?.trim()) {
		writeFileSync(join(dir, "rubric.md"), `${content.rubricMd.trim()}\n`, "utf-8");
	}
	for (const skill of content.skills) {
		const skillDir = join(dir, ".skills", slugify(skill.dirName || skill.name));
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), `${skill.skillMd.trim()}\n`, "utf-8");
	}
	logger.info({ presetId: id, dir, skillCount: content.skills.length }, "agent preset written");
	return { meta, dir };
}

/* ── 生成流水线（与参考实现的 generatePackage 同构） ── */

export async function generateAgentPreset(
	paths: RuntimePaths,
	input: AgentPresetGenerateInput,
	onPhase?: (label: string) => void,
): Promise<GeneratedPresetResult> {
	const instruction = String(input.instruction || "").trim();
	const documents = (input.documents ?? []).map((doc, index) => ({
		name: compactText(String(doc?.name || `Document ${index + 1}`), 120) || `Document ${index + 1}`,
		content: String(doc?.content || "").slice(0, 80_000),
	}));
	if (!instruction && documents.length === 0) {
		throw new Error("Instruction or documents are required");
	}

	const startedAt = Date.now();
	const docParts = buildDocumentContext(documents, MAX_BASE_DOCUMENT_CHARS);
	const skillDocParts = buildDocumentContext(documents, MAX_SKILL_DOCUMENT_CHARS);
	const hasInstruction = instruction.length > 0;

	// 第一步：紧凑的元数据 JSON（名称 / 描述 / 技能清单），失败回退到规则推断
	onPhase?.("整理需求，生成智能体元数据");
	const fallbackBase = createFallbackBase(instruction, documents);
	let base: PresetBaseGenerationResult;
	try {
		const baseRaw = await generateText(
			[
				"You are an agent-package generation assistant.",
				"Return strict JSON only.",
				"Generate only compact metadata for one reusable prompt package.",
				"Prefer Chinese content when the user instruction is Chinese.",
				"When documents are provided without explicit instructions, deeply analyze the documents to extract domain knowledge, workflows, and rules, then build the agent and skills entirely from the document content.",
				"Do not generate agent.md, rubric.md, or full SKILL.md content in this step.",
				"Do not include long Markdown content in JSON fields.",
			].join("\n"),
			hasInstruction
				? ["Create a prompt package from this instruction:", instruction, docParts, "", getBaseOutputSchemaPrompt()].join("\n")
				: [
					"Analyze the following documents and create a compact prompt package base based entirely on their content.",
					"Infer the agent's role, workflow, core skills, and evaluation criteria directly from the document content.",
					docParts,
					"",
					getBaseOutputSchemaPrompt(),
				].join("\n"),
			2000,
			60_000,
		);
		base = normalizeBaseMetadataJson(parseJsonLoose<Partial<PresetBaseGenerationResult>>(baseRaw), fallbackBase);
	} catch (err) {
		logger.warn({ err }, "agent preset base metadata failed; using structured fallback");
		base = fallbackBase;
	}
	const skillMetas = normalizeSkillMetadata(base.skills);
	logger.info({ durationMs: Date.now() - startedAt, skillCount: skillMetas.length }, "agent preset base done");

	// 第二步：agent.md（角色 / 流程 / 边界 / 技能路由表）
	onPhase?.("生成 agent.md");
	const agentMd = stripMarkdownFence(await generateText(
		[
			"You are an expert agent.md author.",
			"Return plain Markdown only.",
			"Do not wrap the answer in Markdown fences.",
			"Prefer Chinese content when the source content is Chinese.",
		].join("\n"),
		[
			"Create a complete but concise agent.md for this package.",
			"",
			`Package name: ${base.name}`,
			`Package description: ${base.description}`,
			"",
			"Core skills metadata:",
			JSON.stringify(skillMetas, null, 2),
			"",
			hasInstruction ? "User instruction:" : "Source documents:",
			hasInstruction ? instruction : docParts,
			"",
			"The agent.md should define role, workflow, boundaries, and output style.",
			"Add a concise skill routing table. For each skill, describe:",
			"- typical user request that should use this skill",
			"- requests that should be routed to another skill",
			"- high-risk cases that require safety guidance or referral before continuing",
			"Keep each skill responsibility narrow; avoid assigning the same scenario to multiple skills.",
			"Return only the Markdown file content.",
		].join("\n"),
		3500,
		180_000,
	));

	// 第三步：rubric.md（评分维度，含资料忠实度与安全转介边界）
	onPhase?.("生成 rubric.md");
	const rubricMd = stripMarkdownFence(await generateText(
		[
			"You are an evaluation rubric author.",
			"Return plain Markdown only.",
			"Do not wrap the answer in Markdown fences.",
			"Prefer Chinese content when the source content is Chinese.",
		].join("\n"),
		[
			"Create a rubric.md for this package with 3-5 scoring dimensions.",
			"The rubric must include dimensions for document fidelity and safety/referral boundaries.",
			"Document fidelity should check whether outputs stay grounded in uploaded materials and avoid unsupported invention.",
			"Safety/referral boundaries should check whether high-risk cases such as severe harm, self-harm, medical/legal crisis, or imminent danger receive appropriate escalation guidance.",
			"",
			`Package name: ${base.name}`,
			`Package description: ${base.description}`,
			"",
			"agent.md 摘要：",
			agentMd.slice(0, 1800),
			"",
			"Return only the Markdown file content.",
		].join("\n"),
		2000,
		120_000,
	));

	// 第四步：逐个生成 SKILL.md（frontmatter 强制归一化）
	const skills: GeneratedSkill[] = [];
	for (let index = 0; index < skillMetas.length; index += 1) {
		const skillMeta = skillMetas[index];
		onPhase?.(`生成技能 ${index + 1}/${skillMetas.length}：${skillMeta.name}`);
		const skillMdRaw = await generateText(
			[
				"You are a concise SKILL.md author.",
				"Return plain Markdown only.",
				"Do not wrap the answer in Markdown fences.",
				"Prefer Chinese content when the source content is Chinese.",
				"Generate only the requested SKILL.md content; do not regenerate agent.md or rubric.md.",
			].join("\n"),
			[
				"Create one compact SKILL.md for this package.",
				"",
				`Package name: ${base.name}`,
				`Package description: ${base.description}`,
				"",
				"agent.md 摘要：",
				agentMd.slice(0, 1800),
				"",
				"rubric.md 摘要：",
				rubricMd.slice(0, 1200),
				skillDocParts,
				"",
				"Skill metadata:",
				JSON.stringify(skillMeta),
				"",
				"Sibling skills metadata, used only for boundary clarity:",
				JSON.stringify(skillMetas.filter((meta) => meta.dirName !== skillMeta.dirName), null, 2),
				"",
				getCompactSkillTemplatePrompt(),
				"",
				"Keep this skill focused on its own trigger. If a request belongs to a sibling skill, say so in When not to use instead of covering that workflow here.",
			].join("\n"),
			4000,
			180_000,
		);
		skills.push({
			...skillMeta,
			skillMd: normalizeSkillMdFrontmatter(skillMdRaw || "", skillMeta.dirName, skillMeta.description),
		});
	}

	onPhase?.("保存智能体模板");
	logger.info({ durationMs: Date.now() - startedAt }, "agent preset generation done");
	return writeAgentPreset(paths, {
		name: base.name,
		description: base.description,
		agentMd,
		rubricMd,
		skills,
	});
}

/* ── zip 导入（对应参考实现的 importPackageZip，改用系统 unzip） ── */

function extractZipToTemp(fileName: string, data: Buffer): { tempRoot: string; extractDir: string } {
	const tempRoot = join(tmpdir(), `inno-preset-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const zipPath = join(tempRoot, `${basename(fileName, extname(fileName)) || "preset"}.zip`);
	const extractDir = join(tempRoot, "extract");
	mkdirSync(extractDir, { recursive: true });
	writeFileSync(zipPath, data);

	if (process.platform === "win32") {
		// Windows：用 .NET ZipFile 解压（系统无 unzip 命令）
		const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
			`[System.IO.Compression.ZipFile]::ExtractToDirectory(` +
			`'${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`;
		const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error((result.stderr || "").trim() || "无法解压 ZIP 文件");
		}
	} else {
		const result = spawnSync("/usr/bin/unzip", ["-qq", "-o", zipPath, "-d", extractDir], { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error((result.stderr || "").trim() || "无法解压 ZIP 文件");
		}
	}
	return { tempRoot, extractDir };
}

function findFileRecursive(root: string, matcher: (name: string) => boolean, depth = 0): string | null {
	if (depth > 4) return null;
	for (const entry of readdirSync(root)) {
		if (entry === "__MACOSX" || entry.startsWith(".")) continue;
		const full = join(root, entry);
		const stats = statSync(full);
		if (stats.isFile() && matcher(entry)) return full;
		if (stats.isDirectory()) {
			const found = findFileRecursive(full, matcher, depth + 1);
			if (found) return found;
		}
	}
	return null;
}

function readTextIfExists(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

/** 导入 agent 包 ZIP（兼容 EduClaw 导出格式与手工打包的 preset 目录）。 */
export function importAgentPresetZip(paths: RuntimePaths, fileName: string, data: Buffer): GeneratedPresetResult {
	const { tempRoot, extractDir } = extractZipToTemp(fileName, data);
	try {
		// 包根目录 = agent.md 所在目录（兼容 zip 里套一层顶级目录的情况）
		const agentFile = findFileRecursive(extractDir, (name) => name === "agent.md");
		if (!agentFile) {
			throw new Error("导入的 ZIP 中缺少 agent.md");
		}
		const rootDir = dirname(agentFile);

		// 名称/描述：preset.json（inno 格式）优先，其次 manifest.json（EduClaw 格式）
		let name = basename(fileName, extname(fileName)) || "导入的智能体";
		let description = "导入的智能体";
		for (const metaFile of ["preset.json", "manifest.json"]) {
			const raw = readTextIfExists(join(rootDir, metaFile));
			if (!raw) continue;
			try {
				const parsed = JSON.parse(raw) as { name?: string; description?: string };
				if (typeof parsed.name === "string" && parsed.name.trim()) name = parsed.name.trim();
				if (typeof parsed.description === "string" && parsed.description.trim()) description = parsed.description.trim();
				break;
			} catch {
				// 元数据损坏时继续用文件名兜底
			}
		}

		// 技能目录：.skills/（inno 格式）或 skills/（EduClaw 导出格式）
		const skills: GeneratedSkill[] = [];
		for (const skillsDirName of [".skills", "skills"]) {
			const skillsRoot = join(rootDir, skillsDirName);
			if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) continue;
			for (const entry of readdirSync(skillsRoot)) {
				const skillMdPath = join(skillsRoot, entry, "SKILL.md");
				if (!existsSync(skillMdPath)) continue;
				const skillMd = readFileSync(skillMdPath, "utf-8");
				const title = skillMd.split("\n").find((line) => line.startsWith("# "))?.replace(/^#\s+/, "") || entry;
				skills.push({
					dirName: entry,
					name: title,
					description: `${title} skill`,
					skillMd: normalizeSkillMdFrontmatter(skillMd, slugify(entry), `${title} skill`),
				});
			}
			if (skills.length > 0) break;
		}

		return writeAgentPreset(paths, {
			name,
			description,
			agentMd: readFileSync(agentFile, "utf-8"),
			rubricMd: readTextIfExists(join(rootDir, "rubric.md")),
			skills,
		});
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}
