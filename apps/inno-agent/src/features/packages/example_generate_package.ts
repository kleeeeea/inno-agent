//
// Agent Builder 生成示例（inno-agent 版，移植自 EduClaw-js 的同名脚本）。
//
// 说明：generateAgentPreset 通过 pi-runner 的 completePromptOnce 调模型，
// 依赖服务进程里已初始化的 PI 会话；单独脱离服务跑本脚本时模型不可用，
// 会走 handleGeneratePreset 的模板回退路径，因此推荐直接调 HTTP 接口验证：
//
//   curl -X POST http://localhost:3000/api/presets/generate \
//     -H 'Content-Type: application/json' \
//     -d '{"instruction":"创建一个帮助小学班主任处理课堂突发纪律问题的助手"}'
//
// 也可以传 documents 让 AI 基于文档内容生成：
//   -d '{"instruction":"","documents":[{"name":"讲义.md","content":"..."}]}'
//
// 生成结果是 preset-cache 下的一个 preset 目录：
//   preset.json + agent.md + rubric.md + .skills/<dir>/SKILL.md
// 在 Simple Mode 的模板卡片列表里即可看到并一键开场。
//
// 直跑（走模板回退，不调模型）：npx tsx src/features/packages/example_generate_package.ts
import { parseRuntimeArgs, resolveRuntimePaths } from "../../runtime.js";
import { handleGeneratePreset } from "./routes.js";

async function main() {
	const paths = resolveRuntimePaths(parseRuntimeArgs(process.argv.slice(2)).options);
	console.log("[example] preset 输出目录：", paths.presetCacheDir);

	const created = await handleGeneratePreset(
		paths,
		{ instruction: "创建一个帮助小学班主任处理课堂突发纪律问题的助手", documents: [] },
		(label) => console.log("[phase]", label),
	);

	console.log("\n=== 生成完成 ===");
	console.log("presetId   :", created.meta.id);
	console.log("name       :", created.meta.name);
	console.log("description:", created.meta.description);
	console.log("dir        :", created.dir);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
