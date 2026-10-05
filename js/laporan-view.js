/**
 * SIBER-UJIAN — laporan-view.js (v3)
 * Menampilkan laporan yang disusun dashboard guru (tab pembuka), lalu siap dicetak / disimpan PDF.
 * Data diambil dari tab pembuka (window.opener) atau salinan terakhir di localStorage.
 */
(function () {
  'use strict';
  const MAX_WAIT_MS = 5 * 60 * 1000;
  const started = Date.now();
  const reqId = (location.hash || '').replace('#', '');

  function $(id) { return document.getElementById(id); }

  function fromOpener() {
    try {
      const store = window.opener && window.opener.SIBER_LAPORAN_DOCS;
      return store && reqId ? store[reqId] || null : null;
    } catch (e) { return null; }
  }

  function fromStorage() {
    try {
      const doc = JSON.parse(localStorage.getItem('siber_laporan_last') || 'null');
      if (doc && (!reqId || String(doc.id) === reqId)) return doc;
    } catch (e) { /* abaikan */ }
    return null;
  }

  function show(doc) {
    if (doc.error) {
      $('status').textContent = 'Gagal membuat laporan: ' + doc.error;
      $('isi').innerHTML = '';
      const p = document.createElement('p');
      p.textContent = doc.error;
      $('isi').appendChild(p);
      return;
    }
    document.title = doc.title || 'Laporan';
    if (doc.landscape) document.body.classList.add('landscape');
    $('isi').innerHTML = doc.html;
    if (window.MathRenderer) {
      document.querySelectorAll('#isi .math').forEach(function (el) {
        const src = el.getAttribute('data-src');
        if (src && /\$|\\\(|\\\[/.test(src)) MathRenderer.renderInto(el, src);
      });
    }
    document.querySelectorAll('#isi img').forEach(function (img) {
      img.addEventListener('error', function () {
        if (!img.dataset.fallback) { img.dataset.fallback = '1'; img.src = 'assets/icons/icon-192.png'; }
      });
    });
    $('btn-print').disabled = false;
    $('status').textContent = 'Siap dicetak. Di jendela cetak pilih tujuan "Simpan sebagai PDF".' +
      (doc.landscape ? ' Kertas: A4 mendatar.' : ' Kertas: A4.');
  }

  function poll() {
    const doc = fromOpener();
    if (doc) {
      try { localStorage.setItem('siber_laporan_last', JSON.stringify(doc)); } catch (e) { /* terlalu besar: abaikan */ }
      show(doc);
      return;
    }
    let openerGone = false;
    try { openerGone = !window.opener || window.opener.closed; } catch (e) { openerGone = true; }
    if (openerGone || Date.now() - started > MAX_WAIT_MS) {
      const saved = fromStorage();
      if (saved) { show(saved); return; }
      $('status').textContent = 'Data laporan tidak ditemukan. Buat ulang dari dashboard guru.';
      return;
    }
    setTimeout(poll, 300);
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('btn-print').addEventListener('click', function () { window.print(); });
    poll();
  });
})();
