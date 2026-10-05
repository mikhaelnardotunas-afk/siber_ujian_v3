/**
 * SIBER-UJIAN — laporan.js (v3)
 * Menyusun isi laporan (HTML aman, tanpa style inline) untuk dibuka di laporan.html:
 *  rekap      : rekap nilai satu ujian
 *  detail     : lembar jawaban per siswa (1 halaman per siswa)
 *  analisis   : analisis butir soal (kesukaran, daya beda, sebaran pilihan)
 *  kelas      : rekap semua ujian satu kelas
 *  mapel      : rekap semua ujian satu mata pelajaran
 *  riwayat    : riwayat nilai satu siswa
 */
const Laporan = (function () {
  'use strict';

  const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus',
    'September', 'Oktober', 'November', 'Desember'];
  const LETTERS = ['A', 'B', 'C', 'D', 'E'];

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** Teks yang mungkin berisi rumus LaTeX: dirender di laporan.html oleh MathRenderer. */
  function rich(s) {
    const t = String(s === null || s === undefined ? '' : s);
    return '<span class="math" data-src="' + esc(t) + '">' + esc(t) + '</span>';
  }
  function tglIndo(iso) {
    const d = iso ? new Date(iso + 'T00:00:00') : new Date();
    if (isNaN(d.getTime())) return '';
    return d.getDate() + ' ' + BULAN[d.getMonth()] + ' ' + d.getFullYear();
  }
  function waktu(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '-';
    return d.getDate() + ' ' + BULAN[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear() + ', ' +
      ('0' + d.getHours()).slice(-2) + '.' + ('0' + d.getMinutes()).slice(-2);
  }
  function angka(v) {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '-';
    return String(Math.round(Number(v) * 10) / 10).replace('.', ',');
  }
  function rata(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : null; }
  function ket(nilai, kkm) { return nilai === null || nilai === undefined ? '' : (nilai >= kkm ? 'Tuntas' : 'Belum tuntas'); }
  function ketHtml(nilai, kkm) {
    if (nilai === null || nilai === undefined) return '-';
    return nilai >= kkm ? '<span class="tuntas">Tuntas</span>' : '<span class="belum">Belum tuntas</span>';
  }
  function durasi(a, b) {
    const x = Date.parse(a), y = Date.parse(b);
    if (isNaN(x) || isNaN(y)) return '-';
    return Math.max(0, Math.round((y - x) / 60000)) + ' menit';
  }
  function barClass(pct) {
    const v = Math.max(0, Math.min(100, Math.round((Number(pct) || 0) / 5) * 5));
    return 'bar w' + v;
  }
  function cmpText(a, b) { return String(a || '').localeCompare(String(b || ''), 'id'); }

  function urutkan(rows, cara) {
    return rows.sort(function (a, b) {
      if (cara === 'nilai') {
        const x = a.nilai === null || a.nilai === undefined ? -1 : a.nilai;
        const y = b.nilai === null || b.nilai === undefined ? -1 : b.nilai;
        return (y - x) || cmpText(a.name, b.name);
      }
      if (cara === 'nama') return cmpText(a.name, b.name);
      return cmpText(a.class, b.class) || cmpText(a.name, b.name);
    });
  }

  /* ---------- Kop & tanda tangan ---------- */

  function kop(o, judul, sub) {
    const logo = o.logo && /^https:\/\//i.test(o.logo) ? o.logo : 'assets/icons/icon-192.png';
    return '<div class="kop"><img src="' + esc(logo) + '" alt=""><div class="t">' +
      '<div class="s">' + esc(o.sekolah || '') + '</div>' +
      '<div class="j">' + esc(judul) + '</div>' +
      '<div class="x">' + esc(sub || '') + (o.tp ? ' · Tahun Pelajaran ' + esc(o.tp) : '') + '</div></div>' +
      '<img src="' + esc(logo) + '" alt="" class="ghost"></div>';
  }

  function ttd(o, hanyaGuru) {
    if (!o.ttd) return '';
    const tempat = esc(o.kota || '') + (o.kota ? ', ' : '') + tglIndo(o.tanggal);
    const guru = '<div>' + (hanyaGuru ? tempat + '<br>' : '<br>') + 'Guru Mata Pelajaran<div class="nm">' +
      esc(o.guru || '……………………………') + '</div>NIP. ' + esc(o.nipGuru || '-') + '</div>';
    const kepsek = '<div>Mengetahui,<br>Kepala Sekolah<div class="nm">' + esc(o.kepsek || '……………………………') +
      '</div>NIP. ' + esc(o.nipKepsek || '-') + '</div>';
    if (hanyaGuru) return '<div class="ttd"><div></div>' + guru + '</div>';
    return '<p class="tempat">' + tempat + '</p><div class="ttd">' + kepsek + guru + '</div>';
  }

  function ringkas(items) {
    return '<div class="ringkas">' + items.map(function (it) {
      return '<div>' + esc(it[0]) + '<b>' + it[1] + '</b></div>';
    }).join('') + '</div>';
  }

  function sebaran(nilai) {
    if (!nilai.length) return '';
    const rentang = [[85, 100, 'Sangat baik (85–100)'], [70, 84.999, 'Baik (70–84)'],
      [50, 69.999, 'Cukup (50–69)'], [0, 49.999, 'Perlu bimbingan (0–49)']];
    return '<table class="half"><thead><tr><th>Rentang nilai</th><th class="w60">Jumlah</th><th>Grafik</th></tr></thead><tbody>' +
      rentang.map(function (r) {
        const n = nilai.filter(function (v) { return v >= r[0] && v <= r[1]; }).length;
        const pct = n / nilai.length * 100;
        return '<tr><td>' + r[2] + '</td><td class="c">' + n + '</td><td><span class="' + barClass(pct) + '"></span> ' +
          Math.round(pct) + '%</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---------- 1. Rekap satu ujian ---------- */
  function rekap(o, d) {
    const e = d.exam;
    const map = {};
    d.results.forEach(function (r) { map[r.user_id] = r; });
    const known = {};
    let rows = d.students.map(function (s) {
      known[s.user_id] = true;
      const r = map[s.user_id];
      return { name: s.name, class: s.class, r: r, nilai: r ? r.score : null };
    });
    d.results.forEach(function (r) {
      if (!known[r.user_id]) rows.push({ name: r.name, class: r.class, r: r, nilai: r.score, extra: true });
    });
    if (!o.belum) rows = rows.filter(function (x) { return x.r; });
    urutkan(rows, o.urut);
    const nilai = rows.filter(function (x) { return x.r; }).map(function (x) { return x.nilai; });
    const tuntas = nilai.filter(function (v) { return v >= o.kkm; }).length;
    const peserta = nilai.length;
    const totalSiswa = d.students.length;
    const kelasTeks = o.kelas || 'Semua kelas tingkat ' + e.grade;

    let html = kop(o, 'REKAP NILAI ' + String(e.exam_name).toUpperCase(), e.subject + ' · ' + kelasTeks) +
      '<table class="info"><tr><td>Mata pelajaran</td><td>: ' + esc(e.subject) + '</td><td>Jumlah soal</td><td>: ' +
      esc(e.question_count) + ' pilihan ganda</td></tr>' +
      '<tr><td>Kelas</td><td>: ' + esc(kelasTeks) + '</td><td>KKM</td><td>: ' + esc(o.kkm) + '</td></tr></table>' +
      ringkas([
        ['Peserta', peserta + ' / ' + totalSiswa],
        ['Rata-rata', angka(rata(nilai))],
        ['Tertinggi / Terendah', nilai.length ? angka(Math.max.apply(null, nilai)) + ' / ' + angka(Math.min.apply(null, nilai)) : '-'],
        ['Tuntas', tuntas + (nilai.length ? ' (' + Math.round(tuntas / nilai.length * 100) + '%)' : '')]
      ]);

    const rankCol = o.urut === 'nilai';
    html += '<table><thead><tr><th class="w34">No</th>' + (rankCol ? '<th class="w44">Rank</th>' : '') +
      '<th>Nama siswa</th><th class="w70">Kelas</th><th class="w50">Benar</th><th class="w50">Salah</th>' +
      '<th class="w60">Nilai</th><th class="w105">Keterangan</th><th class="w70">Pelang&shy;garan</th></tr></thead><tbody>';
    let rank = 0, prev = null, shown = 0;
    rows.forEach(function (x, i) {
      const r = x.r;
      let k;
      if (!r) k = '<span class="belum">Tidak ikut</span>';
      else k = ketHtml(x.nilai, o.kkm);
      if (r) {
        shown++;
        if (prev === null || x.nilai !== prev) rank = shown;
        prev = x.nilai;
      }
      html += '<tr><td class="c">' + (i + 1) + '</td>' + (rankCol ? '<td class="c">' + (r ? rank : '-') + '</td>' : '') +
        '<td>' + esc(x.name) + (r && r.edited ? ' <span class="kecil">*</span>' : '') + (x.extra ? ' <span class="kecil">(nonaktif)</span>' : '') +
        '</td><td class="c">' + esc(x.class) + '</td>' +
        '<td class="c">' + (r ? r.correct : '-') + '</td><td class="c">' + (r ? r.wrong : '-') + '</td>' +
        '<td class="c"><b>' + (r ? angka(x.nilai) : '-') + '</b></td><td class="c">' + k + '</td>' +
        '<td class="c">' + (r ? (r.violations || 0) : '-') + '</td></tr>';
    });
    html += '</tbody></table>';
    if (rows.some(function (x) { return x.r && x.r.edited; })) html += '<p class="kecil">* nilai sudah dikoreksi guru.</p>';
    html += sebaran(nilai);
    return html + ttd(o, false);
  }

  /* ---------- 2. Lembar jawaban per siswa ---------- */
  function detail(o, d) {
    const e = d.exam;
    const uname = {};
    (d.students || []).forEach(function (s) { uname[s.user_id] = s.username; });
    const list = d.sheets.slice().sort(function (a, b) { return cmpText(a.class, b.class) || cmpText(a.name, b.name); });
    if (!list.length) return kop(o, 'LEMBAR JAWABAN', e.exam_name) + '<p>Belum ada jawaban terkirim untuk pilihan ini.</p>';
    return list.map(function (h, idx) {
      let s = '<div class="' + (idx ? 'halaman' : '') + '">' +
        kop(o, 'LEMBAR JAWABAN DAN NILAI', e.exam_name + ' · ' + e.subject) +
        '<table class="info"><tr><td>Nama</td><td>: <b>' + esc(h.name) + '</b></td><td>Kelas</td><td>: ' + esc(h.class) + '</td></tr>' +
        '<tr><td>Username</td><td>: ' + esc(uname[h.user_id] || h.user_id) + '</td><td>Dikirim</td><td>: ' + waktu(h.synced_at) + '</td></tr>' +
        '<tr><td>Lama mengerjakan</td><td>: ' + durasi(h.started_at, h.completed_at) + '</td><td>Pelanggaran</td><td>: ' +
        (h.violations || 0) + ' kali</td></tr></table>' +
        ringkas([
          ['Benar', h.correct + ' / ' + h.total],
          ['Salah / kosong', String(h.wrong)],
          ['Nilai', angka(h.score)],
          ['Keterangan', esc(ket(h.score, o.kkm))]
        ]);
      s += '<table><thead><tr><th class="w34">No</th>' + (o.teksSoal ? '<th>Soal</th>' : '') +
        '<th class="' + (o.teksSoal ? 'w150' : '') + '">Jawaban siswa</th>' + (o.kunci ? '<th class="w54">Kunci</th>' : '') +
        '<th class="w54">Hasil</th><th class="w50">Skor</th></tr></thead><tbody>';
      d.questions.forEach(function (q) {
        const a = h.answers[q.question_id] || { a: '', c: false, s: 0, e: false };
        const opsi = q.options || {};
        let soal = '';
        if (o.teksSoal) {
          soal = '<td>' + rich(q.question) + (q.has_image ? ' <span class="kecil">[gambar]</span>' : '') +
            '<div class="opsi">' + LETTERS.filter(function (L) { return opsi[L]; }).map(function (L) {
              const cls = (o.kunci && L === q.answer_key) ? ' class="kunci"' : '';
              return '<div' + cls + '>' + L + '. ' + rich(opsi[L]) + '</div>';
            }).join('') + '</div></td>';
        }
        const jawab = a.a ? '<b>' + esc(a.a) + '.</b> ' + (o.teksSoal ? '' : rich(opsi[a.a] || '')) : '<i>Tidak dijawab</i>';
        s += '<tr><td class="c">' + q.number + '</td>' + soal + '<td>' + jawab + '</td>' +
          (o.kunci ? '<td class="c">' + esc(q.answer_key) + '</td>' : '') +
          '<td class="c">' + (a.c ? '✔' : '✘') + (a.e ? '<sup>*</sup>' : '') + '</td><td class="c">' + angka(a.s) + '</td></tr>';
      });
      s += '</tbody></table>';
      if (d.questions.some(function (q) { return (h.answers[q.question_id] || {}).e; })) {
        s += '<p class="kecil">* dikoreksi guru.</p>';
      }
      return s + ttd(o, true) + '</div>';
    }).join('');
  }

  /* ---------- 3. Analisis butir soal ---------- */
  function analisis(o, d) {
    const e = d.exam;
    const sheets = d.sheets;
    const n = sheets.length;
    const kelasTeks = o.kelas || 'Semua kelas';
    let html = kop(o, 'ANALISIS BUTIR SOAL', e.exam_name + ' · ' + e.subject + ' · ' + kelasTeks);
    if (!n) return html + '<p>Belum ada jawaban terkirim untuk pilihan ini.</p>';

    const sorted = sheets.slice().sort(function (a, b) { return b.score - a.score; });
    const g = n >= 6 ? Math.max(1, Math.round(n * 0.27)) : 0;
    const upper = g ? sorted.slice(0, g) : [];
    const lower = g ? sorted.slice(n - g) : [];

    let mudah = 0, sedang = 0, sukar = 0;
    const rows = d.questions.map(function (q) {
      const dist = { A: 0, B: 0, C: 0, D: 0, E: 0 };
      let benar = 0, kosong = 0;
      sheets.forEach(function (h) {
        const a = h.answers[q.question_id];
        if (!a || !a.a) { kosong++; return; }
        if (dist[a.a] !== undefined) dist[a.a]++;
        if (a.c) benar++;
      });
      const p = benar / n * 100;
      let kat = 'Sedang';
      if (p >= 70) { kat = 'Mudah'; mudah++; } else if (p < 30) { kat = 'Sukar'; sukar++; } else sedang++;
      let db = null, dbKet = '-';
      if (g) {
        const cu = upper.filter(function (h) { return (h.answers[q.question_id] || {}).c; }).length;
        const cl = lower.filter(function (h) { return (h.answers[q.question_id] || {}).c; }).length;
        db = (cu - cl) / g;
        dbKet = db >= 0.4 ? 'Sangat baik' : db >= 0.3 ? 'Baik' : db >= 0.2 ? 'Cukup' : 'Perlu diperbaiki';
      }
      return { q: q, dist: dist, benar: benar, kosong: kosong, p: p, kat: kat, db: db, dbKet: dbKet };
    });

    html += '<table class="info"><tr><td>Jumlah peserta</td><td>: ' + n + ' siswa</td><td>Jumlah soal</td><td>: ' +
      d.questions.length + '</td></tr></table>' +
      ringkas([['Mudah (≥70%)', String(mudah)], ['Sedang (30–69%)', String(sedang)], ['Sukar (<30%)', String(sukar)],
        ['Rata-rata nilai', angka(rata(sheets.map(function (h) { return h.score; })))]]);
    const letters = LETTERS.filter(function (L) { return d.questions.some(function (q) { return q.options && q.options[L]; }); });
    html += '<table><thead><tr><th class="w34">No</th>' + (o.teksSoal ? '<th>Soal</th>' : '') +
      '<th class="w44">Kunci</th>' + letters.map(function (L) { return '<th class="w44">' + L + '</th>'; }).join('') +
      '<th class="w44">Ko&shy;song</th><th class="w60">% Benar</th><th class="w70">Kesu&shy;karan</th><th class="w60">Daya beda</th>' +
      '<th class="w90">Ket. daya beda</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr><td class="c">' + r.q.number + '</td>' + (o.teksSoal ? '<td>' + rich(r.q.question) + '</td>' : '') +
        '<td class="c"><b>' + esc(r.q.answer_key) + '</b></td>' +
        letters.map(function (L) {
          return '<td class="c' + (L === r.q.answer_key ? ' kunci' : '') + '">' + r.dist[L] + '</td>';
        }).join('') +
        '<td class="c">' + r.kosong + '</td><td class="c">' + angka(r.p) + '%</td><td class="c">' + r.kat + '</td>' +
        '<td class="c">' + (r.db === null ? '-' : angka(r.db)) + '</td><td class="c">' + r.dbKet + '</td></tr>';
    });
    html += '</tbody></table><p class="kecil">Kesukaran = persentase siswa yang menjawab benar. Daya beda = selisih proporsi benar ' +
      'kelompok atas dan bawah (27% nilai tertinggi vs terendah); dihitung jika peserta minimal 6. ' +
      'Kolom huruf = jumlah siswa yang memilih huruf itu (huruf asli di sheet QUESTIONS); kolom berbingkai tebal = kunci. ' +
      'Pilihan pengecoh yang tidak dipilih siapa pun sebaiknya diperbaiki.</p>';
    return html + ttd(o, true);
  }

  /* ---------- 4/5. Matriks nilai (per kelas / per mapel) ---------- */
  function matriks(o, d, judul, sub) {
    const map = {};
    d.results.forEach(function (r) { map[r.exam_id + '|' + r.user_id] = r; });
    const ex = d.exams;
    if (!ex.length) return kop(o, judul, sub) + '<p>Tidak ada ujian untuk pilihan ini.</p>';
    const rows = d.students.map(function (s) {
      const vals = ex.map(function (e) {
        if (e.grade && s.grade && e.grade !== s.grade) return undefined;
        const r = map[e.exam_id + '|' + s.user_id];
        return r ? r.score : null;
      });
      const ada = vals.filter(function (v) { return typeof v === 'number'; });
      return { name: s.name, class: s.class, vals: vals, nilai: ada.length ? rata(ada) : null };
    });
    urutkan(rows, o.urut);
    let html = kop(o, judul, sub) + '<table class="legend">' + ex.map(function (e, i) {
      return '<tr><td><b>U' + (i + 1) + '</b></td><td>' + esc(e.exam_name) + '</td><td>' + esc(e.subject) +
        '</td><td>' + esc(e.start_date || '') + '</td></tr>';
    }).join('') + '</table>' +
      '<table><thead><tr><th class="w30">No</th><th>Nama siswa</th><th class="w62">Kelas</th>' +
      ex.map(function (e, i) { return '<th>U' + (i + 1) + '</th>'; }).join('') +
      '<th>Rata-rata</th><th>Ket.</th></tr></thead><tbody>';
    rows.forEach(function (r, i) {
      html += '<tr><td class="c">' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td class="c">' + esc(r.class) + '</td>' +
        r.vals.map(function (v) {
          if (v === undefined) return '<td class="c abu">·</td>';
          if (v === null) return '<td class="c">-</td>';
          return '<td class="c' + (v < o.kkm ? ' belum' : '') + '">' + angka(v) + '</td>';
        }).join('') +
        '<td class="c"><b>' + angka(r.nilai) + '</b></td><td class="c">' + (r.nilai === null ? '-' : ket(r.nilai, o.kkm)) + '</td></tr>';
    });
    html += '<tr><th colspan="3" class="r">Rata-rata ujian</th>' + ex.map(function (e, j) {
      return '<th>' + angka(rata(rows.map(function (r) { return r.vals[j]; }).filter(function (v) { return typeof v === 'number'; }))) + '</th>';
    }).join('') + '<th>' + angka(rata(rows.map(function (r) { return r.nilai; }).filter(function (v) { return v !== null; }))) +
      '</th><th></th></tr></tbody></table>' +
      '<p class="kecil">Keterangan: "-" tidak ikut / belum mengirim · "·" ujian bukan untuk tingkat kelas siswa · angka merah di bawah KKM (' +
      esc(o.kkm) + '). Rata-rata siswa hanya dari ujian yang diikuti.</p>';
    return html + ttd(o, false);
  }

  /* ---------- 6. Riwayat satu siswa ---------- */
  function riwayat(o, d) {
    const s = d.student;
    if (!s) return '<p>Siswa tidak ditemukan.</p>';
    const map = {};
    d.results.forEach(function (r) { if (r.user_id === s.user_id) map[r.exam_id] = r; });
    const nilai = [];
    let html = kop(o, 'RIWAYAT NILAI SISWA', s.name + ' · Kelas ' + s.class) +
      '<table class="info"><tr><td>Nama</td><td>: <b>' + esc(s.name) + '</b></td></tr><tr><td>Kelas</td><td>: ' + esc(s.class) +
      '</td></tr><tr><td>Username</td><td>: ' + esc(s.username) + '</td></tr></table>' +
      '<table><thead><tr><th class="w34">No</th><th>Ujian</th><th>Mata pelajaran</th><th>Dikirim</th><th class="w50">Benar</th>' +
      '<th class="w60">Nilai</th><th class="w105">Keterangan</th></tr></thead><tbody>';
    d.exams.forEach(function (e, i) {
      const r = map[e.exam_id];
      if (r) nilai.push(r.score);
      html += '<tr><td class="c">' + (i + 1) + '</td><td>' + esc(e.exam_name) + '</td><td>' + esc(e.subject) + '</td><td>' +
        (r ? waktu(r.synced_at || r.completed_at) : '-') + '</td><td class="c">' + (r ? r.correct + '/' + r.total : '-') + '</td>' +
        '<td class="c"><b>' + (r ? angka(r.score) : '-') + '</b></td><td class="c">' +
        (!r ? '<span class="belum">Tidak ikut</span>' : ketHtml(r.score, o.kkm)) + '</td></tr>';
    });
    html += '<tr><th colspan="5" class="r">Rata-rata</th><th>' + angka(rata(nilai)) + '</th><th>' +
      (nilai.length ? esc(ket(rata(nilai), o.kkm)) : '') + '</th></tr></tbody></table>';
    if (nilai.length) html += sebaran(nilai);
    return html + ttd(o, false);
  }

  /**
   * @param o pilihan laporan (lihat guru-extra.js)
   * @param d data sesuai jenis
   * @returns { title, landscape, html, math }
   */
  function build(o, d) {
    let html, title, landscape = false;
    if (o.jenis === 'rekap') { html = rekap(o, d); title = 'Rekap ' + d.exam.exam_name; }
    else if (o.jenis === 'detail') { html = detail(o, d); title = 'Lembar jawaban ' + d.exam.exam_name; }
    else if (o.jenis === 'analisis') {
      html = analisis(o, d); title = 'Analisis soal ' + d.exam.exam_name;
      landscape = !o.teksSoal ? false : true;
    } else if (o.jenis === 'kelas') {
      html = matriks(o, d, 'REKAP NILAI KELAS ' + o.kelas, (o.mapel ? o.mapel + ' · ' : 'Semua mata pelajaran · ') + 'Kelas ' + o.kelas);
      title = 'Rekap kelas ' + o.kelas; landscape = d.exams.length > 6;
    } else if (o.jenis === 'mapel') {
      html = matriks(o, d, 'REKAP NILAI ' + String(o.mapel || 'SEMUA MAPEL').toUpperCase(), o.kelas ? 'Kelas ' + o.kelas : 'Semua kelas');
      title = 'Rekap ' + (o.mapel || 'mapel'); landscape = d.exams.length > 6;
    } else { html = riwayat(o, d); title = 'Riwayat ' + (d.student ? d.student.name : ''); }
    html += '<p class="kecil dicetak">Dicetak ' + waktu(new Date().toISOString()) + ' · ' + esc(o.app || 'SIBER-UJIAN') + '</p>';
    return { title: title, landscape: landscape, html: html };
  }

  return { build: build, esc: esc };
})();
