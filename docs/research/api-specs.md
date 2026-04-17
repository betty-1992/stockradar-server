# API 스펙

- **프레임워크**: Express 5 · CommonJS
- **마운트 구조**: `index.js` 가 루트에서 `/api/auth` → `authRouter`, `/api/admin` → `adminRouter` 를 attach, 나머지 비즈니스 라우트는 루트에 직접 등록.
- **인증 모드**:
  - **public** — 미들웨어 없음, `req.user` 가 있을 수도/없을 수도 있음 (핸들러 내부에서 분기)
  - **requireAuth** — `req.user` 필수, 없으면 401 `AUTH_REQUIRED`
  - **requireAdmin** — `req.user.role === 'admin'` 필수, 없으면 401/403
  - ⚠️ `adminRouter` 는 라우트 정의 직전에 `router.use(requireAdmin)` 한 번만 걸리므로 `/api/admin/*` 모든 엔드포인트가 자동으로 어드민 전용.

---

## 1. 전체 API 엔드포인트 목록

### 공통 · 시스템

| 메서드 | 경로 | 인증 | 역할 설명 |
|---|---|---|---|
| GET | `/` | public | 사용자 SPA `StockRadar_v5.html` 서빙 |
| GET | `/admin` | public | 어드민 콘솔 `admin.html` 서빙 (로그인 오버레이 내장) |
| GET | `/health` | public | 서버 헬스체크 (`{ok:true, time}`) |
| GET | `/api/status` | public | 외부 API 연결 상태 (FMP / Gemini 키 유무) |
| GET | `/api/menus` | public | LNB 메뉴 목록 (enabled + min_role 필터) |

### 시세 · 차트 · 지수

| 메서드 | 경로 | 인증 | 역할 설명 |
|---|---|---|---|
| GET | `/api/quote/:symbol` | public | 단일 종목 Yahoo 시세 + 캔들 상위값 |
| GET | `/api/quotes?symbols=` | public | 복수 종목 시세 배치 조회 |
| GET | `/api/universe` | public | Yahoo 스크리너 predefined (day_gainers 등) |
| GET | `/api/indices` | public | KOSPI/KOSDAQ/NASDAQ/S&P500/WTI/환율 |
| GET | `/api/chart/:symbol?range=&interval=` | public | Yahoo chart candles |
| GET | `/api/period-changes?symbols=&range=` | public | 기간별(오늘/1주/1월) 수익률 배치 (섹터맵 기간 드롭다운용) |

### 재무 · 프로필

| 메서드 | 경로 | 인증 | 역할 설명 |
|---|---|---|---|
| GET | `/api/profile/:symbol` | public | FMP profile + ratios-ttm + key-metrics-ttm + quote 통합 |
| GET | `/api/financials/:symbol` | public | FMP 재무제표 (income statement) |

### 뉴스

| 메서드 | 경로 | 인증 | 역할 설명 |
|---|---|---|---|
| GET | `/api/news` | public | 단일 키워드 뉴스 (Google News RSS) |
| GET | `/api/news/multi` | public | 복수 키워드 병렬 조회 |
| GET | `/api/news/trending` | public | 최근 뜨는 키워드 추출 (RSS 집계) |

### AI 생성

| 메서드 | 경로 | 인증 | 역할 설명 |
|---|---|---|---|
| POST | `/api/ai-analysis` | requireAuth¹ | 종목 상세 AI 분석 (현재가·PER·ROE → 한 줄 총평) |
| POST | `/api/ai-chat` | requireAuth¹ | 스톡이 자유 질문 채팅 (history·context 전달) |
| POST | `/api/ai-sector` | requireAuth¹ | 섹터/토픽 브리핑 (등락 원인·전망·가치 평가) |

¹ public 라우트지만 핸들러 첫 줄에서 `if (!req.user) return 401` 수동 검사.

### 사용자 행동 · 공개 수집

| 메서드 | 경로 | 인증 | 역할 설명 |
|---|---|---|---|
| POST | `/api/events` | public | 클라이언트 이벤트 수집 (search/page_view/filter/chip_click/detail_open) |
| GET | `/api/notices/active` | public | 상단 배너용 활성 공지 목록 |
| GET | `/api/articles` | public | 발행된 가이드 글 목록 |
| GET | `/api/articles/:slug` | public | 발행된 가이드 글 단건 |

### 고객 문의

| 메서드 | 경로 | 인증 | 역할 설명 |
|---|---|---|---|
| POST | `/api/inquiries` | public² | 문의 접수 (비로그인은 email 필수) |
| GET | `/api/inquiries/mine` | requireAuth¹ | 내 문의 이력 조회 |

² `/api/inquiries` POST 는 public 이지만 `req.user` 있으면 user_id 로 기록, 없으면 body.email 필수 검증.

---

### 인증 — `/api/auth/*` (auth.js)

| 메서드 | 경로 | 인증 | 역할 설명 |
|---|---|---|---|
| POST | `/api/auth/signup` | public | 이메일 가입 (즉시 active, 자동 로그인) — `signupLimiter` |
| POST | `/api/auth/verify-email` | public | 이메일 인증 코드 확인 — `loginLimiter` · 현재 유휴 |
| POST | `/api/auth/resend-verification` | public | 인증 코드 재발송 — `resendLimiter` · 현재 유휴 |
| POST | `/api/auth/request-password-reset` | public | 비번 재설정 메일 요청 — `resendLimiter` |
| POST | `/api/auth/reset-password` | public | 비번 재설정 — `loginLimiter` |
| POST | `/api/auth/login` | public | 이메일 로그인 — `loginLimiter` |
| POST | `/api/auth/logout` | public | 세션 destroy + 쿠키 clear |
| GET | `/api/auth/me` | public | 현재 세션 유저 (`publicUser` 포맷) 또는 null |
| POST | `/api/auth/migrate-local` | requireAuth | 비로그인 시절 localStorage 즐겨찾기·키워드 서버 이관 |
| GET | `/api/auth/favorites` | requireAuth | 내 즐겨찾기 |
| PUT | `/api/auth/favorites` | requireAuth | 즐겨찾기 전체 치환 |
| GET | `/api/auth/keywords` | requireAuth | 내 관심 키워드 |
| PUT | `/api/auth/keywords` | requireAuth | 키워드 전체 치환 |
| GET | `/api/auth/holdings` | requireAuth | 내 포트폴리오 보유 종목 목록 (updated_at DESC) |
| POST | `/api/auth/holdings` | requireAuth | 보유 종목 upsert `{stock_id, quantity, avg_price, memo}` — `ON CONFLICT(user_id, stock_id) DO UPDATE` |
| DELETE | `/api/auth/holdings/:stockId` | requireAuth | 개별 종목 삭제 (stockId 자동 대문자화) |
| POST | `/api/auth/complete-signup` | requireAuth | 소셜 가입 직후 닉네임·약관 동의 저장 |
| GET | `/api/auth/google` | public | Google OAuth 리디렉션 시작 (state 세션에 저장) |
| GET | `/api/auth/google/callback` | public | Google 코드 교환 + find-or-create + 세션 발급 |

**속도 제한기**
- `signupLimiter` — 1시간당 10회
- `loginLimiter` — 15분당 20회
- `resendLimiter` — 인증 코드 재발송용 (짧은 쿨다운)

---

### 어드민 — `/api/admin/*` (admin.js, 전부 **requireAdmin**)

| 메서드 | 경로 | 역할 설명 |
|---|---|---|
| GET | `/api/admin/stats` | 대시보드 통계 (users/pending/banned/todaySignups/providers 분포) |
| GET | `/api/admin/users` | 회원 목록 검색·필터 (q/status/role/provider + 페이지네이션) |
| PATCH | `/api/admin/users/:id` | 회원 수정 (role/status/nickname) — 자신 강등 방지 |
| POST | `/api/admin/users/:id/reset-password` | 관리자 강제 비번 리셋 (임시 비번 응답) |
| DELETE | `/api/admin/users/:id` | **soft ban** (status='banned') |
| POST | `/api/admin/users/:id/hard-delete` | 완전 삭제 — 마지막 어드민 보호, self-delete 금지 |
| GET | `/api/admin/menus` | LNB 메뉴 전체 |
| PATCH | `/api/admin/menus/:key` | 메뉴 label/order/enabled/min_role 수정 |
| GET | `/api/admin/logs` | 감사 로그 검색 (action 필터) |
| GET | `/api/admin/ai-usage?range=` | AI 사용량 집계 + byUser/byModel/recent + FX 환율 |
| GET | `/api/admin/costs` | 고정비 + AI 실측 + 월별 추이 (KRW 환산 포함) |
| GET | `/api/admin/errors` | 에러 로그 검색·필터 (level/source/resolved/q) |
| PATCH | `/api/admin/errors/:id` | 에러 해결/미해결 토글 |
| DELETE | `/api/admin/errors?before= or ?resolved=1` | 에러 일괄 삭제 |
| GET | `/api/admin/service-status` | 외부 API 연결 + 시스템 리소스 (업타임/메모리/PID) |
| GET | `/api/admin/notices` | 공지 목록 |
| POST | `/api/admin/notices` | 공지 생성 |
| PATCH | `/api/admin/notices/:id` | 공지 수정 |
| DELETE | `/api/admin/notices/:id` | 공지 삭제 |
| POST | `/api/admin/change-email` | 어드민 본인 이메일 변경 (현재 비번 확인) |
| GET | `/api/admin/analytics` | DAU/WAU/MAU + Top 종목·키워드·AI·이벤트 타입 |
| GET | `/api/admin/articles` | 가이드 글 목록 (draft·published·archived 전부) |
| POST | `/api/admin/articles` | 글 생성 (zod 검증) |
| PATCH | `/api/admin/articles/:id` | 글 수정 (published 시점 자동 기록) |
| DELETE | `/api/admin/articles/:id` | 글 삭제 |
| POST | `/api/admin/articles/draft` | **⚠️ Gemini 직접 호출** — AI 초안 생성 (slug 자동) |
| GET | `/api/admin/inquiries?status=` | 문의 목록 + 요약 카운트 |
| PATCH | `/api/admin/inquiries/:id` | 상태 전환 · 관리자 답변 저장 |
| POST | `/api/admin/change-password` | 어드민 본인 비번 변경 |

---

## 2. 외부 API 연동 목록

| 서비스 | 사용 목적 | 호출 위치 (파일 · 함수) | 환경변수 |
|---|---|---|---|
| **Yahoo Finance** (비공식 JSON) | 시세·차트·지수·Spark·Screener | `index.js` · `_probeYahoo()`, `/api/quote`, `/api/quotes`, `/api/chart`, `/api/universe`, `/api/indices`, `/api/period-changes` | 없음 (공개) |
| **Financial Modeling Prep (FMP)** | 회사 프로필·재무 지표·재무제표 | `index.js` · `fmpFetch()` (공통 래퍼), `/api/profile`, `/api/financials` | `FMP_API_KEY` |
| **Google News RSS** | 키워드 뉴스·트렌드 | `index.js` · `fetchGoogleNews()`, `/api/news*` | 없음 (공개 RSS) |
| **Google Gemini** (Generative AI) | 종목 분석·채팅·섹터 브리핑·가이드 초안 | `index.js` · `_geminiOnce()` / `callGemini()` (래퍼) · **`admin.js` · `/articles/draft` (직접 호출)** | `GOOGLE_API_KEY` 아님 → `GEMINI_API_KEY` |
| **Google OAuth 2.0** | 소셜 로그인 | `auth.js` · `/google` (auth URL 리디렉션), `/google/callback` (token + userinfo 교환) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_CALLBACK_BASE` |
| **Resend** | 이메일 발송 (인증 코드·비번 재설정) | `email.js` · `sendVerificationCode()`, `sendPasswordResetCode()` | `RESEND_API_KEY`, `EMAIL_FROM` |
| **Yahoo KRW=X** (환율) | USD → KRW 환산 (비용 관리) | `admin.js` · `getUsdKrwRate()` — 1h 캐시, env `USD_KRW_RATE` 오버라이드 가능, 실패 시 1400 fallback | `USD_KRW_RATE` (선택) |

### 기타 환경변수 (외부 서비스 아님)

| 키 | 용도 |
|---|---|
| `PORT` | 서버 포트 (기본 3000) |
| `NODE_ENV` | `production` 여부 — secure 쿠키·CORS 분기 |
| `SESSION_SECRET` | 세션 서명 키 — prod 에서 미설정 시 서버 fatal exit |
| `DATA_DIR` | SQLite + sessions.db 저장 경로 (Railway 볼륨 `/data`) |
| `DB_PATH` | DB 파일 경로 오버라이드 (선택) |
| `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD` | 최초 관리자 시드 |
| `RAILWAY_MONTHLY_USD`, `FMP_MONTHLY_USD`, `RESEND_MONTHLY_USD`, `GEMINI_FREE_CREDIT_USD` | 비용 관리 대시보드 고정비 항목 (선택) |

---

## 3. AI 호출 구조

### `callGemini()` — 정식 래퍼 (`index.js`)

**위치**: `index.js` · line ~1343 (`const callGemini = async (prompt) => { ... }`)

**모델 목록** (`GEMINI_MODELS`):
```
gemini-2.5-flash
gemini-2.5-flash-lite
gemini-2.0-flash
gemini-2.0-flash-lite
```

**폴백 로직**
1. 위 순서대로 모델을 순차 시도.
2. 모델당 **최대 2회** 재시도 (800ms 백오프).
3. **재시도 대상**: `status === 503 || 429 || 500 || 네트워크 오류`.
4. **블랙리스트**: `status === 404 || 400` 이면 해당 모델을 `_geminiBadModels` Set 에 등록 — **세션 동안 재호출 안 함**.
5. 모든 모델 실패 시 `lastErr` throw.

**반환**: `{ text, model, usage: { promptTokens, completionTokens, totalTokens } }`

**내부 실행**: `_geminiOnce(model, prompt, key)` — 실제 `fetch('https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=...')` 호출. 응답 JSON 의 `candidates[0].content.parts[0].text` 추출 + `usageMetadata` 파싱.

**사용처 (index.js)**
- `/api/ai-analysis` (line ~1456)
- `/api/ai-chat` (line ~1569)
- `/api/ai-sector` (line ~1646)

세 엔드포인트 모두 호출 후 `logAiUsage()` 로 토큰·비용·context 기록.

### ⚠️ 이중 관리 포인트 — `admin.js` 직접 호출

**위치**: `admin.js` · `POST /api/admin/articles/draft` 핸들러 (line ~804)

**구현**:
```js
const r = await fetchFn(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
  { method: 'POST', headers: ..., body: JSON.stringify({ contents, generationConfig }) }
);
```

**문제점**
- `callGemini()` 의 **모델 폴백 없음** — 2.5-flash 가 실패하면 즉시 에러.
- `_geminiOnce()` 의 재시도·블랙리스트 로직 미적용.
- usageMetadata 는 별도로 읽어 `logAiUsage({ endpoint: 'ai-article-draft', ... })` 에 기록 (이 부분은 동기화되어 있음).
- `maxOutputTokens: 3000` (callGemini 는 2048) — 이 엔드포인트만 긴 응답이 필요해서 다른 값 사용.

**해결 방향**: `callGemini()` 가 `maxOutputTokens` 를 파라미터로 받도록 확장하고 `admin.js` 에서 import 해서 재사용. MEMORY.md 의 🔴 높은 우선순위 항목으로 이미 등록됨.

---

## 4. 미들웨어 적용 구조

### 요청이 Express 체인을 따라 거치는 순서

```
[1] helmet({ contentSecurityPolicy:false, crossOriginEmbedderPolicy:false })
        │  보안 헤더 세팅 (X-Frame-Options, Strict-Transport-Security 등)
        │  ⚠️ CSP 끔 — StockRadar_v5.html 인라인 스크립트 호환
        ▼
[2] cors (개발 환경에서만)
        │  IS_PROD 면 skip, 개발 환경에서는 origin 반사 + credentials:true
        ▼
[3] express.json({ limit: '200kb' })
        │  JSON body 파싱, 200KB 초과 시 413
        ▼
[4] express-session + SQLiteStore
        │  - name: 'sr.sid'
        │  - store: connect-sqlite3 (`DATA_DIR/sessions.db`)
        │  - cookie.httpOnly true, secure IS_PROD, sameSite 'lax', maxAge 30일
        │  - rolling: true → 요청마다 만료 갱신
        │  - app.set('trust proxy', 1) 로 Railway 프록시 뒤 secure 쿠키 동작
        ▼
[5] attachUser (middleware.js)
        │  세션에 userId 있으면 users 테이블에서 SELECT → req.user 주입
        │  status !== 'active' 면 세션 destroy
        ▼
[6] 5xx 응답 자동 로깅 (index.js line 155)
        │  res.json 을 wrap → statusCode >= 500 이면 logError() 에 url/method/status/userId 기록
        ▼
[7] Router attach
        │  /api/auth/*  → authRouter (미들웨어 없음, 핸들러별로 requireAuth 걸림)
        │  /api/admin/* → adminRouter (router.use(requireAdmin) 일괄)
        ▼
[8] 루트 라우트들
        │  /api/menus, /health, /api/status, 시세/뉴스/AI 엔드포인트 …
        │  /, /admin  (정적 HTML 서빙)
        ▼
[9] 민감 경로 차단 미들웨어
        │  BLOCKED_PATH 정규식: /node_modules/, /.git/, .js/.json/.env/.db/.log/.toml 등
        │  매치되면 404 end
        ▼
[10] express.static(STATIC_ROOT, { index:false, extensions:['html'], dotfiles:'deny' })
        │  이미지·favicon 등 정적 자산
        ▼
[11] 전역 에러 핸들러 (err, req, res, next)
        │  logError + status (err.status || 500) + JSON 응답
```

### Process-level 안전장치 (라우트 외부)

```
process.on('unhandledRejection', r => logError({ source:'unhandledRejection', ... }))
process.on('uncaughtException',  e => logError({ source:'uncaughtException',  ... }))
```

두 이벤트 모두 DB 에 기록하고 console.error 출력 — Express 밖에서 터진 Promise 실패·동기 에러도 error_logs 로 수집됨.

### 인증 계층 요약

- **어떤 핸들러**도 `req.user` 를 **읽을 수 있음** (`attachUser` 가 모든 요청에 적용).
- **명시적 보호 필요 라우트**:
  - `requireAuth` — `auth.js` 의 migrate-local, favorites, keywords, holdings, complete-signup
  - `requireAdmin` — `admin.js` 전체 (`router.use(requireAdmin)`)
- **수동 검사**:
  - `POST /api/ai-analysis | ai-chat | ai-sector` — 핸들러 첫 줄에서 `if (!req.user) return 401`
  - `GET /api/inquiries/mine` — 동일
  - `POST /api/inquiries` — 로그인 여부와 무관하게 허용, 비로그인 시 `email` 필수

---

**STEP 4 완료**
