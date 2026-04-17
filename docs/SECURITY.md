# StockRadar — 보안 · 개인정보 · 결제 규칙

> 보안/결제/개인정보 관련 작업 전 필수 확인.

---

## 환경변수 / 키 관리

- **절대 금지**: API Key · Gemini/FMP/Yahoo 키 코드 하드코딩
- **템플릿**: `server/.env.example` 에 키 이름만 기록
- **실제 값**: `server/.env` (gitignore) — Railway 대시보드에서도 동일 키 세팅
- **노출 방지**: 프론트 번들에 백엔드 키 포함되지 않도록 주의 (Vercel env prefix 없음)

---

## 인증

- **세션**: 현재 `express-session` + `connect-sqlite3` → Redis 세션 또는 JWT 전환 예정 (`MEMORY.md`)
- **패스워드**: bcrypt 해싱 (회원가입 시 `auth.js`)
- **Google OAuth**: redirect URI 화이트리스트 확인
- **어드민 보호**: `requireAdmin` 미들웨어 — user.is_admin=1 체크

---

## 개인정보

- **수집 최소화**: 이메일만 필수. 이름/전화번호 선택
- **투자 정보**: `user_keywords`, `user_favorites`, `user_holdings` — 암호화 저장 검토 중 (`MEMORY.md`)
- **회원 탈퇴**: 미구현 — 개인정보보호법상 필수 (`MEMORY.md` 참조)

---

## 결제 (V2 예정)

- **카드정보**: 절대 자체 DB 저장 금지
- **PG**: 토스페이먼츠 또는 포트원 (결정 전 — `INSIGHTS.md`)
- **분리**: `payments.js` 별도 모듈로 준비

---

## AI 호출 보안

- **Gemini API 키**: 서버 환경변수만. 프론트 노출 금지
- **호출 경로**: `callGemini()` 공통 함수 경유 (admin.js 직접 호출은 기술부채)
- **사용량 제어**: rate limit + 사용자별 일일 한도 고려 (`MEMORY.md` 세분화 TODO)

---

## helmet / CSP

- **현재**: `contentSecurityPolicy: false` (인라인 스크립트 다수)
- **방향**: `StockRadar_v5.html` 모듈 분리 후 CSP nonce 방식으로 재활성
