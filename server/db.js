// ════════════════════════════════════════════════
//  SQLite — better-sqlite3 기반 영구 저장소
// ════════════════════════════════════════════════
//  파일: server/data.db (자동 생성)
//  동기 API라 try/catch 로 감싸거나 트랜잭션으로 사용
//  배포 시엔 볼륨 마운트한 경로에 data.db 가 있어야 영구 저장됨
// ════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// 영구 저장소 위치
//  - 로컬: server/data.db
//  - 배포(Railway 등): DATA_DIR 환경변수로 볼륨 경로 지정 → /data/data.db
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'data.db');
const db = new Database(DB_PATH);

// 권장 PRAGMA — 동시성/안정성 향상
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ─── 스키마 마이그레이션 ─────────────────────────
//  user_version 을 이용한 단순 버전 기반 마이그레이션
//  새 버전을 추가할 때 migrations 배열 끝에 함수 append 만 하면 됨
//  현재 버전: v11 (stocks 재무지표 peg/fcf 컬럼 추가)
const migrations = [
  // v1 — 초기 스키마
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        email        TEXT UNIQUE NOT NULL,
        pw_hash      TEXT,
        nickname     TEXT NOT NULL,
        role         TEXT NOT NULL DEFAULT 'user',
        status       TEXT NOT NULL DEFAULT 'active',
        provider     TEXT NOT NULL DEFAULT 'local',
        provider_id  TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        last_login   INTEGER,
        login_count  INTEGER NOT NULL DEFAULT 0,
        UNIQUE(provider, provider_id)
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

      CREATE TABLE IF NOT EXISTS user_keywords (
        user_id    INTEGER NOT NULL,
        keyword    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, keyword),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_favorites (
        user_id    INTEGER NOT NULL,
        stock_id   TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, stock_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER,
        action     TEXT NOT NULL,
        target     TEXT,
        meta       TEXT,
        ip         TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

      CREATE TABLE IF NOT EXISTS menus (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT UNIQUE NOT NULL,
        label      TEXT NOT NULL,
        icon       TEXT,
        order_idx  INTEGER NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        min_role   TEXT NOT NULL DEFAULT 'user',
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS email_verifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        email      TEXT NOT NULL,
        code       TEXT NOT NULL,
        purpose    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_email_verif_email ON email_verifications(email);
    `);
  },
  // v2 — AI 사용량 트래킹
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER,
        endpoint          TEXT NOT NULL,
        model             TEXT NOT NULL,
        prompt_tokens     INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens      INTEGER NOT NULL DEFAULT 0,
        cost_usd          REAL NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
    `);
  },
  // v3 — 에러 로그 + 공지사항
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        level      TEXT NOT NULL DEFAULT 'error',
        source     TEXT,
        message    TEXT NOT NULL,
        stack      TEXT,
        url        TEXT,
        method     TEXT,
        status     INTEGER,
        user_id    INTEGER,
        ip         TEXT,
        resolved   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_error_logs_resolved ON error_logs(resolved);
      CREATE INDEX IF NOT EXISTS idx_error_logs_source ON error_logs(source);

      CREATE TABLE IF NOT EXISTS notices (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        level      TEXT NOT NULL DEFAULT 'info',
        enabled    INTEGER NOT NULL DEFAULT 1,
        starts_at  INTEGER,
        ends_at    INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notices_enabled ON notices(enabled);
    `);
  },
  // v4 — 이벤트 로그 (조회/검색/분석 등 사용자 행동 트래킹)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER,
        type       TEXT NOT NULL,
        target     TEXT,
        meta       TEXT,
        ip         TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
      CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
    `);
  },
  // v5 — 프로필 완료 플래그 (소셜 가입 후 약관/닉네임 확인 단계)
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
      ALTER TABLE users ADD COLUMN marketing_agreed  INTEGER NOT NULL DEFAULT 0;
    `);
    // 기존 로컬 가입자는 가입 시 약관 동의했으므로 created_at 으로 백필
    db.exec(`UPDATE users SET terms_accepted_at = created_at WHERE terms_accepted_at IS NULL`);
  },
  // v6 — AI 호출 컨텍스트 (어떤 종목/질문인지)
  (db) => {
    db.exec(`ALTER TABLE ai_usage ADD COLUMN context TEXT`);
  },
  // v7 — 투자 가이드 글 (어드민에서 AI 로 작성·발행)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        slug         TEXT UNIQUE NOT NULL,
        category     TEXT NOT NULL DEFAULT 'basics',
        emoji        TEXT NOT NULL DEFAULT '📖',
        title        TEXT NOT NULL,
        summary      TEXT NOT NULL DEFAULT '',
        body         TEXT NOT NULL DEFAULT '',
        read_min     INTEGER NOT NULL DEFAULT 4,
        status       TEXT NOT NULL DEFAULT 'draft',  -- draft | published | archived
        author_id    INTEGER,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        published_at INTEGER,
        FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
      CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
      CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
    `);
  },
  // v8 — 고객 문의 (inquiries)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER,
        email         TEXT,
        category      TEXT NOT NULL DEFAULT 'general',
        subject       TEXT NOT NULL,
        message       TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'open',  -- open | in_progress | resolved | closed
        admin_reply   TEXT,
        replied_at    INTEGER,
        replied_by    INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY(replied_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);
      CREATE INDEX IF NOT EXISTS idx_inquiries_user ON inquiries(user_id);
      CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries(created_at);
    `);
  },
  // v9 — 포트폴리오(나의 투자) 보유 종목
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_holdings (
        user_id     INTEGER NOT NULL,
        stock_id    TEXT    NOT NULL,
        quantity    REAL    NOT NULL,
        avg_price   REAL    NOT NULL,
        memo        TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (user_id, stock_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_holdings_user ON user_holdings(user_id);
    `);
  },
  // v10 — 종목 마스터 DB 전환 (Phase 0)
  //   stocks: FMP/큐레이션 기반 종목 원천 데이터
  //   stock_curation: 수기 정성값 (score/geo/inst/note) 분리 — 재수집 시 덮어쓰기 방지
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stocks (
        symbol          TEXT    PRIMARY KEY,
        market          TEXT    NOT NULL,
        name            TEXT    NOT NULL,
        name_kr         TEXT,
        exchange        TEXT,
        sector          TEXT,
        industry        TEXT,
        market_cap      REAL,
        currency        TEXT,
        is_etf          INTEGER NOT NULL DEFAULT 0,
        etf_index       TEXT,
        tags            TEXT,
        per             REAL,
        pbr             REAL,
        roe             REAL,
        dividend_yield  REAL,
        revenue_growth  REAL,
        source          TEXT    NOT NULL DEFAULT 'unknown',
        is_curated      INTEGER NOT NULL DEFAULT 0,
        is_active       INTEGER NOT NULL DEFAULT 1,
        last_fetched_at INTEGER,
        last_seen_at    INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);
      CREATE INDEX IF NOT EXISTS idx_stocks_sector ON stocks(market, sector);
      CREATE INDEX IF NOT EXISTS idx_stocks_mcap   ON stocks(market_cap DESC);
      CREATE INDEX IF NOT EXISTS idx_stocks_active ON stocks(is_active, market);
      CREATE INDEX IF NOT EXISTS idx_stocks_etf    ON stocks(is_etf);

      CREATE TABLE IF NOT EXISTS stock_curation (
        symbol      TEXT    PRIMARY KEY,
        score       INTEGER,
        geo         INTEGER DEFAULT 0,
        inst        INTEGER DEFAULT 0,
        note        TEXT,
        updated_by  INTEGER,
        updated_at  INTEGER NOT NULL,
        FOREIGN KEY (symbol) REFERENCES stocks(symbol) ON DELETE CASCADE
      );
    `);
  },
  // v11 — Phase 2 대량 수집기 대비: 재무지표 peg/fcf 컬럼 추가
  //   peg : Price/Earnings to Growth (성장률 대비 PER)
  //   fcf : Free Cash Flow (단위: 해당 종목 통화의 절대값)
  (db) => {
    const cols = db.prepare("PRAGMA table_info(stocks)").all().map(r => r.name);
    if (!cols.includes('peg')) {
      db.exec(`ALTER TABLE stocks ADD COLUMN peg REAL;`);
    }
    if (!cols.includes('fcf')) {
      db.exec(`ALTER TABLE stocks ADD COLUMN fcf REAL;`);
    }
  },
  // v12 — 포트폴리오 거래 이력(transactions) + 실현 손익
  //  · user_holdings 는 현재 보유 스냅샷(quantity, avg_price)
  //  · transactions 는 매수/매도 이력. realized_pl 은 매도 시 (가격 - 평균매수가) × 수량
  //  · 평단은 평균원가법 — 매수 시 재계산, 매도 시 유지
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        stock_id    TEXT NOT NULL,
        side        TEXT NOT NULL CHECK (side IN ('buy','sell')),
        quantity    REAL NOT NULL,
        price       REAL NOT NULL,
        traded_at   INTEGER NOT NULL,
        realized_pl REAL,
        memo        TEXT,
        created_at  INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_user
        ON transactions(user_id, traded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_user_stock
        ON transactions(user_id, stock_id, traded_at);
    `);
  },
];

function runMigrations() {
  const cur = db.pragma('user_version', { simple: true });
  if (cur < migrations.length) {
    const tx = db.transaction(() => {
      for (let v = cur; v < migrations.length; v++) {
        console.log(`[db] migrating v${v} → v${v + 1}`);
        migrations[v](db);
      }
      db.pragma(`user_version = ${migrations.length}`);
    });
    tx();
    console.log(`[db] schema now at v${migrations.length}`);
  }
}
runMigrations();

// ─── 기본 메뉴 시드 ───────────────────────────────
// 페이지 key 는 프론트의 showPage() 가 받는 값과 일치해야 함
const DEFAULT_MENUS = [
  { key: 'home',     label: '홈',         icon: '🏠', order_idx: 1,  min_role: 'user' },
  { key: 'screener', label: '종목 발굴',   icon: '🔍', order_idx: 2,  min_role: 'user' },
  { key: 'sector',   label: '섹터 맵',     icon: '🗺',  order_idx: 3,  min_role: 'user' },
  { key: 'issue',    label: '트렌드 트래커', icon: '🔥', order_idx: 4,  min_role: 'user' },
  { key: 'guide',    label: '투자 가이드', icon: '📖', order_idx: 5,  min_role: 'user' },
];

function seedMenusIfEmpty() {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM menus`).get();
  if (row.c > 0) return;
  const ins = db.prepare(`
    INSERT INTO menus (key, label, icon, order_idx, enabled, min_role, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  const now = Date.now();
  const tx = db.transaction((rows) => {
    rows.forEach(r => ins.run(r.key, r.label, r.icon, r.order_idx, r.min_role, now));
  });
  tx(DEFAULT_MENUS);
  console.log(`[db] seeded ${DEFAULT_MENUS.length} menus`);
}
seedMenusIfEmpty();

// ─── 초기 어드민 계정 시드 ───────────────────────
//  ENV 에 ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD 가 있으면
//  서버 최초 실행 시 어드민 계정이 없을 때만 생성
// ─── 종목 마스터 자동 시드 ─────────────────────
//  마이그레이션 직후 stocks 테이블이 비어있으면 seed-stocks.js 자동 실행
//  배경: 2026-04-18 Phase 3 (/api/universe DB 전환) 배포 시 프로덕션 stocks 비어있어
//        total=0 반환하는 장애 발생 → 즉시 revert. 재발 방지용.
//  child_process 격리 — seed-stocks.js 의 별도 better-sqlite3 connection 충돌 회피
//  DB_PATH 환경변수 전달 — 동일 DB 파일 보장
function seedStocksIfEmpty() {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM stocks`).get();
    if (row.c > 0) return;
    console.log('[db] stocks 테이블 비어있음 — seed-stocks.js 자동 실행...');
    const { execSync } = require('child_process');
    execSync(`node ${path.join(__dirname, 'scripts', 'seed-stocks.js')}`, {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env, DB_PATH },
    });
    console.log('[db] stocks 자동 seed 완료');
  } catch (e) {
    console.warn('[db] stocks 자동 seed 실패:', e.message);
  }
}
seedStocksIfEmpty();

async function seedAdminIfNeeded() {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!email || !password) return;

  const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (exists) return;

  const bcrypt = require('bcryptjs');
  const pwHash = await bcrypt.hash(password, 12);
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (email, pw_hash, nickname, role, status, provider, email_verified, created_at)
    VALUES (?, ?, ?, 'admin', 'active', 'local', 1, ?)
  `).run(email, pwHash, 'Admin', now);
  console.log(`[db] seeded admin account: ${email}`);
}
seedAdminIfNeeded().catch(e => console.warn('[db] admin seed failed:', e.message));

// ─── 감사 로그 헬퍼 ──────────────────────────────
function logAudit({ userId = null, action, target = null, meta = null, ip = null }) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, action, target, meta, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, action, target, meta ? JSON.stringify(meta) : null, ip, Date.now());
  } catch (e) {
    console.warn('[audit] insert failed:', e.message);
  }
}

// ─── AI 사용량 기록 헬퍼 ────────────────────────
// Gemini API 가격 (2026 기준, USD per 1M tokens)
//  출처: ai.google.dev/pricing — 무료 플랜이라도 유료 전환 시 예상 비용 산출용
const GEMINI_PRICING = {
  'gemini-2.5-flash':      { in: 0.30,  out: 2.50 },
  'gemini-2.5-flash-lite': { in: 0.10,  out: 0.40 },
  'gemini-2.0-flash':      { in: 0.10,  out: 0.40 },
  'gemini-2.0-flash-lite': { in: 0.075, out: 0.30 },
};
const DEFAULT_PRICING = { in: 0.10, out: 0.40 };

function computeCost(model, promptTokens, completionTokens) {
  const p = GEMINI_PRICING[model] || DEFAULT_PRICING;
  return (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
}

function logAiUsage({ userId = null, endpoint, model, promptTokens = 0, completionTokens = 0, totalTokens = 0, context = null }) {
  try {
    const cost = computeCost(model, promptTokens, completionTokens);
    db.prepare(`
      INSERT INTO ai_usage (user_id, endpoint, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, endpoint, model,
      promptTokens, completionTokens,
      totalTokens || (promptTokens + completionTokens),
      cost,
      context ? JSON.stringify(context).slice(0, 1500) : null,
      Date.now(),
    );
  } catch (e) {
    console.warn('[ai_usage] insert failed:', e.message);
  }
}

// ─── 에러 로그 헬퍼 ──────────────────────────────
function logError({ level = 'error', source = null, message, stack = null, url = null, method = null, status = null, userId = null, ip = null }) {
  try {
    db.prepare(`
      INSERT INTO error_logs (level, source, message, stack, url, method, status, user_id, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(level, source, String(message || '').slice(0, 2000), stack ? String(stack).slice(0, 4000) : null, url, method, status, userId, ip, Date.now());
  } catch (e) {
    console.warn('[error_log] insert failed:', e.message);
  }
}

// ─── 이벤트 로그 헬퍼 ───────────────────────────
//  조용히 실패 — 이벤트 로깅이 사용자 요청을 깨뜨리면 안 됨
function logEvent({ userId = null, type, target = null, meta = null, ip = null }) {
  try {
    if (!type) return;
    db.prepare(`
      INSERT INTO events (user_id, type, target, meta, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      String(type).slice(0, 40),
      target ? String(target).slice(0, 200) : null,
      meta ? JSON.stringify(meta).slice(0, 1000) : null,
      ip,
      Date.now(),
    );
  } catch (e) {
    console.warn('[events] insert failed:', e.message);
  }
}

module.exports = {
  db,
  logAudit,
  logAiUsage,
  logError,
  logEvent,
  GEMINI_PRICING,
  DB_PATH,
};
