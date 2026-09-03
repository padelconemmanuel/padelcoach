/**
 * Backend de sincronización para padel-alumnos.html.
 * Se deploya como Web App desde una cuenta con acceso al calendario
 * "CLASES DE PADEL" (clasesdepadel@gmail.com) — ese calendario es la
 * fuente de verdad para horarios/alumnos; el estado de pagos vive acá
 * (Script Properties) porque el calendario no tiene ese concepto.
 *
 * Deploy: Implementar > Nueva implementación > Aplicación web
 *   - Ejecutar como: Yo (clasesdepadel@gmail.com)
 *   - Quién tiene acceso: Cualquier usuario
 * Antes de deployar, configurar el token en:
 *   Configuración del proyecto > Propiedades del script > SYNC_TOKEN
 */

const CALENDAR_ID = 'clasesdepadel@gmail.com';
const TIMEZONE = 'America/Argentina/Buenos_Aires';
const DEFAULT_DURATION_MIN = 60;
const TAG_RE = /\[alumnos:([a-zA-Z0-9_]+)\]/;
const RESERVA_RE = /\breserva\b/i;
const TAG_WORDS = ['nuevo', 'partido'];

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

/* ── entradas HTTP ─────────────────────────────────────────────── */

// GET queda solo para pruebas manuales (curl, etc). Google cachea las
// respuestas GET para pedidos con User-Agent de navegador ignorando el
// query string, así que el frontend usa POST para todo (ver doPost).
function doGet(e) {
  try {
    checkToken_(e);
    if (e.parameter.action === 'state') {
      return jsonOut_(stateResponse_(e.parameter.week));
    }
    if (e.parameter.action === 'ping') {
      return jsonOut_({ ok: true, msg: 'pong' });
    }
    return jsonOut_({ ok: false, error: 'acción desconocida' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    checkToken_({ parameter: { token: body.token } });
    if (body.action === 'state') {
      return jsonOut_(stateResponse_(body.week));
    }
    if (body.action === 'save') {
      const monday = mondayFromParam_(body.week);
      const mondayIso = isoDate_(monday);
      deleteCalendarEvents_(monday, body.deletedClassIds);
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        const store = getStore_();
        // replaceMaps: el cliente pidió vaciar explícitamente ("Reiniciar
        // pagos" / "Restaurar original"), así que no hay nada previo que
        // conservar.
        const prev = body.replaceMaps ? {} : (store.weeks[mondayIso] || {});
        // Los mapas de pagos se fusionan en vez de reemplazarse: una pestaña
        // con datos viejos (o abierta desde antes de que se propagara un
        // pago al mes) mandaba la semana entera y borraba lo que no conocía.
        // Con el merge, solo pisa las claves que efectivamente trae.
        store.weeks[mondayIso] = {
          data: body.data,
          paid: mergeMaps_(prev.paid, body.paid),
          amounts: mergeMaps_(prev.amounts, body.amounts),
          metodos: mergeMaps_(prev.metodos, body.metodos),
          comprobantes: mergeMaps_(prev.comprobantes, body.comprobantes),
        };
        if (typeof body.uid === 'number' && body.uid > store.uid) store.uid = body.uid;
        saveStore_(store);
      } finally {
        lock.releaseLock();
      }
      return jsonOut_(stateResponse_(mondayIso));
    }
    if (body.action === 'uploadReceipt') {
      return jsonOut_(enqueueReceipt_(body));
    }
    if (body.action === 'checkUpload') {
      return jsonOut_(checkUpload_(body.requestId));
    }
    if (body.action === 'setMonthlyPaid') {
      applyPaidToMonth_(body);
      return jsonOut_({ ok: true });
    }
    if (body.action === 'resetMonth') {
      resetMonth_(body.week);
      return jsonOut_({ ok: true });
    }
    if (body.action === 'monthTotal') {
      return jsonOut_(monthTotal_(body.week));
    }
    return jsonOut_({ ok: false, error: 'acción desconocida' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

// Fusiona el mapa que manda el cliente sobre lo que ya había guardado: las
// claves que el cliente trae ganan, las que no conoce se conservan.
function mergeMaps_(prev, incoming) {
  const out = {};
  if (prev) Object.keys(prev).forEach(k => { out[k] = prev[k]; });
  if (incoming) Object.keys(incoming).forEach(k => { out[k] = incoming[k]; });
  return out;
}

function stateResponse_(weekParam) {
  const monday = mondayFromParam_(weekParam);
  const mondayIso = isoDate_(monday);
  const state = reconcile_(mondayIso);
  const prev = new Date(monday); prev.setDate(monday.getDate() - 7);
  const next = new Date(monday); next.setDate(monday.getDate() + 7);
  const todayIso = isoDate_(mondayOf_(new Date()));
  return {
    ok: true,
    state,
    weekStart: mondayIso,
    prevWeek: isoDate_(prev),
    nextWeek: isoDate_(next),
    isCurrentWeek: mondayIso === todayIso,
  };
}

function mondayFromParam_(param) {
  if (!param) return mondayOf_(new Date());
  return mondayOf_(new Date(param + 'T00:00:00'));
}

function checkToken_(e) {
  const token = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!token) throw new Error('SYNC_TOKEN no configurado en Propiedades del script');
  if (!e || e.parameter.token !== token) throw new Error('token inválido');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ── triggers periódicos (configurar manualmente en "Activadores"):
   syncTick cada 15 min, uploadTick cada 1 min ──────────────────── */

function syncTick() {
  reconcile_(isoDate_(mondayOf_(new Date())));
  backupToDrive_(getStore_());
  processPendingUploads_();
}

function uploadTick() {
  processPendingUploads_();
}

/* ── backup y comprobantes en Google Drive (cuenta clasesdepadel@gmail.com) ──
   IMPORTANTE: Google bloquea el acceso a Drive (scope 'drive'/'drive.file')
   cuando la Web App se invoca de forma anónima (que es como la llama el
   frontend, sin login). Solo funciona cuando el código corre "como el
   dueño del script" vía un trigger instalado (Activadores), nunca desde
   doGet/doPost. Por eso el backup y la subida de comprobantes NO se hacen
   en el momento del pedido HTTP: el comprobante se encola (CacheService) y
   un trigger lo sube a Drive poco después. */

const BACKUP_FOLDER_NAME = 'Padel Alumnos - Backups';
const RECEIPTS_FOLDER_NAME = 'Padel Alumnos - Comprobantes';
const UPLOAD_CHUNK_SIZE = 90000; // caracteres por chunk en CacheService (límite ~100KB/valor)
const UPLOAD_TTL_SEC = 21600; // 6 horas, el máximo que permite CacheService

function backupToDrive_(store) {
  try {
    const folder = getOrCreateFolder_('BACKUP_FOLDER_ID', BACKUP_FOLDER_NAME);
    const fileName = 'backup-' + isoDate_(new Date()) + '.json';
    const content = JSON.stringify(store, null, 2);
    const existing = folder.getFilesByName(fileName);
    if (existing.hasNext()) {
      existing.next().setContent(content);
    } else {
      folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
    }
  } catch (err) {
    // el backup no debe romper el flujo principal de guardado/sync
  }
}

// Guarda el archivo en cola (CacheService, partido en chunks) para que lo
// suba processPendingUploads_ desde un trigger. Devuelve enseguida.
function enqueueReceipt_(body) {
  if (!body.dataBase64) throw new Error('falta el archivo');
  const cache = CacheService.getScriptCache();
  const requestId = Utilities.getUuid();
  const data = body.dataBase64;
  const chunkCount = Math.ceil(data.length / UPLOAD_CHUNK_SIZE) || 1;
  for (let i = 0; i < chunkCount; i++) {
    cache.put('upl_' + requestId + '_' + i, data.slice(i * UPLOAD_CHUNK_SIZE, (i + 1) * UPLOAD_CHUNK_SIZE), UPLOAD_TTL_SEC);
  }
  cache.put('upl_' + requestId + '_meta', JSON.stringify({
    chunks: chunkCount,
    fileName: body.fileName || 'comprobante',
    mimeType: body.mimeType || 'application/octet-stream',
  }), UPLOAD_TTL_SEC);

  const props = PropertiesService.getScriptProperties();
  const pending = JSON.parse(props.getProperty('PENDING_UPLOADS') || '[]');
  pending.push(requestId);
  props.setProperty('PENDING_UPLOADS', JSON.stringify(pending));

  return { ok: true, pending: true, requestId };
}

function checkUpload_(requestId) {
  if (!requestId) throw new Error('falta requestId');
  const cache = CacheService.getScriptCache();
  const resultRaw = cache.get('uplres_' + requestId);
  if (resultRaw) return Object.assign({ ok: true, done: true }, JSON.parse(resultRaw));
  return { ok: true, done: false };
}

// Corre desde un trigger (nunca desde doGet/doPost): sube a Drive todos los
// comprobantes encolados y guarda el resultado para que el frontend lo
// recoja vía checkUpload_.
function processPendingUploads_() {
  const props = PropertiesService.getScriptProperties();
  const pending = JSON.parse(props.getProperty('PENDING_UPLOADS') || '[]');
  if (!pending.length) return;

  const cache = CacheService.getScriptCache();
  const remaining = [];
  pending.forEach(requestId => {
    try {
      const metaRaw = cache.get('upl_' + requestId + '_meta');
      if (!metaRaw) return; // expiró (más de 6hs) o ya se procesó: se descarta
      const meta = JSON.parse(metaRaw);
      let data = '';
      for (let i = 0; i < meta.chunks; i++) {
        const chunk = cache.get('upl_' + requestId + '_' + i);
        if (chunk === null) throw new Error('falta un chunk, se reintenta en el próximo tick');
        data += chunk;
      }
      const folder = getOrCreateFolder_('RECEIPTS_FOLDER_ID', RECEIPTS_FOLDER_NAME);
      const bytes = Utilities.base64Decode(data);
      const blob = Utilities.newBlob(bytes, meta.mimeType, meta.fileName);
      const file = folder.createFile(blob);
      file.setName('comp-' + Date.now() + '-' + meta.fileName);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      cache.put('uplres_' + requestId, JSON.stringify({ url: file.getUrl(), name: file.getName() }), UPLOAD_TTL_SEC);
      for (let i = 0; i < meta.chunks; i++) cache.remove('upl_' + requestId + '_' + i);
      cache.remove('upl_' + requestId + '_meta');
    } catch (err) {
      remaining.push(requestId); // reintentar en el próximo tick
    }
  });
  props.setProperty('PENDING_UPLOADS', JSON.stringify(remaining));
}

// Evita DriveApp.getFoldersByName (busca en todo el Drive y requiere el
// scope amplio 'drive'). Guardamos el ID la primera vez que se crea la
// carpeta y después la buscamos por ID.
function getOrCreateFolder_(propKey, name) {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(propKey);
  if (savedId) {
    try { return DriveApp.getFolderById(savedId); } catch (err) { /* la carpeta ya no existe, se recrea abajo */ }
  }
  const folder = DriveApp.createFolder(name);
  props.setProperty(propKey, folder.getId());
  return folder;
}

/* ── estado persistido (una entrada por semana, guardadas por su lunes) ─ */

function getStore_() {
  const raw = PropertiesService.getScriptProperties().getProperty('STATE');
  if (!raw) return { weeks: {}, uid: 1 };
  const parsed = JSON.parse(raw);
  if (parsed.weeks) return parsed;
  // migración desde el formato viejo (una sola semana suelta)
  const weekStart = parsed.weekStart || isoDate_(mondayOf_(new Date()));
  return {
    weeks: {
      [weekStart]: {
        data: parsed.data || [],
        paid: parsed.paid || {},
        amounts: parsed.amounts || {},
        metodos: parsed.metodos || {},
        comprobantes: parsed.comprobantes || {},
      },
    },
    uid: parsed.uid || 1,
  };
}

function saveStore_(store) {
  PropertiesService.getScriptProperties().setProperty('STATE', JSON.stringify(store));
}

/* ── helpers de fecha ─────────────────────────────────────────── */

function mondayOf_(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function isoDate_(d) {
  return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}

function timeStr_(d) {
  return Utilities.formatDate(d, TIMEZONE, 'HH:mm');
}

function fmtFecha_(d) {
  return d.getDate() + ' de ' + MESES[d.getMonth()];
}

/* ── armar/leer nombres desde el título del evento ───────────────── */

function parseTitle_(summary) {
  const parts = summary.split(/\s*,\s*|\s+y\s+/i).map(s => s.trim()).filter(Boolean);
  return parts.map(part => {
    let words = part.split(/\s+/);
    let t = null;
    const last = (words[words.length - 1] || '').toLowerCase();
    if (TAG_WORDS.indexOf(last) !== -1) {
      t = words.pop();
      words = words;
    } else if (/^x2$|^×2$/i.test(last)) {
      t = '×2';
      words.pop();
    }
    let n = words.join(' ').trim();
    n = n.charAt(0).toUpperCase() + n.slice(1);
    return { n, t };
  }).filter(s => s.n);
}

function buildTitle_(students) {
  return students.map(s => s.t ? `${s.n} ${s.t}` : s.n).join(', ');
}

function buildDescription_(students, paid, amounts, classId) {
  const lines = students.map(s => {
    const isPaid = !!paid[s.id];
    const amt = amounts[s.id] || 0;
    return isPaid ? `${s.n}: pagado $${amt}` : `${s.n}: pendiente`;
  });
  lines.push(`[alumnos:${classId}]`);
  return lines.join('\n');
}

/* ── reconciliación principal ─────────────────────────────────── */

function reconcile_(mondayIso) {
  const store = getStore_();
  const monday = new Date(mondayIso + 'T00:00:00');

  let weekState = store.weeks[mondayIso] || seedWeek_(monday);
  const merged = {
    data: weekState.data,
    paid: weekState.paid || {},
    amounts: weekState.amounts || {},
    metodos: weekState.metodos || {},
    comprobantes: weekState.comprobantes || {},
    uid: store.uid,
  };

  const result = syncWithCalendar_(merged, monday);

  store.weeks[mondayIso] = {
    data: result.data,
    paid: result.paid,
    amounts: result.amounts,
    metodos: result.metodos,
    comprobantes: result.comprobantes,
  };
  store.uid = result.uid;
  saveStore_(store);

  return {
    data: result.data,
    paid: result.paid,
    amounts: result.amounts,
    metodos: result.metodos,
    comprobantes: result.comprobantes,
    uid: store.uid,
  };
}

// Aplica monto/método (y opcionalmente pagado) a todas las apariciones del
// mismo alumno en el mismo día de la semana + horario, dentro del mes de la
// clase que disparó el cambio. Las clases de pádel se cobran por mes, no por
// semana: cargar el monto (o tildar "pagado") una vez alcanza para todo el mes.
function applyPaidToMonth_(body) {
  if (!body.classDayIso || !body.time || !body.studentName) return;
  const refDate = new Date(body.classDayIso + 'T00:00:00');
  const weekdayIdx = refDate.getDay();
  // La semana de refDate puede cruzar fin de mes (ej. una clase el lunes 31
  // ago pertenece a la semana "31 ago - 6 sep"). Usamos el jueves de esa
  // semana para elegir el mes, igual que monthTotal_, así "todo el mes"
  // significa el mes que la app está mostrando y no se corta en el lunes.
  const refMonday = mondayOf_(refDate);
  const refThursday = new Date(refMonday);
  refThursday.setDate(refMonday.getDate() + 3);
  const year = refThursday.getFullYear();
  const month = refThursday.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);

  const mondays = [];
  let cursor = mondayOf_(firstOfMonth);
  while (cursor <= lastOfMonth) {
    mondays.push(isoDate_(cursor));
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 7);
  }

  // Nota: solo toca semanas que ya están en el store (ya vistas/sincronizadas
  // al menos una vez). No llamamos reconcile_ acá para no multiplicar por
  // 4-5 las operaciones sobre el calendario en cada tilde de "pagado" — eso
  // generaba choques con otros pedidos concurrentes (polling, guardados) que
  // terminaban corrompiendo el roster de una clase. Si una semana del mes
  // todavía no se sincronizó, el pago no se aplica ahí hasta que se
  // sincronice esa semana por separado (visitarla o esperar el syncTick).
  const nameKey = body.studentName.trim().toLowerCase();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const store = getStore_();
    mondays.forEach(mIso => {
      const weekState = store.weeks[mIso];
      if (!weekState) return;
      weekState.paid = weekState.paid || {};
      weekState.amounts = weekState.amounts || {};
      weekState.metodos = weekState.metodos || {};
      weekState.data.forEach(day => {
        const d = new Date(day.iso + 'T00:00:00');
        if (d.getDay() !== weekdayIdx || d < firstOfMonth || d > lastOfMonth) return;
        day.classes.forEach(cls => {
          if (cls.time !== body.time) return;
          cls.students.forEach(s => {
            if (s.n.trim().toLowerCase() !== nameKey) return;
            // "paid" es opcional: el tilde de pagado propaga pagado+monto+
            // método juntos, pero cargar el monto o el método solos (sin
            // tildar pagado todavía) también los propaga, sin tocar el
            // estado de pagado de las demás semanas.
            if (typeof body.paid === 'boolean') weekState.paid[s.id] = body.paid;
            weekState.amounts[s.id] = body.amount || 0;
            if (body.metodo) weekState.metodos[s.id] = body.metodo;
            else delete weekState.metodos[s.id];
          });
        });
      });
    });
    saveStore_(store);
  } finally {
    lock.releaseLock();
  }
}

// Borra pagos/montos/métodos/comprobantes de todas las clases del mes que
// contiene la semana pedida (mismo criterio de mes que monthTotal_): el
// botón "Reiniciar pagos" reinicia el mes entero, no solo la semana vista.
function resetMonth_(weekParam) {
  const monday = mondayFromParam_(weekParam);
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const year = thursday.getFullYear();
  const month = thursday.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);

  const mondays = [];
  let cursor = mondayOf_(firstOfMonth);
  while (cursor <= lastOfMonth) {
    mondays.push(isoDate_(cursor));
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 7);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const store = getStore_();
    mondays.forEach(mIso => {
      const weekState = store.weeks[mIso];
      if (!weekState) return;
      weekState.paid = weekState.paid || {};
      weekState.amounts = weekState.amounts || {};
      weekState.metodos = weekState.metodos || {};
      weekState.comprobantes = weekState.comprobantes || {};
      weekState.data.forEach(day => {
        const d = new Date(day.iso + 'T00:00:00');
        if (d < firstOfMonth || d > lastOfMonth) return;
        day.classes.forEach(cls => cls.students.forEach(s => {
          delete weekState.paid[s.id];
          delete weekState.amounts[s.id];
          delete weekState.metodos[s.id];
          delete weekState.comprobantes[s.id];
        }));
      });
    });
    saveStore_(store);
  } finally {
    lock.releaseLock();
  }
}

// Suma real de los montos cargados (tilden o no "pagado", igual que el
// resumen semanal y el badge por día) en todas las semanas del mes que ya se
// sincronizaron alguna vez, agrupados por fecha real. A diferencia de la
// proyección anterior, esto es la plata efectivamente cargada en el mes.
function monthTotal_(weekParam) {
  const monday = mondayFromParam_(weekParam);
  // Una semana lunes-domingo puede cruzar fin de mes (ej. 31 ago - 6 sep).
  // Usamos el jueves de esa semana como referencia: es el día que siempre
  // cae en el mes con más días de la semana (regla tipo ISO), así que no
  // importa si el lunes cayó "del otro lado" del corte de mes.
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const year = thursday.getFullYear();
  const month = thursday.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);

  const mondays = [];
  let cursor = mondayOf_(firstOfMonth);
  while (cursor <= lastOfMonth) {
    mondays.push(isoDate_(cursor));
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 7);
  }

  const store = getStore_();
  const byDate = [];
  let total = 0;
  // totalPagado: solo lo que está efectivamente tildado como "pagado". Es lo
  // que muestra el visor "cobrado del mes" del encabezado.
  let totalPagado = 0;

  mondays.forEach(mIso => {
    const weekState = store.weeks[mIso];
    if (!weekState) return;
    weekState.data.forEach(day => {
      const d = new Date(day.iso + 'T00:00:00');
      if (d < firstOfMonth || d > lastOfMonth) return;
      const entries = [];
      let dayTotal = 0;
      day.classes.forEach(cls => {
        cls.students.forEach(s => {
          const amt = (weekState.amounts && weekState.amounts[s.id]) || 0;
          const pagado = !!(weekState.paid && weekState.paid[s.id]);
          if (pagado) totalPagado += amt;
          if (amt > 0) {
            entries.push({ time: cls.time, name: s.n, amount: amt, paid: pagado });
            dayTotal += amt;
          }
        });
      });
      if (dayTotal > 0) {
        byDate.push({ iso: day.iso, dayName: day.day, date: day.date, amount: dayTotal, entries });
        total += dayTotal;
      }
    });
  });

  byDate.sort((a, b) => a.iso.localeCompare(b.iso));

  return { ok: true, monthLabel: MESES[month] + ' ' + year, total, totalPagado, byDate };
}

function seedWeek_(monday) {
  const data = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    data.push({ day: DIAS[i], date: fmtFecha_(d), iso: isoDate_(d), classes: [] });
  }
  return { data, paid: {}, amounts: {}, metodos: {}, comprobantes: {} };
}

// Borra en el calendario los eventos de las clases que se eliminaron en la
// app. Sin esto, reconcile_ los vuelve a encontrar (tag sin clase asociada)
// y los reimporta como si fueran clases nuevas.
function deleteCalendarEvents_(monday, classIds) {
  if (!classIds || !classIds.length) return;
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) return;
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 7);
  const idSet = {};
  classIds.forEach(id => { idSet[id] = true; });
  cal.getEvents(monday, sunday).forEach(ev => {
    const m = TAG_RE.exec(ev.getDescription() || '');
    if (m && idSet[m[1]]) {
      try { ev.deleteEvent(); } catch (err) { /* ya borrado o error transitorio */ }
    }
  });
}

function syncWithCalendar_(state, monday) {
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error('No se encontró el calendario ' + CALENDAR_ID);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 7);

  const events = cal.getEvents(monday, sunday);

  // Google Calendar a veces "pega" la misma descripción (y por lo tanto el
  // mismo tag [alumnos:ID]) en varias instancias distintas de una serie
  // recurrente. Si un tag aparece más de una vez en esta semana, no es
  // confiable: tratamos todos esos eventos como si no tuvieran tag.
  const byTagLists = {};
  const untagged = [];
  events.forEach(ev => {
    if (RESERVA_RE.test(ev.getTitle() || '')) return;
    // eventos de día completo (cumpleaños, feriados, recordatorios) no son
    // clases y suelen ser de solo lectura: tocarlos tira "Acción no permitida"
    if (ev.isAllDayEvent()) return;
    const m = TAG_RE.exec(ev.getDescription() || '');
    if (m) {
      (byTagLists[m[1]] = byTagLists[m[1]] || []).push(ev);
    } else {
      untagged.push(ev);
    }
  });
  const byTag = {};
  Object.keys(byTagLists).forEach(tagId => {
    const list = byTagLists[tagId];
    if (list.length === 1) byTag[tagId] = list[0];
    else untagged.push(...list);
  });

  let uid = state.uid || 1;
  const nextClassId = () => 'cl' + (uid++);
  const nextStudentId = () => 'st' + (uid++);

  const dayByIso = {};
  state.data.forEach(day => { dayByIso[day.iso] = day; });

  const classIndex = {};
  state.data.forEach(day => day.classes.forEach(cls => {
    if (!cls.id) cls.id = nextClassId();
    classIndex[cls.id] = { day, cls };
  }));

  // Foto previa (día+hora+nombre -> id y pagos) ANTES de tocar nada. Los
  // pagos se guardan por id de alumno, pero los ids se regeneran cada vez
  // que una clase se re-importa del calendario (tag perdido o duplicado).
  // Sin esta foto, cada re-importación deja los montos/pagos huérfanos y el
  // alumno aparece en cero. Al reimportar reutilizamos el id y los valores.
  const prevStudentByKey = {};
  const prevClassIdByKey = {};
  state.data.forEach(day => day.classes.forEach(cls => {
    prevClassIdByKey[day.iso + '|' + cls.time] = cls.id;
    cls.students.forEach(s => {
      prevStudentByKey[day.iso + '|' + cls.time + '|' + s.n.trim().toLowerCase()] = {
        id: s.id,
        paid: state.paid[s.id],
        amount: state.amounts[s.id],
        metodo: state.metodos[s.id],
        comprobante: state.comprobantes[s.id],
      };
    });
  }));

  // 1. clases previamente sincronizadas cuyo evento desapareció en GCal -> borrar en la app
  Object.keys(classIndex).forEach(classId => {
    const { day, cls } = classIndex[classId];
    if (cls.synced && !byTag[classId]) {
      cls.students.forEach(s => {
        delete state.paid[s.id];
        delete state.amounts[s.id];
        delete state.metodos[s.id];
        delete state.comprobantes[s.id];
      });
      day.classes.splice(day.classes.indexOf(cls), 1);
      delete classIndex[classId];
    }
  });

  // 2. push/pull por clase (título, hora, alumnos, pagos)
  Object.keys(classIndex).forEach(classId => {
    const { day, cls } = classIndex[classId];
    if (!cls.students.length) return;

    const ev = byTag[classId];
    const appTitle = buildTitle_(cls.students);
    const appStart = `${day.iso}T${cls.time}`;

    if (!ev) {
      const start = new Date(`${day.iso}T${cls.time}:00`);
      const end = new Date(start.getTime() + DEFAULT_DURATION_MIN * 60000);
      const created = cal.createEvent(appTitle, start, end, {
        description: buildDescription_(cls.students, state.paid, state.amounts, classId),
      });
      byTag[classId] = created;
      cls.synced = true;
      cls._syncTitle = appTitle;
      cls._syncTime = appStart;
      return;
    }

    const evTitle = ev.getTitle() || '';
    const evStart = ev.getStartTime();
    const evStartStr = `${isoDate_(evStart)}T${timeStr_(evStart)}`;

    const titleChangedInApp = appTitle !== cls._syncTitle;
    const titleChangedInCal = evTitle !== cls._syncTitle;
    const timeChangedInApp = appStart !== cls._syncTime;
    const timeChangedInCal = evStartStr !== cls._syncTime;

    if (timeChangedInCal && !timeChangedInApp) {
      // el horario cambió directo en el calendario -> lo adoptamos en la app
      const [newIso, newTime] = evStartStr.split('T');
      cls.time = newTime;
      if (dayByIso[newIso] && dayByIso[newIso] !== day) {
        day.classes.splice(day.classes.indexOf(cls), 1);
        dayByIso[newIso].classes.push(cls);
      }
    } else if (timeChangedInApp) {
      // horario editado en la app (o cambiado en ambos lados: gana la app)
      const durMin = Math.round((ev.getEndTime() - evStart) / 60000) || DEFAULT_DURATION_MIN;
      const newStart = new Date(`${day.iso}T${cls.time}:00`);
      try { ev.setTime(newStart, new Date(newStart.getTime() + durMin * 60000)); } catch (err) { /* evento de solo lectura */ }
    }

    if (titleChangedInCal && !titleChangedInApp) {
      // alumnos/tags cambiados directo en el calendario -> los adoptamos en la app
      const parsed = parseTitle_(evTitle);
      const byName = {};
      cls.students.forEach(s => { byName[s.n.toLowerCase()] = s; });
      const kept = [];
      parsed.forEach(p => {
        const existing = byName[p.n.toLowerCase()];
        if (existing) { existing.t = p.t; kept.push(existing); }
        else { kept.push({ id: nextStudentId(), n: p.n, t: p.t }); }
      });
      const keptIds = {};
      kept.forEach(s => { keptIds[s.id] = true; });
      cls.students.forEach(s => {
        if (!keptIds[s.id]) {
          delete state.paid[s.id];
          delete state.amounts[s.id];
          delete state.metodos[s.id];
          delete state.comprobantes[s.id];
        }
      });
      cls.students = kept;
    } else if (titleChangedInApp || evTitle !== appTitle) {
      // alumnos editados en la app (o el título de gcal no matchea lo esperado): la app manda
      if (evTitle !== appTitle) {
        try { ev.setTitle(appTitle); } catch (err) { /* evento de solo lectura */ }
      }
    }

    const wantDesc = buildDescription_(cls.students, state.paid, state.amounts, classId);
    if (ev.getDescription() !== wantDesc) {
      try { ev.setDescription(wantDesc); } catch (err) { /* evento de solo lectura */ }
    }

    cls.synced = true;
    cls._syncTitle = buildTitle_(cls.students);
    cls._syncTime = `${day.iso}T${cls.time}`;
  });

  // 3. eventos sin tag, o con un tag que no es de esta semana (ej. quedó
  // pegado de otra semana al copiarse una instancia recurrente) -> importar
  // como clase nueva de esta semana.
  const orphanTagged = Object.keys(byTag)
    .filter(tagId => !classIndex[tagId])
    .map(tagId => byTag[tagId]);
  const toImport = untagged.concat(orphanTagged);

  toImport.forEach(ev => {
    const iso = isoDate_(ev.getStartTime());
    const day = dayByIso[iso];
    if (!day) return; // fuera de la semana actual
    const time = timeStr_(ev.getStartTime());
    const parsed = parseTitle_(ev.getTitle() || '');
    if (!parsed.length) return;
    // Reutilizamos el id previo de la clase/alumnos en ese día+hora (si
    // existía) para no perder los pagos ya cargados: están guardados por id.
    const prevClassId = prevClassIdByKey[iso + '|' + time];
    const classId = (prevClassId && !classIndex[prevClassId]) ? prevClassId : nextClassId();
    const students = parsed.map(p => {
      const prev = prevStudentByKey[iso + '|' + time + '|' + p.n.trim().toLowerCase()];
      if (!prev) return { id: nextStudentId(), n: p.n, t: p.t };
      if (prev.paid !== undefined) state.paid[prev.id] = prev.paid;
      if (prev.amount !== undefined) state.amounts[prev.id] = prev.amount;
      if (prev.metodo !== undefined) state.metodos[prev.id] = prev.metodo;
      if (prev.comprobante !== undefined) state.comprobantes[prev.id] = prev.comprobante;
      return { id: prev.id, n: p.n, t: p.t };
    });
    const cls = {
      id: classId,
      time,
      students,
      synced: true,
      _syncTitle: buildTitle_(students),
      _syncTime: `${iso}T${time}`,
    };
    // Primero intentamos taggear el evento; si no se puede (evento ajeno /
    // invitación de solo lectura, ej. "Acción no permitida"), NO lo
    // importamos: sin tag se volvería a importar en cada sync, duplicándose.
    try {
      ev.setDescription(buildDescription_(students, state.paid, state.amounts, classId));
    } catch (err) {
      return;
    }
    day.classes.push(cls);
  });

  state.data.forEach(day => day.classes.sort((a, b) => a.time.localeCompare(b.time)));
  state.uid = uid;
  return state;
}
