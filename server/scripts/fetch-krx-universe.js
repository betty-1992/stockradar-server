// ════════════════════════════════════════════════
//  fetch-krx-universe.js — KOSPI/KOSDAQ 전종목 유니버스를 stocks 테이블에 주입
// ════════════════════════════════════════════════
//  실행: cd server && node scripts/fetch-krx-universe.js
//
//  입력: server/scripts/data/kr-universe.csv
//    포맷: symbol,name,exchange[,market_cap]   (헤더 행 필수, market_cap 선택)
//    예:   005930,삼성전자,KOSPI,1259873040024000
//    범위: KOSPI + KOSDAQ 전종목 (ETF 제외 — ETF 는 etfs.js 별도 관리)
//
//  CSV 생성 방법 (FinanceDataReader, 1회 실행):
//    pip3 install --user finance-datareader
//    python3 -c "
//    import FinanceDataReader as fdr, csv
//    with open('server/scripts/data/kr-universe.csv', 'w', newline='', encoding='utf-8') as f:
//        w = csv.writer(f); w.writerow(['symbol', 'name', 'exchange', 'market_cap'])
//        for exch in ('KOSPI', 'KOSDAQ'):
//            for _, r in fdr.StockListing(exch).iterrows():
//                code = str(r['Code']).strip(); name = str(r['Name']).strip()
//                if not code or not name: continue
//                mcap = int(r['Marcap']) if r.get('Marcap') is not None and str(r.get('Marcap')).strip() != '' else ''
//                w.writerow([code, name, exch, mcap])
//    "
//    대안: pykrx 도 가능하나 KRX 공식 API IP 차단 잦음. FDR 이 Naver 등 폴백 지원
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
    const mcapRaw = String(r.market_cap || '').trim();
    const mcap = mcapRaw && /^\d+$/.test(mcapRaw) ? Number(mcapRaw) : null;
    try {
      const result = upsertStock({
        symbol,
        market: 'KR',
        name: r.name || symbol,
        name_kr: r.name || null,
        exchange: r.exchange || null,
        currency: 'KRW',
        is_etf: 0,
        market_cap: mcap,
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
