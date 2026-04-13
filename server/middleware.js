// ════════════════════════════════════════════════
//  인증/권한 미들웨어
// ════════════════════════════════════════════════
const { db } = require('./db');

// 세션에 user.id 가 있으면 req.user 로 hydrate
function attachUser(req, _res, next) {
  if (req.session?.userId) {
    const u = db.prepare(`
      SELECT id, email, nickname, role, status, email_verified, provider, terms_accepted_at, created_at, last_login
      FROM users WHERE id = ?
    `).get(req.session.userId);
    if (u && u.status === 'active') {
      req.user = u;
    } else if (u && u.status !== 'active') {
      // 차단된 계정은 세션 강제 무효화
      req.session.destroy(() => {});
      req.user = null;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'ADMIN_ONLY' });
  next();
}

// 간단한 요청 IP 추출
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
      || req.socket?.remoteAddress
      || null;
}

module.exports = { attachUser, requireAuth, requireAdmin, clientIp };
