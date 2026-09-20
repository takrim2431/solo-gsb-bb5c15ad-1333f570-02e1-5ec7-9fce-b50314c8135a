/**
 * 扫描印刷稿套色偏移校准 —— 前端主逻辑
 *
 * 坐标约定（仿射方向）：
 *   扫描图坐标 = A · 参考图坐标 + t
 *   [x']   [a c e] [x]
 *   [y'] = [b d f] [y]
 *   [1 ]   [0 0 1] [1]
 * 叠加预览时使用逆矩阵，把扫描图扭曲到参考图坐标系。
 */
'use strict';

/* ============================ 全局状态 ============================ */

const state = {
  images: { ref: null, scan: null },
  points: { ref: [], scan: [] },   // 点坐标均为图像自然像素 {x, y}
  mode: 'add',                     // 'add' | 'delete'
  opacity: 0.6,
  fit: null                        // 最近一次成功拟合结果
};

const els = {};

document.addEventListener('DOMContentLoaded', init);

/* ============================ 初始化 ============================ */

function init() {
  for (const id of [
    'refFile', 'scanFile', 'refInfo', 'scanInfo',
    'refCanvas', 'scanCanvas', 'overlayCanvas',
    'modeAdd', 'modeDelete', 'pointCount', 'clearPoints',
    'statusBanner', 'matrixGrid', 'matrixMeta',
    'exportMatrix', 'exportResiduals', 'residualBody',
    'opacitySlider', 'opacityValue'
  ]) {
    els[id] = document.getElementById(id);
  }

  els.refFile.addEventListener('change', (e) => loadImage(e.target.files[0], 'ref'));
  els.scanFile.addEventListener('change', (e) => loadImage(e.target.files[0], 'scan'));

  els.refCanvas.addEventListener('click', (e) => onCanvasClick(e, 'ref'));
  els.scanCanvas.addEventListener('click', (e) => onCanvasClick(e, 'scan'));

  els.modeAdd.addEventListener('click', () => setMode('add'));
  els.modeDelete.addEventListener('click', () => setMode('delete'));
  els.clearPoints.addEventListener('click', () => {
    state.points.ref = [];
    state.points.scan = [];
    recompute('cleared');
  });

  els.opacitySlider.addEventListener('input', () => {
    state.opacity = els.opacitySlider.value / 100;
    els.opacityValue.textContent = `${els.opacitySlider.value}%`;
    renderOverlay();
  });

  els.exportMatrix.addEventListener('click', exportMatrix);
  els.exportResiduals.addEventListener('click', exportResiduals);

  window.addEventListener('resize', () => { drawPanel('ref'); drawPanel('scan'); });

  drawPlaceholder(els.refCanvas, '请先上传参考图');
  drawPlaceholder(els.scanCanvas, '请先上传扫描图');
  drawPlaceholder(els.overlayCanvas, '叠加预览将在拟合成功后显示');
  recompute('init');
}

/* ============================ 图片加载 ============================ */

function loadImage(file, side) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    alert(`「${file.name}」不是图像文件，请重新选择。`);
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if (state.images[side] && state.images[side].objectURL) {
      URL.revokeObjectURL(state.images[side].objectURL);
    }
    img.objectURL = url;
    state.images[side] = img;
    state.points[side] = [];           // 换图后该侧旧点失效
    const box = document.getElementById(side === 'ref' ? 'refFile' : 'scanFile').closest('.upload-box');
    box.classList.add('loaded');
    els[side === 'ref' ? 'refInfo' : 'scanInfo'].textContent =
      `${file.name}（${img.naturalWidth} × ${img.naturalHeight}）`;
    recompute('image-loaded');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert(`无法读取图像「${file.name}」，请换用 PNG / JPEG 等浏览器支持的格式。`);
  };
  img.src = url;
}

/* ============================ 画布点击（添加 / 删除） ============================ */

function onCanvasClick(event, side) {
  if (!state.images[side]) return;
  const canvas = els[side === 'ref' ? 'refCanvas' : 'scanCanvas'];
  const { x, y } = eventToImageCoord(event, canvas);

  if (state.mode === 'delete') {
    deleteNearby(side, x, y);
    return;
  }
  state.points[side].push({ x, y });
  recompute('point-added');
}

function eventToImageCoord(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height
  };
}

function deleteNearby(side, x, y) {
  const pts = state.points[side];
  if (pts.length === 0) return;
  const canvas = els[side === 'ref' ? 'refCanvas' : 'scanCanvas'];
  const rect = canvas.getBoundingClientRect();
  // 14 CSS 像素的拾取半径，换算到自然像素
  const threshold = 14 * canvas.width / rect.width;
  let best = -1;
  let bestDist = threshold;
  pts.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestDist) { bestDist = d; best = i; }
  });
  if (best < 0) return;
  removePointPair(side, best);
  recompute('point-deleted');
}

/** 删除某侧索引 i 的点；若对侧同序号点存在则一并删除（成对删除）。 */
function removePointPair(side, i) {
  state.points[side].splice(i, 1);
  const other = side === 'ref' ? 'scan' : 'ref';
  if (i < state.points[other].length) state.points[other].splice(i, 1);
}

function setMode(mode) {
  state.mode = mode;
  els.modeAdd.classList.toggle('active', mode === 'add');
  els.modeDelete.classList.toggle('active', mode === 'delete');
  document.body.classList.toggle('mode-delete', mode === 'delete');
}

/* ============================ 仿射最小二乘拟合（见 affine.js） ============================ */

const affineFit = window.AffineFit.affineFit;

/* ============================ 重算（任一点变化立即调用） ============================ */

function recompute(trigger) {
  const pairs = Math.min(state.points.ref.length, state.points.scan.length);
  els.pointCount.textContent =
    `参考点 ${state.points.ref.length} · 扫描点 ${state.points.scan.length} · 成对 ${pairs}`;

  state.fit = null;

  if (!state.images.ref || !state.images.scan) {
    setStatus('info', '请先上传参考图和扫描图两幅图像。');
  } else if (pairs < 3) {
    setStatus('info', `已记录 ${pairs} 对控制点，至少需要 3 对才能进行仿射拟合（建议 4 对以上以便评估残差）。`);
  } else {
    const result = affineFit(state.points.ref, state.points.scan);
    if (result.ok) {
      state.fit = result;
      const maxInfo = result.maxResidual.value > 0
        ? `最大异常点为第 ${result.maxResidual.index + 1} 对（残差 ${fmt(result.maxResidual.value, 3)} px，表中红色标出）。`
        : '所有点残差均为 0，完全拟合。';
      let msg = `拟合成功：RMS = ${fmt(result.rms, 3)} px，最大残差 = ${fmt(result.maxResidual.value, 3)} px。${maxInfo}`;
      if (result.eigenRatio < 1e-3) {
        msg += ' 注意：控制点空间分布偏狭长，结果可能不够稳健，建议补充拉开距离的点。';
        setStatus('warn', msg);
      } else {
        setStatus('ok', msg);
      }
    } else if (result.reason === 'collinear') {
      setStatus(
        'error',
        `控制点近共线（特征值比 λmin/λmax = ${fmtSmall(result.eigenRatio)}），仿射拟合被拒绝。` +
        '请让控制点在平面上呈三角形均匀铺开，避免落在同一条直线附近。'
      );
    } else {
      setStatus('error', '拟合方程组奇异，无法求解。请调整控制点的空间分布。');
    }
  }

  updateMatrixPanel();
  renderResidualTable();
  drawPanel('ref');
  drawPanel('scan');
  renderOverlay();
}

/* ============================ 状态 / 矩阵 / 残差表 ============================ */

function setStatus(kind, text) {
  els.statusBanner.className = `status ${kind}`;
  els.statusBanner.textContent = text;
}

function updateMatrixPanel() {
  const p = state.fit ? state.fit.params : null;
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const cell = els.matrixGrid.querySelector(`[data-m="${key}"]`);
    cell.textContent = p ? fmt(p[key], 6) : '–';
  }
  if (state.fit) {
    els.matrixMeta.textContent =
      `方向：扫描图坐标 = M · 参考图坐标 ｜ ${state.fit.pointCount} 对控制点 ｜ ` +
      `RMS ${fmt(state.fit.rms, 3)} px ｜ 分布特征值比 ${fmt(state.fit.eigenRatio, 4)}`;
  } else {
    els.matrixMeta.textContent = '参数将在拟合成功后显示';
  }
  els.exportMatrix.disabled = !state.fit;
  els.exportResiduals.disabled = !state.fit;
}

function renderResidualTable() {
  const body = els.residualBody;
  body.innerHTML = '';

  const pairs = Math.min(state.points.ref.length, state.points.scan.length);
  if (state.points.ref.length === 0 && state.points.scan.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="5">尚无数据</td></tr>';
    return;
  }

  const maxIdx = state.fit ? state.fit.maxResidual.index : -1;

  for (let i = 0; i < pairs; i++) {
    const tr = document.createElement('tr');
    if (i === maxIdx) tr.className = 'max-residual';
    const r = state.fit ? state.fit.residuals[i] : null;
    tr.innerHTML =
      `<td>${i + 1}</td>` +
      `<td>${fmt(state.points.ref[i].x, 1)}, ${fmt(state.points.ref[i].y, 1)}</td>` +
      `<td>${fmt(state.points.scan[i].x, 1)}, ${fmt(state.points.scan[i].y, 1)}</td>` +
      `<td>${r ? fmt(r.residual, 3) : '—'}</td>` +
      `<td class="del-cell"><button class="del-btn" title="删除该点对">✕</button></td>`;
    tr.querySelector('.del-btn').addEventListener('click', () => {
      removePointPair('ref', i);
      recompute('pair-deleted');
    });
    body.appendChild(tr);
  }

  // 未成对的多余点
  const extras = [];
  if (state.points.ref.length > pairs) {
    for (let i = pairs; i < state.points.ref.length; i++) extras.push({ side: 'ref', i, p: state.points.ref[i] });
  }
  if (state.points.scan.length > pairs) {
    for (let i = pairs; i < state.points.scan.length; i++) extras.push({ side: 'scan', i, p: state.points.scan[i] });
  }
  for (const ex of extras) {
    const tr = document.createElement('tr');
    tr.className = 'unpaired-row';
    tr.innerHTML =
      `<td>${ex.i + 1}</td>` +
      (ex.side === 'ref'
        ? `<td>${fmt(ex.p.x, 1)}, ${fmt(ex.p.y, 1)}</td><td>—</td>`
        : `<td>—</td><td>${fmt(ex.p.x, 1)}, ${fmt(ex.p.y, 1)}</td>`) +
      `<td>未成对</td>` +
      `<td class="del-cell"><button class="del-btn" title="删除该点">✕</button></td>`;
    tr.querySelector('.del-btn').addEventListener('click', () => {
      state.points[ex.side].splice(ex.i, 1);
      recompute('point-deleted');
    });
    body.appendChild(tr);
  }
}

/* ============================ 画布绘制 ============================ */

function drawPlaceholder(canvas, text) {
  canvas.width = 900;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#6b7785';
  ctx.font = '20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function drawPanel(side) {
  const img = state.images[side];
  const canvas = els[side === 'ref' ? 'refCanvas' : 'scanCanvas'];
  if (!img) return;  // 保持占位画面

  if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth;
  if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);

  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / canvas.width || 1;  // 每自然像素对应的 CSS 像素
  const pts = state.points[side];
  const pairs = Math.min(state.points.ref.length, state.points.scan.length);
  const maxIdx = state.fit ? state.fit.maxResidual.index : -1;
  const baseColor = side === 'ref' ? '#1a6fb0' : '#d0641a';

  pts.forEach((p, i) => {
    const paired = i < pairs;
    const isMax = paired && i === maxIdx;
    const r = 7 / scale;
    const ringR = 12 / scale;

    if (isMax) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = '#d12f2f';
      ctx.lineWidth = 3 / scale;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = paired ? baseColor : '#c79100';
    ctx.fill();
    ctx.lineWidth = 2 / scale;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // 编号
    ctx.font = `bold ${11 / scale}px sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(paired ? String(i + 1) : '!', p.x, p.y);
  });
}

/* ============================ 叠加预览 ============================ */

function renderOverlay() {
  const ref = state.images.ref;
  const scan = state.images.scan;
  const canvas = els.overlayCanvas;

  if (!ref) {
    drawPlaceholder(canvas, '请先上传参考图');
    return;
  }
  if (canvas.width !== ref.naturalWidth) canvas.width = ref.naturalWidth;
  if (canvas.height !== ref.naturalHeight) canvas.height = ref.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 底图：参考图
  ctx.globalAlpha = 1;
  ctx.drawImage(ref, 0, 0);

  if (!state.fit || !state.fit.inverse || !scan) {
    // 未成功拟合时给出提示遮罩
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#6b7785';
    ctx.font = `${Math.max(16, canvas.width / 45)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const msg = !scan
      ? '上传扫描图并完成至少 3 对控制点后显示叠加'
      : '控制点不足或近共线，无法生成叠加';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
    return;
  }

  // 扫描图经逆仿射变换绘制（扫描坐标 → 参考坐标），裁剪在参考图范围内
  const inv = state.fit.inverse;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.clip();
  ctx.globalAlpha = state.opacity;
  // ctx.transform(a, b, c, d, e, f) 与矩阵 [a c e; b d f] 对应
  ctx.transform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
  ctx.drawImage(scan, 0, 0);
  ctx.restore();
  ctx.globalAlpha = 1;
}

/* ============================ JSON 导出 ============================ */

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMatrix() {
  if (!state.fit) return;
  const { a, b, c, d, e, f } = state.fit.params;
  const inv = state.fit.inverse;
  downloadJSON({
    description: '扫描印刷稿套色校准仿射矩阵（扫描图坐标 = M · 参考图坐标）',
    transformDirection: 'scan = M * ref',
    parameters: roundObj({ a, b, c, d, e, f }, 8),
    matrix3x3: [
      [round(a, 8), round(c, 8), round(e, 8)],
      [round(b, 8), round(d, 8), round(f, 8)],
      [0, 0, 1]
    ],
    inverseMatrix3x3: inv ? [
      [round(inv.a, 8), round(inv.c, 8), round(inv.e, 8)],
      [round(inv.b, 8), round(inv.d, 8), round(inv.f, 8)],
      [0, 0, 1]
    ] : null,
    pointCount: state.fit.pointCount,
    rmsPx: round(state.fit.rms, 6),
    maxResidualPx: round(state.fit.maxResidual.value, 6),
    maxResidualPointIndex: state.fit.maxResidual.index + 1,
    eigenRatio: round(state.fit.eigenRatio, 8),
    generatedAt: new Date().toISOString()
  }, 'affine-matrix.json');
}

function exportResiduals() {
  if (!state.fit) return;
  downloadJSON({
    description: '各控制点仿射拟合残差（扫描点实际坐标 - 预测坐标）',
    unit: 'px',
    pointCount: state.fit.pointCount,
    rms: round(state.fit.rms, 6),
    maxResidual: {
      pointIndex: state.fit.maxResidual.index + 1,
      value: round(state.fit.maxResidual.value, 6)
    },
    points: state.fit.residuals.map((r) => ({
      index: r.index + 1,
      ref: roundObj(r.ref, 3),
      scan: roundObj(r.scan, 3),
      predicted: roundObj(r.predicted, 3),
      residualX: round(r.residualX, 6),
      residualY: round(r.residualY, 6),
      residual: round(r.residual, 6),
      isMaxResidual: r.isMax
    })),
    generatedAt: new Date().toISOString()
  }, 'residuals.json');
}

/* ============================ 工具 ============================ */

function fmt(v, digits) {
  if (!Number.isFinite(v)) return '–';
  return round(v, digits).toFixed(digits);
}

/** 极小/极大数用紧凑科学计数法，其余保留 4 位有效小数。 */
function fmtSmall(v) {
  if (!Number.isFinite(v)) return '–';
  if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5)) return v.toExponential(2);
  return round(v, 4).toFixed(4);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round((v + Number.EPSILON) * f) / f;
}

function roundObj(obj, digits) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = round(obj[k], digits);
  return out;
}
