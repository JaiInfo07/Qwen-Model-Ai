const crypto = require("crypto");

const OTP_LENGTH = 6;
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_RESENDS = 5;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return { valid: false, error: "Email is required." };
  if (email.length > 254) return { valid: false, error: "Email is too long." };
  if (/\s/.test(email)) return { valid: false, error: "Email cannot contain spaces." };

  const parts = email.split("@");
  if (parts.length !== 2) return { valid: false, error: "Enter a valid email address." };

  const [local, domain] = parts;
  if (!local || !domain || local.length > 64) {
    return { valid: false, error: "Enter a valid email address." };
  }
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return { valid: false, error: "Enter a valid email address." };
  }
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) {
    return { valid: false, error: "Enter a valid email address." };
  }
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return { valid: false, error: "Enter a valid email domain." };
  }

  const labels = domain.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    return { valid: false, error: "Enter a valid email domain." };
  }

  return { valid: true, value: email };
}

function validateUsername(value) {
  const username = String(value || "").trim();
  if (!username) return { valid: false, error: "Username is required." };
  if (username.length < 3 || username.length > 24) {
    return { valid: false, error: "Username must contain 3–24 characters." };
  }
  if (!/^[A-Za-z]/.test(username)) {
    return { valid: false, error: "Username must start with a letter." };
  }
  if (!/^[A-Za-z][A-Za-z0-9._]*$/.test(username)) {
    return { valid: false, error: "Use only letters, numbers, dots, and underscores." };
  }
  if (/[._]{2}/.test(username) || /[._]$/.test(username)) {
    return { valid: false, error: "Do not end with or repeat dots/underscores." };
  }
  return { valid: true, value: username, normalized: normalizeUsername(username) };
}

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789",
  "qwerty123", "admin123", "welcome1", "letmein123", "iloveyou",
]);

function validatePassword(value, context = {}) {
  const password = String(value || "");
  const errors = [];

  if (password.length < 8) errors.push("Use at least 8 characters.");
  if (Buffer.byteLength(password, "utf8") > 72) errors.push("Password must be 72 bytes or fewer.");
  if (!/[a-z]/.test(password)) errors.push("Add a lowercase letter.");
  if (!/[A-Z]/.test(password)) errors.push("Add an uppercase letter.");
  if (!/\d/.test(password)) errors.push("Add a number.");
  if (!/[^A-Za-z0-9]/.test(password)) errors.push("Add a special character.");
  if (/\s/.test(password)) errors.push("Do not use spaces.");

  const lowered = password.toLowerCase();
  const username = normalizeUsername(context.username);
  const emailLocal = normalizeEmail(context.email).split("@")[0] || "";
  if (username.length >= 3 && lowered.includes(username)) errors.push("Do not include your username.");
  if (emailLocal.length >= 3 && lowered.includes(emailLocal)) errors.push("Do not include your email name.");
  if (COMMON_PASSWORDS.has(lowered)) errors.push("Choose a less common password.");

  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  if (errors.length) score = Math.min(score, 2);

  return {
    valid: errors.length === 0,
    errors,
    score: Math.min(score, 5),
    label: score <= 1 ? "Weak" : score <= 3 ? "Fair" : score === 4 ? "Strong" : "Very strong",
  };
}

function generateOtp() {
  const max = 10 ** OTP_LENGTH;
  return crypto.randomInt(0, max).toString().padStart(OTP_LENGTH, "0");
}

function generateOtpSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function hashOtp(otp, salt, secret) {
  return crypto
    .createHmac("sha256", String(secret || "local-development-otp-secret"))
    .update(`${salt}:${String(otp)}`)
    .digest("hex");
}

function verifyOtp(otp, salt, expectedHash, secret) {
  if (!/^\d{6}$/.test(String(otp || ""))) return false;
  const actual = Buffer.from(hashOtp(otp, salt, secret), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function maskEmail(value) {
  const email = normalizeEmail(value);
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const visible = local.length <= 2 ? local.charAt(0) : local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

module.exports = {
  OTP_EXPIRY_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_MAX_RESENDS,
  normalizeEmail,
  normalizeUsername,
  validateEmail,
  validateUsername,
  validatePassword,
  generateOtp,
  generateOtpSalt,
  hashOtp,
  verifyOtp,
  maskEmail,
};
