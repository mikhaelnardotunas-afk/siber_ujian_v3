/**
 * SIBER-UJIAN — dashboard.js
 * Dashboard guru: ringkasan, rekap kelas, peserta (termasuk pelanggaran), detail jawaban,
 * analisis soal, PANTAUAN LANGSUNG siswa yang online, dan KIRIM PESAN ke layar siswa.
 * Hanya untuk role TEACHER/ADMIN (server juga menolak role lain).
 */
(function () {
  'use strict';

  const $ = UI.$;
  const el = UI.el;
  const AUTO_MS = 60000;
  const ONLINE_WINDOW_MS = 2 * 60 * 1000;

  let lastData = null;
  let autoHandle = null;
  let loading = false;

  /* ---------- Bantuan ---------- */

  function updateNetStatus() {
    const online = navigator.onLine;
    const s = $('net-status');
    s.textContent = online ? 'Online' : 'Offline';
    s.className = 'net-status ' + (online ? 'is-online' : 'is-offline');
  }

  function isTeacher(state) {
    return !!state && (state.user.role === 'TEACHER' || state.user.role === 'ADMIN');
  }

  function show(v) { return (v === null || v === undefined || v === '') ? '-' : String(v); }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.substring(0, n - 1) + '…' : s;
  }

  function durationText(a, b) {
    const x = Date.parse(a);
    const y = Date.parse(b);
    if (isNaN(x) || isNaN(y)) return '-';
    return Math.max(0, Math.round((y - x) / 60000)) + ' mnt';
  }

  function agoText(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return '-';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + ' dtk lalu';
    if (s < 3600) return Math.round(s / 60) + ' mnt lalu';
    return Math.round(s / 3600) + ' jam lalu';
  }

  const REASON_TEXT = {
    MANUAL: 'Selesai sendiri',
    TIME_UP: 'Waktu habis',
    ALL_DONE: 'Semua soal selesai',
    DATA_ERROR: 'Data perangkat rusak'
  };

  const VIOLATION_TEXT = {
    LEAVE_SCREEN: 'keluar layar',
    APP_REOPENED: 'aplikasi ditutup/dimuat ulang',
    EXIT_FULLSCREEN: 'keluar layar penuh'
  };

  function violationDetailText(detail) {
    return String(detail || '').replace(/[A-Z_]+/g, function (k) { return VIOLATION_TEXT[k] || k; });
  }

  function badge(text, cls) { return el('span', { className: 'badge ' + (cls || ''), text: text }); }

  function td(cell) {
    if (cell instanceof Node) return el('td', null, [cell]);
    if (cell && typeof cell === 'object') {
      const c = el('td', { className: cell.className || '' });
      if (cell.math) MathRenderer.renderInto(c, cell.text); else c.textContent = show(cell.text);
      if (cell.title) c.title = cell.title;
      return c;
    }
    return el('td', { text: show(cell) });
  }

  function table(headers, rows, rowClassFn) {
    const thead = el('thead', null, [el('tr', null, headers.map(function (h) { return el('th', { text: h }); }))]);
    const tbody = el('tbody', null, rows.map(function (r, i) {
      const tr = el('tr', null, r.cells.map(td));
      if (rowClassFn) tr.className = rowClassFn(r, i) || '';
      return tr;
    }));
    return el('table', { className: 'data-table' }, [thead, tbody]);
  }

  function percentCell(pct) {
    const wrap = el('div', null, [el('div', { text: show(pct) + '%' })]);
    const bar = el('div', { className: 'bar' }, [el('span')]);
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    bar.firstChild.style.width = v + '%';
    bar.firstChild.className = v >= 70 ? 'bar-good' : (v >= 30 ? 'bar-mid' : 'bar-low');
    wrap.appendChild(bar);
    return wrap;
  }

  function violationCell(n, detail) {
    const v = Number(n) || 0;
    const b = el('span', { className: 'vio ' + (v ? 'vio-yes' : 'vio-no'), text: v ? String(v) : '0' });
    if (detail) b.title = violationDetailText(detail);
    return b;
  }

  /* ---------- Login ---------- */

  async function onLogin(event) {
    event.preventDefault();
    UI.hideMsg('login-message');
    const btn = $('btn-login');
    const pw = $('login-password');
    UI.setBusy(btn, true, 'Memeriksa...');
    let res;
    try {
      res = await Auth.login($('login-username').value, pw.value);
    } catch (e) {
      res = { success: false, error: { code: 'CLIENT_ERROR', message: e.message } };
    }
    UI.setBusy(btn, false);
    pw.value = '';

    if (!res.success) {
      UI.showMsg('login-message', 'error', UI.errorText(res));
      return;
    }
    const s = Auth.getState();
    if (!isTeacher(s)) {
      await Auth.logout();
      UI.showMsg('login-message', 'error', 'Halaman ini khusus guru/admin. Siswa silakan memakai aplikasi ujian.');
      return;
    }
    await openDashboard();
  }

  function onTogglePassword() {
    const input = $('login-password');
    const btn = $('btn-toggle-password');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    btn.textContent = hidden ? 'Sembunyi' : 'Lihat';
  }

  async function onLogout() {
    stopAuto();
    $('chk-auto').checked = false;
    await Auth.logout();
    $('login-username').value = '';
    UI.showScreen('login');
  }

  /* ---------- Daftar ujian ---------- */

  async function loadExamList() {
    let exams = null;
    if (navigator.onLine) {
      const res = await Auth.authedCall('getDashboard', {});
      if (res.success) {
        exams = res.data.exams || [];
        await DB.setSetting('dash_exams', exams);
      } else {
        UI.showMsg('dash-message', 'error', 'Gagal memuat daftar ujian: ' + UI.errorText(res));
      }
    }
    if (!exams) exams = (await DB.getSetting('dash_exams')) || [];

    const sel = $('sel-exam');
    const keep = sel.value || (await DB.getSetting('dash_last_exam')) || '';
    sel.replaceChildren();
    if (!exams.length) {
      const o = el('option', { text: navigator.onLine ? '(belum ada ujian / gagal memuat — tekan Perbarui)' : '(offline)' });
      o.value = '';
      sel.appendChild(o);
      return false;
    }
    exams.forEach(function (e) {
      const o = el('option', { text: e.exam_name + ' (' + e.exam_id + ') · ' + e.mode + ' · ' + e.synced_count + ' hasil' });
      o.value = e.exam_id;
      sel.appendChild(o);
    });
    if (keep && exams.some(function (e) { return e.exam_id === keep; })) sel.value = keep;
    return true;
  }

  /* ---------- Dashboard ---------- */

  function cacheKey(examId, cls) { return 'dash_cache:' + examId + ':' + (cls || 'ALL'); }

  async function loadDashboard(quiet) {
    const examId = $('sel-exam').value;
    if (loading) return;
    if (!examId) {
      // daftar ujian belum termuat: coba muat ulang daftarnya dulu
      if (!quiet && await loadExamList() && $('sel-exam').value) return loadDashboard(quiet);
      return;
    }
    const cls = $('sel-class').value;
    loading = true;
    const btn = $('btn-refresh');
    if (!quiet) UI.setBusy(btn, true, 'Memuat...');
    await DB.setSetting('dash_last_exam', examId);

    try {
      if (navigator.onLine) {
        const res = await Auth.authedCall('getDashboard', { exam_id: examId, class: cls });
        if (res.success) {
          const fetchedAt = new Date().toISOString();
          await DB.setSetting(cacheKey(examId, cls), { data: res.data, fetched_at: fetchedAt });
          render(res.data, fetchedAt, false);
          if (!quiet) UI.hideMsg('dash-message');
          loadLive();
          loadMessages();
          return;
        }
        UI.showMsg('dash-message', 'error', 'Gagal memuat dashboard: ' + UI.errorText(res) +
          (res.error && (res.error.code === 'SESSION_EXPIRED' || res.error.code === 'UNAUTHORIZED')
            ? ' Tekan Keluar lalu login lagi.' : ''));
      }
      const cached = await DB.getSetting(cacheKey(examId, cls));
      if (cached) {
        render(cached.data, cached.fetched_at, true);
        if (!navigator.onLine) {
          UI.showMsg('dash-message', 'warn', 'Perangkat offline. Menampilkan data terakhir yang tersimpan.');
        }
      } else if (!navigator.onLine) {
        UI.showMsg('dash-message', 'warn', 'Perangkat offline dan belum ada data tersimpan untuk pilihan ini.');
      }
    } catch (e) {
      UI.showMsg('dash-message', 'error', 'Terjadi kesalahan: ' + e.message);
    } finally {
      loading = false;
      if (!quiet) UI.setBusy(btn, false);
    }
  }

  function render(data, fetchedAt, fromCache) {
    lastData = data;
    window.SIBER_DASH = { data: data, fetched_at: fetchedAt, from_cache: fromCache, teacher: Auth.getState() ? Auth.getState().user.name : '' };
    const e = data.exam;
    $('dash-exam-title').textContent = e.exam_name;
    $('dash-exam-info').textContent =
      e.subject + ' kelas ' + e.grade + ' · Mode ' + e.mode +
      ' · Versi ' + e.version + (e.token_required ? ' · Bertoken' : '') +
      ' · Periode ' + e.start_date + ' s/d ' + e.end_date;
    $('dash-fetched').textContent = 'Data diambil ' + UI.formatDateTime(fetchedAt) + (fromCache ? ' (tersimpan)' : '');
    UI.showMsg('dash-note', 'info', data.note || '');

    const selC = $('sel-class');
    const keep = selC.value;
    selC.replaceChildren(el('option', { text: 'Semua kelas' }));
    selC.firstChild.value = '';
    (data.classes || []).forEach(function (c) {
      const o = el('option', { text: c });
      o.value = c;
      selC.appendChild(o);
    });
    selC.value = (data.classes || []).indexOf(keep) !== -1 ? keep : '';

    renderSummary(data.summary);
    renderByClass(data.by_class || []);
    renderParticipants();
    renderItems(data.item_analysis || []);
    renderMessageTargets();
  }

  function renderSummary(s) {
    const items = [
      ['Peserta', s.total_participants, 'tone-indigo'],
      ['Sudah terkirim', s.synced, 'tone-emerald'],
      ['Belum terkirim', s.not_synced, s.not_synced ? 'tone-amber' : 'tone-slate'],
      ['Rata-rata', s.average, 'tone-sky'],
      ['Median', s.median, 'tone-sky'],
      ['Tertinggi', s.highest, 'tone-emerald'],
      ['Terendah', s.lowest, 'tone-rose'],
      ['Ada pelanggaran', s.with_violations, s.with_violations ? 'tone-rose' : 'tone-slate'],
      ['Ada catatan jam/data', s.with_warnings, s.with_warnings ? 'tone-amber' : 'tone-slate']
    ];
    const grid = $('summary-grid');
    grid.replaceChildren();
    items.forEach(function (it) {
      grid.appendChild(el('div', { className: 'stat ' + it[2] }, [
        el('div', { className: 'stat-label', text: it[0] }),
        el('div', { className: 'stat-value', text: show(it[1]) })
      ]));
    });
  }

  function renderByClass(rows) {
    const box = $('by-class');
    box.replaceChildren();
    if (!rows.length) { box.appendChild(el('p', { className: 'small', text: 'Belum ada data kelas.' })); return; }
    box.appendChild(table(
      ['Kelas', 'Peserta', 'Terkirim', 'Belum', 'Rata-rata', 'Tertinggi', 'Terendah'],
      rows.map(function (r) {
        return { cells: [r.class, { text: r.total, className: 'num' }, { text: r.synced, className: 'num' },
          { text: r.not_synced, className: 'num' }, { text: r.average, className: 'num' },
          { text: r.highest, className: 'num' }, { text: r.lowest, className: 'num' }] };
      })
    ));
  }

  function sortParticipants(list) {
    const mode = $('sel-sort').value;
    const arr = list.slice();
    const score = function (p) { return p.score === null ? -1 : p.score; };
    const hasWarn = function (p) { return !!(p.warnings || p.clock_flags || p.note) || (p.violations || 0) > 0; };
    arr.sort(function (a, b) {
      if (mode === 'score_desc') return score(b) - score(a);
      if (mode === 'score_asc') {
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return a.score - b.score;
      }
      if (mode === 'status' && a.status !== b.status) return a.status === 'BELUM_SYNC' ? -1 : 1;
      if (mode === 'violations') return (b.violations || 0) - (a.violations || 0);
      if (mode === 'warn' && hasWarn(a) !== hasWarn(b)) return hasWarn(a) ? -1 : 1;
      return (a.class + '|' + a.name).localeCompare(b.class + '|' + b.name);
    });
    return arr;
  }

  function renderParticipants() {
    const box = $('participants');
    box.replaceChildren();
    if (!lastData) return;
    const list = sortParticipants(lastData.participants || []);
    if (!list.length) { box.appendChild(el('p', { className: 'small', text: 'Belum ada peserta.' })); return; }

    const rows = list.map(function (p, i) {
      const notes = [p.clock_flags, p.warnings, p.note].filter(Boolean).join(' | ');
      const detailBtn = p.attempt_id
        ? el('button', { className: 'btn btn-light btn-small', type: 'button', text: 'Detail', data: { attempt: p.attempt_id } })
        : el('span', { className: 'muted', text: '-' });
      return {
        p: p,
        cells: [
          { text: i + 1, className: 'num' },
          p.name,
          p.class,
          p.status === 'SYNCED' ? badge('Terkirim', 'badge-done') : badge('Belum terkirim', 'badge-warn'),
          { text: p.score, className: 'num strong' },
          { text: p.correct, className: 'num' },
          { text: p.wrong, className: 'num' },
          violationCell(p.violations, p.violation_detail),
          UI.formatDateTime(p.started_at),
          UI.formatDateTime(p.completed_at),
          { text: p.status === 'SYNCED' ? durationText(p.started_at, p.completed_at) : '-', className: 'num' },
          REASON_TEXT[p.finish_reason] || show(p.finish_reason),
          notes ? { text: '⚠ ' + truncate(notes, 60), title: notes, className: 'wrap' } : '-',
          detailBtn
        ]
      };
    });

    box.appendChild(table(
      ['No', 'Nama', 'Kelas', 'Status', 'Nilai', 'Benar', 'Salah', 'Pelanggaran', 'Mulai', 'Selesai', 'Durasi', 'Cara selesai', 'Catatan', ''],
      rows,
      function (r) {
        if (r.p.status !== 'SYNCED') return 'row-missing';
        if ((r.p.violations || 0) > 0) return 'row-alert';
        if (r.p.warnings || r.p.clock_flags || r.p.note) return 'row-warn';
        return '';
      }
    ));
  }

  function renderItems(items) {
    const box = $('items');
    box.replaceChildren();
    if (!items.length) { box.appendChild(el('p', { className: 'small', text: 'Belum ada data soal.' })); return; }
    box.appendChild(table(
      ['No', 'Soal', 'Dijawab', 'Benar', 'Salah', 'Kosong', '% Benar', 'Kategori', 'Sebaran pilihan'],
      items.map(function (q) {
        const d = q.distribution || {};
        const diffCls = { MUDAH: 'badge-done', SEDANG: 'badge-warn', SUKAR: 'badge-bad' }[q.difficulty] || '';
        return {
          cells: [
            { text: q.number, className: 'num' },
            { text: q.question, title: q.question, className: 'wrap', math: true },
            { text: q.total_answer, className: 'num' },
            { text: q.correct, className: 'num' },
            { text: q.wrong, className: 'num' },
            { text: q.blank, className: 'num' },
            percentCell(q.percent_correct),
            badge(q.difficulty, diffCls),
            'A:' + show(d.A) + '  B:' + show(d.B) + '  C:' + show(d.C) + '  D:' + show(d.D)
          ]
        };
      })
    ));
  }

  /* ---------- Pantauan langsung ---------- */

  async function loadLive() {
    const box = $('live');
    const examId = $('sel-exam').value;
    if (!examId) return;
    if (!navigator.onLine) {
      UI.showMsg('live-message', 'warn', 'Pantauan langsung memerlukan internet.');
      return;
    }
    const res = await Auth.authedCall('getLiveStatus', { exam_id: examId, class: $('sel-class').value });
    if (!res.success) {
      UI.showMsg('live-message', 'error', 'Gagal memuat pantauan: ' + UI.errorText(res));
      return;
    }
    UI.hideMsg('live-message');
    const rows = res.data.rows || [];
    const now = Date.now();
    let inExam = 0;
    let atHome = 0;
    let away = 0;

    const tableRows = rows.map(function (r) {
      const seenMs = Date.parse(r.at);
      const online = !isNaN(seenMs) && (now - seenMs) <= ONLINE_WINDOW_MS;
      const sameExam = r.exam_id === examId;
      let status;
      if (online && r.state === 'EXAM' && sameExam) { status = badge('Sedang mengerjakan', 'badge-live'); inExam++; }
      else if (online && r.state === 'EXAM') { status = badge('Mengerjakan ujian lain', 'badge-warn'); inExam++; }
      else if (online) { status = badge('Online di beranda', 'badge-done'); atHome++; }
      else { status = badge(r.at ? 'Tidak terhubung' : 'Belum pernah online', 'badge-muted'); away++; }

      const exam = (r.state === 'EXAM' && sameExam);
      const msgBtn = el('button', { className: 'btn btn-light btn-small', type: 'button', text: 'Pesan', data: { msgUser: r.user_id } });
      return {
        r: r,
        cells: [
          r.name,
          r.class,
          status,
          { text: exam ? (r.current + ' / ' + r.total) : '-', className: 'num' },
          { text: exam ? r.answered : '-', className: 'num' },
          { text: exam ? UI.formatDuration(r.remaining_ms || 0) : '-', className: 'num' },
          violationCell(exam ? r.violations : 0),
          r.at ? agoText(r.at) : '-',
          msgBtn
        ]
      };
    });

    $('live-summary').textContent = inExam + ' sedang mengerjakan · ' + atHome + ' online di beranda · ' +
      away + ' tidak terhubung. Diperbarui ' + UI.formatClock(new Date().toISOString()) + '.';
    box.replaceChildren();
    if (!tableRows.length) {
      box.appendChild(el('p', { className: 'small', text: 'Belum ada siswa untuk ditampilkan.' }));
      return;
    }
    box.appendChild(table(
      ['Nama', 'Kelas', 'Status', 'Soal ke', 'Terjawab', 'Sisa waktu', 'Pelanggaran', 'Terakhir terlihat', ''],
      tableRows,
      function (x) { return (x.r.state === 'EXAM' && (x.r.violations || 0) > 0) ? 'row-alert' : ''; }
    ));
  }

  /* ---------- Pesan ke siswa ---------- */

  function renderMessageTargets() {
    const sel = $('msg-target');
    const keep = sel.value;
    sel.replaceChildren();
    const add = function (value, text) {
      const o = el('option', { text: text });
      o.value = value;
      sel.appendChild(o);
    };
    add('ALL', 'Semua peserta ujian ini');
    (lastData && lastData.classes || []).forEach(function (c) { add('CLASS:' + c, 'Semua siswa kelas ' + c); });
    (lastData && lastData.participants || []).slice().sort(function (a, b) {
      return (a.class + a.name).localeCompare(b.class + b.name);
    }).forEach(function (p) { add('USER:' + p.user_id, p.name + ' (' + p.class + ')'); });
    if (Array.prototype.some.call(sel.options, function (o) { return o.value === keep; })) sel.value = keep;
  }

  function updateMsgCounter() {
    $('msg-counter').textContent = $('msg-input').value.length + ' / 300';
  }

  async function onSendMessage() {
    UI.hideMsg('msgsend-message');
    const text = $('msg-input').value.trim();
    if (!text) { UI.showMsg('msgsend-message', 'warn', 'Tulis pesan terlebih dahulu.'); return; }
    if (!navigator.onLine) { UI.showMsg('msgsend-message', 'warn', 'Mengirim pesan memerlukan internet.'); return; }
    const target = $('msg-target').value;
    let targetType = 'ALL';
    let targetValue = '';
    if (target.indexOf('CLASS:') === 0) { targetType = 'CLASS'; targetValue = target.substring(6); }
    else if (target.indexOf('USER:') === 0) { targetType = 'USER'; targetValue = target.substring(5); }

    const btn = $('btn-send-message');
    UI.setBusy(btn, true, 'Mengirim...');
    const res = await Auth.authedCall('sendMessage', {
      exam_id: $('sel-exam').value,
      target_type: targetType,
      target_value: targetValue,
      text: text
    });
    UI.setBusy(btn, false);
    if (!res.success) {
      UI.showMsg('msgsend-message', 'error', 'Gagal mengirim: ' + UI.errorText(res));
      return;
    }
    $('msg-input').value = '';
    updateMsgCounter();
    UI.showMsg('msgsend-message', 'ok', 'Pesan terkirim ke: ' + res.data.target_label +
      '. Siswa yang sedang online akan melihatnya dalam ±1 menit.');
    loadMessages();
  }

  async function loadMessages() {
    const box = $('msg-list');
    if (!navigator.onLine) return;
    const res = await Auth.authedCall('listMessages', { exam_id: $('sel-exam').value });
    box.replaceChildren();
    if (!res.success) {
      box.appendChild(el('p', { className: 'small', text: 'Gagal memuat riwayat pesan: ' + UI.errorText(res) }));
      return;
    }
    const list = res.data.messages || [];
    if (!list.length) {
      box.appendChild(el('p', { className: 'small', text: 'Belum ada pesan untuk ujian ini.' }));
      return;
    }
    list.forEach(function (m) {
      const active = m.status === 'ACTIVE';
      const head = el('div', { className: 'msg-item-head' }, [
        el('strong', { text: m.target_label }),
        el('span', { className: 'small', text: UI.formatDateTime(m.created_at) + ' · oleh ' + m.from_name }),
        active ? badge('Aktif 24 jam', 'badge-done') : badge('Ditarik', 'badge-muted')
      ]);
      const children = [head, el('div', { className: 'msg-item-text', text: m.text })];
      if (active) {
        children.push(el('button', { className: 'btn btn-light btn-small', type: 'button', text: 'Tarik pesan',
          data: { withdraw: m.message_id } }));
      }
      box.appendChild(el('div', { className: 'msg-item' + (active ? '' : ' withdrawn') }, children));
    });
  }

  async function onMessageListClick(e) {
    const b = e.target.closest('button[data-withdraw]');
    if (!b) return;
    if (!confirm('Tarik pesan ini? Siswa yang belum menerimanya tidak akan melihatnya.')) return;
    b.disabled = true;
    const res = await Auth.authedCall('withdrawMessage', { message_id: b.dataset.withdraw });
    if (!res.success) {
      b.disabled = false;
      alert('Gagal menarik pesan: ' + UI.errorText(res));
      return;
    }
    loadMessages();
  }

  function onLiveClick(e) {
    const b = e.target.closest('button[data-msg-user]');
    if (!b) return;
    const value = 'USER:' + b.dataset.msgUser;
    const sel = $('msg-target');
    if (Array.prototype.some.call(sel.options, function (o) { return o.value === value; })) sel.value = value;
    $('msg-input').focus();
    $('msg-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- Detail jawaban ---------- */

  let detailAttempt = null;
  let detailData = null;
  let detailBusy = false;

  async function openDetail(attemptId, keepView) {
    detailAttempt = attemptId;
    $('detail-modal').hidden = false;
    if (!keepView) {
      detailData = null;
      $('detail-title').textContent = 'Detail jawaban';
      $('detail-info').replaceChildren();
      $('detail-answers').replaceChildren();
      $('btn-detail-delete').hidden = true;
      $('btn-detail-print').hidden = true;
    }
    if (!navigator.onLine) {
      UI.showMsg('detail-message', 'warn', 'Detail jawaban memerlukan internet.');
      return;
    }
    if (!keepView) UI.showMsg('detail-message', 'info', 'Memuat...');
    const res2 = await Auth.authedCall('getAttemptDetailV2', { attempt_id: attemptId });
    if (detailAttempt !== attemptId) return;
    if (res2.success) {
      if (!keepView) UI.hideMsg('detail-message');
      renderDetailV2(res2.data);
      return;
    }
    if (!(res2.error && res2.error.code === 'UNKNOWN_ACTION')) {
      UI.showMsg('detail-message', 'error', UI.errorText(res2));
      return;
    }
    // Server lama (Fitur.gs belum dipasang): tampilan detail lama tanpa koreksi
    await openDetailLegacy(attemptId);
  }

  function optText(a, letter) {
    return (a.options && letter && a.options[letter]) ? a.options[letter] : '';
  }

  function renderDetailV2(d) {
    detailData = d;
    const r = d.result;
    $('detail-title').textContent = r.name + ' (' + r.class + ')' + (d.exam ? ' · ' + d.exam.exam_name : '');
    UI.setRows('detail-info', [
      ['Nilai', r.score + ' (benar ' + r.correct + ', salah ' + r.wrong + ' dari ' + r.total_questions + ')' +
        (r.teacher_edit ? ' · dikoreksi guru' : '')],
      ['Mulai / selesai', UI.formatDateTime(r.started_at) + ' / ' + UI.formatDateTime(r.completed_at)],
      ['Durasi', durationText(r.started_at, r.completed_at)],
      ['Mode / cara selesai', show(r.mode) + ' / ' + (REASON_TEXT[r.finish_reason] || show(r.finish_reason))],
      ['Pelanggaran', (r.violations || 0) + (r.violation_detail ? ' (' + violationDetailText(r.violation_detail) + ')' : '')],
      ['Terkirim', UI.formatDateTime(r.synced_at)],
      ['Token', show(r.token_id)],
      ['Versi paket / aplikasi', show(r.package_version) + ' / ' + show(r.client_version)],
      ['Catatan jam', show(r.clock_flags)],
      ['Peringatan', show(r.warnings)],
      ['Kode attempt', r.attempt_id]
    ]);
    $('btn-detail-delete').hidden = false;
    $('btn-detail-print').hidden = !(window.GuruExtra && window.GuruExtra.printAnswerSheet);
    const box = $('detail-answers');
    box.replaceChildren();
    box.appendChild(table(
      ['No', 'Soal', 'Jawaban siswa', 'Kunci', 'Hasil', 'Skor', 'Koreksi guru'],
      d.answers.map(function (a) {
        let hasil;
        if (!a.has_row) hasil = el('span', { className: 'muted', text: 'Tidak ada data' });
        else if (a.is_correct) hasil = el('span', { className: 'ok-text', text: '✔ Benar' });
        else if (!a.answer) hasil = el('span', { className: 'bad-text', text: '✘ Kosong' });
        else hasil = el('span', { className: 'bad-text', text: '✘ Salah' });
        const fix = el('div', { className: 'fix-group' }, [
          el('button', { className: 'fix-btn fix-ok' + (a.teacher_edit && a.is_correct ? ' on' : ''), type: 'button', text: '✔',
            data: { fix: 'TRUE', qid: a.question_id }, disabled: !a.has_row }),
          el('button', { className: 'fix-btn fix-no' + (a.teacher_edit && !a.is_correct ? ' on' : ''), type: 'button', text: '✘',
            data: { fix: 'FALSE', qid: a.question_id }, disabled: !a.has_row }),
          el('button', { className: 'fix-btn fix-auto', type: 'button', text: '↺',
            data: { fix: 'AUTO', qid: a.question_id }, disabled: !a.has_row || !a.teacher_edit })
        ]);
        fix.querySelectorAll('button').forEach(function (b) {
          b.title = b.dataset.fix === 'TRUE' ? 'Anggap benar' : (b.dataset.fix === 'FALSE' ? 'Anggap salah' : 'Kembali dinilai otomatis');
        });
        if (a.teacher_edit) fix.appendChild(el('span', { className: 'badge badge-warn', text: 'dikoreksi' }));
        return {
          a: a,
          cells: [
            { text: a.number, className: 'num' },
            { text: a.question, title: a.question, className: 'wrap', math: true },
            a.answer ? { text: a.answer + '. ' + optText(a, a.answer), className: 'wrap', math: true }
              : el('span', { className: 'muted', text: 'Tidak dijawab' }),
            { text: a.answer_key + (optText(a, a.answer_key) ? '. ' + optText(a, a.answer_key) : ''), className: 'wrap', math: true },
            hasil,
            { text: a.score + ' / ' + a.weight, className: 'num' },
            fix
          ]
        };
      }),
      function (x) { return x.a.teacher_edit ? 'row-warn' : ''; }
    ));
  }

  async function onDetailFix(e) {
    const b = e.target.closest('button[data-fix]');
    if (!b || b.disabled || detailBusy || !detailData) return;
    detailBusy = true;
    const v = b.dataset.fix;
    const btns = $('detail-answers').querySelectorAll('button[data-fix]');
    btns.forEach(function (x) { x.disabled = true; });
    UI.showMsg('detail-message', 'info', 'Menyimpan koreksi...');
    const res = await Auth.authedCall('setAnswerScore', {
      attempt_id: detailData.result.attempt_id,
      question_id: b.dataset.qid,
      correct: v === 'TRUE' ? true : (v === 'FALSE' ? false : null)
    });
    detailBusy = false;
    if (!res.success) {
      UI.showMsg('detail-message', 'error', 'Gagal menyimpan koreksi: ' + UI.errorText(res));
      renderDetailV2(detailData);
      return;
    }
    UI.showMsg('detail-message', 'ok', 'Koreksi tersimpan. Nilai sekarang ' + res.data.score +
      ' (benar ' + res.data.correct + ' dari ' + res.data.total + ').');
    await openDetail(detailData.result.attempt_id, true);
    loadDashboard(true);
  }

  async function onDetailDelete() {
    if (!detailData || detailBusy) return;
    const r = detailData.result;
    const reason = prompt('HAPUS KIRIMAN ' + r.name + ' (' + r.class + '), nilai ' + r.score + '?\n\n' +
      'Nilai dan jawaban dihapus dari server (salinannya dicatat di sheet RESET_LOG), lalu siswa bisa mengerjakan ulang.\n' +
      'Siswa harus membuka aplikasi saat online dan menekan "Perbarui daftar".\n\n' +
      'Tulis alasan (boleh dikosongkan), lalu tekan OK:', '');
    if (reason === null) return;
    detailBusy = true;
    UI.setBusy($('btn-detail-delete'), true, 'Menghapus...');
    const res = await Auth.authedCall('deleteAttempt', { attempt_id: r.attempt_id, reason: reason });
    UI.setBusy($('btn-detail-delete'), false);
    detailBusy = false;
    if (!res.success) {
      UI.showMsg('detail-message', 'error', 'Gagal menghapus: ' + UI.errorText(res));
      return;
    }
    closeDetail();
    UI.showMsg('dash-message', 'ok', 'Kiriman ' + r.name + ' dihapus. Minta siswa membuka aplikasi saat online lalu menekan "Perbarui daftar"; ujian bisa dikerjakan ulang (perlu token lagi jika bertoken).');
    loadDashboard(true);
  }

  function onDetailPrint() {
    if (!detailData || !window.GuruExtra) return;
    window.GuruExtra.printAnswerSheet(detailData.result.exam_id, detailData.result.user_id);
  }

  async function onRegrade() {
    const examId = $('sel-exam').value;
    if (!examId) return;
    if (!navigator.onLine) { UI.showMsg('regrade-message', 'warn', 'Perlu internet.'); return; }
    if (!confirm('Nilai ulang semua hasil ujian ini memakai ANSWER_KEY dan WEIGHT terbaru di sheet QUESTIONS?\n\n' +
      'Pakai ini jika kunci jawaban ternyata salah lalu sudah dibetulkan di sheet.\n' +
      'Jawaban yang sudah dikoreksi manual oleh guru tidak diubah.')) return;
    const btn = $('btn-regrade');
    UI.setBusy(btn, true, 'Menilai ulang...');
    UI.showMsg('regrade-message', 'info', 'Sedang menilai ulang. Tunggu sebentar...');
    const res = await Auth.authedCall('regradeExam', { exam_id: examId }, 120000);
    UI.setBusy(btn, false);
    if (!res.success) {
      UI.showMsg('regrade-message', 'error', 'Gagal: ' + UI.errorText(res));
      return;
    }
    UI.showMsg('regrade-message', 'ok', 'Selesai. ' + res.data.changed_answers + ' jawaban berubah, ' +
      res.data.results_updated + ' nilai siswa berubah (dari ' + res.data.attempts + ' kiriman).');
    loadDashboard(true);
  }

  async function openDetailLegacy(attemptId) {
    const res = await Auth.authedCall('getAttemptDetail', { attempt_id: attemptId });
    if (!res.success) {
      UI.showMsg('detail-message', 'error', UI.errorText(res));
      return;
    }
    UI.hideMsg('detail-message');
    const r = res.data.result;
    $('detail-title').textContent = r.name + ' (' + r.class + ')';
    UI.setRows('detail-info', [
      ['Nilai', r.score + ' (benar ' + r.correct + ', salah ' + r.wrong + ' dari ' + r.total_questions + ')'],
      ['Mulai / selesai', UI.formatDateTime(r.started_at) + ' / ' + UI.formatDateTime(r.completed_at)],
      ['Durasi', durationText(r.started_at, r.completed_at)],
      ['Mode / cara selesai', show(r.mode) + ' / ' + (REASON_TEXT[r.finish_reason] || show(r.finish_reason))],
      ['Pelanggaran', (r.violations || 0) + (r.violation_detail ? ' (' + violationDetailText(r.violation_detail) + ')' : '')],
      ['Terkirim', UI.formatDateTime(r.synced_at)],
      ['Token', show(r.token_id)],
      ['Versi paket / aplikasi', show(r.package_version) + ' / ' + show(r.client_version)],
      ['Catatan jam', show(r.clock_flags)],
      ['Peringatan', show(r.warnings)],
      ['Kode attempt', r.attempt_id]
    ]);
    $('detail-answers').appendChild(table(
      ['No', 'Soal', 'Jawaban', 'Hasil', 'Waktu menjawab'],
      res.data.answers.map(function (a) {
        let hasil;
        if (!a.answer) hasil = el('span', { className: 'muted', text: 'Kosong' });
        else if (a.is_correct) hasil = el('span', { className: 'ok-text', text: '✔ Benar' });
        else hasil = el('span', { className: 'bad-text', text: '✘ Salah' });
        return {
          cells: [
            { text: a.number, className: 'num' },
            { text: a.question, title: a.question, className: 'wrap', math: true },
            a.answer || '-',
            hasil,
            a.answered_at ? UI.formatClock(a.answered_at) : '-'
          ]
        };
      })
    ));
  }

  function closeDetail() {
    $('detail-modal').hidden = true;
    detailAttempt = null;
    UI.hideMsg('detail-message');
  }

  /* ---------- Perbarui otomatis ---------- */

  function startAuto() {
    stopAuto();
    autoHandle = setInterval(function () {
      if (navigator.onLine && document.visibilityState === 'visible' && !loading) loadDashboard(true);
    }, AUTO_MS);
  }

  function stopAuto() {
    if (autoHandle) clearInterval(autoHandle);
    autoHandle = null;
  }

  /* ---------- Membuka dashboard ---------- */

  async function openDashboard() {
    const s = Auth.getState();
    $('dash-teacher').textContent = s.user.name;
    $('dash-role').textContent = s.user.role === 'ADMIN' ? 'Admin' : 'Guru';
    UI.showScreen('home');
    UI.hideMsg('dash-message');
    const hasExam = await loadExamList();
    if (hasExam) await loadDashboard(false);
    document.dispatchEvent(new CustomEvent('siber:dashboard-open'));
  }

  async function loadSchoolName() {
    try {
      const cached = await DB.getSetting('app_config');
      if (cached) $('school-name').textContent = cached.school_name || '';
      if (!navigator.onLine) return;
      const res = await Api.call('getAppConfig', {});
      if (res.success) {
        $('school-name').textContent = res.data.school_name || '';
        await DB.setSetting('app_config', res.data);
      }
    } catch (e) { /* abaikan */ }
  }

  async function init() {
    $('footer-version').textContent = 'Versi ' + SIBER_CONFIG.CLIENT_VERSION;
    updateNetStatus();
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);

    $('login-form').addEventListener('submit', onLogin);
    $('btn-toggle-password').addEventListener('click', onTogglePassword);
    $('btn-logout').addEventListener('click', onLogout);
    $('btn-refresh').addEventListener('click', function () { loadDashboard(false); });
    $('sel-exam').addEventListener('change', function () {
      $('sel-class').value = '';
      loadDashboard(false);
    });
    $('sel-class').addEventListener('change', function () { loadDashboard(false); });
    $('sel-sort').addEventListener('change', renderParticipants);
    $('chk-auto').addEventListener('change', function () {
      if ($('chk-auto').checked) startAuto(); else stopAuto();
    });
    $('participants').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-attempt]');
      if (b) openDetail(b.dataset.attempt);
    });
    $('btn-live-refresh').addEventListener('click', loadLive);
    $('live').addEventListener('click', onLiveClick);
    $('msg-input').addEventListener('input', updateMsgCounter);
    $('btn-send-message').addEventListener('click', onSendMessage);
    $('msg-list').addEventListener('click', onMessageListClick);
    $('btn-detail-close').addEventListener('click', closeDetail);
    $('detail-answers').addEventListener('click', onDetailFix);
    $('btn-detail-delete').addEventListener('click', onDetailDelete);
    $('btn-detail-print').addEventListener('click', onDetailPrint);
    $('btn-regrade').addEventListener('click', onRegrade);
    window.SiberDash = {
      getExamId: function () { return $('sel-exam').value; },
      getClass: function () { return $('sel-class').value; },
      getLastData: function () { return lastData; },
      reload: function (quiet) { return loadDashboard(quiet !== false); },
      openDetail: openDetail
    };
    $('detail-modal').addEventListener('click', function (e) {
      if (e.target === $('detail-modal')) closeDetail();
    });

    if (!Api.isConfigured()) { UI.showScreen('setup'); return; }
    if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
      $('fatal-message').textContent = 'Halaman harus dibuka lewat alamat https (GitHub Pages).';
      UI.showScreen('fatal');
      return;
    }
    try {
      await DB.open();
    } catch (e) {
      $('fatal-message').textContent = 'Penyimpanan lokal tidak bisa dibuka: ' + e.message;
      UI.showScreen('fatal');
      return;
    }

    loadSchoolName();

    let restored = null;
    try { restored = await Auth.restore(); } catch (e) { restored = null; }

    if (restored && isTeacher(restored)) {
      await openDashboard();
    } else {
      UI.showScreen('login');
      if (restored) {
        UI.showMsg('login-message', 'info',
          'Perangkat ini sedang dipakai akun siswa (' + restored.user.username + '). Masuk dengan akun guru untuk membuka dashboard.');
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
