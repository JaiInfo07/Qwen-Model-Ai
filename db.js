// db.js — lightweight local JSON-file database (pure JavaScript, no compiler needed)
// Stores users, pending email verifications, conversations, messages, and attachment metadata.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_FILE = path.join(__dirname, "db.json");

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      users: [],
      pendingSignups: [],
      conversations: [],
      messages: [],
      nextUserId: 1,
      nextPendingSignupId: 1,
      nextConversationId: 1,
      nextMessageId: 1,
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }

  const data = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  data.users = data.users || [];
  data.pendingSignups = data.pendingSignups || [];
  data.conversations = data.conversations || [];
  data.messages = data.messages || [];
  data.nextUserId = data.nextUserId || 1;
  data.nextPendingSignupId = data.nextPendingSignupId || 1;
  data.nextConversationId = data.nextConversationId || 1;
  data.nextMessageId = data.nextMessageId || 1;

  // Backward-compatible migration for accounts created before email verification existed.
  data.users.forEach((user) => {
    user.usernameNormalized = user.usernameNormalized || normalizeUsername(user.username);
    if (user.email) user.emailNormalized = user.emailNormalized || normalizeEmail(user.email);
    if (typeof user.emailVerified !== "boolean") user.emailVerified = Boolean(user.email);
  });

  return data;
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ---------- Users ----------
function findUserByUsername(username) {
  const normalized = normalizeUsername(username);
  const data = loadDb();
  return data.users.find((u) => (u.usernameNormalized || normalizeUsername(u.username)) === normalized) || null;
}

function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const data = loadDb();
  return data.users.find((u) => (u.emailNormalized || normalizeEmail(u.email)) === normalized) || null;
}

function createUser({ username, email, passwordHash, emailVerified = true }) {
  const data = loadDb();
  const usernameNormalized = normalizeUsername(username);
  const emailNormalized = normalizeEmail(email);

  if (data.users.some((u) => (u.usernameNormalized || normalizeUsername(u.username)) === usernameNormalized)) {
    throw new Error("USERNAME_EXISTS");
  }
  if (emailNormalized && data.users.some((u) => (u.emailNormalized || normalizeEmail(u.email)) === emailNormalized)) {
    throw new Error("EMAIL_EXISTS");
  }

  const user = {
    id: data.nextUserId,
    username,
    usernameNormalized,
    email: email || null,
    emailNormalized: emailNormalized || null,
    emailVerified: Boolean(emailVerified),
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  data.nextUserId += 1;
  saveDb(data);
  return user;
}

// ---------- Pending sign-ups / OTP verification ----------
function cleanupOldPendingSignups(data, now = Date.now()) {
  const retentionMs = 24 * 60 * 60 * 1000;
  data.pendingSignups = data.pendingSignups.filter((item) => {
    const created = Date.parse(item.createdAt || 0);
    return Number.isFinite(created) && now - created < retentionMs;
  });
}

function createPendingSignup(record) {
  const data = loadDb();
  cleanupOldPendingSignups(data);

  const pending = {
    id: data.nextPendingSignupId,
    username: record.username,
    usernameNormalized: record.usernameNormalized,
    email: record.email,
    emailNormalized: record.emailNormalized,
    passwordHash: record.passwordHash,
    otpHash: record.otpHash,
    otpSalt: record.otpSalt,
    otpExpiresAt: record.otpExpiresAt,
    attempts: 0,
    resendCount: 0,
    lastSentAt: record.lastSentAt,
    createdAt: new Date().toISOString(),
  };

  data.pendingSignups.push(pending);
  data.nextPendingSignupId += 1;
  saveDb(data);
  return pending;
}

function getPendingSignupById(id) {
  const data = loadDb();
  return data.pendingSignups.find((item) => item.id === Number(id)) || null;
}

function incrementPendingSignupAttempts(id) {
  const data = loadDb();
  const pending = data.pendingSignups.find((item) => item.id === Number(id));
  if (!pending) return null;
  pending.attempts = Number(pending.attempts || 0) + 1;
  saveDb(data);
  return pending;
}

function updatePendingSignupOtp(id, values) {
  const data = loadDb();
  const pending = data.pendingSignups.find((item) => item.id === Number(id));
  if (!pending) return null;
  pending.otpHash = values.otpHash;
  pending.otpSalt = values.otpSalt;
  pending.otpExpiresAt = values.otpExpiresAt;
  pending.lastSentAt = values.lastSentAt;
  pending.attempts = 0;
  pending.resendCount = Number(pending.resendCount || 0) + 1;
  saveDb(data);
  return pending;
}

function deletePendingSignup(id) {
  const data = loadDb();
  const before = data.pendingSignups.length;
  data.pendingSignups = data.pendingSignups.filter((item) => item.id !== Number(id));
  if (data.pendingSignups.length !== before) saveDb(data);
}

// ---------- Conversations ----------
function createConversation(userId, title) {
  const data = loadDb();
  const convo = {
    id: data.nextConversationId,
    userId,
    title: title || "New chat",
    shareToken: null,
    createdAt: new Date().toISOString(),
  };
  data.conversations.push(convo);
  data.nextConversationId += 1;
  saveDb(data);
  return convo;
}

function getConversationsForUser(userId) {
  const data = loadDb();
  return data.conversations.filter((c) => c.userId === userId).sort((a, b) => b.id - a.id);
}

function getConversationById(conversationId) {
  const data = loadDb();
  return data.conversations.find((c) => c.id === conversationId) || null;
}

function updateConversationTitle(conversationId, title) {
  const data = loadDb();
  const convo = data.conversations.find((c) => c.id === conversationId);
  if (convo) {
    convo.title = title;
    saveDb(data);
  }
}

function deleteConversation(conversationId) {
  const data = loadDb();
  data.conversations = data.conversations.filter((c) => c.id !== conversationId);
  data.messages = data.messages.filter((m) => m.conversationId !== conversationId);
  saveDb(data);
}

function getOrCreateShareToken(conversationId) {
  const data = loadDb();
  const convo = data.conversations.find((c) => c.id === conversationId);
  if (!convo) return null;
  if (!convo.shareToken) {
    convo.shareToken = crypto.randomBytes(12).toString("hex");
    saveDb(data);
  }
  return convo.shareToken;
}

function getConversationByShareToken(token) {
  const data = loadDb();
  return data.conversations.find((c) => c.shareToken === token) || null;
}

// Copies a shared conversation into a new private conversation. Attachment files remain
// server-side and are referenced by the copied metadata, while modelContent preserves
// extracted document text for future follow-up questions.
function copyConversationForUser(sourceConversationId, newUserId) {
  const data = loadDb();
  const source = data.conversations.find((c) => c.id === sourceConversationId);
  if (!source) return null;

  const newConvo = {
    id: data.nextConversationId,
    userId: newUserId,
    title: source.title,
    shareToken: null,
    createdAt: new Date().toISOString(),
  };
  data.conversations.push(newConvo);
  data.nextConversationId += 1;

  const sourceMessages = data.messages
    .filter((m) => m.conversationId === sourceConversationId)
    .sort((a, b) => a.id - b.id);

  sourceMessages.forEach((m) => {
    data.messages.push({
      id: data.nextMessageId,
      conversationId: newConvo.id,
      role: m.role,
      content: m.content,
      modelContent: m.modelContent || m.content,
      attachments: Array.isArray(m.attachments) ? JSON.parse(JSON.stringify(m.attachments)) : [],
      createdAt: new Date().toISOString(),
    });
    data.nextMessageId += 1;
  });

  saveDb(data);
  return newConvo;
}

// ---------- Messages ----------
function getMessagesForConversation(conversationId) {
  const data = loadDb();
  return data.messages.filter((m) => m.conversationId === conversationId).sort((a, b) => a.id - b.id);
}

function addMessage(conversationId, role, content, options = {}) {
  const data = loadDb();
  const msg = {
    id: data.nextMessageId,
    conversationId,
    role,
    content,
    modelContent: options.modelContent || content,
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
    createdAt: new Date().toISOString(),
  };
  data.messages.push(msg);
  data.nextMessageId += 1;
  saveDb(data);
  return msg;
}

module.exports = {
  findUserByUsername,
  findUserByEmail,
  createUser,
  createPendingSignup,
  getPendingSignupById,
  incrementPendingSignupAttempts,
  updatePendingSignupOtp,
  deletePendingSignup,
  createConversation,
  getConversationsForUser,
  getConversationById,
  updateConversationTitle,
  deleteConversation,
  getOrCreateShareToken,
  getConversationByShareToken,
  copyConversationForUser,
  getMessagesForConversation,
  addMessage,
};
