# StockRadar

주식 스크리너 · 트렌드 트래커 · 섹터 맵 · AI 분석 · 투자 가이드.
실시간 시세(Yahoo), 재무(FMP), AI 분석(Gemini), 뉴스(Google News), 이메일(Resend) 기반.

- **Repo**: github.com/betty-1992/stockradar-server
- **Production**: https://stockradar-server-production-394b.up.railway.app (Railway 기본 도메인, 커스텀 도메인 미연결)
- **Stack**: Node.js 18+ · Express 5 · better-sqlite3 · Vanilla JS SPA
- **Deploy**: Railway (풀스택 단일 배포. Vercel 프론트 분리는 향후 과제)

---

## 📁 프로젝트 구조

```
StockRadar/
├── README.md                       ← 본 문서
├── .gitignore
├── nixpacks.toml                   ← Railway Nixpacks 설정
├── railway.json                    ← Railway 배포 config
│
├── docs/                           ← 팀·AI 가이드 문서
│   ├── CLAUDE.md                   ← Claude Code 핵심 가이드
│   ├── WORKFLOW.md                 ← 작업 방식 · /check 명령
│   ├── MEMORY.md                   ← 기술 부채 · 의사결정 기록
│   └── research/
│       ├── architecture.md         ← 아키텍처 결정 사항 (스텁)
│       ├── db-schema.md            ← DB 스키마 전수 문서
│       └── api-specs.md            ← API 엔드포인트·외부 연동·미들웨어
│
└── server/                         ← Railway Root Directory
    ├── .env                        ← gitignored — 실제 시크릿
    ├── .env.example                ← 환경변수 템플릿 (커밋됨)
    ├── .gitignore
    ├── package.json
    ├── package-lock.json
    │
    ├── index.js                    ← Express 메인 — 시세·뉴스·AI API + 정적 서빙
    ├── auth.js                     ← /api/auth/* (signup·login·Google OAuth·complete)
    ├── admin.js                    ← /api/admin/* (requireAdmin 일괄 적용)
    ├── db.js                       ← SQLite 마이그레이션 v1~v8 + 헬퍼
    ├── middleware.js               ← attachUser · requireAuth · requireAdmin
    ├── email.js                    ← Resend 이메일 발송
    ├── etfs.js                     ← KR/US ETF 마스터 데이터
    │
    ├── StockRadar_v5.html          ← 사용자 SPA (~15k줄, 분리 예정)
    ├── admin.html                  ← 어드민 콘솔
    │
    ├── data.db / .db-wal / .db-shm ← gitignored, Railway 볼륨
    └── sessions.db                 ← gitignored, Railway 볼륨
```

---

## 🖥️ 로컬 개발 환경 세팅

### 1. 프로젝트 받기
```bash
git clone https://github.com/betty-1992/stockradar-server.git
cd stockradar-server
```

### 2. 환경 변수 설정
```bash
cd server
cp .env.example .env
```

그 다음 `server/.env` 를 열어 값을 채웁니다. 최소한 아래 키는 필수:

| 키 | 필수 여부 | 비고 |
|---|---|---|
| `SESSION_SECRET` | ✅ 필수 | 32자 이상 랜덤 문자열. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 로 생성 |
| `ADMIN_SEED_EMAIL` | ✅ 필수 | 서버 최초 기동 시 자동 생성될 관리자 이메일 |
| `ADMIN_SEED_PASSWORD` | ✅ 필수 | 초기 관리자 비밀번호 (로그인 후 즉시 변경) |
| `FMP_API_KEY` | 선택 | 재무 지표 조회용. 없으면 `/api/profile` · `/api/financials` 미동작 |
| `GEMINI_API_KEY` | 선택 | AI 분석·챗봇·섹터 브리핑용. 없으면 해당 기능만 비활성 |
| `RESEND_API_KEY` / `EMAIL_FROM` | 선택 | 이메일 인증·비번 재설정용. 미설정 시 이메일 전송만 건너뜀 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `OAUTH_CALLBACK_BASE` | 선택 | 구글 소셜 로그인 활성화 시 |

전체 키 목록과 각 용도는 `server/.env.example` 에 주석으로 기록돼 있습니다.

### 3. 의존성 설치 & 실행
```bash
npm install
node index.js
```

처음 실행 시 자동으로:
- `data.db` 생성 + 마이그레이션 v1~v8 실행
- `DEFAULT_MENUS` 시드 (5개 기본 메뉴)
- `ADMIN_SEED_EMAIL` 로 초기 관리자 계정 생성

### 4. 접속
- **사용자 페이지**: http://localhost:3000/
- **어드민 콘솔**: http://localhost:3000/admin
- **헬스체크**: http://localhost:3000/health
- **API 상태**: http://localhost:3000/api/status

### 5. 초기 관리자 로그인
`.env` 의 `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` 로 `/admin` 에 접속 → **로그인 후 즉시 비밀번호 변경** (설정 메뉴).

---

## 🚀 배포 구조

### 전체 아키텍처

```
┌──────────────────────────┐          ┌──────────────────────────┐
│  Vercel (프론트, 예정)    │   ◀────▶  │  Railway (백엔드)         │
│  정적 HTML/CSS/JS 배포    │  HTTPS    │  Express 5 · Node 18     │
└──────────────────────────┘          │  + SQLite 영구 볼륨       │
                                       └────────────┬─────────────┘
                                                    │
                                     외부 API 호출 (서버 경유)
                                                    ▼
                               Yahoo Finance · FMP · Google News ·
                               Google Gemini · Google OAuth · Resend
```

### Railway (백엔드)

- **Root Directory**: `server/`
- **Builder**: Nixpacks (Railpack) — `nixpacks.toml` 에서 Node 20 고정
- **Build Command**: `npm ci` (or `npm install`)
- **Start Command**: `node index.js`
- **Healthcheck**: `/health`
- **Volume**: `/data` (SQLite `data.db` + `sessions.db` 영구 저장)
- **환경 변수**: `.env.example` 의 키 전부 Railway Variables 에서 설정
- **배포 방식**: `main` 브랜치 push → GitHub webhook → Railway 자동 빌드·재배포
- **커스텀 도메인**: Settings → Networking → Generate Domain 또는 Custom Domain

### Vercel (프론트, 향후 예정)

현재는 `server/StockRadar_v5.html` + `admin.html` 이 Express 같은 오리진에서 정적 서빙되어 Railway 단일 배포로 운영 중. **SPA 분리 후 Vercel 로 프론트 분리 배포**는 향후 과제.

분리 시 예상 구성:
- **루트**: Vercel 정적 자산 (HTML/CSS/JS bundle)
- **API**: `stockradar-server-production-394b.up.railway.app` 로 직접 호출
- **CORS**: Railway 측 `index.js` 에 Vercel 도메인 화이트리스트 추가 필요
- **세션 쿠키**: SameSite=None + Secure 로 교차 도메인 전송 허용 (현재는 `lax`)

### 주의사항

- **`SESSION_SECRET`** 미설정 시 프로덕션에서 `process.exit(1)` — Railway 에 반드시 설정.
- **`DATA_DIR=/data`** 설정 누락 시 재배포마다 DB·세션 초기화됨.
- **첫 배포 후** 반드시 `ADMIN_SEED_PASSWORD` 를 강한 값으로 바꾸고, 로그인 후 설정에서 바꾼 뒤 해당 env 를 제거해도 됨.

---

## 🗃 DB 마이그레이션

- **엔진**: SQLite (better-sqlite3)
- **현재 버전**: **v8**
- **방식**: `user_version` PRAGMA 기반 단순 버전 마이그레이션. `server/db.js` 의 `migrations` 배열 끝에 함수를 append 하면 서버 기동 시 한 번 실행됨.
- **상세 스키마**: [`docs/research/db-schema.md`](docs/research/db-schema.md) 참조 (12개 테이블 · 컬럼 · FK · 버전별 이력)

### 다음 마이그레이션은 반드시 v9

```js
// server/db.js migrations 배열 끝에 추가
const migrations = [
  (db) => { /* v1 */ },
  (db) => { /* v2 */ },
  // … v3 ~ v8 …
  (db) => { // v9 — 새 기능 테이블 / 컬럼 추가
    db.exec(`
      CREATE TABLE IF NOT EXISTS my_new_table ( ... );
      -- 또는 ALTER TABLE users ADD COLUMN my_col INTEGER NOT NULL DEFAULT 0;
    `);
    // 필요하면 같은 블록 안에서 백필 UPDATE 실행
  },
];
```

### 체크리스트 (v9 추가 시)

1. **SQLite 제약 인지** — `DROP COLUMN`, 컬럼 rename, 타입 변경은 제한적. 신규 컬럼은 `ALTER TABLE ADD COLUMN` 만 지원.
2. **`NOT NULL` + `DEFAULT` 필수** — 기존 로우가 있으면 NOT NULL 만으로 추가 불가, 기본값 함께 선언하거나 nullable 로 추가 후 백필.
3. **트랜잭션 중복 금지** — `runMigrations()` 가 이미 `db.transaction()` 으로 감싸므로 마이그레이션 함수 안에서 별도 트랜잭션 열지 말 것.
4. **`CREATE INDEX IF NOT EXISTS`** — 항상 idempotent 하게.
5. **FK `ON DELETE` 정책 결정** — 유저 탈퇴 시 cascade 할지 set null 할지 명시.
6. **`middleware.js attachUser`** 의 SELECT 컬럼에 users 새 컬럼을 추가해야 `req.user` 에 hydrate 됨.
7. **문서 동기화** — `docs/research/db-schema.md` 의 테이블 목록 + 마이그레이션 이력 + 주의사항에 v9 내용 추가.
8. **로컬 smoke test** — 기존 `data.db` 가 있는 상태와 없는 상태 양쪽에서 서버가 정상 기동하는지 확인.
9. **롤백 불가** — down migration 미지원. 배포 직전 반드시 스키마 diff 확인.

---

## 📚 문서 위치

프로젝트 문서는 `docs/` 폴더에 모여 있습니다. 새 기능 작업 시 아래 순서로 읽어주세요.

| 파일 | 내용 |
|---|---|
| [`docs/CLAUDE.md`](docs/CLAUDE.md) | 파일 역할 맵 · 절대 규칙 · Claude Code 가 먼저 볼 요약 |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | 질문할 것 vs 바로 진행할 것 · 완료 보고 형식 · `/check` 명령 |
| [`docs/MEMORY.md`](docs/MEMORY.md) | 🔴🟡🟢 기술 부채 · 의사결정 기록 · 완료 항목 아카이브 |
| [`docs/research/architecture.md`](docs/research/architecture.md) | 아키텍처 결정 사항 (스텁) |
| [`docs/research/db-schema.md`](docs/research/db-schema.md) | 12개 테이블 · 컬럼 · FK · 마이그레이션 이력 |
| [`docs/research/api-specs.md`](docs/research/api-specs.md) | 전체 API 엔드포인트 · 외부 연동 · AI 호출 구조 · 미들웨어 체인 |

---

## 🔐 보안 체크리스트

- [x] 비밀번호 bcrypt 해시 (rounds 12)
- [x] 세션 쿠키 `httpOnly + secure(prod) + sameSite=lax + maxAge 30일`
- [x] helmet 보안 헤더 (⚠️ CSP 는 인라인 스크립트 호환 위해 off — SPA 분리 후 재활성)
- [x] express-rate-limit (로그인 15분당 20회 · 가입 1시간당 10회)
- [x] zod 입력 검증 (signup·login·admin patch·article·inquiry 등)
- [x] 감사 로그 (`audit_logs` 테이블)
- [x] 관리자 본인 권한 강등/차단 방지 · 마지막 어드민 hard-delete 차단
- [x] 민감 경로 차단 (`.env` · `.db` · `.js` · `node_modules/` 등 404 처리)
- [x] 전역 에러 캐치 (`unhandledRejection` · `uncaughtException` → DB 기록)
- [x] `SESSION_SECRET` 미설정 시 프로덕션 fatal exit
- [ ] 배포 전 `ADMIN_SEED_PASSWORD` 변경
- [ ] 배포 전 `SESSION_SECRET` 설정
- [ ] 배포 전 Resend 도메인 인증 (커스텀 발신 주소 사용 시)

---

## 📋 API 엔드포인트 (요약)

전체 엔드포인트 명세는 [`docs/research/api-specs.md`](docs/research/api-specs.md) 참고.

### 공개
- `GET /health` · `GET /api/status` · `GET /api/menus`
- 시세: `/api/quote/:sym` · `/api/quotes?symbols=` · `/api/chart/:sym` · `/api/indices` · `/api/universe` · `/api/period-changes`
- 재무: `/api/profile/:sym` · `/api/financials/:sym`
- 뉴스: `/api/news` · `/api/news/multi` · `/api/news/trending`
- AI: `/api/ai-analysis` · `/api/ai-chat` · `/api/ai-sector` (로그인 필수)
- 이벤트·공지·글·문의: `/api/events` · `/api/notices/active` · `/api/articles` · `/api/inquiries`

### 인증 — `/api/auth/*`
- `signup` · `login` · `logout` · `me` · `complete-signup`
- `request-password-reset` · `reset-password`
- `migrate-local` · `favorites` · `keywords`
- `google` · `google/callback`

### 어드민 — `/api/admin/*` (requireAdmin)
- `stats` · `analytics` · `users` · `menus` · `logs`
- `ai-usage` · `costs` · `service-status`
- `errors` · `notices` · `articles` · `inquiries`
- `change-email` · `change-password`

---

## 🧪 테스트 계정 (로컬)

| 역할 | 이메일 | 비번 |
|---|---|---|
| Admin | `.env` 의 `ADMIN_SEED_EMAIL` | `.env` 의 `ADMIN_SEED_PASSWORD` |
| User | (가입 시 본인이 설정) | — |

배포 환경에선 Railway Variables 에 설정한 값으로 자동 시드됨.
