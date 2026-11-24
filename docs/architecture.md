# Arsitektur

Satu Cloudflare Worker melayani halaman statis (hasil build Vite) sekaligus API. Data pesanan ada di D1, isi file di Google Drive milik toko.

```
Browser pelanggan ──┐                     ┌── D1: pesanan, catatan, metadata file, sesi, pengaturan
                    ├── Worker (Hono) ────┤
Browser admin ──────┘                     └── Google Drive: satu folder per pesanan + CATATAN.txt
```

## Struktur folder

| Path | Isi |
|---|---|
| `src/worker/index.ts` | Entry Worker, header keamanan, penanganan error Drive, pemicu perawatan berkala |
| `src/worker/public.ts` | API pelanggan: `/api/config`, `/api/status`, `/api/start`, `/api/files`, `/api/finish` |
| `src/worker/admin.ts` | API dashboard di `/api/admin/*`: pesanan, file, pengaturan, staf |
| `src/worker/auth.ts` | Login Google, sambungkan Drive, sesi admin, peran pemilik dan staf |
| `src/worker/drive.ts` | Klien Google Drive: token, folder, resumable upload, Trash |
| `src/worker/cron.ts` | Perawatan berkala: sesi kedaluwarsa, upload macet, sinkron catatan, auto-Trash |
| `src/worker/crypto.ts` | Token bertanda tangan HMAC dan enkripsi AES-GCM untuk token Google |
| `src/shared.ts` | Konstanta dan helper yang dipakai Worker dan frontend (status, jenis file, nomor pesanan) |
| `src/web/` | Frontend Preact: halaman upload, `admin/`, `privasi/` |
| `migrations/` | Skema D1 |
| `public/` | Aset statis, header CSP (`_headers`), ikon |
| `dev/` | Server Google tiruan dan skrip E2E |
| `test/` | Uji unit Vitest |

## Alur upload

1. Pelanggan mengirim nomor pesanan ke `POST /api/start` (rate limit, Turnstile bila aktif). Worker membuat atau memakai pesanan yang ada lalu mengembalikan token pesanan bertanda tangan yang berlaku 30 hari.
2. Untuk tiap file, `POST /api/files` mendaftarkan nama, ukuran, dan catatan. Worker membuka sesi resumable upload di Drive. File dengan nama, ukuran, dan waktu ubah yang sama dianggap file yang sama, jadi tidak terkirim dobel.
3. Browser mengirim potongan 4 MB lewat `PUT /api/files/:id` dengan header `Content-Range`. Worker meneruskan potongan itu ke Drive. Kalau koneksi putus, `GET /api/files/:id` memberi offset terakhir untuk dilanjutkan. Sesi Drive yang kedaluwarsa dibuat ulang otomatis.
4. `POST /api/finish` menutup pengiriman dan menandai pesanan punya file baru.

File tidak pernah disimpan di Cloudflare. Worker hanya meneruskan potongan ke Drive.

## Akses dan peran

- **Pemilik:** email di secret `OWNER_EMAILS`. Bisa menyambungkan Drive, mengubah pengaturan, dan mengatur staf.
- **Staf:** ditambahkan pemilik dari dashboard, masuk dengan akun Google. Izin hapus file diberikan per staf.
- **Pelanggan:** tanpa akun. Siapa pun yang tahu nomor pesanan bisa melihat status, pesan revisi, dan jumlah file, serta menambah file. Isi dan nama file tidak terlihat.

## Perawatan berkala

Akun Cloudflare gratis dibatasi 5 cron per akun. Karena itu `wrangler.jsonc` tidak memakai cron, dan perawatan menumpang permintaan yang masuk, paling sering sekali per jam, diklaim lewat D1 supaya tidak jalan dobel. Handler `scheduled` tetap ada, jadi di akun Workers Paid cukup tambahkan `"triggers": { "crons": ["17 * * * *"] }`.

Yang dikerjakan:
- hapus sesi admin kedaluwarsa,
- hapus upload yang tidak selesai setelah 8 hari,
- tulis ulang `CATATAN.txt` di folder pesanan yang catatannya berubah,
- pindahkan folder pesanan kosong ke Trash setelah 9 hari,
- pindahkan pesanan berstatus Selesai ke Trash setelah jumlah hari di pengaturan (bila diaktifkan).

## Hal yang perlu diketahui

- Scope Drive hanya `drive.file`. File yang Anda taruh manual di folder tidak terlihat oleh aplikasi.
- Folder di Drive boleh dipindah. Kalau folder pesanan dihapus, folder baru dibuat saat ada upload berikutnya.
- `SESSION_SECRET` juga dipakai untuk mengenkripsi token Drive. Kalau diganti, Drive harus disambungkan ulang.
- Jenis file yang diterima diatur di `ALLOWED_EXT` pada `src/shared.ts`.
- Validasi nomor pesanan memakai pola Shopee (`looksLikeShopee`). Untuk marketplace lain, sesuaikan fungsi itu dan teks di halaman upload.
