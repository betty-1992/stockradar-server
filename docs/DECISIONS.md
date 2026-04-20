# StockRadar — 의사결정 기록 (ADR)

> 이미 내린 결정과 이유. 불변 기록.
> 아직 미결정 사안은 `INSIGHTS.md`, 현재 TODO는 `MEMORY.md`.

---

| 날짜 | 결정 | 이유 |
|------|------|------|
| MVP | SQLite 사용 | 빠른 개발, 추후 PostgreSQL 전환 예정 |
| MVP | 단일 HTML SPA | 빠른 개발, 추후 모듈 분리 예정 |
| MVP | helmet CSP off | 인라인 스크립트 다수, SPA 분리 후 재활성 예정 |
| 2026-04-15 | 포트폴리오 PK = (user_id, stock_id) 복합키 + upsert | 동일 종목 재매수 시 평단 재계산, lot 분할 안 함 — 단순화 우선 |
| 2026-04-15 | 포트폴리오 통화 혼합 V1은 분리 카드 | 환율 적용 로직·실시간 환율 캐시 추가 복잡도 회피 |
| 2026-04-15 | 포트폴리오 거래 이력 V2로 미룸 | MVP는 현재 보유 스냅샷 충분, 이력은 매도/실현손익과 묶어 일괄 추가 |
| 2026-04-15 | 종목 마스터 DB 전환 시작 — stocks(v10) + stock_curation 테이블, PK=symbol 단일, Phase 0~4 계획 | 하드코딩 MASTER/KOREAN_TICKERS/KR_INFO → DB 기반 전환. 정량/정성값 분리로 재수집 덮어쓰기 방지. 기존 `/api/universe` 응답 스키마 유지해 프론트 무변경 |
| 2026-04-18 | Phase 2 is_curated=1 은 identity·재무지표 모두 "완전 보호" — upsert 스킵 | 큐레이터 의도가 최우선. 재무지표 리프레시가 필요하면 stock_curation.note 수동 flag 또는 별도 refresh 스크립트로 분리 |
| 2026-04-18 | KR 수집은 Yahoo Finance quoteSummary 비공식 엔드포인트 사용 — cookies+crumb 디스크 캐시, 429 시 5s 백오프, 기본 딜레이 1s | 공식 API 없음, crumb 엔드포인트 IP rate-limit 이 공격적이라 세션 재사용 필수 |
| 2026-04-18 | **US 수집도 Yahoo Finance 로 전환** (FMP Starter → Yahoo). `lib/yahoo-fetch.js` 공통 모듈로 KR/US 통합, 유니버스만 datahub CSV(`s-and-p-500-companies`) 유지 | FMP 스킴이 2025-08-31 이후 변경됨 (legacy v3 전부 403). `/stable/` 경로는 `profile` 만 전 심볼 200, `key-metrics-ttm`/`ratios-ttm`/`income-statement-growth` 는 AAPL 등 대형주 외에 **402 "Special Endpoint: not available under your current subscription"** — Starter 플랜은 재무지표 심볼 게이트. 상위 플랜 업그레이드는 비용 부담 + 게이트 해제 보장 없음. Yahoo 는 무료, KR 과 스킴 통일, 필드 1:1 매칭 가능. 트레이드오프: 비공식 API 로 스킴 변경/차단 리스크 있음 — 추후 재검토 조건은 INSIGHTS.md 참조 |
| 2026-04-18 | **Phase 3 (`/api/universe` DB 전환) 시도 → 즉시 revert** (commit `d9d5a7e` → `31ec855`). 재시도 전 프로덕션 DB seed 선행 + 유니버스 확장 선행 필수 | 배포 직후 total=0 응답 확인. 원인: 프로덕션 Railway 볼륨의 `stocks` 테이블이 비어있음 (v10/v11 마이그는 돌았지만 `seed-stocks.js` 미실행). 로컬 DB 기준 "307행 시드됨" 으로 착각 — 메모리의 Phase 0~1 완료 항목이 로컬/프로덕션 구분 없이 기록돼있던 게 근본 원인. 추가로 Phase 3 는 구조 변경일 뿐 종목 수 확장 효과가 없음을 계산 실수로 잘못 안내 (828 "복귀" 가능하다고 했으나 실제 ~768). Betty 의 원 목적은 "종목 수 확장" 이었으므로 유니버스 소스 자체 확장(KOSPI 전체·Russell 등) 이 선행돼야 의미 있음. 내일 재검토 예정 |
| 2026-04-20 | **프로덕션 seed 자동화 + KR 유니버스 자동 확장** (`db.js` `seedStocksIfEmpty` + `expandKrUniverseIfNeeded`) | Phase 3 재시도 시 유실 방지. Railway 재배포 시 DB 가 비거나 유니버스가 작으면 seed-stocks/fetch-krx-universe/fetch-kr-etfs 를 child_process 로 자동 실행. 임계값: KR 주식 < 1,000 or ETF < 500 이면 확장 스크립트 실행. CSV 는 repo 에 포함되어 컨테이너에서 즉시 사용 가능 |
| 2026-04-20 | **KR 유니버스 확장 데이터 소스 = FinanceDataReader** (pykrx·KRX 공식 API 아님) | KRX `data.krx.co.kr/comm/bldAttendant/getJsonData.cmd` 는 JSESSIONID 있어도 현재 IP 에서 "LOGOUT" 거부. pykrx 도 내부 동일 엔드포인트 사용해 실패. FinanceDataReader 는 Naver 금융 등 다중 소스 폴백 — 한국에서 안정적 통과. CSV 는 1회 생성 후 repo commit (`server/scripts/data/kr-universe.csv`, `kr-etfs.csv`). 갱신은 Python 스크립트 1줄로 재생성 |
| 2026-04-20 | **Phase 3 재배포 — /api/universe DB 기반 전환 완료** (revert-of-revert `43e8df1`) | seed 자동화 + KRX 확장으로 재시도 안전 보장됨. 결과: total 801 → 2,898. US 87 + KR 2,708 + KR ETF 103 + US ETF 55. Betty 원 목표 "종목 수 확장" 3.6배 달성 |
| 2026-04-20 | **KR 실시간 시세 Yahoo → 네이버 polling API 로 전환** (`fetchYahooQuote` 내부 분기) | Yahoo 는 한국 코스닥 소형주 커버리지 부실 — volume=0, timestamp stale, 과거 체결 기반 등락률 왜곡 (예: 미래에셋벤처투자 +19% 오탐 vs 네이버 -1.73% 정확). 네이버 `polling.finance.naver.com/api/realtime/domestic/stock/{code}` 는 실시간 + 정확. US 종목은 그대로 Yahoo. 응답 스키마는 Yahoo 와 동일 맵핑해 프론트 무변경 |
| 2026-04-20 | **`/api/quotes` 를 네이버 멀티 심볼 배치 API 로 고도화** (`fetchNaverKrQuotesBatch`) | 네이버는 `/stock/{code1,code2,...}` 로 100개/호출 지원, 실측 0.06초. 기존 심볼 개별 호출 → 배치 호출로 `/api/quotes` 응답 시간 10~20배 단축 (500 KR 심볼 1.9초 내). 프론트 `loadPrices` 의 BATCH 를 50 → 300 + 3병렬로 올려 초기 로드 2분 → 6~10초 수렴 |
| 2026-04-20 | **초기 로드 범위 축소 + lazy 시세 보충** (`_pickInitialPriceIds` + `ensureLivePrices`) | 2,898개 전체를 매 진입마다 부르지 않음. 시총 상위 500 + 보유 종목 + 관심 종목만 즉시. 나머지는 스크리너 필터 결과 상위 200개 중 `liveData` 없는 심볼만 12초 타임아웃 + 1회 재시도로 보충. 중복 호출 차단 (`_ensureRecent`) |
| 2026-04-20 | **나의 투자 V2-2/V2-3 — 거래 이력 + 실현 손익** (DB v12 `transactions` 테이블) | 사용자 니즈: 매수/매도 이력 날짜별 기록 + 평단 자동 재계산 + 실현손익 추적. 평균원가법: 매수 시 (old_qty × old_avg + new_qty × price) / total 로 평단 재계산, 매도 시 평단 유지 + `realized_pl = (price − avg) × qty` 기록. 전량 매도 시 `user_holdings` 삭제. 트랜잭션 삭제 시 해당 종목 전체 거래 시간순 재생으로 holdings 재구성 (정정 안전) |
| 2026-04-20 | **나의 투자 V2-1 — 원화 환산 통합 평가 카드** | KR+US 두 통화 혼합 보유 시 전체 자산 규모 체감 어려움. `/api/quote/USDKRW=X` 환율로 US 평가금액·손익·원금을 원화 환산해 통합 카드 + 각 행 현재가·평가금액 보조 표시. 평단은 원래 거래 단가라 환산 제외 (매일 환율 변동 시 혼란) |
| 2026-04-20 | **이미지 OCR — Gemini Vision 기반 포트폴리오 자동 등록** (`POST /api/portfolio/ocr`) | Betty 의 "증권사 앱 캡처 업로드 → 자동 매핑" 요구. 멀티모달 Gemini 에 이미지 + 구조화 프롬프트 전달 → `{name, ticker, quantity, avg_price, currency}` JSON 추출. 서버에서 ticker ↔ name 교차 검증으로 오매칭 방지 (예: TIGER 미국S&P500 에 069500 ticker 오인 시 이름 공통 토큰 없어 ticker 무시). name→symbol 매칭 폴백: 완전일치 → 정방향 LIKE → 역방향 토큰 매칭. `express.json({limit:'12mb'})` 전용 라우트 (전역 200kb 회피) |
| 2026-04-20 | **OCR 프롬프트 — 한국 증권사 앱 특유 함정 방어 지시** | (a) 평가금액(수량×평단)을 평단으로 오인하지 말 것. (b) 미국 종목(SCHD·AAPL 등)의 원화 환산 평단을 달러값으로 넣지 말 것. (c) TIGER·KODEX·ARIRANG 등으로 시작하는 국내 ETF 는 "미국/나스닥" 이름에도 `currency=KRW` 고정. (d) 확신 없으면 ticker=null 로 두고 서버 name 매칭에 맡김. Gemini 에 실전 예시·힌트 포함 |
| 2026-04-20 | **시뮬레이터 메뉴 신설 — 2 탭 구조 (🔮 미래 예상 / 📊 과거 검증)** | Betty 요구: "종목 얼마 투자하면 얼마 될까" + "비교". 용어 정리: 백테스트 ≠ 모의투자지만 Betty 타겟(주린이)에는 둘 다 "시뮬레이터" 안에서 충분. 미래 예상 = 과거 CAGR → 복리 추정 (낙관/중립/비관). 과거 검증 = 실제 일봉으로 정수주(KR)·소수점(US) 매수 재현. 각각 다른 효용: 미래 예상은 "대략 얼마", 과거 검증은 "중간 하락 체감". 저장은 localStorage (서버 동기화 미도입 — 솔로 파운더 기준 과투자 회피) |
| 2026-04-20 | **시뮬레이터 입력 모델 = 비중(%) + 총액 1회 입력** (Betty 피드백 기반 재설계) | 초안은 종목별 투자금 직접 입력 → 총액은 합산. Betty 지적: "투자금은 자동 계산 read-only 가 자연스럽다". 재설계: (1) 총 투자금 or 월/주 적립액 1회 (2) 종목 + 비중 %만 (3) 종목당 실제 배분액은 자동 계산 표시 (4) "자동 균등 분배" 버튼. 비중 합계 100% 실시간 검증 |
| 2026-04-20 | **Railway 볼륨 `/data` 마운트 + DB 수동 백업 엔드포인트** (`/api/admin/ops/dbinfo`, `/api/admin/ops/backup`) | 데이터 영속성 3중 방어. (1) Railway 볼륨 `/data/data.db` — 재배포 안전 (DATA_DIR env 확인됨). (2) admin 설정 페이지 "🗄️ DB 스냅샷 다운로드" — `better-sqlite3.backup()` 으로 WAL-safe. Betty 수동 주 1회 Dropbox/iCloud. (3) 서버 기동 시 seed + KRX 확장 자동 복구. S3 자동 업로드는 유저 늘면 검토 |
| 2026-04-20 | **브라우저 캐시 무력화** — `Cache-Control: no-store` 응답 헤더 + `<meta http-equiv>` + `pageshow.persisted` 자동 reload | 배포 후 Betty 브라우저가 계속 구 HTML 실행하던 증상. HTTP 헤더 단독으로는 Safari bfcache 우회 못 함. 3중 방어로 다음 접속부터 무조건 fresh 보장 |
| 2026-04-20 | **스톡이 프롬프트 완화 — 거시·시사 이슈도 답변 허용** | 기존: "주식·ETF·투자 관련만". 변경: "투자에 영향을 주는 전쟁·금리·관세·선거·정책도 '이런 상황 → 어떤 섹터/종목 영향' 구조로 설명". 요리·연예·일상 상담만 거절. Betty 요청 (B 옵션) |
| 2026-04-20 | **시뮬레이터 AI 해설 — 단순 요약 금지 + 인사이트 중심 프롬프트 재설계** | Betty 피드백: 스톡이 답변이 입력 수치를 나열·반복만 함. 해결: 서버에서 stocks 테이블 조회해 포트 구성 분석(국가/섹터/ETF 비중) 선행 집계. 프롬프트에 "⛔ 수치 단순 반복 금지 + 각 불릿 [관찰→해석→시사점] 구조 + 반드시 다룰 5 각도(포트 성격·변동성 폭·MDD 체감·시장 맥락·개선 방향)" 지시 + 나쁜/좋은 예시 제시. 볼드는 핵심 1~2곳만 과용 금지 |
| 2026-04-20 | **시뮬레이터 해설 카드 다크모드 가독성 — 본문 dim + 볼드만 선명** | 모든 불릿이 동일 밝은 색이라 강약 없음. `.sim-ai-card/.sim-ai-list` 분리, 본문 `var(--tx2)` + 다크 `rgba(231,234,240,.72)`, `<b>` 는 `var(--tx)` + 다크 `#fff`. 경고(⚠️) 는 빨강 좌선 박스로 분리 표시 |

---

## 완료된 큰 작업 (히스토리)

### 시뮬레이터 Phase 1~3 — 2026-04-20
- **Phase 1**: `GET /api/history?symbol=xxx&period=1y|3y|5y|10y` — 과거 일봉
  KR 네이버 siseJson (정규식 파서), US Yahoo chart/v8. 캐시 6h.
- **Phase 2a (🔮 미래 예상)**: 과거 N년 CAGR 추출 → 미래 N년 복리 투사.
  낙관(×1.3)·중립·비관(max(×0.5, −5%p)) 3시나리오. 일시금·월적립·주적립.
- **Phase 2b (📊 과거 검증)**: 실제 일봉으로 주기마다 매수 시뮬. KR 정수 주,
  US 소수점 (현실적). 잔돈 현금잔고 누적. NAV 시계열 + Chart.js 라인차트.
- **Phase 3 (🤖 스톡이 AI 해설)**: `POST /api/ai-scenario` — 시나리오 구성·
  결과를 프롬프트로 구성해 callGemini 재호출. 4~6 불릿 + ⚠️ 주의.
- **UX**: 탭 브랜드 그라데이션 강조, 탭별 설명 안내, 저장 접이식 리스트
  (localStorage 기반 `sr_sim_scenarios`, 최대 20개, 이름 검색).

### 나의 투자 V2 (환율·거래이력·실현손익·OCR) — 2026-04-20
- **V2-1 통합 평가 카드**: `/api/quote/USDKRW=X` → 원화 환산 합산.
  미국 카드·각 행 현재가/평가금액에 ≈ 원화 병기.
- **V2-2 거래 이력**: DB v12 `transactions` (id, user_id, stock_id, side,
  quantity, price, traded_at, realized_pl, memo, created_at).
  POST/GET/DELETE `/api/auth/transactions`. 평균원가법.
- **V2-3 실현 손익**: 매도 시 `(price − avg) × qty` 기록. 요약 카드 (KR/US
  통화별) + 거래 이력 테이블.
- **이미지 OCR**: Gemini Vision + name/ticker 교차 검증 매칭 + currency
  강제. POST `/api/portfolio/ocr` (12MB 업로드).
- **UX**: 주력 버튼 2개(이미지·직접 입력) + 더보기 드롭다운(거래 기록·
  CSV). 중복 이미지 자동 제거.

### KR 유니버스 확장 + 시세 전환 — 2026-04-20
- **FinanceDataReader** 로 KR CSV 생성 → `fetch-krx-universe.js` / `fetch-kr-etfs.js`
  로 stocks 테이블 확장. 총 KR 주식 117 → 2,708, ETF 48 → 874.
- `db.js expandKrUniverseIfNeeded()` 기동 시 자동 확장.
- KR 실시간 시세 **네이버 polling API** 전환 (Yahoo 소형주 품질 문제).
  멀티 심볼 배치로 `/api/quotes` 10~20배 가속.
- 초기 로드 범위 축소 (시총 상위 500 + 보유/관심) + `ensureLivePrices` lazy
  보충.

### Phase 3 재배포 완료 — 2026-04-20
- revert-of-revert (`43e8df1`) — seed 자동화 + 유니버스 확장 덕에 안전
- `/api/universe total` : 801 → **2,898**

### 종목 마스터 DB 전환 Phase 2 — 2026-04-18
- DB v11: `stocks.peg` · `stocks.fcf` 컬럼 추가
- 공통 유틸: `server/scripts/lib/fetch-utils.js`, `server/scripts/lib/yahoo-fetch.js` (KR/US 공통 Yahoo auth+quoteSummary+extractFinancials)
- KR 수집기: `fetch-kr-stocks.js` — 심볼 접미사 `.KS`/`.KQ` 순차 시도, `KOREAN_TICKERS` 유니버스
- US 수집기: `fetch-us-stocks.js` — **Yahoo 기반으로 전환 (2026-04-18 재작성)**. 유니버스는 datahub CSV, 심볼 변환 `BRK.B → BRK-B` 규칙 적용. 이전 FMP 버전은 sp500-constituent 402 + 재무지표 심볼 게이트로 사실상 사용 불가 확인 후 폐기
- 리포트: inserted/updated/unchanged/skipped_curated/failed 5구간 카운트
- 인증 캐시: `server/scripts/.yahoo-cache.json` (6h TTL) + `YAHOO_COOKIE`/`YAHOO_CRUMB` env 오버라이드
- 상태: 로컬 smoke 미완 (Yahoo IP rate-limit), 코드·마이그레이션은 검증됨

### 종목 마스터 DB 전환 Phase 0~1 — 2026-04-16
- Phase 0: v10 마이그레이션 (stocks + stock_curation)
- Phase 0.5: FMP 무료 쿼터 실측 → Starter $19/월 구독 결정
- Phase 1: `seed-stocks.js` 1회 실행 — 하드코딩 데이터 307행 DB 이전

### 포트폴리오(나의 투자) V1 — 2026-04-15
- DB: v9 `user_holdings`
- API: `GET/POST/DELETE /api/auth/holdings`
- 프론트: `pg-portfolio` 페이지, 통화별 요약, 테이블, 상세페이지 패널
- 동기화: `reloadUserData()` 에서 자동 덮어쓰기
