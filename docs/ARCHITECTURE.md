# StockRadar — 시스템 설계 · 파일 역할

> 시스템 전반 구조. 상세 결정 배경은 `docs/research/architecture.md` 참고.

---

## 스택

- **백엔드**: Node.js 20 / Express 5 / better-sqlite3 (→ PostgreSQL 전환 예정, `MEMORY.md` 참조)
- **프론트엔드**: 단일 HTML SPA (`StockRadar_v5.html`, ~15k 줄) — 현재 백엔드에서 함께 서빙
- **배포**: Railway (풀스택 단일 배포). Vercel 프론트 분리는 향후 과제
- **외부 API**: 네이버 금융 (KR 실시간 시세·과거 일봉), Yahoo Finance (US 시세·과거 차트), Gemini (AI 텍스트 + Vision), FinanceDataReader (KR 유니버스 CSV 생성, 1회성), Resend (이메일)

## 배포 URL

| 환경 | URL | 비고 |
|------|-----|------|
| Production | https://stockradar-server-production-394b.up.railway.app | Railway 기본 도메인. 커스텀 도메인 미연결 (Phase 후반 예정) |

- 헬스체크: `GET /api/universe` → `{ ok: true, counts: {...} }`
- Railway 대시보드: Betty 계정 `stockradar / production` 프로젝트

---

## 파일 역할 맵

| 파일 | 역할 |
|------|------|
| `server/index.js` | Express 메인 — 시세·뉴스·AI·**히스토리**·**OCR**·**AI 시나리오** API, `callGemini()` 공통 함수 (멀티모달 지원), `fetchNaverKrQuote`·`fetchNaverKrQuotesBatch`·`fetchKrHistory`·`fetchUsHistory` |
| `server/auth.js` | 회원가입·로그인·Google OAuth·포트폴리오(holdings)·**거래 이력(transactions)** API |
| `server/admin.js` | 어드민 API — ⚠️ Gemini 직접 호출 (이중 관리). 운영 엔드포인트 (`/ops/dbinfo`, `/ops/backup`, `/script/start`) |
| `server/db.js` | SQLite 마이그 v1~**v12** + `seedStocksIfEmpty()` + `expandKrUniverseIfNeeded()` 자동 복구 |
| `server/middleware.js` | `attachUser` / `requireAuth` / `requireAdmin` |
| `server/email.js` | Resend 이메일 발송 |
| `server/etfs.js` | KR/US ETF 초기 큐레이션 (확장분은 stocks 테이블 `source='krx-etf'`) |
| `server/scripts/seed-stocks.js` | 하드코딩 데이터 → DB 이전 1회성 |
| `server/scripts/fetch-krx-universe.js` | **FDR 로 만든 KR 주식 CSV → stocks 주입** (2,591) |
| `server/scripts/fetch-kr-etfs.js` | **FDR KR ETF CSV → stocks 주입** (~820, is_etf=1) |
| `server/scripts/fetch-us-stocks.js` | Yahoo → US stocks 재무지표 수집 (Yahoo 차단 해제 대기) |
| `server/scripts/fetch-kr-stocks.js` | Yahoo → KR stocks 재무지표 수집 (동) |
| `server/scripts/data/kr-universe.csv` | KOSPI+KOSDAQ 주식 2,770행 (FDR 1회 생성) |
| `server/scripts/data/kr-etfs.csv` | KRX ETF 1,093행 (FDR 1회 생성) |
| `server/scripts/lib/fetch-utils.js` | openDb / httpGetJson / makeUpsertStock 공통 유틸 |
| `StockRadar_v5.html` | 사용자 SPA — ⚠️ 수정 전 반드시 범위 보고. 시뮬레이터·OCR·거래 기록 UI 포함 |
| `admin.html` | 어드민 콘솔 — DB 백업 버튼 포함 |

---

## 상세 문서 위치

- **아키텍처 결정 배경**: `docs/research/architecture.md`
- **DB 스키마**: `docs/DATABASE.md` → `docs/research/db-schema.md`
- **API 스펙**: `docs/API.md` → `docs/research/api-specs.md`
- **초기 감사 기록**: `docs/research/audit-초기점검.md`

---

## 로컬 스토리지 키 (프론트, `sr_*`)

| 키 | 타입 | 용도 |
|----|------|------|
| `sr_wl` | string[] | 즐겨찾기 종목 심볼 |
| `sr_kws` | string[] | 관심 키워드 |
| `sr_pf` | object[] | 포트폴리오 보유 종목 |
| `sr_theme` | string | 테마 (auto/light/dark) |
| `sr_fs` | string | 폰트 크기 |
| `sr_dashboard_layout` | object[] | 대시보드 위젯 레이아웃 |
| `sr_recent_viewed` | string[] | 최근 본 종목 (최대 8개) |
| `sr_alert` | object | 알림 설정 |
| `sr_refresh_min` | number | 자동 새로고침 주기(분) |
| `sr_lnb_collapsed` | boolean | LNB 접힘 상태 |
| `sr_batch_cache` | object | 배치 데이터 캐시 |
| `sr_last_refresh` | number | 마지막 새로고침 timestamp |
| `sr_sim_scenarios` | object[] | 시뮬레이터 저장 시나리오 (최대 20개) |

---

## 시뮬레이터 데이터 플로우 (2026-04-20)

```
입력: items(종목+비중) + 기간 + 방식(lump/monthly/weekly) + 금액
  ↓
프론트: /api/history?symbol=...&period=Ny 병렬 호출 (종목당 1회)
  ↓
[🔮 미래 예상] _computeScenario()
  - 각 종목 정규화(r = c/start) → 가중 NAV 재구성
  - CAGR, MDD 추출
  - 낙관(×1.3)·중립·비관(max(×0.5, −5%p)) 3시나리오 future projection
  - FV 공식: lump = A×(1+r)^t, monthly/weekly = A×((1+rm)^k − 1)/rm
[📊 과거 검증] _computeBacktest()
  - 공통 기간 내 주기(7/30일)마다 실제 가격에 매수 시뮬
  - KR: floor(배분액/가격) 정수 주 · US: 배분액/가격 소수점
  - 잔돈 → cash 누적 (재사용 X)
  - NAV 시계열 + 종목별 누적 수량 + 현금잔고
  ↓
결과 렌더 (Chart.js) + 저장(localStorage)
  ↓
🤖 "스톡이에게 물어보기" → POST /api/ai-scenario
  - 서버: stocks 테이블로 sector·is_etf 보강 + 구성 집계 (국가·섹터·ETF)
  - callGemini() 재사용, "관찰→해석→시사점" 5각도 강제 프롬프트
  - 본문 dim + 볼드만 강조 CSS (.sim-ai-card)
```

## OCR 데이터 플로우 (2026-04-20)

```
사용자 이미지 업로드 (증권사 앱 캡처, 최대 5장)
  ↓
프론트 FileReader → base64 → POST /api/portfolio/ocr (12MB)
  ↓
서버: callGemini(prompt, { images }) — Gemini 2.5-flash-vision
  프롬프트: { name, ticker, quantity, avg_price, currency } JSON 강제
           + 한국 증권사 앱 함정 주의 (평가금액·원화 환산·TIGER 국내 ETF)
  ↓
findMatch(name, ticker): ticker 직매칭 (name 교차 검증) → name 완전 → LIKE → 역방향 토큰
  ↓
응답: items[] { name, ticker, quantity, avg_price, currency, matchedSymbol, matchedMarket }
  ↓
프론트 결과 테이블 — 통화(KRW/USD) 시각 표시 + 편집 가능 + 체크박스 선택
  ↓
savePortfolioRow() 반복 호출 → user_holdings 저장
```
