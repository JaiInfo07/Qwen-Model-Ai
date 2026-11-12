const nodemailer = require("nodemailer");

const APP_NAME = process.env.APP_NAME || "Office AI Chat";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || SMTP_PORT === 465).toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const FROM_NAME = process.env.EMAIL_FROM_NAME || APP_NAME;
const FROM_EMAIL = process.env.EMAIL_FROM_ADDRESS || SMTP_USER;

let transporter = null;

function isSmtpConfigured() {
  return Boolean(SMTP_HOST && FROM_EMAIL && (!SMTP_USER || SMTP_PASS));
}

function getTransporter() {
  if (transporter) return transporter;
  if (!isSmtpConfigured()) return null;

  const options = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  };

  if (SMTP_USER) {
    options.auth = { user: SMTP_USER, pass: SMTP_PASS };
  }

  transporter = nodemailer.createTransport(options);
  return transporter;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildOtpEmail({ username, otp, expiresMinutes }) {
  const safeName = escapeHtml(username || "there");
  const safeOtp = escapeHtml(otp);
  const safeAppName = escapeHtml(APP_NAME);

  const subject = `${otp} is your ${APP_NAME} verification code`;
  const text = [
    `Hello ${username || "there"},`,
    "",
    `Use this verification code to finish creating your ${APP_NAME} account:`,
    otp,
    "",
    `This code expires in ${expiresMinutes} minutes and can be used only once.`,
    "If you did not request this account, you can safely ignore this email.",
    "",
    `${APP_NAME} Security Team`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#171717;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:32px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background:#111111;padding:22px 28px;color:#ffffff;font-size:19px;font-weight:700;letter-spacing:.2px;">${safeAppName}</td>
          </tr>
          <tr>
            <td style="padding:30px 28px 12px;">
              <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;">Verify your email</h1>
              <p style="margin:0 0 18px;color:#525252;font-size:15px;line-height:1.6;">Hello <strong>${safeName}</strong>, use the code below to finish creating your account.</p>
              <div style="margin:20px 0;padding:18px 16px;background:#f5f5f5;border:1px solid #e5e5e5;border-radius:12px;text-align:center;font-size:32px;line-height:1;font-weight:800;letter-spacing:8px;color:#111111;">${safeOtp}</div>
              <p style="margin:0;color:#525252;font-size:14px;line-height:1.6;">⏱️ This code expires in <strong>${expiresMinutes} minutes</strong> and can be used only once.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 30px;">
              <div style="border-top:1px solid #eeeeee;padding-top:18px;color:#737373;font-size:12.5px;line-height:1.6;">🔐 If you did not request this account, no action is needed. Never share this code with anyone.</div>
            </td>
          </tr>
        </table>
        <div style="max-width:560px;padding:14px 10px 0;color:#9ca3af;font-size:11.5px;line-height:1.5;text-align:center;">Automated security message from ${safeAppName}.</div>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

async function sendVerificationOtp({ to, username, otp, expiresMinutes = 5 }) {
  const message = buildOtpEmail({ username, otp, expiresMinutes });
  const smtp = getTransporter();

  if (!smtp) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMTP is not configured. Set SMTP_HOST and EMAIL_FROM_ADDRESS before enabling sign-up.");
    }
    console.log("\n============================================================");
    console.log(`[DEV EMAIL] ${APP_NAME} verification code for ${to}: ${otp}`);
    console.log(`Expires in ${expiresMinutes} minutes.`);
    console.log("============================================================\n");
    return { deliveryMode: "console" };
  }

  const info = await smtp.sendMail({
    from: { name: FROM_NAME, address: FROM_EMAIL },
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  return { deliveryMode: "email", messageId: info.messageId };
}

module.exports = {
  isSmtpConfigured,
  sendVerificationOtp,
  buildOtpEmail,
};
