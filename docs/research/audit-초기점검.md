# StockRadar — 초기 점검 감사 보고서

**작성일**: 2026-04-15
**점검 범위**: 문서 구조 · 코드 주석 · 의존성 · 환경변수 · DB 마이그레이션 · 보안
**점검자**: Claude Code
**점검 방식**: 읽기 전용 (소스 수정 없음)

---

## 1. docs/ 파일 목록 확인

**결과**: ✅ 6개 파일 확인 (요구: 6개 이상)

```
docs/
├── CLAUDE.md                     ← Claude Code 핵심 가이드
├── WORKFLOW.md                   ← 작업 방식 · /check 명령
├── MEMORY.md                     ← 기술 부채 · 의사결정 기록
└── research/
    ├── architecture.md           ← 아키텍처 결정 (스텁)
    ├── db-schema.md              ← DB 스키마 상세
    └── api-specs.md              ← API 엔드포인트·외부 연동·미들웨어
```

**비고**:
- `architecture.md` 는 현재 헤더만 있는 스텁 상태. 추후 PostgreSQL 전환 · SPA 분리 결정사항을 기록할 예정.
- `docs/audit-초기점검.md` 는 본 파일로 곧 추가됨.

---

## 2. server/ 내 TODO / FIXME / console.error 검색

### 🟡 TODO (3건) — `StockRadar_v5.html` 에만 존재

| 위치 | 내용 | 액션 |
|---|---|---|
| `StockRadar_v5.html:5787` | 카카오·네이버 로그인 버튼 주석 처리 — 연동 후 재노출 | 향후 소셜 로그인 확장 시 제거 |
| `StockRadar_v5.html:5805` | 이메일 가입/로그인 블록 주석 — 발신 도메인 확보 전까지 비활성 | Resend 커스텀 도메인 verify 후 복원 |
| `StockRadar_v5.html:5843` | 카카오·네이버 가입 버튼 주석 | (5787 과 세트) |

⚠️ **FIXME**: 0건 — 깨끗함.

### 🟢 console.error (6건) — 모두 의도된 로깅

| 위치 | 목적 |
|---|---|
| `auth.js:536` | Google OAuth 콜백 에러 로깅 (DB 기록 외 stderr 출력) |
| `index.js:125` | `SESSION_SECRET` 미설정 시 FATAL 메시지 → 직후 `process.exit(1)` |
| `index.js:1804` | 전역 에러 핸들러 — method·url·message 출력 |
| `index.js:1813` | `unhandledRejection` 이벤트 catch |
| `index.js:1817` | `uncaughtException` 이벤트 catch |
| `StockRadar_v5.html:10460` | 프론트 `[kwpTrending]` 로딩 실패 로깅 |

**평가**: 모든 `console.error` 가 **의도적 에러 출력**이며, 서버 측은 `logError()` DB 기록과 병행됨. 정리할 로그성 데드코드 없음.

---

## 3. 의존성 점검 (package.json)

### 사용 패키지 (12개)

| 패키지 | 현재 | 상태 | 비고 |
|---|---|---|---|
| express | ^5.2.1 | 🟡 RC-ish | Express 5 는 GA 된지 얼마 안 된 버전. major 버그 주시 필요. |
| express-session | ^1.19.0 | ✅ 최신 | |
| express-rate-limit | ^8.3.2 | ✅ 최신 | |
| connect-sqlite3 | ^0.9.16 | 🟡 | SQLite 세션 저장 — PostgreSQL 전환 시 `connect-pg-simple` 로 교체 예정 (MEMORY.md 등록) |
| helmet | ^8.1.0 | ✅ 최신 | ⚠️ CSP 끔 (인라인 스크립트 호환용) |
| cors | ^2.8.6 | ✅ | 개발 모드에서만 사용 |
| better-sqlite3 | ^12.9.0 | 🟡 | PostgreSQL 전환 시 `pg` 로 교체 예정 |
| bcryptjs | ^3.0.3 | ✅ | rounds 12 |
| dotenv | ^17.4.2 | ✅ | |
| **node-fetch** | ^2.7.0 | 🔴 **제거 권장** | Node 18+ 내장 `fetch` 존재. 실제 사용처는 `index.js` / `admin.js` 에 걸쳐 있지만 `require('node-fetch')` 를 명시적으로 부르는 곳은 admin.js 의 `fetchFn` fallback 1곳뿐. 검증 후 제거 가능. |
| resend | ^6.10.0 | ✅ 최신 | |
| zod | ^4.3.6 | ✅ 최신 | |

### devDependencies

**없음**. 🔴 테스트 프레임워크(jest/vitest), 린터(eslint), 포매터(prettier) 전부 미설치. 모든 변경이 수동 smoke test 로만 검증되는 상태 — MEMORY.md 🟢 낮은 우선순위에 등록됨.

### 권장 액션

1. **node-fetch 제거** — 다음 pass 에서 내장 fetch 로 교체 (MEMORY.md 🟢)
2. **express 5.x 안정성 모니터링** — major 버그 패치 주시 (MEMORY.md 🟢)
3. **eslint + 기본 smoke test 추가** — 상용화 전 권장 (MEMORY.md 🟢)

---

## 4. 환경변수 일치 점검

### 코드에서 참조 (`process.env.XXX`)

```
ADMIN_SEED_EMAIL · ADMIN_SEED_PASSWORD
DATA_DIR · DB_PATH
EMAIL_FROM · FMP_API_KEY · GEMINI_API_KEY
FMP_MONTHLY_USD · GEMINI_FREE_CREDIT_USD · RAILWAY_MONTHLY_USD · RESEND_MONTHLY_USD
GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET
NODE_ENV · OAUTH_CALLBACK_BASE · PORT
RESEND_API_KEY · SESSION_SECRET · USD_KRW_RATE
```
**19개 키**

### `.env.example` 정의

```
ADMIN_SEED_EMAIL · ADMIN_SEED_PASSWORD
DATA_DIR · DB_PATH
EMAIL_FROM · FMP_API_KEY · GEMINI_API_KEY
FMP_MONTHLY_USD · GEMINI_FREE_CREDIT_USD · RAILWAY_MONTHLY_USD · RESEND_MONTHLY_USD
GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET
NODE_ENV · OAUTH_CALLBACK_BASE · PORT
RESEND_API_KEY · SESSION_SECRET · USD_KRW_RATE
```
**19개 키** (+ KAKAO/NAVER 4개는 주석으로 향후 준비)

### 결과: ✅ 완전 일치 (diff 0)

- 코드에만 있고 example 에 없는 키: **없음**
- example 에만 있고 코드에 없는 키: **없음** (주석 처리된 KAKAO_* / NAVER_* 는 의도적 미사용)

---

## 5. db.js 마이그레이션 순서 일관성

### 버전 마커 위치

```
v1 초기 스키마                     (line 30)
v2 AI 사용량 트래킹                (line 104)
v3 에러 로그 + 공지사항            (line 123)
v4 이벤트 로그                     (line 159)
v5 프로필 완료 플래그 (users 컬럼 추가)  (line 178)
v6 AI 호출 컨텍스트 (ai_usage 컬럼)      (line 187)
v7 투자 가이드 글 (articles)        (line 191)
v8 고객 문의 (inquiries)            (line 215)
```

### 검증 결과: ✅ 정상

- 버전 번호 연속성: **v1 → v8 빠짐 없음**
- `migrations` 배열 길이(8) == `user_version` 최종값(8) 일치
- 각 마이그레이션 함수가 `(db) => { ... }` 단일 시그니처 준수
- `runMigrations()` 가 `db.transaction()` 으로 감싸 원자성 보장
- v5 의 백필 `UPDATE users SET terms_accepted_at = created_at WHERE ...` 가 동일 트랜잭션 내 실행됨 — 실패 시 컬럼 추가까지 롤백

### ⚠️ 다음 마이그레이션 주의

- **반드시 v9** — `migrations` 배열 끝에 함수 append 만 하면 `user_version` 이 9 로 자동 증가
- SQLite 제약: `DROP COLUMN` · 타입 변경 미지원
- `NOT NULL` 컬럼 추가 시 반드시 `DEFAULT` 병행
- 상세 체크리스트는 `docs/research/db-schema.md` § 5 참조

---

## 6. STEP 5 보안 이슈 요약

### ❌ Critical: 0건

### ⚠️ Warning: 2건

1. **helmet CSP 비활성화** (`index.js:28`)
   - 현황: `contentSecurityPolicy: false` — 인라인 스크립트 호환 목적
   - 위험: XSS 경로가 존재할 경우 인라인 실행 차단 불가
   - 완화: 서버 측 입력이 zod + prepared SQL 로 소독되어 실질 공격 경로 좁음
   - 권장: **StockRadar_v5.html 모듈 분리 후** CSP nonce 방식으로 재활성 (MEMORY.md 🟡)

2. **AI 엔드포인트 수동 auth 검사**
   - 위치: `/api/ai-analysis`, `/api/ai-chat`, `/api/ai-sector`, `/api/inquiries/mine`
   - 현황: 핸들러 내부 `if (!req.user) return 401` 로 보호 (보안적으로는 작동)
   - 문제: 일관성 부족 — 라우트 정의만 봐서는 인증 필수 여부 불명확, 신규 AI 엔드포인트 추가 시 실수 누락 가능
   - 권장: `requireAuth` 미들웨어로 이관

### ✅ OK: 8건

| 항목 | 확인 내용 |
|---|---|
| 1 `.gitignore` | `.env*`, `data.db*`, `sessions.db*`, `node_modules/` 전부 차단 |
| 2 bcrypt rounds | 모든 `bcrypt.hash()` 호출이 **rounds 12** (auth.js/admin.js/db.js) |
| 3 SQL 인젝션 | prepared statement 128회 · `db.exec()` 는 정적 DDL 9곳만 |
| 5 CORS | `IS_PROD` 에서는 `cors` 미들웨어 attach 안 함 → same-origin |
| 6 세션 쿠키 | `httpOnly:true` · `secure: IS_PROD` · `sameSite:'lax'` · `maxAge 30일` · `rolling:true` |
| 7 관리자 보호 | `admin.js` 상단 `router.use(requireAdmin)` 일괄 |
| 9 민감 경로 차단 | `BLOCKED_PATH` 정규식 + `dotfiles:'deny'` 이중 방어 |
| 10 SESSION_SECRET 검증 | 프로덕션 미설정 시 `process.exit(1)` |

---

## 📊 종합 요약

| 영역 | 결과 |
|---|---|
| 문서 구조 | ✅ 6개 파일 세팅 완료 |
| 코드 주석 정리 | 🟢 TODO 3건(의도적 주석) · FIXME 0 · console.error 모두 의도된 로깅 |
| 의존성 | 🟡 1건 제거 권장 (node-fetch) · devDependencies 전무 |
| 환경변수 | ✅ 코드 ↔ .env.example 완전 동기화 (19/19) |
| DB 마이그레이션 | ✅ v1~v8 순차 · 무결 · 다음 v9 준비 OK |
| 보안 | ✅ Critical 0 · Warning 2 (기록됨) · OK 8 |

### 다음 작업 우선순위 (상용화 기준)

🔴 **높음** — MEMORY.md 에 이미 등록
- SQLite → PostgreSQL 전환
- express-session → Redis / JWT 전환
- admin.js Gemini 직접 호출 → callGemini() 통합
- StockRadar_v5.html 모듈 분리

🟡 **중간**
- 이메일 인증 활성화 (회원가입 블록 복원)
- helmet CSP 재활성화
- 결제 모듈(payments.js) 분리 준비
- 개인정보 암호화 · 회원 탈퇴 + 개인정보 삭제 기능

🟢 **낮음**
- node-fetch 제거
- express 5.x 안정성 모니터링
- 테스트 코드 도입
- Rate Limiting 엔드포인트별 세분화

---

**감사 종료** · 소스 파일 수정 없음.
