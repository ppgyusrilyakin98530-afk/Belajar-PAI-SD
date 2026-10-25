# Belajar PAI SD (Supabase + Claude)

Soal dibuat dinamis oleh Edge Function `pai` lewat API Claude. Kunci jawaban dan penilaian ada di server. XP, level, dan streak tersimpan di database.

## Isi
- `supabase/migrations/20261025000000_pai.sql`: tabel `profiles`, `soal`, fungsi `catat_jawaban`, RLS.
- `supabase/functions/pai/index.ts`: engine soal dan penilai.
- `index.html`: antarmuka siswa.

## Pasang
1. Buat proyek Supabase. Di Authentication > Sign In / Providers, aktifkan **Anonymous sign-ins**. Sangat disarankan aktifkan CAPTCHA agar bot tidak membuat akun anonim massal.
2. Terapkan skema: `supabase link --project-ref <ref>` lalu `supabase db push`.
3. Simpan API key Claude sebagai secret: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`
4. Opsional: `supabase secrets set ALLOWED_ORIGIN=https://domain-kamu.id` (membatasi CORS) dan `CLAUDE_MODEL=claude-haiku-5-5`.
5. Deploy fungsi: `supabase functions deploy pai` (biarkan verify_jwt aktif).
6. Isi `SUPABASE_URL` dan `SUPABASE_KEY` (publishable key) di `index.html`, lalu hosting file itu di mana saja (Netlify, Vercel, GitHub Pages, atau Supabase Storage).
7. Jalankan Advisors di dashboard dan pastikan tidak ada peringatan RLS.

## Catatan
- Batas laju: 6 soal per menit per siswa (`MAX_SOAL_PER_MENIT` di fungsi).
- Akun anonim terikat ke browser. Jika data dihapus, progres hilang. Untuk akun permanen, tautkan email atau Google ke akun anonim (`updateUser` / `linkIdentity`).
- Daftar topik ada di dua tempat (fungsi dan `index.html`). Ubah keduanya bersamaan.
- Soal dibuat AI. Minta guru PAI mengecek sampel sebelum dipakai di kelas.
