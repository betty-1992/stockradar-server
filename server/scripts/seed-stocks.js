// ════════════════════════════════════════════════
//  seed-stocks.js — 하드코딩 종목 데이터 → DB 1회성 이전
// ════════════════════════════════════════════════
//  실행: cd server && node scripts/seed-stocks.js
//
//  읽는 소스 (수정 안 함):
//    1. StockRadar_v5.html  const MASTER   (프론트 큐레이션 101개)
//    2. index.js            const KR_INFO  (한국 종목 이름·섹터 매핑)
//    3. index.js            KOREAN_TICKERS (한국 티커 배열)
//    4. etfs.js             KR_ETFS / US_ETFS
//
//  기록 대상:
//    - stocks            (source='curation', is_curated=1)
//    - stock_curation    (MASTER 항목만 — score/geo/inst)
//
//  idempotent: 여러 번 실행해도 결과 동일 (INSERT OR REPLACE)
// ════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SERVER_DIR = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH
  || path.join(process.env.DATA_DIR || SERVER_DIR, 'data.db');

// ─── 유틸: JS 소스에서 { ... } 객체 리터럴 추출 (중괄호 밸런싱 + 문자열/주석 스킵) ───
function extractObjectLiteral(src, needle) {
  const start = src.indexOf(needle);
  if (start < 0) throw new Error(`not found: ${needle}`);
  const objStart = src.indexOf('{', start);
  let depth = 0, inStr = null, escape = false;
  let i = objStart;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '\\') { escape = true; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(objStart, i);
}

function extractArrayLiteral(src, needle) {
  const start = src.indexOf(needle);
  if (start < 0) throw new Error(`not found: ${needle}`);
  const arrStart = src.indexOf('[', start);
  let depth = 0, inStr = null, escape = false;
  let i = arrStart;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(arrStart, i);
}

// 안전 eval — Function 생성자로 격리 (require 등 불가)
function evalLiteral(literal) {
  return new Function(`"use strict"; return (${literal});`)();
}

// ─── 소스 로드 ────────────────────────────────────
console.log('[seed] 소스 파일 읽는 중...');

const htmlPath   = path.join(SERVER_DIR, 'StockRadar_v5.html');
const indexPath  = path.join(SERVER_DIR, 'index.js');
const htmlSrc    = fs.readFileSync(htmlPath, 'utf8');
const indexSrc   = fs.readFileSync(indexPath, 'utf8');
const { KR_ETFS, US_ETFS } = require(path.join(SERVER_DIR, 'etfs'));

const MASTER            = evalLiteral(extractObjectLiteral(htmlSrc,  'const MASTER = '));
const KR_INFO           = evalLiteral(extractObjectLiteral(indexSrc, 'const KR_INFO = '));
const KOREAN_TICKERS    = evalLiteral(extractArrayLiteral( indexSrc, 'const KOREAN_TICKERS = '));

console.log(`[seed] MASTER          : ${Object.keys(MASTER).length}개`);
console.log(`[seed] KR_INFO         : ${Object.keys(KR_INFO).length}개`);
console.log(`[seed] KOREAN_TICKERS  : ${KOREAN_TICKERS.length}개`);
console.log(`[seed] KR_ETFS         : ${Object.keys(KR_ETFS).length}개`);
console.log(`[seed] US_ETFS         : ${Object.keys(US_ETFS).length}개`);

// ─── 병합 ─────────────────────────────────────────
//  규칙:
//   1) KOREAN_TICKERS + KR_INFO 로 KR 주식 기본행 생성 (KR_INFO 이름/섹터 우선)
//   2) KR_ETFS, US_ETFS 는 별도 ETF 행으로 삽입
//   3) MASTER 를 맨 마지막에 overlay — name/sector/tags/market_cap 덮어씀 (큐레이터 의도 최우선)
//   4) MASTER 만의 정성값(score/geo/inst) 은 stock_curation 으로 분리
const isKr = (sym) => /^\d{6}$/.test(sym);
const nowMs = Date.now();
const stockRows = new Map(); // symbol -> row

const putStock = (row) => {
  const cur = stockRows.get(row.symbol);
  if (cur) {
    // 병합: 새 값이 있으면 덮어쓰기, 없으면 기존값 유지
    for (const k of Object.keys(row)) {
      if (row[k] != null && row[k] !== '') cur[k] = row[k];
    }
  } else {
    stockRows.set(row.symbol, { ...row });
  }
};

// 1) KOREAN_TICKERS 기본 + KR_INFO overlay
for (const sym of new Set(KOREAN_TICKERS)) {
  const info = KR_INFO[sym] || {};
  putStock({
    symbol: sym,
    market: 'KR',
    name: info.nm || sym,
    name_kr: info.nm || null,
    exchange: null,
    sector: info.sec || null,
    industry: null,
    market_cap: null,
    currency: 'KRW',
    is_etf: 0,
    etf_index: null,
    tags: null,
    source: 'curation',
    is_curated: 1,
    is_active: 1,
  });
}
// KR_INFO 에만 있고 KOREAN_TICKERS 에 없는 심볼도 포함
for (const [sym, info] of Object.entries(KR_INFO)) {
  if (stockRows.has(sym)) continue;
  putStock({
    symbol: sym,
    market: 'KR',
    name: info.nm || sym,
    name_kr: info.nm || null,
    sector: info.sec || null,
    currency: 'KRW',
    is_etf: 0,
    source: 'curation',
    is_curated: 1,
    is_active: 1,
  });
}

// 2) KR_ETFS
for (const [sym, info] of Object.entries(KR_ETFS)) {
  putStock({
    symbol: sym,
    market: 'KR',
    name: info.nm,
    name_kr: info.nm,
    sector: info.sec || null,
    industry: info.idx || null,
    currency: 'KRW',
    is_etf: 1,
    etf_index: info.idx || null,
    tags: JSON.stringify(info.tag || []),
    source: 'curation',
    is_curated: 1,
    is_active: 1,
  });
}

// 3) US_ETFS
for (const [sym, info] of Object.entries(US_ETFS)) {
  putStock({
    symbol: sym,
    market: 'US',
    name: info.nm,
    name_kr: null,
    sector: info.sec || null,
    industry: info.idx || null,
    currency: 'USD',
    is_etf: 1,
    etf_index: info.idx || null,
    tags: JSON.stringify(info.tag || []),
    source: 'curation',
    is_curated: 1,
    is_active: 1,
  });
}

// 4) MASTER overlay (최우선)
const curationRows = []; // for stock_curation 테이블
for (const [sym, m] of Object.entries(MASTER)) {
  const kr = isKr(sym);
  // MASTER.mc 는 "millions of USD" 단위 관례 → 실제 USD 로 환산해 저장
  const marketCapUsd = (typeof m.mc === 'number' && m.mc > 0) ? m.mc * 1e6 : null;
  putStock({
    symbol: sym,
    market: kr ? 'KR' : 'US',
    name: m.nm || sym,
    name_kr: kr ? (m.nm || null) : null,
    sector: m.sec || null,
    market_cap: marketCapUsd,
    currency: kr ? 'KRW' : 'USD',
    is_etf: m.isEtf ? 1 : 0,
    tags: m.tags ? JSON.stringify(m.tags) : null,
    per: (typeof m.per === 'number' && m.per > 0) ? m.per : null,
    roe: (typeof m.roe === 'number' && m.roe > 0) ? m.roe : null,
    revenue_growth: (typeof m.rev === 'number') ? m.rev : null,
    dividend_yield: (typeof m.div === 'number' && m.div > 0) ? m.div : null,
    source: 'curation',
    is_curated: 1,
    is_active: 1,
  });

  // 정성값 분리 → stock_curation
  curationRows.push({
    symbol: sym,
    score: (typeof m.score === 'number') ? m.score : null,
    geo:   m.geo  ? 1 : 0,
    inst:  m.inst ? 1 : 0,
    note:  null,
    updated_by: null,
  });
}

// ─── DB 쓰기 ──────────────────────────────────────
console.log(`[seed] DB 열기: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// 스키마 존재 확인
const tbls = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('stocks','stock_curation')").all().map(r => r.name);
if (!tbls.includes('stocks') || !tbls.includes('stock_curation')) {
  console.error('❌ stocks / stock_curation 테이블이 없어요. 서버를 한 번 기동해서 v10 마이그레이션 실행 후 재시도하세요.');
  process.exit(1);
}

const insertStock = db.prepare(`
  INSERT INTO stocks (
    symbol, market, name, name_kr, exchange, sector, industry,
    market_cap, currency, is_etf, etf_index, tags,
    per, pbr, roe, dividend_yield, revenue_growth,
    source, is_curated, is_active, last_fetched_at, last_seen_at, created_at, updated_at
  ) VALUES (
    @symbol, @market, @name, @name_kr, @exchange, @sector, @industry,
    @market_cap, @currency, @is_etf, @etf_index, @tags,
    @per, @pbr, @roe, @dividend_yield, @revenue_growth,
    @source, @is_curated, @is_active, @last_fetched_at, @last_seen_at, @created_at, @updated_at
  )
  ON CONFLICT(symbol) DO UPDATE SET
    market          = excluded.market,
    name            = excluded.name,
    name_kr         = COALESCE(excluded.name_kr, stocks.name_kr),
    exchange        = COALESCE(excluded.exchange, stocks.exchange),
    sector          = COALESCE(excluded.sector, stocks.sector),
    industry        = COALESCE(excluded.industry, stocks.industry),
    market_cap      = COALESCE(excluded.market_cap, stocks.market_cap),
    currency        = excluded.currency,
    is_etf          = excluded.is_etf,
    etf_index       = COALESCE(excluded.etf_index, stocks.etf_index),
    tags            = COALESCE(excluded.tags, stocks.tags),
    per             = COALESCE(excluded.per, stocks.per),
    pbr             = COALESCE(excluded.pbr, stocks.pbr),
    roe             = COALESCE(excluded.roe, stocks.roe),
    dividend_yield  = COALESCE(excluded.dividend_yield, stocks.dividend_yield),
    revenue_growth  = COALESCE(excluded.revenue_growth, stocks.revenue_growth),
    source          = excluded.source,
    is_curated      = excluded.is_curated,
    is_active       = excluded.is_active,
    updated_at      = excluded.updated_at
`);

const insertCuration = db.prepare(`
  INSERT INTO stock_curation (symbol, score, geo, inst, note, updated_by, updated_at)
  VALUES (@symbol, @score, @geo, @inst, @note, @updated_by, @updated_at)
  ON CONFLICT(symbol) DO UPDATE SET
    score      = excluded.score,
    geo        = excluded.geo,
    inst       = excluded.inst,
    note       = COALESCE(excluded.note, stock_curation.note),
    updated_by = COALESCE(excluded.updated_by, stock_curation.updated_by),
    updated_at = excluded.updated_at
`);

const tx = db.transaction(() => {
  for (const row of stockRows.values()) {
    insertStock.run({
      symbol: row.symbol,
      market: row.market,
      name: row.name || row.symbol,
      name_kr: row.name_kr ?? null,
      exchange: row.exchange ?? null,
      sector: row.sector ?? null,
      industry: row.industry ?? null,
      market_cap: row.market_cap ?? null,
      currency: row.currency ?? null,
      is_etf: row.is_etf ?? 0,
      etf_index: row.etf_index ?? null,
      tags: row.tags ?? null,
      per: row.per ?? null,
      pbr: row.pbr ?? null,
      roe: row.roe ?? null,
      dividend_yield: row.dividend_yield ?? null,
      revenue_growth: row.revenue_growth ?? null,
      source: row.source || 'curation',
      is_curated: row.is_curated ?? 1,
      is_active: row.is_active ?? 1,
      last_fetched_at: null,
      last_seen_at: nowMs,
      created_at: nowMs,
      updated_at: nowMs,
    });
  }
  for (const c of curationRows) {
    insertCuration.run({ ...c, updated_at: nowMs });
  }
});
tx();

// ─── 통계 ─────────────────────────────────────────
const stat = (sql) => db.prepare(sql).get();
const total   = stat(`SELECT COUNT(*) AS c FROM stocks`).c;
const kr      = stat(`SELECT COUNT(*) AS c FROM stocks WHERE market='KR'`).c;
const us      = stat(`SELECT COUNT(*) AS c FROM stocks WHERE market='US'`).c;
const etf     = stat(`SELECT COUNT(*) AS c FROM stocks WHERE is_etf=1`).c;
const krEtf   = stat(`SELECT COUNT(*) AS c FROM stocks WHERE is_etf=1 AND market='KR'`).c;
const usEtf   = stat(`SELECT COUNT(*) AS c FROM stocks WHERE is_etf=1 AND market='US'`).c;
const cur     = stat(`SELECT COUNT(*) AS c FROM stock_curation`).c;
const curated = stat(`SELECT COUNT(*) AS c FROM stocks WHERE is_curated=1`).c;

console.log('\n════════════════════════════════════');
console.log(' seed-stocks 완료');
console.log('════════════════════════════════════');
console.log(` 총 stocks      : ${total} (is_curated=1 → ${curated})`);
console.log(` ├─ KR         : ${kr}   (주식 ${kr - krEtf} · ETF ${krEtf})`);
console.log(` └─ US         : ${us}   (주식 ${us - usEtf} · ETF ${usEtf})`);
console.log(` 총 ETF         : ${etf}`);
console.log(` stock_curation : ${cur}`);
console.log('════════════════════════════════════');

db.close();
