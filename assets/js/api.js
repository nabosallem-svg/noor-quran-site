/* Data layer for every page. Talks to Supabase over plain HTTPS (no SDK), or falls back to
   the visitor's localStorage when assets/js/config.js has no Supabase keys yet. */
(function () {
  var C = window.ITQAN_CONFIG || {};
  var URL_ = (C.SUPABASE_URL || '').replace(/\/+$/, '');
  var KEY = C.SUPABASE_ANON_KEY || '';
  var ONLINE = !!(URL_ && KEY);
  var SESSION_KEY = 'itqan_admin_session';
  var DEFAULT_SETTINGS = { slot_times: ['08:00', '09:30', '11:00', '14:00', '16:00', '17:30', '19:00', '20:30'], days_ahead: 14, closed_weekdays: [] };

  /* ───── helpers ───── */

  function digits(p) { return String(p || '').replace(/\D/g, ''); }

  // Turn what people type (01xxxxxxxxx, +20…, 0020…) into the form wa.me wants.
  function waNumber(p) {
    var d = digits(p);
    if (d.indexOf('00') === 0) d = d.slice(2);
    if (d.length === 11 && d.indexOf('01') === 0) d = '2' + d;
    return d;
  }
  function waLink(phone, text) {
    return 'https://wa.me/' + waNumber(phone) + (text ? '?text=' + encodeURIComponent(text) : '');
  }
  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // Wall-clock "now" in Mecca, the time zone the booking page shows.
  function siteNow() {
    try {
      var p = {};
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
      return { date: p.year + '-' + p.month + '-' + p.day, time: p.hour + ':' + p.minute };
    } catch (e) {
      var n = new Date();
      return { date: isoDate(n), time: String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0') };
    }
  }
  function lsGet(k, def) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function fileName(prefix, file) {
    var ext = ((file && file.name) || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ext || ext.length > 5) ext = (file && file.type && file.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '').slice(0, 5);
    return prefix + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  }

  /* ───── HTTP ───── */

  function headers(token, extra) {
    var h = { apikey: KEY };
    // New-style publishable keys (sb_publishable_…) go only in apikey; old anon keys are JWTs and also go in Authorization.
    if (token || KEY.indexOf('eyJ') === 0) h.Authorization = 'Bearer ' + (token || KEY);
    for (var k in extra || {}) h[k] = extra[k];
    return h;
  }
  function call(method, path, body, opt) {
    opt = opt || {};
    var h = headers(opt.token, opt.headers);
    var init = { method: method, headers: h };
    if (body !== undefined) {
      if (opt.raw) { init.body = body; }
      else { init.body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    }
    return fetch(URL_ + path, init).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
        if (!r.ok) {
          var err = new Error((data && (data.message || data.error_description || data.msg || data.error)) || ('HTTP ' + r.status));
          err.status = r.status; err.data = data;
          throw err;
        }
        return data;
      });
    });
  }
  function rpc(fn, args, token) { return call('POST', '/rest/v1/rpc/' + fn, args || {}, { token: token }); }
  function upload(path, file) {
    return call('POST', '/storage/v1/object/uploads/' + path, file, { raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' } })
      .then(function () { return path; });
  }

  /* ───── public site ───── */

  var api = {
    online: ONLINE,
    whatsapp: C.WHATSAPP || '201287654219',
    payNumber: C.PAY_NUMBER || '01287654219',
    waNumber: waNumber,
    waLink: waLink,
    isoDate: isoDate,
    siteNow: siteNow
  };

  api.settings = function () {
    if (!ONLINE) return Promise.resolve(lsGet('itqan_settings_v1', DEFAULT_SETTINGS));
    return rpc('public_settings').then(function (s) { return s || DEFAULT_SETTINGS; });
  };

  // → { 'YYYY-MM-DD': { '09:30': true, '*': true } }
  api.takenSlots = function (from, to) {
    if (!ONLINE) {
      var out = {};
      lsGet('itqan_books_v1', []).forEach(function (b) {
        if (b.status === 'cancelled' || !b.date) return;
        (out[b.date] = out[b.date] || {})[b.time] = true;
      });
      return Promise.resolve(out);
    }
    return rpc('taken_slots', { d_from: from, d_to: to }).then(function (rows) {
      var out = {};
      (rows || []).forEach(function (r) { (out[r.slot_date] = out[r.slot_date] || {})[r.slot_time] = true; });
      return out;
    });
  };

  // Rejects with err.code = 'SLOT_TAKEN' | 'BAD_SLOT' | 'NETWORK'
  api.book = function (b) {
    if (!ONLINE) {
      var arr = lsGet('itqan_books_v1', []);
      if (arr.some(function (x) { return x.date === b.date && x.time === b.time && x.status !== 'cancelled'; })) {
        var e = new Error('SLOT_TAKEN'); e.code = 'SLOT_TAKEN'; return Promise.reject(e);
      }
      var id = arr.length + 1;
      arr.push({ id: id, name: b.name, phone: b.phone, age: b.age, country: b.country, prog: b.program, date: b.date, time: b.time, status: 'new', at: new Date().toISOString() });
      lsSet('itqan_books_v1', arr);
      return Promise.resolve({ id: id });
    }
    return rpc('book_slot', { p_date: b.date, p_time: b.time, p_name: b.name, p_phone: b.phone, p_age: b.age || null, p_country: b.country || null, p_program: b.program || null })
      .catch(function (err) {
        var m = String(err.message || '');
        err.code = m.indexOf('SLOT_TAKEN') > -1 ? 'SLOT_TAKEN' : m.indexOf('BAD_SLOT') > -1 ? 'BAD_SLOT' : 'NETWORK';
        throw err;
      });
  };

  api.studentByCode = function (code) {
    code = String(code || '').trim().toUpperCase();
    if (!ONLINE) {
      var s = lsGet('itqan_students_v1', {})[code];
      return Promise.resolve(s ? {
        code: code, name: s.name, track: s.track || s.prog, teacher: s.teacher || 'معلم المقرأة', progress: s.progress != null ? s.progress : s.pct,
        sessions_done: s.sessions_done || 0, new_task: s.new_task, recent_review: s.recent_review, far_review: s.far_review,
        teacher_note: s.teacher_note, next_session: s.next_session
      } : null);
    }
    return rpc('student_by_code', { p_code: code });
  };

  // Upload failures never block the form: the record is still saved without the file.
  function withUpload(prefix, file) {
    if (!ONLINE || !file) return Promise.resolve(null);
    return upload(fileName(prefix, file), file).catch(function () { return null; });
  }

  api.submitPayment = function (p, file) {
    if (!ONLINE) {
      var arr = lsGet('itqan_pays', []);
      arr.push({ name: p.name, phone: p.phone, pak: p.plan, method: p.method, at: new Date().toISOString() });
      lsSet('itqan_pays', arr);
      return Promise.resolve({ id: arr.length });
    }
    return withUpload('receipts', file).then(function (path) {
      return rpc('submit_payment', { p_name: p.name, p_phone: p.phone, p_plan: p.plan, p_method: p.method, p_receipt_path: path });
    });
  };

  api.submitLevelTest = function (t, audio) {
    if (!ONLINE) {
      lsSet('itqan_level', { finished: true, at: Date.now(), name: t.name, phone: t.phone });
      return Promise.resolve({ id: 1 });
    }
    return withUpload('recitations', audio).then(function (path) {
      return rpc('submit_level_test', {
        p_name: t.name, p_phone: t.phone, p_age_group: t.age_group, p_memorized: t.memorized,
        p_tajweed: t.tajweed, p_timezone: t.timezone, p_period: t.period, p_audio_path: path
      });
    });
  };

  /* ───── admin (admin.html) ───── */

  var admin = api.admin = {};

  function saveSession(s) {
    if (s && s.access_token) {
      s.expires_at = s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600);
      lsSet(SESSION_KEY, { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, email: s.user && s.user.email || s.email });
    }
    return lsGet(SESSION_KEY, null);
  }
  function token() {
    var s = lsGet(SESSION_KEY, null);
    if (!s) return Promise.reject(Object.assign(new Error('SIGNED_OUT'), { code: 'SIGNED_OUT' }));
    if (s.expires_at - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
    return call('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      .then(function (n) { return saveSession(n).access_token; })
      .catch(function (e) { admin.signOut(); e.code = 'SIGNED_OUT'; throw e; });
  }
  function authed(method, path, body, extraHeaders) {
    return token().then(function (t) { return call(method, path, body, { token: t, headers: extraHeaders }); });
  }

  admin.session = function () { return lsGet(SESSION_KEY, null); };
  admin.signIn = function (email, password) {
    return call('POST', '/auth/v1/token?grant_type=password', { email: email, password: password })
      .then(saveSession)
      .then(function () { return token().then(function (t) { return rpc('claim_admin', {}, t); }); })
      .then(function (ok) {
        if (!ok) { admin.signOut(); throw Object.assign(new Error('NOT_ADMIN'), { code: 'NOT_ADMIN' }); }
        return admin.session();
      });
  };
  // Creates the account. Resolves 'signed_in' when Supabase skips email confirmation, else 'confirm_email'.
  admin.signUp = function (email, password) {
    return call('POST', '/auth/v1/signup', { email: email, password: password }).then(function (r) {
      if (r && r.access_token) return admin.signIn(email, password).then(function () { return 'signed_in'; });
      return 'confirm_email';
    });
  };
  admin.signOut = function () {
    var s = lsGet(SESSION_KEY, null);
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    if (s && ONLINE) call('POST', '/auth/v1/logout', {}, { token: s.access_token }).catch(function () {});
  };
  // query: PostgREST string such as 'select=*&order=created_at.desc&limit=200'
  admin.list = function (table, query) { return authed('GET', '/rest/v1/' + table + '?' + (query || 'select=*')); };
  admin.insert = function (table, row) { return authed('POST', '/rest/v1/' + table, row, { Prefer: 'return=representation' }).then(function (r) { return r && r[0]; }); };
  admin.update = function (table, match, patch) { return authed('PATCH', '/rest/v1/' + table + '?' + match, patch, { Prefer: 'return=representation' }); };
  admin.remove = function (table, match) { return authed('DELETE', '/rest/v1/' + table + '?' + match); };
  admin.rpc = function (fn, args) { return token().then(function (t) { return rpc(fn, args, t); }); };
  admin.fileUrl = function (path) {
    return authed('POST', '/storage/v1/object/sign/uploads/' + path, { expiresIn: 3600 })
      .then(function (r) { return URL_ + '/storage/v1' + (r.signedURL || r.signedUrl); });
  };

  window.ItqanAPI = api;
})();
