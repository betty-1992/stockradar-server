# StockRadar — Claude Code 작업 가이드

> 매 세션 시작 시 **이 파일만 먼저** 읽으세요.
> 파일 역할 상세 → `docs/ARCHITECTURE.md`
> 상세 DB/API/결정 기록 → `docs/` 아래 주제별

---

## 프로젝트 한 줄 요약

**StockRadar** — 한국+미국 주식 스크리너 SaaS (상용화 준비 중).
운영자: Betty (비개발자 솔로 파운더)

- 스택: Node.js(Express 5) / better-sqlite3 / Railway (풀스택 단일 배포, Vercel 프론트 분리는 향후 과제)
- GitHub: `betty-1992/stockradar-server`
- **배포 URL (production)**: https://stockradar-server-production-394b.up.railway.app — Railway 기본 도메인. 커스텀 도메인 미연결

---

## 핵심 원칙 (작업 시 반드시 준수)

### 🔴 절대 규칙
1. **`StockRadar_v5.html` (15k줄) 수정 전 반드시 변경 범위 보고 + 승인**
2. **`server/db.js` 수정 = 마이그레이션 버전 한 단계 증가** (현재 v11)
3. **환경변수 추가 시 `server/.env.example` 도 함께 업데이트**
4. **3개 이상 파일 변경 시 계획 먼저 보고 → 승인 후 진행**
5. **AI 호출은 `index.js` 의 `callGemini()` 함수 경유만** (admin.js 직접 호출 금지)
6. **GitHub push 금지** — Betty가 "push해줘"라고 할 때만
7. **확인 없이 진행** — 위 5가지 예외만 빼고 스스로 판단하여 진행

### 🟡 작업 원칙
- 보안/결제/개인정보 관련 → `docs/SECURITY.md` 먼저 읽기
- 기술부채·TODO → `docs/MEMORY.md` 확인
- 과거 결정 의문 → `docs/DECISIONS.md` 확인
- 불필요한 칭찬/감탄 금지, 보고는 보고서 형태로

---

## 문서 인덱스 — 언제 어떤 docs 파일을 읽나

| 파일 | 언제 |
|------|------|
| `docs/ARCHITECTURE.md` | 시스템 설계·파일 역할·스택 파악 |
| `docs/DATABASE.md` | DB 스키마·마이그레이션 (→ `docs/research/db-schema.md` 상세) |
| `docs/API.md` | API 엔드포인트·외부 API 의존성 (→ `docs/research/api-specs.md` 상세) |
| `docs/DECISIONS.md` | "왜 이렇게 결정했나" 과거 ADR |
| `docs/INSIGHTS.md` | V2 기능, 미결정 사안, 관찰/통찰 |
| `docs/MEMORY.md` | 현재 기술부채·TODO (자주 업데이트) |
| `docs/SECURITY.md` | 보안·개인정보·결제·AI 호출 보안 |
| `docs/WORKFLOW.md` | 로컬 실행·배포·점검 |
| `docs/research/` | 자유 리서치 노트 (architecture, db-schema, api-specs, audit 등) |

---

## 작업 시작 체크리스트

- [ ] `CLAUDE.md` (이 파일) 읽음
- [ ] `docs/MEMORY.md` 로 현재 기술부채·진행 상황 확인
- [ ] 관련 주제의 `docs/*.md` 필요 시 추가 로드
- [ ] 작업 후 `docs/MEMORY.md` 또는 `docs/DECISIONS.md` 업데이트 (필요 시)
