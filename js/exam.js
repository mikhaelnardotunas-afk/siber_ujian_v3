/**
 * SIBER-UJIAN — exam.js
 * Mengerjakan ujian MODE TOTAL, PER_SOAL, dan FIXED.
 *
 * ATURAN WAJIB (semua mode):
 *  - Setiap jawaban LANGSUNG disimpan ke IndexedDB saat dipilih.
 *  - Waktu dihitung dari timestamp tersimpan + jam efektif (Timer.now), bukan setInterval.
 *  - Urutan soal/pilihan dibuat sekali saat mulai dan tidak pernah berubah.
 *  - Ujian yang sudah selesai tidak dapat dibuka kembali.
 *
 * MODE PER_SOAL:
 *  - Setiap soal punya waktu sendiri; tidak boleh maju sebelum habis; tidak boleh kembali.
 *  - Jawaban untuk soal yang sudah terkunci DITOLAK oleh database.
 *
 * MODE FIXED:
 *  - Setiap soal punya waktu MINIMAL. Selama waktu soal berjalan, siswa tidak boleh pindah soal.
 *  - Setelah waktu soal habis, siswa boleh pindah: kembali ke soal sebelumnya,
 *    mengganti jawaban, atau membuka soal berikutnya (yang memulai waktu minimal soal itu).
 *  - Ada waktu keseluruhan = jumlah soal x waktu per soal + 5%. Saat habis, ujian selesai otomatis.
 *  - "Selesai ujian" baru bisa ditekan setelah semua soal dibuka dan waktu minimal soal terakhir habis.
 *
 * ANTI-KECURANGAN:
 *  - Keluar dari layar ujian (pindah tab/aplikasi, layar mati), aplikasi ditutup lalu dibuka,
 *    dan keluar dari layar penuh dicatat sebagai pelanggaran dan ditampilkan ke siswa.
 *
 * TOKEN:
 *  - Ujian bertoken hanya bisa dimulai jika token membuka paket soal.
 *  - Token TIDAK disimpan; yang disimpan di attempt hanyalah kunci paket.
 */
const Exam = (function () {
  'use strict';

  const HEARTBEAT_MS = 5000;
  const SAVE_GRACE_MS = 2000;
  const RESUME_BACKWARD_TOLERANCE_MS = 5000;
  const CLOSED_GAP_REPORT_MS = 60000;
  const MAX_CLOCK_EVENTS = 100;
  const MAX_VIOLATION_EVENTS = 200;
  const EXAM_LOCK_NAME = 'siber-ujian-exam';
  const TOKEN_MAX_FAIL = 5;
  const TOKEN_LOCK_MS = 60000;

  const $ = UI.$;
  const el = UI.el;

  const REASON_TEXT = {
    MANUAL: 'Diselesaikan siswa',
    TIME_UP: 'Waktu ujian habis',
    ALL_DONE: 'Semua soal selesai (waktu soal terakhir habis)',
    DATA_ERROR: 'Ditutup karena data di perangkat rusak'
  };

  const MODE_TEXT = { TOTAL: 'Total', PER_SOAL: 'Per soal', FIXED: 'Fixed' };

  let hooks = {};
  let S = null;
  let pendingIntro = null;
  let startBusy = false;
  let heartbeatHandle = null;
  let noticeHandle = null;
  let saveChain = Promise.resolve();
  let saveSeq = 0;
  let releaseLockFn = null;
  let wakeLock = null;

  function fail(code, message) { return { ok: false, code: code, message: message }; }
  function failRes(code, message) { return { success: false, error: { code: code, message: message } }; }
  function isPerQ() { return !!S && S.attempt.mode === 'PER_SOAL'; }
  function isFixed() { return !!S && S.attempt.mode === 'FIXED'; }
  function makeError(code, message) { const e = new Error(message); e.code = code; return e; }

  function extraPercent() {
    const p = Number(SIBER_CONFIG.FIXED_EXTRA_PERCENT);
    return isFinite(p) && p >= 0 ? p : 5;
  }

  /** Mode FIXED: waktu total (ms) = jumlah soal x waktu per soal, ditambah persen cadangan. */
  function fixedTotalMs(perQuestionSeconds, questionCount) {
    return Math.ceil(perQuestionSeconds * questionCount * (1 + extraPercent() / 100)) * 1000;
  }

  /* =========================================================
   * KUNCI SATU TAB, LAYAR MENYALA, LAYAR PENUH
   * ========================================================= */

  function acquireExamLock() {
    if (releaseLockFn) return Promise.resolve(true);
    if (!navigator.locks || !navigator.locks.request) return Promise.resolve(true);
    return new Promise(function (resolve) {
      navigator.locks.request(EXAM_LOCK_NAME, { ifAvailable: true }, function (lock) {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise(function (release) { releaseLockFn = release; });
      }).catch(function () { resolve(true); });
    });
  }

  function releaseExamLock() {
    if (releaseLockFn) {
      releaseLockFn();
      releaseLockFn = null;
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', function () { wakeLock = null; });
      }
    } catch (e) { /* tidak didukung atau ditolak */ }
  }

  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* abaikan */ }
    wakeLock = null;
  }

  function fullscreenSupported() {
    return !!(SIBER_CONFIG.FULLSCREEN && document.documentElement.requestFullscreen && document.fullscreenEnabled);
  }

  /** Harus dipanggil langsung dari klik tombol (aturan browser). */
  function requestFullscreen() {
    if (!fullscreenSupported() || document.fullscreenElement) return;
    try {
      const p = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (p && p.catch) p.catch(function () { /* ditolak browser */ });
    } catch (e) { /* abaikan */ }
  }

  function exitFullscreen() {
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        const p = document.exitFullscreen();
        if (p && p.catch) p.catch(function () { /* abaikan */ });
      }
    } catch (e) { /* abaikan */ }
  }

  function renderFullscreenButton() {
    const b = $('btn-fullscreen');
    if (!b) return;
    b.hidden = !S || S.finishing || !fullscreenSupported() || !!document.fullscreenElement;
  }

  /* =========================================================
   * DATA
   * ========================================================= */

  function makeAttemptId(userId) {
    const rnd = new Uint8Array(6);
    crypto.getRandomValues(rnd);
    const hex = Array.from(rnd).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('').toUpperCase();
    const uid = String(userId).replace(/[^A-Za-z0-9]/g, '').substring(0, 16);
    return 'ATT-' + uid + '-' + Date.now().toString(36).toUpperCase() + '-' + hex;
  }

  async function getUserAttempts(userId) {
    const list = await DB.getAllByIndex('attempts', 'user_id', userId);
    const map = {};
    list.forEach(function (a) {
      if (!map[a.exam_id] || a.status === 'IN_PROGRESS') map[a.exam_id] = a;
    });
    return map;
  }

  async function findInProgress(userId) {
    const list = await DB.getAllByIndex('attempts', 'user_id', userId);
    return list.find(function (a) { return a.status === 'IN_PROGRESS'; }) || null;
  }

  async function countUnsyncedAttempts() {
    const list = await DB.getAll('attempts');
    return list.filter(function (a) { return a.sync_status !== 'SYNCED'; }).length;
  }

  async function checkCanStart(user, examId) {
    if (user.role !== 'STUDENT') return fail('NOT_STUDENT', 'Hanya akun siswa yang dapat mengerjakan ujian.');

    const exam = await DB.get('exams', examId);
    if (!exam) return fail('EXAM_NOT_FOUND', 'Data ujian tidak ada di perangkat.');
    if (exam.grade !== user.grade) return fail('FORBIDDEN_EXAM', 'Ujian ini bukan untuk kelasmu.');

    const existing = await DB.getAllByIndex('attempts', 'user_exam', [user.user_id, examId]);
    const running = existing.find(function (a) { return a.status === 'IN_PROGRESS'; });
    if (running) return { ok: true, resume: running };
    if (existing.length) return fail('ALREADY_DONE', 'Ujian ini sudah kamu kerjakan dan tidak dapat dibuka kembali.');

    if (!Sync.isReady(exam)) return fail('NOT_READY', 'Ujian belum siap. Unduh soal saat ada internet.');
    const cfg = exam.exam_raw;
    if (['TOTAL', 'PER_SOAL', 'FIXED'].indexOf(cfg.mode) === -1) {
      return fail('MODE_INVALID', 'Mode ujian tidak dikenal: ' + cfg.mode + '. Perbarui aplikasi.');
    }
    if (cfg.mode === 'PER_SOAL' && cfg.navigation !== 'SEQUENTIAL') {
      return fail('MODE_INVALID', 'Ujian PER_SOAL wajib NAVIGATION = SEQUENTIAL. Hubungi guru.');
    }
    if (!(cfg.duration_seconds > 0)) return fail('MODE_INVALID', 'Durasi ujian tidak valid.');

    const today = UI.todayLocal();
    if (cfg.start_date && today < cfg.start_date) {
      return fail('NOT_STARTED', 'Ujian baru dapat dimulai tanggal ' + cfg.start_date + '. Periksa juga tanggal di perangkat.');
    }
    if (cfg.end_date && today > cfg.end_date) {
      return fail('EXAM_EXPIRED', 'Masa ujian sudah berakhir (' + cfg.end_date + '). Periksa juga tanggal di perangkat.');
    }

    if (cfg.token_required) {
      if (!exam.encrypted) {
        return fail('PACKAGE_OLD', 'Paket soal ujian ini masih versi lama (belum dikunci token). Unduh ulang saat ada internet.');
      }
      if (!Array.isArray(exam.key_slots) || !exam.key_slots.length) {
        return fail('TOKEN_NOT_SET', 'Data token tidak ada di paket. Unduh ulang saat ada internet.');
      }
    }

    const errs = await Sync.verifyStoredPackage(examId);
    if (errs.length) {
      return fail('PACKAGE_BROKEN', 'Data soal di perangkat bermasalah: ' + errs.join('; ') + '. Unduh ulang saat ada internet.');
    }
    return { ok: true, exam: exam };
  }

  /* ---------- Token ---------- */

  async function verifyTokenForStart(user, exam, input) {
    const failKey = 'token_fail:' + user.user_id + ':' + exam.exam_id;
    const f = await DB.getSetting(failKey);
    const lockActive = f && f.count >= TOKEN_MAX_FAIL && (Date.now() - f.last_at) < TOKEN_LOCK_MS;
    if (lockActive) return failRes('TOKEN_LOCKED', 'Terlalu banyak token salah. Tunggu 1 menit lalu coba lagi.');
    if (!Token.normalize(input)) return failRes('TOKEN_EMPTY', 'Masukkan token yang dibacakan guru.');

    const u = await Token.unlock(exam, input);
    if (!u.success) {
      const base = (f && (Date.now() - f.last_at) < TOKEN_LOCK_MS) ? f.count : 0;
      await DB.setSetting(failKey, { count: base + 1, last_at: Date.now() });
      return u;
    }

    const cfg = await DB.getSetting('app_config');
    const m = Token.checkMeta(u.data.meta, exam, Timer.now(), cfg ? cfg.school_code : '');
    if (!m.success) return m;

    const content = await Token.decryptQuestions(exam, u.data.key);
    const qs = await Questions.loadExamQuestions(exam.exam_id);
    const missing = qs.filter(function (q) { return !content[q.question_id]; });
    if (missing.length) {
      return failRes('PACKAGE_BROKEN', 'Sebagian soal tidak dapat dibuka. Unduh ulang saat ada internet.');
    }

    await DB.delSetting(failKey);
    return {
      success: true,
      data: {
        content_key: Token.bytesToB64(u.data.key),
        token_id: u.data.token_id,
        token_meta: u.data.meta,
        verified_at: new Date(Timer.now()).toISOString()
      }
    };
  }

  function timerStateFor(a, lastSeen) {
    if (a.mode === 'PER_SOAL') {
      return {
        attempt_id: a.attempt_id,
        mode: 'PER_SOAL',
        question_index: a.current_index,
        question_number: a.current_index + 1,
        question_id: a.question_order[a.current_index],
        question_started_at: a.question_started_at_ms,
        question_end_at: a.question_end_at_ms,
        last_seen_at: lastSeen
      };
    }
    if (a.mode === 'FIXED') {
      return {
        attempt_id: a.attempt_id,
        mode: 'FIXED',
        exam_started_at: a.started_at_ms,
        exam_end_at: a.end_at_ms,
        frontier_index: a.frontier_index,
        question_started_at: a.question_started_at_ms,
        question_end_at: a.question_end_at_ms,
        last_seen_at: lastSeen
      };
    }
    return {
      attempt_id: a.attempt_id,
      mode: 'TOTAL',
      exam_started_at: a.started_at_ms,
      exam_end_at: a.end_at_ms,
      last_seen_at: lastSeen
    };
  }

  async function createAttempt(user, exam, tokenInfo) {
    const cfg = exam.exam_raw;
    const perQ = cfg.mode === 'PER_SOAL';
    const fixed = cfg.mode === 'FIXED';
    const qs = await Questions.loadExamQuestions(exam.exam_id);
    if (qs.length !== exam.question_count_local) throw new Error('Jumlah soal di perangkat tidak lengkap. Unduh ulang.');

    const order = Questions.buildOrder(qs, !!cfg.random_question, !!cfg.random_option);
    const nowMs = Timer.now();
    const nowIso = new Date(nowMs).toISOString();
    const durMs = cfg.duration_seconds * 1000;

    let endAt = nowMs + durMs;                     // TOTAL
    if (perQ) endAt = null;                        // PER_SOAL: tidak ada batas total
    if (fixed) endAt = nowMs + fixedTotalMs(cfg.duration_seconds, qs.length);

    const attempt = {
      attempt_id: makeAttemptId(user.user_id),
      user_id: user.user_id,
      user_name: user.name,
      user_class: user.class,
      exam_id: exam.exam_id,
      exam_name: cfg.exam_name,
      mode: cfg.mode,
      duration_seconds: cfg.duration_seconds,
      per_question_seconds: (perQ || fixed) ? cfg.duration_seconds : null,
      fixed_extra_percent: fixed ? extraPercent() : null,
      status: 'IN_PROGRESS',
      sync_status: 'PENDING',
      started_at: nowIso,
      started_at_ms: nowMs,
      end_at_ms: endAt,
      question_started_at_ms: (perQ || fixed) ? nowMs : null,
      question_end_at_ms: (perQ || fixed) ? nowMs + durMs : null,
      frontier_index: fixed ? 0 : null,
      question_log: [],
      clock_events: [],
      violations: [],
      violation_count: 0,
      completed_at: null,
      completed_at_ms: null,
      finish_reason: null,
      current_index: 0,
      current_question: 1,
      question_order: order.question_order,
      option_orders: order.option_orders,
      answered_count: 0,
      encrypted: !!exam.encrypted,
      content_key: tokenInfo ? tokenInfo.content_key : null,
      token_id: tokenInfo ? tokenInfo.token_id : null,
      token_meta: tokenInfo ? tokenInfo.token_meta : null,
      token_verified_at: tokenInfo ? tokenInfo.verified_at : null,
      package_version: exam.package_version,
      package_checksum: exam.checksum,
      client_version: SIBER_CONFIG.CLIENT_VERSION,
      created_at: nowIso,
      updated_at: nowIso
    };
    const timer = timerStateFor(attempt, nowMs);

    await DB.transaction(['attempts', 'timer_state'], 'readwrite', function (t, set, failTx) {
      const req = t.objectStore('attempts').index('user_exam').getAll([user.user_id, exam.exam_id]);
      req.onsuccess = function () {
        if (req.result && req.result.length) {
          failTx('ALREADY_EXISTS', 'Ujian ini sudah pernah dimulai di perangkat ini.');
          return;
        }
        t.objectStore('attempts').put(attempt);
        t.objectStore('timer_state').put(timer);
        set(true);
      };
    });
    return attempt;
  }

  function saveAnswerToDb(attemptId, q, original, display, clickedAt) {
    return DB.transaction(['attempts', 'answers'], 'readwrite', function (t, set, failTx) {
      const r = t.objectStore('attempts').get(attemptId);
      r.onsuccess = function () {
        const a = r.result;
        if (!a || a.status !== 'IN_PROGRESS') { failTx('ATTEMPT_CLOSED', 'Ujian sudah ditutup.'); return; }

        const perQ = a.mode === 'PER_SOAL';
        const deadline = perQ ? a.question_end_at_ms : a.end_at_ms;
        const now = Timer.now();

        if (perQ && a.question_order[a.current_index] !== q.question_id) {
          failTx('QUESTION_LOCKED', 'Soal ini sudah dikunci.');
          return;
        }
        if (a.mode === 'FIXED') {
          const idx = a.question_order.indexOf(q.question_id);
          if (idx < 0 || idx > a.frontier_index) {
            failTx('QUESTION_LOCKED', 'Soal ini belum dibuka.');
            return;
          }
        }
        if (clickedAt >= deadline || now >= deadline + SAVE_GRACE_MS) {
          if (perQ) failTx('QUESTION_LOCKED', 'Waktu soal ini sudah habis. Soal dikunci.');
          else failTx('TIME_UP', 'Waktu ujian sudah habis.');
          return;
        }

        const nowIso = new Date(now).toISOString();
        const rec = {
          attempt_id: attemptId,
          question_id: q.question_id,
          user_id: a.user_id,
          exam_id: a.exam_id,
          question_number: q.original_number,
          display_number: q.display_number,
          answer: original,
          display_letter: display,
          answered_at: new Date(clickedAt).toISOString()
        };
        t.objectStore('answers').put(rec);
        a.last_answer_at = nowIso;
        a.updated_at = nowIso;
        t.objectStore('attempts').put(a);
        set(rec);
      };
    });
  }

  /** TOTAL & FIXED: mengingat soal yang sedang dibuka. */
  function persistPosition() {
    if (!S || isPerQ()) return;
    const id = S.attempt.attempt_id;
    const idx = S.index;
    DB.transaction(['attempts'], 'readwrite', function (t, set) {
      const r = t.objectStore('attempts').get(id);
      r.onsuccess = function () {
        const a = r.result;
        if (a && a.status === 'IN_PROGRESS') {
          a.current_index = (a.mode === 'FIXED') ? Math.min(idx, a.frontier_index) : idx;
          a.current_question = a.current_index + 1;
          t.objectStore('attempts').put(a);
        }
        set(true);
      };
    }).catch(function (e) { console.warn('Gagal menyimpan posisi soal:', e); });
  }

  /** PER_SOAL: kunci soal aktif dan buka soal berikutnya. Ditolak jika waktu soal belum habis. */
  function advanceQuestion(attemptId, expectedIndex) {
    return DB.transaction(['attempts', 'timer_state'], 'readwrite', function (t, set, failTx) {
      const r = t.objectStore('attempts').get(attemptId);
      r.onsuccess = function () {
        const a = r.result;
        if (!a || a.status !== 'IN_PROGRESS' || a.mode !== 'PER_SOAL') {
          failTx('ATTEMPT_CLOSED', 'Ujian sudah ditutup.');
          return;
        }
        if (a.current_index !== expectedIndex) { set(a); return; }

        const now = Timer.now();
        if (now < a.question_end_at_ms) { failTx('NOT_YET', 'Waktu soal ini belum habis.'); return; }
        if (expectedIndex >= a.question_order.length - 1) { failTx('LAST_QUESTION', 'Ini soal terakhir.'); return; }

        a.question_log = a.question_log || [];
        a.question_log.push({
          index: expectedIndex,
          question_id: a.question_order[expectedIndex],
          started_at_ms: a.question_started_at_ms,
          end_at_ms: a.question_end_at_ms,
          locked_at_ms: now
        });

        a.current_index = expectedIndex + 1;
        a.current_question = a.current_index + 1;
        a.question_started_at_ms = now;
        a.question_end_at_ms = now + a.per_question_seconds * 1000;
        a.updated_at = new Date(now).toISOString();

        t.objectStore('attempts').put(a);
        t.objectStore('timer_state').put(timerStateFor(a, now));
        set(a);
      };
    });
  }

  /**
   * FIXED: buka soal berikutnya (memulai waktu minimalnya).
   * Ditolak jika waktu minimal soal terdepan belum habis atau waktu ujian sudah habis.
   */
  function openNextFixed(attemptId, expectedFrontier) {
    return DB.transaction(['attempts', 'timer_state'], 'readwrite', function (t, set, failTx) {
      const r = t.objectStore('attempts').get(attemptId);
      r.onsuccess = function () {
        const a = r.result;
        if (!a || a.status !== 'IN_PROGRESS' || a.mode !== 'FIXED') {
          failTx('ATTEMPT_CLOSED', 'Ujian sudah ditutup.');
          return;
        }
        if (a.frontier_index !== expectedFrontier) { set(a); return; }

        const now = Timer.now();
        if (now >= a.end_at_ms) { failTx('TIME_UP', 'Waktu ujian sudah habis.'); return; }
        if (now < a.question_end_at_ms) { failTx('NOT_YET', 'Waktu soal ini belum habis.'); return; }
        if (expectedFrontier >= a.question_order.length - 1) { failTx('LAST_QUESTION', 'Ini soal terakhir.'); return; }

        a.question_log = a.question_log || [];
        a.question_log.push({
          index: expectedFrontier,
          question_id: a.question_order[expectedFrontier],
          started_at_ms: a.question_started_at_ms,
          end_at_ms: a.question_end_at_ms,
          opened_next_at_ms: now
        });

        a.frontier_index = expectedFrontier + 1;
        a.current_index = a.frontier_index;
        a.current_question = a.current_index + 1;
        a.question_started_at_ms = now;
        a.question_end_at_ms = now + a.per_question_seconds * 1000;
        a.updated_at = new Date(now).toISOString();

        t.objectStore('attempts').put(a);
        t.objectStore('timer_state').put(timerStateFor(a, now));
        set(a);
      };
    });
  }

  async function finishAttempt(attemptId, reason) {
    const answers = await DB.getAllByIndex('answers', 'attempt_id', attemptId);
    const answered = answers.filter(function (a) { return !!a.answer; }).length;

    return DB.transaction(['attempts', 'timer_state', 'sync_queue'], 'readwrite', function (t, set, failTx) {
      const r = t.objectStore('attempts').get(attemptId);
      r.onsuccess = function () {
        const a = r.result;
        if (!a) { failTx('NOT_FOUND', 'Data ujian tidak ditemukan.'); return; }
        if (a.status !== 'IN_PROGRESS') { set(a); return; }

        const now = Timer.now();
        a.status = 'COMPLETED';

        if (a.mode === 'PER_SOAL') {
          const qEnd = a.question_end_at_ms || now;
          a.completed_at_ms = (reason === 'ALL_DONE') ? Math.min(now, qEnd) : now;
          a.finish_reason = reason;
          a.question_log = a.question_log || [];
          if (Array.isArray(a.question_order) && a.question_order[a.current_index]) {
            a.question_log.push({
              index: a.current_index,
              question_id: a.question_order[a.current_index],
              started_at_ms: a.question_started_at_ms,
              end_at_ms: a.question_end_at_ms,
              locked_at_ms: now
            });
          }
        } else {
          const end = (a.end_at_ms > 0) ? a.end_at_ms : now;
          a.completed_at_ms = Math.min(now, end);
          a.finish_reason = (reason !== 'DATA_ERROR' && now >= end) ? 'TIME_UP' : reason;
          if (a.mode === 'FIXED' && Array.isArray(a.question_order) && a.question_order[a.frontier_index]) {
            a.question_log = a.question_log || [];
            a.question_log.push({
              index: a.frontier_index,
              question_id: a.question_order[a.frontier_index],
              started_at_ms: a.question_started_at_ms,
              end_at_ms: a.question_end_at_ms,
              finished_at_ms: now
            });
          }
        }

        a.completed_at = new Date(a.completed_at_ms).toISOString();
        a.answered_count = answered;
        a.sync_status = 'PENDING_SYNC';
        a.updated_at = new Date(now).toISOString();

        t.objectStore('attempts').put(a);
        t.objectStore('timer_state').delete(attemptId);
        t.objectStore('sync_queue').put({
          queue_id: attemptId,
          attempt_id: attemptId,
          user_id: a.user_id,
          exam_id: a.exam_id,
          status: 'PENDING',
          tries: 0,
          created_at: a.updated_at,
          last_error: null
        });
        set(a);
      };
    });
  }

  /* ---------- Catatan kejadian jam ---------- */

  function recordClockEvent(attemptId, ev) {
    return DB.transaction(['attempts'], 'readwrite', function (t, set) {
      const r = t.objectStore('attempts').get(attemptId);
      r.onsuccess = function () {
        const a = r.result;
        if (a && a.status === 'IN_PROGRESS') {
          a.clock_events = a.clock_events || [];
          if (a.clock_events.length < MAX_CLOCK_EVENTS) {
            a.clock_events.push({
              type: ev.type,
              amount_ms: ev.amount_ms,
              effective_at: new Date(ev.effective_at).toISOString(),
              device_at: new Date(ev.device_at).toISOString()
            });
            t.objectStore('attempts').put(a);
          }
        }
        set(true);
      };
    }).catch(function (e) { console.warn('Gagal mencatat kejadian jam:', e); });
  }

  function onClockAnomaly(ev) {
    if (!S || S.finishing) return;
    recordClockEvent(S.attempt.attempt_id, ev);
    if (ev.type === 'CLOCK_BACKWARD') {
      showNotice('Jam perangkat terdeteksi diubah mundur. Waktu ujian tetap dihitung dengan benar, ' +
                 'dan kejadian ini dicatat untuk guru.', 'warn');
    }
  }

  /* ---------- Anti-kecurangan ---------- */

  function recordViolation(type) {
    if (!S || S.finishing || !SIBER_CONFIG.ANTI_CHEAT) return;
    const id = S.attempt.attempt_id;
    S.violationCount = (S.violationCount || 0) + 1;
    S.lastViolationAt = Timer.now();
    renderViolations();

    DB.transaction(['attempts'], 'readwrite', function (t, set) {
      const r = t.objectStore('attempts').get(id);
      r.onsuccess = function () {
        const a = r.result;
        if (a && a.status === 'IN_PROGRESS') {
          a.violations = a.violations || [];
          if (a.violations.length < MAX_VIOLATION_EVENTS) {
            a.violations.push({ type: type, at: new Date(Timer.now()).toISOString() });
          }
          a.violation_count = (a.violation_count || 0) + 1;
          t.objectStore('attempts').put(a);
          set(a.violation_count);
        } else {
          set(null);
        }
      };
    }).then(function (n) {
      if (S && S.attempt.attempt_id === id && typeof n === 'number') {
        S.violationCount = n;
        renderViolations();
      }
    }).catch(function (e) { console.warn('Gagal mencatat pelanggaran:', e); });

    if (typeof Live !== 'undefined' && Live.beatSoon) Live.beatSoon();
  }

  function onLeave() {
    if (!S || S.finishing || S.away) return;
    S.away = { at: Timer.now() };
    recordViolation('LEAVE_SCREEN');
  }

  function onReturn() {
    if (!S || !S.away) return;
    const sec = Math.round((Timer.now() - S.away.at) / 1000);
    S.away = null;
    Timer.tickNow();
    requestWakeLock();
    showNotice('Kamu keluar dari layar ujian' + (sec >= 2 ? ' selama ' + sec + ' detik' : '') +
      '. Pelanggaran tercatat: ' + S.violationCount + '. Gurumu bisa melihat catatan ini.', 'warn');
  }

  function onFullscreenChange() {
    renderFullscreenButton();
    if (!S || S.finishing) return;
    if (document.fullscreenElement) {
      S.wasFullscreen = true;
      return;
    }
    if (!S.wasFullscreen) return;
    S.wasFullscreen = false;
    // Tunggu sebentar: jika siswa sekaligus keluar layar (sudah tercatat), jangan dihitung dua kali.
    setTimeout(function () {
      if (!S || S.finishing || S.away) return;
      if (Timer.now() - (S.lastViolationAt || 0) < 1500) return;
      recordViolation('EXIT_FULLSCREEN');
      showNotice('Kamu keluar dari layar penuh. Pelanggaran tercatat: ' + S.violationCount +
        '. Tekan "Layar penuh" untuk kembali.', 'warn');
    }, 800);
  }

  function renderViolations() {
    const b = $('exam-violations');
    if (!b || !S) return;
    const n = S.violationCount || 0;
    b.textContent = n ? '⚠ Pelanggaran: ' + n : '✓ Pelanggaran: 0';
    b.className = 'violation-badge' + (n ? ' has-violation' : '');
    b.hidden = !SIBER_CONFIG.ANTI_CHEAT;
  }

  /* ---------- Detak "terakhir terlihat" ---------- */

  async function beat() {
    if (!S) return;
    try {
      const ts = await DB.get('timer_state', S.attempt.attempt_id);
      if (ts) {
        ts.last_seen_at = Timer.now();
        await DB.put('timer_state', ts);
      }
    } catch (e) {
      console.warn('Heartbeat gagal:', e);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    beat();
    heartbeatHandle = setInterval(beat, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatHandle) clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }

  /* =========================================================
   * PEMERIKSAAN & PERBAIKAN
   * ========================================================= */

  async function checkAndRepairAttempt(a) {
    const problems = [];
    const N = Array.isArray(a.question_order) ? a.question_order.length : 0;
    if (!N) problems.push('urutan soal hilang');
    if (!a.option_orders || typeof a.option_orders !== 'object') problems.push('urutan pilihan hilang');
    if (!(a.started_at_ms > 0)) problems.push('waktu mulai hilang');
    if (a.encrypted && !a.content_key) problems.push('kunci soal hilang');

    if (a.mode === 'TOTAL') {
      const expected = a.started_at_ms + a.duration_seconds * 1000;
      if (!(a.end_at_ms > 0) || Math.abs(a.end_at_ms - expected) > 1000) {
        problems.push('batas waktu ujian tidak cocok dengan durasi');
      }
    } else if (a.mode === 'PER_SOAL') {
      if (!(a.current_index >= 0 && a.current_index < N)) problems.push('nomor soal aktif tidak valid');
      const len = a.question_end_at_ms - a.question_started_at_ms;
      if (!(a.per_question_seconds > 0) || !(Math.abs(len - a.per_question_seconds * 1000) <= 1000)) {
        problems.push('waktu soal aktif tidak cocok');
      }
    } else if (a.mode === 'FIXED') {
      if (!(a.per_question_seconds > 0)) problems.push('waktu per soal tidak valid');
      const pct = (a.fixed_extra_percent === null || a.fixed_extra_percent === undefined) ? extraPercent() : a.fixed_extra_percent;
      const expected = a.started_at_ms + Math.ceil(a.per_question_seconds * N * (1 + pct / 100)) * 1000;
      if (!(a.end_at_ms > 0) || Math.abs(a.end_at_ms - expected) > 1000) {
        problems.push('batas waktu ujian tidak cocok dengan durasi');
      }
      if (!(a.frontier_index >= 0 && a.frontier_index < N)) problems.push('soal terdepan tidak valid');
      const len = a.question_end_at_ms - a.question_started_at_ms;
      if (!(Math.abs(len - a.per_question_seconds * 1000) <= 1000)) problems.push('waktu soal aktif tidak cocok');
    } else {
      problems.push('mode tidak dikenal');
    }
    if (problems.length) throw makeError('DATA_BROKEN', problems.join('; '));

    const ts = await DB.get('timer_state', a.attempt_id);
    const lastSeen = Math.max(
      (ts && ts.last_seen_at) || 0,
      a.started_at_ms || 0,
      a.question_started_at_ms || 0,
      Date.parse(a.updated_at) || 0,
      Date.parse(a.last_answer_at) || 0
    );

    let mismatch = !ts || ts.mode !== a.mode;
    if (!mismatch) {
      if (a.mode === 'TOTAL') mismatch = ts.exam_end_at !== a.end_at_ms;
      else if (a.mode === 'PER_SOAL') mismatch = ts.question_index !== a.current_index || ts.question_end_at !== a.question_end_at_ms;
      else mismatch = ts.exam_end_at !== a.end_at_ms || ts.frontier_index !== a.frontier_index || ts.question_end_at !== a.question_end_at_ms;
    }

    if (mismatch) await DB.put('timer_state', timerStateFor(a, lastSeen));
    return { lastSeen: lastSeen, repaired: mismatch };
  }

  async function handleBroken(a, e) {
    releaseExamLock();
    const ok = window.confirm(
      'Data ujian "' + a.exam_name + '" di perangkat ini rusak sehingga ujian tidak dapat dilanjutkan.\n\n' +
      'Penyebab: ' + (e && e.message ? e.message : e) + '\n\n' +
      'Tekan OK untuk MENUTUP ujian dan menyimpan jawaban yang sudah ada agar tetap bisa dikirim ke server.\n' +
      'Tekan Batal untuk kembali ke beranda (ujian tetap terbuka).');
    if (!ok) throw makeError('DATA_BROKEN', 'Ujian tidak dapat dilanjutkan: ' + (e && e.message ? e.message : e));
    const done = await finishAttempt(a.attempt_id, 'DATA_ERROR');
    showDone(done, 'Ujian ditutup karena data di perangkat rusak. Jawaban yang sudah tersimpan tetap disimpan dan akan dikirim ke server.');
    return false;
  }

  async function repair() {
    let fixedCount = 0;
    const attempts = await DB.getAll('attempts');
    const queue = await DB.getAll('sync_queue');
    const inQueue = {};
    queue.forEach(function (q) { inQueue[q.attempt_id] = true; });

    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      if (a.status === 'COMPLETED' && a.sync_status !== 'SYNCED') {
        if (a.sync_status !== 'PENDING_SYNC') {
          a.sync_status = 'PENDING_SYNC';
          await DB.put('attempts', a);
          fixedCount++;
        }
        if (!inQueue[a.attempt_id]) {
          await DB.put('sync_queue', {
            queue_id: a.attempt_id,
            attempt_id: a.attempt_id,
            user_id: a.user_id,
            exam_id: a.exam_id,
            status: 'PENDING',
            tries: 0,
            created_at: new Date().toISOString(),
            last_error: null
          });
          fixedCount++;
        }
      }
      if (a.status !== 'IN_PROGRESS') {
        const ts = await DB.get('timer_state', a.attempt_id);
        if (ts) {
          await DB.del('timer_state', a.attempt_id);
          fixedCount++;
        }
      }
    }
    if (fixedCount) console.info('SIBER-UJIAN: ' + fixedCount + ' perbaikan data dilakukan saat aplikasi dibuka.');
    return fixedCount;
  }

  /* =========================================================
   * LAYAR PEMBUKA
   * ========================================================= */

  async function openIntro(user, examId) {
    const c = await checkCanStart(user, examId);
    if (!c.ok) return c;
    if (c.resume) {
      await resume(c.resume);
      return { ok: true };
    }

    pendingIntro = { user: user, exam: c.exam };
    const cfg = c.exam.exam_raw;
    const n = c.exam.question_count_local;
    const D = cfg.duration_seconds;

    $('intro-title').textContent = cfg.exam_name;
    const rows = [
      ['Mata pelajaran', cfg.subject],
      ['Kelas', cfg.grade],
      ['Jumlah soal', n]
    ];
    if (cfg.mode === 'PER_SOAL') {
      rows.push(['Mode', 'Per soal (setiap soal punya waktu sendiri)']);
      rows.push(['Waktu per soal', D + ' detik']);
      rows.push(['Perkiraan total waktu', Math.ceil(n * D / 60) + ' menit']);
    } else if (cfg.mode === 'FIXED') {
      rows.push(['Mode', 'Fixed (waktu minimal per soal + waktu total)']);
      rows.push(['Waktu minimal per soal', D + ' detik']);
      rows.push(['Waktu total ujian', UI.formatDuration(fixedTotalMs(D, n))]);
    } else {
      rows.push(['Mode', 'Total (satu waktu untuk semua soal)']);
      rows.push(['Durasi', Math.round(D / 60) + ' menit']);
    }
    rows.push(['Peserta', user.name + ' (' + user.class + ')']);
    UI.setRows('intro-info', rows);

    const rules = [];
    if (cfg.token_required) rules.push('Ujian ini memerlukan TOKEN dari guru. Token dibacakan di kelas saat ujian akan dimulai.');
    if (cfg.mode === 'PER_SOAL') {
      rules.push(
        'Setiap soal punya waktu sendiri: ' + D + ' detik.',
        'Kamu TIDAK dapat pindah ke soal berikutnya sebelum waktu soal habis, walaupun sudah menjawab.',
        'Saat waktu soal habis, soal dikunci dan soal berikutnya terbuka otomatis.',
        'Kamu TIDAK dapat kembali ke soal sebelumnya.',
        'Selama waktu soal masih berjalan, jawaban boleh diganti.'
      );
    } else if (cfg.mode === 'FIXED') {
      rules.push(
        'Setiap soal punya waktu minimal ' + D + ' detik. Selama waktu itu berjalan, kamu tidak bisa pindah soal.',
        'Setelah waktu soal habis, kamu boleh membuka soal berikutnya, kembali ke soal sebelumnya, dan mengganti jawaban.',
        'Waktu total ujian ' + UI.formatDuration(fixedTotalMs(D, n)) + '. Jika habis, ujian selesai otomatis.',
        'Tombol "Selesai ujian" aktif setelah semua soal dibuka dan waktu soal terakhir habis.'
      );
    } else {
      rules.push(
        'Kamu boleh berpindah soal, kembali ke soal sebelumnya, dan mengganti jawaban selama waktu masih ada.',
        'Jika waktu habis, ujian selesai otomatis.'
      );
    }
    rules.push(
      'Waktu TIDAK berhenti walaupun aplikasi ditutup atau HP mati.',
      'Setiap jawaban langsung tersimpan di perangkat saat dipilih.',
      'Tetap di layar ujian. Pindah tab/aplikasi, mematikan layar, atau menutup aplikasi dicatat sebagai pelanggaran dan dilihat guru.',
      'Mengubah jam HP tidak menambah waktu, dan akan dicatat untuk guru.',
      'Ujian yang sudah selesai tidak dapat dibuka kembali. Internet tidak diperlukan selama ujian.'
    );
    const ul = $('intro-rules');
    ul.replaceChildren();
    rules.forEach(function (r) { ul.appendChild(el('li', { text: r })); });

    $('intro-token-box').hidden = !cfg.token_required;
    $('intro-token').value = '';
    UI.hideMsg('intro-message');
    UI.showScreen('exam-intro');
    if (cfg.token_required) $('intro-token').focus();
    return { ok: true };
  }

  async function onIntroStart() {
    if (!pendingIntro || startBusy) return;
    // Layar penuh harus diminta langsung saat tombol diklik (aturan browser).
    requestFullscreen();
    startBusy = true;
    const btn = $('btn-intro-start');
    UI.hideMsg('intro-message');
    try {
      const user = pendingIntro.user;
      const exam = pendingIntro.exam;

      let tokenInfo = null;
      if (exam.exam_raw.token_required) {
        UI.setBusy(btn, true, 'Memeriksa token...');
        const tr = await verifyTokenForStart(user, exam, $('intro-token').value);
        if (!tr.success) {
          UI.showMsg('intro-message', 'error', UI.errorText(tr));
          $('intro-token').focus();
          exitFullscreen();
          return;
        }
        tokenInfo = tr.data;
      }

      UI.setBusy(btn, true, 'Menyiapkan ujian...');
      if (!(await acquireExamLock())) {
        UI.showMsg('intro-message', 'error',
          'Ada ujian yang sedang terbuka di tab atau jendela lain. Tutup tab lain tersebut terlebih dahulu.');
        exitFullscreen();
        return;
      }
      let attempt;
      try {
        attempt = await createAttempt(user, exam, tokenInfo);
      } catch (e) {
        releaseExamLock();
        throw e;
      }
      pendingIntro = null;
      $('intro-token').value = '';
      await enterExam(attempt);
      if (typeof Live !== 'undefined' && Live.beatSoon) Live.beatSoon();
    } catch (e) {
      if (e && e.code === 'ALREADY_EXISTS') {
        const running = pendingIntro ? await findInProgress(pendingIntro.user.user_id) : null;
        pendingIntro = null;
        if (running) {
          await resume(running);
        } else if (hooks.onExit) {
          await hooks.onExit('Ujian ini sudah pernah dikerjakan di perangkat ini.');
        }
      } else {
        UI.showMsg('intro-message', 'error', 'Gagal memulai ujian: ' + (e && e.message ? e.message : e));
        exitFullscreen();
      }
    } finally {
      startBusy = false;
      UI.setBusy(btn, false);
    }
  }

  async function onIntroBack() {
    pendingIntro = null;
    $('intro-token').value = '';
    if (hooks.onExit) await hooks.onExit();
  }

  /* =========================================================
   * MASUK / MELANJUTKAN UJIAN
   * ========================================================= */

  function initialIndex(attempt, count) {
    let index = Number(attempt.current_index) || 0;
    if (attempt.mode === 'FIXED') {
      if (Timer.now() < attempt.question_end_at_ms) index = attempt.frontier_index; // masih wajib di soal terdepan
      else index = Math.min(index, attempt.frontier_index);
    }
    if (index < 0 || index >= count) index = 0;
    return index;
  }

  async function enterExam(attempt) {
    if (!(await acquireExamLock())) {
      throw makeError('OTHER_TAB', 'Ujian sedang terbuka di tab atau jendela lain. Tutup tab lain tersebut, lalu muat ulang halaman ini.');
    }
    try {
      const questions = await Questions.buildForAttempt(attempt);
      const saved = await DB.getAllByIndex('answers', 'attempt_id', attempt.attempt_id);
      const answers = {};
      saved.forEach(function (a) { answers[a.question_id] = a; });
      let flags = {};
      try { flags = (await DB.getSetting('flags:' + attempt.attempt_id)) || {}; } catch (ignore) { flags = {}; }

      S = {
        flags: flags,
        attempt: attempt,
        questions: questions,
        answers: answers,
        index: initialIndex(attempt, questions.length),
        saving: 0,
        saveError: null,
        finishing: false,
        advancing: false,
        imageUrl: null,
        pendingSeq: {},
        violationCount: attempt.violation_count || 0,
        lastViolationAt: 0,
        away: null,
        wasFullscreen: !!document.fullscreenElement,
        wasPinned: null
      };
    } catch (e) {
      releaseExamLock();
      throw e;
    }

    try { history.pushState({ siberExam: true }, ''); } catch (e) { /* abaikan */ }
    UI.hideMsg('exam-notice');
    applyModeLayout();
    UI.showScreen('exam');
    render();
    renderViolations();
    renderFullscreenButton();
    startTimer();
    startHeartbeat();
    requestWakeLock();
    DB.requestPersistence();
  }

  async function enterSafely(a) {
    try {
      await enterExam(a);
      return true;
    } catch (e) {
      if (e && e.code === 'OTHER_TAB') throw e;
      return handleBroken(a, e);
    }
  }

  async function resume(a) {
    let info;
    try {
      info = await checkAndRepairAttempt(a);
    } catch (e) {
      return handleBroken(a, e);
    }

    const notes = [];
    let noticeType = 'info';

    const back = Timer.ensureAtLeast(info.lastSeen);
    if (back > RESUME_BACKWARD_TOLERANCE_MS) {
      await recordClockEvent(a.attempt_id, {
        type: 'CLOCK_BACKWARD_WHILE_CLOSED',
        amount_ms: back,
        effective_at: Timer.now(),
        device_at: Date.now()
      });
      notes.push('Jam perangkat lebih mundur dari saat aplikasi terakhir dibuka. Waktu tidak ditambah, dan kejadian ini dicatat untuk guru.');
      noticeType = 'warn';
    } else {
      const gap = Timer.now() - info.lastSeen;
      if (gap > CLOSED_GAP_REPORT_MS) {
        await recordClockEvent(a.attempt_id, {
          type: 'APP_CLOSED_GAP',
          amount_ms: gap,
          effective_at: Timer.now(),
          device_at: Date.now()
        });
      }
    }
    if (info.repaired) notes.push('Data timer diperbaiki otomatis dari catatan ujian.');

    let entered = false;
    let first = '';

    if (a.mode === 'TOTAL' || a.mode === 'FIXED') {
      if (Timer.now() >= a.end_at_ms) {
        const done = await finishAttempt(a.attempt_id, 'TIME_UP');
        showDone(done, 'Waktu ujian habis saat aplikasi tertutup. Ujian diselesaikan otomatis; jawaban yang sudah tersimpan tetap dihitung.');
        return;
      }
      entered = await enterSafely(a);
      first = 'Ujian dilanjutkan. Jawaban sebelumnya sudah dimuat. Waktu tetap berjalan selama aplikasi tertutup.';
    } else {
      let at = a;
      first = 'Ujian dilanjutkan. Waktu soal ini tetap berjalan selama aplikasi tertutup.';
      if (Timer.now() >= at.question_end_at_ms) {
        const lockedNumber = at.current_index + 1;
        if (at.current_index >= at.question_order.length - 1) {
          const done = await finishAttempt(at.attempt_id, 'ALL_DONE');
          showDone(done, 'Waktu soal terakhir habis saat aplikasi tertutup. Ujian selesai; jawaban yang sudah tersimpan tetap dihitung.');
          return;
        }
        at = await advanceQuestion(at.attempt_id, at.current_index);
        first = 'Waktu soal ' + lockedNumber + ' habis saat aplikasi tertutup, jadi soal itu dikunci. ' +
                'Soal ' + (at.current_index + 1) + ' dimulai sekarang.';
      }
      entered = await enterSafely(at);
    }

    if (entered) {
      // Membuka kembali ujian yang sedang berjalan = aplikasi sempat ditutup / dimuat ulang.
      recordViolation('APP_REOPENED');
      notes.push('Menutup atau memuat ulang aplikasi dicatat sebagai pelanggaran.');
      showNotice([first].concat(notes).join(' '), 'warn');
      if (typeof Live !== 'undefined' && Live.beatSoon) Live.beatSoon();
    }
    return noticeType;
  }

  /* =========================================================
   * TAMPILAN UJIAN
   * ========================================================= */

  function applyModeLayout() {
    const mode = S.attempt.mode;
    $('exam-timer-label').textContent = mode === 'PER_SOAL' ? 'Sisa waktu soal ini' : 'Sisa waktu ujian';
    $('nav-row').hidden = mode === 'PER_SOAL';
    $('btn-finish').hidden = mode === 'PER_SOAL';
    $('exam-qtimer').hidden = mode !== 'FIXED';

    let legend = 'Hijau = sudah dijawab. Kuning = ragu-ragu. Bingkai tebal = soal yang sedang dibuka.';
    if (mode === 'PER_SOAL') legend = 'Berwarna = sudah dijawab. Abu-abu = terkunci tanpa jawaban. Nomor tidak dapat diklik.';
    if (mode === 'FIXED') legend = 'Hijau = sudah dijawab. Kuning = ragu-ragu. Bertanda + = soal berikutnya yang boleh dibuka. Bergembok = belum boleh dibuka.';
    $('grid-legend').textContent = legend;

    if (mode === 'PER_SOAL') {
      UI.showMsg('exam-mode-info', 'info',
        'Mode per soal: soal berikutnya terbuka otomatis saat waktu soal ini habis. Kamu tidak bisa kembali.');
    } else if (mode === 'FIXED') {
      UI.showMsg('exam-mode-info', 'info',
        'Mode fixed: tunggu waktu minimal soal habis, lalu kamu bebas pindah soal dan mengganti jawaban sampai waktu ujian habis.');
    } else {
      UI.hideMsg('exam-mode-info');
    }
  }

  function startTimer() {
    if (!S) return;
    if (isPerQ()) Timer.start(S.attempt.question_end_at_ms, onTick, onQuestionTimeUp);
    else Timer.start(S.attempt.end_at_ms, onTick, onTimeUp);
  }

  function current() { return S.questions[S.index]; }

  /** FIXED: siswa wajib tetap di soal terdepan sampai waktu minimalnya habis. */
  function fixedPinned() {
    return isFixed() && S.index === S.attempt.frontier_index && Timer.now() < S.attempt.question_end_at_ms;
  }

  function fixedAllDone() {
    return isFixed() && S.attempt.frontier_index >= S.questions.length - 1 &&
      Timer.now() >= S.attempt.question_end_at_ms;
  }

  function isLocked() {
    if (!S) return true;
    if (S.finishing) return true;
    if (isPerQ()) return S.advancing || Timer.now() >= S.attempt.question_end_at_ms;
    if (isFixed()) return S.advancing || Timer.now() >= S.attempt.end_at_ms;
    return false;
  }

  function displayLetterOf(q, original) {
    const opt = q.options.find(function (o) { return o.original === original; });
    return opt ? opt.display : '?';
  }

  function answeredCount() {
    return S.questions.filter(function (q) {
      const a = S.answers[q.question_id];
      return a && a.answer;
    }).length;
  }

  function render() {
    if (!S) return;
    const q = current();
    const N = S.questions.length;
    $('exam-title').textContent = S.attempt.exam_name;
    $('exam-progress').textContent = 'Soal ' + (S.index + 1) + ' dari ' + N + ' · ' + MODE_TEXT[S.attempt.mode];
    $('exam-qnum').textContent = String(S.index + 1);
    MathRenderer.renderInto($('exam-question-text'), q.question);
    renderImage(q);
    renderAll();
  }

  function renderAll() {
    if (!S) return;
    renderOptions();
    renderSaveStatus();
    renderGrid();
    renderNav();
    renderProgress();
    renderFlag();
  }

  /* ---------- Ragu-ragu (TOTAL & FIXED) ---------- */

  function flaggedNumbers() {
    const out = [];
    if (!S || !S.flags || isPerQ()) return out;
    S.questions.forEach(function (q, i) { if (S.flags[q.question_id]) out.push(i + 1); });
    return out;
  }

  function renderFlag() {
    const btn = $('btn-flag');
    if (!btn || !S) return;
    if (isPerQ()) { btn.hidden = true; return; }
    btn.hidden = false;
    const on = !!S.flags[current().question_id];
    btn.classList.toggle('is-on', on);
    btn.textContent = on ? '🚩 Ditandai ragu-ragu' : '🏳️ Tandai ragu-ragu';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.disabled = !!S.finishing;
  }

  function onToggleFlag() {
    if (!S || S.finishing || isPerQ()) return;
    const qid = current().question_id;
    if (S.flags[qid]) delete S.flags[qid]; else S.flags[qid] = true;
    const attemptId = S.attempt.attempt_id;
    const copy = Object.assign({}, S.flags);
    DB.setSetting('flags:' + attemptId, copy).catch(function (e) { console.warn('Gagal menyimpan tanda ragu-ragu:', e); });
    renderFlag();
    renderGrid();
  }

  function renderProgress() {
    const fill = $('exam-progress-fill');
    if (!fill) return;
    const N = S.questions.length;
    const pct = N ? Math.round(answeredCount() / N * 100) : 0;
    fill.style.width = pct + '%';
    $('exam-progress-text').textContent = answeredCount() + ' / ' + N + ' terjawab';
  }

  function renderNav() {
    if (!S || isPerQ()) return;
    const N = S.questions.length;
    const prev = $('btn-prev');
    const next = $('btn-next');
    const finish = $('btn-finish');
    const hint = $('exam-wait-hint');

    if (isFixed()) {
      const pinned = fixedPinned();
      const f = S.attempt.frontier_index;
      prev.disabled = S.finishing || S.advancing || pinned || S.index === 0;
      next.disabled = S.finishing || S.advancing || pinned || S.index >= N - 1 || (S.index === f && f >= N - 1);
      next.textContent = (S.index === f && f < N - 1) ? 'Buka soal berikutnya →' : 'Berikutnya →';
      finish.disabled = S.finishing || !fixedAllDone();
      if (pinned) {
        hint.hidden = false;
        hint.textContent = 'Tunggu waktu minimal soal ini habis dulu, baru kamu bisa pindah soal.';
      } else if (!fixedAllDone()) {
        hint.hidden = false;
        hint.textContent = 'Kamu boleh pindah soal. Tombol "Selesai ujian" aktif setelah semua soal dibuka.';
      } else {
        hint.hidden = true;
      }
    } else {
      prev.disabled = S.finishing || S.index === 0;
      next.disabled = S.finishing || S.index === N - 1;
      next.textContent = 'Berikutnya →';
      finish.disabled = S.finishing;
      hint.hidden = true;
    }
  }

  function renderImage(q) {
    const img = $('exam-question-image');
    if (S.imageUrl) {
      URL.revokeObjectURL(S.imageUrl);
      S.imageUrl = null;
    }
    if (q.image && q.image.blob instanceof Blob) {
      S.imageUrl = URL.createObjectURL(q.image.blob);
      img.src = S.imageUrl;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }

  function renderOptions() {
    const q = current();
    const cur = S.answers[q.question_id];
    const locked = isLocked();
    const box = $('exam-options');
    box.replaceChildren();
    q.options.forEach(function (o) {
      const selected = !!(cur && cur.answer === o.original);
      box.appendChild(el('button', {
        className: 'option-btn option-' + o.display.toLowerCase() + (selected ? ' selected' : '') +
          (selected && cur._pending ? ' pending' : ''),
        type: 'button',
        data: { original: o.original, display: o.display },
        disabled: locked
      }, [
        el('span', { className: 'option-letter', text: o.display }),
        (function(){ const span=el('span',{className:'option-text'}); MathRenderer.renderInto(span,o.text); return span; })(),
        el('span', { className: 'option-check', text: selected ? '✓' : '' })
      ]));
    });
    $('btn-clear-answer').disabled = locked || !(cur && cur.answer);
  }

  function renderSaveStatus() {
    const q = current();
    const cur = S.answers[q.question_id];
    const box = $('exam-save-status');
    const perQ = isPerQ();

    if (S.saving > 0) {
      box.className = 'save-status save-pending';
      box.textContent = 'Menyimpan jawaban...';
    } else if (perQ && isLocked() && !S.finishing) {
      box.className = 'save-status save-pending';
      box.textContent = 'Waktu soal ini habis. Soal dikunci, membuka soal berikutnya...';
    } else if (S.saveError) {
      box.className = 'save-status save-error';
      box.textContent = 'GAGAL MENYIMPAN: ' + S.saveError;
    } else if (cur && cur.answer) {
      box.className = 'save-status save-ok';
      let extra = '';
      if (perQ) extra = ' Kamu tetap di soal ini sampai waktunya habis; jawaban masih bisa diganti.';
      if (fixedPinned()) extra = ' Tunggu waktu minimal soal habis, lalu kamu boleh pindah soal.';
      box.textContent = 'Jawaban ' + displayLetterOf(q, cur.answer) + ' tersimpan (' + UI.formatClock(cur.answered_at) + ').' + extra;
    } else {
      box.className = 'save-status save-none';
      box.textContent = 'Soal ini belum dijawab.';
    }
  }

  function renderGrid() {
    const perQ = isPerQ();
    const fixed = isFixed();
    const grid = $('exam-grid');
    grid.replaceChildren();
    const f = fixed ? S.attempt.frontier_index : -1;
    const pinned = fixed && fixedPinned();
    S.questions.forEach(function (q, i) {
      const a = S.answers[q.question_id];
      let cls = 'grid-btn';
      let label = String(i + 1);
      let disabled = false;
      if (a && a.answer) cls += ' answered';
      if (!perQ && S.flags && S.flags[q.question_id]) cls += ' doubt';
      if (perQ) {
        if (!(a && a.answer) && i < S.index) cls += ' locked';
        disabled = true;
      } else if (fixed) {
        if (i > f + 1 || (i === f + 1 && Timer.now() < S.attempt.question_end_at_ms)) {
          cls += ' locked';
          label = '🔒';
          disabled = true;
        } else if (i === f + 1) {
          cls += ' next-open';
          label = '+' + (i + 1);
        }
        if (pinned && i !== S.index) disabled = true;
      }
      if (i === S.index) cls += ' current';
      grid.appendChild(el('button', {
        className: cls,
        type: 'button',
        text: label,
        data: { index: String(i) },
        disabled: disabled || (S && S.finishing)
      }));
    });
  }

  function onTick(remainingMs) {
    const text = UI.formatDuration(remainingMs);
    const warnLimit = isPerQ() ? 10 * 1000 : 5 * 60 * 1000;
    const warn = remainingMs <= warnLimit;
    ['exam-timer', 'confirm-timer'].forEach(function (id) {
      const t = $(id);
      t.textContent = text;
      t.classList.toggle('timer-warn', warn);
    });
    const box = $('exam-timer-box');
    if (box) box.classList.toggle('timer-warn', warn);

    if (isFixed()) {
      const qt = $('exam-qtimer');
      const pinned = fixedPinned();
      if (pinned) {
        qt.textContent = '⏳ Tunggu ' + UI.formatDuration(S.attempt.question_end_at_ms - Timer.now());
        qt.className = 'qtimer qtimer-wait';
      } else {
        qt.textContent = '✓ Boleh pindah soal';
        qt.className = 'qtimer qtimer-free';
      }
      if (S.wasPinned !== pinned) {
        const wasPinned = S.wasPinned;
        S.wasPinned = pinned;
        renderAll();
        if (wasPinned === true && !pinned) {
          showNotice('Waktu minimal soal ini sudah habis. Sekarang kamu boleh pindah soal.', 'ok');
        }
      }
    }
  }

  function showNotice(text, type) {
    UI.showMsg('exam-notice', type || 'info', text);
    if (noticeHandle) clearTimeout(noticeHandle);
    noticeHandle = setTimeout(function () { UI.hideMsg('exam-notice'); }, 10000);
  }

  /* =========================================================
   * WAKTU HABIS
   * ========================================================= */

  function onTimeUp() {
    finish('TIME_UP');
  }

  async function onQuestionTimeUp() {
    if (!S || S.finishing || S.advancing) return;
    S.advancing = true;
    renderAll();

    await saveChain;
    if (!S) return;

    const idx = S.index;
    if (idx >= S.questions.length - 1) {
      S.advancing = false;
      await finish('ALL_DONE');
      return;
    }

    try {
      const a = await advanceQuestion(S.attempt.attempt_id, idx);
      if (!S) return;
      S.attempt = a;
      S.index = a.current_index;
      S.saveError = null;
      S.advancing = false;
      render();
      startTimer();
      window.scrollTo(0, 0);
      showNotice('Waktu soal ' + (idx + 1) + ' habis dan soal dikunci. Sekarang soal ' + (S.index + 1) + '.');
    } catch (e) {
      if (!S) return;
      S.advancing = false;
      if (e && e.code === 'NOT_YET') {
        startTimer();
        return;
      }
      S.saveError = 'Gagal membuka soal berikutnya: ' + (e && e.message ? e.message : e) + ' Mencoba lagi...';
      renderAll();
      setTimeout(onQuestionTimeUp, 3000);
    }
  }

  /* =========================================================
   * MENJAWAB
   * ========================================================= */

  function queueSave(q, original, display) {
    if (!S || isLocked()) return;
    const clickedAt = Timer.now();
    const attemptId = S.attempt.attempt_id;
    const qid = q.question_id;
    const seq = ++saveSeq;
    S.pendingSeq[qid] = seq;

    S.answers[qid] = { attempt_id: attemptId, question_id: qid, answer: original, display_letter: display, _pending: true };
    S.saving++;
    renderAll();

    saveChain = saveChain
      .then(function () { return saveAnswerToDb(attemptId, q, original, display, clickedAt); })
      .then(function (rec) {
        if (!S || S.attempt.attempt_id !== attemptId) return;
        if (S.pendingSeq[qid] === seq) S.answers[qid] = rec;
        S.saveError = null;
      })
      .catch(async function (e) {
        if (!S || S.attempt.attempt_id !== attemptId) return;
        S.saveError = ((e && e.message) ? e.message : String(e)) +
          (e && e.code === 'QUESTION_LOCKED' ? '' : ' Silakan pilih jawaban lagi.');
        try {
          const fresh = await DB.get('answers', [attemptId, qid]);
          if (S && S.pendingSeq[qid] === seq) {
            if (fresh) S.answers[qid] = fresh;
            else delete S.answers[qid];
          }
        } catch (ignore) { /* tampilan tetap */ }
        if (e && (e.code === 'TIME_UP' || e.code === 'ATTEMPT_CLOSED') && !isPerQ()) {
          setTimeout(function () { finish('TIME_UP'); }, 0);
        }
      })
      .then(function () {
        if (!S || S.attempt.attempt_id !== attemptId) return;
        S.saving = Math.max(0, S.saving - 1);
        renderAll();
      });
  }

  function onOptionClick(event) {
    const btn = event.target.closest('button[data-original]');
    if (!btn || !S || isLocked()) return;
    queueSave(current(), btn.dataset.original, btn.dataset.display);
  }

  function onClearAnswer() {
    if (!S || isLocked()) return;
    const q = current();
    const cur = S.answers[q.question_id];
    if (!cur || !cur.answer) return;
    queueSave(q, '', '');
  }

  /* =========================================================
   * NAVIGASI (TOTAL: bebas; FIXED: dengan waktu minimal; PER_SOAL: tidak ada)
   * ========================================================= */

  async function goTo(i) {
    if (!S || S.finishing || isPerQ() || S.advancing) return;
    if (i < 0 || i >= S.questions.length || i === S.index) return;

    if (isFixed()) {
      if (fixedPinned()) {
        showNotice('Tunggu waktu minimal soal ini habis dulu, baru kamu bisa pindah soal.', 'warn');
        return;
      }
      const f = S.attempt.frontier_index;
      if (i === f + 1) {
        await openNext(f);
        return;
      }
      if (i > f + 1) {
        showNotice('Buka soal secara berurutan.', 'warn');
        return;
      }
    }

    S.index = i;
    S.saveError = null;
    render();
    persistPosition();
    window.scrollTo(0, 0);
  }

  async function openNext(expectedFrontier) {
    S.advancing = true;
    renderAll();
    await saveChain;
    if (!S) return;
    try {
      const a = await openNextFixed(S.attempt.attempt_id, expectedFrontier);
      if (!S) return;
      S.attempt = a;
      S.index = a.frontier_index;
      S.saveError = null;
      S.advancing = false;
      S.wasPinned = null;
      render();
      Timer.tickNow();
      window.scrollTo(0, 0);
      showNotice('Soal ' + (S.index + 1) + ' dibuka. Tunggu ' + S.attempt.per_question_seconds +
        ' detik sebelum pindah soal.', 'info');
    } catch (e) {
      if (!S) return;
      S.advancing = false;
      renderAll();
      if (e && e.code === 'TIME_UP') { finish('TIME_UP'); return; }
      showNotice(e && e.message ? e.message : String(e), 'warn');
    }
  }

  function onGridClick(event) {
    if (isPerQ()) return;
    const btn = event.target.closest('button[data-index]');
    if (!btn || btn.disabled) return;
    goTo(Number(btn.dataset.index));
  }

  /* =========================================================
   * SELESAI
   * ========================================================= */

  function openConfirm() {
    if (!S || S.finishing || isPerQ()) return;
    if (isFixed() && !fixedAllDone()) {
      showNotice('Buka semua soal sampai soal terakhir dan tunggu waktunya habis, baru kamu bisa menyelesaikan ujian.', 'warn');
      return;
    }
    const N = S.questions.length;
    const unanswered = [];
    S.questions.forEach(function (q, i) {
      const a = S.answers[q.question_id];
      if (!a || !a.answer) unanswered.push(i + 1);
    });
    const doubts = flaggedNumbers();
    UI.setRows('confirm-info', [
      ['Terjawab', (N - unanswered.length) + ' dari ' + N],
      ['Belum dijawab', unanswered.length ? 'Nomor ' + unanswered.join(', ') : 'Tidak ada'],
      ['Ragu-ragu', doubts.length ? 'Nomor ' + doubts.join(', ') : 'Tidak ada'],
      ['Pelanggaran tercatat', S.violationCount || 0]
    ]);
    if (S.saving > 0) UI.showMsg('confirm-warning', 'warn', 'Masih ada jawaban yang sedang disimpan. Tunggu sebentar.');
    else if (unanswered.length) UI.showMsg('confirm-warning', 'warn', 'Masih ada ' + unanswered.length + ' soal yang belum dijawab.');
    else if (doubts.length) UI.showMsg('confirm-warning', 'warn', 'Masih ada ' + doubts.length + ' soal yang kamu tandai ragu-ragu. Periksa lagi sebelum selesai.');
    else UI.hideMsg('confirm-warning');
    Timer.tickNow();
    UI.showScreen('exam-confirm');
  }

  function closeConfirm() {
    if (!S || S.finishing) return;
    UI.showScreen('exam');
    render();
  }

  async function finish(reason) {
    if (!S || S.finishing) return;
    S.finishing = true;
    const attemptId = S.attempt.attempt_id;
    Timer.stop();
    stopHeartbeat();
    UI.setBusy($('btn-confirm-yes'), true, 'Menyimpan...');
    render();

    await saveChain;

    let done;
    try {
      done = await finishAttempt(attemptId, reason);
    } catch (e) {
      UI.setBusy($('btn-confirm-yes'), false);
      if (!S) return;
      S.finishing = false;
      S.saveError = 'Gagal menyimpan status selesai: ' + e.message;
      UI.showScreen('exam');
      render();
      const timeIsUp = isPerQ() || Timer.now() >= S.attempt.end_at_ms;
      if (timeIsUp) {
        setTimeout(function () { finish(reason); }, 5000);
      } else {
        startTimer();
        startHeartbeat();
      }
      return;
    }
    UI.setBusy($('btn-confirm-yes'), false);
    DB.delSetting('flags:' + attemptId).catch(function () { /* abaikan */ });
    cleanup();
    exitFullscreen();
    showDone(done, null);
    if (typeof Live !== 'undefined' && Live.beatSoon) Live.beatSoon();
  }

  function showDone(a, note) {
    const N = (a.question_order || []).length;
    let defaultNote = 'Hebat! Ujian berhasil diselesaikan.';
    if (a.finish_reason === 'TIME_UP') defaultNote = 'Waktu habis. Ujian diselesaikan otomatis.';
    if (a.finish_reason === 'ALL_DONE') defaultNote = 'Waktu soal terakhir habis. Ujian selesai.';

    const backward = (a.clock_events || []).filter(function (e) {
      return e.type === 'CLOCK_BACKWARD' || e.type === 'CLOCK_BACKWARD_WHILE_CLOSED';
    }).length;

    $('done-message').textContent = note || defaultNote;
    UI.setRows('done-info', [
      ['Ujian', a.exam_name],
      ['Mode', MODE_TEXT[a.mode] || a.mode],
      ['Selesai pada', UI.formatDateTime(a.completed_at)],
      ['Cara selesai', REASON_TEXT[a.finish_reason] || a.finish_reason],
      ['Terjawab', a.answered_count + ' dari ' + N],
      ['Pelanggaran', a.violation_count || 0],
      ['Catatan jam', backward ? backward + ' kali jam perangkat diubah mundur (dicatat)' : 'Tidak ada'],
      ['Status pengiriman', a.sync_status === 'SYNCED' ? 'Sudah terkirim' : 'Menunggu dikirim'],
      ['Kode attempt', a.attempt_id]
    ]);
    UI.showScreen('exam-done');
  }

  function cleanup() {
    if (S && S.imageUrl) URL.revokeObjectURL(S.imageUrl);
    S = null;
    Timer.stop();
    stopHeartbeat();
    releaseWakeLock();
    releaseExamLock();
    renderFullscreenButton();
  }

  /* =========================================================
   * PERLINDUNGAN SELAMA UJIAN
   * ========================================================= */

  function onBeforeUnload(event) {
    if (S && !S.finishing) {
      beat();
      event.preventDefault();
      event.returnValue = '';
    }
  }

  function onPopState() {
    if (S) {
      try { history.pushState({ siberExam: true }, ''); } catch (e) { /* abaikan */ }
      showNotice('Tombol kembali tidak dapat dipakai selama ujian.');
    }
  }

  function onVisibility() {
    if (!S) return;
    if (document.visibilityState === 'visible') {
      Timer.tickNow();
      requestWakeLock();
      if (document.hasFocus()) onReturn();
    } else {
      beat();
      onLeave();
    }
  }

  function blockDuringExam(event) {
    if (S) event.preventDefault();
  }

  /* =========================================================
   * PUBLIK
   * ========================================================= */

  function init(h) {
    hooks = h || {};
    $('btn-intro-start').addEventListener('click', onIntroStart);
    $('btn-intro-back').addEventListener('click', onIntroBack);
    $('intro-token').addEventListener('keydown', function (e) { if (e.key === 'Enter') onIntroStart(); });
    $('exam-options').addEventListener('click', onOptionClick);
    $('btn-clear-answer').addEventListener('click', onClearAnswer);
    if ($('btn-flag')) $('btn-flag').addEventListener('click', onToggleFlag);
    $('btn-prev').addEventListener('click', function () { if (S) goTo(S.index - 1); });
    $('btn-next').addEventListener('click', function () { if (S) goTo(S.index + 1); });
    $('exam-grid').addEventListener('click', onGridClick);
    $('btn-finish').addEventListener('click', openConfirm);
    $('btn-confirm-no').addEventListener('click', closeConfirm);
    $('btn-confirm-yes').addEventListener('click', function () { finish('MANUAL'); });
    $('btn-done-home').addEventListener('click', function () { if (hooks.onExit) hooks.onExit(); });
    $('btn-fullscreen').addEventListener('click', requestFullscreen);

    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', function () { beat(); });
    window.addEventListener('popstate', onPopState);
    window.addEventListener('blur', function () { if (S) onLeave(); });
    window.addEventListener('focus', function () { if (S && document.visibilityState === 'visible') onReturn(); });
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('freeze', function () { beat(); });
    ['copy', 'cut', 'contextmenu'].forEach(function (ev) { document.addEventListener(ev, blockDuringExam); });
    Timer.onAnomaly(onClockAnomaly);

    repair().catch(function (e) { console.warn('Pemeriksaan data saat dibuka gagal:', e); });
  }

  async function resumeIfAny(user) {
    if (!user || user.role !== 'STUDENT') return false;
    const a = await findInProgress(user.user_id);
    if (!a) return false;
    await resume(a);
    return true;
  }

  function isActive() { return !!S; }

  /** Ringkasan untuk laporan pantauan guru (dikirim saat online). */
  function getLiveInfo() {
    if (!S) return null;
    const a = S.attempt;
    const end = a.mode === 'PER_SOAL' ? a.question_end_at_ms : a.end_at_ms;
    return {
      state: 'EXAM',
      exam_id: a.exam_id,
      attempt_id: a.attempt_id,
      mode: a.mode,
      answered: answeredCount(),
      total: S.questions.length,
      current: S.index + 1,
      violations: S.violationCount || 0,
      remaining_ms: Math.max(0, end - Timer.now())
    };
  }

  return {
    init: init,
    openIntro: openIntro,
    resumeIfAny: resumeIfAny,
    getUserAttempts: getUserAttempts,
    countUnsyncedAttempts: countUnsyncedAttempts,
    isActive: isActive,
    getLiveInfo: getLiveInfo,
    fixedTotalMs: fixedTotalMs
  };
})();
