// ════════════════════════════════════════════════
//  yahoo-fetch.js — Yahoo Finance quoteSummary 공통 모듈
// ════════════════════════════════════════════════
//  사용: fetch-kr-stocks.js (KR, .KS/.KQ 접미사), fetch-us-stocks.js (US, 접미사 없음)
//
//  quoteSummary 인증: A1/A3 쿠키 + crumb 쿼리 파라미터
//  getcrumb 는 IP 당 rate-limit 이 공격적 → 유효 세션은 6h TTL 디스크 캐시
//  환경변수 YAHOO_COOKIE / YAHOO_CRUMB 로 수동 오버라이드 가능
// ════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { sleep, num, numNoZero } = require('./fetch-utils');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YF_HOST = 'query2.finance.yahoo.com';
const AUTH_CACHE_PATH = path.join(__dirname, '.yahoo-cache.json');
const AUTH_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MODULES = [
  'summaryProfile',
  'price',
  'defaultKeyStatistics',
  'financialData',
  'summaryDetail',
].join(',');

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
  catch (e) { console.warn('[yahoo] 인증 캐시 저장 실패:', e.message); }
}

async function getYahooAuth(force = false) {
  if (!force && _yahooAuth) return _yahooAuth;
  if (!force) {
    const cached = loadAuthCache();
    if (cached) {
      _yahooAuth = cached;
      console.log(`[yahoo] 인증 (${cached.source}): crumb=${cached.crumb.slice(0, 8)}...`);
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
      if (crumb && crumb.length < 30) break; // "Too Many Requests" 방어
      crumb = '';
    }
    if (resp2.status === 429) {
      const wait = 1500 * Math.pow(2, attempt);
      console.log(`[yahoo] getcrumb 429 — ${wait}ms 대기 후 재시도`);
      await sleep(wait);
      continue;
    }
    if (!resp2.ok) throw new Error(`getcrumb HTTP ${resp2.status}`);
  }
  if (!crumb) throw new Error('getcrumb 3회 실패 (rate-limit). 수동 해결: YAHOO_COOKIE / YAHOO_CRUMB env 로 오버라이드');

  _yahooAuth = { cookies, crumb };
  saveAuthCache(_yahooAuth);
  console.log(`[yahoo] 인증 신규: crumb=${crumb.slice(0, 8)}...`);
  return _yahooAuth;
}

// ─── quoteSummary: symbols 배열 순차 시도, 첫 성공 반환 ──
//  suffixes: ['.KS','.KQ'] (KR) 또는 [''] (US)
async function fetchQuoteSummary(symbolBase, suffixes = ['']) {
  const { cookies, crumb } = await getYahooAuth();
  const headers = { 'User-Agent': UA, 'Cookie': cookies, 'Accept': 'application/json' };
  let lastErr;
  for (const suf of suffixes) {
    const sym = `${symbolBase}${suf}`;
    const url = `https://${YF_HOST}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`;
    try {
      const js = await httpGetJsonWith(url, headers);
      const res = js?.quoteSummary?.result?.[0];
      if (res) return { result: res, yahooSym: sym };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('quoteSummary 응답 없음');
}

// Yahoo 쿠키 전송용 wrapper — 429 긴 백오프 (5→10→20s)
async function httpGetJsonWith(url, headers, { timeoutMs = 15000, retries = 3 } = {}) {
  const DEBUG = process.env.YAHOO_DEBUG === '1';
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers });
      clearTimeout(timer);
      if (DEBUG) console.log(`[debug] attempt=${attempt} status=${res.status} url=${url.slice(0, 140)}`);
      if (res.status === 429) {
        if (DEBUG) {
          const body = await res.text().catch(() => '');
          console.log(`[debug] 429 body: ${body.slice(0, 200)}`);
        }
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

// ─── 재무지표 추출 (KR/US 공통) ─────────────────────
//  extra: { market, defaultCurrency, computeExchange(yahooSym, profile) }
function extractFinancials(symbol, yahoo, extra) {
  const r  = yahoo.result;
  const sp = r.summaryProfile || {};
  const pr = r.price || {};
  const dk = r.defaultKeyStatistics || {};
  const fd = r.financialData || {};
  const sd = r.summaryDetail || {};

  // PEG: trailing 우선, 없으면 forward
  const peg = numNoZero(rawOrNum(dk.pegRatio) ?? rawOrNum(dk.trailingPegRatio));

  return {
    symbol,
    market:         extra.market,
    name:           pr.longName || pr.shortName || sp.longBusinessSummary?.slice(0, 40) || symbol,
    name_kr:        extra.market === 'KR' ? (pr.longName || pr.shortName || null) : null,
    exchange:       extra.computeExchange ? extra.computeExchange(yahoo.yahooSym, pr) : (pr.exchangeName || pr.fullExchangeName || null),
    sector:         sp.sector || null,
    industry:       sp.industry || null,
    market_cap:     numNoZero(rawOrNum(pr.marketCap) ?? rawOrNum(sd.marketCap)),
    currency:       pr.currency || extra.defaultCurrency,
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

module.exports = {
  getYahooAuth,
  fetchQuoteSummary,
  extractFinancials,
  rawOrNum,
};
