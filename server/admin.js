// ════════════════════════════════════════════════
//  Admin 라우트 — /api/admin/*  (requireAdmin 필수)
// ════════════════════════════════════════════════
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { db, logAudit, logAiUsage, GEMINI_PRICING, DB_PATH } = require('./db');
const fs = require('fs');
const { requireAdmin, clientIp } = require('./middleware');

const router = express.Router();
router.use(requireAdmin);

// ─── GET /api/admin/stats ────────────────────
router.get('/stats', (req, res) => {
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const weekStart  = now - 7 * 24 * 60 * 60 * 1000;

  const totalUsers     = db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c;
  const activeUsers    = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE status='active'`).get().c;
  const pendingUsers   = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE status='pending'`).get().c;
  const bannedUsers    = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE status='banned'`).get().c;
  const todaySignups   = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE created_at >= ?`).get(todayStart.getTime()).c;
  const weeklyActive   = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE last_login >= ?`).get(weekStart).c;
  const adminUsers     = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='admin'`).get().c;

  const recent = db.prepare(`
    SELECT id, email, nickname, role, status, provider, created_at
    FROM users ORDER BY id DESC LIMIT 10
  `).all();

  const providerRows = db.prepare(`
    SELECT provider, COUNT(*) AS c FROM users GROUP BY provider ORDER BY c DESC
  `).all();
  const providers = Object.fromEntries(providerRows.map(r => [r.provider || 'local', r.c]));

  res.json({
    ok: true,
    stats: {
      totalUsers, activeUsers, pendingUsers, bannedUsers,
      todaySignups, weeklyActive, adminUsers,
      providers,
    },
    recent,
  });
});

// ─── GET /api/admin/users ─────────────────────
//  query: q(검색), status, role, page, pageSize
router.get('/users', (req, res) => {
  const q        = (req.query.q || '').toString().trim();
  const status   = (req.query.status || '').toString();
  const role     = (req.query.role || '').toString();
  const provider = (req.query.provider || '').toString();
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize) || 20));

  const where = [];
  const args = [];
  if (q) {
    where.push(`(email LIKE ? OR nickname LIKE ?)`);
    args.push(`%${q}%`, `%${q}%`);
  }
  if (status && ['active','pending','banned'].includes(status)) {
    where.push(`status = ?`);
    args.push(status);
  }
  if (role && ['user','admin'].includes(role)) {
    where.push(`role = ?`);
    args.push(role);
  }
  if (provider && ['local','google','kakao','naver'].includes(provider)) {
    where.push(`provider = ?`);
    args.push(provider);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM users ${whereSql}`).get(...args).c;
  const rows = db.prepare(`
    SELECT id, email, nickname, role, status, email_verified, provider,
           created_at, last_login, login_count
    FROM users ${whereSql}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...args, pageSize, (page - 1) * pageSize);

  res.json({ ok: true, page, pageSize, total, users: rows });
});

// ─── PATCH /api/admin/users/:id ───────────────
//  { role?, status?, nickname? }
const patchUserSchema = z.object({
  role: z.enum(['user','admin']).optional(),
  status: z.enum(['active','pending','banned']).optional(),
  nickname: z.string().trim().min(1).max(40).optional(),
});
router.patch('/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  const parsed = patchUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const target = db.prepare(`SELECT id FROM users WHERE id = ?`).get(id);
  if (!target) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });

  // 자기 자신의 role 강등/차단은 실수 방지
  if (id === req.user.id && (parsed.data.role === 'user' || parsed.data.status === 'banned')) {
    return res.status(400).json({ ok: false, error: 'CANNOT_MODIFY_SELF' });
  }

  const updates = [];
  const args = [];
  if (parsed.data.role != null)     { updates.push('role = ?');     args.push(parsed.data.role); }
  if (parsed.data.status != null)   { updates.push('status = ?');   args.push(parsed.data.status); }
  if (parsed.data.nickname != null) { updates.push('nickname = ?'); args.push(parsed.data.nickname); }
  if (!updates.length) return res.json({ ok: true, unchanged: true });

  args.push(id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  logAudit({
    userId: req.user.id,
    action: 'admin_update_user',
    target: String(id),
    meta: parsed.data,
    ip: clientIp(req),
  });

  const updated = db.prepare(`
    SELECT id, email, nickname, role, status, email_verified, provider, created_at, last_login, login_count
    FROM users WHERE id = ?
  `).get(id);
  res.json({ ok: true, user: updated });
});

// ─── POST /api/admin/users/:id/reset-password ─
//  관리자가 임시 비밀번호로 초기화. 응답에 임시 비번 반환 (어드민만 볼 수 있음)
router.post('/users/:id/reset-password', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  const u = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(id);
  if (!u) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });

  // 임시 비번 = 8자 랜덤 (영문 대소문자 + 숫자)
  const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let tmp = '';
  const crypto = require('crypto');
  for (let i = 0; i < 10; i++) tmp += chars[crypto.randomInt(0, chars.length)];

  const pwHash = await bcrypt.hash(tmp, 12);
  db.prepare(`UPDATE users SET pw_hash = ? WHERE id = ?`).run(pwHash, id);
  logAudit({
    userId: req.user.id,
    action: 'admin_reset_password',
    target: String(id),
    ip: clientIp(req),
  });
  res.json({ ok: true, temporaryPassword: tmp, email: u.email });
});

// ─── DELETE /api/admin/users/:id ─────────────
//  실제 삭제가 아닌 soft ban (status=banned)
router.delete('/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  if (id === req.user.id) return res.status(400).json({ ok: false, error: 'CANNOT_DELETE_SELF' });
  const u = db.prepare(`SELECT id FROM users WHERE id = ?`).get(id);
  if (!u) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
  db.prepare(`UPDATE users SET status = 'banned' WHERE id = ?`).run(id);
  logAudit({ userId: req.user.id, action: 'admin_ban_user', target: String(id), ip: clientIp(req) });
  res.json({ ok: true });
});

// ─── POST /api/admin/users/:id/hard-delete ────
//  회원 계정을 DB에서 완전 삭제 (복구 불가)
//  cascade: user_keywords·user_favorites 자동 삭제 / audit_logs·ai_usage·error_logs는 user_id SET NULL
router.post('/users/:id/hard-delete', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  if (id === req.user.id) return res.status(400).json({ ok: false, error: 'CANNOT_DELETE_SELF' });
  const u = db.prepare(`SELECT id, email, nickname FROM users WHERE id = ?`).get(id);
  if (!u) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
  // 다른 어드민을 삭제하려면 본인 이외의 어드민이 2명 이상 남는지 확인
  const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'`).get().c;
  const target = db.prepare(`SELECT role, status FROM users WHERE id = ?`).get(id);
  if (target.role === 'admin' && target.status === 'active' && adminCount <= 1) {
    return res.status(400).json({ ok: false, error: 'LAST_ADMIN' });
  }
  const r = db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  logAudit({
    userId: req.user.id,
    action: 'admin_hard_delete_user',
    target: String(id),
    meta: { email: u.email, nickname: u.nickname },
    ip: clientIp(req),
  });
  res.json({ ok: true, deleted: r.changes });
});

// ─── GET /api/admin/menus ─────────────────────
router.get('/menus', (req, res) => {
  const rows = db.prepare(`SELECT * FROM menus ORDER BY order_idx ASC, id ASC`).all();
  res.json({ ok: true, menus: rows });
});

// ─── PATCH /api/admin/menus/:key ──────────────
const patchMenuSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  icon: z.string().trim().max(10).optional(),
  order_idx: z.number().int().min(0).max(999).optional(),
  enabled: z.number().int().min(0).max(1).optional(),
  min_role: z.enum(['user','admin']).optional(),
});
router.patch('/menus/:key', (req, res) => {
  const key = req.params.key;
  const target = db.prepare(`SELECT id FROM menus WHERE key = ?`).get(key);
  if (!target) return res.status(404).json({ ok: false, error: 'MENU_NOT_FOUND' });

  const parsed = patchMenuSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const updates = [];
  const args = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    updates.push(`${k} = ?`);
    args.push(v);
  }
  if (!updates.length) return res.json({ ok: true, unchanged: true });
  updates.push('updated_at = ?');
  args.push(Date.now());
  args.push(key);
  db.prepare(`UPDATE menus SET ${updates.join(', ')} WHERE key = ?`).run(...args);
  logAudit({ userId: req.user.id, action: 'admin_update_menu', target: key, meta: parsed.data, ip: clientIp(req) });

  const updated = db.prepare(`SELECT * FROM menus WHERE key = ?`).get(key);
  res.json({ ok: true, menu: updated });
});

// ─── GET /api/admin/logs ──────────────────────
router.get('/logs', (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize) || 30));
  const action   = (req.query.action || '').toString();

  const where = [];
  const args = [];
  if (action) { where.push('action = ?'); args.push(action); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`).get(...args).c;
  const rows = db.prepare(`
    SELECT l.id, l.user_id, u.email, u.nickname, l.action, l.target, l.meta, l.ip, l.created_at
    FROM audit_logs l
    LEFT JOIN users u ON u.id = l.user_id
    ${whereSql}
    ORDER BY l.id DESC
    LIMIT ? OFFSET ?
  `).all(...args, pageSize, (page - 1) * pageSize);

  res.json({ ok: true, page, pageSize, total, logs: rows });
});

// ─── GET /api/admin/ai-usage ─────────────────
//  query: range=today|week|month|all (default: month)
//  반환: { summary, byUser: [{user_id,email,nickname,calls,prompt,completion,total,cost}], byModel, byEndpoint, dailySeries }
router.get('/ai-usage', async (req, res) => {
  const range = (req.query.range || 'month').toString();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const since =
    range === 'today' ? new Date().setHours(0, 0, 0, 0) :
    range === 'week'  ? now - 7 * DAY :
    range === 'all'   ? 0 :
                        now - 30 * DAY;

  const summary = db.prepare(`
    SELECT
      COUNT(*)              AS calls,
      COALESCE(SUM(prompt_tokens), 0)     AS prompt,
      COALESCE(SUM(completion_tokens), 0) AS completion,
      COALESCE(SUM(total_tokens), 0)      AS total,
      COALESCE(SUM(cost_usd), 0)          AS cost
    FROM ai_usage WHERE created_at >= ?
  `).get(since);

  const byUser = db.prepare(`
    SELECT
      a.user_id,
      u.email,
      u.nickname,
      COUNT(*)                            AS calls,
      COALESCE(SUM(a.prompt_tokens), 0)     AS prompt,
      COALESCE(SUM(a.completion_tokens), 0) AS completion,
      COALESCE(SUM(a.total_tokens), 0)      AS total,
      COALESCE(SUM(a.cost_usd), 0)          AS cost,
      MAX(a.created_at)                   AS last_used
    FROM ai_usage a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.created_at >= ?
    GROUP BY a.user_id
    ORDER BY cost DESC, total DESC
    LIMIT 200
  `).all(since);

  const byModel = db.prepare(`
    SELECT model,
           COUNT(*) AS calls,
           COALESCE(SUM(total_tokens), 0) AS total,
           COALESCE(SUM(cost_usd), 0)     AS cost
    FROM ai_usage WHERE created_at >= ?
    GROUP BY model
    ORDER BY cost DESC
  `).all(since);

  const byEndpoint = db.prepare(`
    SELECT endpoint,
           COUNT(*) AS calls,
           COALESCE(SUM(total_tokens), 0) AS total,
           COALESCE(SUM(cost_usd), 0)     AS cost
    FROM ai_usage WHERE created_at >= ?
    GROUP BY endpoint
    ORDER BY cost DESC
  `).all(since);

  // 일자별 시리즈 (최근 30일 고정)
  const seriesSince = now - 30 * DAY;
  const rawSeries = db.prepare(`
    SELECT
      CAST((created_at - ?) / ? AS INTEGER) AS bucket,
      COUNT(*) AS calls,
      COALESCE(SUM(cost_usd), 0) AS cost
    FROM ai_usage
    WHERE created_at >= ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(seriesSince, DAY, seriesSince);
  const seriesMap = Object.fromEntries(rawSeries.map(r => [r.bucket, r]));
  const dailySeries = [];
  for (let i = 0; i < 30; i++) {
    const r = seriesMap[i] || { calls: 0, cost: 0 };
    dailySeries.push({
      date: new Date(seriesSince + i * DAY).toISOString().slice(0, 10),
      calls: r.calls,
      cost: r.cost,
    });
  }

  // 최근 호출 50건 (컨텍스트 포함)
  const recent = db.prepare(`
    SELECT a.id, a.endpoint, a.model,
           a.prompt_tokens, a.completion_tokens, a.total_tokens,
           a.cost_usd, a.context, a.created_at,
           a.user_id, u.email, u.nickname
    FROM ai_usage a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.created_at >= ?
    ORDER BY a.id DESC
    LIMIT 50
  `).all(since);

  const fx = await getUsdKrwRate();
  res.json({ ok: true, range, since, summary, byUser, byModel, byEndpoint, dailySeries, recent, pricing: GEMINI_PRICING, fx });
});

// ─── USD → KRW 환율 캐시 (1시간) ─────────────
let _fxCache = { rate: 0, ts: 0, source: '' };
async function getUsdKrwRate() {
  const now = Date.now();
  if (_fxCache.rate && now - _fxCache.ts < 60 * 60 * 1000) return _fxCache;
  const envRate = parseFloat(process.env.USD_KRW_RATE || '0');
  if (envRate > 0) {
    _fxCache = { rate: envRate, ts: now, source: 'env' };
    return _fxCache;
  }
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1d&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const j = await r.json();
    const rate = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (rate && rate > 0) {
      _fxCache = { rate, ts: now, source: 'yahoo' };
      return _fxCache;
    }
  } catch (e) {}
  _fxCache = { rate: 1400, ts: now, source: 'default' };
  return _fxCache;
}

// ─── GET /api/admin/costs ────────────────────
//  전체 운영 비용 요약 — AI(실측) + 외부 서비스(수동 추정)
//  환경변수로 월정액 입력 가능: RAILWAY_MONTHLY_USD, FMP_MONTHLY_USD, RESEND_MONTHLY_USD
router.get('/costs', async (req, res) => {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const prevMonthStart = new Date(monthStart); prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  const aiToday = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) c FROM ai_usage WHERE created_at >= ?`).get(todayStart.getTime()).c;
  const aiWeek  = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) c FROM ai_usage WHERE created_at >= ?`).get(now - 7 * DAY).c;
  const aiMonth = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) c FROM ai_usage WHERE created_at >= ?`).get(monthStart.getTime()).c;
  const aiPrevMonth = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) c FROM ai_usage WHERE created_at >= ? AND created_at < ?`)
    .get(prevMonthStart.getTime(), monthStart.getTime()).c;
  const aiAll   = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) c FROM ai_usage`).get().c;

  // 외부 고정비 (env 로 조정, 기본값 0)
  const fixed = {
    railway: parseFloat(process.env.RAILWAY_MONTHLY_USD || '0') || 0,
    fmp:     parseFloat(process.env.FMP_MONTHLY_USD || '0') || 0,
    resend:  parseFloat(process.env.RESEND_MONTHLY_USD || '0') || 0,
    gemini_free_credit: parseFloat(process.env.GEMINI_FREE_CREDIT_USD || '0') || 0,
  };
  const fixedMonthly = fixed.railway + fixed.fmp + fixed.resend;

  // 월별 추이 (최근 6개월)
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const s = new Date(monthStart); s.setMonth(s.getMonth() - i);
    const e = new Date(s); e.setMonth(e.getMonth() + 1);
    const c = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) c, COUNT(*) n FROM ai_usage WHERE created_at >= ? AND created_at < ?`)
      .get(s.getTime(), e.getTime());
    months.push({
      month: `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}`,
      aiCost: c.c,
      aiCalls: c.n,
    });
  }

  const fx = await getUsdKrwRate();
  res.json({
    ok: true,
    ai: {
      today: aiToday,
      week: aiWeek,
      month: aiMonth,
      prevMonth: aiPrevMonth,
      allTime: aiAll,
    },
    fixed,
    fixedMonthly,
    totalMonthEstimate: aiMonth + fixedMonthly,
    monthlySeries: months,
    fx,
  });
});

// ─── GET /api/admin/errors ───────────────────
//  query: page, pageSize, level, source, resolved(0|1|all), q
router.get('/errors', (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize) || 30));
  const level    = (req.query.level || '').toString();
  const source   = (req.query.source || '').toString();
  const resolved = (req.query.resolved || '').toString();
  const q        = (req.query.q || '').toString().trim();

  const where = [];
  const args = [];
  if (level)  { where.push('level = ?');  args.push(level); }
  if (source) { where.push('source = ?'); args.push(source); }
  if (resolved === '0' || resolved === '1') { where.push('resolved = ?'); args.push(parseInt(resolved)); }
  if (q)      { where.push('(message LIKE ? OR url LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM error_logs ${whereSql}`).get(...args).c;
  const rows = db.prepare(`
    SELECT id, level, source, message, stack, url, method, status, user_id, ip, resolved, created_at
    FROM error_logs ${whereSql}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...args, pageSize, (page - 1) * pageSize);

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS unresolved,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last24h
    FROM error_logs
  `).get(Date.now() - 24 * 60 * 60 * 1000);

  res.json({ ok: true, page, pageSize, total, errors: rows, summary });
});

// PATCH /errors/:id  { resolved: 0|1 }
router.patch('/errors/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  const resolved = req.body?.resolved === 1 || req.body?.resolved === true ? 1 : 0;
  db.prepare(`UPDATE error_logs SET resolved = ? WHERE id = ?`).run(resolved, id);
  res.json({ ok: true });
});

// DELETE /errors  (?before=timestamp 또는 ?resolved=1)
router.delete('/errors', (req, res) => {
  const before = parseInt(req.query.before) || 0;
  const onlyResolved = req.query.resolved === '1';
  const where = [];
  const args = [];
  if (before)       { where.push('created_at < ?'); args.push(before); }
  if (onlyResolved) { where.push('resolved = 1'); }
  if (!where.length) return res.status(400).json({ ok: false, error: 'NEED_FILTER' });
  const r = db.prepare(`DELETE FROM error_logs WHERE ${where.join(' AND ')}`).run(...args);
  res.json({ ok: true, deleted: r.changes });
});

// ─── GET /api/admin/service-status ───────────
//  외부 API 키 설정 상태 + 최근 에러 카운트 + FMP rate limit 상태
router.get('/service-status', (req, res) => {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const errorsLast24h = db.prepare(`
    SELECT source, COUNT(*) AS c
    FROM error_logs
    WHERE created_at >= ?
    GROUP BY source
  `).all(now - 24 * HOUR);
  const errorsByHour = db.prepare(`
    SELECT source, COUNT(*) AS c
    FROM error_logs
    WHERE created_at >= ?
    GROUP BY source
  `).all(now - HOUR);

  const services = [
    { key: 'fmp',     name: 'FMP (재무 API)',      configured: !!process.env.FMP_API_KEY },
    { key: 'gemini',  name: 'Gemini (AI)',         configured: !!process.env.GEMINI_API_KEY },
    { key: 'resend',  name: 'Resend (이메일)',     configured: !!process.env.RESEND_API_KEY },
    { key: 'yahoo',   name: 'Yahoo Finance (시세)', configured: true },
    { key: 'session', name: 'Session 쿠키',        configured: !!process.env.SESSION_SECRET },
  ];
  const errMap24 = Object.fromEntries(errorsLast24h.map(r => [r.source, r.c]));
  const errMap1  = Object.fromEntries(errorsByHour.map(r => [r.source, r.c]));
  services.forEach(s => {
    s.errors24h = errMap24[s.key] || 0;
    s.errors1h  = errMap1[s.key] || 0;
  });

  const uptimeSec = Math.floor(process.uptime());
  const mem = process.memoryUsage();

  res.json({
    ok: true,
    services,
    system: {
      uptimeSec,
      uptimeHuman: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
      memoryMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      nodeVersion: process.version,
      pid: process.pid,
    },
    totals: {
      users: db.prepare(`SELECT COUNT(*) c FROM users`).get().c,
      aiCallsToday: db.prepare(`SELECT COUNT(*) c FROM ai_usage WHERE created_at >= ?`).get(new Date().setHours(0,0,0,0)).c,
      errorsLast24h: db.prepare(`SELECT COUNT(*) c FROM error_logs WHERE created_at >= ?`).get(now - 24 * HOUR).c,
    },
  });
});

// ─── GET /api/admin/notices ──────────────────
router.get('/notices', (_req, res) => {
  const rows = db.prepare(`SELECT * FROM notices ORDER BY id DESC`).all();
  res.json({ ok: true, notices: rows });
});

const noticeSchema = z.object({
  title: z.string().trim().min(1).max(100),
  body: z.string().max(2000).optional().default(''),
  level: z.enum(['info', 'warn', 'danger']).optional().default('info'),
  enabled: z.number().int().min(0).max(1).optional().default(1),
  starts_at: z.number().int().nullable().optional(),
  ends_at: z.number().int().nullable().optional(),
});
router.post('/notices', (req, res) => {
  const parsed = noticeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const d = parsed.data;
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO notices (title, body, level, enabled, starts_at, ends_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(d.title, d.body || '', d.level, d.enabled, d.starts_at || null, d.ends_at || null, now, now);
  logAudit({ userId: req.user.id, action: 'admin_create_notice', target: String(r.lastInsertRowid), meta: d, ip: clientIp(req) });
  res.json({ ok: true, id: r.lastInsertRowid });
});
router.patch('/notices/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  const parsed = noticeSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const updates = [];
  const args = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    updates.push(`${k} = ?`);
    args.push(v);
  }
  if (!updates.length) return res.json({ ok: true, unchanged: true });
  updates.push('updated_at = ?'); args.push(Date.now());
  args.push(id);
  db.prepare(`UPDATE notices SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  logAudit({ userId: req.user.id, action: 'admin_update_notice', target: String(id), meta: parsed.data, ip: clientIp(req) });
  res.json({ ok: true });
});
router.delete('/notices/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  db.prepare(`DELETE FROM notices WHERE id = ?`).run(id);
  logAudit({ userId: req.user.id, action: 'admin_delete_notice', target: String(id), ip: clientIp(req) });
  res.json({ ok: true });
});

// ─── POST /api/admin/change-email ────────────
router.post('/change-email', async (req, res) => {
  const schema = z.object({
    newEmail: z.string().email().max(120),
    currentPassword: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const { newEmail, currentPassword } = parsed.data;

  const me = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  const ok = await bcrypt.compare(currentPassword, me.pw_hash || '');
  if (!ok) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });

  const dup = db.prepare(`SELECT id FROM users WHERE email = ? AND id != ?`).get(newEmail, req.user.id);
  if (dup) return res.status(409).json({ ok: false, error: 'EMAIL_IN_USE' });

  db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(newEmail, req.user.id);
  logAudit({ userId: req.user.id, action: 'admin_change_email', target: newEmail, ip: clientIp(req) });
  res.json({ ok: true, email: newEmail });
});

// ─── GET /api/admin/analytics ────────────────
//  MAU/DAU + 인기 종목/키워드 집계
//  기준 데이터: events (사용자 행동) + ai_usage (AI 호출) + users.last_login
router.get('/analytics', (_req, res) => {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  // 활성 사용자 정의: events 에 기록 있거나 해당 구간에 로그인한 user_id
  const activeUsers = (sinceMs) => {
    const row = db.prepare(`
      SELECT COUNT(DISTINCT uid) AS c FROM (
        SELECT user_id AS uid FROM events WHERE user_id IS NOT NULL AND created_at >= ?
        UNION
        SELECT id       AS uid FROM users  WHERE last_login IS NOT NULL AND last_login >= ?
      )
    `).get(sinceMs, sinceMs);
    return row.c;
  };

  const dau = activeUsers(now - DAY);
  const wau = activeUsers(now - 7 * DAY);
  const mau = activeUsers(now - 30 * DAY);

  // 일별 활성 사용자 추이 (최근 30일)
  const dailyActive = [];
  for (let i = 29; i >= 0; i--) {
    const dayStart = new Date(now - i * DAY); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = dayStart.getTime() + DAY;
    const row = db.prepare(`
      SELECT COUNT(DISTINCT uid) AS c FROM (
        SELECT user_id AS uid FROM events WHERE user_id IS NOT NULL AND created_at >= ? AND created_at < ?
        UNION
        SELECT id       AS uid FROM users  WHERE last_login IS NOT NULL AND last_login >= ? AND last_login < ?
      )
    `).get(dayStart.getTime(), dayEnd, dayStart.getTime(), dayEnd);
    dailyActive.push({
      date: dayStart.toISOString().slice(0, 10),
      users: row.c,
    });
  }

  // 최근 30일 Top 종목 조회
  const since30 = now - 30 * DAY;
  const topStocks = db.prepare(`
    SELECT target AS symbol,
           COUNT(*) AS views,
           COUNT(DISTINCT user_id) AS uniqueUsers
    FROM events
    WHERE type = 'view_profile' AND target IS NOT NULL AND created_at >= ?
    GROUP BY target
    ORDER BY views DESC
    LIMIT 20
  `).all(since30);

  // 최근 30일 Top 검색 키워드
  const topKeywords = db.prepare(`
    SELECT target AS keyword,
           COUNT(*) AS count,
           COUNT(DISTINCT user_id) AS uniqueUsers
    FROM events
    WHERE type = 'search' AND target IS NOT NULL AND created_at >= ?
    GROUP BY target
    ORDER BY count DESC
    LIMIT 20
  `).all(since30);

  // 최근 30일 AI 분석 인기 종목
  const topAiStocks = db.prepare(`
    SELECT target AS symbol,
           COUNT(*) AS count,
           COUNT(DISTINCT user_id) AS uniqueUsers
    FROM events
    WHERE type = 'ai_analyze' AND target IS NOT NULL AND created_at >= ?
    GROUP BY target
    ORDER BY count DESC
    LIMIT 10
  `).all(since30);

  // 이벤트 타입별 총 건수 (최근 30일)
  const eventsByType = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM events
    WHERE created_at >= ?
    GROUP BY type
    ORDER BY count DESC
  `).all(since30);

  // 총 이벤트 수
  const totalEvents30d = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE created_at >= ?`).get(since30).c;

  // 가입 전환 (최근 30일 가입 수)
  const signups30d = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE created_at >= ?`).get(since30).c;

  res.json({
    ok: true,
    summary: {
      dau, wau, mau,
      totalEvents30d,
      signups30d,
      stickiness: mau > 0 ? +(dau / mau * 100).toFixed(1) : 0,  // DAU/MAU ratio
    },
    dailyActive,
    topStocks,
    topKeywords,
    topAiStocks,
    eventsByType,
  });
});

// ─── 투자 가이드 글 관리 ─────────────────────
router.get('/articles', (_req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.email AS author_email
    FROM articles a LEFT JOIN users u ON u.id = a.author_id
    ORDER BY a.id DESC
  `).all();
  res.json({ ok: true, articles: rows });
});
const articleSchema = z.object({
  slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/, 'slug 은 영문 소문자·숫자·하이픈만'),
  category: z.enum(['basics','chart','value','risk','master','psych']).default('basics'),
  emoji: z.string().trim().min(1).max(8).default('📖'),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(500).optional().default(''),
  body: z.string().max(20000).optional().default(''),
  read_min: z.number().int().min(1).max(60).optional().default(4),
  status: z.enum(['draft','published','archived']).optional().default('draft'),
});
router.post('/articles', (req, res) => {
  const parsed = articleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', issues: parsed.error.issues });
  const d = parsed.data;
  const now = Date.now();
  try {
    const r = db.prepare(`
      INSERT INTO articles (slug, category, emoji, title, summary, body, read_min, status, author_id, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(d.slug, d.category, d.emoji, d.title, d.summary, d.body, d.read_min, d.status, req.user.id, now, now, d.status === 'published' ? now : null);
    logAudit({ userId: req.user.id, action: 'admin_create_article', target: d.slug, ip: clientIp(req) });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ ok: false, error: 'SLUG_EXISTS' });
    throw e;
  }
});
router.patch('/articles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const parsed = articleSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const cur = db.prepare(`SELECT * FROM articles WHERE id = ?`).get(id);
  if (!cur) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const updates = []; const args = [];
  for (const [k, v] of Object.entries(parsed.data)) { updates.push(`${k} = ?`); args.push(v); }
  updates.push('updated_at = ?'); args.push(Date.now());
  // 발행 시점 갱신
  if (parsed.data.status === 'published' && !cur.published_at) {
    updates.push('published_at = ?'); args.push(Date.now());
  }
  args.push(id);
  db.prepare(`UPDATE articles SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  logAudit({ userId: req.user.id, action: 'admin_update_article', target: String(id), meta: parsed.data, ip: clientIp(req) });
  res.json({ ok: true });
});
router.delete('/articles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare(`DELETE FROM articles WHERE id = ?`).run(id);
  logAudit({ userId: req.user.id, action: 'admin_delete_article', target: String(id), ip: clientIp(req) });
  res.json({ ok: true });
});

// POST /api/admin/articles/draft → AI 초안 생성 (저장 X)
//  body: { topic, category, angle, readMin }
router.post('/articles/draft', async (req, res) => {
  try {
    const { topic, category, angle, readMin } = req.body || {};
    if (!topic) return res.status(400).json({ ok: false, error: 'topic 필요' });
    const fetchFn = globalThis.fetch || require('node-fetch');
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY 미설정' });

    const categoryNames = {
      basics: '기초', chart: '차트', value: '가치 평가', risk: '리스크', master: '대가의 원칙', psych: '투자 심리',
    };
    const categoryLabel = categoryNames[category] || '기초';

    const prompt = `당신은 한국 주식 투자 초보자를 위한 블로그 작가입니다.
아래 주제로 ${readMin || 5}분 분량의 블로그 글을 작성해주세요.

[주제] ${topic}
[카테고리] ${categoryLabel}
${angle ? `[관점/포인트] ${angle}` : ''}

[출력 형식 — 반드시 JSON 만 출력. 다른 텍스트 금지]
{
  "title": "매력적인 제목 (60자 이내)",
  "summary": "글의 한 줄 요약 (80자 이내)",
  "emoji": "글의 성격에 맞는 이모지 1개",
  "body": "HTML 형식 본문. <p>, <h3>, <ul><li>, <b>, <code>, <div class='tip'>💡 ...</div>, <div class='warn'>⚠️ ...</div> 태그만 사용. 문단 사이 구분은 <h3> 로. 구체적 수치·예시 포함. 투자 권유 금지."
}`;

    const r = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 3000, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Gemini ${r.status}: ${t.slice(0, 200)}`);
    }
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // 사용량 기록 — 관리자가 AI 로 글쓰기 한 것도 총 비용에 반영
    const um = j?.usageMetadata || {};
    logAiUsage({
      userId: req.user?.id || null,
      endpoint: 'ai-article-draft',
      model: 'gemini-2.5-flash',
      promptTokens: um.promptTokenCount || 0,
      completionTokens: um.candidatesTokenCount || 0,
      totalTokens: um.totalTokenCount || 0,
      context: { topic: (topic || '').slice(0,200), category, readMin },
    });
    // 가끔 ```json 래퍼가 붙음
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { throw new Error('AI 응답 파싱 실패 — 다시 시도해주세요'); }

    // slug 자동 생성 — 한글/특수문자 모두 제거하고 영문·숫자·하이픈만 허용
    //  (articleSchema 의 정규식 ^[a-z0-9-]+$ 준수)
    let base = (parsed.title || topic || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')  // 영문·숫자 이외 전부 하이픈
      .replace(/-+/g, '-')           // 연속 하이픈 압축
      .replace(/^-+|-+$/g, '');      // 양끝 하이픈 제거
    // 한글 제목이라 base 가 비면 timestamp 로 대체
    if (!base) base = 'post-' + Date.now().toString(36);
    const slug = `${category || 'basics'}-${base}`.slice(0, 80).replace(/-+$/g, '');

    res.json({
      ok: true,
      draft: {
        title: parsed.title || topic,
        summary: parsed.summary || '',
        emoji: parsed.emoji || '📖',
        body: parsed.body || '',
        category: category || 'basics',
        read_min: readMin || 5,
        slug,
        status: 'draft',
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── 고객 문의 관리 ───────────────────────────
router.get('/inquiries', (req, res) => {
  const status = (req.query.status || '').toString();
  const where = [];
  const args = [];
  if (status && ['open','in_progress','resolved','closed'].includes(status)) {
    where.push('i.status = ?'); args.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT i.*, u.email AS user_email, u.nickname AS user_nickname
    FROM inquiries i LEFT JOIN users u ON u.id = i.user_id
    ${whereSql}
    ORDER BY i.id DESC LIMIT 200
  `).all(...args);
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_,
      SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved
    FROM inquiries
  `).get();
  res.json({ ok: true, inquiries: rows, summary });
});
router.patch('/inquiries/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const schema = z.object({
    status: z.enum(['open','in_progress','resolved','closed']).optional(),
    admin_reply: z.string().max(4000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  const cur = db.prepare(`SELECT * FROM inquiries WHERE id = ?`).get(id);
  if (!cur) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const updates = []; const args = [];
  if (parsed.data.status != null) { updates.push('status = ?'); args.push(parsed.data.status); }
  if (parsed.data.admin_reply != null) {
    updates.push('admin_reply = ?'); args.push(parsed.data.admin_reply);
    updates.push('replied_at = ?'); args.push(Date.now());
    updates.push('replied_by = ?'); args.push(req.user.id);
  }
  if (!updates.length) return res.json({ ok: true, unchanged: true });
  updates.push('updated_at = ?'); args.push(Date.now());
  args.push(id);
  db.prepare(`UPDATE inquiries SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  logAudit({ userId: req.user.id, action: 'admin_update_inquiry', target: String(id), meta: parsed.data, ip: clientIp(req) });
  res.json({ ok: true });
});

// ─── POST /api/admin/change-password ──────────
//  현재 어드민 본인 비밀번호 변경 (시드 계정 changeme1234 교체용)
router.post('/change-password', async (req, res) => {
  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8)
      .regex(/[A-Za-z]/, 'needs letter')
      .regex(/[0-9]/, 'needs number'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });

  const me = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  const ok = await bcrypt.compare(parsed.data.currentPassword, me.pw_hash || '');
  if (!ok) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });

  const pwHash = await bcrypt.hash(parsed.data.newPassword, 12);
  db.prepare(`UPDATE users SET pw_hash = ? WHERE id = ?`).run(pwHash, req.user.id);
  logAudit({ userId: req.user.id, action: 'admin_self_password_change', ip: clientIp(req) });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
//  스크립트 실행 — Railway 서버에서 Phase 2 수집 트리거용
//  (로컬 IP 가 Yahoo 에 차단돼도 Railway 컨테이너 IP 는 통과)
//  허용 스크립트 화이트리스트 / 환경변수 화이트리스트 / 1회 1개만 실행
// ═══════════════════════════════════════════════════════════════
const { spawn } = require('child_process');
const path = require('path');

const ALLOWED_SCRIPTS = new Set([
  'fetch-krx-universe',
  'fetch-kr-etfs',
  'fetch-kr-stocks',
  'fetch-us-stocks',
]);
const ALLOWED_ENV = new Set([
  'KR_LIMIT', 'KR_DELAY_MS', 'KR_SYMBOLS',
  'US_LIMIT', 'US_DELAY_MS',
  'YAHOO_COOKIE', 'YAHOO_CRUMB', 'YAHOO_DEBUG',
]);

// in-memory 실행 상태 — 한 번에 하나만
let currentRun = null;   // { pid, script, startedAt, env, logs: string[], status, exitCode, endedAt }

function appendLog(line) {
  if (!currentRun) return;
  currentRun.logs.push(line);
  if (currentRun.logs.length > 2000) currentRun.logs.splice(0, currentRun.logs.length - 2000);
}

router.post('/script/start', (req, res) => {
  const { script, env = {} } = req.body || {};
  if (!ALLOWED_SCRIPTS.has(script)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SCRIPT', allowed: [...ALLOWED_SCRIPTS] });
  }
  if (currentRun && currentRun.status === 'running') {
    return res.status(409).json({ ok: false, error: 'ALREADY_RUNNING', current: { script: currentRun.script, pid: currentRun.pid, startedAt: currentRun.startedAt } });
  }

  const filteredEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (ALLOWED_ENV.has(k)) filteredEnv[k] = String(v);
  }

  const scriptsDir = path.join(__dirname, 'scripts');
  const scriptFile = path.join(scriptsDir, `${script}.js`);
  const child = spawn('node', [scriptFile], {
    cwd: __dirname,  // server 루트 (DB 파일 위치)
    env: { ...process.env, ...filteredEnv },
  });

  currentRun = {
    pid: child.pid,
    script,
    env: filteredEnv,
    startedAt: Date.now(),
    logs: [],
    status: 'running',
    exitCode: null,
    endedAt: null,
  };

  logAudit({ userId: req.user.id, action: 'admin_script_start', target: script, meta: { env: filteredEnv, pid: child.pid }, ip: clientIp(req) });

  child.stdout.on('data', d => appendLog(d.toString()));
  child.stderr.on('data', d => appendLog(`[stderr] ${d.toString()}`));
  child.on('exit', code => {
    if (currentRun && currentRun.pid === child.pid) {
      currentRun.status = code === 0 ? 'succeeded' : 'failed';
      currentRun.exitCode = code;
      currentRun.endedAt = Date.now();
      appendLog(`\n[exit] code=${code}`);
    }
  });
  child.on('error', err => {
    appendLog(`[spawn error] ${err.message}`);
    if (currentRun && currentRun.pid === child.pid) {
      currentRun.status = 'failed';
      currentRun.endedAt = Date.now();
    }
  });

  res.json({ ok: true, pid: child.pid, script, startedAt: currentRun.startedAt });
});

router.get('/script/status', (req, res) => {
  if (!currentRun) return res.json({ ok: true, run: null });
  const tailLines = Math.max(1, Math.min(500, parseInt(req.query.tail, 10) || 50));
  const logs = currentRun.logs.slice(-tailLines).join('');
  res.json({
    ok: true,
    run: {
      script: currentRun.script,
      pid: currentRun.pid,
      status: currentRun.status,
      exitCode: currentRun.exitCode,
      startedAt: currentRun.startedAt,
      endedAt: currentRun.endedAt,
      durationMs: (currentRun.endedAt || Date.now()) - currentRun.startedAt,
      env: currentRun.env,
      logs,
    },
  });
});

router.post('/script/stop', (req, res) => {
  if (!currentRun || currentRun.status !== 'running') {
    return res.status(400).json({ ok: false, error: 'NOT_RUNNING' });
  }
  try {
    process.kill(currentRun.pid, 'SIGTERM');
    currentRun.status = 'stopped';
    currentRun.endedAt = Date.now();
    appendLog('\n[stopped by admin]');
    logAudit({ userId: req.user.id, action: 'admin_script_stop', target: currentRun.script, meta: { pid: currentRun.pid }, ip: clientIp(req) });
    res.json({ ok: true, pid: currentRun.pid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── GET /api/admin/ops/dbinfo — DB 경로·볼륨 진단 ─────────────
//  Railway 볼륨 마운트 여부 확인용. DB_PATH 가 /app/... 이면 컨테이너
//  내부(배포마다 초기화 위험), /data/... 같이 볼륨이면 영속성 OK.
router.get('/ops/dbinfo', (req, res) => {
  try {
    const st = fs.statSync(DB_PATH);
    const counts = {
      users:         db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c,
      holdings:      db.prepare(`SELECT COUNT(*) AS c FROM user_holdings`).get().c,
      transactions:  db.prepare(`SELECT COUNT(*) AS c FROM transactions`).get().c,
      favorites:     db.prepare(`SELECT COUNT(*) AS c FROM user_favorites`).get().c,
      stocks:        db.prepare(`SELECT COUNT(*) AS c FROM stocks`).get().c,
    };
    const onVolume = /^\/data(\/|$)/.test(DB_PATH) || /^\/mnt\//.test(DB_PATH) || !!process.env.DATA_DIR;
    res.json({
      ok: true,
      dbPath: DB_PATH,
      dataDirEnv: process.env.DATA_DIR || null,
      sizeBytes: st.size,
      sizeMB: +(st.size / 1024 / 1024).toFixed(2),
      lastModified: new Date(st.mtimeMs).toISOString(),
      inode: st.ino,                     // 재배포 후에도 같으면 볼륨, 다르면 컨테이너 내부
      onVolume,                          // heuristic 판단
      nodeEnv: process.env.NODE_ENV || null,
      counts,
      warning: onVolume ? null : '⚠️ DB 가 컨테이너 내부 경로로 보입니다. Railway 볼륨이 마운트되지 않았다면 재배포 시 사용자 데이터 유실 위험!',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
