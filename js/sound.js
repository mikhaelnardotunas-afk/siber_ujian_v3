/**
 * SIBER-UJIAN — sound.js (v3)
 * Efek suara ala game (dibuat dengan Web Audio, tanpa file suara, tetap jalan offline)
 * dan perayaan konfeti. Dipasang tanpa mengubah logika ujian:
 *  - klik tombol, pilih jawaban, pindah soal, tandai ragu-ragu
 *  - peringatan waktu (alarm sekali + detak 10 detik terakhir)
 *  - pelanggaran tercatat, pesan dari guru, ujian selesai (fanfare + konfeti)
 * Tombol 🔊 di bilah atas mematikan/menyalakan suara (diingat di perangkat).
 */
const Sfx = (function () {
  'use strict';

  const KEY = 'siber_mute';
  let ctx = null;

  // [frekuensi Hz, mulai detik, lama detik, frekuensi akhir (opsional)]
  const TONES = {
    klik: { w: 'triangle', n: [[520, 0, 0.06]] },
    pop: { w: 'triangle', n: [[660, 0, 0.07], [990, 0.06, 0.09]] },
    whoosh: { w: 'triangle', n: [[300, 0, 0.2, 900]] },
    bendera: { w: 'square', n: [[700, 0, 0.06], [940, 0.07, 0.1]], v: 0.08 },
    koin: { w: 'square', n: [[988, 0, 0.08], [1319, 0.08, 0.28]], v: 0.1 },
    sukses: { w: 'triangle', n: [[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.28]] },
    menang: { w: 'square', v: 0.09, n: [[523, 0, 0.12], [523, 0.13, 0.12], [523, 0.26, 0.12], [698, 0.4, 0.5],
      [622, 0.92, 0.14], [698, 1.08, 0.14], [784, 1.24, 0.14], [1047, 1.4, 0.6]] },
    salah: { w: 'sawtooth', n: [[220, 0, 0.18], [170, 0.15, 0.25]], v: 0.12 },
    detik: { w: 'square', n: [[1200, 0, 0.04]], v: 0.06 },
    alarm: { w: 'square', v: 0.1, n: [[880, 0, 0.14], [660, 0.17, 0.14], [880, 0.34, 0.14], [660, 0.51, 0.2]] },
    pesan: { w: 'sine', n: [[784, 0, 0.14], [1047, 0.15, 0.14], [1319, 0.3, 0.3]] }
  };

  function isMuted() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }

  function setMuted(v) {
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* abaikan */ }
    updateButton();
  }

  function play(name) {
    if (isMuted()) return;
    const t = TONES[name];
    if (!t) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = ctx || new AC();
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime + 0.01;
      const vol = t.v || 0.16;
      t.n.forEach(function (n) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = t.w;
        o.frequency.setValueAtTime(n[0], now + n[1]);
        if (n[3]) o.frequency.exponentialRampToValueAtTime(n[3], now + n[1] + n[2]);
        g.gain.setValueAtTime(0.0001, now + n[1]);
        g.gain.exponentialRampToValueAtTime(vol, now + n[1] + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + n[1] + n[2]);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(now + n[1]);
        o.stop(now + n[1] + n[2] + 0.03);
      });
    } catch (e) { /* suara tidak wajib */ }
  }

  function confetti() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const colors = ['#e4432d', '#2e8fd8', '#6acb3a', '#ffcb2b', '#8b5cf6', '#ff8a1f'];
      const box = document.createElement('div');
      box.className = 'confetti';
      for (let i = 0; i < 70; i++) {
        const p = document.createElement('i');
        p.style.left = (Math.random() * 100) + 'vw';
        p.style.background = colors[i % colors.length];
        p.style.animationDuration = (2.2 + Math.random() * 2) + 's';
        p.style.animationDelay = (Math.random() * 0.8) + 's';
        p.style.transform = 'rotate(' + Math.round(Math.random() * 360) + 'deg)';
        box.appendChild(p);
      }
      document.body.appendChild(box);
      setTimeout(function () { box.remove(); }, 5500);
    } catch (e) { /* abaikan */ }
  }

  function toast(text) {
    let box = document.getElementById('toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-box';
      box.className = 'toast-box';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  function updateButton() {
    const b = document.getElementById('btn-sound');
    if (!b) return;
    const m = isMuted();
    b.textContent = m ? '🔇' : '🔊';
    b.classList.toggle('is-muted', m);
    b.setAttribute('aria-label', m ? 'Nyalakan suara' : 'Matikan suara');
    b.title = m ? 'Suara mati' : 'Suara menyala';
  }

  /* ---------- Pengamat layar (tanpa mengubah logika ujian) ---------- */

  function isVisible(id) {
    const el = document.getElementById(id);
    return !!el && !el.hidden;
  }

  function watch() {
    // Klik tombol
    document.addEventListener('click', function (e) {
      const b = e.target.closest('button');
      if (!b || b.disabled || b.id === 'btn-sound') return;
      if (b.closest('#exam-options')) play('pop');
      else if (b.id === 'btn-flag') play('bendera');
      else if (b.classList.contains('grid-btn') || b.id === 'btn-prev' || b.id === 'btn-next') play('whoosh');
      else play('klik');
    }, true);

    // Waktu: alarm sekali saat mulai menipis, detak di 10 detik terakhir
    const box = document.getElementById('exam-timer-box');
    const timer = document.getElementById('exam-timer');
    if (box && timer) {
      let warned = false;
      let lastText = '';
      new MutationObserver(function () {
        const warn = box.classList.contains('timer-warn');
        if (warn && !warned && isVisible('screen-exam')) play('alarm');
        warned = warn;
      }).observe(box, { attributes: true, attributeFilter: ['class'] });
      new MutationObserver(function () {
        const txt = timer.textContent || '';
        if (txt === lastText) return;
        lastText = txt;
        const m = txt.match(/^(\d+):(\d{2})$/);
        if (!m || !isVisible('screen-exam')) return;
        const sec = Number(m[1]) * 60 + Number(m[2]);
        if (sec > 0 && sec <= 10) play('detik');
      }).observe(timer, { childList: true, characterData: true, subtree: true });
    }

    // Pelanggaran bertambah
    const vio = document.getElementById('exam-violations');
    if (vio) {
      let last = -1;
      new MutationObserver(function () {
        const m = (vio.textContent || '').match(/(\d+)/);
        const n = m ? Number(m[1]) : 0;
        if (last >= 0 && n > last) play('salah');
        last = n;
      }).observe(vio, { childList: true, characterData: true, subtree: true });
    }

    // Ujian selesai
    const done = document.getElementById('screen-exam-done');
    if (done) {
      new MutationObserver(function () {
        if (!done.hidden) { play('menang'); confetti(); }
      }).observe(done, { attributes: true, attributeFilter: ['hidden'] });
    }

    // Pesan dari guru
    const modal = document.getElementById('msg-modal');
    if (modal) {
      new MutationObserver(function () {
        if (!modal.hidden) play('pesan');
      }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    }

    // Login gagal
    const lm = document.getElementById('login-message');
    if (lm) {
      new MutationObserver(function () {
        if (!lm.hidden && lm.classList.contains('msg-error')) play('salah');
      }).observe(lm, { attributes: true, attributeFilter: ['hidden', 'class'] });
    }
  }

  function init() {
    const b = document.getElementById('btn-sound');
    if (b) {
      b.addEventListener('click', function () {
        const m = !isMuted();
        setMuted(m);
        if (!m) play('koin');
        toast(m ? 'Suara dimatikan' : 'Suara dinyalakan');
      });
    }
    updateButton();
    watch();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { play: play, confetti: confetti, toast: toast, isMuted: isMuted, setMuted: setMuted };
})();
