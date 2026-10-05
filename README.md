# SIBER-UJIAN v3.0.0

Sistem ujian pilihan ganda sekolah yang tetap berjalan tanpa internet, dengan tampilan game 2D bersuara.

- Frontend: GitHub Pages (HTML, CSS, JavaScript murni) + PWA (bisa dipasang & offline)
- Penyimpanan di HP siswa: IndexedDB
- Backend: Google Apps Script Web App, database: Google Sheets

## Yang baru di versi 3
| Fitur | Keterangan |
|---|---|
| Tampilan game 2D | Langit, awan bergerak, bukit, papan kayu, tombol 3D, pilihan A–D berwarna. Font tersimpan di aplikasi (tetap tampil offline). |
| Efek suara | Klik, pilih jawaban, pindah soal, alarm waktu menipis, detak 10 detik terakhir, pelanggaran, pesan guru, selesai (fanfare + konfeti). Tombol 🔊 untuk mematikan. |
| Ragu-ragu | Mode TOTAL & FIXED: tandai soal ragu-ragu (kotak kuning), ditampilkan saat konfirmasi selesai. |
| Koreksi nilai | Dashboard → Hasil & nilai → Detail: ✔ anggap benar, ✘ anggap salah, ↺ kembali otomatis. Nilai dihitung ulang. |
| Nilai ulang | Jika kunci salah: betulkan ANSWER_KEY di sheet QUESTIONS, lalu tekan "♻️ Nilai ulang". Koreksi manual guru tidak diubah. |
| Hapus kiriman (ujian ulang) | Detail → 🗑️ Hapus kiriman. Salinannya dicatat di sheet RESET_LOG. Siswa menekan "Perbarui daftar" lalu bisa mengerjakan ulang. |
| Tab Siswa & HP | Kesiapan per kelas, login terakhir tiap siswa (online/offline) dan HP-nya, daftar HP, ujian sudah terunduh/versi lama, jawaban tertahan di HP. |
| Laporan PDF | Rekap 1 ujian, lembar jawaban per siswa, analisis butir soal (kesukaran & daya beda), rekap semua ujian per kelas, rekap per mapel, riwayat nilai 1 siswa. Dengan KKM, peringkat, kop, tanda tangan. |
| Tab Token | Lihat status token, buat token baru, nonaktifkan/aktifkan token langsung dari dashboard. |

Semua fitur lama tetap ada: 3 mode waktu, token offline terenkripsi, pelanggaran & layar penuh, pantauan langsung, pesan ke layar siswa, analisis soal, ekspor Excel/CSV/cetak.

## Pengaturan sekali saja
File `js/api-url.js` berisi URL Web App:

    const SIBER_API_URL = 'https://script.google.com/macros/s/XXXX/exec';

## Aturan pemeliharaan
1. Setiap mengubah file di GitHub, naikkan `CLIENT_VERSION` di `js/config.js`.
2. Setiap mengubah soal/kunci/gambar, naikkan `VERSION` ujian di sheet EXAMS (jika kunci salah setelah ujian, cukup pakai tombol "Nilai ulang").
3. Buat token sebelum siswa mengunduh soal.
4. Jangan pernah mengunggah kunci jawaban, password, atau file spreadsheet ke repository ini.
5. Setelah mengubah kode Apps Script: Terapkan → Kelola deployment → Versi baru.

## Masalah umum
| Masalah | Solusi |
|---|---|
| Tab baru: "Server belum diperbarui" | Pasang Fitur.gs + Code.gs baru, jalankan `setupFiturV3`, lalu Kelola deployment → Versi baru. |
| Tab laporan tidak terbuka | Izinkan pop-up untuk situs ini (ikon di ujung kanan bilah alamat). |
| Siswa & HP kosong | HP baru melapor setelah memakai aplikasi versi 3 dalam keadaan online. |
| Siswa belum bisa ujian ulang | Siswa harus online lalu menekan "Perbarui daftar". Jika bertoken, perlu token yang masih berlaku. |
| Tidak ada suara | Tekan 🔊; pastikan HP tidak dalam mode senyap. |
