// ════════════════════════════════════════════════
//  Email — Resend 기반 발송 + 템플릿
// ════════════════════════════════════════════════
//  .env 에 RESEND_API_KEY / EMAIL_FROM 필요
//  API 키 없으면 dev 모드: 콘솔에 코드 출력 (메일 실제 발송 안 함)
// ════════════════════════════════════════════════

let resendClient = null;
function getClient() {
  if (resendClient) return resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  const { Resend } = require('resend');
  resendClient = new Resend(key);
  return resendClient;
}

const FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const BRAND = 'StockRadar';

// ─── 템플릿 ────────────────────────────────────
function codeEmail({ code, purposeKo, minutes = 10 }) {
  return `
<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif;color:#111827;">
  <div style="max-width:520px;margin:40px auto;padding:0 20px;">
    <div style="background:#fff;border-radius:20px;padding:36px 32px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 10px 30px rgba(16,24,40,.08)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:26px">
        <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:22px">📡</div>
        <div style="font-size:18px;font-weight:800;letter-spacing:-.3px;color:#111827">${BRAND}</div>
      </div>
      <div style="font-size:20px;font-weight:800;color:#111827;margin-bottom:10px;letter-spacing:-.4px">${purposeKo}</div>
      <div style="font-size:14px;line-height:1.6;color:#4b5563;margin-bottom:26px">
        아래 인증 코드를 <b style="color:#111827">${minutes}분 이내</b>에 입력해주세요.
        본인이 요청한 게 아니라면 이 메일은 무시하시면 됩니다.
      </div>
      <div style="background:linear-gradient(135deg,#eef2ff,#e0e7ff);border-radius:14px;padding:22px;text-align:center;margin-bottom:24px">
        <div style="font-size:12px;color:#4f46e5;font-weight:700;letter-spacing:2px;margin-bottom:8px">VERIFICATION CODE</div>
        <div style="font-family:'SF Mono',Menlo,monospace;font-size:36px;font-weight:900;letter-spacing:10px;color:#4f46e5">${code}</div>
      </div>
      <div style="font-size:12px;line-height:1.6;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:18px">
        이 메일은 ${BRAND} 에서 자동 발송되었습니다. 회신은 수신되지 않습니다.<br>
        문의: 고객센터 — 곧 연결됩니다
      </div>
    </div>
    <div style="text-align:center;font-size:11px;color:#9ca3af;margin-top:16px">© ${new Date().getFullYear()} ${BRAND}</div>
  </div>
</body>
</html>`;
}

// ─── 발송 함수 ────────────────────────────────
//  모든 send* 는 { ok:true, id } 또는 { ok:false, error } 반환
async function sendEmail({ to, subject, html }) {
  const client = getClient();
  if (!client) {
    // dev 폴백 — API 키 없으면 콘솔에 출력
    console.log(`\n[email:dev-fallback] → ${to}`);
    console.log(`  subject: ${subject}`);
    console.log(`  (RESEND_API_KEY 없음 · 실제 발송 안 됨)\n`);
    return { ok: true, id: 'dev-no-send', dev: true };
  }
  try {
    const res = await client.emails.send({ from: FROM, to, subject, html });
    if (res.error) {
      console.warn('[email] resend error:', res.error);
      return { ok: false, error: res.error.message || 'send_failed' };
    }
    return { ok: true, id: res.data?.id };
  } catch (e) {
    console.warn('[email] exception:', e.message);
    return { ok: false, error: e.message };
  }
}

async function sendVerificationCode(to, code) {
  return sendEmail({
    to,
    subject: `[StockRadar] 이메일 인증 코드: ${code}`,
    html: codeEmail({ code, purposeKo: '이메일 인증 코드' }),
  });
}

async function sendPasswordResetCode(to, code) {
  return sendEmail({
    to,
    subject: `[StockRadar] 비밀번호 재설정 코드: ${code}`,
    html: codeEmail({ code, purposeKo: '비밀번호 재설정 코드' }),
  });
}

// ─── 6자리 숫자 코드 생성 ──────────────────────
const crypto = require('crypto');
function generateCode() {
  // 000000~999999. 앞자리 0 유지 위해 padStart
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

module.exports = { sendVerificationCode, sendPasswordResetCode, generateCode };
