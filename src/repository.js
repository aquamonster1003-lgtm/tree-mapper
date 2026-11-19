// データアクセス層の入口。main.js はここだけを import する。
//  - Supabase の環境変数がある: マップ・ピン・エリアはクラウド (cloud-repository.js)
//  - 無い: 従来どおり端末内 (local-repository.js)
// 端末だけの値 (activeMapId など) と、読み込み (復元) は常に端末内。書き出しは、クラウド版ではクラウドのデータ。
import * as local from './local-repository.js';
import { createCloudRepository } from './cloud-repository.js';
import { supabase } from './supabase.js';

const cloud = supabase ? createCloudRepository(supabase) : null;
const impl = cloud || local;

export const isCloud = !!cloud;

export const {
  newId, initRepository,
  listAllGroups, getSetting, setSetting, removeSetting,
  replaceAll
} = local;

// この端末 (IndexedDB) のデータ。クラウドへのアップロード元として使う
export const exportLocalAll = local.exportAll;

export const {
  listMaps, getMap, saveMap, deleteMap,
  listPins, savePin, deletePin,
  listAreas, saveArea, deleteArea
} = impl;

// 書き出し (バックアップ): クラウド版ではクラウドのデータ、端末内版では端末のデータ
export const exportAll = cloud ? cloud.exportAll : local.exportAll;

export const uploadLocalToCloud = cloud ? cloud.uploadLocalToCloud : null;
