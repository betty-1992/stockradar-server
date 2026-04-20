# StockRadar — 기술 부채 & 의사결정 기록

---

## 🌅 내일(2026-04-21) 이어가기 체크리스트

### 오늘(2026-04-20) 상황 요약
- Phase 2 KR/US smoke test 재시도 → **Yahoo 광범위 IP 차단 확인** (일반 집 IP + 모바일 핫스팟 IP 모두 429). 브라우저에서 cookie/crumb 받아 env 주입해도 quoteSummary 자체가 서버 측에서 HTTP 429. TLS fingerprint + HttpOnly cookie 누락 복합 원인 추정. **24~72h 대기 외 즉시 해결 방법 없음**
- ✅ **프로덕션 seed 자동화 구현 완료** — `db.js` 에 `seedStocksIfEmpty()` 추가. stocks 테이블 비어있으면 `child_process.execSync` 로 `seed-stocks.js` 자동 실행 (connection 격리). 로컬 임시 DB 로 1회차 307 insert / 2회차 스킵 검증 완료. **Phase 3 재시도 시 어제 장애(프로덕션 DB 비어있음) 재발 방지**
- ⏸️ KRX 전종목 API 접근 시도 → `data.krx.co.kr/comm/bldAttendant/getJsonData.cmd` 가 JSESSIONID + Referer 갖춰도 "LOGOUT" 응답. pykrx 라이브러리가 매년 패치해야 하는 영역. 단순 curl/fetch 로는 불가 — 다음 세션에 다른 접근 결정 필요

### 📌 이어갈 핵심 결정 사항
- **유니버스 확장 방식** (3개 옵션, 결정 필요):
  - (방식 A) pykrx Python 스크립트로 CSV 1회 생성 → `server/scripts/data/kospi.csv` 커밋 → fetch-krx-universe.js 가 CSV 읽어서 stocks 테이블 upsert. **장점**: 즉시 진행 가능. **단점**: Python 의존, CSV 갱신 수동
  - (방식 B) data.go.kr 공공 API 인증키 발급 (무료) → Node 에서 fetch. **장점**: 자동화 가능. **단점**: 인증키 발급 1~2일 소요
  - (방식 C) FinanceDataReader 또는 Naver 금융 비공식 스크래핑. **장점**: 인증 불요. **단점**: 비공식 — 언제든 깨질 수 있음
  - **추천**: 방식 A (빠른 실행 + 검증) → 나중에 방식 B 로 자동화 전환

### 📋 내일 작업 순서
1. **유니버스 확장 방식 결정 후 실행** — 위 A/B/C 중 선택
2. **fetch-kr-stocks.js 의 loadTickers() 를 DB 우선 조회로 변경** — DB 에 KR 종목 있으면 그것을 유니버스로, 없으면 KOREAN_TICKERS 폴백
3. **Phase 2 Yahoo 수집 재시도** (차단 풀리면) — KR 먼저, 성공 시 US
4. **Phase 3 재배포** — seed 자동화 덕분에 안전. `/api/universe` DB 전환 재시도

### ⚠️ 어제(2026-04-18) 상황 (참고)
- Phase 2 US 수집을 FMP → Yahoo 로 전환 (✅ 배포됨, commit `7c166ae`)
- 문서 체계 표준화 + 프로덕션 URL 등록 (✅ 배포됨, commit `0cfaeda`)
- Phase 3 (`/api/universe` DB 전환) 시도 → **프로덕션 장애 발생 후 revert** (commit `31ec855`). 원인: 프로덕션 DB 의 `stocks` 테이블이 비어있어서 total=0 반환 → 즉시 롤백 완료, 현재 Yahoo 스크리너 방식으로 복구됨 (total 806 확인)
- 현재 프로덕션: https://stockradar-server-production-394b.up.railway.app — Yahoo 스크리너 기반 동적 유니버스 정상 동작 중 (오늘 기준도 동일)

### 🧠 내일 시작 전 반드시 기억할 것 — **Phase 3 는 종목 수 확장이 아니다**
Betty 가 이 작업을 시작한 진짜 동기는 **"현재 800 종목이 적게 느껴진다"** 였음. 그런데 Phase 3 (DB 전환) 은 구조 변경일 뿐이고, 내가 계산 착오로 "Phase 2 수집 후 830 복귀"라고 안내한 게 틀렸음. 실제로는:

| 시점 | US | KR | ETF | Total |
|------|----|----|-----|-------|
| 현재 (Yahoo 스크리너) | 587 (동적) | 114 | 103 | **804~806** |
| Phase 3 + seed | 142 | 165 | 103 | **310** (감소!) |
| Phase 3 + Phase 2 수집 | 500 (S&P500 한계) | 165 (KOREAN_TICKERS 한계) | 103 | **~768** (여전히 감소) |

**구조적 원인**: 유니버스 소스 자체가 작음 (S&P500 500개, KOREAN_TICKERS 하드코딩 116개). 종목 수 확장은 유니버스 소스 확장으로만 가능.

### 🎯 내일 시작 전 Betty 결정 대기 사항

**Q1. 종목 수 스케일** (Betty 가 원하는 규모 확정 필요)
- [ ] (a) ~1,000개 — KOSPI 전체(~900) + S&P500(500) + ETF, 비교적 빠른 확장
- [ ] (b) ~2,500개 — KOSPI + KOSDAQ 주요 + Russell 1000 + ETF, 중형 스크리너
- [ ] (c) 3,000+ — KOSPI + KOSDAQ 전체 + Russell 2000 + ETF, 풀커버

**Q2. "없어서 불편했던 종목"** 구체적 예 수집 (스케일 결정의 근거)

### 📋 내일 작업 순서 (위 결정 확정 후)
1. **유니버스 소스 확장** — 스케일에 맞춰 KRX 상장사 CSV, Russell 1000 CSV 등 소스 추가. `index.js` 하드코딩 KOREAN_TICKERS 제거 예정
2. **프로덕션 seed 자동화** — `db.js` 마이그레이션 직후 `stocks` 비어있으면 `seed-stocks.js` 자동 실행. **Phase 3 재시도 전 필수** (어제 장애 재발 방지, Betty 승인 'A 옵션' 이 이것)
3. **Phase 2 Yahoo 수집** — rate-limit 해제 후 `fetch-kr-stocks.js` + `fetch-us-stocks.js` 실행. 확장된 유니버스에 재무지표 채움
4. **Phase 3 재배포** — DB 에 충분한 데이터 쌓인 뒤, `/api/universe` DB 전환 재시도

---

## 현재 기술 부채

### 🔴 높은 우선순위

- [ ] **SQLite → PostgreSQL 전환**
  - 이유: Railway 재배포 시 볼륨 데이터 유실 위험, 동시 접속 write lock 충돌
  - 영향: db.js 전체, better-sqlite3 → pg 패키지 교체
  - 참고: Railway PostgreSQL 플러그인으로 전환 가능

- [ ] **express-session → Redis 세션 또는 JWT 전환**
  - 이유: 서버 재시작 시 세션 초기화, 수평 확장 불가
  - 영향: auth.js, middleware.js, connect-sqlite3 제거

- [ ] **admin.js Gemini 직접 호출 → callGemini() 통합**
  - 현황: /api/admin/articles/draft 에서 Gemini 직접 호출 중
  - 문제: index.js의 모델 폴백·재시도 로직이 적용 안 됨
  - 수정: admin.js에서 callGemini() 함수 import 해서 사용하도록 변경

- [ ] **StockRadar_v5.html 15,000줄 분리**
  - 이유: 유지보수 불가, 버그 위치 파악 어려움, Claude Code 토큰 낭비
  - 방향: 기능별 JS 모듈 분리 — 섣불리 건드리지 말 것, 별도 계획 필요

### 🟡 중간 우선순위

- [ ] **이메일 인증 활성화**
  - 현황: email_verifications 테이블·attachUser email_verified 컬럼 준비됨, 미사용
  - 이유: 가입 시 봇/스팸 방지 필요

- [ ] **helmet CSP 재활성화**
  - 현황: contentSecurityPolicy: false (인라인 스크립트 많아서 꺼둠)
  - 방향: StockRadar_v5.html 모듈 분리 이후 CSP nonce 방식으로 재활성

- [ ] **결제 모듈 payments.js 분리 준비**
  - 방향: 토스페이먼츠 또는 포트원(아임포트) 연동 예정
  - 주의: 카드정보 절대 자체 DB 저장 금지

- [ ] **개인정보 암호화 저장 검토**
  - 대상: user_keywords, user_favorites (투자 정보 포함)
  - 의무: 개인정보보호법

- [ ] **회원 탈퇴 + 개인정보 삭제 기능**
  - 현황: 미구현 — 개인정보보호법상 필수

### 🟢 낮은 우선순위

- [ ] **node-fetch 제거**
  - 현황: index.js 1곳만 사용, Node 18+ 내장 fetch로 대체 가능

- [ ] **express 5.x RC 안정성 모니터링**
  - 현황: express ^5.2.1 사용 중 (아직 RC 버전대)
  - 조치: major 버그 패치 주시, 필요 시 4.x 다운그레이드 고려

- [ ] **테스트 코드 부재**
  - 현황: devDependencies 없음, 수동 smoke test만 존재
  - 방향: 핵심 API 엔드포인트 jest 또는 vitest 단위 테스트 추가

- [ ] **API 엔드포인트별 Rate Limiting 세분화**
  - 현황: express-rate-limit 전역 적용
  - 방향: /api/auth, /api/ai 별도 제한값 설정

- [ ] **포트폴리오 — 환율 통합 평가금액** (V2)
  - 현황: V1은 KR/US 통화별 분리 카드 2개로 표시. 통합 원화 환산 미지원
  - 방향: 기존 `USD_KRW_RATE` env + Yahoo `KRW=X` 캐시 재활용해 전체 합산 카드 추가

- [ ] **포트폴리오 — 거래 이력(transactions)** (V2)
  - 현황: V1은 현재 보유 스냅샷만. 매수/매도 히스토리 기록 없음
  - 방향: 신규 `transactions` 테이블 (v10+), (user_id, stock_id, side, qty, price, traded_at)
  - 주의: user_holdings 는 파생 값으로 재계산 가능해야 함 (이중 소스 일관성)

- [ ] **포트폴리오 — 실현 손익 집계** (V2)
  - 현황: V1은 수량 수정만 허용, 매도 → 실현손익 계산 없음
  - 의존: 거래 이력 테이블 선행 필요
  - 방향: 평균원가법 기반 realized_pl 집계 + 대시보드 월별/연별 차트

## 의사결정 기록
| 날짜 | 결정 내용 | 이유 |
|------|-----------|------|
| MVP | SQLite 사용 | 빠른 개발, 추후 PostgreSQL 전환 예정 |
| MVP | 단일 HTML SPA | 빠른 개발, 추후 모듈 분리 예정 |
| MVP | helmet CSP off | 인라인 스크립트 다수, SPA 분리 후 재활성 예정 |
| 2026-04-15 | 포트폴리오 PK = (user_id, stock_id) 복합키 + upsert | 동일 종목 재매수 시 평단 재계산, lot 분할 안 함 — 단순화 우선 |
| 2026-04-15 | 포트폴리오 통화 혼합 V1은 분리 카드 | 환율 적용 로직·실시간 환율 캐시 추가 복잡도 회피 |
| 2026-04-15 | 포트폴리오 거래 이력 V2로 미룸 | MVP는 현재 보유 스냅샷 충분, 이력은 매도/실현손익과 묶어 일괄 추가 |
| 2026-04-15 | 종목 마스터 DB 전환 시작 — stocks(v10) + stock_curation 테이블, PK=symbol 단일, Phase 0~4 계획 | 하드코딩 MASTER/KOREAN_TICKERS/KR_INFO → DB 기반 전환. 정량/정성값 분리로 재수집 덮어쓰기 방지. 기존 `/api/universe` 응답 스키마 유지해 프론트 무변경 |
| 2026-04-18 | Phase 2 is_curated=1 은 identity·재무지표 모두 "완전 보호" — upsert 스킵 | 큐레이터 의도가 최우선. 재무지표 리프레시가 필요하면 stock_curation.note 수동 flag 또는 별도 refresh 스크립트로 분리 |
| 2026-04-18 | KR 수집은 Yahoo Finance quoteSummary 비공식 엔드포인트 사용 — cookies+crumb 디스크 캐시, 429 시 5s 백오프, 기본 딜레이 1s | 공식 API 없음, crumb 엔드포인트 IP rate-limit 이 공격적이라 세션 재사용 필수 |

## 완료된 항목

- [x] **프로덕션 seed 자동화 (`db.js` `seedStocksIfEmpty`)** — 2026-04-20
  - 배경: 2026-04-18 Phase 3 (`/api/universe` DB 전환) 배포 시 프로덕션 `stocks` 테이블이 비어있어 total=0 반환하는 장애 → 즉시 revert. 재발 방지 필수
  - 구현: `db.js` 마이그레이션 직후 `SELECT COUNT(*) FROM stocks` 검사. 0 이면 `child_process.execSync('node scripts/seed-stocks.js')` 호출. connection 격리를 위해 별도 프로세스 (seed-stocks.js 의 자체 better-sqlite3 connection 충돌 회피)
  - DB_PATH 환경변수 전달 — 로컬(server/data.db)·Railway(/data/data.db) 모두 동일 DB 보장
  - 검증: 로컬 `/tmp/seedtest.db` 로 1회차 마이그 전체 실행 + stocks 307 insert, 2회차 기동 시 채워진 상태 감지하여 자동 seed 스킵 확인
  - 효과: Phase 3 재시도 시 프로덕션 DB 가 비어있어도 자동 복구. 수동 `node scripts/seed-stocks.js` 실행 불요
  - 남은 과제: stocks 가 비어있진 않지만 유니버스가 작은 경우(현재 307) → 종목 수 확장은 별도 유니버스 소스 작업 필요 (아래 "Phase 2 KR/US smoke test" 참조)

- [x] **Phase 2 US 수집 FMP → Yahoo 전환** — 2026-04-18
  - 배경 (2026-04-18 재개 중 발견): FMP legacy v3 전 엔드포인트 403 (2025-08-31 cutoff). `/stable/` 경로도 Starter 플랜에서 `sp500-constituent` 402, `profile` 은 전 심볼 200 이지만 `key-metrics-ttm`·`ratios-ttm`·`income-statement-growth` 는 AAPL 등 극소수만 200 나머지 **402 "Special Endpoint: not available under your current subscription"** — 재무지표 심볼 게이트 확인. 결과: US 수집기로 4종목(ACN/ABT/AOS/MMM) insert 됐으나 전부 재무지표 null
  - 결정 (DECISIONS.md 2026-04-18): **US 도 Yahoo Finance 로 전환**. 비용 0, KR 과 스킴 통일, 필드 1:1 매칭. 트레이드오프 및 재검토 조건은 INSIGHTS.md 참조
  - 공통 모듈 추출: `server/scripts/lib/yahoo-fetch.js` — `getYahooAuth()` (6h 디스크 캐시 + YAHOO_COOKIE/CRUMB env 오버라이드) / `fetchQuoteSummary(sym, suffixes[])` / `extractFinancials(sym, yahoo, {market, defaultCurrency, computeExchange})`
  - `fetch-kr-stocks.js` 리팩터: 공통 모듈 import, 동작 동일 (접미사 `.KS`/`.KQ` 순차 시도)
  - `fetch-us-stocks.js` 재작성: datahub CSV 유니버스 유지, Yahoo quoteSummary 호출, 심볼 변환 `BRK.B → BRK-B` (Yahoo 의 클래스 구분자 표기). 이전 FMP 호출 로직 전부 제거. FMP_API_KEY 의존성 제거됨
  - 기존 DB 오염: smoke test 로 남은 ACN/ABT/AOS/MMM 4개는 `is_curated=0 · source='fmp'` 상태로 잔존 — 다음 Yahoo 실행 시 정상 UPDATE 로 재무지표 채워질 예정 (즉 자연 복구)
  - 테스트 상태: **Yahoo IP rate-limit 지속 중 — smoke 미완**. 코드 3개 파일 검증 대기 (lib/yahoo-fetch.js 신규, fetch-kr/us 리팩터)
  - 다음 단계: (1) rate-limit 해제 (30~60분 후) → `cd server && node scripts/fetch-kr-stocks.js` (KR_LIMIT=3 smoke). (2) 성공 시 `node scripts/fetch-us-stocks.js` (US_LIMIT=5 smoke). (3) 둘 다 OK 면 full LIMIT 실행. (4) 완료 후 db-schema.md v11 + research 섹션 업데이트

- [x] **종목 마스터 DB 전환 Phase 2 (대량 수집기 스캐폴드)** — 2026-04-18
  - DB: v11 마이그레이션 — `stocks.peg` · `stocks.fcf` 컬럼 추가 (ALTER TABLE ADD COLUMN, idempotent)
  - 공통 유틸: `server/scripts/lib/fetch-utils.js` — openDb / httpGetJson (타임아웃·백오프) / makeUpsertStock (is_curated=1 완전 스킵, 0·신규만 upsert) / makeProgress / num·numNoZero
  - ⚠️ 이 항목 당시의 US FMP 수집기는 2026-04-18 Yahoo 전환으로 폐기됨 (위 "FMP → Yahoo 전환" 항목 참조)
  - 유니버스 소스: US = datahub CSV (원래 FMP `sp500_constituent` → 전환), KR = `index.js` 의 `KOREAN_TICKERS` 배열 상위 N (KR_SYMBOLS env 오버라이드 가능)
  - 실행 흐름: 서버 1회 기동(v11 마이그 자동) → `node scripts/fetch-kr-stocks.js` → `node scripts/fetch-us-stocks.js` (순서 무관, FMP_API_KEY 불필요)
  - 리포트: inserted / updated / unchanged / skipped_curated / failed 5구간 카운트 + 실패 심볼 상위 10
  - 한계: Yahoo getcrumb IP rate-limit — 첫 실행 시 crumb 받으면 캐시 재사용. 쿼터 초과 시 30~60분 대기 후 재시도 또는 다른 네트워크/브라우저에서 `/tmp/ycookies` + `/v1/test/getcrumb` 로 수동 획득 후 env 주입
  - 문서: `docs/MEMORY.md` (본 항목) — db-schema.md 의 v11 섹션 업데이트 필요 (후속)

- [x] **종목 마스터 DB 전환 Phase 0~1** — 2026-04-16
  - Phase 0: v10 마이그레이션 — `stocks` + `stock_curation` 테이블 추가 (PK=symbol 단일, FK CASCADE)
  - Phase 0.5: FMP 무료 쿼터 실측 — `company-screener`/`sp500-constituent`/`profile-bulk` 전부 402 프리미엄 게이트 확인. Betty 가 FMP Starter($19/월) 유료 구독 결정
  - Phase 1: `server/scripts/seed-stocks.js` 작성 + 실행 — 하드코딩 MASTER(112) / KR_INFO(114) / KOREAN_TICKERS(116) / KR_ETFS(48) / US_ETFS(55) → DB 1회성 이전 완료
  - 결과: `stocks` 307행 (KR 165 + US 142, ETF 103 포함) · `stock_curation` 112행 · 전부 `source='curation'` / `is_curated=1` 로 마킹 (Phase 2 대량 수집기 덮어쓰기 차단)
  - 문서: `docs/research/db-schema.md` (v10 스키마 + seed 실행 방법), `docs/MEMORY.md` (본 항목)

- [x] **포트폴리오(나의 투자) V1** — 2026-04-15
  - DB: v9 마이그레이션으로 `user_holdings` 테이블 추가 (복합 PK + upsert)
  - 서버: `GET/POST/DELETE /api/auth/holdings` 3개 엔드포인트 (`auth.js`)
  - 프론트: `pg-portfolio` 페이지, LNB + 모바일 바텀네비 진입, 추가/수정 모달, CSV 가져오기 모달, 통화별 요약 카드(🇺🇸/🇰🇷), 테이블(수량/현재가/평단/평가금액/비중/수익률), 상세페이지 "내 보유현황" 패널
  - 동기화: `reloadUserData()` 훅에 `syncPortfolioFromServer()` 편입 → 로그인·세션 복원 시 자동 덮어쓰기
  - 문서: `docs/research/db-schema.md` (테이블/버전), `docs/research/api-specs.md` (엔드포인트 3건), `docs/CLAUDE.md` (sr_pf 키, v1~v9)
