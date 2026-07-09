import "./app.css";
import "./i18n/index.js";
import "./stores/theme-store.js";

import { createRoot } from "react-dom/client";
import { App } from "./react/App.js";
import { PageContainer } from "./react/PageContainer.js";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
	<PageContainer>
		<App />
	</PageContainer>,
);

console.log("[inno-web] React initialized");
