import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List, MessageSquare, PlusCircle, RefreshCw, Search, SendHorizonal, Swords } from "lucide-react";
import { createSession, getSession } from "../api/sessions.js";
import type { SessionMeta } from "../api/sessions.js";
import { streamChat } from "../api/chat.js";
import type { ChatMessage, ChatStreamEvent, ChatToolRecord } from "../types/chat.js";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { ErrorBlock, MessageBubble } from "./ChatCenter.js";
import { Spinner } from "./ui/Spinner.js";
import { WorkspacePanel } from "./WorkspacePanel.js";
import type { RightPanelTab } from "../stores/app-store.js";
import { WorkspaceStoreImpl } from "../stores/workspace-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { arenaStore } from "../stores/arena-store.js";
import { useStoreSnapshot } from "./hooks.js";
import "@earendil-works/pi-web-ui";

type ArenaLaneId = "top" | "bottom";

interface ArenaHistory {
	key: string;
	label: string;
	aWorkspaceId: string;
	bWorkspaceId: string;
	aSessionId: string | null;
	bSessionId: string | null;
	updatedAt: string;
	preview: string;
}

interface ArenaLaneState {
	id: ArenaLaneId;
	title: string;
	sessionId: string | null;
	workspaceId: string | null;
	messages: ChatMessage[];
	isSending: boolean;
	streamingText: string;
	streamingThinking: string;
	streamingError: string;
	activeTools: ChatToolRecord[];
	completedTools: ChatToolRecord[];
	workspaceStore: WorkspaceStoreImpl;
	rightPanelTab: RightPanelTab;
}

function createInitialLanes(): ArenaLaneState[] {
	return [
		createInitialLane("top", "Arena A"),
		createInitialLane("bottom", "Arena B"),
	];
}

function isArenaGeneratedWorkspace(id: string): boolean {
	return id.startsWith("arena-a-") || id.startsWith("arena-b-");
}

function arenaHistoryKey(name: string): { side: "a" | "b"; key: string } | null {
	const match = name.match(/^Arena\s+([AB])\s+(.+)$/i);
	if (!match) return null;
	return { side: match[1].toLowerCase() as "a" | "b", key: match[2] };
}

function buildArenaHistories(
	workspaces: ReturnType<typeof workspacesStore.getById>[],
	sessions: SessionMeta[],
): ArenaHistory[] {
	const sessionById = new Map(sessions.map((session) => [session.id, session]));
	const pairs = new Map<string, Partial<ArenaHistory>>();
	for (const workspace of workspaces) {
		if (!workspace || !isArenaGeneratedWorkspace(workspace.id)) continue;
		const parsed = arenaHistoryKey(workspace.name);
		if (!parsed) continue;
		const existing = pairs.get(parsed.key) ?? { key: parsed.key, label: parsed.key, preview: "", updatedAt: workspace.updatedAt };
		const sessionId = workspace.sessionIds?.[0] ?? null;
		const session = sessionId ? sessionById.get(sessionId) : undefined;
		const next: Partial<ArenaHistory> = {
			...existing,
			updatedAt: Date.parse(workspace.updatedAt) > Date.parse(existing.updatedAt ?? "") ? workspace.updatedAt : existing.updatedAt,
			preview: existing.preview || session?.preview || "",
		};
		if (parsed.side === "a") {
			next.aWorkspaceId = workspace.id;
			next.aSessionId = sessionId;
		} else {
			next.bWorkspaceId = workspace.id;
			next.bSessionId = sessionId;
		}
		pairs.set(parsed.key, next);
	}
	return Array.from(pairs.values())
		.filter((history): history is ArenaHistory => Boolean(history.aWorkspaceId && history.bWorkspaceId))
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function createInitialLane(id: ArenaLaneId, title: string): ArenaLaneState {
	return {
		id,
		title,
		sessionId: null,
		workspaceId: null,
		messages: [],
		isSending: false,
		streamingText: "",
		streamingThinking: "",
		streamingError: "",
		activeTools: [],
		completedTools: [],
		workspaceStore: new WorkspaceStoreImpl(),
		rightPanelTab: "preview",
	};
}

function applyStreamEvent(lane: ArenaLaneState, event: ChatStreamEvent): ArenaLaneState {
	switch (event.type) {
		case "text_delta":
			return { ...lane, streamingText: lane.streamingText + event.delta };
		case "thinking_delta":
			return { ...lane, streamingThinking: lane.streamingThinking + event.delta };
		case "tool_start":
			return {
				...lane,
				activeTools: [
					...lane.activeTools,
					{ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
				],
			};
		case "tool_end": {
			const ended: ChatToolRecord = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: lane.activeTools.find((tool) => tool.toolCallId === event.toolCallId)?.args ?? {},
				result: event.result,
				isError: event.isError,
			};
			return {
				...lane,
				activeTools: lane.activeTools.filter((tool) => tool.toolCallId !== event.toolCallId),
				completedTools: [...lane.completedTools, ended],
			};
		}
		case "question":
			return {
				...lane,
				streamingError: "Arena mode received an ask-user question. Answering lane-specific questions is disabled so both lanes keep the same user prompt.",
			};
		case "error":
			return { ...lane, streamingError: event.message };
		case "done":
			return lane;
	}
}

function finalizeLane(lane: ArenaLaneState): ArenaLaneState {
	const shouldAppend = lane.streamingText || lane.streamingThinking || lane.streamingError || lane.completedTools.length > 0;
	const messages = shouldAppend
		? [
			...lane.messages,
			{
				role: "assistant" as const,
				content: lane.streamingText,
				timestamp: Date.now(),
				thinking: lane.streamingThinking || undefined,
				tools: lane.completedTools.length > 0 ? lane.completedTools : undefined,
				error: lane.streamingError || undefined,
			},
		]
		: lane.messages;
	return {
		...lane,
		messages,
		isSending: false,
		streamingText: "",
		streamingThinking: "",
		streamingError: "",
		activeTools: [],
		completedTools: [],
	};
}

function ArenaLaneSidebar({ lane, workspaceName }: { lane: ArenaLaneState; workspaceName: string | null }) {
	return (
		<aside className="flex w-56 shrink-0 flex-col border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)] px-3 py-3 text-xs">
			<div className="mb-3 flex items-center gap-2">
				<div className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[10px] font-semibold text-[var(--inno-accent)]">
					{lane.id === "top" ? "A" : "B"}
				</div>
				<div className="min-w-0">
					<div className="truncate font-semibold text-[var(--inno-text)]">{lane.title}</div>
					<div className="text-[10px] text-[var(--inno-text-subtle)]">{lane.isSending ? "running" : "ready"}</div>
				</div>
			</div>
			<div className="space-y-2 text-[var(--inno-text-muted)]">
				<div>
					<div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--inno-text-subtle)]">Workspace</div>
					<div className="truncate rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-[var(--inno-text)]">
						{workspaceName ?? lane.workspaceId ?? "created on first send"}
					</div>
				</div>
				<div>
					<div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--inno-text-subtle)]">Session</div>
					<div className="truncate rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 font-mono text-[10px] text-[var(--inno-text-muted)]">
						{lane.sessionId ?? "pending"}
					</div>
				</div>
				<div>
					<div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--inno-text-subtle)]">Messages</div>
					<div className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-[var(--inno-text)]">
						{lane.messages.length}
					</div>
				</div>
			</div>
			<div className="mt-auto rounded-md bg-[var(--inno-accent-soft)] px-2 py-1.5 text-[10px] leading-relaxed text-[var(--inno-text-muted)]">
				This lane receives the shared arena prompt and writes only to its own workspace.
			</div>
		</aside>
	);
}

function ArenaHistorySidebar({
	histories,
	onOpen,
	onNew,
	query,
	onQueryChange,
}: {
	histories: ArenaHistory[];
	onOpen: (history: ArenaHistory) => void;
	onNew: () => void;
	query: string;
	onQueryChange: (query: string) => void;
}) {
	const filtered = histories.filter((history) => {
		const q = query.trim().toLowerCase();
		if (!q) return true;
		return history.label.toLowerCase().includes(q) || history.preview.toLowerCase().includes(q);
	});
	return (
		<aside className="flex h-screen w-64 shrink-0 flex-col border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)] text-sm">
			<div className="flex h-12 items-center gap-2 border-b border-[var(--inno-border)] px-4">
				<div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--inno-accent)] text-xs font-semibold text-white">EA</div>
				<div className="min-w-0 flex-1 truncate font-semibold text-[var(--inno-text)]">EduAgentArena</div>
			</div>
			<div className="space-y-1 border-b border-[var(--inno-border)] p-3">
				<button
					type="button"
					className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--inno-text)] hover:bg-[var(--inno-surface)]"
					onClick={onNew}
				>
					<PlusCircle size={15} />
					New Battle
				</button>
				<div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[var(--inno-text-muted)]">
					<List size={15} />
					Battle History
				</div>
				<label className="flex items-center gap-2 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5 text-[var(--inno-text-muted)]">
					<Search size={14} />
					<input
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder="Search"
						className="min-w-0 flex-1 bg-transparent text-xs text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)]"
					/>
				</label>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
				<div className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)]">
					Previous Battles
				</div>
				{filtered.length === 0 ? (
					<div className="px-2 py-6 text-xs text-[var(--inno-text-subtle)]">
						{histories.length === 0 ? "No previous battles yet." : "No matching battles."}
					</div>
				) : null}
				<div className="grid gap-1">
					{filtered.map((history) => (
					<button
						key={history.key}
						type="button"
						className="rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--inno-surface)]"
						onClick={() => onOpen(history)}
					>
						<div className="flex items-center gap-2 text-xs">
							<Swords size={12} className="shrink-0 text-[var(--inno-text-subtle)]" />
							<span className="min-w-0 flex-1 truncate font-medium text-[var(--inno-text)]">{history.label}</span>
						</div>
						{history.preview ? (
							<div className="mt-1 line-clamp-1 pl-5 text-[10px] text-[var(--inno-text-muted)]">{history.preview}</div>
						) : null}
						<div className="mt-0.5 pl-5 text-[10px] text-[var(--inno-text-subtle)]">
							{new Date(history.updatedAt).toLocaleString()}
						</div>
					</button>
				))}
				</div>
			</div>
		</aside>
	);
}

function LanePanel({
	lane,
	workspaceName,
	onTabChange,
}: {
	lane: ArenaLaneState;
	workspaceName: string | null;
	onTabChange: (laneId: ArenaLaneId, tab: RightPanelTab) => void;
}) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [lane.messages, lane.streamingText, lane.streamingThinking, lane.activeTools.length, lane.completedTools.length]);

	return (
		<section className="claude-arena-lane flex min-h-0 flex-1 flex-col overflow-hidden border-b border-[var(--inno-border)] bg-[var(--inno-chat-bg)] last:border-b-0">
			<header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 text-xs">
				<div className="font-semibold text-[var(--inno-text)]">{lane.title}</div>
				<div className="min-w-0 truncate text-[var(--inno-text-muted)]">
					{workspaceName ?? lane.workspaceId ?? "workspace will be created on first send"}
				</div>
				{lane.isSending ? (
					<span className="ml-auto inline-flex items-center gap-1 text-[var(--inno-accent)]">
						<Spinner size={12} />
						running
					</span>
				) : null}
			</header>
			<div className="flex min-h-0 flex-1">
				<ArenaLaneSidebar lane={lane} workspaceName={workspaceName} />
				<div ref={scrollRef} className="chat-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
					<div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-3">
						{lane.messages.length === 0 && !lane.isSending ? (
							<div className="pt-8 text-center text-xs text-[var(--inno-text-subtle)]">
								Select a previous battle from the sidebar or send a new shared arena prompt.
							</div>
						) : null}
						{lane.messages.map((message, index) => (
							<MessageBubble key={`${message.timestamp}-${index}`} message={message} />
						))}
						{lane.activeTools.length > 0 ? (
							<div className="flex justify-start">
								<div className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-accent-soft)] bg-[var(--inno-accent-soft)] px-3 py-2 text-[13px]">
									{lane.activeTools.map((tool) => (
										<div key={tool.toolCallId} className="flex min-w-0 items-center gap-2 text-[var(--inno-text-muted)]">
											<Spinner size={12} className="shrink-0" />
											<span className="min-w-0 break-words font-mono text-xs [overflow-wrap:anywhere]">{tool.toolName}</span>
										</div>
									))}
								</div>
							</div>
						) : null}
						{lane.streamingThinking ? (
							<div className="flex justify-start">
								<details className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
									<summary className="cursor-pointer break-words [overflow-wrap:anywhere]">Thinking...</summary>
									<pre className="mt-1 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">{lane.streamingThinking}</pre>
								</details>
							</div>
						) : null}
						{lane.completedTools.length > 0 ? (
							<div className="flex justify-start">
								<details className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
									<summary className="cursor-pointer break-words [overflow-wrap:anywhere]">Completed tool calls · {lane.completedTools.length}</summary>
								</details>
							</div>
						) : null}
						{lane.streamingText ? (
							<div className="flex justify-start">
								<div className="inno-message max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--inno-text)]">
									<markdown-artifact content={normalizeMarkdownMath(lane.streamingText)} />
								</div>
							</div>
						) : null}
						{lane.streamingError ? (
							<div className="flex justify-start">
								<div className="inno-message max-w-[78%]">
									<ErrorBlock error={lane.streamingError} />
								</div>
							</div>
						) : null}
						{lane.isSending && !lane.streamingText && !lane.streamingError && lane.activeTools.length === 0 ? (
							<div className="flex justify-start">
								<div className="inno-message max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-2 text-sm text-[var(--inno-text-muted)]">
									<span className="inline-flex gap-1">
										<span className="animate-bounce">·</span>
										<span className="animate-bounce" style={{ animationDelay: "150ms" }}>·</span>
										<span className="animate-bounce" style={{ animationDelay: "300ms" }}>·</span>
									</span>
								</div>
							</div>
						) : null}
					</div>
				</div>
				<aside className="w-[34vw] min-w-[360px] max-w-[720px] shrink-0 border-l border-[var(--inno-border)] bg-[var(--inno-workspace-bg)]">
					{lane.workspaceId ? (
						<WorkspacePanel
							activeTab={lane.rightPanelTab}
							mode="half"
							width={560}
							onTabChange={(tab) => onTabChange(lane.id, tab)}
							onModeChange={() => undefined}
							onWidthChange={() => undefined}
							hidePanelControls
							workspaceBrowserProps={{
								store: lane.workspaceStore,
								workspaceId: lane.workspaceId,
								sessionId: lane.sessionId,
								showTerminal: false,
							}}
						/>
					) : (
						<div className="flex h-full items-center justify-center px-6 text-center text-xs text-[var(--inno-text-subtle)]">
							The right workspace panel will appear here after the first shared prompt forks the source workspace.
						</div>
					)}
				</aside>
			</div>
		</section>
	);
}

export function ClaudeArenaApp({ onSwitchChat }: { onSwitchChat?: () => void }) {
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const [lanes, setLanes] = useState<ArenaLaneState[]>(() => createInitialLanes());
	const [error, setError] = useState("");
	const workspaces = useStoreSnapshot(workspacesStore, () => workspacesStore.workspaces);
	const sessions = useStoreSnapshot(sessionsStore, () => sessionsStore.sessions);
	const sourceWorkspaces = useMemo(
		() => workspaces.filter((workspace) => !workspace.isTemp && !workspace.id.startsWith("channel-") && !isArenaGeneratedWorkspace(workspace.id)),
		[workspaces],
	);
	const arenaHistories = useMemo(() => buildArenaHistories(workspaces, sessions), [workspaces, sessions]);
	const [sourceWorkspaceId, setSourceWorkspaceId] = useState("");
	const [historyQuery, setHistoryQuery] = useState("");
	const isSending = lanes.some((lane) => lane.isSending);

	useEffect(() => {
		void sessionsStore.load();
		void workspacesStore.load();
	}, []);

	useEffect(() => {
		if (!sourceWorkspaceId && sourceWorkspaces.length > 0) {
			setSourceWorkspaceId(sourceWorkspaces[0].id);
		}
	}, [sourceWorkspaceId, sourceWorkspaces]);

	const patchLane = useCallback((id: ArenaLaneId, update: (lane: ArenaLaneState) => ArenaLaneState) => {
		setLanes((current) => current.map((lane) => lane.id === id ? update(lane) : lane));
	}, []);

	const setLaneTab = useCallback((laneId: ArenaLaneId, tab: RightPanelTab) => {
		patchLane(laneId, (lane) => ({ ...lane, rightPanelTab: tab }));
	}, [patchLane]);

	const openArenaHistory = useCallback((history: ArenaHistory) => {
		if (isSending) return;
		setError("");
		void (async () => {
			try {
				const [aDetail, bDetail] = await Promise.all([
					history.aSessionId ? getSession(history.aSessionId) : Promise.resolve(null),
					history.bSessionId ? getSession(history.bSessionId) : Promise.resolve(null),
				]);
				const aStore = new WorkspaceStoreImpl();
				const bStore = new WorkspaceStoreImpl();
				void aStore.setActiveWorkspace(history.aWorkspaceId);
				void bStore.setActiveWorkspace(history.bWorkspaceId);
				setLanes([
					{
						...createInitialLane("top", "Arena A"),
						sessionId: history.aSessionId,
						workspaceId: history.aWorkspaceId,
						messages: aDetail?.messages ?? [],
						workspaceStore: aStore,
					},
					{
						...createInitialLane("bottom", "Arena B"),
						sessionId: history.bSessionId,
						workspaceId: history.bWorkspaceId,
						messages: bDetail?.messages ?? [],
						workspaceStore: bStore,
					},
				]);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to load arena history");
			}
		})();
	}, [isSending]);

	const ensureLaneSession = useCallback(async (lane: ArenaLaneState): Promise<{ sessionId: string; workspaceId: string | null }> => {
		if (lane.sessionId) return { sessionId: lane.sessionId, workspaceId: lane.workspaceId };
		const created = await createSession({
			newWorkspace: {
				name: `${lane.title} ${new Date().toLocaleString()}`,
				isTemp: false,
				copyFromWorkspaceId: sourceWorkspaceId || undefined,
			},
		});
		patchLane(lane.id, (current) => ({
			...current,
			sessionId: created.id,
			workspaceId: created.workspaceId ?? current.workspaceId,
		}));
		void sessionsStore.load();
		void workspacesStore.load();
		return { sessionId: created.id, workspaceId: created.workspaceId ?? null };
	}, [patchLane, sourceWorkspaceId]);

	const runLane = useCallback(async (lane: ArenaLaneState, prompt: string) => {
		try {
			const { sessionId, workspaceId } = await ensureLaneSession(lane);
			patchLane(lane.id, (current) => ({
				...current,
				sessionId,
				workspaceId,
				isSending: true,
				streamingText: "",
				streamingThinking: "",
				streamingError: "",
				activeTools: [],
				completedTools: [],
				messages: [
					...current.messages,
					{ role: "user", content: prompt, timestamp: Date.now() },
				],
			}));
			for await (const event of streamChat(prompt, sessionId)) {
				patchLane(lane.id, (current) => applyStreamEvent(current, event));
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			patchLane(lane.id, (current) => ({ ...current, streamingError: message }));
		} finally {
			void lane.workspaceStore.loadTree();
			patchLane(lane.id, finalizeLane);
			void sessionsStore.refresh();
		}
	}, [ensureLaneSession, patchLane]);

	/** 把同一条 prompt 同时发给两条 lane（共享的核心发送路径）。 */
	const dispatchPrompt = useCallback((prompt: string) => {
		if (!prompt || isSending) return;
		setError("");
		const snapshot = lanes;
		void Promise.all(snapshot.map((lane) => runLane(lane, prompt))).catch((err) => {
			setError(err instanceof Error ? err.message : "Failed to send arena prompt");
		});
	}, [isSending, lanes, runLane]);

	const sendSharedPrompt = useCallback(() => {
		const prompt = inputRef.current?.value.trim() ?? "";
		if (!prompt || isSending) return;
		if (inputRef.current) {
			inputRef.current.value = "";
			inputRef.current.style.height = "auto";
		}
		dispatchPrompt(prompt);
	}, [isSending, dispatchPrompt]);

	// 从聊天欢迎屏"预约进场"带过来的首条 prompt：等 Source 工作区默认值就绪后
	// 自动双发一次（consumePendingPrompt 是一次性的，天然防 StrictMode 重复副作用）
	const isLoadingWorkspaces = useStoreSnapshot(workspacesStore, () => workspacesStore.isLoading);
	const sawWorkspacesLoadRef = useRef(false);
	const autoLaunchedRef = useRef(false);
	useEffect(() => {
		if (isLoadingWorkspaces) {
			sawWorkspacesLoadRef.current = true;
			return;
		}
		if (autoLaunchedRef.current) return;
		// 就绪条件：已选出默认 Source 工作区；或确认加载完成后确实没有可选工作区
		const ready = sourceWorkspaceId !== ""
			|| (sawWorkspacesLoadRef.current && !isLoadingWorkspaces && sourceWorkspaces.length === 0);
		if (!ready) return;
		autoLaunchedRef.current = true;
		const pending = arenaStore.consumePendingPrompt();
		if (pending) dispatchPrompt(pending);
	}, [sourceWorkspaceId, isLoadingWorkspaces, sourceWorkspaces.length, dispatchPrompt]);

	const resetArenaLanes = useCallback(() => {
		if (isSending) return;
		setError("");
		setLanes(createInitialLanes());
	}, [isSending]);

	const handleInput = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	}, []);

	const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			sendSharedPrompt();
		}
	}, [sendSharedPrompt]);

	return (
		<div className="claude-arena flex h-screen min-h-0 bg-[var(--inno-background)] text-[var(--inno-text)]">
			<ArenaHistorySidebar
				histories={arenaHistories}
				onOpen={openArenaHistory}
				onNew={resetArenaLanes}
				query={historyQuery}
				onQueryChange={setHistoryQuery}
			/>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<header className="flex h-10 shrink-0 items-center gap-3 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-4">
				<div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--inno-accent)] text-xs font-semibold text-white">EA</div>
				<h1 className="text-sm font-semibold">EduAgentArena</h1>
				<span className="text-xs text-[var(--inno-text-muted)]">上下两份独立工作区，共用同一条用户 prompt</span>
				<label className="ml-2 flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
					<span>Source</span>
					<select
						value={sourceWorkspaceId}
						disabled={isSending || sourceWorkspaces.length === 0 || lanes.some((lane) => lane.sessionId)}
						onChange={(event) => setSourceWorkspaceId(event.target.value)}
						className="h-7 max-w-[220px] rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 text-xs text-[var(--inno-text)] outline-none disabled:opacity-60"
						title={lanes.some((lane) => lane.sessionId) ? "Start a fresh arena page before changing the source workspace" : "Workspace copied into each arena lane"}
					>
						{sourceWorkspaces.length === 0 ? (
							<option value="">empty workspace</option>
						) : null}
						{sourceWorkspaces.map((workspace) => (
							<option key={workspace.id} value={workspace.id}>{workspace.name}</option>
						))}
					</select>
				</label>
				<button
					type="button"
					className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 text-xs text-[var(--inno-text-muted)] hover:text-[var(--inno-accent)] disabled:opacity-50"
					disabled={isSending}
					onClick={resetArenaLanes}
					title="Clear current lanes; next prompt forks the selected source workspace again"
				>
					<RefreshCw size={13} />
					New forks
				</button>
				<div className="ml-auto inline-flex rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-0.5">
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--inno-text-muted)] hover:text-[var(--inno-accent)]"
						onClick={onSwitchChat}
					>
						<MessageSquare size={13} />
						Chat
					</button>
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded bg-[var(--inno-surface)] px-2 py-1 text-xs font-medium text-[var(--inno-accent)] shadow-sm"
					>
						<Swords size={13} />
						Arena
					</button>
				</div>
			</header>
			<main className="flex min-h-0 flex-1 flex-col">
				{lanes.map((lane) => (
					<LanePanel
						key={lane.id}
						lane={lane}
						workspaceName={lane.workspaceId ? workspaces.find((workspace) => workspace.id === lane.workspaceId)?.name ?? null : null}
						onTabChange={setLaneTab}
					/>
				))}
			</main>
			<footer className="shrink-0 border-t border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
				<div className="mx-auto max-w-4xl">
					{error ? <p className="mb-2 text-xs text-[var(--inno-danger)]">{error}</p> : null}
					<div className="inno-composer flex items-end gap-2 rounded-lg p-2">
						<textarea
							ref={inputRef}
							className="min-h-[36px] max-h-[160px] flex-1 resize-none overflow-hidden rounded-md border-0 bg-transparent px-2 py-2 text-sm leading-5 text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] disabled:opacity-60"
							placeholder="输入一次，同时发送给 Arena A 和 Arena B"
							rows={1}
							onInput={handleInput}
							onKeyDown={handleKeyDown}
							disabled={isSending}
						/>
						<button
							className="inno-primary-button flex h-9 w-9 shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50"
							title="Send to both"
							disabled={isSending}
							onClick={sendSharedPrompt}
						>
							{isSending ? <Spinner size={16} /> : <SendHorizonal size={16} />}
						</button>
					</div>
				</div>
			</footer>
			</div>
		</div>
	);
}
