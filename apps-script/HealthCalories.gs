/**
 * Athlete Data Hub: calories from Google Health (HealthCalories.gs)
 *
 * Adds two things to the hourly pull without touching the metrics engine:
 *  - 'GH Calories daily' rows in Raw: total kcal burned that day (Value) and
 *    the active part (Extra). The engine ignores this row type.
 *  - workout rows keep km in Extra; kcal and average heart rate ride in Unit
 *    as "km;kcal:455;hr:156".
 * A calorie failure is logged and skipped so it can never stop a pull.
 */

function healthPost_(path, body) {
  const r = UrlFetchApp.fetch(HEALTH_BASE + path, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + healthToken_() }, muteHttpExceptions: true,
  });
  return { code: r.getResponseCode(), text: r.getContentText() };
}

/** Daily kcal sums by civil date, asked 14 days at a time (the API's limit for total calories). */
function ghDailyKcal_(type, field, since) {
  const DAY = 86400000, out = {};
  const civ = t => { const d = new Date(t); return { date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } }; };
  const two = n => String(n).padStart(2, '0');
  const endKey = Utilities.formatDate(new Date(Date.now() + DAY), 'Asia/Seoul', 'yyyy-MM-dd');
  const end = new Date(endKey + 'T00:00:00Z').getTime();
  let a = new Date(since + 'T00:00:00Z').getTime();
  while (a < end) {
    const b = Math.min(a + 14 * DAY, end);
    const r = healthPost_('/users/me/dataTypes/' + type + '/dataPoints:dailyRollUp', { range: { start: civ(a), end: civ(b) }, windowSizeDays: 1 });
    if (r.code !== 200) throw new Error(type + ' rollup -> HTTP ' + r.code + ': ' + r.text.slice(0, 300));
    (JSON.parse(r.text || '{}').rollupDataPoints || []).forEach(p => {
      const d = (p.civilStartTime || {}).date || {};
      const v = Number((p[field] || {}).kcalSum);
      if (d.year && v > 0) out[d.year + '-' + two(d.month) + '-' + two(d.day)] = Math.round(v);
    });
    a = b;
  }
  return out;
}

function ghCalorieSamples_(since) {
  const out = [];
  try {
    const total = ghDailyKcal_('total-calories', 'totalCalories', since);
    let active = {};
    try { active = ghDailyKcal_('active-energy-burned', 'activeEnergyBurned', since); } catch (err) { Logger.log('active calories skipped: ' + err); }
    Object.keys(total).forEach(k => { const noon = new Date(k + 'T12:00:00+09:00'); out.push(ghSample_('GH Calories daily', noon, noon, total[k], 'kcal', active[k] || '')); });
  } catch (err) {
    Logger.log('calories skipped: ' + err);
  }
  return out;
}

/** Run once from the editor to see what Google returns. */
function testCalories() {
  const since = Utilities.formatDate(new Date(Date.now() - 3 * 86400000), 'UTC', 'yyyy-MM-dd');
  Logger.log(JSON.stringify(ghCalorieSamples_(since).map(s => [s.start, s.value, s.extra])));
}
