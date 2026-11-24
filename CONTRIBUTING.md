# Berkontribusi

Terima kasih sudah tertarik berkontribusi ke Juartah Upload!

## Alur

1. Buka issue dulu untuk perubahan besar, supaya arahnya disepakati sebelum mulai coding.
2. Fork repo, buat branch dari `main`.
3. Jalankan project di lokal mengikuti bagian [Mulai cepat](./README.md#mulai-cepat). Tidak perlu akun Google atau Cloudflare, cukup `npm run mock`.
4. Pastikan semua cek lolos sebelum membuat pull request:

   ```bash
   npm run typecheck
   npm test
   node dev/e2e.mjs    # dengan npm run mock dan npm run dev berjalan, database lokal kosong
   ```

5. Kalau mengubah skema database, tambahkan file baru di `migrations/` dengan nomor urut berikutnya. Jangan mengubah migrasi yang sudah ada.

## Panduan kode

- TypeScript strict.
- Teks yang terlihat user memakai Bahasa Indonesia yang ringkas dan mudah dipahami pembeli di HP.
- Ikuti arah desain di [DESIGN.md](./DESIGN.md): putih kertas, tinta hitam, satu aksen merah.
- Jangan menambah script atau font dari CDN pihak ketiga. CSP di `public/_headers` hanya mengizinkan Turnstile.
- Tulis komentar hanya untuk menjelaskan *alasan*, bukan mengulang apa yang dilakukan kode.
- Jangan pernah meng-commit secret, `.dev.vars`, atau file `client_secret*.json`.

## Melaporkan bug

Gunakan template **Laporan bug** saat membuat issue. Untuk celah keamanan, ikuti [SECURITY.md](./SECURITY.md).
