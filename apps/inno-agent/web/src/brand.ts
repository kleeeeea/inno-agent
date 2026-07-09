import { themeStore } from "./stores/theme-store.js";

/*
 * 品牌名随主题切换：Claude 皮肤下整站显示 EduAgentArena，其它主题保持 Inno Agent。
 * 组件里配合 useStoreSnapshot(themeStore, getBrandName) 使用即可随主题实时刷新。
 */

export function getBrandName(): string {
	return themeStore.current === "claude" ? "EduAgentArena" : "Inno Agent";
}

/** logo 方块里的品牌缩写 */
export function getBrandInitials(): string {
	return themeStore.current === "claude" ? "EA" : "IA";
}

// 浏览器标签页标题跟随品牌名（动态覆盖 index.html 的静态 <title>）
function syncDocumentTitle(): void {
	document.title = getBrandName();
}
syncDocumentTitle();
themeStore.on("change", syncDocumentTitle);
