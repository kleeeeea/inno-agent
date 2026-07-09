import { StrictMode, type ReactNode } from "react";

/**
 * 页面容器控件 — 应用的最外层外壳，由 main.tsx 直接挂载。
 *
 * 职责：
 * - 提供页面级容器（占满视口、背景色跟随当前主题变量），
 *   之后页面级的全局 UI（横幅、全局弹层等）都挂在这一层，不再改 main.tsx；
 * - 包住 StrictMode，让入口文件保持只做"找到 #root 并渲染"这一件事。
 *
 * 默认主题为 Claude（见 stores/theme-store.ts 的 getInitialTheme），
 * 用户在设置面板的选择仍存 localStorage("inno.theme")，优先于默认值。
 */
export function PageContainer({ children }: { children: ReactNode }) {
	return (
		<StrictMode>
			<div
				className="page-container"
				style={{ minHeight: "100vh", background: "var(--inno-background)", color: "var(--inno-text)" }}
			>
				{children}
			</div>
		</StrictMode>
	);
}
