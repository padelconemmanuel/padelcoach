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
      const store = getStore_();
      store.weeks[mondayIso] = { data: body.data, paid: body.paid, amounts: body.amounts };
      if (typeof body.uid === 'number' && body.uid > store.uid) store.uid = body.uid;
      saveStore_(store);
      return jsonOut_(stateResponse_(mondayIso));
    }
    return jsonOut_({ ok: false, error: 'acción desconocida' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
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

/* ── trigger periódico (configurar manualmente: cada 15 min) ─────── */

function syncTick() {
  reconcile_(isoDate_(mondayOf_(new Date())));
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
    weeks: { [weekStart]: { data: parsed.data || [], paid: parsed.paid || {}, amounts: parsed.amounts || {} } },
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
  const merged = { data: weekState.data, paid: weekState.paid || {}, amounts: weekState.amounts || {}, uid: store.uid };

  const result = syncWithCalendar_(merged, monday);

  store.weeks[mondayIso] = { data: result.data, paid: result.paid, amounts: result.amounts };
  store.uid = result.uid;
  saveStore_(store);

  return { data: result.data, paid: result.paid, amounts: result.amounts, uid: store.uid };
}

function seedWeek_(monday) {
  const data = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    data.push({ day: DIAS[i], date: fmtFecha_(d), iso: isoDate_(d), classes: [] });
  }
  return { data, paid: {}, amounts: {} };
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

  // 1. clases previamente sincronizadas cuyo evento desapareció en GCal -> borrar en la app
  Object.keys(classIndex).forEach(classId => {
    const { day, cls } = classIndex[classId];
    if (cls.synced && !byTag[classId]) {
      cls.students.forEach(s => { delete state.paid[s.id]; delete state.amounts[s.id]; });
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
      ev.setTime(newStart, new Date(newStart.getTime() + durMin * 60000));
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
        if (!keptIds[s.id]) { delete state.paid[s.id]; delete state.amounts[s.id]; }
      });
      cls.students = kept;
    } else if (titleChangedInApp || evTitle !== appTitle) {
      // alumnos editados en la app (o el título de gcal no matchea lo esperado): la app manda
      if (evTitle !== appTitle) ev.setTitle(appTitle);
    }

    const wantDesc = buildDescription_(cls.students, state.paid, state.amounts, classId);
    if (ev.getDescription() !== wantDesc) ev.setDescription(wantDesc);

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
    const classId = nextClassId();
    const parsed = parseTitle_(ev.getTitle() || '');
    if (!parsed.length) return;
    const students = parsed.map(p => ({ id: nextStudentId(), n: p.n, t: p.t }));
    const cls = {
      id: classId,
      time: timeStr_(ev.getStartTime()),
      students,
      synced: true,
      _syncTitle: buildTitle_(students),
      _syncTime: `${iso}T${timeStr_(ev.getStartTime())}`,
    };
    day.classes.push(cls);
    ev.setDescription(buildDescription_(students, state.paid, state.amounts, classId));
  });

  state.data.forEach(day => day.classes.sort((a, b) => a.time.localeCompare(b.time)));
  state.uid = uid;
  return state;
}
