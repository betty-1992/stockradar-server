// ════════════════════════════════════════════════
//  Auth 라우트 — /api/auth/*
// ════════════════════════════════════════════════
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { db, logAudit } = require('./db');
const { requireAuth, clientIp } = require('./middleware');
const { sendVerificationCode, sendPasswordResetCode, generateCode } = require('./email');

const router = express.Router();

// 인증 코드 TTL (10분)
const CODE_TTL_MS = 10 * 60 * 1000;

// ─── 인증 코드 헬퍼 ────────────────────────────
function issueCode(email, purpose) {
  // 기존 미소비 코드는 consumed=1 로 무효화 (가장 최신 코드만 유효)
  db.prepare(`UPDATE email_verifications SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0`)
    .run(email, purpose);
  const code = generateCode();
  const now = Date.now();
  db.prepare(`
    INSERT INTO email_verifications (email, code, purpose, created_at, expires_at, consumed)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(email, code, purpose, now, now + CODE_TTL_MS);
  return code;
}

function consumeCode(email, code, purpose) {
  const row = db.prepare(`
    SELECT * FROM email_verifications
    WHERE email = ? AND code = ? AND purpose = ? AND consumed = 0
    ORDER BY id DESC LIMIT 1
  `).get(email, code, purpose);
  if (!row) return { ok: false, reason: 'INVALID_CODE' };
  if (row.expires_at < Date.now()) return { ok: false, reason: 'CODE_EXPIRED' };
  db.prepare(`UPDATE email_verifications SET consumed = 1 WHERE id = ?`).run(row.id);
  return { ok: true };
}

// ─── 속도 제한 ────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_REQUESTS' },
});
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_REQUESTS' },
});

// ─── 입력 스키마 ──────────────────────────────
const emailSchema = z.string().email().max(254).toLowerCase();
const pwSchema = z.string().min(8).max(200)
  .regex(/[A-Za-z]/, 'password must contain a letter')
  .regex(/[0-9]/, 'password must contain a number');
const consentsSchema = z.object({
  terms: z.boolean(),
  privacy: z.boolean(),
  disclaimer: z.boolean(),
  agreedAt: z.string().optional(),
}).optional();
const signupSchema = z.object({
  email: emailSchema,
  password: pwSchema,
  nickname: z.string().trim().min(1).max(40),
  consents: consentsSchema,
});
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

// ─── 세션 헬퍼 ────────────────────────────────
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    role: u.role,
    status: u.status,
    emailVerified: !!u.email_verified,
    createdAt: u.created_at,
  };
}

// ─── POST /api/auth/signup ───────────────────
//  가입 즉시 status='pending'. 인증 코드 메일을 발송하고,
//  유저는 코드 입력 후 verify-email 호출 시 active 로 전환되며 세션 발급.
//  (세션은 verify 성공 시에만 발급 — 미인증 상태로 로그인되는 걸 막음)
router.post('/signup', signupLimiter, async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', issues: parsed.error.issues });
  }
  const { email, password, nickname, consents } = parsed.data;

  // 법적 필수 동의 검증 — 서버에서도 한 번 더 확인
  if (!consents || !consents.terms || !consents.privacy || !consents.disclaimer) {
    return res.status(400).json({ ok: false, error: 'CONSENTS_REQUIRED' });
  }

  const dup = db.prepare(`SELECT id, status FROM users WHERE email = ?`).get(email);
  if (dup) {
    // 이미 pending 상태면 "재발송" 안내 (코드 재발급)
    if (dup.status === 'pending') {
      const code = issueCode(email, 'signup');
      const r = await sendVerificationCode(email, code);
      logAudit({ userId: dup.id, action: 'signup_resend', ip: clientIp(req) });
      return res.json({ ok: true, needVerification: true, email, resent: true, devCode: r.dev ? code : undefined });
    }
    return res.status(409).json({ ok: false, error: 'EMAIL_EXISTS' });
  }

  const pwHash = await bcrypt.hash(password, 12);
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO users (email, pw_hash, nickname, role, status, provider, email_verified, created_at)
    VALUES (?, ?, ?, 'user', 'pending', 'local', 0, ?)
  `).run(email, pwHash, nickname, now);

  const userId = info.lastInsertRowid;
  logAudit({ userId, action: 'signup_request', ip: clientIp(req) });
  // 법적 증거 — 약관 동의 내역을 audit_logs 에 별도 기록
  logAudit({
    userId,
    action: 'consents_agreed',
    meta: {
      terms: true, privacy: true, disclaimer: true,
      agreedAt: consents.agreedAt || new Date().toISOString(),
      version: '2026-04-13',
    },
    ip: clientIp(req),
  });

  // 인증 코드 발송
  const code = issueCode(email, 'signup');
  const r = await sendVerificationCode(email, code);

  // dev 모드(RESEND_API_KEY 없음)면 devCode 를 응답에 포함해서 UI 에서 바로 확인 가능
  res.json({
    ok: true,
    needVerification: true,
    email,
    devCode: r.dev ? code : undefined,
  });
});

// ─── POST /api/auth/verify-email ─────────────
//  { email, code } → 성공 시 status='active' + 세션 발급
const verifySchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
});
router.post('/verify-email', loginLimiter, async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const { email, code } = parsed.data;

  const u = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!u) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });

  const check = consumeCode(email, code, 'signup');
  if (!check.ok) return res.status(400).json({ ok: false, error: check.reason });

  const now = Date.now();
  db.prepare(`
    UPDATE users SET status = 'active', email_verified = 1, last_login = ?, login_count = login_count + 1
    WHERE id = ?
  `).run(now, u.id);
  logAudit({ userId: u.id, action: 'email_verified', ip: clientIp(req) });

  await regenerateSession(req);
  req.session.userId = u.id;

  const refreshed = db.prepare(`SELECT * FROM users WHERE id = ?`).get(u.id);
  res.json({ ok: true, user: publicUser(refreshed) });
});

// ─── POST /api/auth/resend-verification ──────
const resendLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_REQUESTS' },
});
router.post('/resend-verification', resendLimiter, async (req, res) => {
  const parsed = z.object({ email: emailSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const { email } = parsed.data;
  const u = db.prepare(`SELECT id, status FROM users WHERE email = ?`).get(email);
  if (!u) return res.json({ ok: true }); // 유저 존재 여부 숨김
  if (u.status !== 'pending') return res.json({ ok: true });
  const code = issueCode(email, 'signup');
  const r = await sendVerificationCode(email, code);
  logAudit({ userId: u.id, action: 'signup_resend', ip: clientIp(req) });
  res.json({ ok: true, devCode: r.dev ? code : undefined });
});

// ─── POST /api/auth/request-password-reset ───
//  이메일 존재 여부와 무관하게 항상 ok 응답 (유저 열거 공격 방지)
router.post('/request-password-reset', resendLimiter, async (req, res) => {
  const parsed = z.object({ email: emailSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const { email } = parsed.data;
  const u = db.prepare(`SELECT id, status FROM users WHERE email = ?`).get(email);
  let devCode;
  if (u && u.status === 'active') {
    const code = issueCode(email, 'reset');
    const r = await sendPasswordResetCode(email, code);
    if (r.dev) devCode = code;
    logAudit({ userId: u.id, action: 'password_reset_request', ip: clientIp(req) });
  }
  res.json({ ok: true, devCode });
});

// ─── POST /api/auth/reset-password ───────────
const resetSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
  newPassword: pwSchema,
});
router.post('/reset-password', loginLimiter, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const { email, code, newPassword } = parsed.data;

  const u = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!u) return res.status(400).json({ ok: false, error: 'INVALID_CODE' });

  const check = consumeCode(email, code, 'reset');
  if (!check.ok) return res.status(400).json({ ok: false, error: check.reason });

  const pwHash = await bcrypt.hash(newPassword, 12);
  db.prepare(`UPDATE users SET pw_hash = ? WHERE id = ?`).run(pwHash, u.id);
  logAudit({ userId: u.id, action: 'password_reset', ip: clientIp(req) });

  // 모든 기존 세션 무효화를 위해 현재 세션도 새로 발급 (선택적으로 자동 로그인)
  await regenerateSession(req);
  req.session.userId = u.id;
  db.prepare(`UPDATE users SET last_login = ?, login_count = login_count + 1 WHERE id = ?`).run(Date.now(), u.id);

  const refreshed = db.prepare(`SELECT * FROM users WHERE id = ?`).get(u.id);
  res.json({ ok: true, user: publicUser(refreshed) });
});

// ─── POST /api/auth/login ────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  }
  const { email, password } = parsed.data;

  const u = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!u || !u.pw_hash) {
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }
  if (u.status === 'banned') {
    return res.status(403).json({ ok: false, error: 'ACCOUNT_BANNED' });
  }

  const ok = await bcrypt.compare(password, u.pw_hash);
  if (!ok) {
    logAudit({ userId: u.id, action: 'login_fail', ip: clientIp(req) });
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }

  // 비밀번호는 맞았지만 아직 이메일 인증 안 된 계정 → 인증 스텝 유도
  // 코드 자동 재발급은 하지 않음 (기존 발급 코드를 무효화하는 부작용 방지)
  // 프론트는 이 응답을 받으면 인증 화면으로 이동 + 필요 시 /resend-verification 호출
  if (u.status === 'pending') {
    return res.status(403).json({
      ok: false,
      error: 'EMAIL_NOT_VERIFIED',
      email,
    });
  }

  await regenerateSession(req);
  req.session.userId = u.id;
  const now = Date.now();
  db.prepare(`UPDATE users SET last_login = ?, login_count = login_count + 1 WHERE id = ?`).run(now, u.id);
  logAudit({ userId: u.id, action: 'login', ip: clientIp(req) });

  const refreshed = db.prepare(`SELECT * FROM users WHERE id = ?`).get(u.id);
  res.json({ ok: true, user: publicUser(refreshed) });
});

// ─── POST /api/auth/logout ───────────────────
router.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ ok: false, error: 'LOGOUT_FAILED' });
    res.clearCookie('sr.sid');
    if (userId) logAudit({ userId, action: 'logout', ip: clientIp(req) });
    res.json({ ok: true });
  });
});

// ─── GET /api/auth/me ────────────────────────
router.get('/me', (req, res) => {
  if (!req.user) return res.json({ ok: true, user: null });
  res.json({ ok: true, user: publicUser(req.user) });
});

// ─── POST /api/auth/migrate-local ────────────
//  브라우저에 저장돼 있던 즐겨찾기·키워드를 로그인 유저 DB 로 이관
//  최초 로그인 후 한 번만 호출하면 됨. 중복은 무시.
router.post('/migrate-local', requireAuth, (req, res) => {
  const { favorites = [], keywords = [] } = req.body || {};
  const now = Date.now();
  const insFav = db.prepare(`
    INSERT OR IGNORE INTO user_favorites (user_id, stock_id, created_at) VALUES (?, ?, ?)
  `);
  const insKw = db.prepare(`
    INSERT OR IGNORE INTO user_keywords (user_id, keyword, created_at) VALUES (?, ?, ?)
  `);
  const tx = db.transaction(() => {
    let fc = 0, kc = 0;
    for (const f of favorites) {
      if (typeof f === 'string' && f.length <= 50) {
        const r = insFav.run(req.user.id, f, now); if (r.changes) fc++;
      }
    }
    for (const k of keywords) {
      if (typeof k === 'string' && k.length <= 60) {
        const r = insKw.run(req.user.id, k, now); if (r.changes) kc++;
      }
    }
    return { fc, kc };
  });
  const { fc, kc } = tx();
  logAudit({ userId: req.user.id, action: 'migrate_local', meta: { fc, kc }, ip: clientIp(req) });
  res.json({ ok: true, imported: { favorites: fc, keywords: kc } });
});

// ─── GET /api/user/favorites · keywords ─────
router.get('/favorites', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT stock_id FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id);
  res.json({ ok: true, favorites: rows.map(r => r.stock_id) });
});
router.get('/keywords', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT keyword FROM user_keywords WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id);
  res.json({ ok: true, keywords: rows.map(r => r.keyword) });
});

// 동기화 엔드포인트(단일 원자 업데이트 — 프론트에서 변경 시마다 호출)
router.put('/favorites', requireAuth, (req, res) => {
  const list = Array.isArray(req.body?.favorites) ? req.body.favorites.filter(s => typeof s === 'string' && s.length <= 50) : [];
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM user_favorites WHERE user_id = ?`).run(req.user.id);
    const ins = db.prepare(`INSERT OR IGNORE INTO user_favorites (user_id, stock_id, created_at) VALUES (?, ?, ?)`);
    list.forEach(s => ins.run(req.user.id, s, now));
  });
  tx();
  res.json({ ok: true, count: list.length });
});
router.put('/keywords', requireAuth, (req, res) => {
  const list = Array.isArray(req.body?.keywords) ? req.body.keywords.filter(k => typeof k === 'string' && k.length <= 60) : [];
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM user_keywords WHERE user_id = ?`).run(req.user.id);
    const ins = db.prepare(`INSERT OR IGNORE INTO user_keywords (user_id, keyword, created_at) VALUES (?, ?, ?)`);
    list.forEach(k => ins.run(req.user.id, k, now));
  });
  tx();
  res.json({ ok: true, count: list.length });
});

// ════════════════════════════════════════════════
//  Google OAuth 2.0 — 소셜 로그인
// ════════════════════════════════════════════════
//  흐름:
//   1) GET  /api/auth/google          → Google 인증 페이지로 리디렉션 (state 세션에 저장)
//   2) GET  /api/auth/google/callback → code 받음 → token 교환 → userinfo 조회
//                                       → provider='google', provider_id=sub 로 users 테이블 find-or-create
//                                       → 세션 로그인 → 홈으로 리디렉션
const crypto = require('crypto');

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO  = 'https://openidconnect.googleapis.com/v1/userinfo';

function oauthBase(req) {
  // 우선순위: env > 현재 요청 origin (로컬 개발 편의)
  if (process.env.OAUTH_CALLBACK_BASE) return process.env.OAUTH_CALLBACK_BASE.replace(/\/$/, '');
  const proto = req.protocol;
  const host = req.get('host');
  return `${proto}://${host}`;
}

function googleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// 1) 로그인 시작 — Google 동의 화면으로 보냄
router.get('/google', (req, res) => {
  if (!googleConfigured()) {
    return res.status(500).send('Google OAuth not configured (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${oauthBase(req)}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'online',
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

// 2) 콜백 — code → token → userinfo → 세션 로그인
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect(`/?oauth_error=${encodeURIComponent(String(error))}`);
  }
  if (!code || !state || state !== req.session.oauthState) {
    return res.redirect('/?oauth_error=state_mismatch');
  }
  delete req.session.oauthState;

  try {
    // Token 교환
    const tokenBody = new URLSearchParams({
      code: String(code),
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${oauthBase(req)}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    });
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text().catch(() => '');
      throw new Error(`google token ${tokenRes.status}: ${txt.slice(0, 200)}`);
    }
    const { access_token } = await tokenRes.json();
    if (!access_token) throw new Error('no access_token from google');

    // Userinfo 조회
    const uiRes = await fetch(GOOGLE_USERINFO, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!uiRes.ok) throw new Error(`google userinfo ${uiRes.status}`);
    const ui = await uiRes.json();
    //  { sub, email, email_verified, name, given_name, family_name, picture, locale }
    const sub = ui.sub;
    const email = ui.email;
    const nickname = (ui.name || (email && email.split('@')[0]) || 'User').slice(0, 40);
    if (!sub || !email) throw new Error('google userinfo missing sub/email');

    // 유저 find-or-create
    //  1. provider+provider_id 매치되는 계정
    //  2. 같은 이메일의 local 계정 있으면 링크 (email_verified=1 일 때만)
    //  3. 없으면 신규 생성
    let u = db.prepare(`SELECT * FROM users WHERE provider = 'google' AND provider_id = ?`).get(String(sub));
    if (!u) {
      const existing = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
      if (existing && ui.email_verified) {
        // 기존 local 계정과 Google 연동 — provider 는 그대로 'local' 유지, provider_id 만 저장
        //  (여러 소셜 연결 시에는 별도 테이블 필요하지만 지금은 단일 연결만 지원)
        db.prepare(`
          UPDATE users SET provider_id = ?, email_verified = 1, status = CASE WHEN status='pending' THEN 'active' ELSE status END
          WHERE id = ?
        `).run(String(sub), existing.id);
        u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(existing.id);
        logAudit({ userId: u.id, action: 'oauth_link_google', target: email, ip: clientIp(req) });
      } else if (existing && !ui.email_verified) {
        return res.redirect('/?oauth_error=email_not_verified');
      } else {
        // 신규 생성 — pw_hash NULL, provider='google', email_verified=1
        const now = Date.now();
        const r = db.prepare(`
          INSERT INTO users (email, pw_hash, nickname, role, status, provider, provider_id, email_verified, created_at, last_login, login_count)
          VALUES (?, NULL, ?, 'user', 'active', 'google', ?, 1, ?, ?, 1)
        `).run(email, nickname, String(sub), now, now);
        u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(r.lastInsertRowid);
        logAudit({ userId: u.id, action: 'oauth_signup_google', target: email, ip: clientIp(req) });
      }
    } else {
      // 차단된 계정 체크
      if (u.status === 'banned') return res.redirect('/?oauth_error=banned');
      db.prepare(`UPDATE users SET last_login = ?, login_count = login_count + 1 WHERE id = ?`).run(Date.now(), u.id);
      logAudit({ userId: u.id, action: 'oauth_login_google', ip: clientIp(req) });
    }

    // 세션 고정 공격 방지용 regenerate
    await regenerateSession(req);
    req.session.userId = u.id;
    res.redirect('/?oauth=google');
  } catch (e) {
    console.error('[oauth/google]', e);
    res.redirect(`/?oauth_error=${encodeURIComponent(e.message.slice(0, 80))}`);
  }
});

module.exports = router;
