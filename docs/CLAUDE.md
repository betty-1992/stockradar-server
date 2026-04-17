# StockRadar — Claude Code 핵심 가이드

## 프로젝트 개요
- 한국 주식 스크리너 SaaS (상용화 예정)
- 스택: Node.js(Express 5) / better-sqlite3 / Railway(백엔드) + Vercel(프론트)
- GitHub: betty-1992/stockradar-server

## 파일 역할 맵
| 파일 | 역할 |
|------|------|
| index.js | Express 메인, 시세/뉴스/AI API, callGemini 공통 함수 |
| auth.js | 회원가입·로그인·Google OAuth |
| admin.js | 어드민 API — ⚠️ Gemini 직접 호출 코드 포함 (이중 관리 주의) |
| db.js | SQLite 마이그레이션 v1~v10 + 헬퍼 함수 |
| middleware.js | attachUser / requireAuth / requireAdmin |
| email.js | Resend 이메일 발송 |
| etfs.js | KR/US ETF 마스터 데이터 |
| StockRadar_v5.html | 사용자 SPA (~15k줄) — 수정 시 반드시 사전 보고 |
| admin.html | 어드민 콘솔 |

## 절대 규칙
1. StockRadar_v5.html 수정 전 반드시 변경 범위 보고 후 승인받기
2. db.js 수정 = 마이그레이션 버전 v11로 증가 필수
3. 환경변수 추가 시 server/.env.example도 함께 업데이트
4. 3개 이상 파일 변경 시 계획 먼저 보고 → 승인 후 진행
5. AI 호출은 index.js의 callGemini() 함수를 통해서만 할 것 (admin.js 직접 호출 방식 금지)

## 상세 문서 위치
- 아키텍처 결정: docs/research/architecture.md
- DB 스키마: docs/research/db-schema.md
- API 스펙: docs/research/api-specs.md
- 기술 부채: docs/MEMORY.md
- 작업 방식: docs/WORKFLOW.md

## 로컬스토리지 키 목록 (sr_*)
| 키 | 타입 | 용도 |
|----|------|------|
| sr_wl | string[] | 즐겨찾기 종목 심볼 목록 |
| sr_kws | string[] | 관심 키워드 목록 |
| sr_pf | object[] | 포트폴리오 보유 종목 {stock_id, quantity, avg_price, memo, updated_at} |
| sr_theme | string | 테마 설정 (auto/light/dark) |
| sr_fs | string | 폰트 크기 설정 |
| sr_dashboard_layout | object[] | 대시보드 위젯 레이아웃 |
| sr_recent_viewed | string[] | 최근 본 종목 (최대 8개) |
| sr_alert | object | 알림 설정 |
| sr_refresh_min | number | 자동 새로고침 주기(분) |
| sr_lnb_collapsed | boolean | LNB 접힘 상태 |
| sr_batch_cache | object | 배치 데이터 캐시 |
| sr_last_refresh | number | 마지막 새로고침 timestamp |

## V2 예정 기능
| 기능 | 설명 |
|------|------|
| 포트폴리오 환율 통합 | KR/US 통화 환율 적용 통합 평가금액 |
| 거래 이력 | 매수/매도 히스토리 (transactions 테이블 v10) |
| 실현 손익 집계 | 매도 시 실현손익 계산 |
| 백테스트 | 스크리너 필터 조건으로 과거 수익률 시뮬레이션 |
| 매수 타이밍 알림 | 즐겨찾기 종목 52주 하락률+PEG 조건 이메일 알림 |
| 스크리너 필터 고도화 | PEG/ROIC/PSR/3Y CAGR/FCF/베타 필터 추가 |
