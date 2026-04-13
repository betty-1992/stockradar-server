// ════════════════════════════════════════════════
//  Admin 라우트 — /api/admin/*  (requireAdmin 필수)
// ════════════════════════════════════════════════
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { db, logAudit, GEMINI_PRICING } = require('./db');
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

module.exports = router;
