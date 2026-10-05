/**
 * SIBER-UJIAN — device.js (v3)
 * 1. Identitas HP (DEVICE_ID acak, disimpan di IndexedDB).
 * 2. Catatan login siswa (online & offline) → dikirim ke guru saat online.
 * 3. Laporan HP ke guru: ujian yang sudah diunduh, jawaban yang masih tertahan.
 * 4. Ujian ulang: kiriman yang DIHAPUS guru ikut dihapus dari HP (hanya yang sudah terkirim).
 *
 * Semua fungsi di sini "diam": jika gagal, aplikasi tetap berjalan normal.
 */
const Device = (function () {
  'use strict';

  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const REPORT_GAP_MS = 3 * 60 * 1000;
  const PERIODIC_MS = 5 * 60 * 1000;
  const MAX_LOGINS = 200;

  let lastReportAt = 0;
  let running = false;
  let soonHandle = null;
  let serverHasFeature = true;

  function rand(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET.charAt(b[i] % ALPHABET.length);
    return s;
  }

  async function getId() {
    let id = await DB.getSetting('device_id');
    if (typeof id !== 'string' || !/^DEV-[A-Z0-9]{8,40}$/.test(id)) {
      id = 'DEV-' + rand(16);
      await DB.setSetting('device_id', id);
    }
    return id;
  }

  /** Ringkasan HP dari userAgent, misalnya "Android 13 · SM-A145F · Chrome 129". */
  function info() {
    const ua = navigator.userAgent || '';
    let os = 'Lainnya';
    let m;
    if ((m = ua.match(/Android\s([\d.]+)/))) os = 'Android ' + m[1].split('.')[0];
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    let model = '';
    if ((m = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/|\))/))) model = m[1].trim();
    if (model === 'K' || model === 'wv') model = '';
    let browser = '';
    if ((m = ua.match(/(?:SamsungBrowser)\/(\d+)/))) browser = 'Samsung Internet ' + m[1];
    else if ((m = ua.match(/(?:Edg)\/(\d+)/))) browser = 'Edge ' + m[1];
    else if ((m = ua.match(/(?:Firefox)\/(\d+)/))) browser = 'Firefox ' + m[1];
    else if ((m = ua.match(/(?:Chrome)\/(\d+)/))) browser = 'Chrome ' + m[1];
    else if (/Safari/.test(ua)) browser = 'Safari';
    return [os, model, browser].filter(Boolean).join(' · ').substring(0, 120);
  }

  /* ---------- Catatan login ---------- */

  async function recordLogin(mode, user) {
    try {
      if (!user || user.role !== 'STUDENT') return;
      const list = (await DB.getSetting('login_log_queue')) || [];
      list.push({
        login_id: 'LG-' + Date.now().toString(36).toUpperCase() + '-' + rand(6),
        at: new Date().toISOString(),
        user_id: user.user_id,
        mode: mode === 'OFFLINE' ? 'OFFLINE' : 'ONLINE'
      });
      await DB.setSetting('login_log_queue', list.slice(-MAX_LOGINS));
    } catch (e) {
      console.warn('Gagal mencatat login:', e);
    }
  }

  /* ---------- Laporan ke guru ---------- */

  async function buildPayload() {
    const users = (await DB.getAll('users'))
      .filter(function (u) { return u.role === 'STUDENT'; })
      .map(function (u) { return { user_id: u.user_id }; });
    const exams = (await DB.getAll('exams')).map(function (e) {
      return {
        exam_id: e.exam_id,
        version: e.package_version === null || e.package_version === undefined ? '' : String(e.package_version),
        ready: e.local_status === 'READY'
      };
    });
    const pendingList = (await DB.getAll('attempts'))
      .filter(function (a) { return a.status !== 'IN_PROGRESS' && a.sync_status !== 'SYNCED'; })
      .map(function (a) { return { user_id: a.user_id, exam_id: a.exam_id }; });
    const logins = (await DB.getSetting('login_log_queue')) || [];
    return {
      device_id: await getId(),
      device_info: info(),
      client_version: SIBER_CONFIG.CLIENT_VERSION,
      users: users.slice(0, 100),
      exams: exams.slice(0, 100),
      pending: pendingList.length,
      pending_list: pendingList.slice(0, 50),
      logins: logins.slice(0, MAX_LOGINS)
    };
  }

  async function report(force) {
    if (running || !serverHasFeature || !navigator.onLine) return;
    if (typeof Auth === 'undefined' || !Auth.isLoggedIn()) return;
    const st = Auth.getState();
    if (!st || st.user.role !== 'STUDENT' || !st.session_valid) return;
    if (Date.now() - lastReportAt < (force ? 20000 : REPORT_GAP_MS)) return;
    running = true;
    try {
      const payload = await buildPayload();
      const res = await Auth.authedCall('reportDevice', payload);
      lastReportAt = Date.now();
      if (res.success) {
        const sent = {};
        payload.logins.forEach(function (l) { sent[l.login_id] = true; });
        const now = (await DB.getSetting('login_log_queue')) || [];
        await DB.setSetting('login_log_queue', now.filter(function (l) { return !sent[l.login_id]; }));
        await DB.setSetting('device_last_report', new Date().toISOString());
      } else if (res.error && res.error.code === 'UNKNOWN_ACTION') {
        serverHasFeature = false; // server belum diperbarui: berhenti mencoba
      }
    } catch (e) {
      console.warn('Laporan HP gagal:', e);
    } finally {
      running = false;
    }
  }

  function reportSoon() {
    if (soonHandle) clearTimeout(soonHandle);
    soonHandle = setTimeout(function () { soonHandle = null; report(true); }, 2500);
  }

  /* ---------- Ujian ulang (kiriman dihapus guru) ---------- */

  function deleteAttemptLocal(attemptId) {
    return DB.transaction(['attempts', 'answers', 'timer_state', 'sync_queue'], 'readwrite', function (t, set) {
      t.objectStore('attempts').delete(attemptId);
      t.objectStore('timer_state').delete(attemptId);
      const r1 = t.objectStore('answers').index('attempt_id').openCursor(IDBKeyRange.only(attemptId));
      r1.onsuccess = function () { const c = r1.result; if (c) { c.delete(); c.continue(); } };
      const r2 = t.objectStore('sync_queue').index('attempt_id').openCursor(IDBKeyRange.only(attemptId));
      r2.onsuccess = function () { const c = r2.result; if (c) { c.delete(); c.continue(); } };
      set(true);
    });
  }

  /**
   * Menghapus dari HP attempt yang kirimannya sudah dihapus guru.
   * Aman: hanya attempt milik user ini, sudah selesai, dan SUDAH TERKIRIM.
   * @returns jumlah attempt yang dihapus
   */
  async function applyResets(user, serverExams) {
    let n = 0;
    if (!user || user.role !== 'STUDENT' || !Array.isArray(serverExams)) return 0;
    for (const e of serverExams) {
      const ids = Array.isArray(e.reset_attempts) ? e.reset_attempts : [];
      for (const id of ids) {
        try {
          const a = await DB.get('attempts', String(id));
          if (!a || a.user_id !== user.user_id || a.status === 'IN_PROGRESS' || a.sync_status !== 'SYNCED') continue;
          await deleteAttemptLocal(a.attempt_id);
          try { await DB.delSetting('flags:' + a.attempt_id); } catch (ignore) { /* tidak ada */ }
          n++;
        } catch (err) {
          console.warn('Gagal menghapus attempt lama ' + id + ':', err);
        }
      }
    }
    return n;
  }

  function init() {
    window.addEventListener('online', reportSoon);
    if (typeof Submit !== 'undefined' && Submit.onChange) Submit.onChange(reportSoon);
    setInterval(function () {
      if (document.visibilityState === 'visible') report(false);
    }, PERIODIC_MS);
  }

  return {
    getId: getId,
    info: info,
    recordLogin: recordLogin,
    report: report,
    reportSoon: reportSoon,
    applyResets: applyResets,
    init: init
  };
})();
