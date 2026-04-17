// ════════════════════════════════════════════════
//  fetch-kr-stocks.js — Phase 2: 코스피 상위 100종목 수집
// ════════════════════════════════════════════════
//  실행: cd server && node scripts/fetch-kr-stocks.js
//
//  소스: Yahoo Finance (비공식 공개 엔드포인트, API 키 불필요)
//    - quoteSummary v10: modules = summaryProfile, price, defaultKeyStatistics,
//      financialData, summaryDetail
//    - 심볼 포맷: {6자리}.KS (KOSPI) / .KQ (KOSDAQ)
//
//  대상 유니버스:
//    - 기본: server/index.js 의 KOREAN_TICKERS 앞에서 100개 (KR_TICKERS 범위)
//    - 환경변수 KR_SYMBOLS='005930,000660,...' 로 오버라이드 가능
//
//  is_curated 정책:
//    - 신규 심볼      → insert (is_curated=0, source='yahoo')
//    - 기존 is_curated=0 → 재무지표 UPDATE
//    - 기존 is_curated=1 → 완전 SKIP (큐레이션 보호)
// ════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const {
  openDb, httpGetJson, sleep, makeUpsertStock, makeProgress, num, numNoZero,
} = require('./lib/fetch-utils');

const LIMIT    = Number(process.env.KR_LIMIT || 100);
const DELAY_MS = Number(process.env.KR_DELAY_MS || 1000); // 1초 기본 — Yahoo 비공식 엔드포인트 rate-limit 회피
const YF_HOST  = 'query2.finance.yahoo.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ─── Yahoo 인증: 쿠키 + crumb 확보 (디스크 캐시 + env 오버라이드) ──
//  quoteSummary 는 A1/A3 쿠키 + crumb 쿼리 파라미터 동반 필수.
//  getcrumb 엔드포인트는 IP 당 rate-limit 이 공격적 → 유효 세션은 재사용.
const AUTH_CACHE_PATH = path.join(__dirname, '.yahoo-cache.json');
const AUTH_TTL_MS = 6 * 60 * 60 * 1000; // 6h

let _yahooAuth = null;
function loadAuthCache() {
  try {
    if (process.env.YAHOO_COOKIE && process.env.YAHOO_CRUMB) {
      return { cookies: process.env.YAHOO_COOKIE, crumb: process.env.YAHOO_CRUMB, ts: Date.now(), source: 'env' };
    }
    if (!fs.existsSync(AUTH_CACHE_PATH)) return null;
    const j = JSON.parse(fs.readFileSync(AUTH_CACHE_PATH, 'utf8'));
    if (!j?.cookies || !j?.crumb) return null;
    if (Date.now() - (j.ts || 0) > AUTH_TTL_MS) return null;
    return { ...j, source: 'cache' };
  } catch { return null; }
}
function saveAuthCache(auth) {
  try { fs.writeFileSync(AUTH_CACHE_PATH, JSON.stringify({ ...auth, ts: Date.now() }, null, 2)); }
  catch (e) { console.warn('[kr] 인증 캐시 저장 실패:', e.message); }
}

async function getYahooAuth(force = false) {
  if (!force && _yahooAuth) return _yahooAuth;
  if (!force) {
    const cached = loadAuthCache();
    if (cached) {
      _yahooAuth = cached;
      console.log(`[kr] Yahoo 인증 (${cached.source}): crumb=${cached.crumb.slice(0, 8)}...`);
      return _yahooAuth;
    }
  }
  // 1) 쿠키 수신
  const resp1 = await fetch('https://fc.yahoo.com', {
    redirect: 'manual',
    headers: { 'User-Agent': UA, 'Accept': '*/*' },
  });
  const setCookie = (typeof resp1.headers.getSetCookie === 'function')
    ? resp1.headers.getSetCookie()
    : (resp1.headers.raw?.()['set-cookie'] || []);
  const cookies = setCookie.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookies) throw new Error('Yahoo 쿠키 획득 실패');

  // 2) crumb — 실패 시 지수 백오프 (최대 3회)
  let crumb = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': cookies, 'Accept': 'text/plain' },
    });
    if (resp2.ok) {
      crumb = (await resp2.text()).trim();
      if (crumb) break;
    }
    if (resp2.status === 429) {
      const wait = 1500 * Math.pow(2, attempt);
      console.log(`[kr] getcrumb 429 — ${wait}ms 대기 후 재시도`);
      await sleep(wait);
      continue;
    }
    throw new Error(`getcrumb HTTP ${resp2.status}`);
  }
  if (!crumb) throw new Error('getcrumb 3회 실패 (rate-limit). 수동 해결: YAHOO_COOKIE / YAHOO_CRUMB env 로 오버라이드');

  _yahooAuth = { cookies, crumb };
  saveAuthCache(_yahooAuth);
  console.log(`[kr] Yahoo 인증 신규: crumb=${crumb.slice(0, 8)}...`);
  return _yahooAuth;
}

// ─── 티커 유니버스 로드 ──────────────────────────
function loadTickers() {
  if (process.env.KR_SYMBOLS) {
    return process.env.KR_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean);
  }
  const indexPath = path.join(__dirname, '..', 'index.js');
  const src = fs.readFileSync(indexPath, 'utf8');
  const start = src.indexOf('const KOREAN_TICKERS = [');
  if (start < 0) throw new Error('KOREAN_TICKERS 배열을 index.js 에서 찾지 못함');
  const arrStart = src.indexOf('[', start);
  let depth = 0, inStr = null, escape = false, i = arrStart;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (escape) { escape = false; continue; }
    if (inStr) { if (ch === '\\') { escape = true; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  const literal = src.slice(arrStart, i);
  const arr = new Function(`"use strict"; return (${literal});`)();
  return Array.from(new Set(arr)).filter(s => /^\d{6}$/.test(s));
}

// ─── 심볼 포맷: 기본 .KS, 실패 시 .KQ 재시도 ──────
async function fetchQuoteSummary(ticker6) {
  const { cookies, crumb } = await getYahooAuth();
  const modules = [
    'summaryProfile',
    'price',
    'defaultKeyStatistics',
    'financialData',
    'summaryDetail',
  ].join(',');
  const suffixes = ['.KS', '.KQ'];
  const headers = { 'User-Agent': UA, 'Cookie': cookies, 'Accept': 'application/json' };
  let lastErr;
  for (const suf of suffixes) {
    const sym = ticker6 + suf;
    const url = `https://${YF_HOST}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    try {
      const js = await httpGetJsonWith(url, headers);
      const res = js?.quoteSummary?.result?.[0];
      if (res) return { result: res, yahooSym: sym };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('quoteSummary 응답 없음');
}

// Yahoo 쿠키 전송용 wrapper — httpGetJson 은 헤더 옵션이 없어서 간단히 구현.
// 429 는 긴 백오프 (5 → 10 → 20s). 401 은 즉시 throw (상위에서 캐시 폐기 후 재시도 권장).
async function httpGetJsonWith(url, headers, { timeoutMs = 15000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers });
      clearTimeout(timer);
      if (res.status === 429) {
        lastErr = new Error(`HTTP 429`);
        if (attempt < retries) { await sleep(5000 * Math.pow(2, attempt)); continue; }
        throw lastErr;
      }
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt < retries) { await sleep(1500 * Math.pow(2, attempt)); continue; }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) { await sleep(1500 * Math.pow(2, attempt)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// Yahoo 응답 구조: { raw: number, fmt: string } 또는 number. raw 우선.
function rawOrNum(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === 'number') return num(obj);
  if (typeof obj === 'object' && 'raw' in obj) return num(obj.raw);
  return null;
}

function extractRow(ticker6, yahoo) {
  const r  = yahoo.result;
  const sp = r.summaryProfile || {};
  const pr = r.price || {};
  const dk = r.defaultKeyStatistics || {};
  const fd = r.financialData || {};
  const sd = r.summaryDetail || {};

  const isKospi = yahoo.yahooSym.endsWith('.KS');
  // PEG: trailing 우선, 없으면 forward
  const peg = numNoZero(rawOrNum(dk.pegRatio) ?? rawOrNum(dk.trailingPegRatio));

  return {
    symbol:         ticker6,
    market:         'KR',
    name:           pr.longName || pr.shortName || sp.longBusinessSummary?.slice(0, 40) || ticker6,
    name_kr:        pr.longName || pr.shortName || null,
    exchange:       isKospi ? 'KOSPI' : 'KOSDAQ',
    sector:         sp.sector || null,
    industry:       sp.industry || null,
    market_cap:     numNoZero(rawOrNum(pr.marketCap) ?? rawOrNum(sd.marketCap)),
    currency:       pr.currency || 'KRW',
    is_etf:         (pr.quoteType === 'ETF') ? 1 : 0,
    etf_index:      null,
    tags:           null,
    per:            numNoZero(rawOrNum(sd.trailingPE) ?? rawOrNum(sd.forwardPE)),
    pbr:            numNoZero(rawOrNum(dk.priceToBook)),
    roe:            numNoZero(rawOrNum(fd.returnOnEquity)),
    dividend_yield: numNoZero(rawOrNum(sd.dividendYield) ?? rawOrNum(sd.trailingAnnualDividendYield)),
    revenue_growth: num(rawOrNum(fd.revenueGrowth)),
    peg,
    fcf:            num(rawOrNum(fd.freeCashflow)),
    source:         'yahoo',
  };
}

// ─── 메인 ────────────────────────────────────────
(async () => {
  const db = openDb();
  const upsertStock = makeUpsertStock(db);

  const allTickers = loadTickers();
  const target = allTickers.slice(0, LIMIT);
  console.log(`[kr] 대상 종목 ${target.length}개 (유니버스 ${allTickers.length} 중 상위 ${LIMIT})`);

  const stats = { inserted: 0, updated: 0, unchanged: 0, skipped_curated: 0, failed: 0 };
  const failed = [];
  const tick = makeProgress(target.length, 'kr');

  for (const t of target) {
    try {
      const yahoo = await fetchQuoteSummary(t);
      const row = extractRow(t, yahoo);
      const result = upsertStock(row);
      stats[result] = (stats[result] || 0) + 1;
    } catch (e) {
      stats.failed++;
      failed.push({ symbol: t, error: e.message });
    }
    tick(t);
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  console.log('\n════════════════════════════════════');
  console.log(' fetch-kr-stocks 완료');
  console.log('════════════════════════════════════');
  console.log(` inserted        : ${stats.inserted}`);
  console.log(` updated         : ${stats.updated}`);
  console.log(` unchanged       : ${stats.unchanged}`);
  console.log(` skipped_curated : ${stats.skipped_curated}  (is_curated=1 보호)`);
  console.log(` failed          : ${stats.failed}`);
  if (failed.length) {
    console.log('\n실패 심볼 (상위 10):');
    failed.slice(0, 10).forEach(f => console.log(`  ${f.symbol}: ${f.error}`));
    if (failed.length > 10) console.log(`  ... 외 ${failed.length - 10}개`);
  }
  console.log('════════════════════════════════════');
  db.close();
})().catch(e => {
  console.error('❌ 실행 실패:', e);
  process.exit(1);
});
