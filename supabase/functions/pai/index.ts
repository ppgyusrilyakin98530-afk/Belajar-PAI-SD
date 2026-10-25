// Edge Function "pai": engine soal dinamis + penilaian di server.
// Kunci jawaban tidak pernah dikirim ke klien sebelum siswa menjawab.
// verify_jwt dibiarkan aktif (default): siswa harus punya sesi (anonymous sign-in).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Daftar topik. Urutan harus sama dengan daftar di index.html (untuk label tombol).
const TOPIK: Record<number, string[]> = {
  1: ["Mengenal Allah dan Asmaul Husna", "Doa sehari-hari", "Rukun Islam", "Berbakti kepada orang tua", "Bersuci dan kebersihan"],
  2: ["Rukun Iman", "Salat lima waktu", "Jujur dan sopan santun", "Kisah masa kecil Nabi Muhammad saw.", "Doa makan dan doa tidur"],
  3: ["Asmaul Husna dalam kehidupan", "Tata cara wudu dan salat", "Hormat kepada guru dan teman", "Kisah Nabi Ibrahim a.s.", "Puasa Ramadan"],
  4: ["Perilaku amanah dan jujur dalam menggunakan teknologi", "Iman kepada malaikat Allah", "Zakat dan sedekah", "Kisah Nabi Yusuf a.s.", "Toleransi antarteman"],
  5: ["Iman kepada kitab-kitab Allah", "Salat berjamaah dan salat Jumat", "Menjaga lisan di media sosial", "Kisah Khulafaur Rasyidin", "Menghargai perbedaan"],
  6: ["Iman kepada qada dan qadar", "Ibadah haji dan umrah", "Adab bermedia digital dan anti-perundungan", "Kisah Walisongo", "Menjaga lingkungan sebagai amanah"],
};

const MAX_SOAL_PER_MENIT = 6;
const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function secretKey(): string {
  try {
    return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!)["default"];
  } catch {
    return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  }
}

const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: "unauthorized" }, 401);

    const b = await req.json();
    if (b.aksi === "profil") return await profil(user.id);
    if (b.aksi === "buat") return await buat(user.id, b);
    if (b.aksi === "jawab") return await jawab(user.id, b);
    return json({ error: "aksi tidak dikenal" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});

async function profil(uid: string) {
  const { data } = await admin.from("profiles").select("xp,streak,jawab,benar").eq("user_id", uid).maybeSingle();
  return json(data ?? { xp: 0, streak: 0, jawab: 0, benar: 0 });
}

async function buat(uid: string, b: { kelas: unknown; topik_idx: unknown }) {
  const kelas = Number(b.kelas);
  if (!Number.isInteger(kelas) || kelas < 1 || kelas > 6) return json({ error: "kelas tidak valid" }, 400);

  // Batas laju agar biaya API tidak membengkak.
  const sejak = new Date(Date.now() - 60_000).toISOString();
  const { count } = await admin.from("soal").select("id", { count: "exact", head: true })
    .eq("user_id", uid).gte("created_at", sejak);
  if ((count ?? 0) >= MAX_SOAL_PER_MENIT) return json({ error: "terlalu_cepat" }, 429);

  const daftar = TOPIK[kelas];
  const idx = Number(b.topik_idx);
  const topik = Number.isInteger(idx) && idx >= 0 && idx < daftar.length
    ? daftar[idx]
    : daftar[Math.floor(Math.random() * daftar.length)];

  const { data: prev } = await admin.from("soal").select("soal").eq("user_id", uid).eq("kelas", kelas)
    .order("created_at", { ascending: false }).limit(5);
  const hasil = await panggilClaude(kelas, topik, (prev ?? []).map((r) => String(r.soal).slice(0, 80)));

  // Jawaban benar ditulis model di posisi pertama. Server mengacak urutannya.
  const opsi = hasil.pilihan.map((t: string, i: number) => ({ t: t.replace(/^[A-Da-d][.)]\s*/, ""), ok: i === 0 }));
  for (let i = opsi.length - 1; i > 0; i--) {
    const r = Math.floor(Math.random() * (i + 1));
    [opsi[i], opsi[r]] = [opsi[r], opsi[i]];
  }
  const kode = `PAI-${kelas}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const pilihan = opsi.map((o: { t: string }) => o.t);

  const { data: row, error } = await admin.from("soal").insert({
    kode, user_id: uid, kelas, topik, soal: hasil.soal, pilihan,
    benar: opsi.findIndex((o: { ok: boolean }) => o.ok), pembahasan: hasil.pembahasan,
  }).select("id").single();
  if (error) throw error;

  return json({ soal_id: row.id, kode, kelas, topik, soal: hasil.soal, pilihan });
}

async function jawab(uid: string, b: { soal_id: unknown; pilihan: unknown }) {
  const p = Number(b.pilihan);
  if (!Number.isInteger(p) || p < 0 || p > 3) return json({ error: "pilihan tidak valid" }, 400);
  if (typeof b.soal_id !== "string" || !/^[0-9a-f-]{36}$/i.test(b.soal_id)) return json({ error: "soal_id tidak valid" }, 400);

  // Penandaan "dijawab" atomik: satu soal hanya bisa menghasilkan XP satu kali.
  const { data: row } = await admin.from("soal").update({ dijawab: true })
    .eq("id", b.soal_id).eq("user_id", uid).eq("dijawab", false)
    .select("benar,pembahasan").maybeSingle();
  if (!row) return json({ error: "sudah_dijawab_atau_tidak_ada" }, 409);

  const benar = p === row.benar;
  const { data, error } = await admin.rpc("catat_jawaban", { p_user: uid, p_benar: benar });
  if (error) throw error;
  const r = data[0];

  return json({
    benar, indeks_benar: row.benar, pembahasan: row.pembahasan, xp_tambah: r.xp_tambah,
    profil: { xp: r.total_xp, streak: r.streak_now, jawab: r.total_jawab, benar: r.total_benar },
  });
}

async function panggilClaude(kelas: number, topik: string, recent: string[]) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY belum diset");
  const tahun = new Date().getFullYear();
  const system = `Kamu adalah guru PAI (Pendidikan Agama Islam) dan perancang evaluasi SD mengacu pada Kurikulum Merdeka.
Buat 1 soal pilihan ganda atau soal cerita yang kontekstual, relevan dengan kehidupan anak zaman sekarang, dan mendidik.

<input_variabel>
- Kelas: ${kelas} (SD kelas 1 sampai 6)
- Topik/Materi: ${topik}
- Tahun saat ini: ${tahun}
- Kode variasi: ${crypto.randomUUID().slice(0, 6)}
</input_variabel>

<aturan>
1. Kelas 1-3: kalimat pendek, sederhana, situasi sehari-hari (bermain, jajan, di rumah). Kelas 4-6: studi kasus ringan, isu modern (internet, gadget, media sosial), analisis budi pekerti lebih dalam.
2. Konteks harus modern dan relevan dengan anak di tahun ${tahun}. Buat skenario baru, jangan klise.
3. Beri tepat 4 pilihan yang masuk akal dengan 1 jawaban benar mutlak. Hindari jawaban benar yang selalu paling panjang.
4. Tulis jawaban BENAR sebagai pilihan PERTAMA (sistem akan mengacak urutan). Jangan beri awalan huruf A, B, C, D.
5. Pembahasan singkat (maks 3 kalimat) berisi nilai moral/agama yang mudah dipahami siswa. Pastikan sesuai ajaran Islam arus utama; jika ragu, pilih konsep yang disepakati.
6. Jangan mengulang soal ini: ${recent.length ? recent.join(" | ") : "(belum ada)"}
</aturan>

<format_output>
Kembalikan HANYA JSON murni tanpa teks lain dan tanpa markdown:
{"soal":"...","pilihan":["jawaban benar","salah 1","salah 2","salah 3"],"pembahasan":"..."}
</format_output>`;

  for (let i = 0; i < 2; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: Deno.env.get("CLAUDE_MODEL") ?? "claude-haiku-5-5",
        max_tokens: 800,
        system,
        messages: [{ role: "user", content: "Buat 1 soal sekarang sesuai input variabel." }],
      }),
    });
    if (!r.ok) { console.error("anthropic", r.status, await r.text()); continue; }
    const d = await r.json();
    const txt: string = d.content?.find((c: { type: string }) => c.type === "text")?.text ?? "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try {
      const j = JSON.parse(m[0]);
      if (typeof j.soal === "string" && typeof j.pembahasan === "string" && Array.isArray(j.pilihan) &&
          j.pilihan.length === 4 && j.pilihan.every((x: unknown) => typeof x === "string")) return j;
    } catch { /* coba lagi */ }
  }
  throw new Error("Engine gagal membuat soal valid");
}
