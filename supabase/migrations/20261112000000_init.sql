-- Tree Mapper: 初期スキーマ (Supabase / Postgres)
--
-- 方針
--   * 共有の単位は「メンバー全員が同じデータを共有」。メンバー = members テーブルに載っているメール
--   * 匿名ユーザー・メンバー外のログインユーザーは、一切読み書きできない (RLS)
--   * 物理削除は禁止。削除は deleted_at を入れる論理削除 (DELETE 権限を渡さない)
--   * ID は text。アプリが採番する UUID 形式 (pin_xxx 等) と、旧版の ID (Date.now() 形式) の両方をそのまま保存できる
--   * updated_at / updated_by はサーバー側のトリガーが入れる (端末の時計に依存しない)
--
-- 適用方法: Supabase ダッシュボードの SQL Editor に、このファイル全体を貼り付けて実行する。
-- 実行後、必ず supabase/README.md の「メンバーの追加」を行うこと (追加するまで誰もデータにアクセスできない)。

-- ---------------------------------------------------------------------------
-- メンバー (許可メール一覧)
-- ---------------------------------------------------------------------------
create table members (
  email text primary key check (email = lower(email))   -- 小文字で登録する
);

-- メンバー判定。ログイン中ユーザーのメールが members にあれば true。
-- security definer にして、members 自体はクライアントから直接読めないようにしている。
create function is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------------------------------------------------------------------------
-- データテーブル
-- ---------------------------------------------------------------------------
create table maps (
  id         text primary key,
  name       text not null,
  image_path text,                                         -- Storage (map-images) 上のパス
  created_at timestamptz not null default now(),           -- 移行時は元の createdAt を入れる
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_by uuid default auth.uid(),
  updated_by uuid
);

create table pins (
  id         text primary key,
  map_id     text not null references maps (id),
  x          double precision not null,
  y          double precision not null,
  group_name text not null default 'デフォルト',
  species    text not null,
  label      text not null default '',
  photo_path text,                                         -- Storage (pin-photos) 上のパス
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_by uuid default auth.uid(),
  updated_by uuid
);
create index pins_map_id_idx on pins (map_id);

create table areas (
  id         text primary key,
  map_id     text not null references maps (id),
  type       text not null check (type in ('line', 'polygon')),
  points     jsonb not null,                               -- [{"x":..,"y":..}, ...]
  group_name text not null default 'デフォルト',
  label      text not null default '',
  color      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_by uuid default auth.uid(),
  updated_by uuid
);
create index areas_map_id_idx on areas (map_id);

-- 共有設定 (旧 localStorage: customSpecies / speciesColors / customGroups)
-- 個人設定 (hiddenGroups / activeMapId) はこれまで通り端末に残すので、ここには置かない。
create table species (
  name       text primary key,
  color      text not null unique,                         -- 色の重複を DB 側でも防ぐ
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table groups (
  name       text primary key,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

-- 組み込みの樹種の色 (src/main.js の speciesColors の初期値と同じ。名前はコード上の値)。
-- 後から追加される樹種が、これらと同じ色を取れないようにするために登録しておく。
insert into species (name, color) values
  ('shirakashi', '#10b981'),
  ('keyaki',     '#f59e0b');

-- ---------------------------------------------------------------------------
-- updated_at / updated_by をサーバー側で更新するトリガー
-- ---------------------------------------------------------------------------
create function set_updated()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger maps_set_updated  before insert or update on maps  for each row execute function set_updated();
create trigger pins_set_updated  before insert or update on pins  for each row execute function set_updated();
create trigger areas_set_updated before insert or update on areas for each row execute function set_updated();

-- ---------------------------------------------------------------------------
-- マップの論理削除 (配下のピン・エリアも同じトランザクションで削除)
-- ---------------------------------------------------------------------------
-- security invoker (既定) なので、呼んだ人の RLS がそのまま適用される。
create function delete_map(p_id text)
returns void
language sql
as $$
  update pins  set deleted_at = now() where map_id = p_id and deleted_at is null;
  update areas set deleted_at = now() where map_id = p_id and deleted_at is null;
  update maps  set deleted_at = now() where id     = p_id and deleted_at is null;
$$;

-- ---------------------------------------------------------------------------
-- 権限 (Row Level Security)
-- ---------------------------------------------------------------------------
alter table members enable row level security;   -- ポリシーを作らない = API からは一切見えない
alter table maps    enable row level security;
alter table pins    enable row level security;
alter table areas   enable row level security;
alter table species enable row level security;
alter table groups  enable row level security;

-- まず全員から権限を外し、必要なものだけ authenticated に付け直す。
revoke all on members, maps, pins, areas, species, groups from anon, authenticated;
revoke all on function is_member(), delete_map(text) from public, anon;

-- 読み書きできるのはメンバーだけ。DELETE 権限は付けない (論理削除のみ)。
grant select, insert, update on maps, pins, areas to authenticated;
grant select, insert on species, groups to authenticated;
grant execute on function is_member(), delete_map(text) to authenticated;

create policy member_select on maps  for select to authenticated using (is_member());
create policy member_insert on maps  for insert to authenticated with check (is_member());
create policy member_update on maps  for update to authenticated using (is_member()) with check (is_member());

create policy member_select on pins  for select to authenticated using (is_member());
create policy member_insert on pins  for insert to authenticated with check (is_member());
create policy member_update on pins  for update to authenticated using (is_member()) with check (is_member());

create policy member_select on areas for select to authenticated using (is_member());
create policy member_insert on areas for insert to authenticated with check (is_member());
create policy member_update on areas for update to authenticated using (is_member()) with check (is_member());

create policy member_select on species for select to authenticated using (is_member());
create policy member_insert on species for insert to authenticated with check (is_member());

create policy member_select on groups  for select to authenticated using (is_member());
create policy member_insert on groups  for insert to authenticated with check (is_member());

-- ---------------------------------------------------------------------------
-- Realtime (他の人の変更を受け取る対象)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table maps, pins, areas, species, groups;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage (画像)。どちらも非公開バケット。メンバーだけが読み書きできる
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('map-images', 'map-images', false),
       ('pin-photos', 'pin-photos', false)
on conflict (id) do nothing;

create policy "member read images" on storage.objects
  for select to authenticated
  using (bucket_id in ('map-images', 'pin-photos') and is_member());

create policy "member upload images" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('map-images', 'pin-photos') and is_member());

create policy "member update images" on storage.objects
  for update to authenticated
  using (bucket_id in ('map-images', 'pin-photos') and is_member());

-- 論理削除したレコードの画像を片付けられるよう、画像ファイルの削除だけは許可する
create policy "member delete images" on storage.objects
  for delete to authenticated
  using (bucket_id in ('map-images', 'pin-photos') and is_member());
