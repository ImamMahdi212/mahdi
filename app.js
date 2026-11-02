'use strict';

require('dotenv').config();

const express = require('express');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const logger = require('./logger');
const ai = require('./ai');
const crm = require('./crm');
const pipeline = require('./pipeline');
const store = require('./db');

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
  logger.warn('ADVISOR_NUMBERS vacío: ningún asesor recibirá avisos del embudo');
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
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'mone-gardens', dataPath: SESSION_PATH }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
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
  startAutomationsOnce();
});
client.on('change_state', (s) => logger.info(`Estado de WhatsApp: ${s}`));
client.on('disconnected', async (reason) => {
  state.whatsapp = 'disconnected';
  logger.error(`WhatsApp desconectado: ${reason}. Reiniciando el proceso...`);
  await shutdown(1);
});

// ---------------------------------------------------------------------------
// Envío (marcando los mensajes del bot para distinguirlos de los de un humano)
// ---------------------------------------------------------------------------
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
// Avisos a los asesores según el embudo
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
  if (!ADVISOR_NUMBERS.length || state.whatsapp !== 'ready') return;
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

const notify = (text) => notifyAdvisors(text).catch((err) => logger.error('Error notificando', { error: err.message }));

pipeline.events.on('etapa', ({ lead, desde, hacia, por }) => {
  if (por === 'asesor' || por === 'hoja') return; // el equipo ya sabe lo que hizo
  const card = pipeline.leadCard(lead);
  const n = lead.phone;
  switch (hacia) {
    case 'calificado':
      return notify(`🟡 *Lead calificado – Moné Gardens*\n\n${card}\n\nSofía lo está llevando a agendar la visita.`);
    case 'visita_agendada':
      return notify(
        `🔥 *Visita agendada – Moné Gardens*\n\n${card}\n\nConfírmale la hora y la ubicación. Luego: /etapa ${n} confirmada\n` +
          'Si le escribes desde el número del bot, Sofía se pausa sola en ese chat.'
      );
    case 'perdido':
      if (lead.calificacion === 'Calificado' || ['calificado', 'visita_agendada'].includes(desde)) {
        return notify(`⚠️ *Lead calificado se enfrió* (dijo que no le interesa)\n\n${card}\n\n¿Vale la pena una llamada de rescate?`);
      }
      return undefined;
    case 'descalificado':
      return NOTIFY_DISQUALIFIED ? notify(`⚪ *Lead descalificado*\n\n${card}`) : undefined;
    case 'sin_respuesta':
      if (lead.calificacion === 'Calificado') {
        return notify(`🧊 *Lead calificado sin respuesta* tras los seguimientos automáticos\n\n${card}\n\nPrueba con una llamada.`);
      }
      return undefined;
    default:
      return undefined;
  }
});

// Un aviso por cliente cada 30 minutos como máximo, para no saturar al asesor.
const lastInboundNotice = new Map();
pipeline.events.on('inbound_asesor', ({ lead, text }) => {
  const last = lastInboundNotice.get(lead.phone) || 0;
  if (Date.now() - last < 30 * 60 * 1000) return;
  lastInboundNotice.set(lead.phone, Date.now());
  notify(`📩 *${lead.nombre || '+' + lead.phone}* (${pipeline.label(lead.etapa)}) escribió:\n"${text.slice(0, 300)}"\n\nhttps://wa.me/${lead.phone}`);
});

pipeline.events.on('postvisita', ({ lead }) => {
  notify(
    `📋 *¿Cómo fue la visita?*\n\n${pipeline.leadCard(lead)}\n\nActualiza la etapa:\n` +
      `/etapa ${lead.phone} visito · /etapa ${lead.phone} perdido · /etapa ${lead.phone} calificado (no asistió)`
  );
});

// ---------------------------------------------------------------------------
// Comandos de asesores (mensajes enviados al número del bot)
// ---------------------------------------------------------------------------
const HELP = [
  '*Comandos Moné Gardens*',
  '/embudo · resumen del embudo y conversión',
  '/etapa <número> <etapa> · mueve un lead (nuevo, conversacion, calificado, agendada, confirmada, visito, negociacion, reserva, vendido, perdido, descalificado)',
  '/lead <número> · ficha del lead',
  '/lista <etapa> · leads en esa etapa',
  '/pausar <número> · Sofía deja de responder ese chat',
  '/activar <número> · Sofía vuelve a responder',
  '/pausados · chats pausados',
].join('\n');

async function handleAdvisorCommand(msg, text) {
  const [cmdRaw, arg1, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const phone = (arg1 || '').replace(/\D/g, '');
  const reply = (t) => botSend(msg.from, t);

  switch (cmd) {
    case '/embudo':
      return reply(pipeline.funnelText());
    case '/etapa': {
      const etapa = pipeline.resolveStage(rest.join(' '));
      if (!phone || !etapa) return reply('Uso: /etapa 5939XXXXXXXX visito');
      if (!store.getLead(phone)) return reply(`No encuentro el lead +${phone}.`);
      const { lead, changed } = pipeline.setEtapa(phone, etapa, 'asesor');
      return reply(changed ? `✅ +${phone} movido a *${pipeline.label(etapa)}*.\n\n${pipeline.leadCard(lead)}` : `+${phone} ya estaba en ${pipeline.label(etapa)}.`);
    }
    case '/lead': {
      const lead = phone && store.getLead(phone);
      if (!lead) return reply('Uso: /lead 5939XXXXXXXX');
      return reply(pipeline.leadCard(lead) + (pipeline.isPaused(phone) ? '\n⏸️ Sofía pausada en este chat' : ''));
    }
    case '/lista': {
      const etapa = pipeline.resolveStage([arg1, ...rest].join(' '));
      if (!etapa) return reply('Uso: /lista agendada');
      const leads = store.leadsByEtapa(etapa).slice(0, 30);
      if (!leads.length) return reply(`No hay leads en ${pipeline.label(etapa)}.`);
      return reply(
        `*${pipeline.label(etapa)}* (${leads.length})\n\n` +
          leads.map((l) => `• ${l.nombre || l.profile_name || 'Sin nombre'} · +${l.phone}${l.fecha_visita ? ` · ${l.fecha_visita}` : ''}`).join('\n')
      );
    }
    case '/pausar':
      if (!phone) return reply('Uso: /pausar 5939XXXXXXXX');
      pipeline.pause(phone, TAKEOVER_MS);
      cancelPendingBatch(phone);
      return reply(`⏸️ Sofía pausada con +${phone} hasta ${pipeline.fmtDateTime(Date.now() + TAKEOVER_MS)}.`);
    case '/activar':
      if (!phone) return reply('Uso: /activar 5939XXXXXXXX');
      pipeline.resume(phone);
      return reply(`▶️ Sofía vuelve a atender a +${phone}.`);
    case '/pausados': {
      const list = store.pausedLeads(Date.now());
      return reply(
        list.length
          ? `Chats pausados:\n${list.map((p) => `• +${p.phone} hasta ${pipeline.fmtDateTime(p.paused_until)}`).join('\n')}`
          : 'No hay chats pausados.'
      );
    }
    default:
      return reply(HELP);
  }
}

// ---------------------------------------------------------------------------
// Mensajes entrantes: agrupa ráfagas y serializa por contacto
// ---------------------------------------------------------------------------
/** @type {Map<string, {texts: string[], timer: NodeJS.Timeout|null, chain: Promise<void>, phone: string, msg: any}>} */
const queues = new Map();
const chatToPhone = new Map();

function cancelPendingBatch(phone) {
  for (const q of queues.values()) {
    if (q.phone === phone && q.timer) {
      clearTimeout(q.timer);
      q.timer = null;
      for (const t of q.texts) ai.recordExternalMessage(phone, 'user', t);
      q.texts = [];
    }
  }
}

async function resolvePhone(msg) {
  try {
    const contact = await msg.getContact();
    const profileName = contact.pushname || contact.name || '';
    const number = (contact.number || '').replace(/\D/g, '');
    return { phone: number || msg.from.split('@')[0].replace(/\D/g, ''), profileName };
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
  const { phone, msg } = q;

  if (pipeline.isPaused(phone)) {
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
    const reply = await ai.chat(phone, text);
    if (pipeline.isPaused(phone)) {
      logger.info('Respuesta descartada: un asesor tomó el chat', { phone });
      return;
    }
    await botSend(chatId, reply);
    pipeline.onOutbound(phone);
    state.messagesProcessed++;
    state.lastMessageAt = new Date().toISOString();
    logger.info('Respuesta enviada', {
      phone,
      etapa: store.getLead(phone).etapa,
      ms: Date.now() - started,
      in: text.slice(0, 200),
      out: reply.slice(0, 200),
    });
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

    // Los asesores nunca son atendidos por Sofía: solo envían comandos.
    if (ADVISOR_NUMBERS.includes(phone)) {
      const body = (msg.body || '').trim();
      if (body.startsWith('/')) await handleAdvisorCommand(msg, body);
      else await botSend(from, HELP);
      return;
    }
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

    chatToPhone.set(from, phone);
    const lead = pipeline.onInbound(phone, { chatId: from, profileName, text });
    logger.info('Mensaje recibido', { phone, etapa: lead.etapa, type: msg.type, text: text.slice(0, 200) });

    let q = queues.get(from);
    if (!q) {
      q = { texts: [], timer: null, chain: Promise.resolve(), phone, msg };
      queues.set(from, q);
    }
    q.texts.push(text);
    q.msg = msg;
    q.phone = phone;

    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(() => {
      q.chain = q.chain.then(() => processBatch(from)).catch(() => {});
    }, DEBOUNCE_MS);
  } catch (err) {
    logger.error('Error en handler de mensaje', { error: err.message, stack: err.stack });
  }
});

// Mensajes salientes que no envió el bot = un asesor escribiendo desde este número.
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
    if (!phone || ADVISOR_NUMBERS.includes(phone) || !store.getLead(phone)) return;

    pipeline.pause(phone, TAKEOVER_MS);
    cancelPendingBatch(phone);
    logger.info('Asesor escribió desde el número del bot; Sofía pausada', { phone });
    if (msg.body) ai.recordExternalMessage(phone, 'assistant', `[Mensaje del asesor humano] ${msg.body}`);
  } catch (err) {
    logger.error('Error en handler de message_create', { error: err.message, stack: err.stack });
  }
});

// ---------------------------------------------------------------------------
// Automatizaciones del embudo y sincronización con Google Sheets
// ---------------------------------------------------------------------------
const sheetSync = pipeline.startSheetSync();
let automations = null;

function startAutomationsOnce() {
  if (automations) return;
  automations = pipeline.startAutomations({
    generate: (phone, instruccion) => ai.generate(phone, instruccion),
    sendToLead: async (lead, text) => {
      if (state.whatsapp !== 'ready') throw new Error('WhatsApp no está listo');
      await botSend(lead.chat_id, text);
    },
  });
  logger.info('Automatizaciones del embudo activas (seguimientos, recordatorios y alertas)');
}

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
    pausedChats: store.pausedLeads(Date.now()).length,
    funnel: Object.fromEntries(pipeline.funnel().map((r) => [r.etapa, r.total])),
  };
  if (req.query.deep === '1') body.crm = await crm.healthCheck();
  res.status(healthy || ['waiting_qr', 'starting', 'authenticated'].includes(state.whatsapp) ? 200 : 503).json(body);
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
    await sheetSync.push();
    await client.destroy();
    store.db.close();
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

logger.info('Iniciando WhatsApp...');
client.initialize().catch((err) => {
  logger.error('No se pudo iniciar WhatsApp', { error: err.message, stack: err.stack });
  shutdown(1);
});
