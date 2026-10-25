-- Skema Belajar PAI SD.
-- Semua penulisan data dilakukan oleh Edge Function "pai" memakai secret key.
-- Klien hanya boleh membaca profilnya sendiri.

create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  xp         integer not null default 0 check (xp >= 0),
  streak     integer not null default 0 check (streak >= 0),
  jawab      integer not null default 0 check (jawab >= 0),
  benar      integer not null default 0 check (benar >= 0),
  updated_at timestamptz not null default now()
);

create table public.soal (
  id         uuid primary key default gen_random_uuid(),
  kode       text not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kelas      smallint not null check (kelas between 1 and 6),
  topik      text not null,
  soal       text not null,
  pilihan    jsonb not null,
  benar      smallint not null check (benar between 0 and 3),
  pembahasan text not null,
  dijawab    boolean not null default false,
  created_at timestamptz not null default now()
);

create index soal_user_created_idx on public.soal (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.soal enable row level security;

-- Profil: siswa hanya membaca miliknya sendiri. Tidak ada policy tulis.
grant select on public.profiles to authenticated;
create policy "profil: baca sendiri" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Soal menyimpan kunci jawaban, jadi tertutup untuk klien (tanpa grant, tanpa policy).
revoke all on public.soal from anon, authenticated;

grant all on public.profiles, public.soal to service_role;

-- Pencatatan jawaban atomik: XP, streak, dan jumlah jawab dihitung di sisi database.
create or replace function public.catat_jawaban(p_user uuid, p_benar boolean)
returns table (total_xp int, streak_now int, total_jawab int, total_benar int, xp_tambah int)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_streak int;
  v_tambah int;
begin
  insert into public.profiles (user_id) values (p_user) on conflict do nothing;

  select p.streak into v_streak from public.profiles p where p.user_id = p_user for update;

  v_tambah := case
    when p_benar then 10 + case when v_streak + 1 >= 3 then 5 else 0 end
    else 0
  end;

  return query
  update public.profiles p set
    jawab = p.jawab + 1,
    benar = p.benar + case when p_benar then 1 else 0 end,
    streak = case when p_benar then p.streak + 1 else 0 end,
    xp = p.xp + v_tambah,
    updated_at = now()
  where p.user_id = p_user
  returning p.xp, p.streak, p.jawab, p.benar, v_tambah;
end;
$$;

revoke execute on function public.catat_jawaban(uuid, boolean) from public, anon, authenticated;
grant execute on function public.catat_jawaban(uuid, boolean) to service_role;
