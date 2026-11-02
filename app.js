'use strict';

require('dotenv').config();

const express = require('express');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const logger = require('./logger');
const ai = require('./ai');
const crm = require('./crm');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DEBOUNCE_MS = parseInt(process.env.MESSAGE_DEBOUNCE_MS || '3500', 10);
const SESSION_PATH = process.env.WWEBJS_SESSION_PATH || './.wwebjs_auth';
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map((n) => n.replace(/\D/g, ''))
  .filter(Boolean);

if (!process.env.ANTHROPIC_API_KEY) {
  logger.error('Falta ANTHROPIC_API_KEY en el .env');
  process.exit(1);
}
if (!crm.isConfigured()) {
  logger.warn('Google Sheets no está configurado: los leads NO se guardarán hasta completar el .env');
}

const state = {
  whatsapp: 'starting',
  startedAt: new Date().toISOString(),
  messagesProcessed: 0,
  lastMessageAt: null,
};

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------
const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'mone-gardens', dataPath: SESSION_PATH }),
  puppeteer: {
    headless: true,
    args: puppeteerArgs,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  },
});

client.on('qr', (qr) => {
  state.whatsapp = 'waiting_qr';
  logger.info('Escanea este código QR con WhatsApp (Dispositivos vinculados > Vincular un dispositivo):');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  state.whatsapp = 'authenticated';
  logger.info('WhatsApp autenticado; sesión guardada con LocalAuth');
});

client.on('auth_failure', (msg) => {
  state.whatsapp = 'auth_failure';
  logger.error(`Fallo de autenticación de WhatsApp: ${msg}. Borra ${SESSION_PATH} y vuelve a escanear el QR.`);
});

client.on('ready', () => {
  state.whatsapp = 'ready';
  logger.info(`WhatsApp listo. Sofía está atendiendo (${client.info?.wid?.user || 'número desconocido'})`);
});

client.on('change_state', (s) => logger.info(`Estado de WhatsApp: ${s}`));

client.on('disconnected', async (reason) => {
  state.whatsapp = 'disconnected';
  logger.error(`WhatsApp desconectado: ${reason}. Reiniciando el proceso...`);
  await shutdown(1);
});

// ---------------------------------------------------------------------------
// Procesamiento de mensajes: agrupa ráfagas y serializa por contacto
// ---------------------------------------------------------------------------
/** @type {Map<string, {texts: string[], timer: NodeJS.Timeout|null, chain: Promise<void>, msg: any, profileName: string, phone: string}>} */
const queues = new Map();

async function resolvePhone(msg) {
  try {
    const contact = await msg.getContact();
    const profileName = contact.pushname || contact.name || '';
    const number = (contact.number || '').replace(/\D/g, '');
    if (number) return { phone: number, profileName };
    return { phone: msg.from.split('@')[0].replace(/\D/g, ''), profileName };
  } catch (_) {
    return { phone: msg.from.split('@')[0].replace(/\D/g, ''), profileName: '' };
  }
}

async function processBatch(chatId) {
  const q = queues.get(chatId);
  if (!q || !q.texts.length) return;
  const text = q.texts.join('\n');
  q.texts = [];
  q.timer = null;
  const { msg, phone, profileName } = q;

  let chat;
  try {
    chat = await msg.getChat();
    await chat.sendStateTyping();
  } catch (_) {
    /* no crítico */
  }

  try {
    const started = Date.now();
    const reply = await ai.chat(phone, text, profileName);
    await client.sendMessage(chatId, reply);
    state.messagesProcessed++;
    state.lastMessageAt = new Date().toISOString();
    logger.info('Respuesta enviada', { phone, ms: Date.now() - started, in: text.slice(0, 200), out: reply.slice(0, 200) });
  } catch (err) {
    logger.error('Error procesando mensaje', { phone, error: err.message, stack: err.stack });
    try {
      await client.sendMessage(
        chatId,
        'Disculpa, tuve un inconveniente técnico. ¿Podrías escribirme nuevamente en un momento? 🙏'
      );
    } catch (_) {
      /* ignorar */
    }
  } finally {
    try {
      if (chat) await chat.clearState();
    } catch (_) {
      /* no crítico */
    }
  }
}

client.on('message', async (msg) => {
  try {
    if (msg.fromMe || msg.isStatus) return;
    const from = msg.from || '';
    if (from.endsWith('@g.us') || from.endsWith('@broadcast') || from.endsWith('@newsletter')) return;

    const { phone, profileName } = await resolvePhone(msg);
    if (ALLOWED_NUMBERS.length && !ALLOWED_NUMBERS.includes(phone)) return;

    let text = (msg.body || '').trim();
    if (msg.type !== 'chat' || !text) {
      if (['ptt', 'audio'].includes(msg.type)) {
        text = '[El cliente envió una nota de voz que no puedes escuchar. Pídele amablemente que escriba su mensaje.]';
      } else if (['image', 'video', 'document', 'sticker'].includes(msg.type)) {
        text = text
          ? `[El cliente envió un archivo (${msg.type}) con el texto:] ${text}`
          : `[El cliente envió un archivo (${msg.type}) sin texto. Pídele amablemente que te escriba su consulta.]`;
      } else {
        return;
      }
    }

    logger.info('Mensaje recibido', { phone, type: msg.type, text: text.slice(0, 200) });

    let q = queues.get(from);
    if (!q) {
      q = { texts: [], timer: null, chain: Promise.resolve(), msg, phone, profileName };
      queues.set(from, q);
    }
    q.texts.push(text);
    q.msg = msg;
    q.phone = phone;
    q.profileName = profileName;

    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(() => {
      q.chain = q.chain.then(() => processBatch(from)).catch(() => {});
    }, DEBOUNCE_MS);
  } catch (err) {
    logger.error('Error en handler de mensaje', { error: err.message, stack: err.stack });
  }
});

// ---------------------------------------------------------------------------
// Health-check HTTP
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

app.get('/health', async (req, res) => {
  const healthy = state.whatsapp === 'ready';
  const body = {
    status: healthy ? 'ok' : 'degraded',
    whatsapp: state.whatsapp,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: state.startedAt,
    messagesProcessed: state.messagesProcessed,
    lastMessageAt: state.lastMessageAt,
    ai: ai.stats(),
  };
  if (req.query.deep === '1') body.crm = await crm.healthCheck();
  res.status(healthy || state.whatsapp === 'waiting_qr' || state.whatsapp === 'starting' ? 200 : 503).json(body);
});

app.get('/', (_req, res) => res.json({ name: 'Moné Gardens - Sofía', status: state.whatsapp }));

const server = app.listen(PORT, () => logger.info(`Health-check escuchando en http://0.0.0.0:${PORT}/health`));

// ---------------------------------------------------------------------------
// Arranque y apagado limpio
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Cerrando servicio...');
  const force = setTimeout(() => process.exit(code), 10000);
  force.unref();
  try {
    server.close();
    await client.destroy();
  } catch (err) {
    logger.warn(`Error al cerrar: ${err.message}`);
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', { error: err?.message, stack: err?.stack }));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  shutdown(1);
});

if (crm.isConfigured()) {
  crm.getSheet().catch((err) => logger.error(`No se pudo conectar a Google Sheets: ${err.message}`));
}

logger.info('Iniciando WhatsApp...');
client.initialize().catch((err) => {
  logger.error('No se pudo iniciar WhatsApp', { error: err.message, stack: err.stack });
  shutdown(1);
});
