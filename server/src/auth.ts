import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { db } from './db'
import { hashPassword, verifyPassword, newId, newToken, sha256 } from './crypto'
import type { ApiResult, SessionView, UserView } from '../../shared/types'

const COOKIE_NAME = 'tp_sid'
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 7)
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_FAILURES = 5

export interface AuthContext {
  userId: string
  email: string
  sessionId: string
}

interface UserRow {
  id: string
  email: string
  password_hash: string
  created_at: string
}

interface SessionLookupRow {
  session_id: string
  user_id: string
  email: string
  expires_at: string
  revoked_at: string | null
}

interface AttemptRow {
  failed_count: number
  window_started_at: string
}

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
  password: z.string().min(8, '密码至少 8 位').max(128),
})
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
  password: z.string().min(1).max(128),
})

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? ''
}

function readCookies(req: Request): Record<string, string> {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies
  return raw ?? {}
}

function resolveAuth(req: Request): AuthContext | null {
  const token = readCookies(req)[COOKIE_NAME]
  if (!token) return null
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at, u.id AS user_id, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as SessionLookupRow | undefined
  if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) return null
  return { userId: row.user_id, email: row.email, sessionId: row.session_id }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = resolveAuth(req)
  if (!auth) {
    res.status(401).json({ ok: false, error: '请先登录' } satisfies ApiResult<never>)
    return
  }
  res.locals.auth = auth
  next()
}

export function authOf(res: Response): AuthContext {
  return res.locals.auth as AuthContext
}

function createSession(userId: string, req: Request, res: Response): void {
  const token = newToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000)
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    userId,
    sha256(token),
    req.get('user-agent') ?? '',
    clientIp(req),
    now.toISOString(),
    expiresAt.toISOString(),
  )
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // 只有确实通过 HTTPS 访问时才能置 true，否则浏览器会拒绝保存 Cookie，
    // 表现为「注册成功但立刻退回登录页」。由显式的 COOKIE_SECURE 控制，不跟随 NODE_ENV。
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: SESSION_TTL_DAYS * 86_400_000,
    path: '/',
  })
}

/** 无验证码直注的兜底：同邮箱 + 同 IP 15 分钟内连续失败 5 次即锁定 */
function loginBlocked(email: string, ip: string): boolean {
  const row = db
    .prepare('SELECT failed_count, window_started_at FROM login_attempts WHERE email = ? AND ip = ?')
    .get(email, ip) as AttemptRow | undefined
  if (!row) return false
  if (Date.now() - new Date(row.window_started_at).getTime() > LOGIN_WINDOW_MS) {
    db.prepare('DELETE FROM login_attempts WHERE email = ? AND ip = ?').run(email, ip)
    return false
  }
  return row.failed_count >= MAX_LOGIN_FAILURES
}

function recordLoginFailure(email: string, ip: string): void {
  const now = new Date().toISOString()
  const row = db
    .prepare('SELECT failed_count, window_started_at FROM login_attempts WHERE email = ? AND ip = ?')
    .get(email, ip) as AttemptRow | undefined
  if (!row) {
    db.prepare('INSERT INTO login_attempts (email, ip, failed_count, window_started_at) VALUES (?, ?, 1, ?)').run(email, ip, now)
  } else if (Date.now() - new Date(row.window_started_at).getTime() > LOGIN_WINDOW_MS) {
    db.prepare('UPDATE login_attempts SET failed_count = 1, window_started_at = ? WHERE email = ? AND ip = ?').run(now, email, ip)
  } else {
    db.prepare('UPDATE login_attempts SET failed_count = failed_count + 1 WHERE email = ? AND ip = ?').run(email, ip)
  }
}

function clearLoginFailures(email: string, ip: string): void {
  db.prepare('DELETE FROM login_attempts WHERE email = ? AND ip = ?').run(email, ip)
}

/**
 * 微信网页登录需开放平台企业资质 + 备案域名 + HTTPS 回调，本地无法联调。
 * 本期只提供开关、授权地址构造与回调接入点；配置齐全后在 callback 中实现
 * code → access_token → userinfo → 绑定/建号 → createSession 即可启用。
 */
export interface WechatProvider {
  isEnabled(): boolean
  buildAuthorizeUrl(state: string): string
}

export const wechatProvider: WechatProvider = {
  isEnabled: () =>
    Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET && process.env.WECHAT_CALLBACK_URL),
  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      appid: process.env.WECHAT_APP_ID ?? '',
      redirect_uri: process.env.WECHAT_CALLBACK_URL ?? '',
      response_type: 'code',
      scope: 'snsapi_login',
      state,
    })
    return `https://open.weixin.qq.com/connect/qrconnect?${params.toString()}#wechat_redirect`
  },
}

export const authRouter = Router()

authRouter.post('/register', (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const { email, password } = parsed.data
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) {
    res.status(409).json({ ok: false, error: '该邮箱已注册，请直接登录' } satisfies ApiResult<never>)
    return
  }
  const userId = newId()
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    userId,
    email,
    hashPassword(password),
    new Date().toISOString(),
  )
  createSession(userId, req, res)
  const user: UserView = { id: userId, email, createdAt: new Date().toISOString() }
  res.json({ ok: true, data: user } satisfies ApiResult<UserView>)
})

authRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const { email, password } = parsed.data
  const ip = clientIp(req)
  if (loginBlocked(email, ip)) {
    res.status(429).json({ ok: false, error: '尝试次数过多，请 15 分钟后再试' } satisfies ApiResult<never>)
    return
  }
  const user = db.prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?').get(email) as
    | UserRow
    | undefined
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(email, ip)
    res.status(401).json({ ok: false, error: '邮箱或密码不正确' } satisfies ApiResult<never>)
    return
  }
  clearLoginFailures(email, ip)
  createSession(user.id, req, res)
  const view: UserView = { id: user.id, email: user.email, createdAt: user.created_at }
  res.json({ ok: true, data: view } satisfies ApiResult<UserView>)
})

authRouter.post('/logout', (req, res) => {
  const token = readCookies(req)[COOKIE_NAME]
  if (token) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(new Date().toISOString(), sha256(token))
  }
  res.clearCookie(COOKIE_NAME, { path: '/' })
  res.json({ ok: true, data: { loggedOut: true } } satisfies ApiResult<{ loggedOut: boolean }>)
})

authRouter.get('/me', requireAuth, (_req, res) => {
  const { userId, email } = authOf(res)
  const row = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId) as { created_at: string }
  res.json({ ok: true, data: { id: userId, email, createdAt: row.created_at } satisfies UserView } satisfies ApiResult<UserView>)
})

authRouter.get('/sessions', requireAuth, (_req, res) => {
  const { userId, sessionId } = authOf(res)
  const rows = db
    .prepare(
      `SELECT id, user_agent, ip, created_at, expires_at, revoked_at
       FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
    .all(userId) as Array<{
    id: string
    user_agent: string
    ip: string
    created_at: string
    expires_at: string
    revoked_at: string | null
  }>
  const sessions: SessionView[] = rows.map((row) => ({
    id: row.id,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    current: row.id === sessionId,
  }))
  res.json({ ok: true, data: sessions } satisfies ApiResult<SessionView[]>)
})

authRouter.get('/wechat/status', (_req, res) => {
  res.json({
    ok: true,
    data: {
      enabled: wechatProvider.isEnabled(),
      reason: wechatProvider.isEnabled()
        ? ''
        : '微信网页登录需开放平台企业资质与备案域名，本期仅预留接入点',
    },
  })
})

authRouter.get('/wechat/redirect', (req, res) => {
  if (!wechatProvider.isEnabled()) {
    res.status(501).json({ ok: false, error: '微信登录未启用：请配置 WECHAT_APP_ID / WECHAT_APP_SECRET / WECHAT_CALLBACK_URL' } satisfies ApiResult<never>)
    return
  }
  const state = sha256(`${clientIp(req)}:${Date.now()}:${newToken()}`).slice(0, 32)
  res.redirect(wechatProvider.buildAuthorizeUrl(state))
})

authRouter.get('/wechat/callback', (_req, res) => {
  res.status(501).json({
    ok: false,
    error: '微信回调尚未实现：请在 authRouter 的 callback 中完成 code 换取 userinfo 并调用 createSession',
  } satisfies ApiResult<never>)
})
