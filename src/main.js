// --- IndexedDB Wrapper ---
const DB_NAME = 'TreeMapperDB';
const DB_VERSION = 1;

let db;
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('maps')) {
        db.createObjectStore('maps', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pins')) {
        const pinStore = db.createObjectStore('pins', { keyPath: 'id' });
        pinStore.createIndex('mapId', 'mapId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve();
    };
    request.onerror = (e) => reject(e);
  });
}

function saveDBItem(storeName, item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(item);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

function getDBItem(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e);
  });
}

function getAllDBItems(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e);
  });
}

function getPinsByMap(mapId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pins', 'readonly');
    const store = tx.objectStore('pins');
    const index = store.index('mapId');
    const request = index.getAll(mapId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e);
  });
}

function deleteDBItem(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

function clearDBStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

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
  
  // Header / Map Selector
  mapSelector: document.getElementById('map-selector'),
  filterBtn: document.getElementById('filter-btn'),
  filterPanel: document.getElementById('filter-panel'),
  filterList: document.getElementById('filter-list'),

  // Settings / Data Management
  settingsBtn: document.getElementById('settings-btn'),
  uploadSettingsBtn: document.getElementById('upload-settings-btn'),
  settingsModal: document.getElementById('settings-modal-backdrop'),
  settingsCancel: document.getElementById('settings-cancel'),
  exportDataBtn: document.getElementById('export-data-btn'),
  importDataUpload: document.getElementById('import-data-upload'),

  // Modal
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

  // Photo Ext
  pinPhotoInput: document.getElementById('pin-photo'),
  pinPhotoPreview: document.getElementById('pin-photo-preview'),
  photoPlaceholder: document.getElementById('photo-placeholder'),
  removePhotoBtn: document.getElementById('remove-photo-btn')
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
  customSpecies: JSON.parse(localStorage.getItem('tm_customSpecies') || '[]'),
  speciesColors: Object.assign({
    'shirakashi': '#10b981',
    'keyaki': '#f59e0b'
  }, JSON.parse(localStorage.getItem('tm_speciesColors') || '{}')),
  customGroups: JSON.parse(localStorage.getItem('tm_customGroups') || '[]'),
  visibleGroups: JSON.parse(localStorage.getItem('tm_visibleGroups') || '["デフォルト"]'),
  transform: { x: 0, y: 0, scale: 1 },
  activePinId: null,
  tempClickPos: null,
  currentPinPhoto: null,
  selectedNewColor: null
};

// --- Boot ---
async function init() {
  ui.loader.classList.remove('hidden');
  try {
    await initDB();
    await checkMigration();
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
    const mapId = 'map_' + Date.now();
    const newMap = { id: mapId, name: '最初のマップ', image: oldMapSrc, createdAt: Date.now() };
    await saveDBItem('maps', newMap);

    const oldPins = JSON.parse(localStorage.getItem('tm_pins') || '[]');
    for (const pin of oldPins) {
      if (!pin.group) pin.group = 'デフォルト';
      pin.mapId = mapId;
      await saveDBItem('pins', pin);
    }
    await saveDBItem('settings', { key: 'activeMapId', value: mapId });
  }
  localStorage.setItem('tm_migrated', 'true');
}

async function loadInitialData() {
  loadCustomOptions();

  state.maps = await getAllDBItems('maps');
  let activeMapSetting = await getDBItem('settings', 'activeMapId');
  let targetMapId = activeMapSetting ? activeMapSetting.value : null;

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
  const mapData = await getDBItem('maps', mapId);
  if (!mapData) {
    ui.loader.classList.add('hidden');
    return showUploadScreen(); 
  }

  state.activeMapId = mapId;
  state.activeMapImage = mapData.image;
  await saveDBItem('settings', { key: 'activeMapId', value: mapId });

  state.pins = await getPinsByMap(mapId);

  ui.mapImage.src = state.activeMapImage;
  ui.uploadScreen.classList.add('hidden');
  ui.mapScreen.classList.remove('hidden');
  
  updateMapSelector();
  
  ui.mapImage.onload = () => {
    state.transform = { x: 0, y: 0, scale: 1 };
    updateTransform();
    renderFilterPanel();
    renderPins();
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
  localStorage.setItem('tm_visibleGroups', JSON.stringify(state.visibleGroups));
}

function loadCustomOptions() {
  state.customSpecies.forEach(sp => {
    if (!ui.treeSpecies.querySelector(`option[value="${sp}"]`)) {
      const opt = document.createElement('option');
      opt.value = sp; opt.textContent = sp;
      ui.treeSpecies.insertBefore(opt, ui.treeSpecies.lastElementChild);
    }
  });

  state.customGroups.forEach(grp => {
    if (!ui.pinGroupSelect.querySelector(`option[value="${grp}"]`)) {
      const opt = document.createElement('option');
      opt.value = grp; opt.textContent = grp;
      ui.pinGroupSelect.insertBefore(opt, ui.pinGroupSelect.lastElementChild);
    }
  });
}

function getAllGroups() {
  const groups = new Set(['デフォルト', ...state.customGroups]);
  state.pins.forEach(p => groups.add(p.group));
  return Array.from(groups);
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
    
    if (state.visibleGroups.includes(grp)) {
      checkbox.checked = true;
    } else if (!localStorage.getItem('tm_visibleGroups')) {
      checkbox.checked = true;
      state.visibleGroups.push(grp);
    }

    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        if (!state.visibleGroups.includes(grp)) state.visibleGroups.push(grp);
      } else {
        state.visibleGroups = state.visibleGroups.filter(g => g !== grp);
      }
      saveLocalSettings();
      renderPins();
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
  if (confirm('このマップ画像とすべてのピンを完全に削除しますか？\n（この操作は取り消せません）')) {
    ui.loader.classList.remove('hidden');
    const pins = await getPinsByMap(state.activeMapId);
    for(const p of pins) { await deleteDBItem('pins', p.id); }
    await deleteDBItem('maps', state.activeMapId);
    
    state.maps = await getAllDBItems('maps');
    if (state.maps.length > 0) {
      await loadMapData(state.maps[0].id);
    } else {
      await deleteDBItem('settings', 'activeMapId');
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
    const allMaps = await getAllDBItems('maps');
    const allPins = await getAllDBItems('pins');
    
    const exportObj = {
      version: '1.0.0',
      timestamp: Date.now(),
      maps: allMaps,
      pins: allPins,
      settings: {
        customSpecies: state.customSpecies,
        customGroups: state.customGroups,
        speciesColors: state.speciesColors,
        visibleGroups: state.visibleGroups
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

      await clearDBStore('maps');
      await clearDBStore('pins');
      await clearDBStore('settings');

      for (const map of importedData.maps) {
        await saveDBItem('maps', map);
      }
      for (const pin of importedData.pins) {
        await saveDBItem('pins', pin);
      }

      if (importedData.settings) {
        if (importedData.settings.customSpecies) localStorage.setItem('tm_customSpecies', JSON.stringify(importedData.settings.customSpecies));
        if (importedData.settings.customGroups) localStorage.setItem('tm_customGroups', JSON.stringify(importedData.settings.customGroups));
        if (importedData.settings.speciesColors) localStorage.setItem('tm_speciesColors', JSON.stringify(importedData.settings.speciesColors));
        if (importedData.settings.visibleGroups) localStorage.setItem('tm_visibleGroups', JSON.stringify(importedData.settings.visibleGroups));
      }
      
      if (importedData.maps && importedData.maps.length > 0) {
        await saveDBItem('settings', { key: 'activeMapId', value: importedData.maps[0].id });
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
    
    const mapId = 'map_' + Date.now();
    const newMap = { id: mapId, name: mapName, image: dataUrl, createdAt: Date.now() };
    await saveDBItem('maps', newMap);
    
    state.maps.push({ id: mapId, name: mapName });
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
  if (e.target.closest('.map-pin') || e.target.closest('.glass-header')) return;
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
    isDragging = false;
    if (!state.hasMoved && e.changedTouches.length === 1) handleMapClick(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  }
});

ui.viewerContainer.addEventListener('mousedown', (e) => {
  if (e.target.closest('.map-pin') || e.target.closest('.glass-header') || e.target.closest('.filter-panel')) return;
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
  if (!state.hasMoved) handleMapClick(e.clientX, e.clientY);
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
function handleMapClick(clientX, clientY) {
  const rect = ui.mapWrapper.getBoundingClientRect();
  const x = (clientX - state.transform.x) / state.transform.scale;
  const y = (clientY - state.transform.y) / state.transform.scale;
  openModal(null, { x, y });
}

function getPinColor(species) {
  return state.speciesColors[species] || '#8b5cf6'; // fallback
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
    if (!state.visibleGroups.includes(pin.group)) return;

    const el = document.createElement('div');
    el.className = 'map-pin';
    el.style.left = `${pin.x}px`;
    el.style.top = `${pin.y}px`;
    el.title = `${pin.group} - ${pin.species}`;
    
    let photoBadge = pin.photo ? `<div style="position:absolute; top:-4px; right:-4px; width:10px; height:10px; background:#ef4444; border-radius:50%; border:2px solid white;"></div>` : '';
    
    el.innerHTML = getPinSVG(getPinColor(pin.species)) + photoBadge;
    
    el.addEventListener('click', (e) => { e.stopPropagation(); openModal(pin.id); });
    el.addEventListener('touchstart', (e) => e.stopPropagation(), {passive: true});
    el.addEventListener('mousedown', (e) => e.stopPropagation());

    ui.pinsContainer.appendChild(el);
  });
}

// --- Modal & Color Palette ---
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
        renderColorPalette(); // re-render to update outline
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
  state.activePinId = pinId;
  ui.modalBackdrop.classList.remove('hidden');
  ui.newGroupWrapper.style.display = 'none';
  ui.newSpeciesGroup.style.display = 'none';
  
  if (pinId) {
    const pin = state.pins.find(p => p.id === pinId);
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
    renderColorPalette(); // Generate palette logic
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
      const opt = document.createElement('option');
      opt.value = group; opt.textContent = group;
      ui.pinGroupSelect.insertBefore(opt, ui.pinGroupSelect.lastElementChild);
      saveLocalSettings();
      renderFilterPanel();
    }
  }

  let species = ui.treeSpecies.value;
  if (species === '__add_new__') {
    species = ui.newSpeciesInput.value.trim();
    if (!species) return alert('種類名を入力してください。');
    
    // Save chosen color to global lookup
    state.speciesColors[species] = state.selectedNewColor;
    saveLocalSettings();

    if (!state.customSpecies.includes(species)) {
      state.customSpecies.push(species);
      const opt = document.createElement('option');
      opt.value = species; opt.textContent = species;
      ui.treeSpecies.insertBefore(opt, ui.treeSpecies.lastElementChild);
      saveLocalSettings();
    }
  }
  
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
      id: Date.now().toString(),
      mapId: state.activeMapId,
      x: state.tempClickPos.x,
      y: state.tempClickPos.y,
      group,
      species,
      label,
      photo: state.currentPinPhoto
    };
    state.pins.push(pinData);
  }
  
  if (pinData) {
    ui.loader.classList.remove('hidden');
    await saveDBItem('pins', pinData);
    ui.loader.classList.add('hidden');
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
    await deleteDBItem('pins', state.activePinId);
    state.pins = state.pins.filter(p => p.id !== state.activePinId);
    renderPins();
    ui.loader.classList.add('hidden');
    closeModal();
  }
});

// Run Boot
init();
