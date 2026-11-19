// cloud-repository.js の動作確認。本物の Supabase ではなく、メモリ上の代用品 (fake) で検証する。
// 見ること: 項目の変換 (camel/snake・時刻)、画像の保存と署名付き URL、論理削除、
//           1000 件超の取得、アップロード (冪等・ID 衝突・孤立データ・失敗の継続)
import { createCloudRepository } from '../../src/cloud-repository.js';

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

// --- 代用品 ---
function makeFake() {
  const tables = { maps: [], pins: [], areas: [] };
  const files = { 'map-images': new Map(), 'pin-photos': new Map() };
  const log = { rpc: [], failUpload: new Set(), failUpsert: new Set() };
  let clock = Date.parse('2026-11-19T00:00:00Z');
  const now = () => new Date(clock += 1000).toISOString();

  const builder = (table) => {
    let op = 'select', payload, filters = [], orders = [], range, single = false;
    const q = {
      select() { return q; },
      upsert(p) { op = 'upsert'; payload = p; return q; },
      update(p) { op = 'update'; payload = p; return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return q; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
      order(c) { orders.push(c); return q; },
      range(a, b) { range = [a, b]; return q; },
      maybeSingle() { single = true; return q; },
      then(res, rej) { return run().then(res, rej); }
    };
    async function run() {
      const rows = tables[table];
      if (op === 'upsert') {
        if (log.failUpsert.has(payload.id)) return { data: null, error: { message: 'boom' } };
        const i = rows.findIndex((r) => r.id === payload.id);
        if (i >= 0) rows[i] = { ...rows[i], ...payload, updated_at: now() };
        else rows.push({ created_at: now(), updated_at: now(), deleted_at: null, photo_path: null, image_path: null, ...payload });
        return { data: null, error: null };
      }
      let sel = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') { sel.forEach((r) => Object.assign(r, payload, { updated_at: now() })); return { data: null, error: null }; }
      for (const c of [...orders].reverse()) sel = [...sel].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0));
      if (range) sel = sel.slice(range[0], range[1] + 1);
      // 本物の API と同じく、行のコピーを返す (後の更新が取得済みの値に影響しない)
      sel = sel.map((r) => structuredClone(r));
      return { data: single ? (sel[0] ?? null) : sel, error: null };
    }
    return q;
  };

  const client = {
    from: builder,
    rpc: async (name, args) => {
      log.rpc.push([name, args]);
      const t = now();
      tables.pins.concat(tables.areas).filter((r) => r.map_id === args.p_id && !r.deleted_at).forEach((r) => { r.deleted_at = t; });
      tables.maps.filter((r) => r.id === args.p_id).forEach((r) => { r.deleted_at = t; });
      return { data: null, error: null };
    },
    storage: {
      from: (bucket) => ({
        upload: async (path, blob) => {
          if (log.failUpload.has(path)) return { error: { message: 'upload failed' } };
          files[bucket].set(path, blob); return { error: null };
        },
        remove: async (paths) => { paths.forEach((p) => files[bucket].delete(p)); return { error: null }; },
        createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: files[bucket].has(p) ? `https://signed.example/${bucket}/${p}?t=1` : null })), error: null })
      })
    }
  };
  return { client, tables, files, log };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';

console.log('[基本: マップ]');
{
  const f = makeFake(); const r = createCloudRepository(f.client);
  const map = { id: 'map_1', name: '北エリア', image: PNG };
  await r.saveMap(map);
  check('マップ保存で createdAt / updatedAt が付く', typeof map.createdAt === 'number' && typeof map.updatedAt === 'number');
  check('画像が Storage に保存され、パスは {id}.png', f.files['map-images'].has('map_1.png') && f.tables.maps[0].image_path === 'map_1.png');
  check('画像本体は DB 行に入らない', !('image' in f.tables.maps[0]));
  const list = await r.listMaps();
  check('一覧は軽量 (image なし)・時刻は数値', list.length === 1 && !('image' in list[0]) && typeof list[0].createdAt === 'number', JSON.stringify(list));
  const got = await r.getMap('map_1');
  check('getMap は署名付き URL を image に返す', got.image.startsWith('https://signed.example/map-images/map_1.png'));
  await r.saveMap({ id: 'map_1', name: '改名', image: got.image });
  check('画像が URL のまま保存しても、画像パスは変わらず名前だけ更新', f.tables.maps[0].name === '改名' && f.tables.maps[0].image_path === 'map_1.png' && f.files['map-images'].size === 1);
  check('存在しない ID は null', (await r.getMap('nope')) === null);
}

console.log('\n[基本: ピン]');
{
  const f = makeFake(); const r = createCloudRepository(f.client);
  await r.saveMap({ id: 'map_1', name: 'm', image: PNG });
  const pin = { id: 'pin_1', mapId: 'map_1', x: 10.5, y: 20, group: 'A', species: 'keyaki', label: '一本目', photo: JPG };
  await r.savePin(pin);
  const row = f.tables.pins[0];
  check('項目が DB の列名に変換される', row.map_id === 'map_1' && row.group_name === 'A' && row.label === '一本目' && row.x === 10.5);
  check('写真が Storage に保存される (jpg)', row.photo_path === 'pin_1.jpg' && f.files['pin-photos'].has('pin_1.jpg'));
  let pins = await r.listPins('map_1');
  check('一覧で camelCase・写真は署名付き URL', pins[0].mapId === 'map_1' && pins[0].group === 'A' && pins[0].photo.startsWith('https://signed.example/pin-photos/pin_1.jpg'));
  // 写真を変えずに編集
  pins[0].label = '編集後';
  await r.savePin(pins[0]);
  check('写真そのまま編集: 写真パス維持・ラベル更新・ファイル数不変', f.tables.pins[0].photo_path === 'pin_1.jpg' && f.tables.pins[0].label === '編集後' && f.files['pin-photos'].size === 1);
  // 写真を消す
  pins[0].photo = null;
  await r.savePin(pins[0]);
  check('写真を外すと photo_path が null', f.tables.pins[0].photo_path === null);
  pins = await r.listPins('map_1');
  check('写真なしは photo: null', pins[0].photo === null);
  // 写真つきで削除
  await r.savePin({ ...pins[0], photo: JPG });
  await r.deletePin('pin_1');
  check('ピン削除は論理削除 (行は残る)', f.tables.pins.length === 1 && !!f.tables.pins[0].deleted_at);
  check('削除したピンの写真ファイルは消える', f.files['pin-photos'].size === 0);
  check('削除したピンは一覧に出ない', (await r.listPins('map_1')).length === 0);
}

console.log('\n[基本: エリア・マップ削除]');
{
  const f = makeFake(); const r = createCloudRepository(f.client);
  await r.saveMap({ id: 'map_1', name: 'm', image: PNG });
  await r.saveArea({ id: 'area_1', mapId: 'map_1', type: 'line', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], group: 'デフォルト', label: '生垣', color: '#22c55e' });
  await r.savePin({ id: 'pin_1', mapId: 'map_1', x: 1, y: 1, group: 'デフォルト', species: 'a', label: '', photo: JPG });
  const areas = await r.listAreas('map_1');
  check('エリアの points が配列のまま戻る', Array.isArray(areas[0].points) && areas[0].points[1].y === 4 && areas[0].color === '#22c55e');
  await r.deleteArea('area_1');
  check('エリア削除は論理削除', (await r.listAreas('map_1')).length === 0 && f.tables.areas.length === 1);
  await r.deleteMap('map_1');
  check('マップ削除は RPC delete_map を呼ぶ', f.log.rpc.length === 1 && f.log.rpc[0][0] === 'delete_map' && f.log.rpc[0][1].p_id === 'map_1');
  check('マップ・ピンの画像ファイルが消える', f.files['map-images'].size === 0 && f.files['pin-photos'].size === 0);
  check('削除したマップは一覧・取得から消える', (await r.listMaps()).length === 0 && (await r.getMap('map_1')) === null);
}

console.log('\n[1000 件超の取得]');
{
  const f = makeFake(); const r = createCloudRepository(f.client);
  f.tables.maps.push({ id: 'map_1', name: 'm', created_at: 'x', updated_at: 'x', deleted_at: null });
  for (let i = 0; i < 2350; i++) f.tables.pins.push({ id: `pin_${String(i).padStart(5, '0')}`, map_id: 'map_1', x: 0, y: 0, group_name: 'g', species: 's', label: '', photo_path: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null });
  const pins = await r.listPins('map_1');
  check('2350 件すべて取得できる (重複・欠落なし)', pins.length === 2350 && new Set(pins.map((p) => p.id)).size === 2350, String(pins.length));
}

console.log('\n[端末のデータをアップロード]');
{
  const f = makeFake(); const r = createCloudRepository(f.client);
  const T = Date.parse('2023-11-14T00:00:00Z');
  const local = {
    maps: [{ id: '1700000000001', name: '旧ID', image: PNG, createdAt: T, updatedAt: T }, { id: 'map_new', name: '新', image: PNG, createdAt: T + 5, updatedAt: T + 5 }],
    pins: [
      { id: 'pin_a', mapId: '1700000000001', x: 1, y: 2, group: 'A', species: 'x', label: 'a', photo: JPG, createdAt: T + 10, updatedAt: T + 10 },
      { id: 'pin_b', mapId: 'map_new', x: 3, y: 4, group: 'B', species: 'y', label: 'b', photo: null, createdAt: T + 20, updatedAt: T + 20 },
      { id: 'pin_orphan', mapId: 'deleted_map', x: 0, y: 0, group: 'A', species: 'y', label: 'o', photo: null, createdAt: T, updatedAt: T }
    ],
    areas: [{ id: 'area_a', mapId: 'map_new', type: 'polygon', points: [{ x: 0, y: 0 }], group: 'A', label: 'p', color: '#111111', createdAt: T + 30, updatedAt: T + 30 }]
  };
  const prog = [];
  const res = await r.uploadLocalToCloud(local, (d, t) => prog.push([d, t]));
  check('件数が一致', res.maps === 2 && res.pins === 2 && res.areas === 1 && res.photos === 1 && res.skipped === 1 && res.failed.length === 0, JSON.stringify(res));
  check('旧形式のマップ ID がそのまま保存される', f.tables.maps.some((m) => m.id === '1700000000001'));
  check('作成日時が元の値のまま (移行で「今」にならない)', new Date(f.tables.maps.find((m) => m.id === '1700000000001').created_at).getTime() === T && new Date(f.tables.pins.find((p) => p.id === 'pin_a').created_at).getTime() === T + 10);
  check('孤立したピン (マップなし) は送らない', !f.tables.pins.some((p) => p.id === 'pin_orphan'));
  check('進捗が最後に 総数/総数 になる', prog.length > 0 && prog.at(-1)[0] === prog.at(-1)[1], JSON.stringify(prog.at(-1)));
  const before = JSON.stringify([f.tables.maps.length, f.tables.pins.length, f.tables.areas.length, f.files['pin-photos'].size]);
  const res2 = await r.uploadLocalToCloud(local);
  check('2 回実行しても重複しない (冪等)', JSON.stringify([f.tables.maps.length, f.tables.pins.length, f.tables.areas.length, f.files['pin-photos'].size]) === before && res2.remappedMaps === 0);
  check('2 回目は全て「既にある」扱いで何も送らない', res2.maps === 0 && res2.pins === 0 && res2.areas === 0 && res2.photos === 0 && res2.existing === 5, JSON.stringify(res2));

  // クラウドで編集・削除された後に再実行しても、上書き・復活しない
  f.tables.pins.find((p) => p.id === 'pin_a').label = 'クラウドで編集';
  f.tables.pins.find((p) => p.id === 'pin_b').deleted_at = '2026-11-20T00:00:00Z';
  f.tables.maps.find((m) => m.id === 'map_new').name = 'クラウドで改名';
  await r.uploadLocalToCloud(local);
  check('再実行しても、クラウド側の編集は元に戻らない', f.tables.pins.find((p) => p.id === 'pin_a').label === 'クラウドで編集' && f.tables.maps.find((m) => m.id === 'map_new').name === 'クラウドで改名');
  check('再実行しても、クラウドで削除したものは復活しない', !!f.tables.pins.find((p) => p.id === 'pin_b').deleted_at);

  // 別端末で同じ旧形式 ID が偶然かぶった場合
  const other = { maps: [{ id: '1700000000001', name: '別端末のマップ', image: PNG, createdAt: T + 99999, updatedAt: T }], pins: [{ id: 'pin_other', mapId: '1700000000001', x: 9, y: 9, group: 'A', species: 'z', label: 'other', photo: null, createdAt: T, updatedAt: T }], areas: [] };
  const res3 = await r.uploadLocalToCloud(other);
  const oldMap = f.tables.maps.find((m) => m.id === '1700000000001');
  const added = f.tables.maps.find((m) => m.name === '別端末のマップ');
  check('ID が衝突する別のマップは、既存を上書きせず ID を振り直す', res3.remappedMaps === 1 && oldMap.name === '旧ID' && !!added && added.id !== '1700000000001', added?.id);
  check('振り直したマップにピンも付け替わる', f.tables.pins.find((p) => p.id === 'pin_other')?.map_id === added.id);
  const clash = { maps: [{ id: '1700000000001', name: '衝突その2', image: PNG, createdAt: T + 77777, updatedAt: T }], pins: [{ id: 'pin_a', mapId: '1700000000001', x: 5, y: 5, group: 'A', species: 'q', label: '同じIDの別ピン', photo: null, createdAt: T, updatedAt: T }], areas: [] };
  await r.uploadLocalToCloud(clash);
  check('マップ衝突時、同じ ID のピンも既存を上書きせず新 ID で追加', f.tables.pins.find((p) => p.id === 'pin_a').label === 'クラウドで編集' && f.tables.pins.some((p) => p.label === '同じIDの別ピン' && p.id !== 'pin_a'));

  // 失敗しても残りは続ける
  const f2 = makeFake(); const r2 = createCloudRepository(f2.client);
  f2.log.failUpsert.add('pin_b');
  const res4 = await r2.uploadLocalToCloud(local);
  check('1 件失敗しても残りは保存し、失敗を報告する', res4.failed.length === 1 && res4.failed[0].includes('b') && res4.pins === 1 && res4.areas === 1, JSON.stringify(res4.failed));
  f2.log.failUpsert.clear();
  const res5 = await r2.uploadLocalToCloud(local);
  check('失敗後にやり直すと、残りだけが送られる', res5.pins === 1 && res5.maps === 0 && res5.areas === 0 && f2.tables.pins.length === 2, JSON.stringify(res5));
}


console.log('\n[クラウドのデータを書き出す]');
{
  const f = makeFake();
  const r = createCloudRepository(f.client, { toDataUrl: async () => PNG });
  await r.saveMap({ id: 'map_1', name: '本番のマップ', image: PNG });
  await r.saveMap({ id: 'map_2', name: '削除するマップ', image: PNG });
  await r.savePin({ id: 'pin_1', mapId: 'map_1', x: 1, y: 2, group: 'A', species: 'keyaki', label: '写真あり', photo: JPG });
  await r.savePin({ id: 'pin_2', mapId: 'map_1', x: 3, y: 4, group: 'B', species: 'sakura', label: '写真なし', photo: null });
  await r.savePin({ id: 'pin_3', mapId: 'map_1', x: 5, y: 6, group: 'B', species: 'sakura', label: '削除する', photo: null });
  await r.saveArea({ id: 'area_1', mapId: 'map_1', type: 'line', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], group: 'A', label: '生垣', color: '#22c55e' });
  await r.deletePin('pin_3');
  await r.deleteMap('map_2');
  const out = await r.exportAll();
  check('書き出し: 削除していないマップ・ピン・エリアだけ', out.maps.length === 1 && out.pins.length === 2 && out.areas.length === 1, `${out.maps.length}/${out.pins.length}/${out.areas.length}`);
  check('書き出し: マップ画像・写真が Data URL で入る', out.maps[0].image === PNG && out.pins.find((p) => p.id === 'pin_1').photo === PNG);
  check('書き出し: 写真なしは null', out.pins.find((p) => p.id === 'pin_2').photo === null);
  check('書き出し: 端末内版と同じ形 (camelCase・数値の時刻)', out.pins[0].mapId === 'map_1' && out.pins[0].group === 'A' && typeof out.pins[0].createdAt === 'number' && out.areas[0].points.length === 2);

  // 書き出したものを、そのまま別のクラウドにアップロードできる (往復)
  const f2 = makeFake(); const r2 = createCloudRepository(f2.client);
  const res = await r2.uploadLocalToCloud(out);
  check('書き出し→アップロードの往復で、同じ件数が入る', res.maps === 1 && res.pins === 2 && res.areas === 1 && res.failed.length === 0, JSON.stringify(res));

  // 画像が取れないときは、黙って欠けた書き出しを作らない
  f.files['pin-photos'].delete('pin_1.jpg');
  let err = null; try { await r.exportAll(); } catch (e) { err = e.message; }
  check('画像を取得できないときは、例外にする (欠けたバックアップを作らない)', !!err && err.includes('画像を取得できない'), err);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures ? 1 : 0);
