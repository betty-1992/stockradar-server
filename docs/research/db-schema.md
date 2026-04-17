# DB 스키마

- **엔진**: SQLite (better-sqlite3)
- **저장 위치**: `server/data.db` (로컬) / `DATA_DIR` env (Railway 볼륨 `/data/data.db`)
- **PRAGMA**: `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`
- **마이그레이션 방식**: `user_version` PRAGMA 기반 순차 실행 (`runMigrations()`)
- **현재 버전**: **v11**

---

## 1. 테이블 목록

| 테이블명 | 도입 버전 | 역할 한 줄 설명 |
|---|---|---|
| `users` | v1 | 회원 계정 · 소셜 로그인 provider · 권한(role) · 상태(status) |
| `user_keywords` | v1 | 유저별 관심 키워드 (트렌드 트래커 · 뉴스 필터 소스) |
| `user_favorites` | v1 | 유저별 관심 종목 (홈 watchlist 미리보기 · 전용 페이지) |
| `audit_logs` | v1 | 관리자 행동 · 동의 증거 · 인증 이벤트 기록 |
| `menus` | v1 | 어드민에서 편집 가능한 LNB 메뉴 구성 |
| `email_verifications` | v1 | 이메일 인증 코드 (현재 미사용, 재도입 대비) |
| `ai_usage` | v2 | AI 호출별 모델·토큰·비용·컨텍스트 기록 |
| `error_logs` | v3 | 서버 500 에러 · 미들웨어 예외 DB 수집 |
| `notices` | v3 | 사용자 페이지 상단 공지 배너 (level · 활성 기간) |
| `events` | v4 | 사용자 행동 로그 (page_view · search · view_profile 등) |
| `articles` | v7 | AI 로 작성되는 투자 가이드 블로그 글 |
| `inquiries` | v8 | 고객 문의 (카테고리 · 상태 · 관리자 답변) |
| `user_holdings` | v9 | 유저별 포트폴리오(나의 투자) 보유 종목 — 수량·평단·메모 |
| `stocks` | v10 | 종목 마스터 — FMP/큐레이션 기반 원천 데이터 (하드코딩 MASTER 대체) |
| `stock_curation` | v10 | 수기 정성값 (score/geo/inst/note) — 재수집 시 덮어쓰기 방지 목적 분리 |

총 **15개 테이블**.

---

## 2. 테이블별 컬럼 상세

### `users` (v1, v5 컬럼 추가)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| email | TEXT | ✅ | — | 로그인 ID (UNIQUE) |
| pw_hash | TEXT | ❌ | NULL | bcrypt 해시 (소셜 전용 계정은 NULL) |
| nickname | TEXT | ✅ | — | 서비스 내 표시명 |
| role | TEXT | ✅ | `'user'` | `user` / `admin` |
| status | TEXT | ✅ | `'active'` | `active` / `pending` / `banned` |
| provider | TEXT | ✅ | `'local'` | `local` / `google` / `kakao` / `naver` |
| provider_id | TEXT | ❌ | NULL | 소셜 subject ID (provider + provider_id UNIQUE) |
| email_verified | INTEGER | ✅ | 0 | 1 = 인증 완료 (현재 미사용 로직) |
| created_at | INTEGER | ✅ | — | 가입 시각 (ms epoch) |
| last_login | INTEGER | ❌ | NULL | 마지막 로그인 시각 |
| login_count | INTEGER | ✅ | 0 | 누적 로그인 횟수 |
| **terms_accepted_at** (v5) | INTEGER | ❌ | NULL | 약관 동의 시각. NULL = 프로필 미완료 |
| **marketing_agreed** (v5) | INTEGER | ✅ | 0 | 마케팅 수신 동의 여부 |

**인덱스**: `idx_users_email`, `idx_users_role`, `idx_users_status` · **UNIQUE**: `email`, `(provider, provider_id)`

---

### `user_keywords` (v1)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| user_id | INTEGER | ✅ | — | FK → users.id (ON DELETE CASCADE) |
| keyword | TEXT | ✅ | — | 키워드 문자열 |
| created_at | INTEGER | ✅ | — | 등록 시각 |

**PK**: `(user_id, keyword)` 복합 키 — 같은 유저가 같은 키워드를 중복 저장 불가.

---

### `user_favorites` (v1)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| user_id | INTEGER | ✅ | — | FK → users.id (ON DELETE CASCADE) |
| stock_id | TEXT | ✅ | — | 종목 티커 (예: `005930`, `AAPL`) |
| created_at | INTEGER | ✅ | — | 저장 시각 |

**PK**: `(user_id, stock_id)` 복합 키.

---

### `user_holdings` (v9)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| user_id | INTEGER | ✅ | — | FK → users.id (ON DELETE CASCADE) |
| stock_id | TEXT | ✅ | — | 종목 티커 (대문자 정규화, 예: `AAPL`, `005930`) |
| quantity | REAL | ✅ | — | 보유 수량 (소수점 주식 지원) |
| avg_price | REAL | ✅ | — | 평균 매수가 (통화는 stock_id 로 판정 — `/^\d{6}$/` KR, 그 외 US) |
| memo | TEXT | ❌ | NULL | 유저 메모 (최대 500자) |
| created_at | INTEGER | ✅ | — | 최초 등록 시각 |
| updated_at | INTEGER | ✅ | — | 마지막 수정 시각 (upsert 시 갱신) |

**PK**: `(user_id, stock_id)` 복합 키 — 동일 종목 재매수 시 row 분할 없이 **평단 재계산 후 UPDATE** (upsert).
**인덱스**: `idx_holdings_user` (user_id 단일)
**Upsert**: `INSERT ... ON CONFLICT(user_id, stock_id) DO UPDATE SET quantity, avg_price, memo, updated_at = excluded.*`

---

### `stocks` (v10)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| symbol | TEXT | ✅ | — | 티커 (PK 단일) — 미국은 `AAPL`, 한국은 6자리 숫자 원본 |
| market | TEXT | ✅ | — | `US` \| `KR` |
| name | TEXT | ✅ | — | 표시명 (원본 또는 영문) |
| name_kr | TEXT | ❌ | NULL | 한글 표시명 (한국 종목 또는 국내 ETF) |
| exchange | TEXT | ❌ | NULL | `NYSE` \| `NASDAQ` \| `KOSPI` \| `KOSDAQ` \| `AMEX` 등 |
| sector | TEXT | ❌ | NULL | 영문 섹터 (Yahoo/FMP 표기) |
| industry | TEXT | ❌ | NULL | 업종 세부 |
| market_cap | REAL | ❌ | NULL | 시가총액 (USD 단위 권장, KR 는 환산) |
| currency | TEXT | ❌ | NULL | `USD` \| `KRW` |
| is_etf | INTEGER | ✅ | 0 | ETF 여부 |
| etf_index | TEXT | ❌ | NULL | 추적 지수 (ETF 만) |
| tags | TEXT | ❌ | NULL | JSON 배열 문자열 (예: `'["반도체","AI"]'`) |
| per | REAL | ❌ | NULL | FMP 보강 시 채워짐 |
| pbr | REAL | ❌ | NULL | 〃 |
| roe | REAL | ❌ | NULL | 〃 |
| dividend_yield | REAL | ❌ | NULL | 〃 |
| revenue_growth | REAL | ❌ | NULL | 〃 |
| **peg** (v11) | REAL | ❌ | NULL | Price/Earnings to Growth ratio — FMP key-metrics-ttm · Yahoo defaultKeyStatistics |
| **fcf** (v11) | REAL | ❌ | NULL | Free Cash Flow (절대값, 해당 종목 통화) — FMP: FCF/share × shares · Yahoo: financialData.freeCashflow |
| source | TEXT | ✅ | `unknown` | `fmp` \| `krx` \| `curation` \| `yahoo` \| `unknown` |
| is_curated | INTEGER | ✅ | 0 | 수기 큐레이션 플래그 — 대량 재수집 시 덮어쓰기 차단 |
| is_active | INTEGER | ✅ | 1 | 상장폐지/비활성 soft-delete (hard-delete 금지 — 포트폴리오 참조 보호) |
| last_fetched_at | INTEGER | ❌ | NULL | 외부 API 마지막 조회 시각 (rate limit 판단) |
| last_seen_at | INTEGER | ❌ | NULL | 전체 목록 재수집에서 마지막으로 본 시각 (deprecation 판별) |
| created_at | INTEGER | ✅ | — | 최초 등록 시각 |
| updated_at | INTEGER | ✅ | — | 마지막 수정 시각 |

**PK**: `symbol` 단일
**인덱스**: `idx_stocks_market`, `idx_stocks_sector(market, sector)`, `idx_stocks_mcap(market_cap DESC)`, `idx_stocks_active(is_active, market)`, `idx_stocks_etf(is_etf)`

---

### `stock_curation` (v10)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| symbol | TEXT | ✅ | — | FK → stocks.symbol (ON DELETE CASCADE) |
| score | INTEGER | ❌ | NULL | 1~5 점수 (큐레이터 평가) |
| geo | INTEGER | ❌ | 0 | 지정학 리스크 플래그 |
| inst | INTEGER | ❌ | 0 | 기관 매수 플래그 |
| note | TEXT | ❌ | NULL | 큐레이터 메모 |
| updated_by | INTEGER | ❌ | NULL | 편집 관리자 user id |
| updated_at | INTEGER | ✅ | — | 마지막 수정 시각 |

**PK**: `symbol` 단일
**목적**: 정성값(수기)과 정량값(자동 수집) 분리 — `stocks` 재수집 파이프라인이 덮어쓰지 않도록.

---

### `audit_logs` (v1)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| user_id | INTEGER | ❌ | NULL | FK → users.id (ON DELETE SET NULL) |
| action | TEXT | ✅ | — | 이벤트 명 (`login` / `admin_update_user` 등) |
| target | TEXT | ❌ | NULL | 대상 ID 또는 식별자 |
| meta | TEXT | ❌ | NULL | JSON 직렬화된 메타 데이터 |
| ip | TEXT | ❌ | NULL | 요청 IP |
| created_at | INTEGER | ✅ | — | 이벤트 시각 |

**인덱스**: `idx_audit_created`, `idx_audit_action`

---

### `menus` (v1)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| key | TEXT | ✅ | — | 프론트 `showPage()` 가 받는 페이지 키 (UNIQUE) |
| label | TEXT | ✅ | — | 메뉴 표시 라벨 |
| icon | TEXT | ❌ | NULL | 이모지/아이콘 |
| order_idx | INTEGER | ✅ | — | 노출 순서 |
| enabled | INTEGER | ✅ | 1 | 1 = 표시 / 0 = 숨김 |
| min_role | TEXT | ✅ | `'user'` | 최소 노출 권한 (`user` / `admin`) |
| updated_at | INTEGER | ❌ | NULL | 마지막 수정 시각 |

**시드**: 서버 최초 기동 시 `DEFAULT_MENUS` (홈 / 종목 발굴 / 섹터 맵 / 트렌드 트래커 / 투자 가이드) 5개 자동 입력.

---

### `email_verifications` (v1, 현재 유휴)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| email | TEXT | ✅ | — | 대상 이메일 |
| code | TEXT | ✅ | — | 6자리 인증 코드 |
| purpose | TEXT | ✅ | — | `signup` / `password_reset` 등 |
| created_at | INTEGER | ✅ | — | 코드 발급 시각 |
| expires_at | INTEGER | ✅ | — | 만료 시각 |
| consumed | INTEGER | ✅ | 0 | 1 = 이미 사용됨 |

**인덱스**: `idx_email_verif_email` · **상태**: 이메일 인증 비활성화로 현재 insert 되지 않음.

---

### `ai_usage` (v2, v6 컬럼 추가)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| user_id | INTEGER | ❌ | NULL | FK → users.id (ON DELETE SET NULL) |
| endpoint | TEXT | ✅ | — | `ai-analysis` / `ai-chat` / `ai-sector` / `ai-article-draft` |
| model | TEXT | ✅ | — | Gemini 모델 식별자 |
| prompt_tokens | INTEGER | ✅ | 0 | 입력 토큰 |
| completion_tokens | INTEGER | ✅ | 0 | 출력 토큰 |
| total_tokens | INTEGER | ✅ | 0 | 합계 (0이면 prompt+completion 으로 자동 보정) |
| cost_usd | REAL | ✅ | 0 | `GEMINI_PRICING` 기반 환산 비용 |
| **context** (v6) | TEXT | ❌ | NULL | JSON (심볼 · 질문 요약 · 섹터명 등), 최대 1500자 |
| created_at | INTEGER | ✅ | — | 호출 시각 |

**인덱스**: `idx_ai_usage_user`, `idx_ai_usage_created`

---

### `error_logs` (v3)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| level | TEXT | ✅ | `'error'` | `error` / `warn` |
| source | TEXT | ❌ | NULL | `express` / `route` / `unhandledRejection` / `uncaughtException` |
| message | TEXT | ✅ | — | 최대 2000자 |
| stack | TEXT | ❌ | NULL | 최대 4000자 |
| url | TEXT | ❌ | NULL | 요청 URL |
| method | TEXT | ❌ | NULL | HTTP 메서드 |
| status | INTEGER | ❌ | NULL | 응답 코드 |
| user_id | INTEGER | ❌ | NULL | FK → users.id (ON DELETE SET NULL) |
| ip | TEXT | ❌ | NULL | 요청 IP |
| resolved | INTEGER | ✅ | 0 | 어드민이 "해결 처리"하면 1 |
| created_at | INTEGER | ✅ | — | 기록 시각 |

**인덱스**: `idx_error_logs_created`, `idx_error_logs_resolved`, `idx_error_logs_source`

---

### `notices` (v3)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| title | TEXT | ✅ | — | 공지 제목 |
| body | TEXT | ✅ | `''` | 본문 |
| level | TEXT | ✅ | `'info'` | `info` / `warn` / `danger` — 배너 색상 결정 |
| enabled | INTEGER | ✅ | 1 | 활성 스위치 |
| starts_at | INTEGER | ❌ | NULL | 노출 시작 (NULL = 제한 없음) |
| ends_at | INTEGER | ❌ | NULL | 노출 종료 |
| created_at | INTEGER | ✅ | — | 작성 시각 |
| updated_at | INTEGER | ✅ | — | 수정 시각 |

**인덱스**: `idx_notices_enabled`

---

### `events` (v4)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| user_id | INTEGER | ❌ | NULL | FK → users.id (ON DELETE SET NULL) |
| type | TEXT | ✅ | — | `page_view` / `search` / `view_profile` / `ai_analyze` 등 |
| target | TEXT | ❌ | NULL | 대상 (심볼 · 검색어 · 페이지 키) |
| meta | TEXT | ❌ | NULL | JSON (최대 1000자) |
| ip | TEXT | ❌ | NULL | 요청 IP |
| created_at | INTEGER | ✅ | — | 기록 시각 |

**인덱스**: `idx_events_created`, `idx_events_type`, `idx_events_user`, `idx_events_target`

---

### `articles` (v7)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| slug | TEXT | ✅ | — | URL 식별자 (UNIQUE, `^[a-z0-9-]+$`) |
| category | TEXT | ✅ | `'basics'` | `basics` / `chart` / `value` / `risk` / `master` / `psych` |
| emoji | TEXT | ✅ | `'📖'` | 카드 히어로 이모지 |
| title | TEXT | ✅ | — | 글 제목 |
| summary | TEXT | ✅ | `''` | 한 줄 요약 |
| body | TEXT | ✅ | `''` | HTML 본문 (최대 20000자) |
| read_min | INTEGER | ✅ | 4 | 예상 읽기 시간(분) |
| status | TEXT | ✅ | `'draft'` | `draft` / `published` / `archived` |
| author_id | INTEGER | ❌ | NULL | FK → users.id (ON DELETE SET NULL) |
| created_at | INTEGER | ✅ | — | 생성 시각 |
| updated_at | INTEGER | ✅ | — | 수정 시각 |
| published_at | INTEGER | ❌ | NULL | 최초 발행 시각 |

**인덱스**: `idx_articles_status`, `idx_articles_category`, `idx_articles_published`

---

### `inquiries` (v8)
| 컬럼 | 타입 | NOT NULL | 기본값 | 설명 |
|---|---|---|---|---|
| id | INTEGER | ✅ | AUTOINCREMENT | PK |
| user_id | INTEGER | ❌ | NULL | FK → users.id (ON DELETE SET NULL) |
| email | TEXT | ❌ | NULL | 비로그인 작성자용 답변 이메일 |
| category | TEXT | ✅ | `'general'` | `general` / `account` / `bug` / `feature` / `payment` / `other` |
| subject | TEXT | ✅ | — | 제목 (최대 200자) |
| message | TEXT | ✅ | — | 본문 (최대 4000자) |
| status | TEXT | ✅ | `'open'` | `open` / `in_progress` / `resolved` / `closed` |
| admin_reply | TEXT | ❌ | NULL | 관리자 답변 본문 |
| replied_at | INTEGER | ❌ | NULL | 답변 시각 |
| replied_by | INTEGER | ❌ | NULL | FK → users.id (ON DELETE SET NULL), 답변한 관리자 |
| created_at | INTEGER | ✅ | — | 접수 시각 |
| updated_at | INTEGER | ✅ | — | 마지막 수정 시각 |

**인덱스**: `idx_inquiries_status`, `idx_inquiries_user`, `idx_inquiries_created`

---

## 3. 테이블 간 관계

### 외래 키 명시

```
users (id)
 ├── user_keywords.user_id        [ON DELETE CASCADE]   — 탈퇴 시 키워드 동반 삭제
 ├── user_favorites.user_id       [ON DELETE CASCADE]   — 탈퇴 시 즐겨찾기 동반 삭제
 ├── audit_logs.user_id           [ON DELETE SET NULL]  — 감사 이력은 보존, user_id 만 비움
 ├── ai_usage.user_id             [ON DELETE SET NULL]  — 비용 집계용으로 보존
 ├── error_logs.user_id           [ON DELETE SET NULL]  — 에러 추적 보존
 ├── events.user_id               [ON DELETE SET NULL]  — 행동 로그 집계용 보존
 ├── articles.author_id           [ON DELETE SET NULL]  — 글은 저자 없이도 노출 가능
 ├── inquiries.user_id            [ON DELETE SET NULL]  — 문의 이력 보존
 └── inquiries.replied_by         [ON DELETE SET NULL]  — 답변 감사 이력 보존
```

### 논리적 관계 (외래키 없음 · 애플리케이션 레이어 결합)

- `user_favorites.stock_id` ↔ 프론트 `MASTER` 객체의 종목 코드 (DB 에 종목 마스터 테이블 없음, `etfs.js` + `StockRadar_v5.html` 상수)
- `menus.key` ↔ 프론트 `showPage()` 에 전달되는 페이지 식별자
- `audit_logs.action`, `events.type`, `inquiries.category` 등은 문자열 enum — CHECK 제약 없음 (애플리케이션에서 검증)

### 삭제 정책 요약

- **유저 정보 삭제(하드 삭제)**: `user_keywords`, `user_favorites` 자동 cascade.
- **통계·감사 이력**: `user_id` 만 `NULL` 로 끊고 레코드는 보존. AI 비용, 에러 추적, 행동 분석이 유저 삭제와 무관하게 유지됨.
- **Admin soft delete**: `users.status = 'banned'` 로 비활성화만 하는 경우도 존재 (`DELETE /api/admin/users/:id`).

---

## 4. 마이그레이션 이력 요약

| 버전 | 내용 |
|---|---|
| **v1** | 초기 스키마 — `users`, `user_keywords`, `user_favorites`, `audit_logs`, `menus`, `email_verifications` 생성 + 기본 인덱스 |
| **v2** | `ai_usage` 테이블 추가 — Gemini 호출당 토큰·비용 트래킹 시작 |
| **v3** | `error_logs` + `notices` 테이블 동시 추가 — 서버 에러 DB 수집 및 사용자 공지 배너 |
| **v4** | `events` 테이블 추가 — 사용자 행동 로그 (DAU/MAU 집계 기반) |
| **v5** | `users` 에 `terms_accepted_at` · `marketing_agreed` 컬럼 추가 + 기존 가입자 `created_at` 으로 백필 |
| **v6** | `ai_usage.context TEXT` 컬럼 추가 — 어떤 종목·질문이었는지 JSON 저장 |
| **v7** | `articles` 테이블 추가 — 어드민에서 AI 로 작성하는 투자 가이드 글 |
| **v8** | `inquiries` 테이블 추가 — 고객 문의 (CS봇 접수 + 관리자 답변) |
| **v9** | `user_holdings` 테이블 추가 — 포트폴리오(나의 투자) 보유 종목: 복합 PK `(user_id, stock_id)`, upsert 패턴 |
| **v10** | `stocks` + `stock_curation` 테이블 추가 — 종목 마스터 DB 전환 Phase 0 (하드코딩 MASTER/KOREAN_TICKERS/KR_INFO 대체 준비) |
| **v11** | `stocks` 에 `peg` · `fcf` 컬럼 추가 (ALTER TABLE ADD COLUMN, idempotent) — Phase 2 대량 수집기 재무지표 확장 |

---

## 5. 다음 마이그레이션 주의사항

### 반드시 **v12** 로 증가
- 현재 `user_version = 11`. 새 마이그레이션은 **`migrations` 배열 끝에 함수 하나 append** 하면 자동으로 v12 로 올라감.
- 버전 번호를 건너뛰거나 중간에 끼워 넣지 말 것 — `user_version` 은 인덱스(길이) 기반으로 관리됨.

### 변경 전 체크리스트
1. **docs/CLAUDE.md · MEMORY.md 업데이트** — 새 테이블/컬럼의 목적을 기록.
2. **ALTER vs CREATE 구분**
   - 신규 테이블: `CREATE TABLE IF NOT EXISTS ...`
   - 기존 테이블 컬럼 추가: `ALTER TABLE x ADD COLUMN ...` — SQLite 는 `DROP COLUMN`, 컬럼 rename, 타입 변경이 제한적.
3. **ALTER 시 NOT NULL + 기본값** — NOT NULL 만으로는 실패. `DEFAULT` 같이 선언하거나 nullable 로 추가 후 백필 `UPDATE`.
4. **백필 쿼리 포함** — 기존 로우에 의미 있는 초기값이 필요하면 같은 migration 함수 안에서 `UPDATE` 실행 (예: v5 `terms_accepted_at = created_at`).
5. **트랜잭션 자동 적용** — `runMigrations()` 가 `db.transaction()` 으로 감싸므로 개별 마이그레이션 함수 안에 트랜잭션을 추가로 여는 것은 금지.
6. **인덱스**는 `CREATE INDEX IF NOT EXISTS` 로 항상 idempotent 하게.
7. **FK on delete 정책**은 새 테이블 생성 시 명시 — 유저 탈퇴 시 cascade 할지 set null 할지 결정.
8. **foreign_keys PRAGMA 가 ON** 이므로 기존 데이터가 있는 테이블에 FK 추가 시 참조 무결성 깨진 행이 있으면 migration 실패. 사전 검증 필요.
9. **middleware.js `attachUser` 의 SELECT 컬럼 목록 동기화** — users 테이블에 컬럼 추가 후 `req.user` 에서 읽어야 한다면 SELECT 절에 추가 + `publicUser()` 매핑도 확인.
10. **배포 순서** — 로컬에서 마이그레이션 통과 확인 → 로컬 `data.db` 삭제 후 재기동 시나리오로도 검증 → push. Railway 볼륨의 기존 DB 는 서버 최초 기동 시 한 번만 마이그레이션이 실행됨.

### 1회성 seed 스크립트 — `server/scripts/seed-stocks.js`

**목적**: 하드코딩 종목 데이터(MASTER·KR_INFO·KOREAN_TICKERS·KR_ETFS·US_ETFS)를 `stocks` + `stock_curation` 테이블로 1회 이전.

**실행 방법**:
```bash
cd server
node scripts/seed-stocks.js
```

**전제**:
- v10 마이그레이션 적용 완료 (서버 최초 기동 시 자동). 테이블 부재 시 스크립트가 종료하며 에러 메시지 출력.
- `DATA_DIR` / `DB_PATH` env 존중 (없으면 `server/data.db`).

**병합 우선순위**:
1. `KOREAN_TICKERS` + `KR_INFO` → KR 주식 기본행 (이름/섹터는 KR_INFO 우선)
2. `KR_ETFS`, `US_ETFS` → ETF 행 별도 삽입 (is_etf=1, tags JSON 문자열)
3. `MASTER` overlay → name/sector/tags/market_cap/per/roe/div/revenue_growth 덮어씀 (큐레이터 의도 최우선)
4. `MASTER` 의 정성값(score/geo/inst)은 `stock_curation` 으로 분리

**idempotent**: 여러 번 실행해도 동일 결과. `ON CONFLICT(symbol) DO UPDATE` 사용.

**마킹**: 모든 seed 행은 `source='curation'`, `is_curated=1` — 이후 Phase 2 대량 수집기가 덮어쓰지 않음.

**기준 통계 (2026-04-16 기준 최초 실행)**:
- 총 `stocks`: **307** (KR 165 = 주식 117 + ETF 48 / US 142 = 주식 87 + ETF 55)
- `stock_curation`: **112** (MASTER 전체)

---

### 롤백 주의
- SQLite + 본 구현은 **down migration 미지원**. 한 번 v9 로 올라가면 되돌리려면 `user_version` PRAGMA 를 직접 낮추고 `ALTER TABLE DROP COLUMN` 등을 수동 실행해야 함.
- 커밋 직전에 반드시 스키마 diff 를 `docs/research/db-schema.md` 에 함께 업데이트해서 팀/AI 가 최신 구조를 파악할 수 있게 할 것.

---

**STEP 3 완료**
