import { useState } from "react";
import { KeyRound, LogIn, User } from "lucide-react";
import { authStore } from "../stores/auth-store.js";
import { themeStore } from "../stores/theme-store.js";
import { getBrandInitials, getBrandName } from "../brand.js";
import { useStoreSnapshot } from "./hooks.js";

/**
 * 登录页（参考 EduClaw 的 LoginPage：预置账号登录，注册关闭）。
 * 校验规则与参考一致：用户名 3–32 位，密码至少 6 位。
 */
export function LoginPage() {
	const brand = useStoreSnapshot(themeStore, () => ({ name: getBrandName(), initials: getBrandInitials() }));
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault();
		setError("");
		if (username.trim().length < 3 || username.trim().length > 32) {
			setError("用户名长度需为 3–32 个字符");
			return;
		}
		if (password.length < 6) {
			setError("密码至少 6 位");
			return;
		}
		setLoading(true);
		try {
			await authStore.login(username.trim(), password);
		} catch (err) {
			setError(err instanceof Error ? err.message : "登录失败");
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-[var(--inno-background)] px-4">
			<div className="w-full max-w-sm rounded-2xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-8 shadow-[var(--inno-shadow-soft)]">
				<div className="mb-6 flex flex-col items-center gap-3">
					<div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--inno-accent)] bg-[var(--inno-accent)] text-base font-semibold text-white shadow-sm">
						{brand.initials}
					</div>
					<h1 className="text-lg font-semibold text-[var(--inno-text)]">{brand.name}</h1>
					<p className="text-xs text-[var(--inno-text-muted)]">请使用预置账号登录（注册已关闭）</p>
				</div>
				<form onSubmit={(event) => void handleSubmit(event)} className="space-y-3">
					<label className="flex items-center gap-2 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-raised)] px-3 py-2 focus-within:border-[var(--inno-accent)]">
						<User size={15} className="shrink-0 text-[var(--inno-text-subtle)]" />
						<input
							value={username}
							onChange={(event) => setUsername(event.target.value)}
							placeholder="用户名（如 user1）"
							autoComplete="username"
							autoFocus
							className="w-full bg-transparent text-sm text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)]"
						/>
					</label>
					<label className="flex items-center gap-2 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-raised)] px-3 py-2 focus-within:border-[var(--inno-accent)]">
						<KeyRound size={15} className="shrink-0 text-[var(--inno-text-subtle)]" />
						<input
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							placeholder="密码"
							autoComplete="current-password"
							className="w-full bg-transparent text-sm text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)]"
						/>
					</label>
					{error ? <p className="text-xs text-[var(--inno-danger)]">{error}</p> : null}
					<button
						type="submit"
						disabled={loading}
						className="inno-primary-button flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--inno-accent)] px-3 py-2.5 text-sm font-medium text-white shadow-sm hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
					>
						<LogIn size={15} />
						{loading ? "登录中..." : "登录"}
					</button>
				</form>
			</div>
		</div>
	);
}
