'use strict';

const EventEmitter = require('events');
const store = require('./db');
const crm = require('./crm');
const logger = require('./logger');

const TZ = process.env.TZ || 'America/Guayaquil';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Definición del embudo de ventas
// ---------------------------------------------------------------------------
// owner: 'bot' = Sofía puede mover al lead entre estas etapas;
//        'asesor' = solo un asesor mueve al lead (comando /etapa o editando la hoja).
// seguimientos: horas de espera sin respuesta antes de cada seguimiento automático.
const STAGES = {
  nuevo: {
    orden: 1,
    label: '1. Nuevo',
    owner: 'bot',
    objetivo: 'Primer contacto: responde directo lo que preguntó y abre el descubrimiento con una pregunta.',
    seguimientos: [24, 48],
  },
  en_conversacion: {
    orden: 2,
    label: '2. En conversación',
    owner: 'bot',
    objetivo:
      'Descubrimiento: entiende para quién es la casa, si es para vivir o invertir, cómo financiaría y para cuándo; consigue su nombre. Conecta cada respuesta con un beneficio.',
    seguimientos: [24, 48],
  },
  calificado: {
    orden: 3,
    label: '3. Calificado',
    owner: 'bot',
    objetivo:
      'Ya es comprador con presupuesto o financiamiento: tu única meta es agendar la visita al proyecto ofreciendo dos opciones de fecha.',
    seguimientos: [24, 48, 96],
  },
  visita_agendada: {
    orden: 4,
    label: '4. Visita agendada',
    owner: 'bot',
    objetivo:
      'Tiene fecha tentativa de visita: refuerza su decisión, resuelve dudas y asegura que asista. Un asesor le confirmará la hora y la ubicación.',
    seguimientos: [],
  },
  visita_confirmada: {
    orden: 5,
    label: '5. Visita confirmada',
    owner: 'asesor',
    objetivo:
      'Su asesor ya confirmó la visita: responde dudas breves y motívalo a asistir. Cambios de fecha u hora los coordina su asesor.',
    seguimientos: [],
  },
  visito: {
    orden: 6,
    label: '6. Visitó',
    owner: 'asesor',
    objetivo:
      'Ya conoció el proyecto: pregunta qué fue lo que más le gustó y llévalo a conversar con su asesor sobre la reserva y el plan de pagos.',
    seguimientos: [],
  },
  negociacion: {
    orden: 7,
    label: '7. Negociación',
    owner: 'asesor',
    objetivo:
      'Está definiendo la compra con su asesor: responde con calidez y seguridad, no des condiciones comerciales y deriva todo lo de precios, reserva y pagos a su asesor.',
    seguimientos: [],
  },
  reserva: {
    orden: 8,
    label: '8. Reserva',
    owner: 'asesor',
    objetivo: 'Ya reservó su casa: felicítalo, responde dudas generales y deriva lo contractual a su asesor.',
    seguimientos: [],
  },
  vendido: {
    orden: 9,
    label: '9. Vendido',
    owner: 'asesor',
    objetivo:
      'Ya es propietario: atiéndelo con calidez, deriva temas de postventa a su asesor y, si la conversación lo permite, pregúntale si conoce a alguien que también busque casa.',
    seguimientos: [],
  },
  sin_respuesta: {
    orden: 90,
    label: 'X. Sin respuesta',
    owner: 'bot',
    salida: true,
    objetivo: 'Dejó de responder y volvió a escribir: retoma con calidez desde donde quedó y lleva a la visita.',
    seguimientos: [],
  },
  perdido: {
    orden: 91,
    label: 'X. Perdido',
    owner: 'bot',
    salida: true,
    objetivo: 'Había dicho que no le interesaba: atiéndelo con amabilidad, sin presionar; si muestra interés de nuevo, retoma el descubrimiento.',
    seguimientos: [],
  },
  descalificado: {
    orden: 92,
    label: 'X. Descalificado',
    owner: 'bot',
    salida: true,
    objetivo: 'Busca arriendo o es proveedor: sé amable y breve; Moné Gardens es solo venta.',
    seguimientos: [],
  },
};

const STAGE_KEYS = Object.keys(STAGES);
const FUNNEL_ORDER = STAGE_KEYS.slice().sort((a, b) => STAGES[a].orden - STAGES[b].orden);
const VISIT_STAGES = ['visita_agendada', 'visita_confirmada'];
// Tiempo de espera tras el último seguimiento antes de pasar a "Sin respuesta".
const CLOSE_AFTER_MS = 72 * HOUR;

const [FU_START, FU_END] = (process.env.FOLLOWUP_HOURS || '9-19').split('-').map((n) => parseInt(n, 10));

const events = new EventEmitter();

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^[\dx]+\.\s*/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Acepta "visito", "6", "6. Visitó", "Visita confirmada", etc. */
function resolveStage(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const num = raw.match(/^(\d+)/);
  if (num) {
    const byNum = STAGE_KEYS.find((k) => STAGES[k].orden === parseInt(num[1], 10));
    if (byNum) return byNum;
  }
  const n = normalize(raw);
  if (STAGES[n]) return n;
  const aliases = {
    nuevo: 'nuevo',
    conversacion: 'en_conversacion',
    calificado: 'calificado',
    agendada: 'visita_agendada',
    agendado: 'visita_agendada',
    confirmada: 'visita_confirmada',
    confirmado: 'visita_confirmada',
    visito: 'visito',
    visitado: 'visito',
    negociacion: 'negociacion',
    negociando: 'negociacion',
    reserva: 'reserva',
    reservo: 'reserva',
    vendido: 'vendido',
    venta: 'vendido',
    ganado: 'vendido',
    sin_respuesta: 'sin_respuesta',
    frio: 'sin_respuesta',
    perdido: 'perdido',
    descalificado: 'descalificado',
  };
  if (aliases[n]) return aliases[n];
  return STAGE_KEYS.find((k) => normalize(STAGES[k].label) === n) || null;
}

// ---------------------------------------------------------------------------
// Utilidades de fecha (zona horaria de Ecuador)
// ---------------------------------------------------------------------------
function localDate(ts = Date.now()) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}
function localHour(ts = Date.now()) {
  return parseInt(new Date(ts).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }), 10) % 24;
}
function parseVisitDate(text) {
  const m = String(text || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function addDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function fmtDateTime(ts) {
  return ts ? new Date(ts).toLocaleString('es-EC', { timeZone: TZ, hour12: false }) : '';
}
function withinFollowupHours(ts = Date.now()) {
  const h = localHour(ts);
  return h >= FU_START && h < FU_END;
}

// ---------------------------------------------------------------------------
// Transiciones de etapa
// ---------------------------------------------------------------------------
function label(etapa) {
  return (STAGES[etapa] || {}).label || etapa;
}

function scheduleFor(lead, etapa) {
  // Programa el próximo seguimiento según la etapa (desde el último mensaje del bot).
  const steps = STAGES[etapa].seguimientos;
  if (!steps.length || !lead.last_outbound_at) return { next_followup_at: null };
  if ((lead.last_inbound_at || 0) > lead.last_outbound_at) return { next_followup_at: null };
  const n = lead.followups_sent || 0;
  if (n < steps.length) return { next_followup_at: lead.last_outbound_at + steps[n] * HOUR };
  return { next_followup_at: lead.last_outbound_at + CLOSE_AFTER_MS };
}

/**
 * Cambia la etapa de un lead y deja registro.
 * @param {'bot'|'asesor'|'hoja'|'sistema'} por
 */
function setEtapa(phone, etapa, por) {
  const lead = store.ensureLead(phone);
  if (!STAGES[etapa]) throw new Error(`Etapa desconocida: ${etapa}`);
  if (lead.etapa === etapa) return { lead, changed: false };

  const fields = { etapa, etapa_at: Date.now(), updated_at: Date.now(), sheet_dirty: 1 };
  if (STAGES[etapa].owner === 'asesor' || STAGES[etapa].salida) fields.next_followup_at = null;
  if (VISIT_STAGES.includes(etapa) && !VISIT_STAGES.includes(lead.etapa)) {
    fields.reminder_sent = 0;
    fields.postvisit_alerted = 0;
  }
  let updated = store.updateLead(phone, fields);
  if (STAGES[etapa].owner === 'bot' && !STAGES[etapa].salida) {
    updated = store.updateLead(phone, { followups_sent: 0, ...scheduleFor({ ...updated, followups_sent: 0 }, etapa) });
  }
  store.addEtapaHistory(phone, lead.etapa, etapa, por);
  logger.info('Cambio de etapa', { phone, desde: lead.etapa, hacia: etapa, por });
  events.emit('etapa', { lead: updated, desde: lead.etapa, hacia: etapa, por });
  return { lead: updated, changed: true };
}

/** El bot solo avanza dentro de sus etapas; nunca retrocede ni toca etapas del asesor. */
function botCanMove(from, to) {
  if (from === to) return false;
  if (STAGES[from].owner === 'asesor') return false;
  if (from === 'descalificado') return false;
  if (STAGES[from].salida) return true; // reactivación desde sin_respuesta / perdido
  if (STAGES[to].salida) return true;
  return STAGES[to].orden > STAGES[from].orden;
}

/** Mensaje entrante del lead. */
function onInbound(phone, { chatId, profileName, text }) {
  let lead = store.ensureLead(phone);
  lead = store.updateLead(phone, {
    chat_id: chatId || lead.chat_id,
    profile_name: profileName || lead.profile_name,
    last_inbound_at: Date.now(),
    last_message: String(text || '').slice(0, 300),
    followups_sent: 0,
    next_followup_at: null,
    updated_at: Date.now(),
    sheet_dirty: 1,
  });

  if (lead.etapa === 'nuevo' && lead.last_outbound_at) {
    setEtapa(phone, 'en_conversacion', 'bot');
  } else if (lead.etapa === 'sin_respuesta' || lead.etapa === 'perdido') {
    const visita = parseVisitDate(lead.fecha_visita);
    const target =
      lead.calificacion === 'Calificado'
        ? visita && visita >= localDate()
          ? 'visita_agendada'
          : 'calificado'
        : 'en_conversacion';
    setEtapa(phone, target, 'bot');
  }

  lead = store.getLead(phone);
  if (STAGES[lead.etapa].owner === 'asesor') {
    events.emit('inbound_asesor', { lead, text });
  }
  return lead;
}

/** Mensaje enviado por el bot (respuesta o seguimiento). */
function onOutbound(phone, { followup = false } = {}) {
  const lead = store.getLead(phone);
  if (!lead) return;
  const now = Date.now();
  const followups_sent = followup ? (lead.followups_sent || 0) + 1 : lead.followups_sent || 0;
  const next = { ...lead, last_outbound_at: now, followups_sent };
  store.updateLead(phone, {
    last_outbound_at: now,
    followups_sent,
    ...scheduleFor(next, lead.etapa),
    updated_at: now,
    sheet_dirty: 1,
  });
}

/**
 * Aplica los datos que la IA extrajo de la conversación y decide la etapa.
 * @returns {{lead: object, etapa: string, changed: boolean}}
 */
function applyLeadUpdate(phone, data) {
  const current = store.ensureLead(phone);
  const fields = { updated_at: Date.now(), sheet_dirty: 1 };
  for (const k of ['nombre', 'presupuesto', 'tipo_credito', 'fecha_visita', 'interes', 'temperatura', 'notas']) {
    if (data[k]) fields[k] = String(data[k]).trim();
  }
  if (data.estado) fields.calificacion = data.estado;
  if (fields.fecha_visita && fields.fecha_visita !== current.fecha_visita) {
    fields.reminder_sent = 0;
    fields.postvisit_alerted = 0;
  }
  const lead = store.updateLead(phone, fields);

  let target = null;
  if (data.estado === 'Descalificado') target = 'descalificado';
  else if (data.estado === 'Perdido') target = 'perdido';
  else if (data.estado === 'Calificado') target = parseVisitDate(lead.fecha_visita) ? 'visita_agendada' : 'calificado';
  else if (lead.etapa === 'nuevo') target = 'en_conversacion';

  if (target && botCanMove(lead.etapa, target)) {
    const res = setEtapa(phone, target, 'bot');
    return { lead: res.lead, etapa: target, changed: true };
  }
  events.emit('datos', { lead });
  return { lead, etapa: lead.etapa, changed: false };
}

// ---------------------------------------------------------------------------
// Pausas (asesor atendiendo el chat)
// ---------------------------------------------------------------------------
function pause(phone, ms) {
  store.ensureLead(phone);
  return store.updateLead(phone, { paused_until: Date.now() + ms });
}
function resume(phone) {
  store.ensureLead(phone);
  return store.updateLead(phone, { paused_until: null });
}
function isPaused(phone) {
  const lead = store.getLead(phone);
  return Boolean(lead && lead.paused_until && lead.paused_until > Date.now());
}

// ---------------------------------------------------------------------------
// Reportes
// ---------------------------------------------------------------------------
function funnel() {
  const counts = Object.fromEntries(store.funnelCounts().map((r) => [r.etapa, r.total]));
  return FUNNEL_ORDER.map((k) => ({ etapa: k, label: STAGES[k].label, total: counts[k] || 0 }));
}

function funnelText() {
  const rows = funnel();
  const total = rows.reduce((s, r) => s + r.total, 0);
  const activos = rows.filter((r) => !STAGES[r.etapa].salida);
  // Etapa más avanzada que alcanzó cada lead (aunque luego haya salido del embudo).
  const maxOrden = new Map();
  for (const { phone, etapa } of store.reachedStages()) {
    const st = STAGES[etapa];
    if (!st || st.salida) continue;
    maxOrden.set(phone, Math.max(maxOrden.get(phone) || 0, st.orden));
  }
  const llegaron = (k) => [...maxOrden.values()].filter((o) => o >= STAGES[k].orden).length;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
  const lines = ['📊 *Embudo Moné Gardens*', ''];
  for (const r of activos) lines.push(`${r.label}: *${r.total}*`);
  lines.push('');
  for (const r of rows.filter((x) => STAGES[x.etapa].salida)) lines.push(`${r.label}: ${r.total}`);
  lines.push(
    '',
    `Total leads: ${total}`,
    `Lead → calificado: ${pct(llegaron('calificado'), total)}`,
    `Calificado → visita agendada: ${pct(llegaron('visita_agendada'), llegaron('calificado'))}`,
    `Visita agendada → visitó: ${pct(llegaron('visito'), llegaron('visita_agendada'))}`,
    `Visitó → vendido: ${pct(llegaron('vendido'), llegaron('visito'))}`
  );
  return lines.join('\n');
}

function leadCard(lead) {
  return [
    `👤 ${lead.nombre || lead.profile_name || 'Sin nombre'}`,
    `📱 +${lead.phone}  →  https://wa.me/${lead.phone}`,
    `📍 Etapa: *${label(lead.etapa)}*${lead.temperatura ? ` · ${lead.temperatura}` : ''}`,
    `💰 ${[lead.presupuesto, lead.tipo_credito].filter(Boolean).join(' · ') || 'Sin dato'}`,
    `📅 Visita: ${lead.fecha_visita || 'Sin fecha'}`,
    lead.notas ? `📝 ${lead.notas}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Automatizaciones: seguimientos, recordatorios y alertas
// ---------------------------------------------------------------------------
/**
 * @param {object} deps
 * @param {(phone: string, instruccion: string) => Promise<string>} deps.generate  Genera un mensaje con la IA.
 * @param {(lead: object, text: string) => Promise<void>} deps.sendToLead
 */
function startAutomations({ generate, sendToLead, intervalMs = 60 * 1000 }) {
  let running = false;

  async function sendGenerated(lead, instruccion, opts) {
    const text = await generate(lead.phone, instruccion);
    await sendToLead(lead, text);
    onOutbound(lead.phone, opts);
    return text;
  }

  async function processFollowups(now) {
    for (const lead of store.dueFollowups(now)) {
      const stage = STAGES[lead.etapa];
      if (!stage || stage.owner !== 'bot' || stage.salida || !lead.chat_id) {
        store.updateLead(lead.phone, { next_followup_at: null });
        continue;
      }
      if (lead.paused_until && lead.paused_until > now) {
        store.updateLead(lead.phone, { next_followup_at: lead.paused_until + HOUR });
        continue;
      }
      const steps = stage.seguimientos;
      const n = lead.followups_sent || 0;
      if (n >= steps.length) {
        setEtapa(lead.phone, 'sin_respuesta', 'sistema');
        continue;
      }
      const ultimo = n === steps.length - 1;
      const horas = Math.round((now - (lead.last_outbound_at || now)) / HOUR);
      const instruccion = [
        `Seguimiento automático ${n + 1} de ${steps.length}. El cliente no responde desde hace unas ${horas} horas.`,
        `Etapa actual: ${stage.label}. Objetivo: ${stage.objetivo}`,
        'Escribe UN mensaje corto (1-2 frases) que retome la conversación aportando un motivo nuevo para avanzar: un beneficio que aún no mencionaste y que encaje con lo que sabes del cliente.',
        'No le reclames que no respondió ni repitas mensajes anteriores. Termina con una pregunta fácil de responder.',
        ultimo
          ? 'Es el último seguimiento: sé especialmente amable, deja la puerta abierta y ofrece la visita como siguiente paso.'
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      try {
        await sendGenerated(lead, instruccion, { followup: true });
        logger.info('Seguimiento enviado', { phone: lead.phone, etapa: lead.etapa, n: n + 1 });
      } catch (err) {
        logger.error('Error enviando seguimiento', { phone: lead.phone, error: err.message });
        store.updateLead(lead.phone, { next_followup_at: now + HOUR });
      }
    }
  }

  async function processVisits(now) {
    const hoy = localDate(now);
    for (const etapa of VISIT_STAGES) {
      for (const lead of store.leadsByEtapa(etapa)) {
        const visita = parseVisitDate(lead.fecha_visita);
        if (!visita) continue;

        // Recordatorio al cliente el día anterior a la visita.
        if (!lead.reminder_sent && hoy === addDays(visita, -1) && lead.chat_id && !(lead.paused_until > now)) {
          store.updateLead(lead.phone, { reminder_sent: 1 });
          try {
            await sendGenerated(
              lead,
              `Recordatorio automático: la visita del cliente al proyecto es mañana (${lead.fecha_visita}). Escribe un mensaje corto y entusiasta que le recuerde la visita, mencione algo que podrá ver en persona (por ejemplo las áreas comunales o el jardín) y le pida confirmar su asistencia. Si aún no tiene hora confirmada, dile que su asesor le escribirá con la hora y la ubicación.`,
              { followup: false }
            );
            logger.info('Recordatorio de visita enviado', { phone: lead.phone, visita });
          } catch (err) {
            logger.error('Error enviando recordatorio de visita', { phone: lead.phone, error: err.message });
          }
        }

        // Alerta al asesor el día después de la visita para mover la etapa.
        if (!lead.postvisit_alerted && hoy > visita) {
          store.updateLead(lead.phone, { postvisit_alerted: 1 });
          events.emit('postvisita', { lead });
        }
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      if (withinFollowupHours(now)) {
        await processFollowups(now);
        await processVisits(now);
      }
    } catch (err) {
      logger.error('Error en automatizaciones del embudo', { error: err.message, stack: err.stack });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 10 * 1000).unref();
  return { tick, stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// Sincronización con Google Sheets (la hoja es el tablero del equipo)
// ---------------------------------------------------------------------------
function startSheetSync({ pushMs = 30 * 1000, pullMs = 5 * 60 * 1000 } = {}) {
  if (!crm.isConfigured()) {
    logger.warn('Google Sheets no configurado: el embudo solo vive en la base de datos local');
    return { push: async () => {}, pull: async () => {} };
  }
  let pushing = false;
  let pulling = false;

  async function push() {
    if (pushing) return;
    pushing = true;
    try {
      const dirty = store.dirtyLeads();
      if (!dirty.length) return;
      const rows = dirty.map((l) => ({
        telefono: l.phone,
        nombre: l.nombre || l.profile_name,
        etapa: label(l.etapa),
        calificacion: l.calificacion,
        temperatura: l.temperatura,
        presupuesto: l.presupuesto,
        tipo_credito: l.tipo_credito,
        fecha_visita: l.fecha_visita,
        interes: l.interes,
        seguimientos: l.followups_sent,
        proximo_seguimiento: fmtDateTime(l.next_followup_at),
        ultimo_mensaje: l.last_message,
        notas: l.notas,
        creado: fmtDateTime(l.created_at),
      }));
      await crm.syncLeads(rows);
      for (const l of dirty) {
        const fresh = store.getLead(l.phone);
        // Solo limpia el flag si no hubo cambios mientras se sincronizaba.
        if (fresh.updated_at === l.updated_at && fresh.etapa === l.etapa) {
          store.updateLead(l.phone, { sheet_dirty: 0, sheet_etapa: label(l.etapa) });
        } else {
          store.updateLead(l.phone, { sheet_etapa: label(l.etapa) });
        }
      }
    } catch (err) {
      logger.error('Error sincronizando el embudo con Google Sheets', { error: err.message });
    } finally {
      pushing = false;
    }
  }

  async function pull() {
    if (pulling || pushing) return;
    pulling = true;
    try {
      const rows = await crm.readEtapas();
      for (const { telefono, etapa } of rows) {
        const lead = store.getLead(telefono);
        if (!lead || !etapa || etapa === lead.sheet_etapa) continue;
        const key = resolveStage(etapa);
        if (!key) {
          logger.warn('Etapa no reconocida en la hoja', { telefono, etapa });
          continue;
        }
        if (key !== lead.etapa) setEtapa(telefono, key, 'hoja');
        store.updateLead(telefono, { sheet_etapa: label(key), sheet_dirty: 1 });
      }
    } catch (err) {
      logger.error('Error leyendo etapas desde Google Sheets', { error: err.message });
    } finally {
      pulling = false;
    }
  }

  setInterval(push, pushMs).unref();
  setInterval(pull, pullMs).unref();
  setTimeout(push, 5 * 1000).unref();
  return { push, pull };
}

module.exports = {
  STAGES,
  FUNNEL_ORDER,
  events,
  label,
  resolveStage,
  setEtapa,
  onInbound,
  onOutbound,
  applyLeadUpdate,
  pause,
  resume,
  isPaused,
  funnel,
  funnelText,
  leadCard,
  startAutomations,
  startSheetSync,
  localDate,
  fmtDateTime,
};
