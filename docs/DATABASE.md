# StockRadar — DB 스키마 · 마이그레이션

> 실제 스키마 상세는 `docs/research/db-schema.md` 참고.
> 이 파일은 인덱스 + 규칙.

---

## 규칙

- **DB 엔진**: SQLite (better-sqlite3) — PostgreSQL 전환 예정 (`MEMORY.md`)
- **마이그레이션 관리**: `server/db.js` 안에서 version-stepped idempotent 스크립트로 관리
- **변경 시 반드시**:
  1. `db.js` 에 새 버전 번호로 블록 추가 (예: v11 → v12)
  2. `docs/research/db-schema.md` 업데이트
  3. 관련 타입/헬퍼 동기화

---

## 현재 버전: v11

| 버전 | 내용 |
|------|------|
| v1~v8 | 기본 사용자·즐겨찾기·키워드·알림·이메일 인증 테이블 |
| v9 | `user_holdings` 테이블 (포트폴리오) — 복합 PK (user_id, stock_id) + upsert |
| v10 | `stocks` + `stock_curation` 테이블 (종목 마스터 DB, PK=symbol, FK CASCADE) |
| v11 | `stocks.peg` / `stocks.fcf` 컬럼 추가 (ALTER TABLE, idempotent) |

---

## 테이블 요약

| 테이블 | 용도 | 비고 |
|--------|------|------|
| `users` | 회원 계정 | 이메일 인증 컬럼 준비됨(미사용) |
| `user_favorites` | 즐겨찾기 종목 | 로컬스토리지 `sr_wl` 와 동기화 |
| `user_keywords` | 관심 키워드 | |
| `user_holdings` | 포트폴리오 보유 종목 | v9 — 복합 PK upsert |
| `stocks` | 종목 마스터 | v10 — PK=symbol |
| `stock_curation` | 큐레이션 메타 | v10 — is_curated=1 은 수집기 덮어쓰기 차단 |
| `email_verifications` | 이메일 인증 토큰 | 미사용 (`MEMORY.md`) |
| `transactions` | 거래 이력 | **V2 예정** (MEMORY.md / INSIGHTS.md) |

---

## 데이터 수집 정책

- **is_curated=1**: identity + 재무지표 모두 완전 보호 (upsert 스킵)
- **source 필드**: `curation` / `fmp` / `yahoo` 구분
