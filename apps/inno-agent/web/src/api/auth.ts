import { apiFetch } from "./client.js";

/** 与参考 EduClaw 的 AuthUser 对应。 */
export interface AuthUser {
	id: string;
	username: string;
	isAdmin: boolean;
}

export interface LoginResult {
	token: string;
	user: AuthUser;
}

export async function authStatus(): Promise<{ enabled: boolean }> {
	return apiFetch<{ enabled: boolean }>("/api/auth/status");
}

export async function login(username: string, password: string): Promise<LoginResult> {
	return apiFetch<LoginResult>("/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ username, password }),
	});
}

export async function getMe(): Promise<AuthUser> {
	return apiFetch<AuthUser>("/api/auth/me");
}
