# Deploy ke Cloudflare

Contoh memakai `upload.domainanda.com`. Ganti sesuai domain Anda. Domain harus sudah ada di akun Cloudflare yang sama.

## 1. Google Cloud (sekali saja)

1. Buka https://console.cloud.google.com, buat project baru.
2. APIs & Services > Library > aktifkan **Google Drive API**.
3. Google Auth Platform / OAuth consent screen: tipe **External**, isi nama aplikasi dan email.
   Scope: `openid`, `email`, dan `.../auth/drive.file`.
4. Audience > **Publish app** sampai status **In production**. Status Testing membuat Drive putus tiap 7 hari.
5. Clients > Create client > **Web application**. Authorized redirect URI:
   `https://upload.domainanda.com/auth/callback`
6. Simpan Client ID dan Client secret untuk langkah 3.

## 2. Turnstile (anti-bot, opsional)

Dashboard Cloudflare > Turnstile > Add widget, hostname `upload.domainanda.com`, mode Managed. Simpan site key dan secret key.

Site key (`TURNSTILE_SITE_KEY`) dan secret (`TURNSTILE_SECRET`) harus dipasang berpasangan. Kalau hanya secret yang diisi, semua upload akan ditolak.

## 3. Konfigurasi dan deploy

`wrangler.jsonc` di repo ini berisi konfigurasi produksi Juartah Printing. Untuk instalasi Anda sendiri, ubah:

| Kunci | Isi |
|---|---|
| `account_id` | ID akun Cloudflare Anda, atau hapus baris ini dan pakai `wrangler login` |
| `name`, `d1_databases[0].database_name` | Nama Worker dan database Anda |
| `d1_databases[0].database_id` | Hasil `wrangler d1 create` di bawah |
| `routes` | Domain Anda |
| `vars.APP_URL` | `https://upload.domainanda.com` |
| `vars.TURNSTILE_SITE_KEY` | Site key Turnstile, bila dipakai |

```bash
npx wrangler login
npx wrangler d1 create juartah-upload     # salin database_id ke wrangler.jsonc
```

Lalu isi rahasia satu per satu. Nilai diketik saat diminta, jangan ditulis di file:

```bash
npx wrangler secret put SESSION_SECRET         # hasil: openssl rand -base64 48
npx wrangler secret put OWNER_EMAILS           # email Google pemilik, pisahkan koma bila lebih dari satu
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TURNSTILE_SECRET       # opsional
npm run db:remote
npm run deploy
```

## 4. Sambungkan Drive

Buka `https://upload.domainanda.com/admin/`, masuk dengan email pemilik, lalu **Sambungkan Drive** dan setujui akses file. Coba kirim satu file dari HP.

Ganti juga identitas toko sebelum dipakai: logo di `public/`, nama toko dan link toko di `src/web/upload.tsx`, serta isi `src/web/privasi/index.html`. Nama toko yang tampil di halaman bisa diubah dari menu Pengaturan di dashboard.

## Deploy otomatis (GitHub Actions)

Setiap push ke `main` menjalankan `.github/workflows/deploy.yml`: cek tipe, uji unit, build, migrasi D1, lalu `wrangler deploy`. Pull request hanya diuji, tidak di-deploy. Perubahan yang hanya menyentuh dokumentasi tidak memicu deploy.

Isi sekali di GitHub, Settings > Secrets and variables > Actions:

- Secret `CLOUDFLARE_API_TOKEN`: buat di Cloudflare, My Profile > API Tokens > Create Token, template **Edit Cloudflare Workers**, lalu tambah izin **Account > D1 > Edit**. Batasi ke akun dan zona domain Anda.

Rahasia aplikasi (`SESSION_SECRET`, `GOOGLE_CLIENT_*`, `OWNER_EMAILS`, `TURNSTILE_SECRET`) tetap di Cloudflare dan tidak ikut terhapus saat deploy.
