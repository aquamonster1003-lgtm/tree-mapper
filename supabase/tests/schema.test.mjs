// supabase/migrations の SQL を PGlite (ローカルで動く Postgres) で実行し、権限と制約を検証する。
// ※ 本物の Supabase ではなく代用環境での検証。本番に適用したら supabase/README.md の「動作確認」も行うこと。
// Supabase 固有の部分 (auth.jwt / auth.uid / storage / publication / roles) は最小の代用品で再現する。
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 使い方: npm i --no-save @electric-sql/pglite && node supabase/tests/schema.test.mjs [マイグレーションのパス]
// 引数なしなら supabase/migrations の中で一番新しいファイルを検証する
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const latest = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort().pop();
const migration = fs.readFileSync(process.argv[2] ?? path.join(migrationsDir, latest), 'utf8');
const db = new PGlite();

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

// --- Supabase の代用品 ---
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on all functions in schema auth to anon, authenticated;

  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean default false);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;

  create publication supabase_realtime;
  grant usage on schema public to anon, authenticated;

  -- 本物の Supabase は、public に作ったテーブル・関数に anon/authenticated の権限を自動付与する
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`);

// --- 本番と同じ手順で、マイグレーションを実行 ---
try {
  await db.exec(migration);
  check('マイグレーションがエラーなく実行できる', true);
} catch (e) {
  check('マイグレーションがエラーなく実行できる', false, e.message);
  process.exit(1);
}

const UID_MEMBER = '11111111-1111-4111-8111-111111111111';
const UID_OUTSIDER = '22222222-2222-4222-8222-222222222222';

async function as(role, claims, fn) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const member = (fn) => as('authenticated', { sub: UID_MEMBER, email: 'Member@Example.com' }, fn); // 大文字混じり
const outsider = (fn) => as('authenticated', { sub: UID_OUTSIDER, email: 'outsider@example.com' }, fn);
const anon = (fn) => as('anon', null, fn);
const admin = (fn) => as('postgres', null, fn);
const fails = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

await admin(() => db.query(`insert into members (email) values ('member@example.com')`));

console.log('\n[メンバー表]');
check('メール大文字は members に登録できない', !!(await fails(admin(() => db.query(`insert into members values ('Bad@Example.com')`)))));
check('メンバーでも members を直接読めない', !!(await fails(member(() => db.query(`select * from members`)))));
check('メンバー外は members を直接読めない', !!(await fails(outsider(() => db.query(`select * from members`)))));

console.log('\n[メンバー: 読み書き]');
await member(() => db.query(`insert into maps (id, name, created_at) values ('map_1', 'テスト', '2023-11-14T00:00:00Z')`));
let m = (await admin(() => db.query(`select * from maps where id='map_1'`))).rows[0];
check('マップを追加できる (JWTのメールが大文字でも判定される)', !!m);
check('移行用: created_at を指定した値のまま保存できる', new Date(m.created_at).toISOString() === '2023-11-14T00:00:00.000Z', String(m.created_at));
check('updated_by に自分のIDがサーバー側で入る', m.updated_by === UID_MEMBER && m.created_by === UID_MEMBER);

await member(() => db.query(`insert into pins (id, map_id, x, y, species) values ('pin_1', 'map_1', 10, 20, 'keyaki')`));
await member(() => db.query(`insert into pins (id, map_id, x, y, species, group_name, label) values ('1700000000001', 'map_1', 1, 2, 'sakura', 'A', 'legacy')`));
check('旧形式のID (Date.now形式) のピンも保存できる', (await admin(() => db.query(`select 1 from pins where id='1700000000001'`))).rows.length === 1);
let p = (await admin(() => db.query(`select * from pins where id='pin_1'`))).rows[0];
check('group_name / label の既定値', p.group_name === 'デフォルト' && p.label === '');

await member(() => db.query(`insert into areas (id, map_id, type, points, color) values ('area_1', 'map_1', 'line', '[{"x":1,"y":2},{"x":3,"y":4}]', '#22c55e')`));
check('エリアを追加できる (points は jsonb)', (await admin(() => db.query(`select jsonb_array_length(points) n from areas where id='area_1'`))).rows[0].n === 2);
check('エリアの type は line / polygon のみ', !!(await fails(member(() => db.query(`insert into areas (id, map_id, type, points, color) values ('area_x','map_1','circle','[]','#000')`)))));
check('存在しないマップへのピンは追加できない (外部キー)', !!(await fails(member(() => db.query(`insert into pins (id, map_id, x, y, species) values ('pin_x','nope',0,0,'a')`)))));

await new Promise(r => setTimeout(r, 30));
const before = (await admin(() => db.query(`select updated_at from pins where id='pin_1'`))).rows[0].updated_at;
await member(() => db.query(`update pins set label='edited' where id='pin_1'`));
const after = (await admin(() => db.query(`select updated_at, updated_by, label from pins where id='pin_1'`))).rows[0];
check('編集すると updated_at がサーバー側で進む', new Date(after.updated_at) > new Date(before) && after.label === 'edited');

console.log('\n[共有設定: 樹種・グループ]');
await member(() => db.query(`insert into species (name, color) values ('sakura', '#ec4899')`));
await member(() => db.query(`insert into groups (name) values ('A')`));
check('樹種・グループを追加できる', true);
check('同じ色の樹種は追加できない (一意制約)', /unique|duplicate/i.test(await fails(member(() => db.query(`insert into species (name, color) values ('ume', '#ec4899')`))) || ''));
check('組み込み樹種の色も取れない', /unique|duplicate/i.test(await fails(member(() => db.query(`insert into species (name, color) values ('x', '#10b981')`))) || ''));
check('樹種は更新できない', !!(await fails(member(() => db.query(`update species set color='#000000' where name='sakura'`)))));
check('樹種は削除できない', !!(await fails(member(() => db.query(`delete from species where name='sakura'`)))));

console.log('\n[物理削除の禁止]');
for (const t of ['pins', 'areas', 'maps']) {
  check(`メンバーでも ${t} を DELETE できない`, !!(await fails(member(() => db.query(`delete from ${t}`)))));
}

console.log('\n[メンバー外・匿名は何もできない]');
check('匿名は pins を読めない', !!(await fails(anon(() => db.query(`select * from pins`)))));
check('匿名は maps に書けない', !!(await fails(anon(() => db.query(`insert into maps (id,name) values ('m','n')`)))));
check('メンバー外は pins が 0 件に見える (データはある)', (await outsider(() => db.query(`select * from pins`))).rows.length === 0
  && (await admin(() => db.query(`select count(*)::int c from pins`))).rows[0].c === 2);
check('メンバー外は追加できない (RLS)', /row-level security/i.test(await fails(outsider(() => db.query(`insert into maps (id,name) values ('m2','n')`))) || ''));
const upd = await outsider(() => db.query(`update pins set label='hacked'`));
check('メンバー外は更新できない (0件)', upd.affectedRows === 0 && (await admin(() => db.query(`select label from pins where id='pin_1'`))).rows[0].label === 'edited');
check('匿名は is_member() を直接呼べない', !!(await fails(anon(() => db.query(`select is_member()`)))));
check('匿名は delete_map を実行できない', !!(await fails(anon(() => db.query(`select delete_map('map_1')`)))));
await outsider(() => db.query(`select delete_map('map_1')`));
check('メンバー外が delete_map を呼んでも何も消えない', (await admin(() => db.query(`select count(*)::int c from maps where deleted_at is null`))).rows[0].c === 1);

console.log('\n[マップの論理削除 (delete_map)]');
await member(() => db.query(`select delete_map('map_1')`));
const del = (await admin(() => db.query(`select
  (select count(*)::int from maps  where deleted_at is not null) maps,
  (select count(*)::int from pins  where deleted_at is not null) pins,
  (select count(*)::int from areas where deleted_at is not null) areas,
  (select count(*)::int from pins) total_pins`))).rows[0];
check('マップ・全ピン・全エリアに deleted_at が付く (行は残る)', del.maps === 1 && del.pins === 2 && del.areas === 1 && del.total_pins === 2, JSON.stringify(del));

console.log('\n[Realtime]');
const pub = (await admin(() => db.query(`select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1`))).rows.map(r => r.tablename);
check('maps/pins/areas/species/groups が Realtime の対象', JSON.stringify(pub) === JSON.stringify(['areas', 'groups', 'maps', 'pins', 'species']), pub.join(','));
check('members は Realtime の対象外', !pub.includes('members'));

console.log('\n[Storage]');
const bk = (await admin(() => db.query(`select id, public from storage.buckets order by id`))).rows;
check('バケット2つ・どちらも非公開', bk.length === 2 && bk.every(b => b.public === false), JSON.stringify(bk));
await member(() => db.query(`insert into storage.objects (bucket_id, name) values ('pin-photos', 'pin_1.jpg')`));
check('メンバーは画像を保存できる', (await admin(() => db.query(`select 1 from storage.objects`))).rows.length === 1);
check('メンバーは画像を読める', (await member(() => db.query(`select * from storage.objects`))).rows.length === 1);
check('メンバー外は画像を保存できない', !!(await fails(outsider(() => db.query(`insert into storage.objects (bucket_id, name) values ('pin-photos','x.jpg')`)))));
check('メンバー外は画像が見えない', (await outsider(() => db.query(`select * from storage.objects`))).rows.length === 0);
check('匿名は画像が見えない', (await anon(() => db.query(`select * from storage.objects`))).rows.length === 0);
check('許可外のバケットには保存できない', !!(await fails(member(() => db.query(`insert into storage.objects (bucket_id, name) values ('other','x.jpg')`)))));
await member(() => db.query(`delete from storage.objects where bucket_id='pin-photos'`));
check('メンバーは画像ファイルを削除できる (論理削除後の片付け用)', (await admin(() => db.query(`select 1 from storage.objects`))).rows.length === 0);

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures ? 1 : 0);
