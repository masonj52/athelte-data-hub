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
 * Relies on Code.gs for: TAB, TZ, readConfig_, localParts, parseDate, num.
 * The site only reads, except for two small writes: a Push/Pull/Legs tag on a
 * Fitbit workout (Tags tab) and the weekly run goal (a script property). Calls writeCoachFeed_ (HealthApi.gs) if present.
 */

const WEB_TRIES_PER_LOCK = 5;   // wrong PINs before a timed lock
const WEB_LOCK_MINUTES = 60;    // length of the timed lock
const WEB_HARD_LOCK = 15;       // wrong PINs in a row before a lock only the sheet menu clears
const WEB_FEED_DAYS = 90;       // days of the Daily tab sent to the site
const WEB_TAGS = ['Push', 'Pull', 'Legs', 'ETC'];
const WEB_TAG_TAB = 'Tags';     // Key (workout start), Tag, Set at

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
    if (action === 'tag') {
      if (!webSetTag_(String(body.start || ''), String(body.tag || ''))) return webJson_({ ok: false, error: 'invalid' });
    } else if (action === 'goal') {
      if (!webSetRunGoal_(body.km)) return webJson_({ ok: false, error: 'invalid' });
    } else if (action !== 'feed') {
      return webJson_({ ok: false, error: 'bad_request' });
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
  let activity = { workouts: [], calories: {}, vitals: {} };
  try { activity = webActivity_(); } catch (err) { /* the feed still goes out without workouts */ }
  const goal = Number(PropertiesService.getScriptProperties().getProperty('WEB_RUN_GOAL'));
  return {
    ok: true,
    generated: new Date().toISOString(),
    daysOfData: total,
    status: String(readConfig_().HEALTH_STATUS || ''),
    head: cols ? sh.getRange(1, 1, 1, cols).getDisplayValues()[0] : [],
    days: n ? sh.getRange(2, 1, n, cols).getDisplayValues() : [],   // newest first, as the sheet shows them
    workouts: activity.workouts,
    calories: activity.calories,
    vitals: activity.vitals,
    runGoal: goal > 0 ? goal : null,
  };
}

/** Fitbit workouts, daily calories and nightly vitals from the Raw tab, last WEB_FEED_DAYS days. */
function webActivity_() {
  const out = { workouts: [], calories: {}, vitals: {} };
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.RAW);
  if (!sh || sh.getLastRow() < 2) return out;
  const tags = webReadTags_();
  const cutoff = Date.now() - WEB_FEED_DAYS * 86400000;
  const VITAL = { 'GH SpO2 daily': 'spo2', 'GH Breathing daily': 'br', 'GH Skin temp daily': 'temp' };
  const seen = {};
  sh.getRange(2, 2, sh.getLastRow() - 1, 6).getValues().forEach(r => {   // Type, Start, End, Value, Unit, Extra
    const type = String(r[0]);
    if (type !== 'GH Workout' && type !== 'GH Calories daily' && !VITAL[type]) return;
    const a = parseDate(r[1]), b = parseDate(r[2]);
    if (!a || a.getTime() < cutoff) return;
    if (type === 'GH Calories daily') { out.calories[localParts(a).key] = [num(r[3]), num(r[5])]; return; }
    if (VITAL[type]) { const k = localParts(a).key; (out.vitals[k] || (out.vitals[k] = {}))[VITAL[type]] = num(r[3]); return; }
    const start = Utilities.formatDate(a, TZ, 'yyyy-MM-dd HH:mm');
    if (seen[start]) return;
    seen[start] = true;
    const unit = String(r[4] || '');
    const pick = k => { const m = unit.match(new RegExp('(?:^|;)' + k + ':([0-9.]+)')); return m ? Number(m[1]) : null; };
    out.workouts.push({
      start: start, min: b ? Math.round((b - a) / 60000) : null,
      type: String(r[3] || 'OTHER'), km: num(r[5]), kcal: pick('kcal'), hr: pick('hr'), azm: pick('azm'),
      zones: [pick('zl'), pick('zm'), pick('zv'), pick('zp')], tag: tags[start] || '',
    });
  });
  out.workouts.sort((x, y) => (x.start < y.start ? 1 : -1));
  return out;
}

/* ───────────────────────── Tags and run goal ───────────────────────── */

function webTagSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(WEB_TAG_TAB);
  if (!sh) {
    sh = ss.insertSheet(WEB_TAG_TAB, ss.getSheets().length);
    sh.getRange(1, 1, 1, 3).setValues([['Key', 'Tag', 'Set at']]).setFontWeight('bold');
    sh.getRange('A:A').setNumberFormat('@');
    sh.setFrozenRows(1);
  }
  return sh;
}

function webReadTags_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(WEB_TAG_TAB), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(r => { if (r[0] && r[1]) out[r[0]] = r[1]; });
  return out;
}

/** Tag a workout by its start time ("yyyy-MM-dd HH:mm"); an empty tag clears it. */
function webSetTag_(start, tag) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(start)) return false;
  if (tag && WEB_TAGS.indexOf(tag) < 0) return false;
  const sh = webTagSheet_(), last = sh.getLastRow();
  const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const i = keys.indexOf(start);
  if (i >= 0) { if (tag) sh.getRange(i + 2, 2, 1, 2).setValues([[tag, new Date()]]); else sh.deleteRow(i + 2); }
  else if (tag) sh.getRange(last + 1, 1, 1, 3).setValues([[start, tag, new Date()]]);
  return true;
}

/** Weekly run goal in km; null or 0 hands it back to the app's own suggestion. */
function webSetRunGoal_(km) {
  const p = PropertiesService.getScriptProperties();
  if (km == null || km === 0) { p.deleteProperty('WEB_RUN_GOAL'); return true; }
  if (typeof km !== 'number' || !isFinite(km) || km < 1 || km > 150) return false;
  p.setProperty('WEB_RUN_GOAL', String(Math.round(km * 2) / 2));
  return true;
}
