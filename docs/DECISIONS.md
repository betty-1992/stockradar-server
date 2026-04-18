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

---

## 완료된 큰 작업 (히스토리)

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
