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
| 어드민 | `server/admin.js` | 글쓰기 draft, 사용량 로그 등 |

---

## 외부 API 의존성

| 서비스 | 용도 | 주의사항 |
|--------|------|---------|
| Yahoo Finance | KR 종목 수집 (비공식 quoteSummary) | cookies+crumb 세션 재사용 필수, 429 백오프 |
| FMP | US 종목 수집 (Starter 유료) | 무료 쿼터로는 대부분 402 |
| Gemini | AI 글쓰기/분석 | `callGemini()` 공통 함수 경유 |
| Resend | 이메일 발송 | `email.js` 에서 처리 |
