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
const parseNumbers = (v) =>
  (v || '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean);
const ALLOWED_NUMBERS = parseNumbers(process.env.ALLOWED_NUMBERS);
const ADVISOR_NUMBERS = parseNumbers(process.env.ADVISOR_NUMBERS);
const NOTIFY_DISQUALIFIED = /^(1|true|si|sí|yes)$/i.test(process.env.NOTIFY_DISQUALIFIED || '');
const TAKEOVER_MS = parseFloat(process.env.HUMAN_TAKEOVER_HOURS || '12') * 3600 * 1000;

if (!process.env.ANTHROPIC_API_KEY) {
  logger.error('Falta ANTHROPIC_API_KEY en el .env');
  process.exit(1);
}
if (!ADVISOR_NUMBERS.length) {
  logger.warn('ADVISOR_NUMBERS vacío: ningún asesor recibirá avisos de leads calificados');
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
// Envío de mensajes del bot (para distinguirlos de los que escribe un humano)
// ---------------------------------------------------------------------------
/** chatId -> textos que el bot está por enviar (para reconocer su eco en message_create) */
const pendingBotEchoes = new Map();
const ECHO_WINDOW_MS = 2 * 60 * 1000;

function rememberBotMessage(chatId, text) {
  const list = (pendingBotEchoes.get(chatId) || []).filter((e) => Date.now() - e.at < ECHO_WINDOW_MS);
  list.push({ text: text.trim(), at: Date.now() });
  pendingBotEchoes.set(chatId, list);
}

function consumeBotEcho(chatId, text) {
  const list = pendingBotEchoes.get(chatId);
  if (!list) return false;
  const idx = list.findIndex((e) => e.text === (text || '').trim() && Date.now() - e.at < ECHO_WINDOW_MS);
  if (idx === -1) return false;
  list.splice(idx, 1);
  if (!list.length) pendingBotEchoes.delete(chatId);
  return true;
}

async function botSend(chatId, text) {
  rememberBotMessage(chatId, text);
  return client.sendMessage(chatId, text);
}

// ---------------------------------------------------------------------------
// Pausa del bot cuando un asesor toma la conversación
// ---------------------------------------------------------------------------
/** phone -> timestamp hasta el que el bot no responde */
const pausedUntil = new Map();
/** chatId <-> phone de los leads que han escrito */
const chatToPhone = new Map();
const phoneToChat = new Map();

function isPaused(phone) {
  const until = pausedUntil.get(phone);
  if (!until) return false;
  if (Date.now() > until) {
    pausedUntil.delete(phone);
    logger.info('Pausa de asesor expirada; Sofía retoma el chat', { phone });
    return false;
  }
  return true;
}

function pause(phone, ms, reason) {
  pausedUntil.set(phone, Date.now() + ms);
  const chatId = phoneToChat.get(phone);
  const q = chatId && queues.get(chatId);
  if (q && q.timer) {
    clearTimeout(q.timer);
    q.timer = null;
    q.texts = [];
  }
  logger.info('Sofía pausada en este chat', { phone, reason, horas: +(ms / 3600000).toFixed(1) });
}

function resume(phone) {
  pausedUntil.delete(phone);
  logger.info('Sofía reactivada en este chat', { phone });
}

function fmtUntil(ts) {
  return new Date(ts).toLocaleString('es-EC', { timeZone: process.env.TZ || 'America/Guayaquil', hour12: false });
}

// ---------------------------------------------------------------------------
// Avisos al asesor
// ---------------------------------------------------------------------------
const advisorChatIds = new Map();

async function advisorChatId(number) {
  if (advisorChatIds.has(number)) return advisorChatIds.get(number);
  const wid = await client.getNumberId(number);
  if (!wid) throw new Error(`El número de asesor ${number} no tiene WhatsApp`);
  advisorChatIds.set(number, wid._serialized);
  return wid._serialized;
}

async function notifyAdvisors(text) {
  await Promise.all(
    ADVISOR_NUMBERS.map(async (number) => {
      try {
        await botSend(await advisorChatId(number), text);
      } catch (err) {
        logger.error('No se pudo avisar al asesor', { asesor: number, error: err.message });
      }
    })
  );
}

ai.setLeadNotifier(async (lead) => {
  if (!ADVISOR_NUMBERS.length) return;
  const calificado = lead.estado === 'Calificado';
  if (!calificado && !NOTIFY_DISQUALIFIED) return;

  const titulo = calificado
    ? lead.action === 'updated'
      ? '🔄 *Lead actualizado – Moné Gardens*'
      : '🔥 *Nuevo lead calificado – Moné Gardens*'
    : '⚪ *Lead descalificado – Moné Gardens*';
  const lines = [
    titulo,
    '',
    `👤 ${lead.nombre || 'Sin nombre'}`,
    `📱 +${lead.telefono}  →  https://wa.me/${lead.telefono}`,
    `💰 ${[lead.presupuesto, lead.tipo_credito].filter(Boolean).join(' · ') || 'Sin dato'}`,
    `📅 Visita: ${lead.fecha_visita || 'Sin fecha'}`,
    `🏷️ ${lead.interes || '-'} · ${lead.estado}`,
  ];
  if (lead.notas) lines.push(`📝 ${lead.notas}`);
  if (lead.action === 'error') lines.push('', '⚠️ No se pudo guardar en Google Sheets; revisa los logs.');
  if (calificado) {
    lines.push(
      '',
      'Si le escribes desde el número del bot, Sofía se pausa sola en ese chat.',
      `Comandos (envíalos a este chat): /pausar ${lead.telefono} · /activar ${lead.telefono} · /estado`
    );
  }
  await notifyAdvisors(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Comandos de asesores (mensajes enviados al número del bot)
// ---------------------------------------------------------------------------
async function handleAdvisorCommand(msg, text) {
  const [cmd, arg] = text.trim().split(/\s+/);
  const phone = (arg || '').replace(/\D/g, '');
  const reply = (t) => botSend(msg.from, t);

  switch (cmd.toLowerCase()) {
    case '/pausar':
      if (!phone) return reply('Uso: /pausar 5939XXXXXXXX');
      pause(phone, TAKEOVER_MS, 'comando de asesor');
      return reply(`⏸️ Sofía pausada con +${phone} hasta ${fmtUntil(pausedUntil.get(phone))}.`);
    case '/activar':
      if (!phone) return reply('Uso: /activar 5939XXXXXXXX');
      resume(phone);
      return reply(`▶️ Sofía vuelve a atender a +${phone}.`);
    case '/estado': {
      const activos = [...pausedUntil.keys()].filter(isPaused);
      return reply(
        activos.length
          ? `Chats pausados:\n${activos.map((p) => `• +${p} hasta ${fmtUntil(pausedUntil.get(p))}`).join('\n')}`
          : 'No hay chats pausados. Sofía está atendiendo todos los chats.'
      );
    }
    default:
      return reply('Comandos: /pausar <número> · /activar <número> · /estado');
  }
}

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

function isPrivateChat(id) {
  return Boolean(id) && !id.endsWith('@g.us') && !id.endsWith('@broadcast') && !id.endsWith('@newsletter');
}

async function processBatch(chatId) {
  const q = queues.get(chatId);
  if (!q || !q.texts.length) return;
  const text = q.texts.join('\n');
  q.texts = [];
  q.timer = null;
  const { msg, phone, profileName } = q;

  if (isPaused(phone)) {
    ai.recordExternalMessage(phone, 'user', text);
    return;
  }

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
    if (isPaused(phone)) {
      // Un asesor tomó el chat mientras la IA pensaba: no enviar la respuesta.
      logger.info('Respuesta descartada: un asesor tomó el chat', { phone });
      return;
    }
    await botSend(chatId, reply);
    state.messagesProcessed++;
    state.lastMessageAt = new Date().toISOString();
    logger.info('Respuesta enviada', { phone, ms: Date.now() - started, in: text.slice(0, 200), out: reply.slice(0, 200) });
  } catch (err) {
    logger.error('Error procesando mensaje', { phone, error: err.message, stack: err.stack });
    try {
      await botSend(chatId, 'Disculpa, tuve un inconveniente técnico. ¿Podrías escribirme nuevamente en un momento? 🙏');
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
    if (!isPrivateChat(from)) return;

    const { phone, profileName } = await resolvePhone(msg);

    // Los asesores nunca son atendidos por Sofía: solo pueden enviar comandos.
    if (ADVISOR_NUMBERS.includes(phone)) {
      const body = (msg.body || '').trim();
      if (body.startsWith('/')) await handleAdvisorCommand(msg, body);
      return;
    }

    if (ALLOWED_NUMBERS.length && !ALLOWED_NUMBERS.includes(phone)) return;

    chatToPhone.set(from, phone);
    phoneToChat.set(phone, from);

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

    logger.info('Mensaje recibido', { phone, type: msg.type, text: text.slice(0, 200), pausado: isPaused(phone) });

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

// Mensajes salientes: si no los envió el bot, es un asesor escribiendo desde
// este número (teléfono o WhatsApp Web) y Sofía se pausa en ese chat.
client.on('message_create', async (msg) => {
  try {
    if (!msg.fromMe) return;
    const to = msg.to || '';
    if (!isPrivateChat(to)) return;
    if (consumeBotEcho(to, msg.body)) return;

    let phone = chatToPhone.get(to);
    if (!phone) {
      try {
        const contact = await client.getContactById(to);
        phone = (contact.number || '').replace(/\D/g, '');
      } catch (_) {
        phone = to.split('@')[0].replace(/\D/g, '');
      }
    }
    if (!phone || ADVISOR_NUMBERS.includes(phone)) return;

    pause(phone, TAKEOVER_MS, 'un asesor escribió desde el número del bot');
    if (msg.body) ai.recordExternalMessage(phone, 'assistant', `[Mensaje del asesor humano] ${msg.body}`);
  } catch (err) {
    logger.error('Error en handler de message_create', { error: err.message, stack: err.stack });
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
    advisors: ADVISOR_NUMBERS.length,
    pausedChats: [...pausedUntil.keys()].filter(isPaused).length,
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
