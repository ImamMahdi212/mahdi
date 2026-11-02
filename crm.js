'use strict';

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const logger = require('./logger');

// Columnas del tablero de ventas. "Etapa" la puede editar el equipo a mano:
// el bot lee ese cambio y mueve al lead en el embudo.
const HEADERS = [
  'Fecha',
  'Telefono',
  'Nombre',
  'Etapa',
  'Estado',
  'Temperatura',
  'Presupuesto',
  'TipoCredito',
  'FechaVisita',
  'Interes',
  'Seguimientos',
  'ProximoSeguimiento',
  'UltimoMensaje',
  'Notas',
  'UltimaActualizacion',
];

const SHEET_TITLE = process.env.GOOGLE_SHEET_TAB || 'Leads';
const TZ = process.env.TZ || 'America/Guayaquil';

let sheetPromise = null;

function getPrivateKey() {
  const raw = process.env.GOOGLE_PRIVATE_KEY || '';
  // Soporta claves pegadas con "\n" literales o entre comillas.
  return raw.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
}

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_SHEET_ID &&
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_PRIVATE_KEY
  );
}

async function initSheet() {
  if (!isConfigured()) {
    throw new Error('Google Sheets no configurado (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY).');
  }

  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: getPrivateKey(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();

  let sheet = doc.sheetsByTitle[SHEET_TITLE];
  if (!sheet) {
    sheet = await doc.addSheet({ title: SHEET_TITLE, headerValues: HEADERS });
    logger.info(`Hoja "${SHEET_TITLE}" creada en "${doc.title}"`);
  } else {
    try {
      await sheet.loadHeaderRow();
    } catch (_) {
      await sheet.setHeaderRow(HEADERS);
    }
    const missing = HEADERS.filter((h) => !sheet.headerValues.includes(h));
    if (missing.length) {
      await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
    }
  }

  logger.info(`CRM conectado a Google Sheets: "${doc.title}" / "${SHEET_TITLE}"`);
  return sheet;
}

function getSheet() {
  if (!sheetPromise) {
    sheetPromise = initSheet().catch((err) => {
      sheetPromise = null; // permitir reintento en la próxima llamada
      throw err;
    });
  }
  return sheetPromise;
}

function now() {
  return new Date().toLocaleString('es-EC', { timeZone: TZ, hour12: false });
}

async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = 1000 * 2 ** i;
      logger.warn(`Error en Google Sheets (intento ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Serializa los accesos a la hoja para evitar filas duplicadas.
let chain = Promise.resolve();
function serialized(fn) {
  const task = chain.then(() => withRetry(fn));
  chain = task.catch(() => {});
  return task;
}

const clean = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * Inserta o actualiza (por teléfono) varios leads del embudo.
 * @param {Array<object>} leads
 */
function syncLeads(leads) {
  return serialized(async () => {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const byPhone = new Map(rows.map((r) => [String(r.get('Telefono') || '').replace(/\D/g, ''), r]));
    const toAdd = [];

    for (const lead of leads) {
      const telefono = String(lead.telefono || '').replace(/\D/g, '');
      if (!telefono) continue;
      const data = {
        Telefono: telefono,
        Nombre: clean(lead.nombre),
        Etapa: clean(lead.etapa),
        Estado: clean(lead.calificacion),
        Temperatura: clean(lead.temperatura),
        Presupuesto: clean(lead.presupuesto),
        TipoCredito: clean(lead.tipo_credito),
        FechaVisita: clean(lead.fecha_visita),
        Interes: clean(lead.interes),
        Seguimientos: clean(lead.seguimientos),
        ProximoSeguimiento: clean(lead.proximo_seguimiento),
        UltimoMensaje: clean(lead.ultimo_mensaje),
        Notas: clean(lead.notas),
        UltimaActualizacion: now(),
      };
      const existing = byPhone.get(telefono);
      if (existing) {
        existing.assign(data);
        await existing.save();
      } else {
        toAdd.push({ Fecha: lead.creado || now(), ...data });
      }
    }
    if (toAdd.length) await sheet.addRows(toAdd);
    logger.debug('Embudo sincronizado con Google Sheets', { actualizados: leads.length - toAdd.length, nuevos: toAdd.length });
  });
}

/** Lee la columna Etapa de la hoja (para detectar cambios hechos por el equipo). */
function readEtapas() {
  return serialized(async () => {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    return rows
      .map((r) => ({
        telefono: String(r.get('Telefono') || '').replace(/\D/g, ''),
        etapa: String(r.get('Etapa') || '').trim(),
      }))
      .filter((r) => r.telefono);
  });
}

async function healthCheck() {
  if (!isConfigured()) return 'not_configured';
  try {
    await getSheet();
    return 'ok';
  } catch (err) {
    return `error: ${err.message}`;
  }
}

module.exports = { syncLeads, readEtapas, healthCheck, isConfigured, getSheet };
