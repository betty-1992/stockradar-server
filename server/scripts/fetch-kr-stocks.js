// ════════════════════════════════════════════════
//  fetch-kr-stocks.js — Phase 2: 코스피 상위 100종목 수집
// ════════════════════════════════════════════════
//  실행: cd server && node scripts/fetch-kr-stocks.js
//
//  소스: Yahoo Finance quoteSummary (lib/yahoo-fetch.js 공통 모듈)
//    - 심볼 포맷: {6자리}.KS (KOSPI) / .KQ (KOSDAQ) — 순차 시도
//
//  대상 유니버스:
//    - 기본: server/index.js 의 KOREAN_TICKERS 앞에서 LIMIT 개
//    - KR_SYMBOLS env 로 오버라이드 가능
//
//  is_curated 정책:
//    - 신규 심볼      → insert (is_curated=0, source='yahoo')
//    - 기존 is_curated=0 → 재무지표 UPDATE
//    - 기존 is_curated=1 → 완전 SKIP (큐레이션 보호)
// ════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const {
  openDb, sleep, makeUpsertStock, makeProgress,
} = require('./lib/fetch-utils');
const { fetchQuoteSummary, extractFinancials } = require('./lib/yahoo-fetch');

const LIMIT    = Number(process.env.KR_LIMIT || 100);
const DELAY_MS = Number(process.env.KR_DELAY_MS || 1000); // 1초 — Yahoo 비공식 rate-limit 회피

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
      const yahoo = await fetchQuoteSummary(t, ['.KS', '.KQ']);
      const row = extractFinancials(t, yahoo, {
        market: 'KR',
        defaultCurrency: 'KRW',
        computeExchange: (sym) => sym.endsWith('.KS') ? 'KOSPI' : 'KOSDAQ',
      });
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
