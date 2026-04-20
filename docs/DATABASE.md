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

## 현재 버전: v12

| 버전 | 내용 |
|------|------|
| v1~v8 | 기본 사용자·즐겨찾기·키워드·알림·이메일 인증 테이블 |
| v9 | `user_holdings` 테이블 (포트폴리오) — 복합 PK (user_id, stock_id) + upsert |
| v10 | `stocks` + `stock_curation` 테이블 (종목 마스터 DB, PK=symbol, FK CASCADE) |
| v11 | `stocks.peg` / `stocks.fcf` 컬럼 추가 (ALTER TABLE, idempotent) |
| v12 | `transactions` 테이블 (거래 이력 + 실현손익) — 2026-04-20 |

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
| `transactions` | 거래 이력 + 실현손익 | v12 — 평균원가법. 매수 시 평단 재계산, 매도 시 평단 유지 + `realized_pl` |

---

## 데이터 수집 정책

- **is_curated=1**: identity + 재무지표 모두 완전 보호 (upsert 스킵)
- **source 필드**: `curation` / `fmp` / `yahoo` / `krx` / `krx-etf` 구분
- **기동 시 자동 복구** (`db.js` 2026-04-20):
  - `seedStocksIfEmpty()` — stocks 비어있으면 `seed-stocks.js` 자동 실행 (307건)
  - `expandKrUniverseIfNeeded()` — KR 주식 < 1,000 이면 `fetch-krx-universe.js`, KR ETF < 500 이면 `fetch-kr-etfs.js` 자동 실행 → 총 2,708 주식 + 874 ETF

## v12 transactions 테이블 스키마

```
CREATE TABLE transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  stock_id    TEXT NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('buy','sell')),
  quantity    REAL NOT NULL,
  price       REAL NOT NULL,
  traded_at   INTEGER NOT NULL,
  realized_pl REAL,                   -- sell 시 (price - avg) × qty
  memo        TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_transactions_user       ON transactions(user_id, traded_at DESC);
CREATE INDEX idx_transactions_user_stock ON transactions(user_id, stock_id, traded_at);
```

**로직** (`server/auth.js` `/api/auth/transactions`):
- **POST**: 트랜잭션 원자 처리. 매수 시 `user_holdings` 평단 재계산, 매도 시 평단 유지 + realized_pl 기록. 전량 매도 시 holdings 삭제. 보유량 초과 매도는 400.
- **DELETE**: 거래 삭제 후 해당 종목 **모든 거래 시간순 재생** 으로 holdings 재구성 (안전한 정정).

## 영속성 보장 — 3중 방어 (2026-04-20)

1. Railway 볼륨 `/data/data.db` 마운트 확인 (env `DATA_DIR=/data`)
2. `GET /api/admin/ops/backup` — admin 설정 페이지 "DB 스냅샷 다운로드" 버튼. `better-sqlite3.backup()` WAL-safe
3. 기동 시 자동 seed/확장 (위 정책)
