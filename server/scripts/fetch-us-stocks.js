// ════════════════════════════════════════════════
//  fetch-us-stocks.js — Phase 2: 미국 상위 500종목 수집
// ════════════════════════════════════════════════
//  실행: cd server && node scripts/fetch-us-stocks.js
//
//  소스: FMP Starter (환경변수 FMP_API_KEY 필요)
//    1. GET /api/v3/sp500_constituent
//    2. 각 심볼별:
//       - /api/v3/profile/{sym}            (name/sector/mktCap/currency)
//       - /api/v3/key-metrics-ttm/{sym}    (roeTTM · pegRatioTTM · fcfPerShareTTM · numberOfSharesTTM)
//       - /api/v3/ratios-ttm/{sym}         (peRatioTTM · priceToBookRatioTTM · dividendYielTTM)
//       - /api/v3/income-statement-growth/ (growthRevenue, annual 최신 1건)
//
//  is_curated 정책:
//    - 신규 심볼      → insert (is_curated=0, source='fmp')
//    - 기존 is_curated=0 → 재무지표 UPDATE
//    - 기존 is_curated=1 → 완전 SKIP (큐레이션 보호)
// ════════════════════════════════════════════════

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  openDb, httpGetJson, sleep, makeUpsertStock, makeProgress, num, numNoZero,
} = require('./lib/fetch-utils');

const API_KEY = process.env.FMP_API_KEY;
if (!API_KEY) {
  console.error('❌ FMP_API_KEY 가 .env 에 설정돼 있지 않습니다.');
  process.exit(1);
}

const LIMIT       = Number(process.env.US_LIMIT || 500);
const DELAY_MS    = Number(process.env.US_DELAY_MS || 150); // 호출 간 지연 (rate-limit 여유)
const FMP_BASE    = 'https://financialmodelingprep.com/api/v3';

// ─── 1) S&P500 구성종목 조회 ─────────────────────
async function fetchSP500() {
  console.log('[us] S&P500 구성종목 조회...');
  const data = await httpGetJson(`${FMP_BASE}/sp500_constituent?apikey=${API_KEY}`);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('sp500_constituent 응답이 비어있거나 형식이 다름');
  }
  return data;
}

// ─── 2) 심볼별 4개 엔드포인트 수집 + 합치기 ────────
async function fetchOne(symbol) {
  const enc = encodeURIComponent(symbol);
  const urls = [
    `${FMP_BASE}/profile/${enc}?apikey=${API_KEY}`,
    `${FMP_BASE}/key-metrics-ttm/${enc}?apikey=${API_KEY}`,
    `${FMP_BASE}/ratios-ttm/${enc}?apikey=${API_KEY}`,
    `${FMP_BASE}/income-statement-growth/${enc}?period=annual&limit=1&apikey=${API_KEY}`,
  ];

  const [profArr, kmArr, ratArr, growArr] = await Promise.all(
    urls.map(u => httpGetJson(u).catch(() => null))
  );

  const p  = Array.isArray(profArr) ? profArr[0]  : null;
  const km = Array.isArray(kmArr)   ? kmArr[0]    : null;
  const rt = Array.isArray(ratArr)  ? ratArr[0]   : null;
  const gr = Array.isArray(growArr) ? growArr[0]  : null;

  if (!p) throw new Error('profile 없음');

  // FCF (절대값) = FCF/share × shares outstanding (TTM)
  const fcfPerShare = num(km?.freeCashFlowPerShareTTM);
  const shares      = num(km?.numberOfSharesTTM ?? km?.weightedAverageSharesDilutedTTM);
  const fcf         = (fcfPerShare != null && shares != null) ? fcfPerShare * shares : null;

  return {
    symbol,
    market:         'US',
    name:           p.companyName || symbol,
    name_kr:        null,
    exchange:       p.exchangeShortName || p.exchange || null,
    sector:         p.sector || null,
    industry:       p.industry || null,
    market_cap:     numNoZero(p.mktCap),
    currency:       p.currency || 'USD',
    is_etf:         p.isEtf ? 1 : 0,
    etf_index:      null,
    tags:           null,
    per:            numNoZero(rt?.peRatioTTM ?? rt?.priceEarningsRatioTTM),
    pbr:            numNoZero(rt?.priceToBookRatioTTM),
    roe:            numNoZero(km?.roeTTM ?? km?.returnOnEquityTTM),
    dividend_yield: numNoZero(rt?.dividendYielTTM ?? rt?.dividendYieldTTM),
    revenue_growth: num(gr?.growthRevenue),
    peg:            numNoZero(km?.pegRatioTTM ?? rt?.pegRatioTTM),
    fcf:            (fcf != null && Number.isFinite(fcf)) ? fcf : null,
    source:         'fmp',
  };
}

// ─── 메인 ────────────────────────────────────────
(async () => {
  const db = openDb();
  const upsertStock = makeUpsertStock(db);

  const sp500 = await fetchSP500();
  const top = sp500.slice(0, LIMIT);
  console.log(`[us] 대상 종목 ${top.length}개 (요청 LIMIT=${LIMIT})`);

  const stats = { inserted: 0, updated: 0, unchanged: 0, skipped_curated: 0, failed: 0 };
  const failed = [];
  const tick = makeProgress(top.length, 'us');

  for (const c of top) {
    const sym = String(c.symbol || '').trim().toUpperCase();
    if (!sym) { stats.failed++; tick(); continue; }

    try {
      const row = await fetchOne(sym);
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
