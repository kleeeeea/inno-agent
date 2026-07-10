import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimePaths } from "../runtime.js";
import type { WorkspaceMeta, WorkspaceRegistry } from "../workspace/workspace-registry.js";
import type { RemoteContentSource } from "../content-source/index.js";
import { mapWithConcurrency } from "../content-source/types.js";
import { logger } from "../logger.js";

// if DO_SKIP_REMOTE, don't use any remote github repo, just use inno-agent/apps/inno-agent/presets
const DO_SKIP_REMOTE = 1;
/**
 * Preset workspaces — ready-to-use templates surfaced in Simple Mode.
 *
 * Each preset is a directory containing:
 *   - `preset.json` — metadata `{ id, name, description, icon? }` (id must equal
 *     the directory name)
 *   - `agent.md`    — per-workspace instructions (injected each turn by the
 *     extension's `before_agent_start` hook)
 *   - `.skills/`    — optional per-workspace private skills (also auto-injected)
 *
 * Presets are fetched from the remote content hub (a GitHub repo or a private
 * bundle service) and materialized into a local cache under
 * `<dataDir>/preset-cache/<id>/`. Opening a preset instantiates it: a fresh
 * editable workspace is created and the preset's `agent.md` + `.skills/` are
 * copied in (excluding `preset.json`). The cache is the single source of truth
 * for instantiation, so first open requires the network but later opens (and
 * offline use) reuse the cached copy.
 */

export interface PresetMeta {
	id: string;
	name: string;
	description: string;
	icon?: string;
	category?: string;
}

export interface GeneratedPresetInput {
	instruction: string;
	documents?: Array<{ name: string; content: string }>;
}

export interface GeneratedPresetResult {
	meta: PresetMeta;
	dir: string;
}

/** Only simple, single-segment ids — blocks path traversal. */
const PRESET_ID_RE = /^[a-zA-Z0-9._-]+$/;

function isValidPresetId(id: string): boolean {
	return PRESET_ID_RE.test(id) && id !== "." && id !== "..";
}

function isIgnoredPresetEntry(name: string): boolean {
	return name === "__MACOSX" || name.startsWith(".") || name.startsWith("_");
}

function slugifyPresetId(value: string): string {
	const ascii = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return ascii || `agent-${randomUUID().slice(0, 8)}`;
}

function compactText(value: string, maxLength: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function inferGeneratedPresetName(instruction: string, documents: Array<{ name: string; content: string }>): string {
	const fromInstruction = compactText(instruction, 24);
	if (fromInstruction) return fromInstruction.includes("Agent") || fromInstruction.includes("助手") ? fromInstruction : `${fromInstruction} Agent`;
	const firstDoc = documents[0]?.name?.replace(/\.[^.]+$/, "").trim();
	return firstDoc ? `${firstDoc} Agent` : "自定义 Agent";
}

function buildGeneratedPresetAgentMd(meta: PresetMeta, instruction: string, documents: Array<{ name: string; content: string }>): string {
	const parts = [
		`# ${meta.name}`,
		"",
		`> ${meta.description}`,
		"",
		"## Role",
		"",
		`You are ${meta.name}. Help the user complete the workflow described by this preset with clear plans, concrete outputs, and careful validation.`,
		"",
		"## Source Request",
		"",
		instruction.trim() || "The user uploaded source material and asked the system to infer a useful agent workspace.",
		"",
		"## Operating Guidelines",
		"",
		"- Clarify ambiguous requirements before making irreversible changes.",
		"- Prefer concrete files, commands, examples, and checklists over vague advice.",
		"- Preserve user-provided constraints and terminology.",
		"- When source material is provided, ground answers in that material and call out assumptions.",
		"- Before finalizing work, summarize what changed and how it was verified.",
	];

	if (documents.length > 0) {
		parts.push("", "## Uploaded Reference Material", "");
		for (const [index, doc] of documents.entries()) {
			const content = doc.content.trim();
			parts.push(`### ${index + 1}. ${doc.name}`, "", content.slice(0, 6000) || "[empty]", "");
			if (content.length > 6000) parts.push("[content truncated in generated preset]", "");
		}
	}

	return `${parts.join("\n").trim()}\n`;
}

function buildGeneratedPresetReadme(meta: PresetMeta, instruction: string, documents: Array<{ name: string; content: string }>): string {
	return `${[
		`# ${meta.name}`,
		"",
		meta.description,
		"",
		"## How to Use",
		"",
		"Open this preset from Simple Mode and start with a concrete task. The workspace includes `agent.md`, which defines the agent behavior for this template.",
		"",
		"## Original Builder Request",
		"",
		instruction.trim() || "Generated from uploaded material.",
		"",
		"## Included Material",
		"",
		documents.length > 0 ? documents.map((doc) => `- ${doc.name}`).join("\n") : "- None",
	].join("\n").trim()}\n`;
}

export function createGeneratedPreset(paths: RuntimePaths, input: GeneratedPresetInput): GeneratedPresetResult {
	const instruction = String(input.instruction || "").trim();
	const documents = Array.isArray(input.documents)
		? input.documents.map((doc, index) => ({
			name: compactText(String(doc?.name || `Document ${index + 1}`), 120) || `Document ${index + 1}`,
			content: String(doc?.content || "").slice(0, 80_000),
		}))
		: [];
	if (!instruction && documents.length === 0) {
		throw new Error("Instruction or documents are required");
	}

	const name = inferGeneratedPresetName(instruction, documents);
	const descriptionSource = instruction || documents.map((doc) => doc.content).join("\n");
	const description = compactText(descriptionSource, 140) || "由 Agent Builder 生成的自定义工作区模板。";
	const baseId = slugifyPresetId(name);
	const root = presetsDir(paths);
	mkdirSync(root, { recursive: true });
	let id = baseId;
	let suffix = 2;
	while (existsSync(join(root, id))) {
		id = `${baseId}-${suffix}`;
		suffix += 1;
	}

	const meta: PresetMeta = {
		id,
		name,
		description,
		category: "generated",
		icon: "sparkles",
	};
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "preset.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
	writeFileSync(join(dir, "agent.md"), buildGeneratedPresetAgentMd(meta, instruction, documents), "utf-8");
	writeFileSync(join(dir, "README.md"), buildGeneratedPresetReadme(meta, instruction, documents), "utf-8");
	logger.info({ presetId: id, dir }, "created generated preset");
	return { meta, dir };
}

/** Absolute path to the local preset cache directory. */
export function presetsDir(paths: RuntimePaths): string {
	return paths.presetCacheDir;
}

/**
 * Absolute path to the presets bundled with the app (shipped under the compiled
 * code root). Used as an offline fallback / seed when the remote hub has no
 * presets yet, so the app still shows its built-in templates.
 */
export function bundledPresetsDir(paths: RuntimePaths): string {
	return join(paths.codeDir, "presets");
}

function parsePresetMeta(rawText: string, id: string): PresetMeta | null {
	try {
		const raw = JSON.parse(rawText) as Partial<PresetMeta>;
		const metaId = (raw.id ?? "").trim();
		// The declared id must match the directory name to keep instantiation safe.
		if (metaId !== id) {
			logger.warn({ metaId, id }, "preset.json id does not match directory name; skipping");
			return null;
		}
		const name = (raw.name ?? "").trim();
		if (!name) {
			logger.warn({ id }, "preset.json missing name; skipping");
			return null;
		}
		return {
			id,
			name,
			description: (raw.description ?? "").trim(),
			icon: raw.icon?.trim() || undefined,
			category: raw.category?.trim() || undefined,
		};
	} catch (err) {
		logger.warn({ err, id }, "failed to parse preset.json; skipping");
		return null;
	}
}

function readPresetMeta(dir: string, id: string): PresetMeta | null {
	const metaPath = join(dir, "preset.json");
	if (!existsSync(metaPath)) return null;
	return parsePresetMeta(readFileSync(metaPath, "utf-8"), id);
}

function resolvePresetScanRoot(root: string, subfolder?: string): string | null {
	if (!subfolder?.trim()) return root;
	const parts = subfolder.split(/[\\/]+/).filter(Boolean);
	if (parts.length === 0) return root;
	if (parts.some((part) => !isValidPresetId(part) || isIgnoredPresetEntry(part))) return null;
	const resolved = resolve(root, ...parts);
	const rel = relative(resolve(root), resolved);
	if (rel.startsWith("..") || resolve(rel) === rel) return null;
	return resolved;
}

function collectPresetDirs(root: string, subfolder?: string): Array<{ dir: string; id: string }> {
	const scanRoot = resolvePresetScanRoot(root, subfolder);
	const found: Array<{ dir: string; id: string }> = [];
	if (!scanRoot || !existsSync(scanRoot)) return found;

	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (isIgnoredPresetEntry(entry.name)) continue;
			const child = join(dir, entry.name);
			if (isValidPresetId(entry.name) && existsSync(join(child, "preset.json"))) {
				found.push({ dir: child, id: entry.name });
				continue;
			}
			visit(child);
		}
	};

	visit(scanRoot);
	return found;
}

function findBundledPresetDir(paths: RuntimePaths, id: string): string | null {
	for (const { dir } of collectPresetDirs(bundledPresetsDir(paths))) {
		if (readPresetMeta(dir, id)) return dir;
	}
	return null;
}

/**
 * List presets available offline: the union of the local cache and the presets
 * bundled with the app (cache wins on id collision). Best-effort — invalid
 * presets are skipped. Used as a fallback when the remote hub is unreachable.
 */
export function listPresets(paths: RuntimePaths, subfolder?: string): PresetMeta[] {
	const byId = new Map<string, PresetMeta>();
	// Bundled first, then cache overrides (a downloaded preset is fresher).
	for (const root of [bundledPresetsDir(paths), presetsDir(paths)]) {
		for (const { dir, id } of collectPresetDirs(root, subfolder)) {
			const meta = readPresetMeta(dir, id);
			if (meta) byId.set(meta.id, meta);
		}
	}
	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}


/**
 * List presets available from the remote content hub. For each preset, the
 * metadata comes from inline source meta (bundle service) or by reading its
 * `preset.json` (GitHub). Best-effort: presets with invalid metadata are
 * skipped.
 */
export async function listRemotePresets(source: RemoteContentSource, forceRefresh = false): Promise<PresetMeta[]> {
	// DO_SKIP_REMOTE：不访问远端目录，返回空列表——server 端对空结果会自动回退到
	// listPresets(paths)（随包 presets ∪ 本地缓存），效果即"只用 apps/inno-agent/presets"。
	if (DO_SKIP_REMOTE) return [];
	const items = await source.listItems("presets", { forceRefresh });
	// GitHub reads one preset.json per item over raw.githubusercontent.com, which
	// throttles bursts (429). Cap concurrency so a large catalog doesn't trip the
	// limit and silently drop presets from the list.
	const metas = await mapWithConcurrency(items, 5, async (item): Promise<PresetMeta | null> => {
		// Bundle service ships metadata inline in index.json.
		const m = item.meta;
		if (m && typeof m.name === "string" && m.name.trim()) {
			return {
				id: item.name,
				name: m.name.trim(),
				description: typeof m.description === "string" ? m.description.trim() : "",
				icon: typeof m.icon === "string" && m.icon.trim() ? m.icon.trim() : undefined,
				category: typeof m.category === "string" && m.category.trim() ? m.category.trim() : undefined,
			};
		}
		// GitHub: read the preset.json file.
		const text = await source.readItemTextFile("presets", item.name, "preset.json");
		if (!text) {
			logger.warn({ id: item.name }, "remote preset missing preset.json; skipping");
			return null;
		}
		return parsePresetMeta(text, item.name);
	});
	return metas.filter((m): m is PresetMeta => m !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ensure a preset's files are present in the local cache, downloading them from
 * the content source on first use (or when `forceRefresh` is set). Returns the
 * absolute cache directory. Throws if the preset is unknown / invalid.
 */
export async function ensurePresetCached(
	paths: RuntimePaths,
	source: RemoteContentSource,
	presetId: string,
	forceRefresh = false,
): Promise<string> {
	const id = presetId.trim();
	if (!isValidPresetId(id)) {
		throw new Error(`Invalid preset id: ${presetId}`);
	}
	const root = presetsDir(paths);
	const cacheDir = join(root, id);
	const cachedMetaExists = existsSync(join(cacheDir, "preset.json"));
	// DO_SKIP_REMOTE：完全不碰远端。随包目录里有就每次重新播种缓存（这样直接改
	// apps/inno-agent/presets 里的文件无需清缓存即可生效），没有再退回已有缓存。
	if (DO_SKIP_REMOTE) {
		const bundledDir = findBundledPresetDir(paths, id);
		if (bundledDir) {
			copyPresetContents(bundledDir, cacheDir);
			// copyPresetContents skips preset.json, so copy it explicitly.
			writeFileSync(join(cacheDir, "preset.json"), readFileSync(join(bundledDir, "preset.json")));
			logger.info({ presetId: id, cacheDir }, "seeded preset from bundled copy (DO_SKIP_REMOTE)");
			return cacheDir;
		}
		if (cachedMetaExists) return cacheDir;
		throw new Error(`Preset "${id}" not found in bundled presets (DO_SKIP_REMOTE)`);
	}
	if (cachedMetaExists && !forceRefresh) {
		return cacheDir;
	}
	// Try the remote hub first.
	try {
		await source.downloadItem("presets", id, cacheDir);
		if (!existsSync(join(cacheDir, "preset.json"))) {
			throw new Error(`Preset "${id}" did not provide a preset.json`);
		}
		logger.info({ presetId: id, cacheDir }, "cached remote preset");
		return cacheDir;
	} catch (err) {
		// Fall back to a preset bundled with the app, if one exists. Lets the
		// shipped templates work offline / before the hub has them.
		const bundledDir = findBundledPresetDir(paths, id);
		if (bundledDir) {
			copyPresetContents(bundledDir, cacheDir);
			// copyPresetContents skips preset.json, so copy it explicitly.
			writeFileSync(join(cacheDir, "preset.json"), readFileSync(join(bundledDir, "preset.json")));
			logger.info({ presetId: id, cacheDir }, "seeded preset from bundled copy (remote unavailable)");
			return cacheDir;
		}
		throw err;
	}
}

/**
 * Recursively copy a preset's content into a destination workspace directory.
 * Uses file-by-file read/write (not cpSync) for robustness against
 * asar-unpacked paths in Electron packaged builds. Skips `preset.json`.
 */
function copyPresetContents(sourceDir: string, targetDir: string): void {
	if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (entry.name === "__MACOSX" || entry.name === ".DS_Store" || entry.name === "preset.json") continue;
		const source = join(sourceDir, entry.name);
		const target = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			copyPresetContents(source, target);
		} else if (entry.isFile()) {
			writeFileSync(target, readFileSync(source));
		}
	}
}

/**
 * Open a preset: return its stable dedicated workspace (creating + seeding it
 * with the preset's files on first open). Repeatedly opening the same preset
 * reuses one workspace, so every conversation for that task is archived
 * together. The preset must already be present in the local cache (call
 * `ensurePresetCached` first). Throws on an unknown/invalid preset.
 */
export function instantiatePreset(
	paths: RuntimePaths,
	registry: WorkspaceRegistry,
	presetId: string,
): WorkspaceMeta {
	const id = presetId.trim();
	if (!isValidPresetId(id)) {
		throw new Error(`Invalid preset id: ${presetId}`);
	}
	const root = presetsDir(paths);
	const srcDir = join(root, id);
	// Confirm the resolved dir stays under the cache root (defence in depth).
	const rel = relative(root, srcDir);
	if (rel.startsWith("..") || !existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
		throw new Error(`Preset not found in cache: ${presetId}`);
	}
	const meta = readPresetMeta(srcDir, id);
	if (!meta) {
		throw new Error(`Preset metadata invalid: ${presetId}`);
	}

	const { ws, created } = registry.ensurePresetWorkspace(id, meta.name);
	const destDir = registry.resolveWorkspaceDir(ws.id);
	if (!destDir) {
		throw new Error(`Failed to resolve workspace dir for ${ws.id}`);
	}
	// Only seed the preset's files on first creation so later opens don't clobber
	// the user's edits / conversation artifacts in that workspace.
	if (created) {
		copyPresetContents(srcDir, destDir);
		logger.info({ presetId: id, workspaceId: ws.id }, "instantiated preset workspace");
	} else {
		logger.info({ presetId: id, workspaceId: ws.id }, "reused existing preset workspace");
	}
	return ws;
}
