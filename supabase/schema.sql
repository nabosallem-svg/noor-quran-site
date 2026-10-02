-- مقرأة الإتقان: قاعدة البيانات على Supabase
-- Run this whole file once in Supabase → SQL Editor. It is safe to run again.
--
-- Visitors (the anon key) never touch the tables directly. They can only call the
-- public functions below, which check the input and return the minimum data.
-- The teacher signs in to admin.html and, once listed in public.admins, can read
-- and change everything.

-- ───────────────────────── Tables ─────────────────────────

create table if not exists public.admins (
  user_id    uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id              int primary key default 1 check (id = 1),
  slot_times      text[] not null default '{08:00,09:30,11:00,14:00,16:00,17:30,19:00,20:30}',
  days_ahead      int    not null default 14 check (days_ahead between 1 and 60),
  closed_weekdays int[]  not null default '{}',  -- 0 = Sunday … 6 = Saturday
  updated_at      timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

-- A closed slot, or a whole closed day when slot_time = '*'
create table if not exists public.blocked_slots (
  slot_date date not null,
  slot_time text not null default '*',
  primary key (slot_date, slot_time)
);

create table if not exists public.bookings (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  slot_date  date not null,
  slot_time  text not null,
  name       text not null check (char_length(name) between 2 and 80),
  phone      text not null check (char_length(phone) between 8 and 20),
  age        text check (char_length(age) <= 20),
  country    text check (char_length(country) <= 40),
  program    text check (char_length(program) <= 80),
  status     text not null default 'new' check (status in ('new', 'confirmed', 'done', 'cancelled')),
  seen       boolean not null default false,
  notes      text
);
-- The heart of "no double booking": one live booking per slot.
create unique index if not exists bookings_one_per_slot
  on public.bookings (slot_date, slot_time) where status <> 'cancelled';

create table if not exists public.students (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  code          text not null unique,
  name          text not null,
  phone         text,
  track         text,
  teacher       text not null default 'معلم المقرأة',
  progress      int  not null default 0 check (progress between 0 and 100),
  sessions_done int  not null default 0 check (sessions_done >= 0),
  new_task      text,
  recent_review text,
  far_review    text,
  teacher_note  text,
  next_session  timestamptz,
  active        boolean not null default true,
  booking_id    bigint references public.bookings on delete set null
);

create table if not exists public.payments (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  name         text not null check (char_length(name) between 2 and 80),
  phone        text not null check (char_length(phone) between 8 and 20),
  plan         text check (char_length(plan) <= 80),
  method       text check (char_length(method) <= 40),
  receipt_path text check (char_length(receipt_path) <= 200),
  status       text not null default 'new' check (status in ('new', 'verified', 'rejected')),
  seen         boolean not null default false
);

create table if not exists public.level_tests (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name       text not null check (char_length(name) between 2 and 80),
  phone      text not null check (char_length(phone) between 8 and 20),
  age_group  text check (char_length(age_group) <= 80),
  memorized  text check (char_length(memorized) <= 80),
  tajweed    text check (char_length(tajweed) <= 80),
  timezone   text check (char_length(timezone) <= 80),
  period     text check (char_length(period) <= 80),
  audio_path text check (char_length(audio_path) <= 200),
  seen       boolean not null default false
);

-- ───────────────────────── Admin access ─────────────────────────

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

do $$
declare t text;
begin
  foreach t in array array['admins','settings','blocked_slots','bookings','students','payments','level_tests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ───────────────────────── Public functions ─────────────────────────

-- "Now" on the clock the site shows (Mecca time)
create or replace function public._site_now() returns timestamp
language sql stable as $$ select now() at time zone 'Asia/Riyadh' $$;

create or replace function public._clean_phone(p text) returns text
language sql immutable as $$ select left(regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g'), 20) $$;

-- Opening hours, for the booking page
create or replace function public.public_settings() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('slot_times', slot_times, 'days_ahead', days_ahead, 'closed_weekdays', closed_weekdays)
  from public.settings where id = 1;
$$;

-- Which slots are gone (booked or closed). Dates and times only, no names.
create or replace function public.taken_slots(d_from date, d_to date)
returns table (slot_date date, slot_time text)
language sql stable security definer set search_path = public as $$
  select b.slot_date, b.slot_time from public.bookings b
   where b.status <> 'cancelled' and b.slot_date between d_from and least(d_to, d_from + 62)
  union
  select s.slot_date, s.slot_time from public.blocked_slots s
   where s.slot_date between d_from and least(d_to, d_from + 62);
$$;

create or replace function public.book_slot(
  p_date date, p_time text, p_name text, p_phone text,
  p_age text default null, p_country text default null, p_program text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  cfg public.settings;
  new_id bigint;
begin
  select * into cfg from public.settings where id = 1;
  if p_time is null or not (p_time = any (cfg.slot_times)) then
    raise exception 'BAD_SLOT' using errcode = 'P0001';
  end if;
  if p_date < (public._site_now())::date or p_date > (public._site_now())::date + cfg.days_ahead
     or (p_date + p_time::time) <= public._site_now()
     or extract(dow from p_date)::int = any (cfg.closed_weekdays) then
    raise exception 'BAD_SLOT' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.blocked_slots where slot_date = p_date and slot_time in ('*', p_time)) then
    raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end if;
  begin
    insert into public.bookings (slot_date, slot_time, name, phone, age, country, program)
    values (p_date, p_time, btrim(p_name), public._clean_phone(p_phone),
            nullif(btrim(p_age), ''), nullif(btrim(p_country), ''), nullif(btrim(p_program), ''))
    returning id into new_id;
  exception when unique_violation then
    raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end;
  return json_build_object('id', new_id);
end $$;

-- What a student sees after typing their code. No phone numbers.
create or replace function public.student_by_code(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'code', code, 'name', name, 'track', track, 'teacher', teacher, 'progress', progress,
    'sessions_done', sessions_done, 'new_task', new_task, 'recent_review', recent_review,
    'far_review', far_review, 'teacher_note', teacher_note, 'next_session', next_session)
  from public.students
  where code = upper(btrim(p_code)) and active;
$$;

create or replace function public.submit_payment(
  p_name text, p_phone text, p_plan text, p_method text, p_receipt_path text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  if p_receipt_path is not null and p_receipt_path !~ '^receipts/[A-Za-z0-9._-]+$' then
    p_receipt_path := null;
  end if;
  insert into public.payments (name, phone, plan, method, receipt_path)
  values (btrim(p_name), public._clean_phone(p_phone), p_plan, p_method, p_receipt_path)
  returning id into new_id;
  return json_build_object('id', new_id);
end $$;

create or replace function public.submit_level_test(
  p_name text, p_phone text, p_age_group text, p_memorized text, p_tajweed text,
  p_timezone text, p_period text, p_audio_path text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  if p_audio_path is not null and p_audio_path !~ '^recitations/[A-Za-z0-9._-]+$' then
    p_audio_path := null;
  end if;
  insert into public.level_tests (name, phone, age_group, memorized, tajweed, timezone, period, audio_path)
  values (btrim(p_name), public._clean_phone(p_phone), p_age_group, p_memorized, p_tajweed, p_timezone, p_period, p_audio_path)
  returning id into new_id;
  return json_build_object('id', new_id);
end $$;

-- A short student code that is easy to read out: ITQ-7K3M9P
create or replace function public.new_student_code() returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  abc text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  r bytea;
  c text;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  loop
    r := uuid_send(gen_random_uuid());
    select 'ITQ-' || string_agg(substr(abc, 1 + (get_byte(r, i) % length(abc)), 1), '' order by i)
      into c from generate_series(0, 5) i;
    exit when not exists (select 1 from public.students where code = c);
  end loop;
  return c;
end $$;

-- Who may call what
revoke execute on all functions in schema public from public, anon;
grant execute on function public.public_settings() to anon, authenticated;
grant execute on function public.taken_slots(date, date) to anon, authenticated;
grant execute on function public.book_slot(date, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.student_by_code(text) to anon, authenticated;
grant execute on function public.submit_payment(text, text, text, text, text) to anon, authenticated;
grant execute on function public.submit_level_test(text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.new_student_code() to authenticated;

-- ───────────────────────── Uploads (receipts, recitations) ─────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uploads', 'uploads', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf',
              'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav'])
on conflict (id) do nothing;

drop policy if exists uploads_anyone_adds on storage.objects;
create policy uploads_anyone_adds on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] in ('receipts', 'recitations'));

drop policy if exists uploads_admin_reads on storage.objects;
create policy uploads_admin_reads on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and public.is_admin());

drop policy if exists uploads_admin_deletes on storage.objects;
create policy uploads_admin_deletes on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and public.is_admin());
