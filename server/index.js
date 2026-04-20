// ════════════════════════════════════════════════
//  StockRadar 서버 — 로컬 개발용
// ════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

// DB + 라우트
const { db, logAiUsage, logError, logEvent } = require('./db');
const authRouter = require('./auth');
const adminRouter = require('./admin');
const { attachUser } = require('./middleware');
const { KR_ETFS, US_ETFS } = require('./etfs');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ─── 보안 미들웨어 ──────────────────────────────
//  helmet: 기본 보안 헤더. contentSecurityPolicy 는 기존 HTML 에서
//  Chart.js CDN 을 쓰므로 로컬 개발 편의상 off.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// 간단한 메모리 캐시 (같은 요청 반복 방지)
const cache = new Map();
const getCached = (key, ttlMs) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.data;
  return null;
};
const setCached = (key, data) => cache.set(key, { data, time: Date.now() });

// 한국 종목은 6자리 숫자 → 기본 .KS, 해석 실패 시 .KQ 로 폴백
// 해석 성공한 suffix는 영구 메모이즈 (한 번 결정되면 바뀌지 않음)
const KR_SUFFIX_CACHE = new Map(); // '005930' → 'KS', '293490' → 'KQ'

// Yahoo chart API로 해당 suffix에서 실제 가격이 나오는지 검증
// 반환: { ok:true, json, exchangeName } | { ok:false }
const _probeYahoo = async (yahooSym) => {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=5d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { ok: false };
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) return { ok: false };
    const meta = result.meta;
    if (meta?.regularMarketPrice == null) return { ok: false };
    return { ok: true, json, result, exchangeName: meta.exchangeName || '' };
  } catch {
    return { ok: false };
  }
};

// Yahoo 거래소 코드 → KOSPI='KSC' / KOSDAQ='KOE'
// 기대한 suffix 와 실제 응답 거래소가 일치하는지 확인
const _suffixMatchesExchange = (suffix, exchName) => {
  if (!exchName) return true; // 모르면 일단 통과 (폴백에서 걸러짐)
  if (suffix === 'KS') return /KSC|KSE|KRX/i.test(exchName);
  if (suffix === 'KQ') return /KOE|KOSDAQ|KSD/i.test(exchName);
  return true;
};

// 6자리 한국 종목 raw 심볼을 받아 KS/KQ 중 실제 동작하는 쪽을 결정.
// 결정된 symbol + 최초 probe 응답을 돌려 재요청 절약. 한 번 결정되면 메모이즈.
// 숫자 아닌 심볼(미국 등)은 그대로 통과.
const resolveKrSymbol = async (raw) => {
  if (!/^\d{6}$/.test(raw)) {
    return { yahooSym: raw.toUpperCase(), primedJson: null };
  }
  const cached = KR_SUFFIX_CACHE.get(raw);
  if (cached) return { yahooSym: `${raw}.${cached}`, primedJson: null };

  // KS 먼저 시도
  const ks = await _probeYahoo(`${raw}.KS`);
  if (ks.ok && _suffixMatchesExchange('KS', ks.exchangeName)) {
    KR_SUFFIX_CACHE.set(raw, 'KS');
    return { yahooSym: `${raw}.KS`, primedJson: ks.json };
  }
  // KS 가 실패했거나, 응답은 왔지만 거래소가 KOSPI 가 아님(=잘못된 종목/KOSDAQ 혼선)
  // → KQ 시도
  const kq = await _probeYahoo(`${raw}.KQ`);
  if (kq.ok && _suffixMatchesExchange('KQ', kq.exchangeName)) {
    KR_SUFFIX_CACHE.set(raw, 'KQ');
    return { yahooSym: `${raw}.KQ`, primedJson: kq.json };
  }
  // KQ 도 안 맞으면: KS 에 어쨌든 응답이 있었다면 그거라도 사용 (거래소 이름이 못 믿을 수도 있으니)
  if (ks.ok) {
    KR_SUFFIX_CACHE.set(raw, 'KS');
    return { yahooSym: `${raw}.KS`, primedJson: ks.json };
  }
  if (kq.ok) {
    KR_SUFFIX_CACHE.set(raw, 'KQ');
    return { yahooSym: `${raw}.KQ`, primedJson: kq.json };
  }
  // 전부 실패 → KS 폴백 (호출부에서 에러)
  return { yahooSym: `${raw}.KS`, primedJson: null };
};

// CORS — 배포 환경에선 Express 가 HTML 도 같은 오리진에서 서빙하므로 CORS 불필요.
// 로컬에서 file:// 이나 다른 포트로 열 때만 reflect 해서 쿠키 전송 허용.
if (IS_PROD) {
  // same-origin only → cors 미들웨어 자체를 안 쓰면 됨
} else {
  app.use(cors({
    origin: (origin, cb) => cb(null, origin || true),
    credentials: true,
  }));
}
// OCR 엔드포인트는 이미지 base64 때문에 12mb 필요 — 전역 200kb 앞에 등록해야 적용됨
app.use('/api/portfolio/ocr', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '200kb' }));

// ─── 세션 ──────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET
  || (IS_PROD ? null : crypto.randomBytes(32).toString('hex'));
if (!SESSION_SECRET) {
  console.error('[server] FATAL: SESSION_SECRET must be set in production');
  process.exit(1);
}
app.set('trust proxy', 1); // 프록시(Railway 등) 뒤에서 secure 쿠키 작동하게
// 세션 저장소 경로 — 배포 시엔 DATA_DIR(영구 볼륨) 안에 두어야 재배포해도 유지됨
const DATA_DIR = process.env.DATA_DIR || __dirname;
app.use(session({
  name: 'sr.sid',
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: DATA_DIR,
    table: 'sessions',
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // 요청마다 만료 갱신
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    // 'lax' 가 OAuth redirect·top-level navigation 에 친화적. 'strict' 는 너무 공격적.
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30일 (rolling: 요청마다 갱신)
  },
}));

// 세션 → req.user hydrate (모든 라우트에서 req.user 사용 가능)
app.use(attachUser);

// 5xx 응답 자동 로깅 — 기존 try/catch에서 res.status(500).json(...) 한 것도 캡처
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function(body) {
    if (res.statusCode >= 500) {
      const msg = (body && (body.error || body.message)) || `HTTP ${res.statusCode}`;
      logError({
        level: 'error',
        source: 'route',
        message: msg,
        url: req.originalUrl,
        method: req.method,
        status: res.statusCode,
        userId: req.user?.id || null,
        ip: req.ip,
      });
    }
    return origJson(body);
  };
  next();
});

// ─── 인증 라우트 ─────────────────────────────
app.use('/api/auth', authRouter);

// ─── 어드민 라우트 (requireAdmin 내부에서 체크) ──
app.use('/api/admin', adminRouter);

// ─── 공개: 활성화된 메뉴 목록 ────────────────
//  프론트의 LNB 가 하드코딩 대신 이 엔드포인트를 읽어 렌더
//  role='admin' 전용 메뉴는 로그인된 어드민만 볼 수 있게 min_role 기준 필터
app.get('/api/menus', (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const rows = db.prepare(`
    SELECT key, label, icon, order_idx, min_role
    FROM menus
    WHERE enabled = 1
    ORDER BY order_idx ASC, id ASC
  `).all();
  const visible = rows.filter(r => r.min_role === 'user' || (r.min_role === 'admin' && isAdmin));
  res.json({ ok: true, menus: visible });
});

// ─── 헬스체크 (서버가 살아있는지 확인용) ───
// GET / 은 HTML 을 서빙하므로 헬스체크는 /health 로 이동
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    message: 'StockRadar 서버가 동작 중이에요! 🚀',
    time: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    fmp: process.env.FMP_API_KEY && !process.env.FMP_API_KEY.includes('여기에') ? 'configured' : 'missing',
    gemini: process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('여기에') ? 'configured' : 'missing'
  });
});

// ════════════════════════════════════════════════
//  Yahoo Finance — 실시간 주가 & 차트
// ════════════════════════════════════════════════

// GET /api/quote/:symbol → 현재가, 등락률, 기본 정보
// 단일 진실 공급원(fetchYahooQuote)을 공유 — 버그 인라인 로직 제거 완료
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const data = await fetchYahooQuote(req.params.symbol);
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  fetchYahooQuote — 모든 시세 조회의 단일 진실 공급원 (SSOT)
//
//  데이터 정확성 원칙:
//   1) 전일 종가(prev) = meta.previousClose → 차트 종가 배열 마지막 2개 비교
//      ❌ meta.chartPreviousClose 는 range 시작 직전(5~7일 전)이라 절대 쓰면 안 됨
//   2) 오늘 고가/저가 = 마지막 일봉 H/L 과 meta.regularMarketDayHigh/Low 중
//      같은 날짜 기준으로 일관된 값만 사용. 불일치 시 일봉 값 우선.
//   3) 52주 고가/저가 = meta.fiftyTwoWeekHigh/Low 직접 사용. 폴백 없음.
//   4) 모든 값은 숫자 검증(isFinite && >0)을 통과해야 반영.
//   5) 가격/등락률은 과다 소수점 제거 (USD 0.01, KRW 1원 단위로 반올림).
// ════════════════════════════════════════════════════════════════
// ─── 네이버 금융 polling API — KR 전용 SSOT ─────────────────
//  2026-04-20: Yahoo 는 한국 코스닥 소형주 실시간 커버리지 부실 (volume=0,
//  timestamp stale, 과거 체결로 등락률 오탐). KR 6자리 심볼은 네이버로 우회.
//  응답 스키마는 Yahoo fetchYahooQuote 출력과 동일하게 맞춤 (프론트 무변경).
const fetchNaverKrQuote = async (rawSym) => {
  const cacheKey = `quote:naver:${rawSym}`;
  const cached = getCached(cacheKey, 60 * 1000);
  if (cached) return cached;

  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${encodeURIComponent(rawSym)}`;
  const r = await fetch(url, {
    headers: {
      'Referer': 'https://finance.naver.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  });
  if (!r.ok) throw new Error(`naver ${r.status}`);
  const json = await r.json();
  const d = json?.datas?.[0];
  if (!d) throw new Error('naver: no data');

  // "1,234,500" 또는 숫자 → number. 빈값/실패 → null.
  const numN = (s) => {
    if (s == null) return null;
    const n = Number(String(s).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  };

  const price = numN(d.closePrice);
  const change = numN(d.compareToPreviousClosePrice);
  const changePct = numN(d.fluctuationsRatio);
  const prevClose = (price != null && change != null) ? price - change : null;
  const exchCode = d.stockExchangeType?.code === 'KS' ? 'KS' : 'KQ';
  const exchName = d.stockExchangeType?.code === 'KS' ? 'KOSPI' : 'KOSDAQ';

  const out = {
    symbol: `${rawSym}.${exchCode}`,
    rawSymbol: rawSym,
    name: (d.stockName || rawSym).trim(),
    price,
    previousClose: prevClose,
    change,
    changePercent: changePct,
    currency: 'KRW',
    marketState: d.marketStatus || null,  // OPEN | CLOSE
    exchange: exchName,
    dayHigh: numN(d.highPrice),
    dayLow: numN(d.lowPrice),
    volume: numN(d.accumulatedTradingVolume),
    fiftyTwoWeekHigh: null, // 네이버 폴링 API 미지원 — 별도 요청 필요 (추후)
    fiftyTwoWeekLow: null,
    timestamp: Math.floor(Date.now() / 1000),
    source: 'naver',
  };
  setCached(cacheKey, out);
  return out;
};

// ─── 네이버 멀티 심볼 배치 — KR 대량 시세용 ─────────────────
//  한 요청으로 수백 종목 (0.06s 실측). 배치 크기 100 기본.
const _naverRowToQuote = (d) => {
  const numN = (s) => {
    if (s == null) return null;
    const n = Number(String(s).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  };
  const price = numN(d.closePrice);
  const change = numN(d.compareToPreviousClosePrice);
  const changePct = numN(d.fluctuationsRatio);
  const prevClose = (price != null && change != null) ? price - change : null;
  const exchCode = d.stockExchangeType?.code === 'KS' ? 'KS' : 'KQ';
  const exchName = d.stockExchangeType?.code === 'KS' ? 'KOSPI' : 'KOSDAQ';
  return {
    symbol: `${d.itemCode}.${exchCode}`,
    rawSymbol: d.itemCode,
    name: (d.stockName || d.itemCode).trim(),
    price,
    previousClose: prevClose,
    change,
    changePercent: changePct,
    currency: 'KRW',
    marketState: d.marketStatus || null,
    exchange: exchName,
    dayHigh: numN(d.highPrice),
    dayLow: numN(d.lowPrice),
    volume: numN(d.accumulatedTradingVolume),
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    timestamp: Math.floor(Date.now() / 1000),
    source: 'naver',
  };
};

async function fetchNaverKrQuotesBatch(codes, { chunkSize = 100 } = {}) {
  const out = {}; // { '005930': quoteObj, ... }
  const chunks = [];
  for (let i = 0; i < codes.length; i += chunkSize) chunks.push(codes.slice(i, i + chunkSize));
  await Promise.all(chunks.map(async (chunk) => {
    const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${chunk.map(encodeURIComponent).join(',')}`;
    try {
      const r = await fetch(url, {
        headers: {
          'Referer': 'https://finance.naver.com/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      if (!r.ok) return;
      const json = await r.json();
      (json?.datas || []).forEach((d) => {
        if (d?.itemCode) {
          const q = _naverRowToQuote(d);
          out[d.itemCode] = q;
          setCached(`quote:naver:${d.itemCode}`, q);
        }
      });
    } catch { /* 개별 청크 실패는 스킵 — 반환 누락으로 처리 */ }
  }));
  return out;
}

const fetchYahooQuote = async (rawSym) => {
  // KR 6자리 숫자 심볼은 네이버로 우회 (Yahoo 한국 시세 품질 문제)
  if (/^\d{6}$/.test(rawSym)) {
    try {
      return await fetchNaverKrQuote(rawSym);
    } catch (e) {
      // 네이버 실패 시 기존 Yahoo 로 폴백 (데이터라도 반환)
      console.warn(`[quote] naver fallback to yahoo for ${rawSym}: ${e.message}`);
    }
  }

  // 한국 종목은 KS/KQ 자동 판별. 미국 등은 그대로.
  const { yahooSym: sym, primedJson } = await resolveKrSymbol(rawSym);
  const cacheKey = `quote:${sym}`;
  const cached = getCached(cacheKey, 60 * 1000);
  if (cached) return cached;

  let json = primedJson;
  if (!json) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    json = await r.json();
  }
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('not found');
  const meta = result.meta;

  const price = meta.regularMarketPrice;

  // ═══════════════════════════════════════════════════════
  //  전일 종가 결정 — 데이터 정확성 핵심
  // ═══════════════════════════════════════════════════════
  //  우선순위:
  //   1) meta.previousClose           — Yahoo가 직접 주는 "직전 거래일 종가"가 있으면 항상 1순위
  //   2) 차트 종가 배열에서 계산       — range=5d interval=1d 로 받은 일봉 종가 배열의
  //                                      마지막 두 값 중 '직전 거래일'에 해당하는 것
  //   ❌ meta.chartPreviousClose 는 절대 사용 금지
  //      → 이건 range 시작 직전 종가(약 5~7 거래일 전)라 하루치 change 계산엔 완전히 잘못된 값.
  //        과거에 폴백으로 쓰다가 GS건설(006360) 같은 케이스에서 +29% 로 뜨는 버그 발생.
  // 차트 배열에서 (timestamp, O/H/L/C) 함께 정리 — 오늘 고저 검증에도 사용
  const q = result.indicators?.quote?.[0] || {};
  const ts = result.timestamp || [];
  const bars = ts.map((t, i) => ({
    t,
    o: q.open?.[i],
    h: q.high?.[i],
    l: q.low?.[i],
    c: q.close?.[i],
  })).filter(b => b.c != null && isFinite(b.c) && b.c > 0);

  let prev = null;
  if (meta.previousClose != null && isFinite(meta.previousClose) && meta.previousClose > 0) {
    prev = meta.previousClose;
  } else if (bars.length >= 2) {
    const last = bars[bars.length - 1];
    const secondLast = bars[bars.length - 2];
    // "마지막 일봉 = 오늘인지" 판정
    //  · 소수 종목(USD)은 절대값 1달러 tolerance 가 너무 커서 false match 위험
    //  · 비율 기반 0.1% 가 안전
    const diff = Math.abs(last.c - price);
    const rel = price > 0 ? diff / price : 1;
    prev = (rel < 0.001) ? secondLast.c : last.c;
  } else if (bars.length === 1) {
    prev = bars[0].c;
  }

  const change = (prev != null) ? (price - prev) : 0;
  const changePct = (prev != null && prev > 0) ? (change / prev) * 100 : 0;

  // ── 오늘 고가/저가 ─────────────────────────────────────
  //  meta.regularMarketDayHigh/Low 는 장중 실시간 값이지만 가끔 stale.
  //  마지막 일봉(오늘)의 H/L 과 비교해 더 확장된 범위를 채택.
  //  마지막 일봉이 '오늘'이 아닐 경우(장 시작 전) 일봉 값은 어제 값이므로 meta 우선.
  const lastBar = bars[bars.length - 1];
  const lastBarIsToday = lastBar && prev != null && Math.abs(lastBar.c - price) / Math.max(price, 1) < 0.001;
  const num = (v) => (v != null && isFinite(v) && v > 0) ? +v : null;
  let dayHigh = num(meta.regularMarketDayHigh);
  let dayLow  = num(meta.regularMarketDayLow);
  if (lastBarIsToday) {
    const bH = num(lastBar.h);
    const bL = num(lastBar.l);
    if (bH != null) dayHigh = dayHigh != null ? Math.max(dayHigh, bH) : bH;
    if (bL != null) dayLow  = dayLow  != null ? Math.min(dayLow,  bL) : bL;
    // price 도 범위에 포함되어야 함 (meta 가 업데이트 안된 경우)
    if (dayHigh == null || price > dayHigh) dayHigh = price;
    if (dayLow  == null || price < dayLow)  dayLow  = price;
  }

  // ── 52주 고저 ─────────────────────────────────────────
  //  meta 값 그대로. 없으면 null (5일 윈도우 폴백은 값 왜곡이라 금지)
  const h52 = num(meta.fiftyTwoWeekHigh);
  const l52 = num(meta.fiftyTwoWeekLow);

  // ── 가격 반올림(노이즈 제거) ────────────────────────────
  //  USD/EUR 등 소수통화 → 0.01, KRW/JPY → 1원 단위
  const isIntUnit = /KRW|JPY/i.test(meta.currency || '');
  const round = (v) => {
    if (v == null || !isFinite(v)) return v;
    if (isIntUnit) return Math.round(v);
    return Math.round(v * 100) / 100;
  };

  // 이름 정리 (Yahoo가 코스닥 종목에 이상한 shortName 주는 경우 대응)
  const krInfo = KR_INFO[rawSym];
  let cleanName = krInfo?.nm || meta.longName || meta.shortName || '';
  if (isBadName(cleanName, meta.symbol)) {
    cleanName = krInfo?.nm || rawSym;
  }

  const data = {
    symbol: meta.symbol,
    rawSymbol: rawSym,
    name: cleanName,
    price: round(price),
    previousClose: round(prev),
    change: round(change),
    changePercent: Math.round(changePct * 100) / 100, // 소수 2자리
    currency: meta.currency,
    marketState: meta.marketState,
    exchange: meta.fullExchangeName,
    dayHigh: round(dayHigh),
    dayLow: round(dayLow),
    volume: meta.regularMarketVolume,
    fiftyTwoWeekHigh: round(h52),
    fiftyTwoWeekLow: round(l52),
    timestamp: meta.regularMarketTime,
  };
  setCached(cacheKey, data);
  return data;
};

// GET /api/quotes?symbols=AAPL,TSLA,005930 → 여러 종목 한 번에
app.get('/api/quotes', async (req, res) => {
  try {
    const raw = (req.query.symbols || '').toString();
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 0) return res.json({ ok: true, quotes: {} });

    const quotes = {};
    // ── KR 심볼 분리 후 네이버 배치 호출 (멀티 심볼 API 로 수백 건 한 번에)
    const krCodes = list.filter(s => /^\d{6}$/.test(s));
    const nonKr   = list.filter(s => !/^\d{6}$/.test(s));
    if (krCodes.length > 0) {
      // 캐시 히트 먼저 챙기고 나머지만 네이버 배치
      const missing = [];
      for (const code of krCodes) {
        const hit = getCached(`quote:naver:${code}`, 60 * 1000);
        if (hit) quotes[code] = hit;
        else missing.push(code);
      }
      if (missing.length > 0) {
        const fetched = await fetchNaverKrQuotesBatch(missing, { chunkSize: 100 });
        for (const code of missing) {
          quotes[code] = fetched[code] || { error: 'naver: not found' };
        }
      }
    }

    // ── non-KR (US 등) 은 기존 방식: 30개씩 병렬
    for (let i = 0; i < nonKr.length; i += 30) {
      const chunk = nonKr.slice(i, i + 30);
      const results = await Promise.all(chunk.map(s =>
        fetchYahooQuote(s).then(d => [s, d]).catch(e => [s, { error: e.message }])
      ));
      results.forEach(([k, v]) => { quotes[k] = v; });
    }

    res.json({ ok: true, quotes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════
//  Universe — 종목 목록 (Yahoo 스크리너 + KOSPI 하드코딩)
// ════════════════════════════════════════════════

// 한국 종목 이름/섹터 매핑 (Yahoo가 이름을 제대로 안 주는 경우 많음)
const KR_INFO = {
  '005930': { nm: '삼성전자',           sec: 'Technology' },
  '000660': { nm: 'SK하이닉스',          sec: 'Technology' },
  '207940': { nm: '삼성바이오로직스',    sec: 'Healthcare' },
  '005380': { nm: '현대차',              sec: 'Consumer' },
  '000270': { nm: '기아',                sec: 'Consumer' },
  '035420': { nm: 'NAVER',               sec: 'Communication' },
  '105560': { nm: 'KB금융',              sec: 'Financials' },
  '055550': { nm: '신한지주',            sec: 'Financials' },
  '086790': { nm: '하나금융지주',        sec: 'Financials' },
  '051910': { nm: 'LG화학',              sec: 'Materials' },
  '006400': { nm: '삼성SDI',             sec: 'Technology' },
  '028260': { nm: '삼성물산',            sec: 'Industrials' },
  '068270': { nm: '셀트리온',            sec: 'Healthcare' },
  '009150': { nm: '삼성전기',            sec: 'Technology' },
  '035720': { nm: '카카오',              sec: 'Communication' },
  '066570': { nm: 'LG전자',              sec: 'Technology' },
  '373220': { nm: 'LG에너지솔루션',      sec: 'Industrials' },
  '005490': { nm: 'POSCO홀딩스',         sec: 'Materials' },
  '032830': { nm: '삼성생명',            sec: 'Financials' },
  '138040': { nm: '메리츠금융지주',      sec: 'Financials' },
  '316140': { nm: '우리금융지주',        sec: 'Financials' },
  '010130': { nm: '고려아연',            sec: 'Materials' },
  '018260': { nm: '삼성에스디에스',      sec: 'Technology' },
  '001570': { nm: '금양',                sec: 'Materials' },
  '000810': { nm: '삼성화재',            sec: 'Financials' },
  '003670': { nm: '포스코퓨처엠',        sec: 'Materials' },
  '028050': { nm: '삼성E&A',             sec: 'Industrials' },
  '003490': { nm: '대한항공',            sec: 'Industrials' },
  '034020': { nm: '두산에너빌리티',      sec: 'Industrials' },
  '012450': { nm: '한화에어로스페이스',  sec: 'Industrials' },
  '011200': { nm: 'HMM',                 sec: 'Industrials' },
  '298040': { nm: '효성중공업',          sec: 'Industrials' },
  '000990': { nm: 'DB하이텍',            sec: 'Technology' },
  '079550': { nm: 'LIG넥스원',           sec: 'Industrials' },
  '058470': { nm: '리노공업',            sec: 'Technology' },
  '042700': { nm: '한미반도체',          sec: 'Technology' },
  '034220': { nm: 'LG디스플레이',        sec: 'Technology' },
  '240810': { nm: '원익IPS',             sec: 'Technology' },
  '357780': { nm: '솔브레인',            sec: 'Materials' },
  '027360': { nm: '아주IB투자',          sec: 'Financials' },
  '058420': { nm: '제이티',              sec: 'Technology' },
  '036570': { nm: '엔씨소프트',          sec: 'Communication' },
  '067160': { nm: '숲(아프리카TV)',      sec: 'Communication' },
  '251270': { nm: '넷마블',              sec: 'Communication' },
  '293490': { nm: '카카오게임즈',        sec: 'Communication' },
  '352820': { nm: '하이브',              sec: 'Communication' },
  '263750': { nm: '펄어비스',            sec: 'Communication' },
  '259960': { nm: '크래프톤',            sec: 'Communication' },
  '128940': { nm: '한미약품',            sec: 'Healthcare' },
  '006280': { nm: '녹십자',              sec: 'Healthcare' },
  '326030': { nm: 'SK바이오팜',          sec: 'Healthcare' },
  '145020': { nm: '휴젤',                sec: 'Healthcare' },
  '302440': { nm: 'SK바이오사이언스',    sec: 'Healthcare' },
  '041510': { nm: 'SM엔터테인먼트',      sec: 'Communication' },
  '091990': { nm: '셀트리온헬스케어',    sec: 'Healthcare' },
  '196170': { nm: '알테오젠',            sec: 'Healthcare' },
  '131760': { nm: '파미셀',              sec: 'Healthcare' },
  '214450': { nm: '파마리서치',          sec: 'Healthcare' },
  '086280': { nm: '현대글로비스',        sec: 'Industrials' },
  '185750': { nm: '종근당',              sec: 'Healthcare' },
  '112040': { nm: '위메이드',            sec: 'Communication' },
  '122870': { nm: '와이지엔터테인먼트',  sec: 'Communication' },
  '175330': { nm: 'BNK금융지주',         sec: 'Financials' },
  '071050': { nm: '한국금융지주',        sec: 'Financials' },
  '024110': { nm: '기업은행',            sec: 'Financials' },
  '082740': { nm: '한화엔진',            sec: 'Industrials' },
  '003550': { nm: 'LG',                  sec: 'Industrials' },
  '139480': { nm: '이마트',              sec: 'Consumer' },
  '034730': { nm: 'SK스퀘어',            sec: 'Technology' },
  '047050': { nm: '포스코인터내셔널',    sec: 'Industrials' },
  '003530': { nm: '한화투자증권',        sec: 'Financials' },
  '029780': { nm: '삼성카드',            sec: 'Financials' },
  '042660': { nm: '한화오션',            sec: 'Industrials' },
  '047810': { nm: '한국항공우주',        sec: 'Industrials' },
  '000720': { nm: '현대건설',            sec: 'Industrials' },
  '010140': { nm: '삼성중공업',          sec: 'Industrials' },
  '011790': { nm: 'SKC',                 sec: 'Materials' },
  '006360': { nm: 'GS건설',              sec: 'Industrials' },
  '004020': { nm: '현대제철',            sec: 'Materials' },
  '011170': { nm: '롯데케미칼',          sec: 'Materials' },
  '010620': { nm: '현대미포조선',        sec: 'Industrials' },
  '001440': { nm: '대한전선',            sec: 'Materials' },
  '007070': { nm: 'GS리테일',            sec: 'Consumer' },
  '018880': { nm: '한온시스템',          sec: 'Consumer' },
  '034300': { nm: '신세계건설',          sec: 'Industrials' },
  '010950': { nm: 'S-Oil',               sec: 'Energy' },
  '051900': { nm: 'LG생활건강',          sec: 'Consumer' },
  '004370': { nm: '농심',                sec: 'Consumer' },
  '002790': { nm: '아모레G',             sec: 'Consumer' },
  '009830': { nm: '한화솔루션',          sec: 'Materials' },
  '051600': { nm: '한전KPS',             sec: 'Utilities' },
  '097950': { nm: 'CJ제일제당',          sec: 'Consumer' },
  '271560': { nm: '오리온',              sec: 'Consumer' },
  '015760': { nm: '한국전력',            sec: 'Utilities' },
  '030000': { nm: '제일기획',            sec: 'Communication' },
  '090430': { nm: '아모레퍼시픽',        sec: 'Consumer' },
  '011040': { nm: '경동나비엔',          sec: 'Consumer' },
  '000100': { nm: '유한양행',            sec: 'Healthcare' },
  '023530': { nm: '롯데쇼핑',            sec: 'Consumer' },
  '069960': { nm: '현대백화점',          sec: 'Consumer' },
  '030200': { nm: 'KT',                  sec: 'Communication' },
  '017670': { nm: 'SK텔레콤',            sec: 'Communication' },
  '033780': { nm: 'KT&G',                sec: 'Consumer' },
  '004490': { nm: '세방전지',            sec: 'Technology' },
  '035000': { nm: 'GIIR',                sec: 'Communication' },
  '025540': { nm: '한국단자공업',        sec: 'Technology' },
  '001040': { nm: 'CJ',                  sec: 'Consumer' },
  '064350': { nm: '현대로템',            sec: 'Industrials' },
  '080220': { nm: '제주반도체',          sec: 'Technology' },
  '035900': { nm: 'JYP엔터테인먼트',     sec: 'Communication' },
  '036460': { nm: '한국가스공사',        sec: 'Utilities' },
  '053210': { nm: '스카이라이프',        sec: 'Communication' },
  '247540': { nm: '에코프로비엠',        sec: 'Materials' },
  '095570': { nm: 'AJ네트웍스',          sec: 'Industrials' },
};

// 이름 검증: Yahoo가 이상한 값을 넘길 때 감지
const isBadName = (nm, sym) => {
  if (!nm) return true;
  if (nm === sym) return true;
  if (/,/.test(nm)) return true;               // "067160.KS,0P...,7163" 같은 혼합
  if (/^\d+\.(KS|KQ)/.test(nm)) return true;   // "067160.KS"
  if (/^\d{4,}$/.test(nm)) return true;        // 숫자만
  return false;
};

// KOSPI200 + KOSDAQ150 주요 종목 (이전 프로토타입에서 가져옴)
const KOREAN_TICKERS = [
  // 대형주
  '005930','000660','207940','005380','000270','035420','105560','055550',
  '086790','051910','006400','028260','068270','009150','035720','066570',
  '373220','005490','032830','138040','316140','010130','018260','001570',
  '000810','003670','028050','003490','034020','012450','011200','298040',
  // IT/반도체
  '000990','079550','058470','042700','034220','240810','357780','027360',
  '058420','036570','067160','251270','293490','352820','263750','259960',
  // 바이오/헬스
  '128940','006280','326030','145020','302440','041510',
  '091990','196170','131760','214450','086280','185750','112040','122870',
  // 금융
  '175330','071050','024110','082740','003550','139480','034730','047050','003530','029780',
  // 산업재/방산/건설
  '042660','047810','000720','010140','011790',
  '006360','004020','011170','010620','001440','007070','018880','034300',
  // 에너지/화학/소재
  '010950','051900','004370','002790','009830','051600',
  '097950','271560','015760','030000','090430','011040','000100','023530',
  // 소비재/유통
  '069960','030200','017670','033780',
  '005945','005387','004490','035000','025540','001040','064350','080220',
  // 통신/미디어
  '035900','036460','053210',
  // 코스닥 대표
  '247540','095570',
];

// Yahoo 스크리너에서 미국 종목 여러 카테고리를 모아서 unique 리스트 생성
const fetchYahooScreener = async (scrId, count = 100) => {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=${count}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return [];
  const j = await r.json();
  const quotes = j?.finance?.result?.[0]?.quotes || [];
  return quotes
    .filter(q => {
      if (!q.symbol) return false;
      // 주식만 통과 (ETF, MUTUALFUND, CURRENCY, INDEX, CRYPTOCURRENCY 제외)
      if (q.quoteType && q.quoteType !== 'EQUITY') return false;
      // 심볼은 알파벳으로 시작하고 A-Z·숫자·-·.만 허용, 최대 6글자
      // 예: AAPL ✅, BRK-B ✅, 005930.KS ❌, 0P0000D4AV ❌, 71635 ❌
      if (!/^[A-Z][A-Z0-9-]{0,5}$/.test(q.symbol)) return false;
      return true;
    })
    .map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      exchange: q.fullExchangeName || q.exchange,
      marketCap: q.marketCap,
      price: q.regularMarketPrice,
      sector: q.sector || null,
      industry: q.industry || null,
    }));
};

// GET /api/universe → 전체 종목 리스트 (미국 + 한국)
// /api/universe — stocks 테이블(DB) 기반 유니버스.
// Phase 3 (2026-04-18): 이전 Yahoo 스크리너 실시간 병합 + 하드코딩 티커 병합 방식에서 DB 조회로 전환.
// 프론트 loadUniverse 스키마 무변경: { ok, counts, us[], kr[], krEtf[], usEtf[] }.
// 엔트리 필드: { symbol, name, exchange, marketCap, price:null, sector, industry, isEtf, tags? }.
// price 는 frontend 에서 사용 안 함 (MASTER 병합 경로에서 참조 없음). 시세는 /api/batch · /api/quote 로 별도 조회.
app.get('/api/universe', async (req, res) => {
  try {
    const cacheKey = 'universe-db';
    const cached = getCached(cacheKey, 24 * 60 * 60 * 1000); // 24시간 캐시
    if (cached) return res.json({ ...cached, cached: true });

    const rows = db.prepare(`
      SELECT symbol, name, name_kr, exchange, sector, industry,
             market_cap, currency, is_etf, etf_index, tags, market
      FROM stocks
      WHERE is_active = 1
      ORDER BY (market_cap IS NULL), market_cap DESC, symbol ASC
    `).all();

    const us = [], kr = [], krEtf = [], usEtf = [];
    for (const r of rows) {
      let tagArr = [];
      if (r.tags) {
        try { const parsed = JSON.parse(r.tags); if (Array.isArray(parsed)) tagArr = parsed; }
        catch { /* tags 가 JSON 이 아니면 무시 */ }
      }
      const entry = {
        symbol:    r.symbol,
        name:      r.name_kr || r.name || r.symbol,
        exchange:  r.exchange,
        marketCap: r.market_cap,
        price:     null, // 스키마 호환 (프론트 미사용)
        sector:    r.sector,
        industry:  r.industry || r.etf_index || null,
        isEtf:     r.is_etf === 1,
      };
      if (entry.isEtf || tagArr.length) entry.tags = tagArr;

      if (r.market === 'KR')      (entry.isEtf ? krEtf : kr).push(entry);
      else if (r.market === 'US') (entry.isEtf ? usEtf : us).push(entry);
    }

    const result = {
      ok: true,
      counts: {
        us:    us.length,
        kr:    kr.length,
        krEtf: krEtf.length,
        usEtf: usEtf.length,
        total: us.length + kr.length + krEtf.length + usEtf.length,
      },
      us, kr, krEtf, usEtf,
    };
    setCached(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/indices → 주요 지수 (KOSPI, KOSDAQ, NASDAQ, S&P500, WTI, USD/KRW)
app.get('/api/indices', async (req, res) => {
  try {
    const map = {
      KOSPI: '^KS11', KOSDAQ: '^KQ11', NASDAQ: '^IXIC',
      SP500: '^GSPC', WTI: 'CL=F', FX: 'USDKRW=X'
    };
    const entries = await Promise.all(
      Object.entries(map).map(([key, sym]) =>
        fetchYahooQuote(sym).then(d => [key, d]).catch(e => [key, { error: e.message }])
      )
    );
    const indices = Object.fromEntries(entries);
    res.json({ ok: true, indices });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/chart/:symbol?range=1mo&interval=1d → 차트용 캔들 데이터
// range: 1d, 5d, 1mo, 3mo, 6mo, 1y, 5y, max
// interval: 1m, 5m, 15m, 1h, 1d, 1wk, 1mo
app.get('/api/chart/:symbol', async (req, res) => {
  try {
    const { yahooSym: sym } = await resolveKrSymbol(req.params.symbol);
    const range = req.query.range || '1mo';
    const interval = req.query.interval || '1d';
    const cacheKey = `chart:${sym}:${range}:${interval}`;
    const cached = getCached(cacheKey, 5 * 60 * 1000); // 5분 캐시
    if (cached) return res.json({ ...cached, cached: true });

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Yahoo 응답 오류: ${r.status}`);
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('해당 종목을 찾을 수 없어요');

    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = timestamps.map((t, i) => ({
      time: t,
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i]
    })).filter(c => c.close != null);

    const data = {
      symbol: result.meta.symbol,
      range,
      interval,
      candles
    };
    setCached(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════
//  기간별 등락률 배치 조회 — 섹터맵 기간 필터용
// ════════════════════════════════════════════════
//  GET /api/period-changes?symbols=AAPL,TSLA,005930&range=5d
//  Yahoo chart API 를 배치로 호출해서 각 종목의 기간 수익률(%) 을 반환
//  range: 1d | 5d | 1mo
app.get('/api/period-changes', async (req, res) => {
  try {
    const raw = (req.query.symbols || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    const range = ['1d','5d','1mo'].includes(req.query.range) ? req.query.range : '5d';
    if (!raw.length) return res.json({ ok: true, range, changes: {} });

    const cacheKey = `periodChg:${range}:${raw.sort().join(',').slice(0,200)}:${raw.length}`;
    const cached = getCached(cacheKey, 30 * 60 * 1000); // 30분
    if (cached) return res.json({ ...cached, cached: true });

    // 각 심볼을 KS/KQ 등으로 해석
    const resolved = await Promise.all(raw.map(async (r) => {
      try {
        const { yahooSym } = await resolveKrSymbol(r);
        return { raw: r, yahoo: yahooSym };
      } catch { return null; }
    }));
    const ok = resolved.filter(Boolean);

    // Yahoo spark API — 배치 호출 (한 번에 많이)
    const BATCH = 20;
    const changes = {};
    for (let i = 0; i < ok.length; i += BATCH) {
      const slice = ok.slice(i, i + BATCH);
      const symParam = slice.map(x => x.yahoo).join(',');
      const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symParam)}&range=${range}&interval=1d`;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) continue;
        const j = await r.json();
        // 응답은 { spark: { result: [{ symbol, response: [{ meta, timestamp, indicators: { quote: [{ close }] } }] }] } }
        const results = j?.spark?.result || [];
        results.forEach(row => {
          const sym = row.symbol;
          const closes = row.response?.[0]?.indicators?.quote?.[0]?.close || [];
          const clean = closes.filter(c => c != null && !isNaN(c));
          if (clean.length >= 2) {
            const chg = ((clean[clean.length - 1] - clean[0]) / clean[0]) * 100;
            const matched = slice.find(x => x.yahoo === sym);
            if (matched) changes[matched.raw] = +chg.toFixed(2);
          }
        });
      } catch(_) {}
    }

    const result = { ok: true, range, changes };
    setCached(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════
//  FMP — 재무 / 펀더멘털 데이터
// ════════════════════════════════════════════════
const FMP_BASE = 'https://financialmodelingprep.com/stable';

// FMP 신규 API는 ?symbol=XXX 쿼리 스타일
// FMP 호출 제한에 걸리면 일정 시간 모든 FMP 호출을 단락시킨다.
// 무료 플랜은 일 단위 한도라 UTC 자정까지 막는 게 자연스럽지만,
// 정책이 플랜별로 다르므로 "최소 1시간" 으로 보수적으로 잠근다.
let _fmpRateLimitedUntil = 0;
const FMP_RATE_LIMIT_LOCK_MS = 60 * 60 * 1000; // 1시간
const makeRateLimitError = () => {
  const e = new Error('FMP 호출 한도 초과 — 무료 플랜 일일 한도를 모두 사용했어요. 잠시 후 다시 시도해주세요.');
  e.code = 'FMP_RATE_LIMIT';
  return e;
};
const fmpFetch = async (endpoint, params = {}) => {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY가 .env에 없어요');
  if (Date.now() < _fmpRateLimitedUntil) throw makeRateLimitError();
  const qs = new URLSearchParams({ ...params, apikey: key }).toString();
  const url = `${FMP_BASE}/${endpoint}?${qs}`;
  const r = await fetch(url);
  // FMP는 한도 초과 시 보통 429 를 돌려주지만, 때때로 200 + {"Error Message":"Limit Reach..."} 로도 응답함
  if (r.status === 429) {
    _fmpRateLimitedUntil = Date.now() + FMP_RATE_LIMIT_LOCK_MS;
    throw makeRateLimitError();
  }
  // 402/403 = 무료 플랜에서 접근 불가한 프리미엄 엔드포인트/심볼
  // → 빈 배열 반환해서 다른 데이터는 계속 로드되도록 함
  if (r.status === 402 || r.status === 403) {
    console.warn(`[fmp] ${endpoint} (${JSON.stringify(params)}) → ${r.status} premium, returning empty`);
    return [];
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`FMP ${endpoint} 오류 ${r.status}: ${txt.slice(0, 120)}`);
  }
  const body = await r.json();
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body['Error Message'] === 'string') {
    const msg = body['Error Message'];
    if (/limit reach/i.test(msg)) {
      _fmpRateLimitedUntil = Date.now() + FMP_RATE_LIMIT_LOCK_MS;
      throw makeRateLimitError();
    }
    if (/premium|exclusive|subscription|not available under your current/i.test(msg)) {
      console.warn(`[fmp] ${endpoint} → premium-gated, returning empty: ${msg.slice(0, 120)}`);
      return [];
    }
    throw new Error(`FMP ${endpoint}: ${msg.slice(0, 120)}`);
  }
  return body;
};

// GET /api/profile/:symbol → 회사 프로필 + 핵심 지표 한 번에
// 예: /api/profile/AAPL
app.get('/api/profile/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    logEvent({ userId: req.user?.id, type: 'view_profile', target: sym, ip: req.ip });
    const cacheKey = `fmp:profile:${sym}`;
    const cached = getCached(cacheKey, 60 * 60 * 1000); // 1시간 캐시
    if (cached) return res.json({ ...cached, cached: true });

    // 병렬 호출 (4개 엔드포인트 동시에)
    const [profileArr, ratiosArr, metricsArr, quoteArr] = await Promise.all([
      fmpFetch('profile', { symbol: sym }),
      fmpFetch('ratios-ttm', { symbol: sym }),
      fmpFetch('key-metrics-ttm', { symbol: sym }),
      fmpFetch('quote', { symbol: sym })
    ]);

    const profile = profileArr?.[0];
    const ratios = ratiosArr?.[0] || {};
    const metrics = metricsArr?.[0] || {};
    const quote = quoteArr?.[0] || {};

    if (!profile) throw new Error('해당 종목을 찾을 수 없어요 (무료 플랜은 미국 주식만 지원)');

    // PER/PBR/PSR 파생 계산 (stable API에는 직접 필드가 없음)
    const price = quote.price ?? profile.price;
    const epsTTM = ratios.netIncomePerShareTTM;
    const per = metrics.earningsYieldTTM ? 1 / metrics.earningsYieldTTM
              : (epsTTM && epsTTM > 0 ? price / epsTTM : null);
    const pbr = ratios.bookValuePerShareTTM ? price / ratios.bookValuePerShareTTM : null;
    const psr = ratios.revenuePerShareTTM ? price / ratios.revenuePerShareTTM : null;

    const data = {
      symbol: profile.symbol,
      name: profile.companyName,
      sector: profile.industry,      // stable API는 sector 필드가 없음
      industry: profile.industry,
      country: profile.country,
      exchange: profile.exchange,
      marketCap: profile.marketCap,
      price,
      beta: profile.beta,
      description: profile.description,
      ceo: profile.ceo,
      website: profile.website,
      image: profile.image,
      yearHigh: quote.yearHigh,
      yearLow: quote.yearLow,
      // 핵심 지표
      per,
      pbr,
      psr,
      roe: metrics.returnOnEquityTTM,
      roa: metrics.returnOnAssetsTTM,
      debtToEquity: ratios.debtToEquityRatioTTM,
      dividendYield: ratios.dividendYieldTTM,
      earningsYield: metrics.earningsYieldTTM,
      freeCashFlowYield: metrics.freeCashFlowYieldTTM,
      // 추가 지표
      epsTTM,
      revenuePerShare: ratios.revenuePerShareTTM,
      bookValuePerShare: ratios.bookValuePerShareTTM,
      freeCashFlowPerShare: ratios.freeCashFlowPerShareTTM
    };
    setCached(cacheKey, data);
    res.json(data);
  } catch (e) {
    if (e.code === 'FMP_RATE_LIMIT') {
      return res.status(429).json({ ok: false, code: 'FMP_RATE_LIMIT', error: e.message });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/financials/:symbol → 최근 손익계산서 (연간/분기 선택)
// 예: /api/financials/AAPL?period=annual&limit=5
app.get('/api/financials/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const period = req.query.period === 'quarter' ? 'quarter' : 'annual';
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    const cacheKey = `fmp:fin:${sym}:${period}:${limit}`;
    const cached = getCached(cacheKey, 24 * 60 * 60 * 1000); // 24시간 캐시
    if (cached) return res.json({ ...cached, cached: true });

    const data = await fmpFetch('income-statement', { symbol: sym, period, limit });
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('재무제표를 찾을 수 없어요');
    }
    const simplified = data.map(d => ({
      date: d.date,
      revenue: d.revenue,
      grossProfit: d.grossProfit,
      operatingIncome: d.operatingIncome,
      netIncome: d.netIncome,
      eps: d.eps,
      ebitda: d.ebitda
    }));
    const result = { symbol: sym, period, data: simplified };
    setCached(cacheKey, result);
    res.json(result);
  } catch (e) {
    if (e.code === 'FMP_RATE_LIMIT') {
      return res.status(429).json({ ok: false, code: 'FMP_RATE_LIMIT', error: e.message });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════
//  News — Google News RSS 기반 실시간 뉴스
// ════════════════════════════════════════════════

// 엔티티 디코딩 + CDATA 제거
const decodeEntities = (s = '') => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/<\/?b>/g, '')
  .replace(/<[^>]+>/g, '')
  .trim();

// Google News RSS XML 파싱 (의존성 없이 정규식)
const parseNewsItems = (xml) => {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const pick = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`);
      const mm = block.match(re);
      return mm ? decodeEntities(mm[1]) : '';
    };
    const title = pick('title');
    const link = pick('link');
    const pubDate = pick('pubDate');
    const description = pick('description');
    const source = pick('source');
    // <source url="https://www.ajunews.com">아주경제</source> 에서 URL 추출
    const srcUrlMatch = block.match(/<source\s+url="([^"]+)"/);
    let sourceUrl = srcUrlMatch ? srcUrlMatch[1] : '';
    let sourceDomain = '';
    if (sourceUrl) {
      try { sourceDomain = new URL(sourceUrl).hostname.replace(/^www\./, ''); } catch {}
    }
    if (title) {
      items.push({
        title,
        link,
        source: source || '',
        sourceUrl,
        sourceDomain,
        // Google Favicon API — 64px 아이콘, 언론사별 로고 자동
        thumbnail: sourceDomain ? `https://www.google.com/s2/favicons?domain=${sourceDomain}&sz=128` : '',
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
        snippet: description.slice(0, 200),
      });
    }
  }
  return items;
};

// ─── 키워드 동의어/연관어 사전 ────────────────
// 알려진 테마는 OR 확장 검색해서 관련 단어가 포함된 기사도 모두 잡음
// Google News 쿼리 구문: "A OR B OR C" 지원
const KEYWORD_SYNONYMS = {
  // 기술·반도체
  '반도체':   ['반도체','칩','메모리','파운드리','DRAM','HBM','엔비디아','TSMC','SK하이닉스','삼성전자'],
  'AI':       ['AI','인공지능','생성형','ChatGPT','LLM','OpenAI','엔비디아','AI반도체'],
  // 에너지·전력
  '원전':     ['원전','SMR','소형원자로','원자력','두산에너빌리티','한전'],
  '전력':     ['전력','송전','변압기','AI전력','데이터센터','HD현대일렉트릭','효성중공업'],
  // 2차전지·EV
  '2차전지':  ['2차전지','배터리','양극재','음극재','LFP','전해질','에코프로','LG에너지솔루션','삼성SDI'],
  '전기차':   ['전기차','EV','테슬라','리비안','현대차','기아','BYD'],
  // 바이오
  '바이오':   ['바이오','제약','신약','임상','FDA','셀트리온','삼성바이오로직스','알테오젠'],
  // 방산·우주
  '방산':     ['방산','국방','무기','K방산','한화에어로','LIG넥스원','KAI','현대로템'],
  '우주':     ['우주','위성','발사체','한화시스템','누리호'],
  // 금융·경제
  '배당':     ['배당','배당주','고배당','배당성향','SCHD'],
  '금리':     ['금리','기준금리','FOMC','파월','인하','인상'],
  '환율':     ['환율','원달러','달러','엔화','위안화'],
  // 지정학
  '휴전':     ['휴전','종전','정전협정','평화협상','러우전쟁','이스라엘'],
  '관세':     ['관세','무역전쟁','트럼프','보호무역'],
  // 친환경
  '태양광':   ['태양광','솔라','한화솔루션','OCI'],
  '수소':     ['수소','연료전지','그린수소','현대차수소','두산퓨얼셀'],
};

function _expandQuery(raw){
  const q = String(raw || '').trim();
  if (!q) return q;
  // 정확 키 매칭 우선
  if (KEYWORD_SYNONYMS[q]) {
    // Google News 검색은 OR 연산자 지원 (대문자 OR)
    // 원본 키워드를 맨 앞에 두고, 나머지는 OR 연결
    const terms = KEYWORD_SYNONYMS[q];
    return terms.map(t => `"${t}"`).join(' OR ');
  }
  // 부분 매칭 (예: "AI 반도체" → "AI"와 "반도체" 각각 확장해 OR 결합)
  // 공백 분리 후 각 단어가 키에 있으면 모두 확장
  const words = q.split(/\s+/).filter(Boolean);
  const expandedSets = words.map(w => KEYWORD_SYNONYMS[w] || [w]);
  // 카테시안 곱은 쿼리가 너무 길어지니, 단순 flatten + uniq
  const flat = [...new Set(expandedSets.flat())];
  if (flat.length === 1) return flat[0];
  return flat.map(t => `"${t}"`).join(' OR ');
}

const fetchGoogleNews = async (query, limit = 100) => {
  const expanded = _expandQuery(query);
  // 원본·확장 쿼리가 다르면 둘 다 캐시 키에 반영
  const cacheKey = `news:${query}`;
  const cached = getCached(cacheKey, 10 * 60 * 1000); // 10분
  if (cached) return cached.slice(0, limit);
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(expanded)}&hl=ko&gl=KR&ceid=KR:ko`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Google News ${r.status}`);
  const xml = await r.text();
  const items = parseNewsItems(xml);
  setCached(cacheKey, items);
  return items.slice(0, limit);
};

// GET /api/news?q=반도체&limit=10
app.get('/api/news', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    if (!q) return res.status(400).json({ ok: false, error: 'q 파라미터 필요' });
    const items = await fetchGoogleNews(q, limit);
    res.json({ ok: true, query: q, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/news/multi?keywords=반도체,AI,원전&limit=60
// 여러 키워드를 병렬 수집 → 중복 제거(제목 기준) → 최신순 → limit
// 각 아이템의 keywords 필드는 해당 뉴스가 매칭된 모든 키워드 배열 (태그 필터용)
app.get('/api/news/multi', async (req, res) => {
  try {
    const raw = (req.query.keywords || '').toString();
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const perKw = Math.min(parseInt(req.query.perKw) || 80, 100);
    const kws = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (kws.length === 0) return res.json({ ok: true, items: [] });

    const results = await Promise.all(
      kws.map(k =>
        fetchGoogleNews(k, perKw)
          .then(items => items.map(it => ({ ...it, _matchedKw: k })))
          .catch(() => [])
      )
    );
    // 제목 정규화 기준으로 dedupe — 하지만 매칭된 키워드는 누적
    const byKey = new Map();
    for (const arr of results) {
      for (const it of arr) {
        const norm = (it.title || '').replace(/\s+/g, '').toLowerCase();
        if (!norm) continue;
        const existing = byKey.get(norm);
        if (existing) {
          if (!existing.keywords.includes(it._matchedKw)) {
            existing.keywords.push(it._matchedKw);
          }
        } else {
          const { _matchedKw, ...rest } = it;
          byKey.set(norm, { ...rest, keyword: _matchedKw, keywords: [_matchedKw] });
        }
      }
    }
    const merged = [...byKey.values()];
    merged.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    res.json({
      ok: true, keywords: kws,
      count: merged.length,
      total: merged.length,
      items: merged.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════
//  트렌딩 주제 추출 — 브로드 쿼리 → 제목 빈도 분석
// ════════════════════════════════════════════════
//  AI 없이 순수 빈도 기반. 광범위한 금융/시장 뉴스를 수집한 뒤
//  제목에서 2~6 글자 한글 단어와 2+ 글자 대문자 영문 토큰을 뽑고
//  일반 불용어·이미 사용자가 가진 키워드를 제거한 뒤 빈도순 정렬.

// 불용어 (도메인에서 너무 흔하거나 언론사명·일반어라 트렌딩 신호가 아닌 단어)
const TRENDING_STOPWORDS = new Set([
  // 일반 금융 용어
  '주식','종목','시장','증시','코스피','코스닥','상승','하락','급등','급락',
  '상승세','하락세','상승폭','하락폭','상한가','하한가','신고가','신저가',
  '오늘','내일','어제','오전','오후','지난','이번','최근','현재','가격',
  '기업','회사','발표','공시','예상','전망','분석','리포트','뉴스','기사',
  '한국','미국','중국','일본','유럽','글로벌','국내','해외','국제',
  '투자','투자자','거래','거래소','매수','매도','주가','종가','시가','등락',
  '기록','기준','가능','위해','관련','대한','통해','대해','까지','부터',
  '한다','했다','된다','됐다','있다','없다','있는','없는','이다','이라',
  '대비','대신','대해서','때문','그러나','하지만','그리고','그래서',
  '달러','이상','이하','미만','초과','최대','최소','최고','최저','최다',
  '1위','2위','3위','톱10','톱5','순위','명단','리스트',
  '마감','개장','출발','시작','종료','마무리','이어','계속','다시',
  '확대','축소','증가','감소','급증','급감','돌파','반등','약세','강세',
  '포함','제외','추가','삭제','변경','수정','공개','확인','검토','논의',
  '영향','효과','결과','원인','요인','이슈','문제','상황','현황','동향',
  '관련주','수혜주','테마주','대장주','주도주','급등주','상승주','하락주',
  '뉴욕증시','국내증시','아시아','유럽증시',
  '프리미엄','콘텐츠','프리미엄콘텐','프리미엄콘텐츠',
  // 언론사명
  '한국경제','매일경제','서울경제','파이낸셜','파이낸스','이데일리','머니투데이',
  '아시아경제','조선비즈','동아일보','중앙일보','한겨레','경향신문','주간동아',
  '연합뉴스','뉴시스','뉴스1','헤럴드','매경','한경','MBN','YTN','SBS','KBS','MBC',
  // 일반 조사/어미가 남은 찌꺼기
  '오늘의','내일의','우리','이번주','다음주','지난주','올해','내년','작년',
  '한편','한달','주간','일간','월간','연간',
  // 영문
  'the','and','for','with','from','that','this','says','will','new','are','has','have','its','was',
  'Reuters','Bloomberg','CNBC','WSJ','AP','AFP',
]);

// 광범위 금융/시장 쿼리 모음 — 최대한 다양한 주제 커버
const TRENDING_QUERIES = [
  '증시','코스피','나스닥','테마주','급등주','주도주','실적','수혜주',
  '반도체','전기차','바이오','방산','원전','AI','배터리','조선',
];

// 한글 2~8자, 영문 대문자로 시작하는 2+자 토큰 추출
//  · 한글 길이 6→8 로 확장 (프리미엄콘텐츠 같은 합성어 온전 매칭)
//  · 단, 8자 초과 긴 명사는 포기 (NLP 없이는 한계)
//  · stopwords 는 선택적으로 동적 확장 집합 주입 가능 (언론사명 런타임 추가용)
const tokenize = (text, stopwords = TRENDING_STOPWORDS) => {
  const tokens = [];
  const re = /[가-힣]{2,8}|[A-Z][A-Za-z0-9]{1,}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[0];
    if (stopwords.has(t)) continue;
    if (stopwords.has(t.toLowerCase())) continue;
    // 끝 조사 제거
    const trimmed = t.replace(/(의|는|은|이|가|을|를|로|도|과|와|에|서)$/, '');
    if (trimmed.length < 2) continue;
    if (stopwords.has(trimmed)) continue;
    tokens.push(trimmed);
  }
  return tokens;
};

// GET /api/news/trending?exclude=반도체,AI&limit=12
//  - exclude: 결과에서 빼고 싶은 키워드(사용자가 이미 등록한 것들)
//  - limit: 반환할 트렌딩 주제 개수
app.get('/api/news/trending', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 30);
    const exclude = new Set(
      (req.query.exclude || '').toString().split(',').map(s => s.trim()).filter(Boolean)
    );
    const cacheKey = `trending:${[...exclude].sort().join(',')}:${limit}`;
    const cached = getCached(cacheKey, 10 * 60 * 1000); // 10분
    if (cached) return res.json({ ...cached, cached: true });

    // 병렬 수집
    const lists = await Promise.all(
      TRENDING_QUERIES.map(q => fetchGoogleNews(q, 60).catch(() => []))
    );
    const all = lists.flat();

    // 언론사명을 동적으로 불용어 세트에 추가 (Google News 제목 끝 " - 언론사" 포맷 흔함)
    const dynamicStopwords = new Set(TRENDING_STOPWORDS);
    for (const it of all) {
      if (it.source) {
        // 언론사명 자체 + 한글 부분 추출해서 추가
        const src = it.source.trim();
        dynamicStopwords.add(src);
        const parts = src.match(/[가-힣]{2,}/g) || [];
        parts.forEach(p => dynamicStopwords.add(p));
      }
    }

    // 제목 뒤 " - 언론사" 패턴을 잘라내는 정제 함수
    const cleanTitle = (t) => (t || '').replace(/\s+[-–—]\s+[^-–—]+$/, '');

    // 제목 + 스니펫 토큰화해서 빈도 집계
    const freq = new Map();
    const seen = new Set();
    for (const it of all) {
      const norm = (it.title || '').replace(/\s+/g,'').toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      const text = `${cleanTitle(it.title)} ${it.snippet || ''}`;
      const tokens = tokenize(text, dynamicStopwords);
      // 한 기사 내 중복은 1회만 카운트 (도배성 제목 가중치 방지)
      const uniq = new Set(tokens);
      for (const t of uniq) {
        if (exclude.has(t)) continue;
        if (dynamicStopwords.has(t)) continue;
        freq.set(t, (freq.get(t) || 0) + 1);
      }
    }

    // base 쿼리 단어 자체는 결과에서 제외 (순환 방지)
    const baseSet = new Set(TRENDING_QUERIES);
    const sorted = [...freq.entries()]
      .filter(([word, c]) => c >= 2 && !baseSet.has(word))
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word, count]) => ({ word, count }));

    const result = {
      ok: true,
      generatedAt: new Date().toISOString(),
      baseQueries: TRENDING_QUERIES,
      articleCount: seen.size,
      trending: sorted,
    };
    setCached(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════
//  Gemini — AI 종목 분석
// ════════════════════════════════════════════════
//  모델 폴백 순서: 2.5-flash 가 503/429 면 2.0-flash → lite 로 순차 시도
//  · 1.5-flash 는 API v1beta 에서 404 (deprecated on free tier) 라 제거
//  · 1.5-pro 는 속도 느리고 일부 키에서 미지원이라 제외
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];
const DEFAULT_GEMINI_MODEL = GEMINI_MODELS[0];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function _geminiOnce(model, prompt, key, opts = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  // opts.images: [{ mimeType, data(base64) }] — multimodal 호출용
  const parts = [];
  if (Array.isArray(opts.images)) {
    for (const img of opts.images) {
      if (img?.mimeType && img?.data) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      }
    }
  }
  parts.push({ text: prompt });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.maxOutputTokens ?? 2048,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const err = new Error(`Gemini ${model} ${r.status}: ${txt.slice(0, 160)}`);
    err.status = r.status;
    throw err;
  }
  const json = await r.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini: empty response');
  const um = json?.usageMetadata || {};
  const usage = {
    promptTokens: um.promptTokenCount || 0,
    completionTokens: um.candidatesTokenCount || 0,
    totalTokens: um.totalTokenCount || 0,
  };
  return { text, usage };
}

// 404/400 (모델 없음) 난 모델은 세션 동안 블랙리스트 처리해서 재호출 방지
const _geminiBadModels = new Set();

// 반환: { text, model, usage }
//  opts: { images?: [{mimeType,data(base64)}], temperature?, maxOutputTokens? }
const callGemini = async (prompt, opts = {}) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY가 .env에 없어요');

  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    if (_geminiBadModels.has(model)) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text, usage } = await _geminiOnce(model, prompt, key, opts);
        return { text, model, usage };
      } catch (e) {
        lastErr = e;
        if (e.status === 404 || e.status === 400) {
          console.warn(`[gemini] ${model} 제외 (${e.status}) — 이 세션에선 다시 호출 안 함`);
          _geminiBadModels.add(model);
          break;
        }
        const retryable = e.status === 503 || e.status === 429 || e.status === 500 || !e.status;
        if (!retryable) break;
        if (attempt === 0) await sleep(800);
      }
    }
  }
  throw lastErr || new Error('Gemini: all models failed');
};

// ═══════════════════════════════════════════════════════════════
//  POST /api/portfolio/ocr — 포트폴리오 스크린샷 OCR (Gemini Vision)
//  · 증권사 앱 캡처 이미지에서 {name, quantity, avg_price} 배열 추출
//  · stocks 테이블로 name → symbol 매칭
//  · 사용자는 결과 편집 후 /api/auth/transactions 또는 /api/auth/holdings 로 저장
//  · 이미지 업로드 용량 10MB (기본 라우트의 200kb limit 회피)
// ═══════════════════════════════════════════════════════════════
app.post('/api/portfolio/ocr',
  async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
      const { images } = req.body || {};
      if (!Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ ok: false, error: 'NO_IMAGES' });
      }
      if (images.length > 5) {
        return res.status(400).json({ ok: false, error: 'TOO_MANY_IMAGES' });
      }
      // 각 이미지 검증 — mimeType + data (base64)
      const imgs = [];
      for (const im of images) {
        if (!im?.mimeType || !im?.data) continue;
        if (!/^image\/(jpeg|jpg|png|webp|heic)$/i.test(im.mimeType)) continue;
        // 너무 큰 이미지는 거부 (base64 기준 ~8MB)
        if (im.data.length > 8 * 1024 * 1024) {
          return res.status(400).json({ ok: false, error: 'IMAGE_TOO_LARGE' });
        }
        imgs.push({ mimeType: im.mimeType, data: im.data });
      }
      if (!imgs.length) return res.status(400).json({ ok: false, error: 'INVALID_IMAGES' });

      const prompt = `당신은 증권사 앱/웹 포트폴리오 스크린샷을 분석해 보유 종목을 추출하는 도우미입니다.

이미지에서 각 보유 종목의 아래 정보를 뽑아 JSON 배열로만 반환하세요:
- "name": 종목명 (화면에 보이는 그대로. 한글이면 한글, 영문이면 영문)
- "quantity": 보유수량 (숫자. 쉼표 · 단위 제거)
- "avg_price": 평균매수가 or 매입단가 (숫자. 쉼표 · 원 · $ 제거)

주의 사항:
- "평가금액", "손익", "현재가", "수익률" 은 추출 대상 아님. 오직 수량·평균단가만.
- 이미지가 증권사 포트폴리오가 아니면 빈 배열 []
- 일부 필드가 읽히지 않으면 해당 필드만 null
- 종목명이 축약돼 있어도 가능한 정확히 기재
- 출력은 JSON 배열 한 번만. 마크다운 코드펜스(\`\`\`)·설명 금지

형식 예:
[
  {"name":"삼성전자","quantity":10,"avg_price":72000},
  {"name":"NVIDIA","quantity":3,"avg_price":135.80}
]`;

      const { text, model, usage } = await callGemini(prompt, { images: imgs, temperature: 0.1, maxOutputTokens: 2048 });
      logAiUsage({
        userId: req.user.id,
        endpoint: 'portfolio-ocr',
        model,
        promptTokens: usage?.promptTokens || 0,
        completionTokens: usage?.completionTokens || 0,
        totalTokens: usage?.totalTokens || 0,
        context: { imgCount: imgs.length },
      });

      // JSON 파싱 (마크다운 펜스 대비 방어)
      let rows = [];
      try {
        const clean = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        const parsed = JSON.parse(clean);
        rows = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'PARSE_FAIL', raw: String(text).slice(0, 500) });
      }

      // name → symbol 매칭 (stocks 테이블)
      //  1) name_kr 완전 일치 > 2) name 완전 일치 > 3) name_kr LIKE > 4) name LIKE
      //  여러 후보면 market_cap DESC
      const findByName = (rawName) => {
        const n = String(rawName || '').trim();
        if (!n) return null;
        const exactKr = db.prepare(
          `SELECT symbol, name, name_kr, market, market_cap FROM stocks
           WHERE name_kr = ? AND is_active = 1 ORDER BY market_cap IS NULL, market_cap DESC LIMIT 1`
        ).get(n);
        if (exactKr) return exactKr;
        const exactEn = db.prepare(
          `SELECT symbol, name, name_kr, market, market_cap FROM stocks
           WHERE name = ? AND is_active = 1 ORDER BY market_cap IS NULL, market_cap DESC LIMIT 1`
        ).get(n);
        if (exactEn) return exactEn;
        const likeKr = db.prepare(
          `SELECT symbol, name, name_kr, market, market_cap FROM stocks
           WHERE (name_kr LIKE ? OR name LIKE ?) AND is_active = 1
           ORDER BY market_cap IS NULL, market_cap DESC LIMIT 1`
        ).get(`%${n}%`, `%${n}%`);
        return likeKr || null;
      };

      const items = rows.map((r) => {
        const match = findByName(r?.name);
        return {
          name: r?.name ?? null,
          quantity: (r?.quantity != null && isFinite(+r.quantity)) ? +r.quantity : null,
          avg_price: (r?.avg_price != null && isFinite(+r.avg_price)) ? +r.avg_price : null,
          matchedSymbol: match?.symbol || null,
          matchedName: match ? (match.name_kr || match.name) : null,
          matchedMarket: match?.market || null,
        };
      });

      res.json({ ok: true, items, model, detected: items.length });
    } catch (e) {
      console.warn('[portfolio/ocr] error', e);
      res.status(500).json({ ok: false, error: e.message || 'INTERNAL' });
    }
  }
);

// POST /api/ai-analysis → 종목 데이터를 받아 AI 분석 리턴
// 바디: { symbol, name, price, changePercent, per, pbr, roe, sector, ... }
app.post('/api/ai-analysis', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    const d = req.body || {};
    if (!d.symbol && !d.name) {
      return res.status(400).json({ ok: false, error: 'symbol 또는 name이 필요해요' });
    }

    const isKR = d.symbol && /^\d{6}$/.test(d.symbol);
    const cacheKey = `ai:${d.symbol}:${isKR ? 'kr' : 'us'}`;
    const cached = getCached(cacheKey, 30 * 60 * 1000); // 30분 캐시
    if (cached) return res.json({ ...cached, cached: true });

    const fmt = (v, s = '') => (v == null || isNaN(v)) ? 'N/A' : `${(+v).toFixed(2)}${s}`;
    const fmtBig = (v) => {
      if (v == null) return 'N/A';
      if (v >= 1e12) return `${(v/1e12).toFixed(2)}조`;
      if (v >= 1e9)  return `${(v/1e9).toFixed(2)}B`;
      if (v >= 1e6)  return `${(v/1e6).toFixed(2)}M`;
      return v.toString();
    };

    // KR 종목은 FMP 미지원이라 최근 뉴스로 컨텍스트 보강
    let newsBlock = '';
    if (isKR) {
      try {
        const news = await Promise.race([
          fetchGoogleNews(d.name || d.symbol, 5),
          new Promise((_, rej) => setTimeout(() => rej(new Error('news timeout')), 5000))
        ]);
        if (news && news.length) {
          newsBlock = '\n[최근 뉴스 5개]\n' + news.slice(0, 5).map(n => {
            const t = n.publishedAt ? new Date(n.publishedAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit' }) : '';
            return `- ${t} · ${n.title}`;
          }).join('\n');
        }
      } catch (_) { /* 뉴스 실패해도 분석은 계속 */ }
    }

    const commonHeader = `당신은 주린이(주식 초보)를 위한 친절한 투자 멘토입니다.
아래 종목을 **쉬운 한국어**로 분석해주세요. 전문 용어는 괄호 안에 풀어서 설명해주세요.`;

    const infoBlock = `[종목 정보]
- 이름: ${d.name || d.symbol}
- 티커: ${d.symbol || '-'}
- 섹터/산업: ${d.sector || '-'} / ${d.industry || '-'}
- 현재가: ${d.price ?? '-'} ${d.currency || ''}
- 전일대비: ${fmt(d.changePercent, '%')}
- 시가총액: ${fmtBig(d.marketCap)}
- PER: ${fmt(d.per)}배
- PBR: ${fmt(d.pbr)}배
- PSR: ${fmt(d.psr)}배
- ROE: ${d.roe != null ? fmt(d.roe * 100, '%') : 'N/A'}
- 배당수익률: ${d.dividendYield != null ? fmt(d.dividendYield * 100, '%') : 'N/A'}${d.description ? `\n- 사업 요약: ${d.description.slice(0, 300)}` : ''}`;

    const formatBlock = `[출력 형식]
다음 4개 섹션으로 나눠 작성하세요. 각 섹션은 **2~3문장**으로 간결하게.

## 🏢 어떤 회사인가요
## 💰 지금 비싸? 싸?
## ✨ 매력 포인트
## ⚠️ 주의할 점

마지막에 한 줄 요약을 **"💡 한 줄 총평:"** 으로 시작해주세요.
투자 권유는 하지 마세요 — 정보 제공 목적임을 명시해주세요.`;

    const prompt = isKR
      ? `${commonHeader}

⚠️ 한국 종목은 상세 재무지표(PER/PBR/ROE 등)가 제한적으로 제공됩니다. 제공된 수치가 N/A 이면 **뉴스 흐름 · 주가 변동 · 섹터 특성** 중심으로 평가해주세요.

${infoBlock}
${newsBlock}

${formatBlock}`
      : `${commonHeader}

${infoBlock}

${formatBlock}`;

    const { text: analysis, model: usedModel, usage } = await callGemini(prompt);
    logAiUsage({
      userId: req.user?.id || null,
      endpoint: 'ai-analysis',
      model: usedModel,
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      context: {
        symbol: d.symbol || null,
        name: d.name || null,
        market: isKR ? 'KR' : 'US',
        sector: d.sector || null,
      },
    });
    logEvent({
      userId: req.user?.id,
      type: 'ai_analyze',
      target: d.symbol || d.name,
      meta: { name: d.name, market: isKR ? 'KR' : 'US' },
      ip: req.ip,
    });
    const result = {
      symbol: d.symbol,
      market: isKR ? 'KR' : 'US',
      model: usedModel,
      analysis,
      newsIncluded: Boolean(newsBlock),
      generatedAt: new Date().toISOString()
    };
    setCached(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/ai-chat → 자유 질문 채팅 (구조화된 컨텍스트 포함)
// 바디: {
//   question: 사용자 질문(필수),
//   stock?:   { symbol, name, sector, price, changePercent, per, pbr, roe, marketCap, isEtf, idx } (선택),
//   history?: [ { role:'user'|'assistant', content:'...' }, ... ] (선택, 최근 N개만),
//   userName?: 사용자 닉네임 (있으면 답변에 이름으로 호칭)
// }
app.post('/api/ai-chat', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    const { question, stock, history, userName, context: legacyContext } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ ok: false, error: 'question이 필요해요' });
    }
    if (question.length > 500) {
      return res.status(400).json({ ok: false, error: '질문은 500자 이내로 해주세요' });
    }

    const safeName = (userName && typeof userName === 'string')
      ? userName.replace(/[<>"]/g, '').slice(0, 30)
      : '';

    // 시스템 가이드 — 짧고 구조화된 답변을 강제
    const system = `당신의 이름은 '스톡이'입니다. 주식·ETF·투자와 이에 영향을 주는 거시·시사 이슈에 답하는 친절한 도우미예요.

${safeName ? `사용자 이름은 '${safeName}'입니다. 답변 시작에 한 번만 이름을 부를 수 있지만, 억지로 매번 부를 필요는 없어요. "주린이" 같은 호칭은 절대 사용하지 마세요.` : '사용자를 지칭할 필요가 있다면 "고객님" 또는 이름 없이 직접 설명하세요. "주린이" 같은 호칭은 절대 사용하지 마세요.'}

답변 원칙 (엄격히 지킬 것):

1) **아주 짧은 문장**만 써요. 한 문장은 50자 이내. 한 문장에 한 가지 내용만 담으세요.
2) **마크다운 불릿(-) 3~5개**로 핵심만 나열. 서론·요약·"결론적으로" 같은 도입/마무리 문장 금지.
3) **반드시 구체 수치** 포함. "높아요/낮아요" 금지. "PER 15배는 S&P500 평균 수준(약 18배)보다 낮은 편이에요" 처럼.
4) **용어는 괄호로 짧게** 풀이. 예: "PER(주가수익비율)".
5) **투자 권유 금지**. "사세요/파세요" 대신 "이런 의미예요".
6) **답변 가능한 주제**: 개별 종목·ETF 분석, 시장·섹터 동향, 경제 지표, 금리·환율·유가, 전쟁·관세·선거·규제 같은 시사·거시 이슈도 **투자 영향 관점에서** 설명 가능. 시사 질문이라도 "이런 상황 → 어떤 섹터/종목에 영향" 구조로 답변하세요.
   **거절 주제**: 요리·연예·일상 상담처럼 투자/경제와 완전히 무관한 주제만 "주식·투자·경제 쪽 질문만 답변 드려요" 한 줄로 정중히 거절.
7) 답변 맨 마지막 줄에 **"⚠️ "** 로 시작하는 한 줄 주의 문구 (15~30자).

출력 형식 예시:
- PER(주가수익비율) 32배는 S&P500 평균(18배)의 약 1.8배 수준이에요.
- 성장 기대감이 가격에 많이 반영된 상태라는 뜻이에요.
- 과거 Apple의 평균 PER(약 25배)과 비교해도 높은 편이에요.
⚠️ 고평가 구간은 단기 조정 위험이 있어요.`;

    // 종목 컨텍스트 직렬화
    let stockBlock = '';
    if (stock && typeof stock === 'object') {
      const fmt = (v, s = '') => (v == null || isNaN(v)) ? 'N/A' : `${(+v).toFixed(2)}${s}`;
      stockBlock = `
[지금 보고 있는 종목]
- 이름: ${stock.name || stock.symbol || '—'}
- 티커: ${stock.symbol || '—'}${stock.isEtf ? ' (ETF)' : ''}
- 섹터/지수: ${stock.sector || stock.idx || '—'}
- 현재가: ${stock.price ?? '—'}
- 전일대비: ${fmt(stock.changePercent, '%')}
${stock.marketCap ? `- 시가총액: ${stock.marketCap}\n` : ''}${stock.per != null ? `- PER: ${fmt(stock.per)}배\n` : ''}${stock.pbr != null ? `- PBR: ${fmt(stock.pbr)}배\n` : ''}${stock.roe != null ? `- ROE: ${fmt(stock.roe * 100, '%')}\n` : ''}`;
    }

    // 대화 히스토리 직렬화 (최근 6턴까지)
    let historyBlock = '';
    if (Array.isArray(history) && history.length) {
      const trimmed = history.slice(-6)
        .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .map(h => `${h.role === 'user' ? '사용자' : '멘토'}: ${h.content.slice(0, 400)}`)
        .join('\n');
      if (trimmed) historyBlock = `\n[지금까지 대화]\n${trimmed}\n`;
    }

    // 레거시 context 필드도 지원 (기존 클라이언트 호환)
    const legacy = legacyContext ? `\n[추가 맥락]\n${legacyContext}\n` : '';

    const prompt = `${system}
${stockBlock}${historyBlock}${legacy}
[새 질문] ${question}

위 원칙대로 한국어로 답변해주세요.`;

    const { text: answer, model: usedModel, usage } = await callGemini(prompt);
    logAiUsage({
      userId: req.user?.id || null,
      endpoint: 'ai-chat',
      model: usedModel,
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      context: {
        question: String(question).slice(0, 300),
        stockSymbol: stock?.symbol || null,
        stockName: stock?.name || null,
      },
    });
    res.json({ ok: true, answer, model: usedModel });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/ai-sector → 섹터/토픽 요약 + 등락 원인 추정 + 산업 전망
app.post('/api/ai-sector', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    const { sector, avgChg, count, gainers = [], losers = [] } = req.body || {};
    if (!sector) return res.status(400).json({ ok: false, error: 'sector 필요' });

    const cacheKey = `ai-sec:${sector}:${Math.round((avgChg||0)*10)}`;
    const cached = getCached(cacheKey, 30 * 60 * 1000);
    if (cached) return res.json({ ...cached, cached: true });

    // 섹터 관련 최근 뉴스 컨텍스트
    let newsBlock = '';
    try {
      const news = await Promise.race([
        fetchGoogleNews(sector, 6),
        new Promise((_, rej) => setTimeout(() => rej(new Error('news timeout')), 5000)),
      ]);
      if (news && news.length) {
        newsBlock = '\n[최근 관련 뉴스]\n' + news.slice(0, 6).map(n => {
          const t = n.publishedAt ? new Date(n.publishedAt).toLocaleString('ko-KR', { month:'short', day:'numeric' }) : '';
          return `- ${t} · ${n.title}`;
        }).join('\n');
      }
    } catch(_) {}

    const gainersText = gainers.length
      ? '상승 Top: ' + gainers.map(g => `${g.name || g.id}(${g.chg>=0?'+':''}${Number(g.chg||0).toFixed(2)}%)`).join(', ')
      : '';
    const losersText = losers.length
      ? '하락 Top: ' + losers.map(l => `${l.name || l.id}(${Number(l.chg||0).toFixed(2)}%)`).join(', ')
      : '';

    const prompt = `당신은 주식·섹터 애널리스트입니다. "${sector}" 섹터/토픽에 대해 **쉬운 한국어**로 간결하게 분석해주세요.

[섹터 정보]
- 이름: ${sector}
- 종목 수: ${count || 0}
- 평균 등락률: ${avgChg >= 0 ? '+' : ''}${Number(avgChg||0).toFixed(2)}%
${gainersText ? '- ' + gainersText : ''}
${losersText ? '- ' + losersText : ''}
${newsBlock}

[출력 형식] 각 섹션 2~3문장 이내, 굵은 글씨 활용:

## 📊 오늘의 움직임
(오늘 왜 올랐/내렸는지, 뉴스·거시 요인 중심으로)

## 🏢 산업 전망
(향후 1~3년 성장 동력·리스크)

## 💰 가치 평가
(현재 밸류에이션 수준, 매력도)

마지막에 한 줄 **"💡 한 줄 총평:"** 으로 마무리.
투자 권유는 하지 마시고 정보 제공 목적임을 유지해주세요.`;

    const { text: analysis, model: usedModel, usage } = await callGemini(prompt);
    logAiUsage({
      userId: req.user?.id || null,
      endpoint: 'ai-sector',
      model: usedModel,
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      context: { sector, avgChg, count },
    });
    logEvent({ userId: req.user?.id, type: 'ai_analyze', target: `sector:${sector}`, ip: req.ip });

    const result = { ok: true, sector, analysis, model: usedModel, generatedAt: new Date().toISOString() };
    setCached(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════
//  정적 HTML 서빙 (배포 환경용 — API 라우트 뒤에 배치)
// ════════════════════════════════════════════════
//  server/ 의 부모 디렉토리(프로젝트 루트)에 있는 HTML 을 같은 오리진에서 서빙
//  → 배포 시 CORS 불필요, 쿠키 natively 동작
// HTML 및 정적 자산은 server/ 안에 같이 위치 (Railway Root Directory=server 호환)
const STATIC_ROOT = __dirname;
// HTML 은 무조건 fresh — max-age=0 만으로는 일부 브라우저가 304 재사용하는 케이스가
// 있어 2026-04-20 배포 후에도 구 HTML 로 eval 실행되는 사고 있었음.
// no-store 로 강제 재다운 보장.
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(STATIC_ROOT, 'StockRadar_v5.html'));
});
app.get('/admin', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(STATIC_ROOT, 'admin.html'));
});

// 🔐 민감 경로 차단 — 서버 소스·DB·env·node_modules 절대 노출 금지
const BLOCKED_PATH = /^\/(node_modules(\/|$)|\.git(\/|$))|\.(js|cjs|mjs|ts|json|toml|yml|yaml|env|db|db-wal|db-shm|db-journal|log|lock)$/i;
app.use((req, res, next) => {
  if (BLOCKED_PATH.test(req.path)) return res.status(404).end();
  next();
});

// 정적 자산 — HTML·이미지·favicon 등. dotfiles 자동 차단 + 위 미들웨어 추가 차단.
app.use(express.static(STATIC_ROOT, {
  index: false,
  extensions: ['html'],
  dotfiles: 'deny',
}));

// ─── 공개: 클라이언트 이벤트 수집 ───────────
//  바디: { type, target?, meta? }
//  레이트 리밋은 별도 미들웨어 없이 길이/타입 화이트리스트로 방어
const EVENT_TYPES = new Set(['search', 'page_view', 'filter', 'chip_click', 'detail_open']);
app.post('/api/events', (req, res) => {
  const { type, target, meta } = req.body || {};
  if (!type || !EVENT_TYPES.has(String(type))) return res.status(400).json({ ok: false, error: 'INVALID_TYPE' });
  logEvent({
    userId: req.user?.id,
    type: String(type),
    target: target ? String(target).slice(0, 200) : null,
    meta: (meta && typeof meta === 'object') ? meta : null,
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ─── 공개: 문의하기 ─────────────────────────
//  로그인 여부 무관 (비로그인은 email 필수). rate limit 으로 스팸 방어
const INQUIRY_CATEGORIES = new Set(['general','account','bug','feature','payment','other']);
app.post('/api/inquiries', (req, res) => {
  try {
    const { category, subject, message, email } = req.body || {};
    if (!subject || typeof subject !== 'string' || !message || typeof message !== 'string') {
      return res.status(400).json({ ok: false, error: 'subject·message 필요' });
    }
    if (subject.length > 200 || message.length > 4000) {
      return res.status(400).json({ ok: false, error: 'TOO_LONG' });
    }
    const cat = INQUIRY_CATEGORIES.has(category) ? category : 'general';
    const userId = req.user?.id || null;
    const emailFinal = userId ? (req.user.email) : (email || '').toString().trim();
    if (!userId && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailFinal)) {
      return res.status(400).json({ ok: false, error: '유효한 이메일 필요 (비로그인 시)' });
    }
    const now = Date.now();
    const r = db.prepare(`
      INSERT INTO inquiries (user_id, email, category, subject, message, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(userId, emailFinal, cat, subject.slice(0, 200), message.slice(0, 4000), now, now);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/inquiries/mine', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  const rows = db.prepare(`
    SELECT id, category, subject, message, status, admin_reply, replied_at, created_at, updated_at
    FROM inquiries WHERE user_id = ? ORDER BY id DESC
  `).all(req.user.id);
  res.json({ ok: true, inquiries: rows });
});

// ─── 공개: 투자 가이드 글 (발행된 것만) ─────
app.get('/api/articles', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, slug, category, emoji, title, summary, body, read_min, published_at
      FROM articles
      WHERE status = 'published'
      ORDER BY published_at DESC, id DESC
    `).all();
    res.json({ ok: true, articles: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/articles/:slug', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT id, slug, category, emoji, title, summary, body, read_min, published_at
      FROM articles WHERE slug = ? AND status = 'published'
    `).get(req.params.slug);
    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true, article: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── 공개: 활성 공지사항 (사용자 페이지 상단 배너용) ──
app.get('/api/notices/active', (_req, res) => {
  try {
    const now = Date.now();
    const rows = db.prepare(`
      SELECT id, title, body, level, starts_at, ends_at, created_at, updated_at
      FROM notices
      WHERE enabled = 1
        AND (starts_at IS NULL OR starts_at <= ?)
        AND (ends_at IS NULL OR ends_at >= ?)
      ORDER BY id DESC
      LIMIT 5
    `).all(now, now);
    res.json({ ok: true, notices: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── 전역 에러 핸들러 (DB에 기록) ────────────
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  logError({
    level: status >= 500 ? 'error' : 'warn',
    source: 'express',
    message: err.message || String(err),
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    status,
    userId: req.user?.id || null,
    ip: req.ip,
  });
  console.error('[express error]', req.method, req.originalUrl, err.message);
  if (res.headersSent) return;
  res.status(status).json({ ok: false, error: err.message || 'Server error' });
});

// ─── process-level 예외 포착 ────────────
process.on('unhandledRejection', (reason) => {
  const r = reason instanceof Error ? reason : new Error(String(reason));
  logError({ level: 'error', source: 'unhandledRejection', message: r.message, stack: r.stack });
  console.error('[unhandledRejection]', r);
});
process.on('uncaughtException', (err) => {
  logError({ level: 'error', source: 'uncaughtException', message: err.message, stack: err.stack });
  console.error('[uncaughtException]', err);
});

// ─── 서버 시작 ───
app.listen(PORT, () => {
  console.log(`\n✅ 서버가 켜졌어요!`);
  console.log(`   주소: http://localhost:${PORT}`);
  console.log(`   메인: http://localhost:${PORT}/`);
  console.log(`   어드민: http://localhost:${PORT}/admin`);
  console.log(`   상태확인: http://localhost:${PORT}/api/status\n`);
});
