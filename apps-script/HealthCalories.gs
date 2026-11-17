/**
 * Athlete Data Hub: calories from Google Health (HealthCalories.gs)
 *
 * Adds two things to the hourly pull without touching the metrics engine:
 *  - 'GH Calories daily' rows in Raw: total kcal burned that day (Value) and
 *    the active part (Extra). The engine ignores this row type.
 *  - workout rows keep km in Extra; kcal, average heart rate, zone minutes ride
 *    in Unit as "km;kcal:455;hr:156;azm:15;zl:84;zm:14".
 *  - nightly blood oxygen, breathing rate and skin temperature rows.
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
  ghVitalSamples_(since).forEach(s => out.push(s));
  return out;
}

/**
 * Nightly vitals the engine does not use: blood oxygen, breathing rate and skin
 * temperature (stored as the difference from Fitbit's own baseline).
 */
function ghVitalSamples_(since) {
  const out = [];
  const each = (type, field, fn) => {
    try {
      healthList_(type, type.replace(/-/g, '_') + '.date >= "' + since + '"').forEach(p => {
        const x = p[field] || {};
        if (x.date) fn(x, ghNoon_(x.date));
      });
    } catch (err) { Logger.log(type + ' skipped: ' + err); }
  };
  each('daily-oxygen-saturation', 'dailyOxygenSaturation', (x, t) => {
    const v = Number(x.averagePercentage);
    if (v > 0) out.push(ghSample_('GH SpO2 daily', t, t, Math.round(v * 10) / 10, '%', Number(x.lowerBoundPercentage) || ''));
  });
  each('daily-respiratory-rate', 'dailyRespiratoryRate', (x, t) => {
    const v = Number(x.breathsPerMinute);
    if (v > 0) out.push(ghSample_('GH Breathing daily', t, t, Math.round(v * 10) / 10, 'br/min'));
  });
  each('daily-sleep-temperature-derivations', 'dailySleepTemperatureDerivations', (x, t) => {
    const n = Number(x.nightlyTemperatureCelsius), b = Number(x.baselineTemperatureCelsius);
    if (n > 0 && b > 0) out.push(ghSample_('GH Skin temp daily', t, t, Math.round((n - b) * 100) / 100, 'C vs baseline', Math.round(n * 100) / 100));
  });
  return out;
}

/** Everything about a workout beyond distance, packed into the Unit column. */
function ghWorkoutUnit_(e) {
  const ms = e.metricsSummary || {}, z = ms.heartRateZoneDurations || {};
  const mins = v => Math.round((parseFloat(v) || 0) / 60);
  const parts = ['km'];
  const add = (k, v) => { if (v > 0) parts.push(k + ':' + Math.round(v)); };
  add('kcal', Number(ms.caloriesKcal)); add('hr', Number(ms.averageHeartRateBeatsPerMinute)); add('azm', Number(ms.activeZoneMinutes));
  add('zl', mins(z.lightTime)); add('zm', mins(z.moderateTime)); add('zv', mins(z.vigorousTime)); add('zp', mins(z.peakTime));
  return parts.join(';');
}

/** Run once from the editor to see what Google returns. */
function testCalories() {
  const since = Utilities.formatDate(new Date(Date.now() - 3 * 86400000), 'UTC', 'yyyy-MM-dd');
  Logger.log(JSON.stringify(ghCalorieSamples_(since).map(s => [s.start, s.value, s.extra])));
}
