// 写真の拡大表示 (全画面)。ピンチ / ホイールで拡大、ドラッグで移動、ダブルタップで 1倍 ⇄ 2.5倍。
// 閉じる: ✕ボタン、Esc、拡大していない状態で背景をタップ。
const MIN = 1;
const MAX = 6;

let root, img, stage;
let scale = 1, tx = 0, ty = 0;
const pointers = new Map(); // pointerId -> {x, y}
let gesture = null;          // { startDist, startScale, startTx, startTy, startMid } | { dragX, dragY, startTx, startTy }
let moved = false;
let lastTap = 0;

function build() {
  root = document.createElement('div');
  root.id = 'photo-viewer';
  root.className = 'photo-viewer hidden';
  root.innerHTML = `
    <button type="button" class="photo-viewer-close" aria-label="閉じる">✕</button>
    <div class="photo-viewer-stage"><img alt="拡大写真" draggable="false" /></div>
    <p class="photo-viewer-hint">ピンチで拡大・ドラッグで移動・ダブルタップで拡大/戻す</p>`;
  document.body.appendChild(root);
  stage = root.querySelector('.photo-viewer-stage');
  img = stage.querySelector('img');

  root.querySelector('.photo-viewer-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.classList.contains('hidden')) close(); });

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }, { passive: false });
}

const center = () => { const r = stage.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

function clampPan() {
  const vw = stage.clientWidth, vh = stage.clientHeight;
  // 画面に収まっている状態 (拡大前) の画像サイズ
  const fit = Math.min(vw / img.naturalWidth, vh / img.naturalHeight, Infinity) || 1;
  const w = img.naturalWidth * fit, h = img.naturalHeight * fit;
  const maxX = Math.max(0, (w * scale - vw) / 2);
  const maxY = Math.max(0, (h * scale - vh) / 2);
  tx = Math.min(maxX, Math.max(-maxX, tx));
  ty = Math.min(maxY, Math.max(-maxY, ty));
}

function apply() {
  clampPan();
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  root.classList.toggle('zoomed', scale > 1.001);
}

// 画面上の点 (clientX, clientY) の下にある画像の位置を固定したまま、拡大率を変える
function zoomAt(next, cx, cy) {
  next = Math.min(MAX, Math.max(MIN, next));
  const c = center();
  const px = cx - c.x, py = cy - c.y;
  const ratio = next / scale;
  tx = px - (px - tx) * ratio;
  ty = py - (py - ty) * ratio;
  scale = next;
  if (scale === MIN) { tx = 0; ty = 0; }
  apply();
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function onDown(e) {
  try { stage.setPointerCapture(e.pointerId); } catch { /* 取得できなくても動作に影響しない */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  moved = false;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', startDist: dist(a, b), startScale: scale, startTx: tx, startTy: ty, startMid: mid(a, b) };
  } else if (pointers.size === 1) {
    gesture = { type: 'drag', x: e.clientX, y: e.clientY, startTx: tx, startTy: ty };
  }
}

function onMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const m = mid(a, b), c = center();
    const next = Math.min(MAX, Math.max(MIN, gesture.startScale * (dist(a, b) / gesture.startDist)));
    const ratio = next / gesture.startScale;
    const px = gesture.startMid.x - c.x, py = gesture.startMid.y - c.y;
    // 開始時の中点を固定しつつ、中点の移動ぶんだけ画像も動かす
    tx = (px - (px - gesture.startTx) * ratio) + (m.x - gesture.startMid.x);
    ty = (py - (py - gesture.startTy) * ratio) + (m.y - gesture.startMid.y);
    scale = next;
    if (scale === MIN) { tx = 0; ty = 0; }
    moved = true;
    apply();
  } else if (gesture.type === 'drag' && pointers.size === 1) {
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    if (Math.hypot(dx, dy) > 6) moved = true;
    if (scale > 1) { tx = gesture.startTx + dx; ty = gesture.startTy + dy; apply(); }
  }
}

function onUp(e) {
  const wasSingle = pointers.size === 1;
  pointers.delete(e.pointerId);
  if (pointers.size === 1) {
    // ピンチの片方を離した → 残りの指でドラッグを続ける
    const [p] = [...pointers.values()];
    gesture = { type: 'drag', x: p.x, y: p.y, startTx: tx, startTy: ty };
    return;
  }
  if (pointers.size > 0) return;
  gesture = null;
  if (!wasSingle || moved || e.type === 'pointercancel') return;

  // ここからは「動かさずに離した = タップ」
  const now = Date.now();
  if (now - lastTap < 300) {
    lastTap = 0;
    if (scale > 1.001) { scale = 1; tx = 0; ty = 0; apply(); }
    else zoomAt(2.5, e.clientX, e.clientY);
    return;
  }
  lastTap = now;
  // 拡大していないときに写真の外 (背景) をタップしたら閉じる
  if (scale <= 1.001 && e.target === stage) setTimeout(() => { if (lastTap === now) close(); }, 310);
}

function close() {
  root.classList.add('hidden');
  img.removeAttribute('src');
  pointers.clear(); gesture = null;
}

export function openPhotoViewer(src) {
  if (!src) return;
  if (!root) build();
  scale = 1; tx = 0; ty = 0; lastTap = 0;
  img.style.transform = '';
  img.onload = apply;
  img.src = src;
  root.classList.remove('hidden', 'zoomed');
}
