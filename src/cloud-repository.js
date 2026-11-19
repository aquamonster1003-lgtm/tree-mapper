// クラウド (Supabase) 版のデータ層。local-repository.js と同じ関数名・同じ戻り値にしてあるので、
// main.js は違いを意識しない。
//  - 画像・写真は Storage (非公開バケット)。画面には署名付き URL を渡す (Data URL と同じく <img src> に使える)
//  - 保存時に photo / image が Data URL なら Storage にアップロード、URL (=変更なし) なら触らない
//  - 削除は論理削除 (deleted_at)。マップは RPC delete_map
//  - 時刻は端末内版に合わせて、取得時に ms の数値へ変換する
import { newId } from './local-repository.js';

const SIGN_SECONDS = 6 * 60 * 60;
const PAGE = 1000; // Supabase の 1 回の取得上限
const MAP_BUCKET = 'map-images';
const PIN_BUCKET = 'pin-photos';

// 保存しようとしたデータが、開いたあとに他の人に変更・削除されていたとき
export class ConflictError extends Error {
  constructor(what) { super(`${what} was changed by someone else`); this.name = 'ConflictError'; }
}

const ms = (v) => (v ? Date.parse(v) : undefined);
const iso = (v) => (v ? new Date(v).toISOString() : undefined);
const isDataUrl = (v) => typeof v === 'string' && v.startsWith('data:');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function must({ data, error }) {
  if (error) throw error;
  return data;
}

async function dataUrlToBlob(dataUrl) {
  return await (await fetch(dataUrl)).blob();
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// 署名付き URL の画像を Data URL にする (書き出し用)
async function fetchAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`画像の取得に失敗 (${res.status})`);
  return await blobToDataUrl(await res.blob());
}

export function createCloudRepository(sb, { toDataUrl = fetchAsDataUrl } = {}) {
  async function uploadImage(bucket, id, dataUrl) {
    const blob = await dataUrlToBlob(dataUrl);
    const path = `${id}.${EXT[blob.type] || 'bin'}`;
    const { error } = await sb.storage.from(bucket).upload(path, blob, { upsert: true, contentType: blob.type });
    if (error) throw error;
    return path;
  }

  async function removeFiles(bucket, paths) {
    const list = paths.filter(Boolean);
    if (!list.length) return;
    try { await sb.storage.from(bucket).remove(list); } catch (e) { console.warn('画像の削除に失敗 (無視)', e); }
  }

  async function signAll(bucket, paths) {
    const unique = [...new Set(paths.filter(Boolean))];
    const urls = new Map();
    if (!unique.length) return urls;
    const { data, error } = await sb.storage.from(bucket).createSignedUrls(unique, SIGN_SECONDS);
    if (error) throw error;
    for (const row of data) if (row.signedUrl) urls.set(row.path, row.signedUrl);
    return urls;
  }

  // 1000 件ごとに取得して全件つなげる
  async function fetchAll(makeQuery) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const page = must(await makeQuery().range(from, from + PAGE - 1));
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  // --- Maps ---
  const mapMeta = (r) => ({ id: r.id, name: r.name, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) });

  async function listMaps() {
    const rows = await fetchAll(() => sb.from('maps').select('id,name,created_at,updated_at')
      .is('deleted_at', null).order('created_at').order('id'));
    return rows.map(mapMeta);
  }

  async function getMap(id) {
    const row = must(await sb.from('maps').select('*').eq('id', id).is('deleted_at', null).maybeSingle());
    if (!row) return null;
    const urls = await signAll(MAP_BUCKET, [row.image_path]);
    return { ...mapMeta(row), image: urls.get(row.image_path) || null };
  }

  async function saveMap(map) {
    const row = { id: map.id, name: map.name };
    if (map.createdAt) row.created_at = iso(map.createdAt);
    if (isDataUrl(map.image)) row.image_path = await uploadImage(MAP_BUCKET, map.id, map.image);
    must(await sb.from('maps').upsert(row, { onConflict: 'id' }));
    const now = Date.now();
    if (!map.createdAt) map.createdAt = now;
    map.updatedAt = now;
  }

  async function deleteMap(id) {
    const map = must(await sb.from('maps').select('image_path').eq('id', id).maybeSingle());
    const pins = await fetchAll(() => sb.from('pins').select('id,photo_path').eq('map_id', id).order('id'));
    must(await sb.rpc('delete_map', { p_id: id }));
    await removeFiles(MAP_BUCKET, [map?.image_path]);
    await removeFiles(PIN_BUCKET, pins.map((p) => p.photo_path));
  }

  // --- Pins ---
  const pinFromRow = (r, urls) => ({
    id: r.id, mapId: r.map_id, x: r.x, y: r.y,
    group: r.group_name, species: r.species, label: r.label,
    photo: r.photo_path ? (urls.get(r.photo_path) || null) : null,
    createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
    _v: r.updated_at // サーバー上の版 (updated_at の文字列そのまま)。保存時に、他の人の変更を上書きしないための照合に使う
  });

  async function listPins(mapId) {
    const rows = await fetchAll(() => sb.from('pins').select('*').eq('map_id', mapId)
      .is('deleted_at', null).order('created_at').order('id'));
    const urls = await signAll(PIN_BUCKET, rows.map((r) => r.photo_path));
    return rows.map((r) => pinFromRow(r, urls));
  }

  async function pinRow(pin) {
    const row = {
      id: pin.id, map_id: pin.mapId, x: pin.x, y: pin.y,
      group_name: pin.group || 'デフォルト', species: pin.species, label: pin.label || ''
    };
    if (pin.createdAt) row.created_at = iso(pin.createdAt);
    if (isDataUrl(pin.photo)) row.photo_path = await uploadImage(PIN_BUCKET, pin.id, pin.photo);
    else if (!pin.photo) row.photo_path = null;
    // photo が署名付き URL のとき = 変更なし。photo_path は送らず、そのまま残す
    return row;
  }

  // 開いたときの版 (pin._v) が、いまもサーバーと同じときだけ更新する。違えば ConflictError
  async function writeRow(table, item, row) {
    let rows;
    if (item._v) {
      rows = must(await sb.from(table).update(row).eq('id', item.id).eq('updated_at', item._v).select('updated_at'));
      if (!rows.length) throw new ConflictError(table);
    } else {
      rows = must(await sb.from(table).upsert(row, { onConflict: 'id' }).select('updated_at'));
    }
    const now = Date.now();
    if (!item.createdAt) item.createdAt = now;
    const version = rows[0]?.updated_at;
    item.updatedAt = version ? ms(version) : now;
    if (version) item._v = version;
  }

  async function savePin(pin) {
    await writeRow('pins', pin, await pinRow(pin));
  }

  async function deletePin(id) {
    const row = must(await sb.from('pins').select('photo_path').eq('id', id).maybeSingle());
    must(await sb.from('pins').update({ deleted_at: new Date().toISOString(), photo_path: null }).eq('id', id));
    await removeFiles(PIN_BUCKET, [row?.photo_path]);
  }

  // --- Areas ---
  const areaFromRow = (r) => ({
    id: r.id, mapId: r.map_id, type: r.type, points: r.points,
    group: r.group_name, label: r.label, color: r.color,
    createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
    _v: r.updated_at
  });

  async function listAreas(mapId) {
    const rows = await fetchAll(() => sb.from('areas').select('*').eq('map_id', mapId)
      .is('deleted_at', null).order('created_at').order('id'));
    return rows.map(areaFromRow);
  }

  const areaRow = (area) => {
    const row = {
      id: area.id, map_id: area.mapId, type: area.type, points: area.points,
      group_name: area.group || 'デフォルト', label: area.label || '', color: area.color
    };
    if (area.createdAt) row.created_at = iso(area.createdAt);
    return row;
  };

  async function saveArea(area) {
    await writeRow('areas', area, areaRow(area));
  }

  async function deleteArea(id) {
    must(await sb.from('areas').update({ deleted_at: new Date().toISOString() }).eq('id', id));
  }

  // --- 共有設定 (樹種・グループ) ---
  // 追加だけができる (更新・削除は DB 側で禁止)。樹種の色は DB の一意制約で重複を防ぐ。
  const HEX = /^#[0-9a-fA-F]{6}$/;

  async function loadSharedSettings() {
    const [species, groups] = await Promise.all([
      fetchAll(() => sb.from('species').select('name,color').order('created_at').order('name')),
      fetchAll(() => sb.from('groups').select('name').order('created_at').order('name'))
    ]);
    return { species: species.map((r) => ({ name: r.name, color: r.color })), groups: groups.map((r) => r.name) };
  }

  const isUnique = (error) => error && error.code === '23505';

  // 戻り値: 'added' | 'exists' (同じ名前が既にある) | 'color-taken' (色が他の樹種で使われている)。通信失敗などは例外
  async function addSpecies(name, color) {
    const { error } = await sb.from('species').insert({ name, color });
    if (!error) return 'added';
    if (isUnique(error)) return /color/i.test(`${error.message} ${error.details || ''}`) ? 'color-taken' : 'exists';
    throw error;
  }

  async function addGroup(name) {
    const { error } = await sb.from('groups').insert({ name });
    if (error && !isUnique(error)) throw error; // 既にあるのは問題なし
  }

  // 端末 / バックアップファイルの設定を、クラウドに無いものだけ追加する (既存は触らない)
  async function uploadSharedSettings(settings = {}) {
    const result = { species: 0, groups: 0, existing: 0, colorConflicts: [] };
    const cloud = await loadSharedSettings();
    const haveSpecies = new Set(cloud.species.map((x) => x.name));
    const haveGroups = new Set(cloud.groups);
    const colors = settings.speciesColors || {};

    for (const name of settings.customSpecies || []) {
      if (haveSpecies.has(name)) { result.existing++; continue; }
      const color = colors[name];
      if (!HEX.test(color || '')) continue; // 色が分からない樹種は送らない (ピンは既定色で表示される)
      const r = await addSpecies(name, color.toLowerCase());
      if (r === 'added') { result.species++; haveSpecies.add(name); }
      else if (r === 'color-taken') result.colorConflicts.push(name);
      else result.existing++;
    }
    for (const name of settings.customGroups || []) {
      if (haveGroups.has(name) || name === 'デフォルト') { result.existing++; continue; }
      await addGroup(name);
      result.groups++;
      haveGroups.add(name);
    }
    return result;
  }

  // --- クラウドのデータを書き出す (バックアップ) ---
  // 端末内版の exportAll() と同じ形 (画像・写真は Data URL)。論理削除済みは含めない。
  // 画像が取れなかったものは、黙って欠けないよう、失敗として例外にする。
  async function exportAll() {
    const mapRows = await fetchAll(() => sb.from('maps').select('*').is('deleted_at', null).order('created_at').order('id'));
    const pinRows = await fetchAll(() => sb.from('pins').select('*').is('deleted_at', null).order('created_at').order('id'));
    const areaRows = await fetchAll(() => sb.from('areas').select('*').is('deleted_at', null).order('created_at').order('id'));

    const mapUrls = new Map(); const pinUrls = new Map();
    const sign = async (bucket, paths, into) => {
      const list = [...new Set(paths.filter(Boolean))];
      for (let i = 0; i < list.length; i += 100) (await signAll(bucket, list.slice(i, i + 100))).forEach((v, k) => into.set(k, v));
    };
    await sign(MAP_BUCKET, mapRows.map((r) => r.image_path), mapUrls);
    await sign(PIN_BUCKET, pinRows.map((r) => r.photo_path), pinUrls);

    const missing = [];
    const maps = [];
    for (const r of mapRows) {
      let image = null;
      if (r.image_path) {
        const url = mapUrls.get(r.image_path);
        if (!url) missing.push(`マップ画像 ${r.name}`); else image = await toDataUrl(url);
      }
      maps.push({ ...mapMeta(r), image });
    }

    const pins = new Array(pinRows.length);
    let next = 0;
    const worker = async () => {
      while (next < pinRows.length) {
        const i = next++; const r = pinRows[i];
        let photo = null;
        if (r.photo_path) {
          const url = pinUrls.get(r.photo_path);
          if (!url) missing.push(`ピン写真 ${r.label || r.id}`); else photo = await toDataUrl(url);
        }
        pins[i] = { id: r.id, mapId: r.map_id, x: r.x, y: r.y, group: r.group_name, species: r.species, label: r.label, photo, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) };
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    if (missing.length) throw new Error(`画像を取得できないデータがあります: ${missing.slice(0, 5).join('、')}`);
    return { maps, pins, areas: areaRows.map(areaFromRow) };
  }

  // --- この端末のデータをクラウドへ ---
  // local = local-repository の exportAll() の結果 (画像つき)。ID は変えずに送る。
  // 安全のため「クラウドにまだ無いものだけ」を追加する。すでにあるもの (他の人や自分が後から編集・削除したものを含む)
  // は上書きしないので、何度実行しても、また途中で失敗してやり直しても、クラウド側の変更は失われない。
  // 例外: 同じ ID のマップがクラウドに既にあり、作成日時が違う場合は「別のマップ」とみなして ID を振り直して追加する。
  async function uploadLocalToCloud(local, onProgress = () => {}) {
    const result = { maps: 0, pins: 0, areas: 0, photos: 0, remappedMaps: 0, skipped: 0, existing: 0, failed: [] };
    const maps = local.maps || [];
    const total = maps.length + (local.pins || []).length + (local.areas || []).length;
    let done = 0;
    const tick = () => onProgress(++done, total);

    // クラウドに既にある ID (論理削除済みも含む)
    async function existingIds(table, ids, columns) {
      const found = new Map();
      for (let i = 0; i < ids.length; i += 50) {
        const rows = must(await sb.from(table).select(columns).in('id', ids.slice(i, i + 50)));
        rows.forEach((r) => found.set(r.id, r));
      }
      return found;
    }

    const existingMaps = await existingIds('maps', maps.map((m) => m.id), 'id,created_at');
    const idMap = new Map(); // 元のマップ ID -> クラウド上のマップ ID
    for (const map of maps) {
      try {
        const cloud = existingMaps.get(map.id);
        const cloudCreated = cloud ? ms(cloud.created_at) : undefined;
        const collides = cloud && map.createdAt && Math.abs(cloudCreated - map.createdAt) > 1000;
        if (cloud && !collides) {
          idMap.set(map.id, map.id); // 同じマップ (送信済み): 触らない
          result.existing++;
        } else {
          const newMapId = collides ? newId('map') : map.id;
          await saveMap({ ...map, id: newMapId });
          idMap.set(map.id, newMapId);
          result.maps++;
          if (collides) result.remappedMaps++;
        }
      } catch (e) {
        console.error(e);
        result.failed.push(`マップ ${map.name || map.id}`);
      }
      tick();
    }

    // ピン・エリアの既存 ID。マップを振り直した場合に、同じ ID の別データを上書きしないために使う
    const existingPins = await existingIds('pins', (local.pins || []).map((p) => p.id), 'id');
    const existingAreas = await existingIds('areas', (local.areas || []).map((a) => a.id), 'id');

    // ピン: 写真アップロードがあるので 4 件ずつ並列
    const pins = local.pins || [];
    let next = 0;
    const worker = async () => {
      while (next < pins.length) {
        const pin = pins[next++];
        const mapId = idMap.get(pin.mapId);
        if (!mapId) { result.skipped++; tick(); continue; }
        const remapped = mapId !== pin.mapId;
        if (existingPins.has(pin.id) && !remapped) { result.existing++; tick(); continue; }
        try {
          const id = existingPins.has(pin.id) ? newId('pin') : pin.id; // 別のマップの同じ ID と混ざる場合だけ新しい ID
          await sb.from('pins').upsert(await pinRow({ ...pin, id, mapId }), { onConflict: 'id' }).then(must);
          result.pins++;
          if (isDataUrl(pin.photo)) result.photos++;
        } catch (e) {
          console.error(e);
          result.failed.push(`ピン ${pin.label || pin.id}`);
        }
        tick();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    const areas = local.areas || [];
    for (const area of areas) {
      const mapId = idMap.get(area.mapId);
      if (!mapId) { result.skipped++; tick(); continue; }
      const remapped = mapId !== area.mapId;
      if (existingAreas.has(area.id) && !remapped) { result.existing++; tick(); continue; }
      try {
        const id = existingAreas.has(area.id) ? newId('area') : area.id;
        must(await sb.from('areas').upsert(areaRow({ ...area, id, mapId }), { onConflict: 'id' }));
        result.areas++;
      } catch (e) {
        console.error(e);
        result.failed.push(`エリア ${area.label || area.id}`);
      }
      tick();
    }
    return result;
  }

  return {
    listMaps, getMap, saveMap, deleteMap,
    listPins, savePin, deletePin,
    listAreas, saveArea, deleteArea,
    uploadLocalToCloud, exportAll,
    loadSharedSettings, addSpecies, addGroup, uploadSharedSettings
  };
}
