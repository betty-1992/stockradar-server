// ════════════════════════════════════════════════
//  fetch-kr-etfs.js — KR ETF 유니버스 주입 (stocks 테이블, is_etf=1)
// ════════════════════════════════════════════════
//  실행: cd server && node scripts/fetch-kr-etfs.js
//
//  입력: server/scripts/data/kr-etfs.csv
//    포맷: symbol,name[,market_cap]
//    예:   069500,KODEX 200,21300300000000
//    범위: KRX 상장 ETF 전체 (~1,090개)
//
//  CSV 생성 (FinanceDataReader, 1회 실행):
//    python3 -c "
//    import FinanceDataReader as fdr, csv
//    etf = fdr.StockListing('ETF/KR')
//    with open('server/scripts/data/kr-etfs.csv','w',newline='',encoding='utf-8') as f:
//        w = csv.writer(f); w.writerow(['symbol','name','market_cap'])
//        for _, r in etf.iterrows():
//            sym = str(r['Symbol']).strip(); name = str(r['Name']).strip()
//            if not sym or not name: continue
//            mc = r.get('MarCap')
//            mc_val = int(mc)*100_000_000 if mc and str(mc).strip() not in ('','nan') else ''
//            w.writerow([sym, name, mc_val])
//    "
//
//  동작:
//    신규 ETF 심볼        → INSERT (is_curated=0, is_etf=1, source='krx-etf')
//    기존 is_curated=0 ETF → UPDATE name/market_cap
//    기존 is_curated=1 ETF → SKIP
// ════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { openDb, makeUpsertStock, makeProgress } = require('./lib/fetch-utils');

const CSV_PATH = process.env.KR_ETF_CSV
  || path.join(__dirname, 'data', 'kr-etfs.csv');

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
      else if (ch === '"') inQ = false;
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

(async () => {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`❌ CSV 파일 없음: ${CSV_PATH}`);
    console.error('   FinanceDataReader 로 생성 방법은 이 스크립트 상단 주석 참조.');
    process.exit(1);
  }

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  console.log(`[kr-etf] CSV 로드: ${rows.length}행 (${CSV_PATH})`);

  const db = openDb();
  const upsertStock = makeUpsertStock(db);

  const stats = { inserted: 0, updated: 0, unchanged: 0, skipped_curated: 0, failed: 0 };
  const failed = [];
  const tick = makeProgress(rows.length, 'kr-etf');

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
        exchange: 'KOSPI', // ETF 는 KOSPI 상장이 일반적
        currency: 'KRW',
        is_etf: 1,
        market_cap: mcap,
        source: 'krx-etf',
      });
      stats[result] = (stats[result] || 0) + 1;
    } catch (e) {
      stats.failed++;
      failed.push({ symbol, error: e.message });
    }
    tick(symbol);
  }

  console.log('\n════════════════════════════════════');
  console.log(' fetch-kr-etfs 완료');
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
