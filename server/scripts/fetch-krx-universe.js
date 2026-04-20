// ════════════════════════════════════════════════
//  fetch-krx-universe.js — KOSPI/KOSDAQ 전종목 유니버스를 stocks 테이블에 주입
// ════════════════════════════════════════════════
//  실행: cd server && node scripts/fetch-krx-universe.js
//
//  입력: server/scripts/data/kr-universe.csv
//    포맷: symbol,name,exchange   (헤더 행 필수)
//    예:   005930,삼성전자,KOSPI
//    범위: KOSPI + KOSDAQ 전종목 (ETF 제외 — ETF 는 etfs.js 별도 관리)
//
//  CSV 생성 방법 (pykrx, Python 별도 환경에서 1회):
//    pip install pykrx
//    python3 -c "
//    from pykrx import stock
//    import csv, sys
//    base = '20251128'  # 최근 영업일 (야말일 피하기)
//    rows = []
//    for mkt in ('KOSPI', 'KOSDAQ'):
//        for t in stock.get_market_ticker_list(base, market=mkt):
//            rows.append([t, stock.get_market_ticker_name(t), mkt])
//    w = csv.writer(sys.stdout)
//    w.writerow(['symbol', 'name', 'exchange'])
//    w.writerows(rows)
//    " > server/scripts/data/kr-universe.csv
//
//  동작:
//    신규 심볼        → INSERT (is_curated=0, source='krx', 재무지표 null)
//    기존 is_curated=0 → UPDATE name/exchange (재무지표는 null 전달 → 기존값 유지)
//    기존 is_curated=1 → SKIP (큐레이션 보호)
//
//  이후: fetch-kr-stocks.js 가 DB 전체를 유니버스로 삼아 Yahoo 재무지표 채움
// ════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { openDb, makeUpsertStock, makeProgress } = require('./lib/fetch-utils');

const CSV_PATH = process.env.KRX_CSV
  || path.join(__dirname, 'data', 'kr-universe.csv');

// ─── CSV 파서 (단순 — 쉼표/따옴표만 처리) ─────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => { row[h] = cols[idx]; });
    out.push(row);
  }
  return out;
}

function parseLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') inQ = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// ─── 메인 ────────────────────────────────────────
(async () => {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`❌ CSV 파일 없음: ${CSV_PATH}`);
    console.error('   pykrx 로 생성 방법은 이 스크립트 상단 주석 참조.');
    process.exit(1);
  }

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  console.log(`[krx] CSV 로드: ${rows.length}행 (${CSV_PATH})`);

  const db = openDb();
  const upsertStock = makeUpsertStock(db);

  const stats = { inserted: 0, updated: 0, unchanged: 0, skipped_curated: 0, failed: 0 };
  const failed = [];
  const tick = makeProgress(rows.length, 'krx');

  for (const r of rows) {
    const symbol = String(r.symbol || '').trim();
    if (!/^\d{6}$/.test(symbol)) { stats.failed++; failed.push({ symbol, error: 'invalid symbol' }); continue; }
    try {
      const result = upsertStock({
        symbol,
        market: 'KR',
        name: r.name || symbol,
        name_kr: r.name || null,
        exchange: r.exchange || null,
        currency: 'KRW',
        is_etf: 0,
        source: 'krx',
      });
      stats[result] = (stats[result] || 0) + 1;
    } catch (e) {
      stats.failed++;
      failed.push({ symbol, error: e.message });
    }
    tick(symbol);
  }

  console.log('\n════════════════════════════════════');
  console.log(' fetch-krx-universe 완료');
  console.log('════════════════════════════════════');
  console.log(` inserted        : ${stats.inserted}`);
  console.log(` updated         : ${stats.updated}`);
  console.log(` unchanged       : ${stats.unchanged}`);
  console.log(` skipped_curated : ${stats.skipped_curated}  (is_curated=1 보호)`);
  console.log(` failed          : ${stats.failed}`);
  if (failed.length) {
    console.log('\n실패 심볼 (상위 10):');
    failed.slice(0, 10).forEach(f => console.log(`  ${f.symbol}: ${f.error}`));
  }
  console.log('════════════════════════════════════');
})().catch(e => { console.error('fatal:', e); process.exit(1); });
