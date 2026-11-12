import {
  initRepository, newId,
  listMaps, getMap, saveMap, deleteMap,
  listPins, savePin, deletePin,
  listAreas, saveArea, deleteArea,
  listAllGroups, getSetting, setSetting, removeSetting,
  exportAll, replaceAll
} from './repository.js';
import { checkAccess, bindAuthUi } from './auth.js';

// --- Image Compression ---
function compressImage(file, maxSize = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// UI Elements
const ui = {
  loader: document.getElementById('loading-overlay'),
  uploadScreen: document.getElementById('upload-screen'),
  mapScreen: document.getElementById('map-screen'),
  mapUploadBtn: document.getElementById('map-upload'),
  resetMapBtn: document.getElementById('reset-map-btn'),
  viewerContainer: document.getElementById('viewer-container'),
  mapWrapper: document.getElementById('map-wrapper'),
  mapImage: document.getElementById('map-image'),
  pinsContainer: document.getElementById('pins-container'),
  areasSvg: document.getElementById('areas-svg'),
  mapHint: document.getElementById('map-hint'),

  // Header / Map Selector
  mainHeader: document.getElementById('main-header'),
  mapSelector: document.getElementById('map-selector'),
  filterBtn: document.getElementById('filter-btn'),
  filterPanel: document.getElementById('filter-panel'),
  filterList: document.getElementById('filter-list'),
  hedgeBtn: document.getElementById('hedge-btn'),
  drawingHint: document.getElementById('drawing-hint'),

  // Hedge Submenu & Drawing Controls
  hedgeSubmenu: document.getElementById('hedge-submenu'),
  hedgeLineBtn: document.getElementById('hedge-line-btn'),
  hedgePolygonBtn: document.getElementById('hedge-polygon-btn'),
  hedgeSubmenuCancel: document.getElementById('hedge-submenu-cancel'),
  drawingControls: document.getElementById('drawing-controls'),
  drawingConfirmBtn: document.getElementById('drawing-confirm-btn'),
  drawingCancelBtn: document.getElementById('drawing-cancel-btn'),

  // Settings / Data Management
  settingsBtn: document.getElementById('settings-btn'),
  uploadSettingsBtn: document.getElementById('upload-settings-btn'),
  settingsModal: document.getElementById('settings-modal-backdrop'),
  settingsCancel: document.getElementById('settings-cancel'),
  exportDataBtn: document.getElementById('export-data-btn'),
  importDataUpload: document.getElementById('import-data-upload'),

  // Pin Modal
  modalBackdrop: document.getElementById('pin-modal-backdrop'),
  pinForm: document.getElementById('pin-form'),
  modalCancel: document.getElementById('modal-cancel'),
  modalTitle: document.getElementById('modal-title'),
  modalDelete: document.getElementById('modal-delete'),
  deleteActionGroup: document.getElementById('delete-action-group'),
  pinGroupSelect: document.getElementById('pin-group'),
  newGroupWrapper: document.getElementById('new-group-wrapper'),
  newGroupInput: document.getElementById('new-group'),
  treeSpecies: document.getElementById('tree-species'),
  newSpeciesGroup: document.getElementById('new-species-group'),
  newSpeciesInput: document.getElementById('new-species'),
  treeLabel: document.getElementById('tree-label'),
  pinPhotoInput: document.getElementById('pin-photo'),
  pinPhotoPreview: document.getElementById('pin-photo-preview'),
  photoPlaceholder: document.getElementById('photo-placeholder'),
  removePhotoBtn: document.getElementById('remove-photo-btn'),

  // Area Modal
  areaModalBackdrop: document.getElementById('area-modal-backdrop'),
  areaForm: document.getElementById('area-form'),
  areaModalTitle: document.getElementById('area-modal-title'),
  areaLabel: document.getElementById('area-label'),
  areaGroupSelect: document.getElementById('area-group'),
  areaNewGroupWrapper: document.getElementById('area-new-group-wrapper'),
  areaNewGroupInput: document.getElementById('area-new-group'),
  areaColorPalette: document.getElementById('area-color-palette'),
  areaModalCancel: document.getElementById('area-modal-cancel'),
  areaDeleteGroup: document.getElementById('area-delete-group'),
  areaModalDelete: document.getElementById('area-modal-delete')
};

// Application State
const PALETTE_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', 
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', 
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899'
];

let state = {
  maps: [], 
  activeMapId: null,
  activeMapImage: null,
  pins: [],
  areas: [],
  customSpecies: JSON.parse(localStorage.getItem('tm_customSpecies') || '[]'),
  speciesColors: Object.assign({
    'shirakashi': '#10b981',
    'keyaki': '#f59e0b'
  }, JSON.parse(localStorage.getItem('tm_speciesColors') || '{}')),
  customGroups: JSON.parse(localStorage.getItem('tm_customGroups') || '[]'),
  // 表示するグループではなく「隠すグループ」を保存する。
  // こうすると、他の人が新しく作ったグループは既定で表示される。
  hiddenGroups: JSON.parse(localStorage.getItem('tm_hiddenGroups') || '[]'),
  transform: { x: 0, y: 0, scale: 1 },
  activePinId: null,
  tempClickPos: null,
  currentPinPhoto: null,
  selectedNewColor: null,

  // Hedge mode state
  hedgeMode: null, // null | 'line' | 'polygon'
  currentPoints: [], // drawing in progress: [{x, y}]
  activeAreaId: null, // editing/viewing area
  selectedAreaColor: '#22c55e'
};

// --- Boot ---
async function init() {
  bindAuthUi();
  const access = await checkAccess();
  if (access !== 'local' && access !== 'ok') return; // ログイン前・未登録・通信エラー時はデータを読み込まない
  ui.loader.classList.remove('hidden');
  try {
    await initRepository();
    await checkMigration();
    await migrateVisibleToHiddenGroups();
    await loadInitialData();
  } catch (err) {
    console.error('DB Initialization failed', err);
    alert('データベースの初期化に失敗しました。');
  }
  ui.loader.classList.add('hidden');
}

async function checkMigration() {
  const isMigrated = localStorage.getItem('tm_migrated');
  if (isMigrated === 'true') return;

  const oldMapSrc = localStorage.getItem('tm_mapSrc');
  if (oldMapSrc) {
    const mapId = newId('map');
    const newMap = { id: mapId, name: '最初のマップ', image: oldMapSrc };
    await saveMap(newMap);

    const oldPins = JSON.parse(localStorage.getItem('tm_pins') || '[]');
    for (const pin of oldPins) {
      if (!pin.group) pin.group = 'デフォルト';
      pin.mapId = mapId;
      await savePin(pin);
    }
    await setSetting('activeMapId', mapId);
  }
  localStorage.setItem('tm_migrated', 'true');
}

// 旧: 表示するグループ (tm_visibleGroups) → 新: 隠すグループ (tm_hiddenGroups)
// 旧版は「保存済みの表示グループに無いもの = 非表示」だったので、その状態をそのまま引き継ぐ
async function migrateVisibleToHiddenGroups() {
  if (localStorage.getItem('tm_hiddenGroups') !== null) return;

  const legacy = localStorage.getItem('tm_visibleGroups');
  let hidden = [];
  if (legacy !== null) {
    const visible = JSON.parse(legacy);
    const known = new Set(['デフォルト', ...state.customGroups, ...(await listAllGroups())]);
    hidden = Array.from(known).filter(g => !visible.includes(g));
  }
  state.hiddenGroups = hidden;
  localStorage.setItem('tm_hiddenGroups', JSON.stringify(hidden));
}

async function loadInitialData() {
  renderSelectOptions();

  state.maps = await listMaps();
  let targetMapId = (await getSetting('activeMapId')) || null;

  if (state.maps.length === 0) {
    showUploadScreen();
  } else {
    if (!state.maps.find(m => m.id === targetMapId)) {
      targetMapId = state.maps[0].id;
    }
    await loadMapData(targetMapId);
  }
}

async function loadMapData(mapId) {
  ui.loader.classList.remove('hidden');
  const mapData = await getMap(mapId);
  if (!mapData) {
    ui.loader.classList.add('hidden');
    return showUploadScreen();
  }

  state.activeMapId = mapId;
  state.activeMapImage = mapData.image;
  await setSetting('activeMapId', mapId);

  state.pins = await listPins(mapId);
  state.areas = await listAreas(mapId);
  renderSelectOptions();

  ui.mapImage.src = state.activeMapImage;
  ui.uploadScreen.classList.add('hidden');
  ui.mapScreen.classList.remove('hidden');
  
  updateMapSelector();
  
  ui.mapImage.onload = () => {
    state.transform = { x: 0, y: 0, scale: 1 };
    updateTransform();
    renderFilterPanel();
    renderPins();
    renderAreas();
    ui.loader.classList.add('hidden');
  };
}

function showUploadScreen() {
  updateMapSelector();
  ui.uploadScreen.classList.remove('hidden');
  ui.mapScreen.classList.add('hidden');
  state.activeMapId = null;
  state.activeMapImage = null;
  state.pins = [];
  state.areas = [];
  try{ ui.mapImage.src = ''; }catch(e){} 
}

function updateMapSelector() {
  ui.mapSelector.innerHTML = '';
  state.maps.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id === state.activeMapId) opt.selected = true;
    ui.mapSelector.appendChild(opt);
  });
  
  const addOpt = document.createElement('option');
  addOpt.value = '__add_new__';
  addOpt.textContent = '+ 新しいマップを追加';
  ui.mapSelector.appendChild(addOpt);
}

ui.mapSelector.addEventListener('change', async (e) => {
  const val = e.target.value;
  if (val === '__add_new__') {
    state.activeMapId = null;
    showUploadScreen();
  } else {
    await loadMapData(val);
  }
});

function saveLocalSettings() {
  localStorage.setItem('tm_customSpecies', JSON.stringify(state.customSpecies));
  localStorage.setItem('tm_speciesColors', JSON.stringify(state.speciesColors));
  localStorage.setItem('tm_customGroups', JSON.stringify(state.customGroups));
  localStorage.setItem('tm_hiddenGroups', JSON.stringify(state.hiddenGroups));
}

// 組み込みの樹種 (value は保存済みデータとの互換のため変更しない)
const BUILTIN_SPECIES = [
  { value: 'shirakashi', label: 'シラカシ' },
  { value: 'keyaki', label: 'ケヤキ' }
];

// 樹種・グループのプルダウンを、現在の状態から丸ごと作り直す。
// 選択肢が増える経路 (新規追加 / マップ切替 / インポート / 将来の他ユーザーの追加) は
// すべてこの関数を呼ぶだけでよい。作り直しても現在の選択は保つ。
function renderSelectOptions() {
  const species = [
    ...BUILTIN_SPECIES,
    ...state.customSpecies.map(sp => ({ value: sp, label: sp })),
    ...state.pins.map(p => ({ value: p.species, label: p.species }))
  ];
  fillSelect(ui.treeSpecies, species, '+ 新しい種類を追加...');

  const groups = getAllGroups().map(g => ({
    value: g,
    label: g === 'デフォルト' ? 'デフォルト (未分類)' : g
  }));
  fillSelect(ui.pinGroupSelect, groups, '+ 新しいグループを作成...');
  fillSelect(ui.areaGroupSelect, groups, '+ 新しいグループを作成...');
}

function fillSelect(select, options, addNewLabel) {
  const current = select.value;
  const seen = new Set();
  select.innerHTML = '';
  options.forEach(({ value, label }) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
  const addOpt = document.createElement('option');
  addOpt.value = '__add_new__';
  addOpt.textContent = addNewLabel;
  select.appendChild(addOpt);

  if (current && seen.has(current)) select.value = current;
}

function collectGroups(customGroups, pins, areas) {
  const groups = new Set(['デフォルト', ...customGroups]);
  pins.forEach(p => groups.add(p.group));
  areas.forEach(a => groups.add(a.group));
  groups.delete(undefined);
  groups.delete('');
  return Array.from(groups);
}

function getAllGroups() {
  return collectGroups(state.customGroups, state.pins, state.areas);
}

function isGroupVisible(group) {
  return !state.hiddenGroups.includes(group);
}

function showGroup(group) {
  state.hiddenGroups = state.hiddenGroups.filter(g => g !== group);
}

function renderFilterPanel() {
  ui.filterList.innerHTML = '';
  const allGroups = getAllGroups();

  allGroups.forEach(grp => {
    const label = document.createElement('label');
    label.className = 'filter-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = grp;
    checkbox.checked = isGroupVisible(grp);

    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        showGroup(grp);
      } else if (!state.hiddenGroups.includes(grp)) {
        state.hiddenGroups.push(grp);
      }
      saveLocalSettings();
      renderPins();
      renderAreas();
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(grp));
    ui.filterList.appendChild(label);
  });
}

ui.filterBtn.addEventListener('click', () => {
  ui.filterPanel.classList.toggle('hidden');
  ui.filterBtn.classList.toggle('active');
});

// Map Delete
ui.resetMapBtn.addEventListener('click', async () => {
  if (!state.activeMapId) return;
  if (confirm('このマップ画像とすべてのピン・生垣エリアを完全に削除しますか？\n（この操作は取り消せません）')) {
    ui.loader.classList.remove('hidden');
    await deleteMap(state.activeMapId);

    state.maps = await listMaps();
    if (state.maps.length > 0) {
      await loadMapData(state.maps[0].id);
    } else {
      await removeSetting('activeMapId');
      showUploadScreen();
    }
    ui.loader.classList.add('hidden');
  }
});

// --- Settings & Data Management (Export/Import) ---
function openSettings() {
  ui.settingsModal.classList.remove('hidden');
}

ui.settingsBtn.addEventListener('click', openSettings);
if(ui.uploadSettingsBtn) ui.uploadSettingsBtn.addEventListener('click', openSettings);

ui.settingsCancel.addEventListener('click', () => {
  ui.settingsModal.classList.add('hidden');
});
ui.settingsModal.addEventListener('click', (e) => {
  if (e.target === ui.settingsModal) ui.settingsModal.classList.add('hidden');
});

ui.exportDataBtn.addEventListener('click', async () => {
  ui.loader.classList.remove('hidden');
  try {
    const { maps, pins, areas } = await exportAll();

    const exportObj = {
      version: '1.2.0',
      timestamp: Date.now(),
      maps,
      pins,
      areas,
      settings: {
        customSpecies: state.customSpecies,
        customGroups: state.customGroups,
        speciesColors: state.speciesColors,
        hiddenGroups: state.hiddenGroups
      }
    };
    
    const dataStr = JSON.stringify(exportObj);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `treemapper_data_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    alert('データのエクスポートが完了しました。');
  } catch (err) {
    alert('エクスポートに失敗しました。');
    console.error(err);
  }
  ui.loader.classList.add('hidden');
});

ui.importDataUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  if (!confirm('現在のデータはすべて消去され、ファイルの内容で完全に上書きされます。\nよろしいですか？')) {
    e.target.value = '';
    return;
  }
  
  ui.loader.classList.remove('hidden');
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const importedData = JSON.parse(ev.target.result);
      
      if (!importedData.maps || !importedData.pins) {
        throw new Error('Invalid file format. No maps or pins array.');
      }

      await replaceAll({
        maps: importedData.maps,
        pins: importedData.pins,
        areas: importedData.areas || []
      });

      if (importedData.settings) {
        if (importedData.settings.customSpecies) localStorage.setItem('tm_customSpecies', JSON.stringify(importedData.settings.customSpecies));
        if (importedData.settings.customGroups) localStorage.setItem('tm_customGroups', JSON.stringify(importedData.settings.customGroups));
        
        if (importedData.settings.speciesColors) {
          const colors = importedData.settings.speciesColors;
          for (const key in colors) {
            if (!/^#[0-9a-fA-F]{3,6}$/.test(colors[key])) {
              delete colors[key]; 
            }
          }
          localStorage.setItem('tm_speciesColors', JSON.stringify(colors));
        }

        if (Array.isArray(importedData.settings.hiddenGroups)) {
          localStorage.setItem('tm_hiddenGroups', JSON.stringify(importedData.settings.hiddenGroups));
        } else if (Array.isArray(importedData.settings.visibleGroups)) {
          // 旧形式 (v1.1.0 以前) のファイル: 表示グループ → 隠すグループに変換する
          const s = importedData.settings;
          const known = collectGroups(s.customGroups || [], importedData.pins, importedData.areas || []);
          const hidden = known.filter(g => !s.visibleGroups.includes(g));
          localStorage.setItem('tm_hiddenGroups', JSON.stringify(hidden));
        }
      }

      if (importedData.maps && importedData.maps.length > 0) {
        await setSetting('activeMapId', importedData.maps[0].id);
      }

      alert('データのインポートが完了しました。アプリを再読み込みします。');
      window.location.reload();
      
    } catch (err) {
      alert('ファイルの読み込みに失敗しました。Tree Mapper用のデータファイルか確認してください。');
      console.error(err);
      ui.loader.classList.add('hidden');
      e.target.value = '';
    }
  };
  reader.onerror = () => {
    alert('ファイルの読み取りエラーが発生しました。');
    ui.loader.classList.add('hidden');
  };
  reader.readAsText(file);
});

// --- Map Upload ---
ui.mapUploadBtn.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  ui.loader.classList.remove('hidden');
  try {
    const mapName = prompt('マップの名前を入力してください', `マップ ${state.maps.length + 1}`) || `Map ${state.maps.length + 1}`;
    const dataUrl = await compressImage(file, 2048, 0.8); 
    
    const mapId = newId('map');
    await saveMap({ id: mapId, name: mapName, image: dataUrl });

    state.maps = await listMaps();
    await loadMapData(mapId);
  } catch(err) {
    alert('画像の処理に失敗しました。');
    console.error(err);
  }
  ui.loader.classList.add('hidden');
  e.target.value = ''; 
});

// --- Pan and Zoom Logic ---
let isDragging = false, startPos = { x: 0, y: 0 }, lastTouches = [];
let touchStartPos = { x: 0, y: 0 };

function updateTransform() {
  ui.mapWrapper.style.transform = `translate(${state.transform.x}px, ${state.transform.y}px) scale(${state.transform.scale})`;
}

function getDistance(t1, t2) {
  const dx = t1.clientX - t2.clientX; const dy = t1.clientY - t2.clientY;
  return Math.hypot(dx, dy);
}

function getCenter(touches) {
  if (touches.length === 1) return { x: touches[0].clientX, y: touches[0].clientY };
  return { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 };
}

ui.viewerContainer.addEventListener('touchstart', (e) => {
  if (e.target.closest('.glass-header') || e.target.closest('.hedge-submenu') || e.target.closest('.filter-panel') || e.target.closest('.drawing-controls')) return;
  if (e.touches.length <= 2) e.preventDefault(); 
  isDragging = true; state.hasMoved = false;
  lastTouches = Array.from(e.touches);
  if (lastTouches.length === 1) {
    touchStartPos = { x: lastTouches[0].clientX, y: lastTouches[0].clientY };
  }
}, { passive: false });

ui.viewerContainer.addEventListener('touchmove', (e) => {
  if (!isDragging) return;
  e.preventDefault();
  const currentTouches = Array.from(e.touches);

  if (currentTouches.length === 1 && lastTouches.length === 1) {
    if (!state.hasMoved) {
      const dist = Math.hypot(currentTouches[0].clientX - touchStartPos.x, currentTouches[0].clientY - touchStartPos.y);
      if (dist > 8) state.hasMoved = true;
    }
    state.transform.x += currentTouches[0].clientX - lastTouches[0].clientX;
    state.transform.y += currentTouches[0].clientY - lastTouches[0].clientY;
  } else if (currentTouches.length === 2 && lastTouches.length === 2) {
    state.hasMoved = true;
    const currentDist = getDistance(currentTouches[0], currentTouches[1]);
    const lastDist = getDistance(lastTouches[0], lastTouches[1]);
    let newScale = state.transform.scale * (currentDist / lastDist);
    newScale = Math.max(0.1, Math.min(newScale, 10)); 
    const actualScaleDelta = newScale / state.transform.scale;
    state.transform.scale = newScale;

    const cc = getCenter(currentTouches);
    const lc = getCenter(lastTouches);
    state.transform.x = cc.x - (cc.x - state.transform.x) * actualScaleDelta + (cc.x - lc.x);
    state.transform.y = cc.y - (cc.y - state.transform.y) * actualScaleDelta + (cc.y - lc.y);
  }
  
  lastTouches = currentTouches;
  updateTransform();
}, { passive: false });

ui.viewerContainer.addEventListener('touchend', (e) => {
  lastTouches = Array.from(e.touches);
  if (e.touches.length === 0) {
    const wasDragging = isDragging;
    isDragging = false;
    if (wasDragging && !state.hasMoved && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];

      // 生垣モード中は頂点追加を最優先
      if (state.hedgeMode) {
        const x = (touch.clientX - state.transform.x) / state.transform.scale;
        const y = (touch.clientY - state.transform.y) / state.transform.scale;
        handleHedgePointAdd(x, y);
        return;
      }

      // タップされた要素から直接判定 (SVG要素の closest が最も確実)
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (target) {
        // ピンのタップチェック
        const pinEl = target.closest('.map-pin');
        if (pinEl && pinEl.dataset.pinId) {
          openModal(pinEl.dataset.pinId);
          return;
        }

        // エリアのタップチェック (polyline/polygon → 親の g[data-area-id])
        const areaEl = target.closest('[data-area-id]');
        if (areaEl) {
          const areaId = areaEl.getAttribute('data-area-id');
          if (areaId) {
            openAreaModal(areaId);
            return;
          }
        }
      }

      // 何もヒットしなかった場合は新規ピン追加
      handleMapTap(touch.clientX, touch.clientY);
    }
  }
});

ui.viewerContainer.addEventListener('mousedown', (e) => {
  if (e.target.closest('.glass-header') || e.target.closest('.filter-panel') || e.target.closest('.hedge-submenu') || e.target.closest('.drawing-controls')) return;
  isDragging = true; state.hasMoved = false; 
  startPos = { x: e.clientX, y: e.clientY };
  touchStartPos = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  if (!state.hasMoved) {
    const dist = Math.hypot(e.clientX - touchStartPos.x, e.clientY - touchStartPos.y);
    if (dist > 8) state.hasMoved = true;
  }
  state.transform.x += e.clientX - startPos.x;
  state.transform.y += e.clientY - startPos.y;
  startPos = { x: e.clientX, y: e.clientY };
  updateTransform();
});

window.addEventListener('mouseup', (e) => {
  if (!isDragging) return;
  isDragging = false;
  if (!state.hasMoved) {
    // 生垣モード中は頂点追加を最優先
    if (state.hedgeMode) {
      const x = (e.clientX - state.transform.x) / state.transform.scale;
      const y = (e.clientY - state.transform.y) / state.transform.scale;
      handleHedgePointAdd(x, y);
      return;
    }

    // ピンのタップチェック
    const pinEl = e.target.closest('.map-pin');
    if (pinEl && pinEl.dataset.pinId) {
      openModal(pinEl.dataset.pinId);
      return;
    }

    // エリアのタップチェック
    const areaEl = e.target.closest('[data-area-id]');
    if (areaEl) {
      const areaId = areaEl.getAttribute('data-area-id');
      if (areaId) {
        openAreaModal(areaId);
        return;
      }
    }

    // 空白クリック → 新規ピン追加
    const x = (e.clientX - state.transform.x) / state.transform.scale;
    const y = (e.clientY - state.transform.y) / state.transform.scale;
    openModal(null, { x, y });
  }
});

ui.viewerContainer.addEventListener('wheel', (e) => {
  if (e.target.closest('.filter-panel') || e.target.closest('.glass-header')) return;
  e.preventDefault();
  let newScale = Math.max(0.1, Math.min(state.transform.scale * (e.deltaY < 0 ? 1.1 : 0.9), 10));
  const actualScaleDelta = newScale / state.transform.scale;
  state.transform.x = e.clientX - (e.clientX - state.transform.x) * actualScaleDelta;
  state.transform.y = e.clientY - (e.clientY - state.transform.y) * actualScaleDelta;
  state.transform.scale = newScale;
  updateTransform();
}, { passive: false });

// --- Interactions ---
function handleMapTap(clientX, clientY) {
  // 空白タップ: 新規ピン追加
  const x = (clientX - state.transform.x) / state.transform.scale;
  const y = (clientY - state.transform.y) / state.transform.scale;
  openModal(null, { x, y });
}

function getPinColor(species) {
  const color = state.speciesColors[species] || '#8b5cf6';
  if (!/^#[0-9a-fA-F]{3,6}$/.test(color)) return '#8b5cf6';
  return color;
}

function getPinSVG(color) {
  return `<svg viewBox="0 0 24 24" fill="${color}" xmlns="http://www.w3.org/2000/svg">
    <path fill-rule="evenodd" clip-rule="evenodd" stroke="white" stroke-width="0.5" d="M12 2C7.58172 2 4 5.58172 4 10C4 14.1561 7.15197 18.0673 10.9839 21.3653C11.5303 21.8359 12.4697 21.8359 13.0161 21.3653C16.848 18.0673 20 14.1561 20 10C20 5.58172 16.4183 2 12 2ZM12 13C13.6569 13 15 11.6569 15 10C15 8.34315 13.6569 7 12 7C10.3431 7 9 8.34315 9 10C9 11.6569 10.3431 13 12 13Z"/>
    <circle cx="12" cy="10" r="3" fill="rgba(255,255,255,0.9)" />
  </svg>`;
}

function renderPins() {
  ui.pinsContainer.innerHTML = '';
  state.pins.forEach(pin => {
    if (!isGroupVisible(pin.group)) return;

    const el = document.createElement('div');
    el.className = 'map-pin';
    el.dataset.pinId = pin.id;
    el.style.left = `${pin.x}px`;
    el.style.top = `${pin.y}px`;
    el.title = `${pin.group} - ${pin.species}`;
    
    let photoBadge = pin.photo ? `<div style="position:absolute; top:-4px; right:-4px; width:10px; height:10px; background:#ef4444; border-radius:50%; border:2px solid white;"></div>` : '';
    
    el.innerHTML = getPinSVG(getPinColor(pin.species)) + photoBadge;

    ui.pinsContainer.appendChild(el);
  });
}

// --- Hedge / Area Rendering & Drawing ---
function renderAreas() {
  ui.areasSvg.innerHTML = '';

  state.areas.forEach(area => {
    if (!isGroupVisible(area.group)) return;

    const color = /^#[0-9a-fA-F]{3,6}$/.test(area.color) ? area.color : '#22c55e';
    const pointsStr = area.points.map(p => `${p.x},${p.y}`).join(' ');

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'area-shape');
    group.setAttribute('data-area-id', area.id);

    if (area.type === 'line') {
      // タップ判定を広げるための透明な太い線 (幅 36px)
      const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      hitLine.setAttribute('points', pointsStr);
      hitLine.setAttribute('stroke', 'transparent');
      hitLine.setAttribute('stroke-width', '36');
      hitLine.setAttribute('fill', 'none');
      hitLine.setAttribute('stroke-linecap', 'round');
      hitLine.setAttribute('stroke-linejoin', 'round');
      hitLine.setAttribute('class', 'area-hit-line');
      group.appendChild(hitLine);

      // 画面に表示する線 (幅 4px)
      const visibleLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      visibleLine.setAttribute('points', pointsStr);
      visibleLine.setAttribute('stroke', color);
      visibleLine.setAttribute('stroke-width', '4');
      visibleLine.setAttribute('fill', 'none');
      visibleLine.setAttribute('stroke-linecap', 'round');
      visibleLine.setAttribute('stroke-linejoin', 'round');
      visibleLine.setAttribute('class', 'area-visible-shape');
      group.appendChild(visibleLine);
    } else {
      // 面 (polygon)
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', pointsStr);
      poly.setAttribute('stroke', color);
      poly.setAttribute('stroke-width', '2.5');
      poly.setAttribute('fill', color);
      poly.setAttribute('fill-opacity', '0.25');
      poly.setAttribute('stroke-linejoin', 'round');
      poly.setAttribute('class', 'area-polygon area-visible-shape');
      group.appendChild(poly);
    }

    // ラベル表示（名前がある場合）
    if (area.label) {
      const firstPt = area.points[0];
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', firstPt.x);
      text.setAttribute('y', firstPt.y - 8);
      text.setAttribute('fill', color);
      text.setAttribute('font-size', '12');
      text.setAttribute('font-weight', 'bold');
      text.setAttribute('paint-order', 'stroke');
      text.setAttribute('stroke', '#ffffff');
      text.setAttribute('stroke-width', '3');
      text.setAttribute('stroke-linejoin', 'round');
      text.setAttribute('style', 'pointer-events: none; user-select: none;');
      text.textContent = area.label;
      group.appendChild(text);
    }

    ui.areasSvg.appendChild(group);
  });

  // Render in-progress drawing preview
  if (state.hedgeMode && state.currentPoints.length > 0) {
    const previewPointsStr = state.currentPoints.map(p => `${p.x},${p.y}`).join(' ');
    
    let previewShape;
    if (state.hedgeMode === 'line') {
      previewShape = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      previewShape.setAttribute('points', previewPointsStr);
      previewShape.setAttribute('stroke', '#22c55e');
      previewShape.setAttribute('stroke-width', '3');
      previewShape.setAttribute('fill', 'none');
      previewShape.setAttribute('class', 'drawing-active-line');
    } else {
      previewShape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      previewShape.setAttribute('points', previewPointsStr);
      previewShape.setAttribute('stroke', '#22c55e');
      previewShape.setAttribute('stroke-width', '2');
      previewShape.setAttribute('fill', '#22c55e');
      previewShape.setAttribute('fill-opacity', '0.2');
      previewShape.setAttribute('class', 'drawing-active-line');
    }
    ui.areasSvg.appendChild(previewShape);

    // Render vertex circles
    state.currentPoints.forEach((pt, idx) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', pt.x);
      circle.setAttribute('cy', pt.y);
      circle.setAttribute('r', '5');
      circle.setAttribute('fill', idx === 0 ? '#15803d' : '#22c55e');
      circle.setAttribute('stroke', 'white');
      circle.setAttribute('stroke-width', '1.5');
      ui.areasSvg.appendChild(circle);
    });
  }
}

// Hedge Mode Controls
ui.hedgeBtn.addEventListener('click', () => {
  if (state.hedgeMode) {
    exitHedgeMode();
  } else {
    ui.hedgeSubmenu.classList.toggle('hidden');
    ui.hedgeBtn.classList.toggle('active');
  }
});

ui.hedgeSubmenuCancel.addEventListener('click', () => {
  ui.hedgeSubmenu.classList.add('hidden');
  ui.hedgeBtn.classList.remove('active');
});

ui.hedgeLineBtn.addEventListener('click', () => {
  startHedgeMode('line');
});

ui.hedgePolygonBtn.addEventListener('click', () => {
  startHedgeMode('polygon');
});

function startHedgeMode(type) {
  state.hedgeMode = type;
  state.currentPoints = [];
  ui.hedgeSubmenu.classList.add('hidden');
  ui.mainHeader.classList.add('hedge-mode');
  ui.hedgeBtn.classList.add('active');
  ui.mapHint.classList.add('hidden');
  ui.drawingHint.classList.remove('hidden');
  ui.drawingControls.classList.remove('hidden');

  if (type === 'line') {
    ui.drawingHint.textContent = '📏 直線モード: 始点をタップしてください';
    ui.drawingConfirmBtn.style.display = 'none';
  } else {
    ui.drawingHint.textContent = '⬡ 面モード: 頂点を順番にタップしてください (3点以上で確定可能)';
    ui.drawingConfirmBtn.style.display = 'inline-flex';
    ui.drawingConfirmBtn.disabled = true;
    ui.drawingConfirmBtn.style.opacity = '0.5';
  }
  renderAreas();
}

function exitHedgeMode() {
  state.hedgeMode = null;
  state.currentPoints = [];
  ui.mainHeader.classList.remove('hedge-mode');
  ui.hedgeBtn.classList.remove('active');
  ui.drawingHint.classList.add('hidden');
  ui.drawingControls.classList.add('hidden');
  ui.mapHint.classList.remove('hidden');
  renderAreas();
}

function handleHedgePointAdd(x, y) {
  state.currentPoints.push({ x, y });

  if (state.hedgeMode === 'line') {
    if (state.currentPoints.length === 1) {
      ui.drawingHint.textContent = '📏 終点をタップしてください';
      renderAreas();
    } else if (state.currentPoints.length === 2) {
      renderAreas();
      setTimeout(() => openAreaModal(null), 100);
    }
  } else if (state.hedgeMode === 'polygon') {
    const count = state.currentPoints.length;
    if (count < 3) {
      ui.drawingHint.textContent = `⬡ ${count}点指定中... (あと${3 - count}点以上必要)`;
      ui.drawingConfirmBtn.disabled = true;
      ui.drawingConfirmBtn.style.opacity = '0.5';
    } else {
      ui.drawingHint.textContent = `⬡ ${count}点指定中: 続けるか[✓ 確定]を押してください`;
      ui.drawingConfirmBtn.disabled = false;
      ui.drawingConfirmBtn.style.opacity = '1';
    }
    renderAreas();
  }
}

ui.drawingCancelBtn.addEventListener('click', exitHedgeMode);

ui.drawingConfirmBtn.addEventListener('click', () => {
  if (state.hedgeMode === 'polygon' && state.currentPoints.length >= 3) {
    openAreaModal(null);
  }
});

// Area Modal & Palette
function renderAreaColorPalette() {
  ui.areaColorPalette.innerHTML = '';
  PALETTE_COLORS.forEach(color => {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = color;
    if (color === state.selectedAreaColor) swatch.classList.add('selected');

    swatch.addEventListener('click', () => {
      state.selectedAreaColor = color;
      renderAreaColorPalette();
    });

    ui.areaColorPalette.appendChild(swatch);
  });
}

function openAreaModal(areaId = null) {
  // 対象のエリアが既に無い (他の人が削除した等) 場合は、モーダルを開かず表示を更新する
  const area = areaId ? state.areas.find(a => a.id === areaId) : null;
  if (areaId && !area) {
    renderAreas();
    return;
  }

  state.activeAreaId = areaId;
  ui.areaModalBackdrop.classList.remove('hidden');
  ui.areaNewGroupWrapper.style.display = 'none';

  if (areaId) {
    ui.areaModalTitle.textContent = 'エリアの確認・編集';
    ui.areaLabel.value = area.label || '';
    ui.areaGroupSelect.value = area.group;
    state.selectedAreaColor = area.color || '#22c55e';
    ui.areaDeleteGroup.classList.remove('hidden');
  } else {
    ui.areaModalTitle.textContent = state.hedgeMode === 'line' ? '生垣 (直線) を保存' : '生垣 (面) を保存';
    ui.areaForm.reset();
    if (state.customGroups.length > 0) {
      ui.areaGroupSelect.value = state.customGroups[state.customGroups.length - 1];
    } else {
      ui.areaGroupSelect.value = 'デフォルト';
    }
    state.selectedAreaColor = '#22c55e';
    ui.areaDeleteGroup.classList.add('hidden');
  }

  renderAreaColorPalette();
}

function closeAreaModal() {
  ui.areaModalBackdrop.classList.add('hidden');
  state.activeAreaId = null;
}

ui.areaModalCancel.addEventListener('click', () => {
  closeAreaModal();
  if (state.hedgeMode) exitHedgeMode();
});

ui.areaModalBackdrop.addEventListener('click', (e) => {
  if (e.target === ui.areaModalBackdrop) {
    closeAreaModal();
    if (state.hedgeMode) exitHedgeMode();
  }
});

ui.areaGroupSelect.addEventListener('change', (e) => {
  ui.areaNewGroupWrapper.style.display = e.target.value === '__add_new__' ? 'block' : 'none';
  if (e.target.value === '__add_new__') ui.areaNewGroupInput.focus();
});

ui.areaForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  let group = ui.areaGroupSelect.value;
  if (group === '__add_new__') {
    group = ui.areaNewGroupInput.value.trim();
    if (!group) return alert('グループ名を入力してください。');
    if (!state.customGroups.includes(group)) {
      state.customGroups.push(group);
    }
  }

  showGroup(group);
  saveLocalSettings();
  renderSelectOptions();

  const label = ui.areaLabel.value.trim();
  let areaData;

  if (state.activeAreaId) {
    const index = state.areas.findIndex(a => a.id === state.activeAreaId);
    if (index !== -1) {
      areaData = state.areas[index];
      areaData.group = group;
      areaData.label = label;
      areaData.color = state.selectedAreaColor;
    }
  } else {
    areaData = {
      id: newId('area'),
      mapId: state.activeMapId,
      type: state.hedgeMode,
      points: [...state.currentPoints],
      group,
      label,
      color: state.selectedAreaColor
    };
  }

  if (areaData) {
    try {
      ui.loader.classList.remove('hidden');
      await saveArea(areaData);
      if (!state.activeAreaId) {
        state.areas.push(areaData);
      }
    } catch(err) {
      console.error(err);
      alert('【保存エラー】エリアの保存に失敗しました。');
    } finally {
      ui.loader.classList.add('hidden');
    }
  }

  renderFilterPanel();
  renderAreas();
  closeAreaModal();
  exitHedgeMode();
});

ui.areaModalDelete.addEventListener('click', async () => {
  if (confirm('このエリアを削除しますか？')) {
    ui.loader.classList.remove('hidden');
    await deleteArea(state.activeAreaId);
    state.areas = state.areas.filter(a => a.id !== state.activeAreaId);
    renderAreas();
    renderFilterPanel();
    ui.loader.classList.add('hidden');
    closeAreaModal();
  }
});

// --- Pin Modal & Color Palette ---
function renderColorPalette() {
  const container = document.getElementById('species-color-palette');
  if(!container) return;
  container.innerHTML = '';
  const usedColors = Object.values(state.speciesColors);
  
  if (!state.selectedNewColor || usedColors.includes(state.selectedNewColor)) {
    const available = PALETTE_COLORS.find(c => !usedColors.includes(c));
    state.selectedNewColor = available || PALETTE_COLORS[0]; 
  }

  PALETTE_COLORS.forEach(color => {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = color;
    
    if (usedColors.includes(color)) {
      swatch.classList.add('disabled');
      swatch.title = 'すでに他の樹種で使用されています';
    } else {
      swatch.title = '色を選択';
      if (color === state.selectedNewColor) swatch.classList.add('selected');
      
      swatch.addEventListener('click', () => {
        state.selectedNewColor = color;
        renderColorPalette();
      });
    }
    
    container.appendChild(swatch);
  });
}

ui.pinPhotoInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const compressed = await compressImage(file, 800, 0.7);
    state.currentPinPhoto = compressed;
    setPhotoPreview(compressed);
  } catch(err) {
    alert('画像の処理に失敗しました。');
  }
  e.target.value = ''; 
});

ui.removePhotoBtn.addEventListener('click', () => {
  state.currentPinPhoto = null;
  setPhotoPreview(null);
});

function setPhotoPreview(src) {
  if (src) {
    ui.pinPhotoPreview.src = src;
    ui.pinPhotoPreview.classList.remove('hidden');
    ui.photoPlaceholder.classList.add('hidden');
    ui.removePhotoBtn.classList.remove('hidden');
  } else {
    ui.pinPhotoPreview.src = '';
    ui.pinPhotoPreview.classList.add('hidden');
    ui.photoPlaceholder.classList.remove('hidden');
    ui.removePhotoBtn.classList.add('hidden');
  }
}

function openModal(pinId = null, pos = null) {
  // 対象のピンが既に無い (他の人が削除した等) 場合は、モーダルを開かず表示を更新する
  const pin = pinId ? state.pins.find(p => p.id === pinId) : null;
  if (pinId && !pin) {
    renderPins();
    return;
  }

  state.activePinId = pinId;
  ui.modalBackdrop.classList.remove('hidden');
  ui.newGroupWrapper.style.display = 'none';
  ui.newSpeciesGroup.style.display = 'none';

  if (pinId) {
    ui.modalTitle.textContent = '樹木の編集';
    ui.pinGroupSelect.value = pin.group;
    ui.treeSpecies.value = pin.species;
    ui.treeLabel.value = pin.label || '';
    ui.deleteActionGroup.classList.remove('hidden');
    state.tempClickPos = null;
    
    state.currentPinPhoto = pin.photo || null;
    setPhotoPreview(state.currentPinPhoto);
  } else {
    ui.modalTitle.textContent = '樹木を追加';
    ui.pinForm.reset();
    
    if (state.customGroups.length > 0) ui.pinGroupSelect.value = state.customGroups[state.customGroups.length - 1];
    else ui.pinGroupSelect.value = 'デフォルト';

    ui.deleteActionGroup.classList.add('hidden');
    state.tempClickPos = pos;
    state.currentPinPhoto = null;
    setPhotoPreview(null);
  }
}

function closeModal() {
  ui.modalBackdrop.classList.add('hidden');
  state.activePinId = null;
  state.tempClickPos = null;
  state.currentPinPhoto = null;
}

ui.pinGroupSelect.addEventListener('change', (e) => {
  ui.newGroupWrapper.style.display = e.target.value === '__add_new__' ? 'block' : 'none';
  if (e.target.value === '__add_new__') ui.newGroupInput.focus();
});

ui.treeSpecies.addEventListener('change', (e) => {
  ui.newSpeciesGroup.style.display = e.target.value === '__add_new__' ? 'block' : 'none';
  if (e.target.value === '__add_new__') {
    ui.newSpeciesInput.focus();
    renderColorPalette();
  }
});

ui.pinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  let group = ui.pinGroupSelect.value;
  if (group === '__add_new__') {
    group = ui.newGroupInput.value.trim();
    if (!group) return alert('グループ名を入力してください。');
    if (!state.customGroups.includes(group)) {
      state.customGroups.push(group);
    }
  }

  let species = ui.treeSpecies.value;
  if (species === '__add_new__') {
    species = ui.newSpeciesInput.value.trim();
    if (!species) return alert('種類名を入力してください。');
    
    state.speciesColors[species] = state.selectedNewColor;
    if (!state.customSpecies.includes(species)) {
      state.customSpecies.push(species);
    }
  }

  showGroup(group);
  saveLocalSettings();
  renderSelectOptions();

  const label = ui.treeLabel.value.trim();
  let pinData;
  if (state.activePinId) {
    const index = state.pins.findIndex(p => p.id === state.activePinId);
    if (index !== -1) {
      pinData = state.pins[index];
      pinData.group = group;
      pinData.species = species;
      pinData.label = label;
      pinData.photo = state.currentPinPhoto;
    }
  } else if (state.tempClickPos) {
    pinData = {
      id: newId('pin'),
      mapId: state.activeMapId,
      x: state.tempClickPos.x,
      y: state.tempClickPos.y,
      group,
      species,
      label,
      photo: state.currentPinPhoto
    };
  }
  
  if (pinData) {
    try {
      ui.loader.classList.remove('hidden');
      await savePin(pinData);
      
      if (!state.activePinId && state.tempClickPos) {
        state.pins.push(pinData);
      }
    } catch(err) {
      console.error(err);
      alert('【保存エラー】端末の容量不足、またはLINE等のアプリ内ブラウザ制限の可能性があります。SafariやChromeブラウザで開き直してください。');
    } finally {
      ui.loader.classList.add('hidden');
    }
  }

  renderFilterPanel();
  renderPins();
  closeModal();
});

ui.modalCancel.addEventListener('click', closeModal);
ui.modalBackdrop.addEventListener('click', (e) => { if (e.target === ui.modalBackdrop) closeModal(); });

ui.modalDelete.addEventListener('click', async () => {
  if (confirm('このピンを削除しますか？')) {
    ui.loader.classList.remove('hidden');
    await deletePin(state.activePinId);
    state.pins = state.pins.filter(p => p.id !== state.activePinId);
    renderPins();
    ui.loader.classList.add('hidden');
    closeModal();
  }
});

// Run Boot
init();
