// server.js — Office AI Chat, v6.4
// Adds a rollback-safe AI provider switch: Ollama or AirLLM + Devstral.
// The existing UI, attachments, conversation storage, and text response protocol remain unchanged.

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const ExcelJS = require("exceljs");
const db = require("./db");
const {
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
} = require("./auth-utils");
const { isSmtpConfigured, sendVerificationOtp } = require("./email-service");
const {
  AIProviderError,
  checkAIHealth,
  generateChat,
  getAIConfig,
} = require("./ai-provider");

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3500);
const AI_CONFIG = getAIConfig();
const OTP_SECRET = process.env.OTP_SECRET || process.env.SESSION_SECRET || "local-development-otp-secret";
const configuredBcryptRounds = Number(process.env.BCRYPT_ROUNDS || 12);
const BCRYPT_ROUNDS = Number.isFinite(configuredBcryptRounds)
  ? Math.min(14, Math.max(10, configuredBcryptRounds))
  : 12;
const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_EXTRACTED_CHARS_PER_FILE = 30000;
const MAX_EXTRACTED_CHARS_TOTAL = 60000;
const UPLOAD_ROOT = path.join(__dirname, "uploads");
const TEMP_UPLOAD_DIR = path.join(UPLOAD_ROOT, "tmp");

fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log",
  ".js", ".jsx", ".ts", ".tsx", ".html", ".htm", ".css", ".scss", ".less",
  ".py", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".php",
  ".cfm", ".cfc", ".sql", ".xml", ".yaml", ".yml", ".sh", ".bat", ".ps1",
  ".ini", ".env", ".properties",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx"]);
const ALLOWED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS, ...DOCUMENT_EXTENSIONS]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TEMP_UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const extension = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`);
    },
  }),
  limits: {
    files: MAX_FILES,
    fileSize: MAX_FILE_SIZE,
    fields: 10,
    fieldSize: 100 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return cb(new Error(`Unsupported file type: ${extension || "unknown"}`));
    }
    cb(null, true);
  },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    store: new FileStore({ path: path.join(__dirname, "sessions") }),
    secret: process.env.SESSION_SECRET || "change-this-to-a-random-string-before-going-public",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);

// ---------- Basic in-memory rate limiting ----------
const requestLog = new Map();
const MAX_REQUESTS_PER_MINUTE = 6;

function isRateLimited(key, maxRequests = MAX_REQUESTS_PER_MINUTE, windowMs = 60 * 1000) {
  const now = Date.now();
  const timestamps = (requestLog.get(key) || []).filter((time) => now - time < windowMs);
  if (timestamps.length >= maxRequests) {
    requestLog.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  requestLog.set(key, timestamps);
  return false;
}

function getClientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

// ---------- Auth / validation helpers ----------
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  next();
}

function loadOwnedConversation(req, res) {
  const conversationId = parseInt(req.params.id || req.body.conversationId, 10);
  const convo = db.getConversationById(conversationId);
  if (!convo || convo.userId !== req.session.userId) {
    res.status(404).json({ error: "Conversation not found." });
    return null;
  }
  return convo;
}

function sanitizeMessagesForClient(messages) {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    attachments: (message.attachments || []).map((attachment) => ({
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      isImage: Boolean(attachment.isImage),
    })),
  }));
}

function cleanupFiles(files = []) {
  for (const file of files) {
    if (!file?.path) continue;
    try {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (error) {
      console.warn("Could not remove temporary upload:", error.message);
    }
  }
}

function trimExtractedText(text) {
  const normalized = String(text || "").replace(/\u0000/g, "").trim();
  if (normalized.length <= MAX_EXTRACTED_CHARS_PER_FILE) return normalized;
  return `${normalized.slice(0, MAX_EXTRACTED_CHARS_PER_FILE)}\n\n[Content truncated by the server.]`;
}

async function extractSpreadsheetText(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const lines = [];

  workbook.eachSheet((worksheet) => {
    lines.push(`Sheet: ${worksheet.name}`);
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values
        .slice(1)
        .map((value) => {
          if (value === null || value === undefined) return "";
          if (typeof value === "object") {
            if (Object.prototype.hasOwnProperty.call(value, "text")) return value.text;
            if (Object.prototype.hasOwnProperty.call(value, "result")) return value.result;
            return JSON.stringify(value);
          }
          return String(value);
        });
      lines.push(values.join("\t"));
    });
    lines.push("");
  });

  return lines.join("\n");
}

async function extractTextFromFile(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  const buffer = await fs.promises.readFile(file.path);

  if (TEXT_EXTENSIONS.has(extension)) {
    return trimExtractedText(buffer.toString("utf8"));
  }

  if (extension === ".pdf") {
    const parsed = await pdfParse(buffer);
    const text = trimExtractedText(parsed.text);
    if (!text) {
      throw new Error("No selectable text was found in this PDF. Scanned PDFs need OCR or page images.");
    }
    return text;
  }

  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return trimExtractedText(result.value);
  }

  if (extension === ".xlsx") {
    return trimExtractedText(await extractSpreadsheetText(buffer));
  }

  return "";
}

async function prepareAttachments(files) {
  const attachments = [];
  const extractedSections = [];
  const currentImages = [];
  let extractedTotal = 0;

  for (const file of files) {
    const extension = path.extname(file.originalname).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(extension);
    const metadata = {
      originalName: path.basename(file.originalname),
      storedName: file.filename,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.size,
      extension,
      isImage,
      savedPath: null,
      tempPath: file.path,
    };

    if (isImage) {
      currentImages.push((await fs.promises.readFile(file.path)).toString("base64"));
    } else {
      let extracted;
      try {
        extracted = await extractTextFromFile(file);
      } catch (error) {
        throw new Error(`${file.originalname}: ${error.message}`);
      }

      if (extracted) {
        const remaining = Math.max(0, MAX_EXTRACTED_CHARS_TOTAL - extractedTotal);
        if (remaining > 0) {
          const included = extracted.slice(0, remaining);
          extractedSections.push(`Attachment: ${metadata.originalName}\n---\n${included}`);
          extractedTotal += included.length;
        }
      }
    }

    attachments.push(metadata);
  }

  return { attachments, extractedSections, currentImages };
}

async function persistAttachments(attachments, userId, conversationId) {
  if (!attachments.length) return [];

  const finalDirectory = path.join(
    UPLOAD_ROOT,
    `user-${Number(userId)}`,
    `conversation-${Number(conversationId)}`
  );
  await fs.promises.mkdir(finalDirectory, { recursive: true });

  for (const attachment of attachments) {
    const finalPath = path.join(finalDirectory, attachment.storedName);
    await fs.promises.rename(attachment.tempPath, finalPath);
    attachment.savedPath = path.relative(__dirname, finalPath).split(path.sep).join("/");
    delete attachment.tempPath;
  }

  return attachments;
}

function imageBase64ForAttachment(attachment) {
  if (!attachment?.isImage || !attachment.savedPath) return null;
  const absolutePath = path.resolve(__dirname, attachment.savedPath);
  if (!absolutePath.startsWith(path.resolve(UPLOAD_ROOT))) return null;
  if (!fs.existsSync(absolutePath)) return null;
  try {
    return fs.readFileSync(absolutePath).toString("base64");
  } catch {
    return null;
  }
}

function toModelMessage(message) {
  const converted = {
    role: message.role,
    content: message.modelContent || message.content,
  };

  if (message.role === "user") {
    const images = (message.attachments || [])
      .map(imageBase64ForAttachment)
      .filter(Boolean);
    if (images.length) converted.images = images;
  }

  return converted;
}

function uploadMiddleware(req, res, next) {
  upload.array("files", MAX_FILES)(req, res, (error) => {
    if (!error) return next();
    cleanupFiles(req.files || []);

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "Each attachment must be 10 MB or smaller." });
      }
      if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ error: `You can attach up to ${MAX_FILES} files at a time.` });
      }
      return res.status(400).json({ error: error.message });
    }

    return res.status(400).json({ error: error.message || "The attachment could not be uploaded." });
  });
}

// ---------- Sign-up validation / availability ----------
app.post("/api/auth/check-availability", (req, res) => {
  if (isRateLimited(`availability:${getClientKey(req)}`, 30, 60 * 1000)) {
    return res.status(429).json({ error: "Too many validation checks. Please wait a minute." });
  }
  const response = {};
  const hasEmail = Object.prototype.hasOwnProperty.call(req.body || {}, "email");
  const hasUsername = Object.prototype.hasOwnProperty.call(req.body || {}, "username");

  if (!hasEmail && !hasUsername) {
    return res.status(400).json({ error: "Provide an email or username to check." });
  }

  if (hasEmail) {
    const result = validateEmail(req.body.email);
    response.email = result.valid
      ? { valid: true, available: !db.findUserByEmail(result.value) }
      : { valid: false, available: false, error: result.error };
  }

  if (hasUsername) {
    const result = validateUsername(req.body.username);
    response.username = result.valid
      ? { valid: true, available: !db.findUserByUsername(result.value) }
      : { valid: false, available: false, error: result.error };
  }

  return res.json(response);
});

function startUserSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.email = user.email || null;
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

// ---------- Sign-up: validate details, hash password, and send OTP ----------
app.post("/api/signup", async (req, res) => {
  const emailResult = validateEmail(req.body?.email);
  const usernameResult = validateUsername(req.body?.username);
  const passwordResult = validatePassword(req.body?.password, {
    username: req.body?.username,
    email: req.body?.email,
  });

  if (!emailResult.valid || !usernameResult.valid || !passwordResult.valid) {
    return res.status(400).json({
      error: "Please correct the highlighted sign-up fields.",
      fieldErrors: {
        email: emailResult.valid ? null : emailResult.error,
        username: usernameResult.valid ? null : usernameResult.error,
        password: passwordResult.valid ? null : passwordResult.errors,
      },
    });
  }

  const email = emailResult.value;
  const username = usernameResult.value;
  const usernameNormalized = usernameResult.normalized;
  const clientKey = getClientKey(req);

  if (isRateLimited(`signup-ip:${clientKey}`, 5, 15 * 60 * 1000)
      || isRateLimited(`signup-email:${email}`, 3, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many sign-up attempts. Please wait 15 minutes and try again." });
  }

  if (db.findUserByEmail(email)) {
    return res.status(409).json({ error: "An account already exists with this email.", field: "email" });
  }
  if (db.findUserByUsername(username)) {
    return res.status(409).json({ error: "That username is already taken.", field: "username" });
  }

  try {
    const passwordHash = await bcrypt.hash(String(req.body.password), BCRYPT_ROUNDS);
    if (req.session.pendingSignupId) {
      db.deletePendingSignup(req.session.pendingSignupId);
      delete req.session.pendingSignupId;
    }
    const otp = generateOtp();
    const otpSalt = generateOtpSalt();
    const now = Date.now();
    const pending = db.createPendingSignup({
      username,
      usernameNormalized,
      email,
      emailNormalized: normalizeEmail(email),
      passwordHash,
      otpHash: hashOtp(otp, otpSalt, OTP_SECRET),
      otpSalt,
      otpExpiresAt: new Date(now + OTP_EXPIRY_MS).toISOString(),
      lastSentAt: new Date(now).toISOString(),
    });

    let delivery;
    try {
      delivery = await sendVerificationOtp({
        to: email,
        username,
        otp,
        expiresMinutes: OTP_EXPIRY_MS / 60000,
      });
    } catch (emailError) {
      db.deletePendingSignup(pending.id);
      console.error("Verification email failed:", emailError.message);
      return res.status(502).json({ error: "We could not send the verification email. Check the SMTP settings and try again." });
    }

    req.session.pendingSignupId = pending.id;
    await new Promise((resolve, reject) => {
      req.session.save((sessionError) => (sessionError ? reject(sessionError) : resolve()));
    });

    return res.json({
      verificationRequired: true,
      maskedEmail: maskEmail(email),
      expiresInSeconds: Math.floor(OTP_EXPIRY_MS / 1000),
      resendAfterSeconds: Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
      deliveryMode: delivery.deliveryMode,
    });
  } catch (error) {
    console.error("Sign-up request failed:", error);
    return res.status(500).json({ error: "Sign-up could not be started. Please try again." });
  }
});

// ---------- Verify sign-up OTP and create the account ----------
app.post("/api/signup/verify-otp", async (req, res) => {
  const pendingId = req.session.pendingSignupId;
  const pending = pendingId ? db.getPendingSignupById(pendingId) : null;
  const otp = String(req.body?.otp || "").trim();

  if (!pending) {
    return res.status(404).json({ error: "No active sign-up was found. Please start again.", code: "SIGNUP_NOT_FOUND" });
  }
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: "Enter the 6-digit verification code." });
  }
  if (Number(pending.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    db.deletePendingSignup(pending.id);
    delete req.session.pendingSignupId;
    return res.status(429).json({ error: "Too many incorrect attempts. Please sign up again.", code: "OTP_ATTEMPTS_EXCEEDED" });
  }
  if (Date.now() > Date.parse(pending.otpExpiresAt)) {
    return res.status(410).json({ error: "This code has expired. Request a new code.", code: "OTP_EXPIRED" });
  }

  if (!verifyOtp(otp, pending.otpSalt, pending.otpHash, OTP_SECRET)) {
    const updated = db.incrementPendingSignupAttempts(pending.id);
    const remainingAttempts = Math.max(0, OTP_MAX_ATTEMPTS - Number(updated?.attempts || OTP_MAX_ATTEMPTS));
    if (remainingAttempts === 0) {
      db.deletePendingSignup(pending.id);
      delete req.session.pendingSignupId;
      return res.status(429).json({ error: "Too many incorrect attempts. Please sign up again.", code: "OTP_ATTEMPTS_EXCEEDED" });
    }
    return res.status(401).json({
      error: `Incorrect code. ${remainingAttempts} attempt${remainingAttempts === 1 ? "" : "s"} remaining.`,
      remainingAttempts,
    });
  }

  if (db.findUserByEmail(pending.email)) {
    db.deletePendingSignup(pending.id);
    delete req.session.pendingSignupId;
    return res.status(409).json({ error: "An account already exists with this email." });
  }
  if (db.findUserByUsername(pending.username)) {
    db.deletePendingSignup(pending.id);
    delete req.session.pendingSignupId;
    return res.status(409).json({ error: "That username is already taken." });
  }

  try {
    const user = db.createUser({
      username: pending.username,
      email: pending.email,
      passwordHash: pending.passwordHash,
      emailVerified: true,
    });
    db.deletePendingSignup(pending.id);
    await startUserSession(req, user);
    return res.json({ success: true, username: user.username, emailVerified: true });
  } catch (error) {
    console.error("OTP verification failed:", error);
    return res.status(500).json({ error: "Your account could not be created. Please try again." });
  }
});

// ---------- Resend sign-up OTP ----------
app.post("/api/signup/resend-otp", async (req, res) => {
  const pendingId = req.session.pendingSignupId;
  const pending = pendingId ? db.getPendingSignupById(pendingId) : null;

  if (!pending) {
    return res.status(404).json({ error: "No active sign-up was found. Please start again.", code: "SIGNUP_NOT_FOUND" });
  }
  if (db.findUserByEmail(pending.email) || db.findUserByUsername(pending.username)) {
    db.deletePendingSignup(pending.id);
    delete req.session.pendingSignupId;
    return res.status(409).json({ error: "This account has already been registered." });
  }
  if (Number(pending.resendCount || 0) >= OTP_MAX_RESENDS) {
    return res.status(429).json({ error: "The resend limit has been reached. Please sign up again." });
  }

  const elapsed = Date.now() - Date.parse(pending.lastSentAt);
  if (elapsed < OTP_RESEND_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({ error: `Please wait ${retryAfterSeconds} seconds before resending.`, retryAfterSeconds });
  }
  if (isRateLimited(`otp-resend-ip:${getClientKey(req)}`, 8, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many resend requests. Please try again later." });
  }

  const otp = generateOtp();
  const otpSalt = generateOtpSalt();
  const now = Date.now();

  try {
    const delivery = await sendVerificationOtp({
      to: pending.email,
      username: pending.username,
      otp,
      expiresMinutes: OTP_EXPIRY_MS / 60000,
    });
    db.updatePendingSignupOtp(pending.id, {
      otpHash: hashOtp(otp, otpSalt, OTP_SECRET),
      otpSalt,
      otpExpiresAt: new Date(now + OTP_EXPIRY_MS).toISOString(),
      lastSentAt: new Date(now).toISOString(),
    });

    return res.json({
      success: true,
      maskedEmail: maskEmail(pending.email),
      expiresInSeconds: Math.floor(OTP_EXPIRY_MS / 1000),
      resendAfterSeconds: Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
      deliveryMode: delivery.deliveryMode,
    });
  } catch (error) {
    console.error("OTP resend failed:", error.message);
    return res.status(502).json({ error: "We could not resend the verification email. Please try again." });
  }
});

// ---------- Login ----------
app.post("/api/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password) {
    return res.status(400).json({ error: "Enter your username and password." });
  }
  if (isRateLimited(`login:${getClientKey(req)}:${normalizeUsername(username)}`, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many login attempts. Please wait and try again." });
  }

  const user = db.findUserByUsername(username);
  if (!user) return res.status(401).json({ error: "Invalid username or password." });
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: "Invalid username or password." });

  try {
    await startUserSession(req, user);
    return res.json({ success: true, username: user.username });
  } catch (error) {
    console.error("Session creation failed:", error);
    return res.status(500).json({ error: "Login succeeded, but the session could not be created." });
  }
});

// ---------- Logout ----------
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// ---------- Who am I ----------
app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, username: req.session.username });
});

// ---------- Conversations ----------
app.get("/api/conversations", requireLogin, (req, res) => {
  res.json({ conversations: db.getConversationsForUser(req.session.userId) });
});

app.post("/api/conversations", requireLogin, (req, res) => {
  const convo = db.createConversation(req.session.userId, "New chat");
  res.json({ conversation: convo });
});

app.get("/api/conversations/:id/messages", requireLogin, (req, res) => {
  const convo = loadOwnedConversation(req, res);
  if (!convo) return;
  res.json({ messages: sanitizeMessagesForClient(db.getMessagesForConversation(convo.id)) });
});

app.delete("/api/conversations/:id", requireLogin, (req, res) => {
  const convo = loadOwnedConversation(req, res);
  if (!convo) return;
  db.deleteConversation(convo.id);
  res.json({ success: true });
});

// ---------- Sharing ----------
app.post("/api/conversations/:id/share", requireLogin, (req, res) => {
  const convo = loadOwnedConversation(req, res);
  if (!convo) return;
  const token = db.getOrCreateShareToken(convo.id);
  res.json({ shareUrl: `/shared/${token}` });
});

app.get("/api/shared/:token", (req, res) => {
  const convo = db.getConversationByShareToken(req.params.token);
  if (!convo) return res.status(404).json({ error: "This shared link is invalid or has expired." });
  res.json({
    title: convo.title,
    messages: sanitizeMessagesForClient(db.getMessagesForConversation(convo.id)),
  });
});

app.post("/api/shared/:token/import", requireLogin, (req, res) => {
  const convo = db.getConversationByShareToken(req.params.token);
  if (!convo) return res.status(404).json({ error: "This shared link is invalid or has expired." });
  const newConvo = db.copyConversationForUser(convo.id, req.session.userId);
  res.json({ conversation: newConvo });
});

app.get("/shared/:token", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Chat (multipart, streamed, stoppable) ----------
app.post(
  "/api/chat",
  requireLogin,
  (req, res, next) => {
    const rateLimitKey = `user_${req.session.userId}`;
    if (isRateLimited(rateLimitKey)) {
      return res.status(429).json({ error: "Too many requests. Please wait a bit and try again." });
    }
    next();
  },
  uploadMiddleware,
  async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";

    if ((!message && files.length === 0) || message.length > MAX_MESSAGE_LENGTH) {
      cleanupFiles(files);
      return res.status(400).json({ error: "Enter a message or attach a supported file." });
    }

    const convo = loadOwnedConversation(req, res);
    if (!convo) {
      cleanupFiles(files);
      return;
    }

    let prepared;
    try {
      prepared = await prepareAttachments(files);
    } catch (error) {
      cleanupFiles(files);
      return res.status(400).json({ error: error.message });
    }

    const displayMessage = message || "Please analyze the attached file(s).";
    const modelContent = prepared.extractedSections.length
      ? `${displayMessage}\n\nThe following attachment content was extracted by the server:\n\n${prepared.extractedSections.join("\n\n")}`
      : displayMessage;

    const pastRows = db.getMessagesForConversation(convo.id).slice(-12);
    const systemMessage = {
      role: "system",
      content:
        "You are an office AI assistant. Format every non-trivial answer as clean, readable Markdown. " +
        "Use ## for main headings and ### for subheadings. When there are multiple items, use bullet points or a numbered list instead of a dense paragraph. " +
        "Bold key labels, important values, decisions, warnings, dates, amounts, and statuses. Keep paragraphs short and easy to scan. " +
        "Use at most one context-appropriate emoji in a major heading or callout when it improves clarity; do not decorate every line or overuse emojis. " +
        "For a request such as 'shortly' or 'briefly', stay concise and use only the sections or bullets that are genuinely useful. Never output raw HTML. " +
        "When your answer includes code, always wrap it in Markdown triple-backtick code blocks with the language name. " +
        "Use attached file content as source material when present. If an image is attached, inspect it carefully. " +
        "For plain conversational answers, do not use code blocks.",
    };

    const currentUserMessage = {
      role: "user",
      content: modelContent,
    };
    if (prepared.currentImages.length) currentUserMessage.images = prepared.currentImages;

    const messages = [systemMessage, ...pastRows.map(toModelMessage), currentUserMessage];
    const needsVision = messages.some((item) => Array.isArray(item.images) && item.images.length > 0);

    let clientGone = false;
    let responseStarted = false;
    let fullReply = "";
    const upstreamAbort = new AbortController();

    res.on("close", () => {
      if (!res.writableEnded) {
        clientGone = true;
        upstreamAbort.abort();
      }
    });

    const startTextResponse = (metadata = {}) => {
      if (responseStarted || clientGone) return;
      responseStarted = true;
      res.status(200);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-AI-Provider", metadata.provider || AI_CONFIG.provider);
      if (metadata.model) res.setHeader("X-AI-Model", metadata.model);
      if (metadata.mode) res.setHeader("X-AI-Response-Mode", metadata.mode);
      res.flushHeaders();
    };

    try {
      await generateChat({
        messages,
        needsVision,
        signal: upstreamAbort.signal,
        onReady: startTextResponse,
        onText: (piece) => {
          if (!piece || clientGone) return;
          fullReply += piece;
          res.write(piece);
        },
      });
    } catch (error) {
      cleanupFiles(files);

      if (clientGone || error?.name === "AbortError") return;

      console.error(`${error.provider || AI_CONFIG.provider} request failed:`, error.message);

      if (responseStarted) {
        if (!res.writableEnded) res.end();
        return;
      }

      const status = error instanceof AIProviderError ? error.status : 500;
      const publicMessage =
        error instanceof AIProviderError
          ? error.publicMessage
          : "The AI provider returned an unexpected error.";

      return res.status(status).json({ error: publicMessage });
    }

    if (clientGone) {
      cleanupFiles(files);
      return;
    }

    if (!responseStarted) startTextResponse({ provider: AI_CONFIG.provider, mode: "buffered" });

    let persistedAttachments = [];
    try {
      persistedAttachments = await persistAttachments(
        prepared.attachments,
        req.session.userId,
        convo.id
      );
    } catch (error) {
      console.error("Could not persist attachments:", error.message);
      cleanupFiles(files);
    }

    const isFirstMessage = pastRows.length === 0;
    db.addMessage(convo.id, "user", displayMessage, {
      modelContent,
      attachments: persistedAttachments,
    });
    db.addMessage(convo.id, "assistant", fullReply || "(no response)");

    if (isFirstMessage) {
      const titleBase = message || prepared.attachments[0]?.originalName || "Attached file";
      const title = titleBase.length > 40 ? `${titleBase.slice(0, 40)}…` : titleBase;
      db.updateConversationTitle(convo.id, title);
    }

    res.end();
  }
);

// ---------- Health check ----------
app.get("/api/health", async (_req, res) => {
  const ai = await checkAIHealth();
  res.json({
    server: "ok",
    aiProvider: ai.provider,
    generation: ai.generation,
    vision: ai.vision,
    textModel: ai.textModel,
    visionModel: ai.visionModel,
    visionFallback: ai.visionFallback,
    airllm: ai.airllm || null,
  });
});

app.listen(PORT, () => {
  console.log(`Office AI Chat (v6.4) running at http://localhost:${PORT}`);
  console.log(`AI provider: ${AI_CONFIG.provider}`);

  if (AI_CONFIG.provider === "airllm") {
    console.log(`AirLLM URL: ${AI_CONFIG.airllmUrl}`);
    console.log(`AirLLM model: ${AI_CONFIG.airllmModelLabel}`);
    console.log(`AirLLM max new tokens: ${AI_CONFIG.airllmMaxNewTokens}`);
    console.log(`Image fallback: ${AI_CONFIG.airllmVisionFallback}`);
  } else {
    console.log(`Text model: ${AI_CONFIG.ollamaModel}`);
  }

  console.log(`Vision model: ${AI_CONFIG.ollamaVisionModel}`);
  console.log(`Ollama URL: ${AI_CONFIG.ollamaUrl}`);
  console.log(`Verification email: ${isSmtpConfigured() ? "SMTP configured" : "development console mode"}`);
  if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
    console.warn("WARNING: SESSION_SECRET is not configured for production.");
  }
  if (process.env.NODE_ENV === "production" && !process.env.OTP_SECRET) {
    console.warn("WARNING: OTP_SECRET is not configured for production.");
  }
});
