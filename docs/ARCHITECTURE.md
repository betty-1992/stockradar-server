# StockRadar — 시스템 설계 · 파일 역할

> 시스템 전반 구조. 상세 결정 배경은 `docs/research/architecture.md` 참고.

---

## 스택

- **백엔드**: Node.js 20 / Express 5 / better-sqlite3 (→ PostgreSQL 전환 예정, `MEMORY.md` 참조)
- **프론트엔드**: 단일 HTML SPA (`StockRadar_v5.html`, ~15k 줄) — 현재 백엔드에서 함께 서빙
- **배포**: Railway (풀스택 단일 배포). Vercel 프론트 분리는 향후 과제
- **외부 API**: Yahoo Finance (KR+US 재무지표), Gemini (AI), Resend (이메일)

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
| `server/index.js` | Express 메인 — 시세/뉴스/AI API, `callGemini()` 공통 함수 |
| `server/auth.js` | 회원가입 · 로그인 · Google OAuth · 포트폴리오 API |
| `server/admin.js` | 어드민 API — ⚠️ Gemini 직접 호출 (이중 관리, `MEMORY.md` 참조) |
| `server/db.js` | SQLite 마이그레이션 v1~v11 + 헬퍼 함수 |
| `server/middleware.js` | `attachUser` / `requireAuth` / `requireAdmin` |
| `server/email.js` | Resend 이메일 발송 |
| `server/etfs.js` | KR/US ETF 마스터 데이터 |
| `server/scripts/seed-stocks.js` | 하드코딩 데이터 → DB 이전 1회성 스크립트 |
| `server/scripts/fetch-us-stocks.js` | FMP API → stocks 테이블 대량 수집 |
| `server/scripts/fetch-kr-stocks.js` | Yahoo Finance → KR stocks 수집 |
| `server/scripts/lib/fetch-utils.js` | openDb / httpGetJson / makeUpsertStock 공통 유틸 |
| `StockRadar_v5.html` | 사용자 SPA — ⚠️ 수정 전 반드시 범위 보고 |
| `admin.html` | 어드민 콘솔 |

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
