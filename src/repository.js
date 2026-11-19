// データアクセス層の入口。main.js はここだけを import する。
//  - Supabase の環境変数がある: マップ・ピン・エリアはクラウド (cloud-repository.js)
//  - 無い: 従来どおり端末内 (local-repository.js)
// 端末だけの値 (activeMapId など) と、書き出し・読み込み (バックアップ) は常に端末内。
import * as local from './local-repository.js';
import { createCloudRepository } from './cloud-repository.js';
import { supabase } from './supabase.js';

const cloud = supabase ? createCloudRepository(supabase) : null;
const impl = cloud || local;

export const isCloud = !!cloud;

export const {
  newId, initRepository,
  listAllGroups, getSetting, setSetting, removeSetting,
  exportAll, replaceAll
} = local;

export const {
  listMaps, getMap, saveMap, deleteMap,
  listPins, savePin, deletePin,
  listAreas, saveArea, deleteArea
} = impl;

export const uploadLocalToCloud = cloud ? cloud.uploadLocalToCloud : null;
