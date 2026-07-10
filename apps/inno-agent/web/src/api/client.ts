export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

const BASE_URL = ""; // Same origin — Vite proxy in dev

/* ── 登录态（参考 EduClaw：token 存 localStorage，请求带 Bearer 头） ── */

const AUTH_TOKEN_KEY = "inno.auth.token";

export function getAuthToken(): string | null {
	return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setAuthToken(token: string | null): void {
	if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
	else localStorage.removeItem(AUTH_TOKEN_KEY);
}

/** 带上登录 token 的公共请求头；auth-store 之外的直连 fetch 也应使用。 */
export function authHeaders(): Record<string, string> {
	const token = getAuthToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

// 401 时通知 auth-store 清登录态并弹出登录页（回调注册避免循环 import）
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
	unauthorizedHandler = handler;
}

function notifyUnauthorized(path: string): void {
	// 登录接口自身的 401/400 由登录页展示，不触发全局登出
	if (path.startsWith("/api/auth/")) return;
	unauthorizedHandler?.();
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		...options,
		headers: { "Content-Type": "application/json", ...authHeaders(), ...options?.headers },
	});
	if (!res.ok) {
		if (res.status === 401) notifyUnauthorized(path);
		const body = await res.json().catch(() => ({}));
		throw new ApiError(res.status, (body as Record<string, string>).error || res.statusText);
	}
	// 204 No Content
	if (res.status === 204) return undefined as T;
	return res.json() as Promise<T>;
}

/**
 * Shared SSE body-reading loop. Yields parsed JSON objects from `data:` lines.
 * When the signal is aborted the generator returns normally.
 */
async function* readSSEStream<T>(res: Response, signal?: AbortSignal): AsyncGenerator<T> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (err) {
				if (signal?.aborted) return;
				throw err;
			}
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop()!;
			for (const line of lines) {
				if (line.startsWith("data: ")) {
					const json = line.slice(6).trim();
					if (json === "[DONE]") return;
					try {
						yield JSON.parse(json) as T;
					} catch {
						// skip malformed lines
					}
				}
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// already closed
		}
	}
}

/**
 * SSE stream parser. Yields parsed JSON objects from `data:` lines.
 * Pass an AbortSignal to allow callers to stop the stream early (e.g. user
 * clicks Stop). When aborted the generator returns normally instead of
 * surfacing the underlying AbortError.
 */
export async function* streamSSE<T>(url: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders() },
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
	if (!res.ok) {
		if (res.status === 401) notifyUnauthorized(url);
		const errBody = await res.json().catch(() => ({}));
		throw new ApiError(res.status, (errBody as Record<string, string>).error || res.statusText);
	}
	yield* readSSEStream<T>(res, signal);
}

/**
 * SSE stream via GET. Returns silently on 404 (no active stream).
 * Yields parsed JSON objects from `data:` lines.
 */
export async function* streamSSEGet<T>(url: string, signal?: AbortSignal): AsyncGenerator<T> {
	let res: Response;
	try {
		res = await fetch(url, { method: "GET", headers: authHeaders(), signal });
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
	if (res.status === 404) return;
	if (!res.ok) {
		if (res.status === 401) notifyUnauthorized(url);
		const errBody = await res.json().catch(() => ({}));
		throw new ApiError(res.status, (errBody as Record<string, string>).error || res.statusText);
	}
	yield* readSSEStream<T>(res, signal);
}
