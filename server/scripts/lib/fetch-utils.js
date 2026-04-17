// ════════════════════════════════════════════════
//  fetch-utils.js — Phase 2 대량 수집기 공통 유틸
// ════════════════════════════════════════════════
//  사용: fetch-us-stocks.js, fetch-kr-stocks.js
//
//  핵심 원칙
//   1) is_curated=1 종목은 건드리지 않는다 (인식 가능한 건 RAISE_SKIP)
//   2) is_curated=0 또는 신규 종목만 upsert
//   3) 외부 API 실패는 해당 심볼만 스킵하고 전체 진행은 계속
// ════════════════════════════════════════════════

const path = require('path');
const Database = require('better-sqlite3');

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH
  || path.join(process.env.DATA_DIR || SERVER_DIR, 'data.db');

// ─── DB 연결 ──────────────────────────────────────
function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const tbls = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('stocks','stock_curation')"
  ).all().map(r => r.name);
  if (!tbls.includes('stocks') || !tbls.includes('stock_curation')) {
    console.error('❌ stocks / stock_curation 테이블이 없습니다. 서버를 한 번 기동해 v10~v11 마이그레이션 실행 후 재시도하세요.');
    process.exit(1);
  }
  const cols = db.prepare("PRAGMA table_info(stocks)").all().map(r => r.name);
  for (const c of ['peg', 'fcf']) {
    if (!cols.includes(c)) {
      console.error(`❌ stocks.${c} 컬럼이 없습니다 (v11 마이그레이션 미적용). 서버를 기동해 마이그레이션 후 재시도하세요.`);
      process.exit(1);
    }
  }
  return db;
}

// ─── sleep / backoff ──────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTTP GET with timeout + retry + 429/5xx backoff
async function httpGetJson(url, { timeoutMs = 15000, retries = 3, baseDelay = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'stockradar-phase2/1.0' } });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        // 429 시 Retry-After 헤더 참고
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const delay = retryAfter > 0 ? retryAfter * 1000 : baseDelay * Math.pow(2, attempt);
        if (attempt < retries) { await sleep(delay); continue; }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) { await sleep(baseDelay * Math.pow(2, attempt)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// ─── is_curated 보호 업서트 ───────────────────────
//  row: { symbol, market, name, ...재무지표 }
//  반환: 'inserted' | 'updated' | 'skipped_curated' | 'unchanged'
function makeUpsertStock(db) {
  const selectStmt = db.prepare(`SELECT is_curated FROM stocks WHERE symbol = ?`);

  const insertStmt = db.prepare(`
    INSERT INTO stocks (
      symbol, market, name, name_kr, exchange, sector, industry,
      market_cap, currency, is_etf, etf_index, tags,
      per, pbr, roe, dividend_yield, revenue_growth, peg, fcf,
      source, is_curated, is_active, last_fetched_at, last_seen_at, created_at, updated_at
    ) VALUES (
      @symbol, @market, @name, @name_kr, @exchange, @sector, @industry,
      @market_cap, @currency, @is_etf, @etf_index, @tags,
      @per, @pbr, @roe, @dividend_yield, @revenue_growth, @peg, @fcf,
      @source, 0, 1, @now, @now, @now, @now
    )
  `);

  // is_curated=0 대상으로만 UPDATE — 정량값 위주, name/sector 은 NULL 아닐 때만 갱신
  const updateStmt = db.prepare(`
    UPDATE stocks SET
      market          = COALESCE(@market,        market),
      name            = COALESCE(@name,          name),
      name_kr         = COALESCE(@name_kr,       name_kr),
      exchange        = COALESCE(@exchange,      exchange),
      sector          = COALESCE(@sector,        sector),
      industry        = COALESCE(@industry,      industry),
      market_cap      = COALESCE(@market_cap,    market_cap),
      currency        = COALESCE(@currency,      currency),
      is_etf          = COALESCE(@is_etf,        is_etf),
      etf_index       = COALESCE(@etf_index,     etf_index),
      tags            = COALESCE(@tags,          tags),
      per             = COALESCE(@per,           per),
      pbr             = COALESCE(@pbr,           pbr),
      roe             = COALESCE(@roe,           roe),
      dividend_yield  = COALESCE(@dividend_yield,dividend_yield),
      revenue_growth  = COALESCE(@revenue_growth,revenue_growth),
      peg             = COALESCE(@peg,           peg),
      fcf             = COALESCE(@fcf,           fcf),
      source          = COALESCE(@source,        source),
      is_active       = 1,
      last_fetched_at = @now,
      last_seen_at    = @now,
      updated_at      = @now
    WHERE symbol = ? AND is_curated = 0
  `);

  return function upsertStock(row) {
    const now = Date.now();
    const existing = selectStmt.get(row.symbol);
    const payload = {
      symbol:         row.symbol,
      market:         row.market,
      name:           row.name ?? null,
      name_kr:        row.name_kr ?? null,
      exchange:       row.exchange ?? null,
      sector:         row.sector ?? null,
      industry:       row.industry ?? null,
      market_cap:     row.market_cap ?? null,
      currency:       row.currency ?? null,
      is_etf:         row.is_etf ?? 0,
      etf_index:      row.etf_index ?? null,
      tags:           row.tags ?? null,
      per:            row.per ?? null,
      pbr:            row.pbr ?? null,
      roe:            row.roe ?? null,
      dividend_yield: row.dividend_yield ?? null,
      revenue_growth: row.revenue_growth ?? null,
      peg:            row.peg ?? null,
      fcf:            row.fcf ?? null,
      source:         row.source ?? 'bulk',
      now,
    };

    if (!existing) {
      insertStmt.run(payload);
      return 'inserted';
    }
    if (existing.is_curated === 1) {
      return 'skipped_curated';
    }
    const info = updateStmt.run(payload, row.symbol);
    return info.changes > 0 ? 'updated' : 'unchanged';
  };
}

// ─── 진행 로거 ────────────────────────────────────
function makeProgress(total, label = 'progress') {
  let done = 0, tickStart = Date.now();
  return function tick(tag) {
    done++;
    if (done % 25 === 0 || done === total) {
      const elapsed = ((Date.now() - tickStart) / 1000).toFixed(1);
      console.log(`[${label}] ${done}/${total} (${elapsed}s elapsed${tag ? ' · ' + tag : ''})`);
    }
  };
}

// ─── 숫자 파싱 (null·0·문자열 방어) ─────────────────
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// 0 을 null 로 취급 — 재무지표에서 0 은 "미집계" 경우가 많아 덮어쓰기 방지
function numNoZero(v) {
  const n = num(v);
  return (n === null || n === 0) ? null : n;
}

module.exports = {
  DB_PATH,
  openDb,
  sleep,
  httpGetJson,
  makeUpsertStock,
  makeProgress,
  num,
  numNoZero,
};
