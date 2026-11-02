'use strict';

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const logger = require('./logger');

const HEADERS = [
  'Fecha',
  'Telefono',
  'Nombre',
  'Presupuesto',
  'TipoCredito',
  'FechaVisita',
  'Interes',
  'Estado',
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

// Serializa escrituras para evitar duplicados por condiciones de carrera.
let writeChain = Promise.resolve();

/**
 * Inserta o actualiza (por teléfono) un lead en Google Sheets.
 * @param {object} lead
 * @returns {Promise<{action: 'created'|'updated'}>}
 */
function saveLead(lead) {
  const task = writeChain.then(() =>
    withRetry(async () => {
      const sheet = await getSheet();
      const telefono = String(lead.telefono || '').trim();
      const data = {
        Telefono: telefono,
        Nombre: lead.nombre || '',
        Presupuesto: lead.presupuesto || '',
        TipoCredito: lead.tipo_credito || '',
        FechaVisita: lead.fecha_visita || '',
        Interes: lead.interes || '',
        Estado: lead.estado || '',
        Notas: lead.notas || '',
        UltimaActualizacion: now(),
      };

      const rows = await sheet.getRows();
      const existing = rows.find((r) => String(r.get('Telefono') || '').trim() === telefono);

      if (existing) {
        existing.assign(data);
        await existing.save();
        logger.info('Lead actualizado en CRM', { telefono, estado: data.Estado });
        return { action: 'updated' };
      }

      await sheet.addRow({ Fecha: now(), ...data });
      logger.info('Lead creado en CRM', { telefono, estado: data.Estado });
      return { action: 'created' };
    })
  );
  writeChain = task.catch(() => {});
  return task;
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

module.exports = { saveLead, healthCheck, isConfigured, getSheet };
