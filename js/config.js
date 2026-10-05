/**
 * SIBER-UJIAN — config.js
 * Pengaturan aplikasi siswa dan guru.
 * JANGAN menaruh password, token, kunci jawaban, atau data rahasia di sini.
 *
 * URL API sekarang disimpan di file terpisah: js/api-url.js
 * (dibuat sekali oleh admin; tidak ikut tertimpa saat aplikasi diperbarui).
 *
 * ATURAN: setiap kali mengubah file APA PUN di GitHub, naikkan CLIENT_VERSION.
 */
const SIBER_CONFIG = {
  // Diambil dari js/api-url.js. Jangan diubah di sini.
  API_URL: (typeof SIBER_API_URL !== 'undefined' && SIBER_API_URL) ? SIBER_API_URL : '',

  // Batas waktu tunggu respons server (milidetik). 45000 = 45 detik (dicoba ulang 1x untuk permintaan baca).
  REQUEST_TIMEOUT_MS: 45000,

  // Login offline hanya diizinkan maksimal sekian hari sejak login online terakhir.
  OFFLINE_LOGIN_MAX_DAYS: 30,

  // Kekuatan "sidik jari" password di perangkat. Jangan diturunkan.
  LOCAL_PBKDF2_ITERATIONS: 100000,

  // Mode FIXED: waktu total = jumlah soal x waktu per soal, ditambah persen ini.
  // HARUS sama dengan FIXED_EXTRA_PERCENT di Exams.gs (server).
  FIXED_EXTRA_PERCENT: 5,

  // Anti-kecurangan: catat setiap kali siswa keluar dari layar ujian.
  ANTI_CHEAT: true,

  // Minta layar penuh saat ujian dimulai; keluar dari layar penuh dicatat sebagai pelanggaran.
  FULLSCREEN: true,

  // Saat online, aplikasi siswa melapor ke guru dan mengambil pesan setiap sekian milidetik.
  HEARTBEAT_MS: 45000,

  // true HANYA saat pengujian: menampilkan "Panel debug".
  DEBUG: false,

  // true HANYA saat pengujian: menampilkan tombol "Hapus semua data lokal".
  ALLOW_LOCAL_WIPE: false,

  // Versi aplikasi (naikkan setiap ada perubahan file)
  CLIENT_VERSION: '3.0.1'
};
