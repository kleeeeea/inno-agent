import { apiFetch } from "./client.js";
import type { PresetMeta } from "../types/presets.js";

export interface GeneratePresetDocument {
	name: string;
	content: string;
}

/** Presets already materialized in the local cache (offline fallback). */
export async function listPresets(subfolder?: string): Promise<PresetMeta[]> {
	const params = new URLSearchParams();
	if (subfolder) params.set("subfolder", subfolder);
	const query = params.toString();
	return apiFetch<PresetMeta[]>(`/api/presets${query ? `?${query}` : ""}`);
}

/** Live preset catalog from the remote content hub (Simple Mode cards). */
export async function listRemotePresets(forceRefresh = false, subfolder?: string): Promise<PresetMeta[]> {
	const params = new URLSearchParams();
	if (forceRefresh) params.set("refresh", "1");
	if (subfolder) params.set("subfolder", subfolder);
	const query = params.toString();
	return apiFetch<PresetMeta[]>(`/api/preset-library${query ? `?${query}` : ""}`);
}

export async function generatePreset(instruction: string, documents: GeneratePresetDocument[]): Promise<PresetMeta> {
	return apiFetch<PresetMeta>("/api/presets/generate", {
		method: "POST",
		body: JSON.stringify({ instruction, documents }),
	});
}

/** 导入 agent 包 ZIP（与 skills 上传同风格的 JSON base64 载荷）。 */
export async function importPresetZip(fileName: string, dataBase64: string): Promise<PresetMeta> {
	return apiFetch<PresetMeta>("/api/presets/import", {
		method: "POST",
		body: JSON.stringify({ fileName, dataBase64 }),
	});
}
