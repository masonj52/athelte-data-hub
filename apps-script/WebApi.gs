/**
 * Athlete Data Hub: website API (WebApi.gs)
 *
 * The GitHub Pages site talks to this file and nothing else. Every request
 * carries the 4-digit PIN; the PIN is checked here, on Google's side, and
 * wrong guesses lock the door. No health data lives in the website's code.
 *
 * Install: add this as a new file in the Athlete Data Hub Apps Script project,
 * delete the old doGet / doPost / parseBody_ from Code.gs, add the two menu
 * items (see README), then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone).
 *
 * Relies on Code.gs for: TAB, TZ, SHIFT_OPTIONS, SESSION_OPTIONS, readConfig_,
 * recompute, logDateKey, localParts, parseDate, num. Calls writeCoachFeed_ (HealthApi.gs) if present.
 */

const WEB_TRIES_PER_LOCK = 5;   // wrong PINs before a timed lock
const WEB_LOCK_MINUTES = 60;    // length of the timed lock
const WEB_HARD_LOCK = 15;       // wrong PINs in a row before a lock only the sheet menu clears
const WEB_FEED_DAYS = 90;       // days of the Daily tab sent to the site
const WEB_LOG_COLS = 10;        // Log tab columns A..J; J holds a row id for the site

function doGet() {
  return webJson_({ ok: false, error: 'post_only' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}') || {};
  } catch (err) {
    return webJson_({ ok: false, error: 'bad_request' });
  }
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return webJson_({ ok: false, error: 'busy' }); }
  try {
    const gate = webCheckPin_(body.pin);
    if (!gate.ok) return webJson_(gate);
    const action = String(body.action || 'feed');
    if (action === 'pull') {
      // Live refresh: fetch the last 2 days from Google Health, recompute, then send the feed.
      lock.releaseLock();
      try { pullHealth(2); } catch (err) { return webJson_({ ok: false, error: 'pull_failed' }); }
      return webJson_(webFeed_());
    }
    if (action === 'save') {
      if (!webSaveEntry_(body.entry || {})) return webJson_({ ok: false, error: 'invalid' });
    } else if (action === 'delete') {
      webDeleteEntry_(String(body.id || ''));
    } else if (action !== 'feed') {
      return webJson_({ ok: false, error: 'bad_request' });
    }
    if (action !== 'feed') {
      recompute();
      try { writeCoachFeed_(); } catch (err) { /* the coach feed catches up on the next pull */ }
    }
    return webJson_(webFeed_());
  } catch (err) {
    return webJson_({ ok: false, error: 'server' });
  } finally {
    lock.releaseLock();
  }
}

function webJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────────────────────── PIN gate ───────────────────────── */

function webHash_(salt, pin) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function webCheckPin_(pin) {
  const p = PropertiesService.getScriptProperties();
  const hash = p.getProperty('WEB_PIN_HASH'), salt = p.getProperty('WEB_PIN_SALT');
  if (!hash || !salt) return { ok: false, error: 'no_pin' };
  const now = Date.now();
  const fails = Number(p.getProperty('WEB_FAILS') || 0);
  const until = Number(p.getProperty('WEB_LOCK_UNTIL') || 0);
  if (fails >= WEB_HARD_LOCK) return { ok: false, error: 'locked', manual: true };
  if (until > now) return { ok: false, error: 'locked', minutes: Math.ceil((until - now) / 60000) };
  if (/^\d{4}$/.test(String(pin || '')) && webHash_(salt, String(pin)) === hash) {
    if (fails || until) { p.deleteProperty('WEB_FAILS'); p.deleteProperty('WEB_LOCK_UNTIL'); }
    return { ok: true };
  }
  const n = fails + 1;
  p.setProperty('WEB_FAILS', String(n));
  if (n >= WEB_HARD_LOCK) return { ok: false, error: 'locked', manual: true };
  if (n % WEB_TRIES_PER_LOCK === 0) {
    p.setProperty('WEB_LOCK_UNTIL', String(now + WEB_LOCK_MINUTES * 60000));
    return { ok: false, error: 'locked', minutes: WEB_LOCK_MINUTES };
  }
  return { ok: false, error: 'bad_pin', left: WEB_TRIES_PER_LOCK - (n % WEB_TRIES_PER_LOCK) };
}

/** Sheet menu: Athlete Hub > Set website PIN. Only the hash is stored. */
function setWebPin() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Website PIN', 'Enter a new 4-digit PIN for the website.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const pin = res.getResponseText().trim();
  if (!/^\d{4}$/.test(pin)) { ui.alert('The PIN must be exactly 4 digits. Nothing was changed.'); return; }
  const salt = Utilities.getUuid();
  const p = PropertiesService.getScriptProperties();
  p.setProperty('WEB_PIN_SALT', salt);
  p.setProperty('WEB_PIN_HASH', webHash_(salt, pin));
  p.deleteProperty('WEB_FAILS');
  p.deleteProperty('WEB_LOCK_UNTIL');
  ui.alert('Website PIN saved.');
}

/** Sheet menu: Athlete Hub > Unlock website. Clears a lock after wrong PINs. */
function unlockWeb() {
  const p = PropertiesService.getScriptProperties();
  const fails = Number(p.getProperty('WEB_FAILS') || 0);
  p.deleteProperty('WEB_FAILS');
  p.deleteProperty('WEB_LOCK_UNTIL');
  try {
    SpreadsheetApp.getUi().alert('Website unlocked. Wrong PINs since your last visit: ' + fails +
      (fails >= WEB_TRIES_PER_LOCK ? '. If that was not you, set a new PIN and make a new deployment so the address changes.' : '.'));
  } catch (err) { /* run from the editor */ }
}

/* ───────────────────────── Feed ───────────────────────── */

function webFeed_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.DAILY);
  const total = Math.max(sh.getLastRow() - 1, 0), cols = sh.getLastColumn();
  const n = Math.min(total, WEB_FEED_DAYS);
  let activity = { workouts: [], calories: {} };
  try { activity = webActivity_(); } catch (err) { /* the feed still goes out without workouts */ }
  return {
    ok: true,
    generated: new Date().toISOString(),
    daysOfData: total,
    status: String(readConfig_().HEALTH_STATUS || ''),
    head: cols ? sh.getRange(1, 1, 1, cols).getDisplayValues()[0] : [],
    days: n ? sh.getRange(2, 1, n, cols).getDisplayValues() : [],   // newest first, as the sheet shows them
    log: webReadLog_(),
    workouts: activity.workouts,
    calories: activity.calories,
  };
}

/** Fitbit workouts and daily calories from the Raw tab, last WEB_FEED_DAYS days. */
function webActivity_() {
  const out = { workouts: [], calories: {} };
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.RAW);
  if (!sh || sh.getLastRow() < 2) return out;
  const cutoff = Date.now() - WEB_FEED_DAYS * 86400000;
  sh.getRange(2, 2, sh.getLastRow() - 1, 6).getValues().forEach(r => {   // Type, Start, End, Value, Unit, Extra
    const type = String(r[0]);
    if (type !== 'GH Workout' && type !== 'GH Calories daily') return;
    const a = parseDate(r[1]), b = parseDate(r[2]);
    if (!a || a.getTime() < cutoff) return;
    if (type === 'GH Calories daily') {
      out.calories[localParts(a).key] = [num(r[3]), num(r[5])];
      return;
    }
    const unit = String(r[4] || '');
    const pick = k => { const m = unit.match(new RegExp(k + ':([0-9.]+)')); return m ? Number(m[1]) : null; };
    out.workouts.push({
      start: Utilities.formatDate(a, TZ, 'yyyy-MM-dd HH:mm'),
      min: b ? Math.round((b - a) / 60000) : null,
      type: String(r[3] || 'OTHER'), km: num(r[5]), kcal: pick('kcal'), hr: pick('hr'),
    });
  });
  out.workouts.sort((x, y) => (x.start < y.start ? 1 : -1));
  return out;
}

/* ───────────────────────── Log tab ───────────────────────── */

function webLogSheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.LOG);
  if (sh.getRange(1, WEB_LOG_COLS).getValue() !== 'Id') sh.getRange(1, WEB_LOG_COLS).setValue('Id').setFontWeight('bold');
  return sh;
}

function webReadLog_() {
  const sh = webLogSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const out = [];
  sh.getRange(2, 1, last - 1, WEB_LOG_COLS).getValues().forEach((r, i) => {
    if (r[0] === '') return;
    const date = logDateKey(r[0]);
    if (!date) return;
    if (!r[9]) { r[9] = Utilities.getUuid().slice(0, 8); sh.getRange(i + 2, WEB_LOG_COLS).setValue(r[9]); }
    out.push({
      id: String(r[9]), date: date, shift: String(r[1] || ''), type: String(r[2] || ''),
      minutes: num(r[3]), rpe: num(r[4]), km: num(r[5]),
      glute: num(r[6]) || 0, shoulder: num(r[7]) || 0, notes: String(r[8] || ''),
    });
  });
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out.slice(0, 400);
}

function webFindRow_(sh, id) {
  if (!id) return 0;
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, WEB_LOG_COLS, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}

/** Validates everything the site sends; returns false instead of writing a bad row. */
function webSaveEntry_(x) {
  const date = String(x.date || '');
  const type = String(x.type || ''), shift = String(x.shift || '');
  const within = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
  const rest = type === 'Rest';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T12:00:00+09:00'))) return false;
  if (SESSION_OPTIONS.indexOf(type) < 0) return false;
  if (shift && SHIFT_OPTIONS.indexOf(shift) < 0) return false;
  if (!rest && (!within(x.minutes, 1, 600) || !within(x.rpe, 1, 10))) return false;
  if (x.km != null && !within(x.km, 0, 100)) return false;
  if (!within(x.glute, 0, 10) || !within(x.shoulder, 0, 10)) return false;
  let notes = String(x.notes || '').slice(0, 200);
  if (/^[=+\-@]/.test(notes)) notes = "'" + notes;              // never let a note become a formula

  const sh = webLogSheet_();
  const id = String(x.id || '');
  let row = webFindRow_(sh, id);
  if (id && !row) return false;
  if (!row) row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, WEB_LOG_COLS).setValues([[
    new Date(date + 'T12:00:00+09:00'), shift, type,
    rest ? '' : Math.round(x.minutes), rest ? '' : Math.round(x.rpe),
    x.km == null ? '' : x.km, Math.round(x.glute), Math.round(x.shoulder), notes,
    id || Utilities.getUuid().slice(0, 8),
  ]]);
  return true;
}

function webDeleteEntry_(id) {
  const sh = webLogSheet_();
  const row = webFindRow_(sh, id);
  if (row) sh.deleteRow(row);
}
