# StockRadar

주식 스크리너 · 이슈 트래커 · 섹터 맵 · AI 분석 · 투자 가이드.
실시간 시세(Yahoo), 재무(FMP), AI 분석(Gemini), 뉴스(Google News), 이메일(Resend) 기반.

## 🏗️ 구조

```
StockRadar/
├── StockRadar_v5.html   사용자 페이지 (단일 파일 SPA)
├── admin.html           어드민 콘솔
├── railway.json         Railway 배포 설정
└── server/
    ├── index.js         Express 메인 — 시세·뉴스·AI·정적 HTML 서빙
    ├── db.js            SQLite 초기화·마이그레이션·시드
    ├── auth.js          /api/auth/* (signup·login·verify·reset)
    ├── admin.js         /api/admin/* (requireAdmin)
    ├── email.js         Resend 이메일 발송
    ├── middleware.js    attachUser·requireAuth·requireAdmin
    ├── package.json
    └── .env             (gitignore)
```

## 🖥️ 로컬 실행

### 1. 서버
```bash
cd server
npm install
node index.js
```

### 2. 브라우저
- **사용자 페이지**: http://localhost:3000/
- **어드민 콘솔**: http://localhost:3000/admin
- 헬스체크: http://localhost:3000/health
- API 상태: http://localhost:3000/api/status

### 3. 초기 어드민 계정
`server/.env` 의 `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` 로 최초 실행 시 자동 생성.
기본값: `admin@stockradar.local` / `changeme1234` — **로그인 후 설정에서 즉시 변경**.

## 🚀 Railway 배포

1. https://railway.app 가입 (GitHub 연동 권장)
2. 프로젝트 생성 → "Deploy from GitHub repo" 선택 → 이 레포 선택
3. **환경 변수 설정** (Variables 탭):
   | 키 | 값 |
   |---|---|
   | `NODE_ENV` | `production` |
   | `SESSION_SECRET` | 32자 이상 랜덤 문자열 (필수) |
   | `FMP_API_KEY` | FMP API 키 |
   | `GEMINI_API_KEY` | Gemini API 키 |
   | `RESEND_API_KEY` | Resend API 키 |
   | `EMAIL_FROM` | `onboarding@resend.dev` (or 본인 도메인) |
   | `ADMIN_SEED_EMAIL` | 본인 이메일 |
   | `ADMIN_SEED_PASSWORD` | 강한 비밀번호 |
   | `DATA_DIR` | `/data` (볼륨 마운트 경로) |
4. **영구 볼륨 추가** (Settings → Volumes):
   - Mount Path: `/data`
   - Size: 1GB (충분)
5. **배포 확인**: 생성된 `*.up.railway.app` URL 접속 → 로그인·가입 테스트
6. **(선택) 커스텀 도메인**: Settings → Networking → "Generate Domain" 또는 "Custom Domain"

## 🔐 보안 체크리스트

- [x] 비밀번호 bcrypt 해시 (rounds 12)
- [x] 세션 쿠키 `httpOnly + secure + sameSite=lax`
- [x] helmet 헤더
- [x] express-rate-limit (로그인 15분당 20회, 가입 1시간당 10회)
- [x] zod 입력 검증
- [x] 감사 로그 (`audit_logs` 테이블)
- [x] 관리자 본인 권한 변경 방지
- [x] 이메일 인증 필수 (status=pending → active)
- [ ] 배포 전 `ADMIN_SEED_PASSWORD` 변경
- [ ] 배포 전 `SESSION_SECRET` 설정
- [ ] 배포 전 Resend 도메인 인증 (커스텀 발신 주소 사용 시)

## 📋 API 엔드포인트

### 공개
- `GET /health` — 헬스체크
- `GET /api/status` — 외부 API 연결 상태
- `GET /api/menus` — LNB 메뉴 목록 (enabled + min_role 필터)
- 시세: `/api/quote/:sym`, `/api/quotes?symbols=`, `/api/chart/:sym`, `/api/indices`, `/api/universe`
- 재무: `/api/profile/:sym`, `/api/financials/:sym`
- 뉴스: `/api/news`, `/api/news/multi`, `/api/news/trending`
- AI: `/api/ai-analysis`, `/api/ai-chat`

### 인증 (`/api/auth/*`)
- `POST signup` — 회원가입 (pending 상태 생성 + 코드 메일)
- `POST verify-email` — 이메일 인증 코드 확인
- `POST resend-verification` — 코드 재발송
- `POST login` — 로그인
- `POST logout` — 로그아웃
- `GET me` — 현재 세션 유저
- `POST request-password-reset` — 비번 재설정 요청
- `POST reset-password` — 새 비번 설정
- `POST migrate-local` — 브라우저 데이터 이관
- `GET/PUT favorites` — 즐겨찾기
- `GET/PUT keywords` — 관심 키워드

### 어드민 (`/api/admin/*` — requireAdmin)
- `GET stats` — 대시보드 통계
- `GET users` — 회원 목록/검색/필터
- `PATCH users/:id` — 회원 수정 (역할·상태·닉네임)
- `DELETE users/:id` — 차단 (soft delete)
- `POST users/:id/reset-password` — 관리자 강제 비번 리셋
- `GET menus` / `PATCH menus/:key` — 메뉴 관리
- `GET logs` — 감사 로그
- `POST change-password` — 본인 비번 변경

## 🧪 테스트 계정 (로컬)

| 역할 | 이메일 | 비번 |
|---|---|---|
| Admin | `admin@stockradar.local` | `changeme1234` |
| User | (가입 시 본인이 설정) | — |

배포 환경에선 `.env` 에 설정한 값으로 자동 시드됨.
