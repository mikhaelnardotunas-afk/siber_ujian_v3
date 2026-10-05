/**
 * SIBER-UJIAN — guru-extra.js (v3)
 * Tab dashboard guru: Pantau langsung · Hasil & nilai · Siswa & HP · Laporan PDF · Token.
 * Bergantung pada dashboard.js (window.SiberDash) dan laporan.js (Laporan).
 */
(function () {
  'use strict';

  const $ = UI.$;
  const el = UI.el;
  const TAB_KEY = 'siber_guru_tab';
  const TABS = ['pantau', 'hasil', 'siswa', 'laporan', 'token'];

  let activeTab = 'pantau';
  let siswaData = null;
  let siswaLoading = false;
  let rep = null;           // data getReportData
  let repLoading = null;    // Promise saat memuat
  let identityFilled = false;
  let tokenLoading = false;

  /* ---------- Bantuan ---------- */

  function dash() { return window.SiberDash || { getExamId: function () { return ''; }, getClass: function () { return ''; } }; }
  function show(v) { return (v === null || v === undefined || v === '') ? '-' : String(v); }
  function up(v) { return String(v || '').trim().toUpperCase(); }
  function badge(text, cls) { return el('span', { className: 'badge ' + (cls || ''), text: text }); }
  function serverOld(res) {
    return res && res.error && res.error.code === 'UNKNOWN_ACTION'
      ? 'Server belum diperbarui. Tempel Fitur.gs dan Code.gs versi baru di Apps Script, jalankan setupFiturV3, lalu Terapkan → Kelola deployment → Versi baru.'
      : null;
  }
  function errText(res) { return serverOld(res) || UI.errorText(res); }

  function agoText(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return '-';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'baru saja';
    if (s < 3600) return Math.round(s / 60) + ' mnt lalu';
    if (s < 86400) return Math.round(s / 3600) + ' jam lalu';
    return Math.round(s / 86400) + ' hari lalu';
  }

  function cell(c) {
    if (c instanceof Node) return el('td', null, [c]);
    if (c && typeof c === 'object') {
      const td = el('td', { className: c.className || '', text: show(c.text) });
      if (c.title) td.title = c.title;
      return td;
    }
    return el('td', { text: show(c) });
  }

  function table(headers, rows, rowClass) {
    const thead = el('thead', null, [el('tr', null, headers.map(function (h) { return el('th', { text: h }); }))]);
    const tbody = el('tbody', null, rows.map(function (r) {
      const tr = el('tr', null, r.cells.map(cell));
      if (rowClass) tr.className = rowClass(r) || '';
      return tr;
    }));
    return el('table', { className: 'data-table' }, [thead, tbody]);
  }

  function fillSelect(sel, items, keep) {
    const old = keep !== undefined ? keep : sel.value;
    sel.replaceChildren();
    items.forEach(function (it) {
      const o = el('option', { text: it[1] });
      o.value = it[0];
      sel.appendChild(o);
    });
    if (items.some(function (it) { return it[0] === old; })) sel.value = old;
  }

  function todayLocal() { return UI.todayLocal(); }

  /* ---------- Tab ---------- */

  function setTab(name, noLoad) {
    if (TABS.indexOf(name) === -1) name = 'pantau';
    activeTab = name;
    document.querySelectorAll('#dash-tabs .tab').forEach(function (b) {
      const on = b.dataset.tab === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    TABS.forEach(function (t) {
      const p = $('tab-' + t);
      if (p) p.hidden = t !== name;
    });
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* abaikan */ }
    if (noLoad) return;
    if (name === 'siswa') loadSiswa();
    else if (name === 'laporan') prepareReport(false);
    else if (name === 'token') loadTokens();
  }

  function onSelectionChange() {
    if (activeTab === 'siswa') loadSiswa();
    else if (activeTab === 'token' && $('token-only-exam').checked) loadTokens();
    if (rep) {
      const ex = dash().getExamId();
      if (ex && Array.prototype.some.call($('lap-exam').options, function (o) { return o.value === ex; })) $('lap-exam').value = ex;
      refreshStudentOptions();
    }
  }

  /* =========================================================
   * SISWA & HP
   * ========================================================= */

  async function loadSiswa() {
    if (siswaLoading) return;
    if (!navigator.onLine) { UI.showMsg('siswa-message', 'warn', 'Tab ini memerlukan internet.'); return; }
    siswaLoading = true;
    UI.setBusy($('btn-siswa-refresh'), true, 'Memuat...');
    UI.showMsg('siswa-message', 'info', 'Memuat data siswa dan HP...');
    const res = await Auth.authedCall('getDeviceOverview', { exam_id: dash().getExamId(), class: dash().getClass() });
    UI.setBusy($('btn-siswa-refresh'), false);
    siswaLoading = false;
    if (!res.success) { UI.showMsg('siswa-message', 'error', 'Gagal memuat: ' + errText(res)); return; }
    siswaData = res.data;
    UI.showMsg('siswa-message', 'ok', 'Diperbarui ' + UI.formatClock(new Date().toISOString()) +
      (siswaData.exam ? ' · Ujian: ' + siswaData.exam.exam_name + ' (versi ' + siswaData.exam.version + ')' : ''));
    renderSiswa();
  }

  function renderSiswa() {
    if (!siswaData) return;
    const d = siswaData;
    const hasExam = !!d.exam;

    const sum = $('siswa-summary');
    sum.replaceChildren();
    if (!d.class_summary.length) {
      sum.appendChild(el('p', { className: 'small', text: 'Belum ada siswa untuk pilihan ini.' }));
    } else {
      sum.appendChild(table(
        ['Kelas', 'Siswa', 'Pernah login', hasExam ? 'Punya HP siap ujian ini' : 'Punya HP', hasExam ? 'Sudah kirim hasil' : '-',
          'Jumlah HP', hasExam ? 'HP berisi ujian ini' : '-', 'Jawaban tertahan'],
        d.class_summary.map(function (c) {
          const pct = function (n) { return c.students ? n + ' / ' + c.students + ' (' + Math.round(n / c.students * 100) + '%)' : String(n); };
          return {
            c: c,
            cells: [
              { text: c.class, className: 'strong' },
              { text: c.students, className: 'num' },
              { text: pct(c.logged_in), className: 'num' },
              { text: pct(c.device_ready), className: 'num' },
              { text: hasExam ? pct(c.submitted) : '-', className: 'num' },
              { text: c.devices, className: 'num' },
              { text: hasExam ? c.devices_with_exam : '-', className: 'num' },
              c.pending ? badge(c.pending + ' tertahan', 'badge-warn') : { text: '0', className: 'num' }
            ]
          };
        }),
        function (r) { return r.c.pending ? 'row-warn' : ''; }
      ));
    }

    const f = $('siswa-filter').value;
    const list = d.students.filter(function (s) {
      if (f === 'never') return !s.last_login_at;
      if (f === 'noexam') return !s.device_ready;
      if (f === 'notsent') return !s.submitted;
      if (f === 'pending') return s.pending > 0;
      return true;
    });
    const sb = $('siswa-students');
    sb.replaceChildren();
    sb.appendChild(el('p', { className: 'small', text: list.length + ' dari ' + d.students.length + ' siswa ditampilkan.' }));
    if (list.length) {
      sb.appendChild(table(
        ['No', 'Nama', 'Kelas', 'Username', 'Login terakhir', 'Cara', 'HP terakhir', 'Login', hasExam ? 'HP siap ujian ini' : 'HP',
          hasExam ? 'Hasil' : '-', 'Tertahan'],
        list.map(function (s, i) {
          return {
            s: s,
            cells: [
              { text: i + 1, className: 'num' },
              { text: s.name, className: 'strong' },
              s.class,
              s.username,
              s.last_login_at ? { text: agoText(s.last_login_at), title: UI.formatDateTime(s.last_login_at) } : badge('Belum pernah', 'badge-bad'),
              s.last_login_mode ? badge(s.last_login_mode === 'OFFLINE' ? 'Offline' : 'Online', s.last_login_mode === 'OFFLINE' ? 'badge-muted' : 'badge-done') : '-',
              { text: s.last_device_info || (s.last_device_id ? s.last_device_id.substring(0, 12) : '-'), className: 'wrap', title: s.last_device_id },
              { text: s.login_count, className: 'num' },
              s.device_ready ? badge('✔ Siap', 'badge-done') : badge('✘ Belum', 'badge-warn'),
              hasExam ? (s.submitted ? badge('Terkirim', 'badge-done') : badge('Belum', 'badge-muted')) : '-',
              s.pending ? badge(s.pending + ' tertahan', 'badge-bad') : { text: '0', className: 'num' }
            ]
          };
        }),
        function (r) { return r.s.pending ? 'row-alert' : (!r.s.last_login_at ? 'row-missing' : ''); }
      ));
    }

    const db = $('siswa-devices');
    db.replaceChildren();
    if (!d.devices.length) {
      db.appendChild(el('p', { className: 'small', text: 'Belum ada HP yang melapor. HP melapor otomatis saat aplikasi siswa versi baru dibuka dalam keadaan online.' }));
      return;
    }
    db.appendChild(table(
      ['No', 'HP', 'Kelas pengguna', 'Pengguna terakhir', 'Online terakhir', hasExam ? 'Ujian ini ada?' : '-', 'Ujian siap', 'Jawaban tertahan', 'Versi app'],
      d.devices.map(function (x, i) {
        let exCell = '-';
        if (hasExam) {
          if (!x.has_exam) exCell = badge('✘ Tidak', 'badge-warn');
          else if (x.exam_latest) exCell = badge('✔ Ya (terbaru)', 'badge-done');
          else exCell = badge('⚠ Versi lama (' + show(x.exam_version) + ')', 'badge-bad');
        }
        const pend = x.pending
          ? el('div', null, [badge(x.pending + ' tertahan', 'badge-bad'), el('div', { className: 'small', text: (x.pending_names || []).join(', ') })])
          : '0';
        return {
          x: x,
          cells: [
            { text: i + 1, className: 'num' },
            { text: (x.info || 'HP') + ' · ' + x.device_id.substring(4, 10), className: 'wrap', title: x.device_id },
            { text: x.classes, className: 'wrap' },
            x.last_user_name,
            { text: agoText(x.last_online), title: UI.formatDateTime(x.last_online) },
            exCell,
            { text: x.exam_count, className: 'num' },
            pend,
            x.client_version
          ]
        };
      }),
      function (r) { return r.x.pending ? 'row-alert' : ''; }
    ));
  }

  /* =========================================================
   * LAPORAN PDF
   * ========================================================= */

  async function loadReportData(force) {
    if (rep && !force) return rep;
    if (repLoading) return repLoading;
    repLoading = (async function () {
      if (navigator.onLine) {
        const res = await Auth.authedCall('getReportData', {}, 90000);
        if (res.success) {
          rep = res.data;
          try { await DB.setSetting('lap_data', { data: rep, at: new Date().toISOString() }); } catch (e) { /* abaikan */ }
          return rep;
        }
        const cached = await DB.getSetting('lap_data');
        if (cached && !serverOld(res)) {
          rep = cached.data;
          UI.showMsg('lap-message', 'warn', 'Gagal memuat data terbaru (' + errText(res) + '). Memakai data tersimpan ' + UI.formatDateTime(cached.at) + '.');
          return rep;
        }
        throw new Error(errText(res));
      }
      const cached = await DB.getSetting('lap_data');
      if (cached) {
        rep = cached.data;
        UI.showMsg('lap-message', 'warn', 'Offline. Memakai data tersimpan ' + UI.formatDateTime(cached.at) + '.');
        return rep;
      }
      throw new Error('Perangkat offline dan belum ada data laporan tersimpan.');
    })();
    try { return await repLoading; } finally { repLoading = null; }
  }

  async function prepareReport(force) {
    UI.showMsg('lap-message', 'info', 'Memuat data nilai...');
    UI.setBusy($('btn-lap-refresh'), true, 'Memuat...');
    try {
      await loadReportData(force);
      fillReportForm();
      UI.showMsg('lap-message', 'ok', rep.exams.length + ' ujian, ' + rep.students.length + ' siswa aktif, ' +
        rep.results.length + ' hasil terkirim. Data diambil ' + UI.formatDateTime(rep.generated_at) + '.');
    } catch (e) {
      UI.showMsg('lap-message', 'error', 'Gagal memuat data laporan: ' + e.message);
    } finally {
      UI.setBusy($('btn-lap-refresh'), false);
    }
  }

  function jenis() {
    const r = document.querySelector('input[name="lap-jenis"]:checked');
    return r ? r.value : 'rekap';
  }

  function classesFor(examId) {
    const set = {};
    const ex = examId ? rep.exams.find(function (e) { return e.exam_id === examId; }) : null;
    rep.students.forEach(function (s) {
      if (!s.class) return;
      if (ex && s.grade !== ex.grade) return;
      set[s.class] = true;
    });
    return Object.keys(set).sort();
  }

  function fillReportForm() {
    if (!rep) return;
    const exams = rep.exams.slice().sort(function (a, b) { return a.exam_name.localeCompare(b.exam_name, 'id'); });
    fillSelect($('lap-exam'), exams.map(function (e) {
      return [e.exam_id, e.exam_name + ' · ' + e.subject + ' · ' + e.grade + ' (' + e.exam_id + ')'];
    }), $('lap-exam').value || dash().getExamId());
    const subjects = {};
    rep.exams.forEach(function (e) { if (e.subject) subjects[e.subject] = true; });
    fillSelect($('lap-subject'), [['', 'Semua mata pelajaran']].concat(Object.keys(subjects).sort().map(function (s) { return [s, s]; })));
    refreshClassOptions();

    const st = rep.settings || {};
    if (!$('lap-kkm').value) $('lap-kkm').value = st.KKM || '75';
    if (!$('lap-date').value) $('lap-date').value = todayLocal();
    if (!identityFilled) {
      identityFilled = true;
      const me = Auth.getState();
      $('lap-city').value = st.KOTA || '';
      $('lap-year').value = st.TAHUN_PELAJARAN || '';
      $('lap-teacher').value = st.NAMA_GURU || (me ? me.user.name : '');
      $('lap-teacher-nip').value = st.NIP_GURU || '';
      $('lap-head').value = st.NAMA_KEPSEK || '';
      $('lap-head-nip').value = st.NIP_KEPSEK || '';
      $('lap-logo').value = st.LOGO_URL || '';
    }
    applyJenis();
  }

  function refreshClassOptions() {
    if (!rep) return;
    const j = jenis();
    const examBased = ['rekap', 'detail', 'analisis'].indexOf(j) !== -1;
    const cls = classesFor(examBased ? $('lap-exam').value : '');
    const first = (j === 'kelas') ? [] : [['', 'Semua kelas']];
    const keep = $('lap-class').value || (dash().getClass() || '');
    fillSelect($('lap-class'), first.concat(cls.map(function (c) { return [c, c]; })), keep);
    refreshStudentOptions();
  }

  function refreshStudentOptions() {
    if (!rep) return;
    const j = jenis();
    const kelas = $('lap-class').value;
    const ex = rep.exams.find(function (e) { return e.exam_id === $('lap-exam').value; });
    const list = rep.students.filter(function (s) {
      if (kelas && up(s.class) !== up(kelas)) return false;
      if (j === 'detail' && ex && s.grade !== ex.grade) return false;
      return true;
    }).sort(function (a, b) { return (a.class + '|' + a.name).localeCompare(b.class + '|' + b.name, 'id'); });
    const first = j === 'detail' ? [['', 'Semua siswa (1 halaman per siswa)']] : [['', '— pilih siswa —']];
    fillSelect($('lap-student'), first.concat(list.map(function (s) { return [s.user_id, s.name + ' (' + s.class + ')']; })));
  }

  function applyJenis() {
    const j = jenis();
    document.querySelectorAll('#lap-form [data-lap]').forEach(function (n) {
      n.hidden = n.dataset.lap.split(' ').indexOf(j) === -1;
    });
    document.querySelectorAll('#lap-types .lap-type').forEach(function (l) {
      l.classList.toggle('is-on', l.querySelector('input').checked);
    });
    refreshClassOptions();
  }

  function readOptions() {
    const st = (rep && rep.settings) || {};
    const kkmRaw = $('lap-kkm').value;
    const kkm = kkmRaw === '' ? Number(st.KKM || 75) : Number(kkmRaw);
    return {
      jenis: jenis(),
      examId: $('lap-exam').value,
      kelas: $('lap-class').value,
      userId: $('lap-student').value,
      mapel: $('lap-subject').value,
      urut: $('lap-sort').value,
      kkm: kkm,
      tanggal: $('lap-date').value || todayLocal(),
      belum: $('lap-absent').checked,
      teksSoal: $('lap-qtext').checked,
      kunci: $('lap-key').checked,
      ttd: $('lap-sign').checked,
      kota: $('lap-city').value.trim(),
      tp: $('lap-year').value.trim(),
      guru: $('lap-teacher').value.trim(),
      nipGuru: $('lap-teacher-nip').value.trim(),
      kepsek: $('lap-head').value.trim(),
      nipKepsek: $('lap-head-nip').value.trim(),
      logo: $('lap-logo').value.trim(),
      sekolah: st.SCHOOL_NAME || '',
      app: st.APP_NAME || 'SIBER-UJIAN'
    };
  }

  function validate(o) {
    if (!(o.kkm >= 0 && o.kkm <= 100)) return 'KKM harus angka 0 sampai 100.';
    if (['rekap', 'detail', 'analisis'].indexOf(o.jenis) !== -1 && !o.examId) return 'Pilih ujian terlebih dahulu.';
    if (o.jenis === 'kelas' && !o.kelas) return 'Pilih kelas terlebih dahulu.';
    if (o.jenis === 'riwayat' && !o.userId) return 'Pilih siswa terlebih dahulu.';
    return null;
  }

  function byStart(a, b) {
    return String(a.start_date || '').localeCompare(String(b.start_date || '')) || a.exam_name.localeCompare(b.exam_name, 'id');
  }

  async function answerSheets(examId, kelas, userId) {
    if (!navigator.onLine) throw new Error('Laporan ini memerlukan internet.');
    const res = await Auth.authedCall('getAnswerSheets', { exam_id: examId, class: kelas || '', user_id: userId || '' }, 120000);
    if (!res.success) throw new Error(errText(res));
    return res.data;
  }

  async function buildData(o) {
    await loadReportData(false);
    const R = rep;
    if (o.jenis === 'detail' || o.jenis === 'analisis') {
      const d = await answerSheets(o.examId, o.kelas, o.jenis === 'detail' ? o.userId : '');
      d.students = R.students;
      return d;
    }
    if (o.jenis === 'rekap') {
      const exam = R.exams.find(function (e) { return e.exam_id === o.examId; });
      if (!exam) throw new Error('Ujian tidak ditemukan. Tekan "Muat ulang data".');
      return {
        exam: exam,
        students: R.students.filter(function (s) { return s.grade === exam.grade && (!o.kelas || up(s.class) === up(o.kelas)); }),
        results: R.results.filter(function (r) { return r.exam_id === exam.exam_id && (!o.kelas || up(r.class) === up(o.kelas)); })
      };
    }
    if (o.jenis === 'kelas' || o.jenis === 'mapel') {
      let students = o.kelas ? R.students.filter(function (s) { return up(s.class) === up(o.kelas); }) : R.students.slice();
      const ids = {};
      students.forEach(function (s) { ids[s.user_id] = true; });
      const results = R.results.filter(function (r) { return ids[r.user_id]; });
      const hasResult = {};
      results.forEach(function (r) { hasResult[r.exam_id] = true; });
      const grades = {};
      students.forEach(function (s) { grades[s.grade] = true; });
      const exams = R.exams.filter(function (e) {
        if (o.mapel && e.subject !== o.mapel) return false;
        if (!grades[e.grade]) return false;
        return !!hasResult[e.exam_id];
      }).sort(byStart);
      if (o.jenis === 'mapel' && !o.kelas) {
        const g = {};
        exams.forEach(function (e) { g[e.grade] = true; });
        students = students.filter(function (s) { return g[s.grade]; });
      }
      return { exams: exams, students: students, results: results };
    }
    const student = R.students.find(function (s) { return s.user_id === o.userId; });
    if (!student) throw new Error('Siswa tidak ditemukan.');
    const conducted = {};
    R.results.forEach(function (r) { conducted[r.exam_id] = true; });
    return {
      student: student,
      exams: R.exams.filter(function (e) { return e.grade === student.grade && conducted[e.exam_id]; }).sort(byStart),
      results: R.results.filter(function (r) { return r.user_id === student.user_id; })
    };
  }

  /** Membuka tab laporan LEBIH DULU (agar tidak diblokir), lalu mengisinya setelah data siap. */
  async function openReport(o) {
    const err = validate(o);
    if (err) { UI.showMsg('lap-message', 'warn', err); return; }
    const reqId = String(Date.now());
    window.SIBER_LAPORAN_DOCS = window.SIBER_LAPORAN_DOCS || {};
    const w = window.open('laporan.html#' + reqId, '_blank');
    if (!w) {
      UI.showMsg('lap-message', 'warn', 'Tab laporan diblokir browser. Izinkan pop-up untuk situs ini (ikon di ujung kanan bilah alamat), lalu coba lagi.');
      return;
    }
    const btn = $('btn-lap-make');
    UI.setBusy(btn, true, 'Menyusun laporan...');
    UI.showMsg('lap-message', 'info', 'Menyusun laporan di tab baru...');
    let doc;
    try {
      const d = await buildData(o);
      doc = Laporan.build(o, d);
      UI.showMsg('lap-message', 'ok', 'Laporan siap di tab baru: ' + doc.title + '.');
    } catch (e) {
      doc = { error: e.message || String(e) };
      UI.showMsg('lap-message', 'error', 'Gagal membuat laporan: ' + doc.error);
    } finally {
      UI.setBusy(btn, false);
    }
    doc.id = reqId;
    const keys = Object.keys(window.SIBER_LAPORAN_DOCS);
    if (keys.length > 4) keys.slice(0, keys.length - 4).forEach(function (k) { delete window.SIBER_LAPORAN_DOCS[k]; });
    window.SIBER_LAPORAN_DOCS[reqId] = doc;
  }

  function onMakeReport(e) {
    e.preventDefault();
    if (!rep) {
      prepareReport(false).then(function () { if (rep) openReport(readOptions()); });
      return;
    }
    openReport(readOptions());
  }

  async function onSaveSettings() {
    if (!navigator.onLine) { UI.showMsg('lap-message', 'warn', 'Perlu internet untuk menyimpan.'); return; }
    const kkm = $('lap-kkm').value;
    const settings = {
      KOTA: $('lap-city').value.trim(),
      TAHUN_PELAJARAN: $('lap-year').value.trim(),
      NAMA_GURU: $('lap-teacher').value.trim(),
      NIP_GURU: $('lap-teacher-nip').value.trim(),
      NAMA_KEPSEK: $('lap-head').value.trim(),
      NIP_KEPSEK: $('lap-head-nip').value.trim(),
      LOGO_URL: $('lap-logo').value.trim()
    };
    if (kkm !== '') settings.KKM = kkm;
    const btn = $('btn-lap-save-settings');
    UI.setBusy(btn, true, 'Menyimpan...');
    const res = await Auth.authedCall('saveReportSettings', { settings: settings });
    UI.setBusy(btn, false);
    if (!res.success) { UI.showMsg('lap-message', 'error', 'Gagal menyimpan: ' + errText(res)); return; }
    if (rep) rep.settings = Object.assign({}, rep.settings, res.data.settings);
    UI.showMsg('lap-message', 'ok', 'Identitas laporan disimpan sebagai bawaan di sheet CONFIG.');
  }

  /** Dipanggil dari tombol "Lembar jawaban PDF" di jendela detail. */
  async function printAnswerSheet(examId, userId) {
    const o = readOptions();
    o.jenis = 'detail';
    o.examId = examId;
    o.userId = userId;
    o.kelas = '';
    if (!(o.kkm >= 0 && o.kkm <= 100)) o.kkm = 75;
    const reqId = String(Date.now());
    window.SIBER_LAPORAN_DOCS = window.SIBER_LAPORAN_DOCS || {};
    const w = window.open('laporan.html#' + reqId, '_blank');
    if (!w) { alert('Tab laporan diblokir browser. Izinkan pop-up untuk situs ini lalu coba lagi.'); return; }
    let doc;
    try {
      await loadReportData(false);
      if (!identityFilled) fillReportForm();
      const o2 = Object.assign(readOptions(), { jenis: 'detail', examId: examId, userId: userId, kelas: '' });
      const d = await buildData(o2);
      doc = Laporan.build(o2, d);
    } catch (e) {
      doc = { error: e.message || String(e) };
    }
    doc.id = reqId;
    window.SIBER_LAPORAN_DOCS[reqId] = doc;
  }

  /* =========================================================
   * TOKEN
   * ========================================================= */

  const TOKEN_STATE = {
    BERLAKU: ['Berlaku sekarang', 'badge-live'],
    HARI_INI_BELUM: ['Hari ini, belum mulai', 'badge-warn'],
    SELESAI_HARI_INI: ['Hari ini, sudah lewat jam', 'badge-muted'],
    AKAN_DATANG: ['Akan datang', 'badge-done'],
    KEDALUWARSA: ['Kedaluwarsa', 'badge-muted'],
    NONAKTIF: ['Nonaktif', 'badge-bad']
  };

  async function loadTokens() {
    if (tokenLoading) return;
    if (!navigator.onLine) { UI.showMsg('token-message', 'warn', 'Tab token memerlukan internet.'); return; }
    tokenLoading = true;
    UI.setBusy($('btn-token-refresh'), true, 'Memuat...');
    const onlyExam = $('token-only-exam').checked;
    const res = await Auth.authedCall('listTokens', { exam_id: onlyExam ? dash().getExamId() : '' });
    UI.setBusy($('btn-token-refresh'), false);
    tokenLoading = false;
    if (!res.success) { UI.showMsg('token-message', 'error', 'Gagal memuat token: ' + errText(res)); return; }
    UI.hideMsg('token-message');
    const d = res.data;

    const sel = $('token-exam');
    fillSelect(sel, d.exams.map(function (e) { return [e.exam_id, e.exam_name + ' (' + e.exam_id + ')' + (e.status !== 'ACTIVE' ? ' · ' + e.status : '')]; }),
      sel.value || dash().getExamId());
    $('btn-token-create').disabled = !d.exams.length;
    if (!d.exams.length) UI.showMsg('token-message', 'info', 'Tidak ada ujian dengan TOKEN_REQUIRED = YES di sheet EXAMS.');
    if (!$('token-date').value) $('token-date').value = d.today || todayLocal();

    const box = $('token-list');
    box.replaceChildren();
    if (!d.tokens.length) {
      box.appendChild(el('p', { className: 'small', text: 'Belum ada token' + (onlyExam ? ' untuk ujian ini.' : '.') }));
      return;
    }
    box.appendChild(table(
      ['Ujian', 'Token', 'Tanggal', 'Jam', 'Status', 'Dibuat', ''],
      d.tokens.map(function (t) {
        const stt = TOKEN_STATE[t.state] || [t.state, ''];
        const act = t.status === 'ACTIVE'
          ? el('button', { className: 'btn btn-light btn-small', type: 'button', text: 'Nonaktifkan', data: { tokenId: t.token_id, active: '0' } })
          : el('button', { className: 'btn btn-light btn-small', type: 'button', text: 'Aktifkan', data: { tokenId: t.token_id, active: '1' } });
        return {
          t: t,
          cells: [
            { text: t.exam_name || t.exam_id, className: 'wrap', title: t.exam_id },
            el('span', { className: 'token-text', text: t.token }),
            t.valid_date,
            t.valid_from + '–' + t.valid_until,
            badge(stt[0], stt[1]),
            UI.formatDateTime(t.created_at),
            act
          ]
        };
      }),
      function (r) { return r.t.state === 'BERLAKU' ? 'row-live' : ''; }
    ));
  }

  async function onTokenListClick(e) {
    const b = e.target.closest('button[data-token-id]');
    if (!b) return;
    const active = b.dataset.active === '1';
    if (!confirm((active ? 'Aktifkan' : 'Nonaktifkan') + ' token ini?\n\nVERSION ujian akan naik: siswa perlu menekan "Perbarui daftar" lalu unduh ulang soal saat online.' +
      (active ? '' : '\nHP yang sudah mengunduh sebelum ini masih menyimpan token lama sampai diperbarui.'))) return;
    b.disabled = true;
    const res = await Auth.authedCall('setTokenStatus', { token_id: b.dataset.tokenId, active: active });
    if (!res.success) { b.disabled = false; UI.showMsg('token-message', 'error', 'Gagal: ' + errText(res)); return; }
    UI.showMsg('token-message', 'ok', 'Token ' + (active ? 'diaktifkan' : 'dinonaktifkan') + '. Versi ujian sekarang ' + res.data.new_version + '.');
    loadTokens();
    if (window.SiberDash) window.SiberDash.reload(true);
  }

  async function onCreateToken(e) {
    e.preventDefault();
    const examId = $('token-exam').value;
    const date = $('token-date').value;
    const allDay = $('token-allday').checked;
    const from = allDay ? '00:00' : $('token-from').value;
    const until = allDay ? '23:59' : $('token-until').value;
    if (!examId) { UI.showMsg('token-message', 'warn', 'Pilih ujian.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { UI.showMsg('token-message', 'warn', 'Isi tanggal ujian.'); return; }
    if (date < todayLocal()) { UI.showMsg('token-message', 'warn', 'Tanggal sudah lewat.'); return; }
    if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(until) || from >= until) {
      UI.showMsg('token-message', 'warn', 'Jam mulai harus lebih awal dari jam selesai.');
      return;
    }
    if (!navigator.onLine) { UI.showMsg('token-message', 'warn', 'Perlu internet.'); return; }
    const btn = $('btn-token-create');
    UI.setBusy(btn, true, 'Membuat token (10–60 detik)...');
    $('token-created').hidden = true;
    const res = await Auth.authedCall('createToken', { exam_id: examId, valid_date: date, valid_from: from, valid_until: until }, 180000);
    UI.setBusy(btn, false);
    if (!res.success) { UI.showMsg('token-message', 'error', 'Gagal membuat token: ' + errText(res)); return; }
    const t = res.data;
    const box = $('token-created');
    box.replaceChildren(
      el('div', { className: 'small', text: 'TOKEN BERHASIL DIBUAT — rahasiakan sampai ujian dimulai' }),
      el('div', { className: 'token-big', text: t.token }),
      el('div', { text: 'Berlaku ' + t.valid_date + ' pukul ' + t.valid_from + '–' + t.valid_until + ' · VERSION ujian sekarang ' + t.new_version }),
      el('div', { className: 'small', text: 'Semua siswa harus menekan "Perbarui daftar" lalu "Unduh soal" SETELAH token ini dibuat (saat ada internet).' })
    );
    box.hidden = false;
    UI.hideMsg('token-message');
    loadTokens();
    if (window.SiberDash) window.SiberDash.reload(true);
  }

  /* =========================================================
   * MULAI
   * ========================================================= */

  function init() {
    document.querySelectorAll('#dash-tabs .tab').forEach(function (b) {
      b.addEventListener('click', function () { setTab(b.dataset.tab); });
    });
    $('sel-exam').addEventListener('change', function () { setTimeout(onSelectionChange, 0); });
    $('sel-class').addEventListener('change', function () { setTimeout(onSelectionChange, 0); });

    $('btn-siswa-refresh').addEventListener('click', loadSiswa);
    $('siswa-filter').addEventListener('change', renderSiswa);

    $('lap-form').addEventListener('submit', onMakeReport);
    $('btn-lap-refresh').addEventListener('click', function () { prepareReport(true); });
    $('btn-lap-save-settings').addEventListener('click', onSaveSettings);
    document.querySelectorAll('input[name="lap-jenis"]').forEach(function (r) { r.addEventListener('change', applyJenis); });
    $('lap-exam').addEventListener('change', refreshClassOptions);
    $('lap-class').addEventListener('change', refreshStudentOptions);
    applyJenis();

    $('btn-token-refresh').addEventListener('click', loadTokens);
    $('token-only-exam').addEventListener('change', loadTokens);
    $('token-list').addEventListener('click', onTokenListClick);
    $('token-form').addEventListener('submit', onCreateToken);
    $('token-allday').addEventListener('change', function () {
      $('token-from').disabled = $('token-allday').checked;
      $('token-until').disabled = $('token-allday').checked;
    });

    let saved = 'pantau';
    try { saved = localStorage.getItem(TAB_KEY) || 'pantau'; } catch (e) { /* abaikan */ }
    setTab(saved, true);
    document.addEventListener('siber:dashboard-open', function () { setTab(activeTab); });

    window.GuruExtra = { printAnswerSheet: printAnswerSheet, setTab: setTab };
  }

  document.addEventListener('DOMContentLoaded', init);
})();
