# StockRadar — API 명세

> 실제 엔드포인트 상세는 `docs/research/api-specs.md` 참고.
> 이 파일은 인덱스 + 원칙.

---

## 원칙

- **AI 호출**: `index.js` 의 `callGemini()` 함수를 통해서만 (admin.js 직접 호출은 기술부채, `MEMORY.md` 참조)
- **인증**: `middleware.js` 의 `requireAuth` / `requireAdmin` 일관 적용
- **rate limiting**: `express-rate-limit` 전역 (세분화는 `MEMORY.md` TODO)

---

## 엔드포인트 그룹

| 그룹 | 파일 | 상세 |
|------|------|------|
| 시세/뉴스/AI | `server/index.js` | `docs/research/api-specs.md` |
| 인증 (회원가입/로그인/OAuth) | `server/auth.js` | 동 |
| 포트폴리오 (holdings) | `server/auth.js` | `GET/POST/DELETE /api/auth/holdings` |
| 포트폴리오 (거래 이력) | `server/auth.js` | `GET/POST /api/auth/transactions`, `DELETE /api/auth/transactions/:id` — v12, 평균원가법·실현손익 자동 계산 |
| 포트폴리오 OCR | `server/index.js` | `POST /api/portfolio/ocr` — Gemini Vision 으로 증권사 앱 캡처 → 종목 배열 추출 + stocks 테이블 매칭 (12MB) |
| 시뮬레이터 — 과거 시세 | `server/index.js` | `GET /api/history?symbol=xxx&period=1y/3y/5y/10y` — KR 네이버, US Yahoo chart. 캐시 6h |
| 시뮬레이터 — AI 해설 | `server/index.js` | `POST /api/ai-scenario` — 시나리오 입력·결과 → 스톡이 해설 (callGemini 재사용) |
| 어드민 | `server/admin.js` | 글쓰기 draft, 사용량 로그 등 |
| 어드민 — 운영 | `server/admin.js` | `GET /api/admin/ops/dbinfo` · `GET /api/admin/ops/backup` (DB 스냅샷 다운로드) · `POST /api/admin/script/start` (Railway 서버에서 수집 스크립트 실행) |

---

## 외부 API 의존성

| 서비스 | 용도 | 주의사항 |
|--------|------|---------|
| **네이버 금융** | KR 실시간 시세 (`polling.finance.naver.com`) · 과거 일봉 (`api.finance.naver.com/siseJson.naver`) | 한국 종목 기본 데이터 소스 (2026-04-20 부터). 멀티 심볼 `?/{code1,code2,...}` 100개/호출 지원. `siseJson` 응답은 JS literal 배열이라 정규식 파싱 |
| **FinanceDataReader** (Python) | KR 전종목 유니버스 CSV 생성 (KOSPI·KOSDAQ·ETF) | 1회 실행 후 `server/scripts/data/kr-universe.csv`·`kr-etfs.csv` 로 repo commit. 런타임 의존 없음 |
| Yahoo Finance | US 실시간 시세 + US/KR 과거 일봉 (`chart/v8`) · **현재 `quoteSummary` 는 차단 지속** (Phase 2 수집 보류) | `chart` 엔드포인트는 통과. cookies+crumb 세션 재사용은 Phase 2 전용 |
| **Gemini** (text + vision) | AI 글쓰기/분석 · 시뮬레이터 해설 · **포트폴리오 OCR** (multimodal) | `callGemini(prompt, {images})` 공통 함수. `_geminiOnce` 가 `inline_data` 지원 |
| Resend | 이메일 발송 | `email.js` 에서 처리 |

~~FMP~~ — 2026-04-18 이후 미사용. Legacy v3 전체 403, `/stable/` 경로는 Starter 플랜에서 재무지표 심볼 게이트. `fetch-us-stocks.js` Yahoo 로 전환됨 (`docs/DECISIONS.md`).

---

## 핵심 엔드포인트 — 동작 변경 이력

### `GET /api/universe` (Phase 3, 2026-04-18 전환)

**현재 동작** — `stocks` 테이블(DB) 기반:
```
SELECT symbol, name, name_kr, exchange, sector, industry, market_cap,
       currency, is_etf, etf_index, tags, market
FROM stocks WHERE is_active = 1
ORDER BY (market_cap IS NULL), market_cap DESC, symbol ASC
```
버킷 분류: `market='KR' & is_etf=0 → kr`, `market='KR' & is_etf=1 → krEtf`, `market='US' & is_etf=0 → us`, `market='US' & is_etf=1 → usEtf`.

**이전 동작** (폐기): Yahoo 스크리너 9카테고리 실시간 병합(US) + `KOREAN_TICKERS`/`KR_ETFS`/`US_ETFS` 하드코딩 + Yahoo quote 호출. 응답 종목 수가 매일 Yahoo 스크리너 따라 ±수십개 변동.

**응답 스키마** (무변경):
```
{ ok: true,
  counts: { us, kr, krEtf, usEtf, total },
  us:[...], kr:[...], krEtf:[...], usEtf:[...] }
```
각 엔트리: `{ symbol, name, exchange, marketCap, price:null, sector, industry, isEtf, tags? }`. `price` 는 스키마 호환용 — 프론트 `loadUniverse` 미사용, 시세는 `/api/batch`·`/api/quote` 로 별도 조회.

**캐시**: 24h 메모리 캐시 (키 `universe-db`).

**현재 상태 (2026-04-18 배포 직후)**: 프로덕션 DB 는 seed 307행, 즉 `/api/universe total = 307`. Phase 2 수집기 (Yahoo rate-limit 해제 후 실행) 돌리면 ~800대로 자연 확장.
