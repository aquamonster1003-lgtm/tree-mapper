// --- Data Access Layer ---
// アプリ本体 (main.js) はこのファイルの関数だけを通してデータを読み書きする。
// 現在の実装は IndexedDB (TreeMapperDB v2)。クラウド化の際は、同じ関数名・
// 同じ戻り値のまま、このファイルの中身だけを Firebase / Supabase 実装に差し替える。
//
// データのルール
//  - ID は newId() で採番する (複数端末で衝突しない UUID)
//  - 保存時に createdAt (初回のみ) と updatedAt を自動で付与する
//  - 削除は物理削除ではなく論理削除 (deletedAt を付与)。一覧取得では除外される
//  - 論理削除したレコードは、画像 (Base64) だけ破棄して容量を空ける

const DB_NAME = 'TreeMapperDB';
const DB_VERSION = 2; // スキーマ変更なし (追加フィールドのみ)。上げると旧データの移行が走るので据え置く

let db;

// --- Helpers ---
export function newId(prefix) {
  const uuid = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.floor(Math.random() * 16);
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
  return `${prefix}_${uuid}`;
}

const isAlive = (item) => !!item && !item.deletedAt;
const byCreatedAt = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);

function stamp(item) {
  const now = Date.now();
  if (!item.createdAt) item.createdAt = now;
  item.updatedAt = now;
  return item;
}

// 論理削除。画像は復元手段がない (削除は取り消せない仕様) ので破棄する
function tombstone(item, now) {
  item.deletedAt = now;
  item.updatedAt = now;
  if ('photo' in item) item.photo = null;
  if ('image' in item) item.image = null;
  return item;
}

const requestToPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

function store(name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}

// --- Init ---
export function initRepository() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('maps')) {
        database.createObjectStore('maps', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('pins')) {
        const pinStore = database.createObjectStore('pins', { keyPath: 'id' });
        pinStore.createIndex('mapId', 'mapId', { unique: false });
      }
      if (!database.objectStoreNames.contains('areas')) {
        const areaStore = database.createObjectStore('areas', { keyPath: 'id' });
        areaStore.createIndex('mapId', 'mapId', { unique: false });
      }
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

// --- Maps ---
// 一覧は軽量なメタ情報のみ (image を含まない)。画像は getMap() で単体取得する
export async function listMaps() {
  const all = await requestToPromise(store('maps').getAll());
  return all
    .filter(isAlive)
    .sort(byCreatedAt)
    .map(({ image, ...meta }) => meta);
}

export async function getMap(id) {
  const map = await requestToPromise(store('maps').get(id));
  return isAlive(map) ? map : null;
}

export async function saveMap(map) {
  await requestToPromise(store('maps', 'readwrite').put(stamp(map)));
}

// マップと、その配下のピン・エリアをまとめて論理削除する (1トランザクション)
export function deleteMap(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['maps', 'pins', 'areas'], 'readwrite');
    const now = Date.now();
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);

    for (const name of ['pins', 'areas']) {
      const objectStore = tx.objectStore(name);
      const request = objectStore.index('mapId').getAll(id);
      request.onsuccess = () => {
        for (const item of request.result) {
          if (isAlive(item)) objectStore.put(tombstone(item, now));
        }
      };
    }

    const mapStore = tx.objectStore('maps');
    const mapRequest = mapStore.get(id);
    mapRequest.onsuccess = () => {
      if (isAlive(mapRequest.result)) mapStore.put(tombstone(mapRequest.result, now));
    };
  });
}

// --- Pins ---
export async function listPins(mapId) {
  const all = await requestToPromise(store('pins').index('mapId').getAll(mapId));
  return all.filter(isAlive).sort(byCreatedAt);
}

export async function savePin(pin) {
  await requestToPromise(store('pins', 'readwrite').put(stamp(pin)));
}

export async function deletePin(id) {
  await softDelete('pins', id);
}

// --- Areas ---
export async function listAreas(mapId) {
  const all = await requestToPromise(store('areas').index('mapId').getAll(mapId));
  return all.filter(isAlive).sort(byCreatedAt);
}

export async function saveArea(area) {
  await requestToPromise(store('areas', 'readwrite').put(stamp(area)));
}

export async function deleteArea(id) {
  await softDelete('areas', id);
}

async function softDelete(storeName, id) {
  const tx = db.transaction(storeName, 'readwrite');
  const objectStore = tx.objectStore(storeName);
  const item = await requestToPromise(objectStore.get(id));
  if (isAlive(item)) objectStore.put(tombstone(item, Date.now()));
  await transactionDone(tx);
}

// 全マップのグループ名一覧 (設定の移行用)
export async function listAllGroups() {
  const [pins, areas] = await Promise.all([
    requestToPromise(store('pins').getAll()),
    requestToPromise(store('areas').getAll())
  ]);
  const groups = new Set();
  [...pins, ...areas].filter(isAlive).forEach((item) => { if (item.group) groups.add(item.group); });
  return Array.from(groups);
}

// --- Settings (この端末だけの値: activeMapId など) ---
export async function getSetting(key) {
  const row = await requestToPromise(store('settings').get(key));
  return row ? row.value : undefined;
}

export async function setSetting(key, value) {
  await requestToPromise(store('settings', 'readwrite').put({ key, value }));
}

export async function removeSetting(key) {
  await requestToPromise(store('settings', 'readwrite').delete(key));
}

// --- Export / Import ---
// 論理削除済みのレコードは含めない
export async function exportAll() {
  const [maps, pins, areas] = await Promise.all([
    requestToPromise(store('maps').getAll()),
    requestToPromise(store('pins').getAll()),
    requestToPromise(store('areas').getAll())
  ]);
  return {
    maps: maps.filter(isAlive).sort(byCreatedAt),
    pins: pins.filter(isAlive).sort(byCreatedAt),
    areas: areas.filter(isAlive).sort(byCreatedAt)
  };
}

// 全データを置き換える。1トランザクションなので、途中で失敗しても元のデータは残る。
// タイムスタンプは取り込んだ値を保つ (stamp しない)
export function replaceAll({ maps = [], pins = [], areas = [] }) {
  return new Promise((resolve, reject) => {
    const names = ['maps', 'pins', 'areas', 'settings'];
    const tx = db.transaction(names, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);

    names.forEach((name) => tx.objectStore(name).clear());
    const put = (name, items) => items.filter(isAlive).forEach((item) => tx.objectStore(name).put(item));
    put('maps', maps);
    put('pins', pins);
    put('areas', areas);
  });
}
