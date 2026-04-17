// ════════════════════════════════════════════════
//  fetch-us-stocks.js — Phase 2: 미국 S&P500 수집 (Yahoo Finance)
// ════════════════════════════════════════════════
//  실행: cd server && node scripts/fetch-us-stocks.js
//
//  유니버스: datahub CSV (raw.githubusercontent.com/datasets/s-and-p-500-companies)
//    — FMP Starter 플랜 sp500-constituent 402 + 재무지표 엔드포인트에 심볼 게이트 확인.
//      Yahoo Finance 로 전환 (lib/yahoo-fetch.js 공통 모듈 재사용, KR 과 동일 스킴).
//      상세: docs/DECISIONS.md (2026-04-18)
//
//  재무지표: Yahoo quoteSummary (modules: summaryProfile/price/defaultKeyStatistics/
//                                financialData/summaryDetail) — 심볼 접미사 없음
//
//  is_curated 정책:
//    - 신규 심볼      → insert (is_curated=0, source='yahoo')
//    - 기존 is_curated=0 → 재무지표 UPDATE
//    - 기존 is_curated=1 → 완전 SKIP (큐레이션 보호)
// ════════════════════════════════════════════════

const {
  openDb, sleep, makeUpsertStock, makeProgress,
} = require('./lib/fetch-utils');
const { fetchQuoteSummary, extractFinancials } = require('./lib/yahoo-fetch');

const LIMIT     = Number(process.env.US_LIMIT || 500);
const DELAY_MS  = Number(process.env.US_DELAY_MS || 1000); // 1초 — Yahoo rate-limit 회피
const SP500_CSV = process.env.US_SP500_CSV
  || 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

// ─── S&P500 유니버스 (datahub CSV) ───────────────
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; } }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function fetchSP500() {
  if (process.env.US_SYMBOLS) {
    return process.env.US_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean).map(symbol => ({ symbol }));
  }
  console.log('[us] S&P500 유니버스 조회 (datahub CSV)...');
  const res = await fetch(SP500_CSV);
  if (!res.ok) throw new Error(`S&P500 CSV HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('S&P500 CSV 비어있음');
  lines.shift(); // header
  return lines.map(parseCsvLine).map(cols => ({
    symbol: (cols[0] || '').trim(),
  })).filter(r => r.symbol);
}

// Yahoo 는 BRK.B / BF.B 처럼 '.'이 클래스 구분자인 심볼을 '-'로 표기 (BRK-B)
function toYahooSymbol(sym) {
  return sym.replace(/\./g, '-');
}

// ─── 메인 ────────────────────────────────────────
(async () => {
  const db = openDb();
  const upsertStock = makeUpsertStock(db);

  const sp500 = await fetchSP500();
  const top = sp500.slice(0, LIMIT);
  console.log(`[us] 대상 종목 ${top.length}개 (유니버스 ${sp500.length} 중 상위 ${LIMIT})`);

  const stats = { inserted: 0, updated: 0, unchanged: 0, skipped_curated: 0, failed: 0 };
  const failed = [];
  const tick = makeProgress(top.length, 'us');

  for (const c of top) {
    const sym = String(c.symbol || '').trim().toUpperCase();
    if (!sym) { stats.failed++; tick(); continue; }

    try {
      const yahooSym = toYahooSymbol(sym);
      const yahoo = await fetchQuoteSummary(yahooSym, ['']);
      const row = extractFinancials(sym, yahoo, {
        market: 'US',
        defaultCurrency: 'USD',
        computeExchange: (_, pr) => pr.exchangeName || pr.fullExchangeName || null,
      });
      const result = upsertStock(row);
      stats[result] = (stats[result] || 0) + 1;
    } catch (e) {
      stats.failed++;
      failed.push({ symbol: sym, error: e.message });
    }
    tick(sym);
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  console.log('\n════════════════════════════════════');
  console.log(' fetch-us-stocks 완료');
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
