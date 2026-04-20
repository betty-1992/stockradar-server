# StockRadar — 아이디어 · 미결정 사안 · 대화 인사이트

> 아직 결정 안 됐지만 언젠가 결정할 것. 대화에서 나온 통찰.
> 확정되면 `DECISIONS.md` 로 옮김.

---

## V2 기능 상태 (2026-04-20 기준)

| 기능 | 상태 | 비고 |
|------|------|------|
| 포트폴리오 환율 통합 | ✅ 완료 | `/api/quote/USDKRW=X` · 통합 평가 카드 + 각 행 원화 병기 |
| 거래 이력 | ✅ 완료 | DB v12 `transactions` · POST/GET/DELETE `/api/auth/transactions` |
| 실현 손익 집계 | ✅ 완료 | 매도 시 `realized_pl = (price − avg) × qty` 자동 기록 |
| 이미지 OCR 자동 등록 | ✅ 완료 | Gemini Vision · `POST /api/portfolio/ocr` · ticker↔name 교차 검증 |
| 시뮬레이터 (미래 예상 + 과거 검증) | ✅ 완료 | Phase 1~3 · AI 해설 포함 |
| 시나리오 저장 | ✅ 완료 (localStorage) | 서버 동기화는 유저 생긴 뒤 검토 |
| 시나리오 비교 (Phase 4) | ⏳ 미착수 | 저장된 2~3개 나란히 차트/표 |
| 매수 타이밍 알림 | ⏳ 미착수 | 즐겨찾기 52주 하락률+PEG 조건 이메일 |
| 스크리너 필터 고도화 | ⏳ 미착수 | PEG/ROIC/PSR/3Y CAGR/FCF/베타 필터 추가 |

---

## 미결정 사안

### 🔴 유니버스 소스 확장 — 종목 수 확대 (2026-04-18 발견, 내일 결정)
**배경**: Betty 가 "현재 800 종목이 적게 느껴진다" 로 개편 시작했으나, Phase 2/3 작업은 구조 변경일 뿐 실제 유니버스 확장은 아니었음. 현재 소스 한계:
- KR: `server/index.js` 하드코딩 `KOREAN_TICKERS` 116개 (KOSPI·KOSDAQ 합쳐 ~2,400 상장사 중 극히 일부)
- US: Phase 2 에서 datahub S&P500 CSV 500개 (Russell 1000/2000 제외)
- ETF: `etfs.js` 하드코딩 KR 48 + US 55

**스케일 옵션 (Betty 결정 대기)**:
| 옵션 | 대상 | 예상 종목수 | 수집 시간(Yahoo 1s 딜레이) | 장단점 |
|------|------|-------------|---------------------------|--------|
| (a) 소형 | KOSPI 전체 + S&P500 + ETF | ~1,500 | ~25분 | 한국 풀커버 + 미국 대형주, 균형 |
| (b) 중형 | KOSPI + KOSDAQ 시총 상위 500 + Russell 1000 + ETF | ~2,500 | ~42분 | 중소형 종목 다양성 확보 |
| (c) 풀커버 | KOSPI + KOSDAQ 전체 + Russell 2000 + ETF | ~5,000 | ~85분 | 가장 많은 종목, 수집 오래 걸림 |

**유니버스 데이터 소스 후보**:
- KR: KRX 상장법인 CSV (`kind.krx.co.kr` 공시 or `data.krx.co.kr` 다운로드) — 공식 무료
- US: Russell 1000/2000 위키피디아 or datahub CSV
- 대안: Yahoo `validateSymbols` 로 공개된 전종목 리스트 API — 비공식

**결정 기준**:
- "스크리너에서 못 찾아서 불편했던 종목" 구체적 예 (예: 코스닥 중소형, Russell 종목) → 옵션 선택
- 수집 빈도 (일 1회 vs 주 1회) 에 따른 Yahoo rate-limit 부담
- 프론트 성능 (MASTER 맵이 3,000+ 종목 담을 때 렌더링/필터링 지연 검증 필요)

### `StockRadar_v5.html` 15k줄 분리 전략
- 방향: 기능별 JS 모듈 분리
- 난제: 섣불리 건드리면 기능 회귀, 인라인 스크립트 → CSP 재활성 순서 조정 필요
- **별도 계획 필요** (손대기 전 Betty 승인 필수)

### Phase 2 US 수집 — Yahoo Finance 재검토 조건 (2026-04-18 결정 이후)
- 현재: `fetch-us-stocks.js` Yahoo 기반 (DECISIONS.md 2026-04-18)
- 재검토 트리거 (아래 하나라도 발생 시):
  1. Yahoo quoteSummary 스킴 변경 · 인증 난이도 급등 · 429 일상화
  2. 프로덕션 크론 실패율 10% 초과 (특정 심볼이 아니라 전반적 실패)
  3. Yahoo 응답 지연 → 전체 수집 시간 30분 초과 (현재 목표: ~10분)
  4. 유료 플랜(FMP Ultimate 등) 으로 **전 심볼 접근 + TTM** 보장하는 확실한 계약 조건 확인
- 대안 검토 순서 (저비용 → 고비용):
  1. **Stooq** (무료, 가격/시총/볼륨 커버 — 재무지표는 약함, 하이브리드 가능)
  2. **AlphaVantage** (무료 티어 분당 5콜 — 속도 한계)
  3. **EOD Historical Data** ($19.99/월부터 — fundamentals 전 심볼)
  4. **FMP Ultimate** ($79/월 — 현 Starter 업그레이드, 게이트 해제 보장은 공식 답변 받아야)
  5. **IEX Cloud / Polygon.io** (사용량 과금제)
- 참고: FMP 가 "legacy cutoff 2025-08-31" 을 실제 적용했으므로, 다음 유료 플랜 선택 시 **공식 문의로 심볼 게이트 정책 명문화된 답변 받고 결정**

### 결제 모듈 방향
- 후보: 토스페이먼츠 vs 포트원(아임포트)
- 결정 기준: 구독 관리 편의성, 정산 주기, 수수료

### 이메일 인증 활성화 시점
- 테이블/컬럼은 준비됨(`email_verifications`, `users.email_verified`)
- 시점: 상용화 직전 or 봇/스팸 발생 시

---

## 관찰 / 통찰

- **FMP 무료 쿼터의 한계**: `company-screener`/`sp500-constituent`/`profile-bulk` 전부 402 — 상용 데이터는 유료 구독 전제
- **Yahoo Finance IP rate-limit**: crumb 엔드포인트가 공격적으로 차단 → 세션 재사용 + 디스크 캐시가 필수
- **큐레이션 원칙**: 사람이 직접 넣은 데이터(is_curated=1)는 어떤 자동 수집도 덮어쓰지 말 것 — 큐레이터 의도 최우선

### 2026-04-20 관찰

- **Yahoo 한국 소형주 데이터 부실**: 코스닥 소형주는 volume=0, timestamp 며칠 전 값, 평가금액 왜곡 빈번 (예: 미래에셋벤처투자 Yahoo +19% 오탐 vs 네이버 -1.73%). KR 은 네이버 polling API 로 전환 필수
- **네이버 멀티 심볼 배치**: `/api/realtime/domestic/stock/{code1,code2,...}` 100개/요청 가능, 실측 0.06초. 수십개 심볼 각자 호출하는 것보다 10~20배 빠름
- **Yahoo IP 광범위 차단**: quoteSummary 는 한국 IP 풀·모바일 NAT·Railway(미국) 전부 차단. chart/v8 엔드포인트는 통과 — 과거 시세 수집은 가능
- **FinanceDataReader > pykrx (KR 유니버스)**: pykrx 는 KRX 공식 API 의존이라 IP 차단 시 0개 반환. FDR 은 Naver 등 폴백 있어 안정적. 단 실시간 시세는 여전히 네이버 polling 직접 호출이 낫음
- **한국 증권사 앱 OCR 함정**:
  - 평가금액(수량×평단)을 평단으로 오인 (숫자 크기가 평단 X 수량 수준이면 의심)
  - 미국 종목의 **원화 환산 평단**을 달러값으로 오인 (예: SCHD "$30.69 / ≈ ₩45,706" 병기 → 45.7 달러로 입력)
  - "TIGER 미국S&P500" 같은 국내 상장 ETF를 미국 종목으로 오인 → 브랜드 프리픽스 화이트리스트로 방어
- **Gemini 해설 기본 경향**: 입력 수치를 단순 반복·나열하는 경향이 강함. "⛔ 금지/✅ 좋은 예" + "[관찰→해석→시사점]" 구조 + 각도 5개 강제 + 볼드 과용 금지 지시까지 해야 인사이트 있는 답변 생성
- **브라우저 캐시의 완고함**: HTTP `Cache-Control: no-store` 만으로 부족 — `<meta http-equiv>` 이중 선언 + `pageshow.persisted` 감지 `location.reload()` 까지 해야 Safari bfcache 우회
- **Railway 볼륨 확인은 런타임 엔드포인트로**: `/api/admin/ops/dbinfo` 가 `DB_PATH` + `DATA_DIR` env + inode 를 반환 — 배포마다 유실 여부를 한 줄 명령으로 검증 가능
- **IIFE 안의 `function foo(){}` 은 전역 X**: 여러 `<script>` 블록이 있고 그중 하나가 IIFE 래핑이면, 그 안에서 선언한 함수는 다른 스크립트에서 접근 불가. `window.foo = function...` 명시가 안전
- **HTML flex 컨테이너 안의 `<style>` 태그**: 일부 브라우저가 flex item 으로 처리해 보이지 않는 빈 공간 차지 → 레이아웃 밀림. `<style>` 은 반드시 head 또는 flex 컨테이너 밖
