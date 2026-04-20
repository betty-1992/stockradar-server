# StockRadar — 기술 부채 & 의사결정 기록

---

## 🌅 내일 이어가기 체크리스트 (세션 마감 2026-04-20 23:00 기준)

### 🔑 세션 최종 상태

**프로덕션**: https://stockradar-server-production-394b.up.railway.app — **정상 가동**
- `/api/universe total = 2,898` (Phase 3 DB 전환 완료)
- KR 시세는 네이버 API 경유 (Yahoo 차단 회피)
- Railway 볼륨 `/data/data.db` 마운트 확인 — 사용자 데이터 영속 보장

**오늘 커밋**: 30+ 건, 모두 main 에 push 완료. 미배포 잔여물 없음.

### 📋 다음 세션 시작 시 해야 할 일

1. **시뮬레이터 피드백 수렴** — Betty 가 실사용 후 나온 이슈 정리·반영
2. **Phase 4 시나리오 비교** (선택) — 저장된 2~3개 시나리오 나란히 비교 차트/표
3. **Phase 2 Yahoo 수집 (KR 재무지표 PER/PBR/ROE)** — 여전히 차단 지속 중.
   회복되면 `KR_LIMIT=100` 부터 점진 실행. 확장된 유니버스 (시총 큰 종목 먼저)
   로 `fetch-kr-stocks.js` 돌리기
4. **US 유니버스 확장** (옵션) — Russell 1000 등 추가 고려

### ⚠️ 다음 세션에서 기억할 것

- **데이터 유실 방어 이미 3중**: (1) Railway /data 볼륨, (2) `seedStocksIfEmpty`·
  `expandKrUniverseIfNeeded` 자동 복구, (3) admin 페이지 "DB 스냅샷 다운로드"
- **Yahoo 는 여전히 차단** (로컬·모바일·Railway IP 전부). chart API(과거 시세)는
  통과 중이고 quoteSummary 만 차단. KR 은 네이버로 우회. US 시세는 현재 chart
  엔드포인트 이용
- **OCR 프롬프트 함정 주의**: 한국 증권사 앱이 미국 종목 평단을 원화 환산해
  병기할 때 Gemini 가 원화값을 달러로 오인. 프롬프트에 방어구 있음 — 결과
  이상하면 프롬프트 재강화

---

## 오늘(2026-04-20) 완료된 작업 총정리

### Phase 3 — `/api/universe` DB 전환 **재배포 완료**
- revert-of-revert (`43e8df1`) — 어제 장애 원인(프로덕션 DB 비어있음)은
  `seedStocksIfEmpty` 로 해결됨. 안전하게 재배포.
- 현재 응답: `counts.total = 2,898` (US 87 + KR 2,708 + KR ETF 103 + US ETF 55)

### KR 유니버스 23배 확장
- **FinanceDataReader** 로 우회 (pykrx·KRX 공식 API 는 IP 차단)
- `server/scripts/data/kr-universe.csv` 2,770행 (KOSPI 949 + KOSDAQ 1,821)
- `fetch-krx-universe.js` 로 2,591 insert
- 추가: `fetch-kr-etfs.js` — KR ETF 48 → 874
- `db.js expandKrUniverseIfNeeded()` — 기동 시 자동 확장 (Railway 재배포 시 보장)

### KR 시세 Yahoo → 네이버 전환
- 증상: Yahoo 가 한국 코스닥 소형주 실시간 커버리지 부실 → volume=0, timestamp
  stale, 평가금액 왜곡 (예: 미래에셋벤처투자 +19% 오탐)
- 해결: `fetchYahooQuote` 내부에서 KR 6자리 심볼은 `fetchNaverKrQuote` 로 우회
  (`polling.finance.naver.com/api/realtime/domestic/stock/...`)
- 배치 최적화: `fetchNaverKrQuotesBatch` — 멀티 심볼 API 로 최대 100개/1회 호출
  → `/api/quotes` 응답 10~20배 단축 (500종목 2초 내)
- 초기 로드: `_pickInitialPriceIds()` 로 시총 상위 500 + 보유/관심 종목만.
  나머지는 `ensureLivePrices()` 로 lazy 보충 (스크리너 필터 결과 기준)

### 나의 투자 V2 구현
- **V2-1 원화 환산 통합 평가 카드** — USDKRW 환율 기반. KR+US 둘 다 보유 시만 노출
- **V2-2 거래 이력** (`transactions` 테이블 v12) + **V2-3 실현 손익**
  - `POST /api/auth/transactions` — 매수/매도 원자 트랜잭션.
    평균원가법: 매수 시 평단 재계산, 매도 시 평단 유지 + `realized_pl` 기록
  - `GET /api/auth/transactions` — 최근 N건 + KR/US 실현손익 합계
  - `DELETE /api/auth/transactions/:id` — 삭제 후 해당 종목 거래 재생
    → `user_holdings` 재구성 (안전한 정정)
- **이미지 OCR 자동 매핑** — Gemini Vision API
  - `POST /api/portfolio/ocr` (12MB 업로드 허용, 최대 5장·장당 8MB)
  - 프롬프트: `{name, ticker, quantity, avg_price, currency}` JSON 강제
  - 매칭 우선순위: ticker 직매칭(교차검증) → name 완전 → LIKE → 역방향 토큰
  - 주의사항 프롬프트화: 평가금액↔평단 오인, 원화 병기 평단, TIGER 미국
    등 국내 ETF
- **포트폴리오 버튼 UX 개편** — 주력 2개(이미지·직접 입력) + 더보기 드롭다운
  (거래 기록·CSV 붙여넣기). 각 모달 상단에 "언제 쓰나요?" 안내

### 시뮬레이터 (신규 메뉴 — 📈 시뮬레이터)
- **Phase 1** `GET /api/history?symbol=xxx&period=1y/3y/5y/10y` — 과거 일봉
  - KR: 네이버 `siseJson.naver` (정규식 파서 — JSON 아닌 JS literal)
  - US: Yahoo `chart/v8` (quoteSummary 차단됐어도 chart 는 통과)
  - 캐시 6h
- **Phase 2a — 🔮 미래 예상**: 과거 CAGR → 복리 추정. 낙관(×1.3)·중립·
  비관(max(×0.5, −5%p)) 3시나리오. 일시금·월적립·주적립 3 모드
- **Phase 2b — 📊 과거 검증**: 과거 N년 실제 일봉으로 매수 시뮬.
  KR 정수 주·US 소수점. 잔돈은 현금잔고로 누적. NAV 시계열 차트.
- **UX**: 탭 그라데이션 강조 · 탭 상세 설명 · 시나리오 저장 (localStorage
  접이식 리스트 + 이름 검색)
- **Phase 3 AI 해설**: `POST /api/ai-scenario` — 스톡이가 주린이 언어로
  특징·리스크·조심할 점을 4~6 불릿으로
  - **인사이트 중심 재설계** (Betty 피드백 반영): 단순 수치 반복 금지,
    각 불릿 [관찰→해석→시사점] 구조, 5각도 강제(포트 성격·변동성 폭·
    MDD 체감·시장 맥락·개선 방향). 서버에서 stocks 조회해 섹터·ETF·
    국가 구성 자동 분석 후 프롬프트 주입
  - **해설 카드 다크모드 가독성**: `.sim-ai-card/.sim-ai-list` CSS 분리,
    본문 dim + 볼드만 선명, 경고 ⚠️ 빨강 분리 박스

### 운영 / 안전장치
- **Railway 볼륨 마운트 확인** — `GET /api/admin/ops/dbinfo` 신설.
  현재 `/data/data.db` 영속 확인됨 (사용자 데이터 유실 위험 없음)
- **DB 수동 백업 다운로드** — `GET /api/admin/ops/backup` + 설정 페이지에
  "🗄️ DB 스냅샷 다운로드" 버튼. `better-sqlite3.backup()` 으로 WAL-safe.
  주 1회 수동 다운로드 권장
- **admin 스크립트 실행** — `POST /api/admin/script/start` 화이트리스트
  (fetch-krx-universe, fetch-kr-etfs, fetch-kr-stocks, fetch-us-stocks).
  Railway 서버에서 Phase 2 수집 트리거용

### 대량 버그 수정
- `esc is not defined` — IIFE 스코프 문제. `window.esc` 로 전역 노출
- 포트폴리오 flex 컨테이너 내부 `<style>` 태그 → head 로 이동 (레이아웃 깨짐)
- `const fx` 중복 선언 SyntaxError — 스크립트 전체 파싱 중단 → 여러 함수
  ReferenceError 연쇄. 중복 제거
- 새로고침 시 홈 리셋 — `validPages` 에 `watchlist`·`portfolio`·`simulator`
  누락. 추가
- 푸터 위치 어긋남 — `relocateFooter` 가 `go()` 경유 시만 호출됨. 초기
  로드·popstate 에도 호출 추가
- `renderPortfolioPage` try/catch + 에러 UI 방어
- 브라우저 캐시 강화: `Cache-Control: no-store` + `<meta>` 이중 선언 +
  `pageshow` bfcache 감지 자동 reload

### 스톡이 프롬프트 완화
- "주식·ETF·투자 관련 질문에만" → "주식·ETF·투자와 이에 영향을 주는
  거시·시사 이슈도 투자 관점에서 답변". 종전·금리·관세 등 가능

---

## 현재 기술 부채

### 🔴 높은 우선순위

- [ ] **SQLite → PostgreSQL 전환** (Railway 볼륨은 방어 완료 but 장기 스케일링 대비)
- [ ] **express-session → Redis 세션 or JWT** — 서버 재시작 세션 초기화
- [ ] **admin.js Gemini 직접 호출 → callGemini() 통합** — `/api/admin/articles/draft`
- [ ] **StockRadar_v5.html 15,000줄 분리** — 섣불리 건드리지 말 것. 별도 계획 필요

### 🟡 중간 우선순위

- [ ] **이메일 인증 활성화** — 테이블 준비됨, 미사용
- [ ] **helmet CSP 재활성화** — HTML 분리 이후 nonce 방식으로
- [ ] **결제 모듈 payments.js** — 토스페이먼츠 or 포트원
- [ ] **개인정보 암호화 저장** — `user_keywords`·`user_favorites`
- [ ] **회원 탈퇴 + 개인정보 삭제** — 개인정보보호법 필수
- [ ] **KR 재무지표 수집** — Phase 2 Yahoo 수집 대기 (차단 해제 후). 또는
  네이버/FinanceDataReader 로 전환 검토
- [ ] **시나리오 서버 동기화** (현재 localStorage 만) — 여러 기기 공유 원할 시

### 🟢 낮은 우선순위

- [ ] node-fetch 제거, Express 5.x 안정성 모니터링, 테스트 코드, 엔드포인트별
  rate limiting 세분화, US 유니버스 Russell 1000 확장

## 의사결정 기록 → `docs/DECISIONS.md` 참조

## 완료된 큰 작업 → `docs/DECISIONS.md` "완료된 큰 작업" 섹션
