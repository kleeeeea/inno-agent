import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { logger } from "../../logger.js";

/*
 * 用户登录管理（移植自 EduClaw-js educlaw-server 的 auth-service / middleware）。
 *
 * 与参考实现的差异（不引入新依赖）：
 * - bcrypt → node:crypto scrypt（格式 scrypt$<saltHex>$<hashHex>）
 * - jsonwebtoken → HMAC-SHA256 紧凑 token：base64url(payload).base64url(signature)，
 *   payload 含 sub / username / exp（7 天）
 * - sqlite users 表 → <dataDir>/users.json；HMAC 密钥持久化在 <dataDir>/auth-secret
 *
 * 预置账号与参考一致：user1–user15；密码可用 INNO_SEED_USER_PASSWORD 覆盖。
 * 注册接口与参考一致：关闭（403），只允许预置账号登录。
 */

export interface AuthUser {
	id: string;
	username: string;
	isAdmin: boolean;
}

interface UserRecord {
	id: string;
	username: string;
	passwordHash: string;
	createdAt: string;
	isAdmin: boolean;
}

interface TokenPayload {
	sub: string;
	username: string;
	exp: number;
}

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天，与参考实现一致

const SEED_USER_NAMES = (process.env.INNO_SEED_USER_NAMES || "")
	.split(",")
	.map((name) => name.trim())
	.filter(Boolean);
if (SEED_USER_NAMES.length === 0) {
	for (let i = 1; i <= 15; i += 1) SEED_USER_NAMES.push(`user${i}`);
}
const SEED_USER_PASSWORD = process.env.INNO_SEED_USER_PASSWORD || "EduClaw2026@StrongPass";

let _dataDir: string | null = null;
let _secret: Buffer | null = null;
let _users: UserRecord[] | null = null;

function usersFile(): string {
	if (!_dataDir) throw new Error("auth not initialized");
	return join(_dataDir, "users.json");
}

/* ── 密码哈希（scrypt） ── */

function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 64);
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
	const parts = stored.split("$");
	if (parts.length !== 3 || parts[0] !== "scrypt") return false;
	const salt = Buffer.from(parts[1], "hex");
	const expected = Buffer.from(parts[2], "hex");
	const actual = scryptSync(password, salt, expected.length);
	return timingSafeEqual(actual, expected);
}

/* ── token（HMAC-SHA256 紧凑格式） ── */

function b64url(data: Buffer | string): string {
	return Buffer.from(data).toString("base64url");
}

function sign(payloadB64: string): string {
	if (!_secret) throw new Error("auth not initialized");
	return createHmac("sha256", _secret).update(payloadB64).digest("base64url");
}

function issueToken(user: UserRecord): { token: string; user: AuthUser } {
	const payload: TokenPayload = {
		sub: user.id,
		username: user.username,
		exp: Date.now() + TOKEN_TTL_MS,
	};
	const payloadB64 = b64url(JSON.stringify(payload));
	return {
		token: `${payloadB64}.${sign(payloadB64)}`,
		user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
	};
}

export function verifyToken(token: string): TokenPayload {
	const [payloadB64, signature] = token.split(".");
	if (!payloadB64 || !signature) throw new Error("invalid token");
	const expected = sign(payloadB64);
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("invalid token signature");
	const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as TokenPayload;
	if (typeof payload.exp !== "number" || payload.exp < Date.now()) throw new Error("token expired");
	return payload;
}

/* ── 初始化与用户存储 ── */

function loadUsers(): UserRecord[] {
	if (_users) return _users;
	const file = usersFile();
	_users = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as UserRecord[]) : [];
	return _users;
}

function saveUsers(users: UserRecord[]): void {
	_users = users;
	writeFileSync(usersFile(), `${JSON.stringify(users, null, 2)}\n`, "utf-8");
}

/**
 * 初始化鉴权子系统：加载/生成 HMAC 密钥，预置 user1–user15。
 * 幂等；server 启动 bootstrap 时调用一次。
 */
export function initAuth(dataDir: string): void {
	_dataDir = dataDir;
	mkdirSync(dataDir, { recursive: true });

	const secretFile = join(dataDir, "auth-secret");
	if (!existsSync(secretFile)) {
		writeFileSync(secretFile, randomBytes(32).toString("hex"), { encoding: "utf-8", mode: 0o600 });
	}
	_secret = Buffer.from(readFileSync(secretFile, "utf-8").trim(), "hex");

	// 与参考实现的 seedUsers 一致：只补缺，不覆盖已有账号（改密码不会被启动重置）
	const users = loadUsers();
	let created = 0;
	for (const username of SEED_USER_NAMES) {
		if (users.some((user) => user.username === username)) continue;
		users.push({
			id: randomUUID(),
			username,
			passwordHash: hashPassword(SEED_USER_PASSWORD),
			createdAt: new Date().toISOString(),
			isAdmin: false,
		});
		created += 1;
	}
	if (created > 0) {
		saveUsers(users);
		logger.info({ created, total: users.length }, "seeded auth users");
	}
}

/* ── 登录 / 查询（与参考 auth-service 同名同语义） ── */

export function loginUser(username: string, password: string): { token: string; user: AuthUser } {
	const user = loadUsers().find((record) => record.username === username.trim());
	if (!user || !verifyPassword(password, user.passwordHash)) {
		throw new Error("用户名或密码错误");
	}
	return issueToken(user);
}

export function getUserById(userId: string): AuthUser | null {
	const user = loadUsers().find((record) => record.id === userId);
	return user ? { id: user.id, username: user.username, isAdmin: user.isAdmin } : null;
}

/* ── 请求鉴权（对应参考的 requireAuth 中间件） ── */

/**
 * 从请求中解析登录态：Authorization: Bearer 头优先，
 * 其次 ?token= 查询参数（给 WebSocket / EventSource 这类没法带头的场景）。
 * 未登录或 token 无效返回 null。
 */
export function authenticateRequest(req: IncomingMessage): TokenPayload | null {
	const header = req.headers.authorization || "";
	let token = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (!token) {
		const query = (req.url ?? "").split("?")[1];
		if (query) token = new URLSearchParams(query).get("token") ?? "";
	}
	if (!token) return null;
	try {
		return verifyToken(token);
	} catch {
		return null;
	}
}
