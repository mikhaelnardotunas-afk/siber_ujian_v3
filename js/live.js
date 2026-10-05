/**
 * SIBER-UJIAN — live.js (aplikasi siswa)
 * Saat ADA internet:
 *  - melapor ke guru secara berkala (sedang ujian atau di beranda, soal ke berapa,
 *    jumlah terjawab, sisa waktu, jumlah pelanggaran),
 *  - mengambil PESAN dari guru dan menampilkannya di layar.
 * Saat offline, tidak ada laporan dan pesan; ujian tetap berjalan normal.
 */
const Live = (function () {
  'use strict';

  const SEEN_KEY = 'seen_messages';
  const MAX_SEEN = 300;

  let busy = false;
  let soonHandle = null;
  let queue = [];
  let showing = false;

  function $(id) { return document.getElementById(id); }

  function interval() {
    const n = Number(SIBER_CONFIG.HEARTBEAT_MS);
    return isFinite(n) && n >= 15000 ? n : 45000;
  }

  function canBeat() {
    if (!navigator.onLine || typeof Auth === 'undefined') return false;
    const s = Auth.getState();
    return !!s && s.user.role === 'STUDENT' && s.session_valid;
  }

  async function beat() {
    if (busy || !canBeat()) return;
    busy = true;
    try {
      const info = (typeof Exam !== 'undefined' && Exam.getLiveInfo) ? Exam.getLiveInfo() : null;
      const payload = info || { state: 'HOME' };
      payload.client_version = SIBER_CONFIG.CLIENT_VERSION;
      const res = await Auth.authedCall('heartbeat', payload);
      if (res.success && res.data && Array.isArray(res.data.messages)) {
        await receive(res.data.messages);
      }
    } catch (e) {
      console.warn('Laporan ke guru gagal:', e);
    } finally {
      busy = false;
    }
  }

  /** Kirim laporan sebentar lagi (misalnya setelah ujian dimulai atau ada pelanggaran). */
  function beatSoon() {
    if (soonHandle) clearTimeout(soonHandle);
    soonHandle = setTimeout(function () { soonHandle = null; beat(); }, 1500);
  }

  async function receive(messages) {
    const seen = (await DB.getSetting(SEEN_KEY)) || [];
    const fresh = messages.filter(function (m) {
      return m && m.message_id && seen.indexOf(m.message_id) === -1 &&
        !queue.some(function (q) { return q.message_id === m.message_id; });
    });
    if (!fresh.length) return;
    fresh.sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
    queue = queue.concat(fresh);
    if (navigator.vibrate) {
      try { navigator.vibrate([120, 80, 120]); } catch (e) { /* abaikan */ }
    }
    showNext();
  }

  function showNext() {
    if (showing || !queue.length) return;
    const m = queue[0];
    showing = true;
    $('msg-from').textContent = 'Pesan dari ' + (m.from_name || 'guru');
    $('msg-time').textContent = UI.formatDateTime(m.created_at);
    $('msg-text').textContent = m.text;
    $('msg-count').textContent = queue.length > 1 ? (queue.length - 1) + ' pesan lagi' : '';
    $('msg-modal').hidden = false;
    $('btn-msg-ok').focus();
  }

  async function onOk() {
    const m = queue.shift();
    $('msg-modal').hidden = true;
    showing = false;
    if (m) {
      try {
        const seen = (await DB.getSetting(SEEN_KEY)) || [];
        seen.push(m.message_id);
        await DB.setSetting(SEEN_KEY, seen.slice(-MAX_SEEN));
      } catch (e) { /* abaikan */ }
    }
    showNext();
  }

  function init() {
    if (!$('msg-modal')) return;
    $('btn-msg-ok').addEventListener('click', onOk);
    window.addEventListener('online', beatSoon);
    setInterval(beat, interval());
    setTimeout(beat, 4000);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { beat: beat, beatSoon: beatSoon };
})();
