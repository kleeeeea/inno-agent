import { apiFetch } from "./client.js";
import type { PresetMeta } from "../types/presets.js";

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
