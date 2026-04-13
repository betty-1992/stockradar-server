// ════════════════════════════════════════════════
//  ETF 큐레이션 리스트 — 국내 + 미국
// ════════════════════════════════════════════════
//  각 항목에는 Yahoo 티커(.KS/.KQ 자동 해석), 표시명, 테마(tag), 추적 지수(idx) 포함
//  서버는 fetchYahooQuote 로 실시간 가격 조회 → MASTER 에 병합됨
//
//  추가/제거 자유롭게. 거래량 적은 건 빼는 게 UX 에 좋음.
// ════════════════════════════════════════════════

// ─── 국내 ETF (KRX) ─────────────────────────────
//  nm: 한글 표시명 (Yahoo 가 주는 이름이 종종 엉뚱해서 직접 고정)
//  sec: 섹터/테마 분류 (스크리너 필터 호환)
//  idx: 추적 지수/자산
//  tag: 검색/필터용 키워드
const KR_ETFS = {
  // ── 국내 대표 지수 ───────────────────────
  '069500': { nm:'KODEX 200',                sec:'ETF-국내지수', idx:'KOSPI200',      tag:['코스피','대형주','지수'] },
  '102110': { nm:'TIGER 200',                sec:'ETF-국내지수', idx:'KOSPI200',      tag:['코스피','지수'] },
  '229200': { nm:'KODEX 코스닥150',           sec:'ETF-국내지수', idx:'코스닥150',     tag:['코스닥','지수'] },
  '122630': { nm:'KODEX 레버리지',            sec:'ETF-레버리지', idx:'KOSPI200 x2',   tag:['레버리지','지수'] },
  '252670': { nm:'KODEX 200선물인버스2X',     sec:'ETF-인버스',   idx:'KOSPI200 -2x',  tag:['인버스','숏'] },
  '114800': { nm:'KODEX 인버스',              sec:'ETF-인버스',   idx:'KOSPI200 -1x',  tag:['인버스','숏'] },
  '233740': { nm:'KODEX 코스닥150레버리지',   sec:'ETF-레버리지', idx:'코스닥150 x2',  tag:['레버리지','코스닥'] },

  // ── 미국 시장 추종 ───────────────────────
  '379800': { nm:'KODEX 미국S&P500TR',        sec:'ETF-미국지수', idx:'S&P500 TR',     tag:['미국','S&P500','대형주'] },
  '360200': { nm:'ACE 미국S&P500',            sec:'ETF-미국지수', idx:'S&P500',        tag:['미국','S&P500'] },
  '360750': { nm:'TIGER 미국S&P500',          sec:'ETF-미국지수', idx:'S&P500',        tag:['미국','S&P500'] },
  '379810': { nm:'KODEX 미국나스닥100TR',     sec:'ETF-미국지수', idx:'NASDAQ100 TR',  tag:['미국','나스닥100','테크'] },
  '133690': { nm:'TIGER 미국나스닥100',       sec:'ETF-미국지수', idx:'NASDAQ100',     tag:['미국','나스닥100','테크'] },
  '367380': { nm:'ACE 미국나스닥100',         sec:'ETF-미국지수', idx:'NASDAQ100',     tag:['미국','나스닥100'] },
  '437080': { nm:'RISE 미국나스닥100',        sec:'ETF-미국지수', idx:'NASDAQ100',     tag:['미국','나스닥100'] },
  '381180': { nm:'TIGER 미국필라델피아반도체', sec:'ETF-반도체',   idx:'SOX',           tag:['미국','반도체','SOX','SMH'] },
  '465580': { nm:'ACE 미국빅테크TOP7+',       sec:'ETF-미국테크', idx:'빅테크7',       tag:['미국','빅테크','테크'] },
  '487230': { nm:'KODEX 미국AI전력핵심인프라', sec:'ETF-AI인프라', idx:'AI 전력',       tag:['AI','전력','인프라','미국'] },
  '483320': { nm:'TIGER 미국AI빅테크10',      sec:'ETF-미국테크', idx:'AI 빅테크',     tag:['AI','빅테크','테크'] },
  '473460': { nm:'KODEX 미국서학개미',        sec:'ETF-미국테크', idx:'서학개미TOP',   tag:['미국','테크','대표주'] },
  '400590': { nm:'TIGER 미국테크TOP10',       sec:'ETF-미국테크', idx:'미국 테크TOP10', tag:['미국','테크'] },

  // ── 미국 배당/채권 ───────────────────────
  '458730': { nm:'TIGER 미국배당다우존스',    sec:'ETF-배당',     idx:'SCHD',          tag:['배당','미국','SCHD'] },
  '453850': { nm:'ACE 미국배당다우존스',      sec:'ETF-배당',     idx:'SCHD',          tag:['배당','미국'] },
  '476030': { nm:'TIGER 미국배당+7%프리미엄', sec:'ETF-배당',     idx:'JEPQ계열',      tag:['배당','커버드콜','프리미엄'] },
  '442580': { nm:'KODEX 미국배당프리미엄',    sec:'ETF-배당',     idx:'커버드콜',      tag:['배당','커버드콜'] },

  // ── 2차전지·전기차 ──────────────────────
  '305720': { nm:'KODEX 2차전지산업',          sec:'ETF-2차전지',  idx:'2차전지',       tag:['2차전지','배터리'] },
  '305540': { nm:'TIGER 2차전지테마',          sec:'ETF-2차전지',  idx:'2차전지테마',   tag:['2차전지','배터리'] },
  '371460': { nm:'TIGER 차이나전기차SOLACTIVE', sec:'ETF-중국',    idx:'중국 전기차',   tag:['중국','전기차','2차전지'] },
  '455030': { nm:'TIGER 2차전지소재Fn',        sec:'ETF-2차전지',  idx:'2차전지 소재',  tag:['2차전지','소재'] },

  // ── 반도체·테크 ─────────────────────────
  '139260': { nm:'TIGER 반도체',               sec:'ETF-반도체',   idx:'KRX 반도체',    tag:['반도체','국내'] },
  '091160': { nm:'KODEX 반도체',               sec:'ETF-반도체',   idx:'KRX 반도체',    tag:['반도체','국내'] },
  '091230': { nm:'TIGER 헬스케어',             sec:'ETF-바이오',   idx:'KRX 헬스케어',  tag:['바이오','헬스케어'] },
  '266420': { nm:'KODEX 바이오',               sec:'ETF-바이오',   idx:'KRX 바이오',    tag:['바이오','헬스케어'] },

  // ── 방산·테마 ───────────────────────────
  '449450': { nm:'PLUS K방산',                 sec:'ETF-방산',     idx:'K방산',         tag:['방산','국방','국내'] },
  '445290': { nm:'KODEX K-방산',               sec:'ETF-방산',     idx:'K방산',         tag:['방산','국방'] },
  '466940': { nm:'TIGER K방산&우주',           sec:'ETF-방산',     idx:'방산우주',      tag:['방산','우주'] },

  // ── 섹터 테마 ───────────────────────────
  '091170': { nm:'KODEX 은행',                 sec:'ETF-금융',     idx:'KRX 은행',      tag:['금융','은행'] },
  '139240': { nm:'TIGER 200중공업',            sec:'ETF-중공업',   idx:'KRX 중공업',    tag:['조선','기계','중공업'] },
  '139230': { nm:'TIGER 200건설',              sec:'ETF-건설',     idx:'KRX 건설',      tag:['건설'] },
  '261240': { nm:'KODEX WTI원유선물(H)',       sec:'ETF-원자재',   idx:'WTI 원유',      tag:['원유','원자재'] },
  '132030': { nm:'KODEX 골드선물(H)',          sec:'ETF-원자재',   idx:'Gold',          tag:['금','원자재'] },
  '319640': { nm:'TIGER 골드선물(H)',          sec:'ETF-원자재',   idx:'Gold',          tag:['금','원자재'] },

  // ── 채권 ────────────────────────────────
  '114260': { nm:'KODEX 국고채3년',             sec:'ETF-채권',    idx:'KTB 3Y',        tag:['채권','국고채'] },
  '153130': { nm:'KODEX 단기채권',              sec:'ETF-채권',    idx:'단기채',        tag:['채권','단기'] },
  '411060': { nm:'ACE 미국30년국채액티브(H)',   sec:'ETF-미국채권', idx:'US 30Y',       tag:['미국채','장기채','TLT'] },
  '451530': { nm:'RISE 미국장기국채선물(H)',    sec:'ETF-미국채권', idx:'US 20Y+',      tag:['미국채','장기채'] },

  // ── 국내 배당·리츠 ──────────────────────
  '251340': { nm:'KODEX 고배당',                sec:'ETF-배당',    idx:'KRX 고배당',    tag:['배당','고배당'] },
  '315930': { nm:'TIGER 리츠부동산인프라',      sec:'ETF-리츠',    idx:'KRX 리츠',      tag:['리츠','부동산'] },
  '329200': { nm:'KODEX TRF3070',               sec:'ETF-혼합',    idx:'주식70/채권30', tag:['혼합','자산배분'] },
};

// ─── 미국 ETF (NYSE / Nasdaq) ────────────────────
const US_ETFS = {
  // ── 시장 ETF ─────────────────────────────
  'SPY':  { nm:'SPDR S&P 500',              sec:'ETF-미국지수', idx:'S&P500',    tag:['미국','S&P500'] },
  'VOO':  { nm:'Vanguard S&P 500',          sec:'ETF-미국지수', idx:'S&P500',    tag:['미국','S&P500'] },
  'IVV':  { nm:'iShares Core S&P 500',      sec:'ETF-미국지수', idx:'S&P500',    tag:['미국','S&P500'] },
  'VTI':  { nm:'Vanguard Total Market',     sec:'ETF-미국지수', idx:'US Total',  tag:['미국','전체'] },
  'QQQ':  { nm:'Invesco QQQ Trust',         sec:'ETF-미국지수', idx:'NASDAQ100', tag:['나스닥100','테크'] },
  'QQQM': { nm:'Invesco QQQ (저보수)',      sec:'ETF-미국지수', idx:'NASDAQ100', tag:['나스닥100','저보수'] },
  'DIA':  { nm:'SPDR Dow Jones',            sec:'ETF-미국지수', idx:'Dow Jones', tag:['다우','대형주'] },
  'IWM':  { nm:'iShares Russell 2000',      sec:'ETF-미국지수', idx:'Russell2000', tag:['소형주','러셀'] },

  // ── 반도체·AI ────────────────────────────
  'SMH':  { nm:'VanEck Semiconductor',      sec:'ETF-반도체', idx:'Semis',       tag:['반도체','AI','SOX'] },
  'SOXX': { nm:'iShares Semiconductor',     sec:'ETF-반도체', idx:'ICE Semi',    tag:['반도체','AI'] },
  'SOXL': { nm:'Direxion Semi Bull 3X',     sec:'ETF-레버리지', idx:'SOX x3',    tag:['반도체','레버리지','3X'] },
  'NVDL': { nm:'GraniteShares NVDA 2X',     sec:'ETF-레버리지', idx:'NVDA x2',   tag:['엔비디아','레버리지'] },

  // ── 섹터 SPDR ────────────────────────────
  'XLK':  { nm:'Tech Select Sector',        sec:'ETF-섹터', idx:'Tech',       tag:['테크','섹터'] },
  'XLF':  { nm:'Financial Select Sector',   sec:'ETF-섹터', idx:'Financials', tag:['금융','섹터'] },
  'XLV':  { nm:'Health Care Select',        sec:'ETF-섹터', idx:'Healthcare', tag:['헬스케어','섹터'] },
  'XLE':  { nm:'Energy Select Sector',      sec:'ETF-섹터', idx:'Energy',     tag:['에너지','섹터'] },
  'XLI':  { nm:'Industrial Select',         sec:'ETF-섹터', idx:'Industrials',tag:['산업재','섹터'] },
  'XLY':  { nm:'Consumer Discretionary',    sec:'ETF-섹터', idx:'ConsDisc',   tag:['경기소비','섹터'] },
  'XLP':  { nm:'Consumer Staples',          sec:'ETF-섹터', idx:'Staples',    tag:['필수소비','섹터'] },
  'XLU':  { nm:'Utilities Select',          sec:'ETF-섹터', idx:'Utilities',  tag:['유틸리티','섹터'] },
  'XLRE': { nm:'Real Estate Select',        sec:'ETF-섹터', idx:'REIT',       tag:['리츠','부동산','섹터'] },
  'XLC':  { nm:'Communication Services',    sec:'ETF-섹터', idx:'Comm',       tag:['통신','섹터'] },

  // ── 배당 ────────────────────────────────
  'SCHD': { nm:'Schwab US Dividend',        sec:'ETF-배당', idx:'Div 100',     tag:['배당'] },
  'VIG':  { nm:'Vanguard Div Appreciation', sec:'ETF-배당', idx:'Div Growth',  tag:['배당성장'] },
  'VYM':  { nm:'Vanguard High Dividend',    sec:'ETF-배당', idx:'High Div',    tag:['배당'] },
  'JEPI': { nm:'JPMorgan Premium Income',   sec:'ETF-배당', idx:'Covered Call',tag:['배당','커버드콜'] },
  'JEPQ': { nm:'JPMorgan Nasdaq Premium',   sec:'ETF-배당', idx:'QQQ 커버드콜',tag:['배당','커버드콜','나스닥'] },
  'DVY':  { nm:'iShares Select Dividend',   sec:'ETF-배당', idx:'Div Select',  tag:['배당'] },

  // ── 성장·테마 ───────────────────────────
  'ARKK': { nm:'ARK Innovation',            sec:'ETF-테마', idx:'Disruptive',  tag:['혁신','성장','ARK'] },
  'ARKQ': { nm:'ARK Autonomous & Robot',    sec:'ETF-테마', idx:'AI/Robot',    tag:['AI','로봇','자율주행'] },
  'ARKG': { nm:'ARK Genomic Revolution',    sec:'ETF-테마', idx:'Genomics',    tag:['바이오','게놈'] },
  'XBI':  { nm:'SPDR Biotech',              sec:'ETF-바이오', idx:'Biotech',   tag:['바이오','생명공학'] },
  'IBB':  { nm:'iShares Biotechnology',     sec:'ETF-바이오', idx:'Biotech',   tag:['바이오','생명공학'] },
  'TAN':  { nm:'Invesco Solar',             sec:'ETF-친환경', idx:'Solar',     tag:['태양광','친환경'] },
  'ICLN': { nm:'iShares Clean Energy',      sec:'ETF-친환경', idx:'Clean',     tag:['친환경','재생에너지'] },
  'LIT':  { nm:'Global X Lithium',          sec:'ETF-2차전지', idx:'Lithium',  tag:['리튬','배터리','2차전지'] },
  'ITA':  { nm:'iShares Aerospace&Defense', sec:'ETF-방산', idx:'Defense',     tag:['방산','항공우주'] },

  // ── 채권 ────────────────────────────────
  'TLT':  { nm:'iShares 20+Y Treasury',     sec:'ETF-미국채권', idx:'US 20Y+',   tag:['미국채','장기채'] },
  'IEF':  { nm:'iShares 7-10Y Treasury',    sec:'ETF-미국채권', idx:'US 7-10Y',  tag:['미국채','중기채'] },
  'BND':  { nm:'Vanguard Total Bond',       sec:'ETF-채권', idx:'US Agg',        tag:['채권','종합'] },
  'AGG':  { nm:'iShares Core US Aggregate', sec:'ETF-채권', idx:'US Agg',        tag:['채권','종합'] },

  // ── 원자재·크립토 ───────────────────────
  'GLD':  { nm:'SPDR Gold',                 sec:'ETF-원자재', idx:'Gold',        tag:['금','원자재'] },
  'SLV':  { nm:'iShares Silver',            sec:'ETF-원자재', idx:'Silver',      tag:['은','원자재'] },
  'USO':  { nm:'US Oil Fund',               sec:'ETF-원자재', idx:'WTI',         tag:['원유','원자재'] },
  'IBIT': { nm:'iShares Bitcoin Trust',     sec:'ETF-크립토', idx:'BTC',         tag:['비트코인','크립토'] },
  'FBTC': { nm:'Fidelity Bitcoin',          sec:'ETF-크립토', idx:'BTC',         tag:['비트코인','크립토'] },
  'BITO': { nm:'ProShares Bitcoin Strategy',sec:'ETF-크립토', idx:'BTC Futures', tag:['비트코인','크립토'] },

  // ── 국제 ────────────────────────────────
  'VEA':  { nm:'Vanguard Developed',        sec:'ETF-국제', idx:'Developed',    tag:['선진국','해외'] },
  'VWO':  { nm:'Vanguard Emerging',         sec:'ETF-국제', idx:'EM',           tag:['신흥국','해외'] },
  'INDA': { nm:'iShares India',             sec:'ETF-국제', idx:'India',        tag:['인도','신흥국'] },
  'MCHI': { nm:'iShares China Large-Cap',   sec:'ETF-국제', idx:'China',        tag:['중국','해외'] },
  'EWJ':  { nm:'iShares Japan',             sec:'ETF-국제', idx:'Japan',        tag:['일본','해외'] },

  // ── 레버리지 ────────────────────────────
  'TQQQ': { nm:'ProShares UltraPro QQQ',    sec:'ETF-레버리지', idx:'QQQ x3',   tag:['나스닥','레버리지','3X'] },
  'SQQQ': { nm:'ProShares UltraPro Short Q',sec:'ETF-레버리지', idx:'QQQ -3x',  tag:['나스닥','인버스','3X'] },
  'UPRO': { nm:'ProShares UltraPro S&P500', sec:'ETF-레버리지', idx:'S&P x3',   tag:['S&P500','레버리지','3X'] },
};

module.exports = { KR_ETFS, US_ETFS };
