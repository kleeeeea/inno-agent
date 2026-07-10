import { useCallback, useRef, useState, type DragEvent } from "react";
import { CheckCircle2, FileText, Image, Loader2, Paperclip, SendHorizonal, Upload, X, XCircle } from "lucide-react";

export interface AgentBuilderDocument {
	name: string;
	content: string;
}

/** 批量生成任务状态（与参考 LiteAgentBuilder 的 BatchGenerateItem 对应）。 */
export interface AgentBuilderBatchItem {
	id: string;
	name: string;
	status: "waiting" | "running" | "done" | "error";
	/** 生成结果的模板名（与源文档名不同时展示）。 */
	resultName?: string;
	error?: string;
}

interface AgentBuilderCardProps {
	disabled?: boolean;
	/** 多文档批量生成的进度列表（由父组件驱动）。 */
	batchRuns?: AgentBuilderBatchItem[];
	onBuild: (instruction: string, documents: AgentBuilderDocument[]) => void | Promise<void>;
	/** 导入 agent 包 ZIP。 */
	onImport?: (file: File) => void | Promise<void>;
}

const ACCEPTED_DOCUMENT_EXTENSIONS = [".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".js", ".ts", ".py", ".html", ".css"];

function isSupportedDocument(file: File): boolean {
	const name = file.name.toLowerCase();
	return file.type.startsWith("image/") || ACCEPTED_DOCUMENT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function hasDraggedFiles(event: DragEvent<HTMLElement>) {
	return Array.from(event.dataTransfer.types || []).includes("Files");
}

async function readDocument(file: File): Promise<AgentBuilderDocument> {
	if (file.type.startsWith("image/")) {
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result || ""));
			reader.onerror = () => reject(reader.error ?? new Error(`${file.name} 读取失败`));
			reader.readAsDataURL(file);
		});
		return {
			name: file.name,
			content: `图片资料：${file.name}\n${dataUrl}`,
		};
	}

	return {
		name: file.name,
		content: await file.text(),
	};
}

export function AgentBuilderCard({ disabled = false, batchRuns = [], onBuild, onImport }: AgentBuilderCardProps) {
	const [instruction, setInstruction] = useState("");
	const [documents, setDocuments] = useState<AgentBuilderDocument[]>([]);
	const [dropActive, setDropActive] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState("");
	const docInputRef = useRef<HTMLInputElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const zipInputRef = useRef<HTMLInputElement | null>(null);

	const handleImport = useCallback(async (file: File) => {
		if (!onImport) return;
		setError("");
		setIsSubmitting(true);
		try {
			await onImport(file);
		} catch (err) {
			setError(err instanceof Error ? err.message : "导入失败");
		} finally {
			setIsSubmitting(false);
		}
	}, [onImport]);

	const addFiles = useCallback(async (fileList: FileList | null) => {
		if (!fileList) return;
		setError("");
		const files = Array.from(fileList);
		const supported = files.filter(isSupportedDocument);
		if (supported.length !== files.length) {
			setError(`已忽略 ${files.length - supported.length} 个暂不支持的文件`);
		}
		const parsed: AgentBuilderDocument[] = [];
		for (const file of supported) {
			try {
				parsed.push(await readDocument(file));
			} catch (err) {
				setError(err instanceof Error ? err.message : `${file.name} 读取失败`);
			}
		}
		if (parsed.length > 0) setDocuments((current) => [...current, ...parsed]);
	}, []);

	const submit = useCallback(async () => {
		if (disabled || isSubmitting) return;
		const trimmed = instruction.trim();
		if (!trimmed && documents.length === 0) return;
		setError("");
		setIsSubmitting(true);
		try {
			await onBuild(trimmed, documents);
			setInstruction("");
			setDocuments([]);
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建失败");
		} finally {
			setIsSubmitting(false);
		}
	}, [disabled, documents, instruction, isSubmitting, onBuild]);

	const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(event)) return;
		event.preventDefault();
		setDropActive(true);
	}, []);

	const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(event)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		setDropActive(true);
	}, []);

	const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
		if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
		setDropActive(false);
	}, []);

	const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(event)) return;
		event.preventDefault();
		setDropActive(false);
		void addFiles(event.dataTransfer.files);
	}, [addFiles]);

	return (
		<div className="mt-5">
			<div
				onDragEnter={handleDragEnter}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
				className={`rounded-xl border bg-[var(--inno-surface)] shadow-[0_14px_40px_rgba(15,23,42,0.08)] transition-colors ${
					dropActive ? "border-[var(--inno-accent)]" : "border-[var(--inno-border)]"
				}`}
			>
				<div className="flex items-end gap-2 p-2">
					<button
						type="button"
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-accent)]"
						onClick={() => docInputRef.current?.click()}
						disabled={disabled || isSubmitting}
						title="上传文档"
					>
						<Paperclip size={17} />
					</button>
					<button
						type="button"
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-accent)]"
						onClick={() => imageInputRef.current?.click()}
						disabled={disabled || isSubmitting}
						title="上传图片"
					>
						<Image size={17} />
					</button>
					<textarea
						value={instruction}
						onChange={(event) => setInstruction(event.target.value)}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing || event.keyCode === 229) return;
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void submit();
							}
						}}
						rows={1}
						disabled={disabled || isSubmitting}
						placeholder="描述你想要的 Agent，或上传资料后生成..."
						className="min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] disabled:opacity-60"
					/>
					{onImport ? (
						<button
							type="button"
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-accent)]"
							onClick={() => zipInputRef.current?.click()}
							disabled={disabled || isSubmitting}
							title="导入 agent 包 ZIP"
						>
							<Upload size={17} />
						</button>
					) : null}
					<button
						type="button"
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--inno-accent)] text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
						onClick={() => void submit()}
						disabled={disabled || isSubmitting || (!instruction.trim() && documents.length === 0)}
						title="生成 Agent"
					>
						{isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <SendHorizonal size={16} />}
					</button>
				</div>
				<input
					ref={docInputRef}
					type="file"
					multiple
					accept={ACCEPTED_DOCUMENT_EXTENSIONS.join(",")}
					className="hidden"
					onChange={(event) => {
						void addFiles(event.target.files);
						event.currentTarget.value = "";
					}}
				/>
				<input
					ref={imageInputRef}
					type="file"
					multiple
					accept="image/*"
					className="hidden"
					onChange={(event) => {
						void addFiles(event.target.files);
						event.currentTarget.value = "";
					}}
				/>
				<input
					ref={zipInputRef}
					type="file"
					accept=".zip"
					className="hidden"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) void handleImport(file);
						event.currentTarget.value = "";
					}}
				/>
				{dropActive ? (
					<div className="border-t border-dashed border-[var(--inno-accent)] px-3 py-2 text-center text-xs text-[var(--inno-accent)]">
						松开上传资料
					</div>
				) : null}
			</div>
			{documents.length > 1 ? (
				<div className="mt-2 text-[11px] text-[var(--inno-text-subtle)]">多文档会逐个生成，不会合并成一个模板。</div>
			) : null}
			{documents.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-1.5">
					{documents.map((doc, index) => (
						<span key={`${doc.name}-${index}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1 text-[11px] text-[var(--inno-text-muted)]">
							<FileText size={12} className="shrink-0" />
							<span className="max-w-[16rem] truncate">{doc.name}</span>
							<button
								type="button"
								className="text-[var(--inno-text-subtle)] hover:text-[var(--inno-danger)]"
								onClick={() => setDocuments((current) => current.filter((_, i) => i !== index))}
								title="移除"
							>
								<X size={12} />
							</button>
						</span>
					))}
				</div>
			) : null}
			{batchRuns.length > 0 ? (
				<div className="mt-2 space-y-1.5 rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-2">
					<div className="flex items-center justify-between px-0.5 text-[11px] text-[var(--inno-text-muted)]">
						<span>批量任务</span>
						<span>{batchRuns.filter((item) => item.status === "done").length}/{batchRuns.length}</span>
					</div>
					{batchRuns.map((item) => (
						<div key={item.id} className="flex items-start justify-between gap-3 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-2 text-xs">
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium text-[var(--inno-text)]">{item.name}</div>
								{item.resultName && item.resultName !== item.name ? (
									<div className="truncate text-[11px] text-[var(--inno-text-muted)]">生成结果：{item.resultName}</div>
								) : null}
								{item.error ? <div className="truncate text-[11px] text-[var(--inno-danger)]">{item.error}</div> : null}
							</div>
							<div className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--inno-text-muted)]">
								{item.status === "running" ? <Loader2 size={14} className="animate-spin" /> : null}
								{item.status === "done" ? <CheckCircle2 size={14} className="text-[var(--inno-success)]" /> : null}
								{item.status === "error" ? <XCircle size={14} className="text-[var(--inno-danger)]" /> : null}
								<span>
									{item.status === "waiting" ? "等待中" : null}
									{item.status === "running" ? "生成中" : null}
									{item.status === "done" ? "已完成" : null}
									{item.status === "error" ? "失败" : null}
								</span>
							</div>
						</div>
					))}
				</div>
			) : null}
			{error ? <div className="mt-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
		</div>
	);
}
