'use strict';

const fs = require('fs');
const path = require('path');

// node:sqlite es estable en la práctica pero Node lo marca como experimental:
// silenciamos solo ese aviso para no ensuciar los logs.
const originalEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === 'string' ? warning : warning && warning.message;
  if (msg && msg.includes('SQLite is an experimental feature')) return;
  return originalEmit.call(process, warning, ...args);
};
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'mone-gardens.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS leads (
    phone             TEXT PRIMARY KEY,
    chat_id           TEXT,
    nombre            TEXT DEFAULT '',
    profile_name      TEXT DEFAULT '',
    etapa             TEXT NOT NULL DEFAULT 'nuevo',
    calificacion      TEXT DEFAULT 'En proceso',
    temperatura       TEXT DEFAULT '',
    presupuesto       TEXT DEFAULT '',
    tipo_credito      TEXT DEFAULT '',
    fecha_visita      TEXT DEFAULT '',
    interes           TEXT DEFAULT '',
    notas             TEXT DEFAULT '',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    etapa_at          INTEGER NOT NULL,
    last_inbound_at   INTEGER,
    last_outbound_at  INTEGER,
    last_message      TEXT DEFAULT '',
    followups_sent    INTEGER NOT NULL DEFAULT 0,
    next_followup_at  INTEGER,
    reminder_sent     INTEGER NOT NULL DEFAULT 0,
    postvisit_alerted INTEGER NOT NULL DEFAULT 0,
    paused_until      INTEGER,
    sheet_etapa       TEXT,
    sheet_dirty       INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads(next_followup_at);
  CREATE INDEX IF NOT EXISTS idx_leads_etapa ON leads(etapa);

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone, id);

  CREATE TABLE IF NOT EXISTS etapa_historial (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL,
    desde      TEXT,
    hacia      TEXT NOT NULL,
    por        TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const LEAD_FIELDS = new Set([
  'chat_id', 'nombre', 'profile_name', 'etapa', 'calificacion', 'temperatura', 'presupuesto',
  'tipo_credito', 'fecha_visita', 'interes', 'notas', 'updated_at', 'etapa_at', 'last_inbound_at',
  'last_outbound_at', 'last_message', 'followups_sent', 'next_followup_at', 'reminder_sent',
  'postvisit_alerted', 'paused_until', 'sheet_etapa', 'sheet_dirty',
]);

const stmts = {
  get: db.prepare('SELECT * FROM leads WHERE phone = ?'),
  insert: db.prepare(
    'INSERT OR IGNORE INTO leads (phone, created_at, updated_at, etapa_at) VALUES (?, ?, ?, ?)'
  ),
  addMessage: db.prepare('INSERT INTO messages (phone, role, content, created_at) VALUES (?, ?, ?, ?)'),
  lastMessages: db.prepare(
    'SELECT role, content FROM (SELECT id, role, content FROM messages WHERE phone = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'
  ),
  addHistory: db.prepare(
    'INSERT INTO etapa_historial (phone, desde, hacia, por, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  dueFollowups: db.prepare(
    'SELECT * FROM leads WHERE next_followup_at IS NOT NULL AND next_followup_at <= ? ORDER BY next_followup_at LIMIT 20'
  ),
  byEtapa: db.prepare('SELECT * FROM leads WHERE etapa = ?'),
  funnel: db.prepare('SELECT etapa, COUNT(*) AS total FROM leads GROUP BY etapa'),
  dirty: db.prepare('SELECT * FROM leads WHERE sheet_dirty = 1 LIMIT 50'),
  paused: db.prepare('SELECT phone, paused_until FROM leads WHERE paused_until IS NOT NULL AND paused_until > ?'),
};

function getLead(phone) {
  return stmts.get.get(phone) || null;
}

function ensureLead(phone) {
  const now = Date.now();
  stmts.insert.run(phone, now, now, now);
  return getLead(phone);
}

function updateLead(phone, fields) {
  const keys = Object.keys(fields).filter((k) => LEAD_FIELDS.has(k));
  if (!keys.length) return getLead(phone);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (fields[k] === undefined ? null : fields[k]));
  db.prepare(`UPDATE leads SET ${sets} WHERE phone = ?`).run(...values, phone);
  return getLead(phone);
}

function addMessage(phone, role, content) {
  stmts.addMessage.run(phone, role, content, Date.now());
}

function lastMessages(phone, limit) {
  return stmts.lastMessages.all(phone, limit).map((r) => ({ role: r.role, content: r.content }));
}

function addEtapaHistory(phone, desde, hacia, por) {
  stmts.addHistory.run(phone, desde, hacia, por, Date.now());
}

module.exports = {
  db,
  getLead,
  ensureLead,
  updateLead,
  addMessage,
  lastMessages,
  addEtapaHistory,
  dueFollowups: (now) => stmts.dueFollowups.all(now),
  leadsByEtapa: (etapa) => stmts.byEtapa.all(etapa),
  funnelCounts: () => stmts.funnel.all(),
  reachedStages: () => db.prepare('SELECT phone, hacia AS etapa FROM etapa_historial UNION SELECT phone, etapa FROM leads').all(),
  dirtyLeads: () => stmts.dirty.all(),
  pausedLeads: (now) => stmts.paused.all(now),
};
