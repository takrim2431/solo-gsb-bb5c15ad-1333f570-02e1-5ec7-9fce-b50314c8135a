/**
 * 2D 仿射最小二乘拟合（浏览器与 Node 通用）
 *
 * 拟合方向：扫描图坐标 = A · 参考图坐标 + t
 *   [x']   [a c e] [x]
 *   [y'] = [b d f] [y]
 *   [1 ]   [0 0 1] [1]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AffineFit = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 近共线判定阈值：参考点散布矩阵 λmin/λmax 小于此值则拒绝计算
  const COLLINEAR_RATIO = 1e-4;

  /**
   * @param {Array<{x:number,y:number}>} refPts  参考点
   * @param {Array<{x:number,y:number}>} scanPts 扫描点
   * @returns {{ok:boolean, reason?:string, [k:string]:any}}
   */
  function affineFit(refPts, scanPts) {
    const n = Math.min(refPts.length, scanPts.length);
    if (n < 3) return { ok: false, reason: 'need-pairs', pointCount: n };

    // 参考点质心
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += refPts[i].x; my += refPts[i].y; }
    mx /= n; my /= n;

    // 中心化二次矩（散布矩阵 S = Σ[p-m][p-m]ᵀ）
    let Sxx = 0, Sxy = 0, Syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = refPts[i].x - mx;
      const dy = refPts[i].y - my;
      Sxx += dx * dx;
      Sxy += dx * dy;
      Syy += dy * dy;
    }

    // 近共线检测：S 的特征值比 λmin/λmax
    const trace = Sxx + Syy;
    const det2 = Sxx * Syy - Sxy * Sxy;
    const discriminant = Math.max(0, trace * trace - 4 * det2);
    const root = Math.sqrt(discriminant);
    const lambdaMin = (trace - root) / 2;
    const lambdaMax = (trace + root) / 2;
    const eigenRatio = lambdaMax === 0 ? 0 : lambdaMin / lambdaMax;

    if (trace === 0 || eigenRatio < COLLINEAR_RATIO) {
      return { ok: false, reason: 'collinear', pointCount: n, eigenRatio };
    }

    // 中心化正规方程（常数列与中心化坐标列正交，矩阵呈块对角）：
    //   [Sxx Sxy 0 ] [a c]   [Σvx·dx  Σvy·dx]
    //   [Sxy Syy 0 ] [b d] = [Σvx·dy  Σvy·dy]
    //   [0   0   n ] [e'f']  [Σvx     Σvy   ]
    const M = [
      [Sxx, Sxy, 0],
      [Sxy, Syy, 0],
      [0,   0,   n]
    ];

    let sxvx = 0, syvx = 0, svx = 0;
    let sxvy = 0, syvy = 0, svy = 0;
    for (let i = 0; i < n; i++) {
      const dx = refPts[i].x - mx;
      const dy = refPts[i].y - my;
      sxvx += dx * scanPts[i].x;
      syvx += dy * scanPts[i].x;
      svx  += scanPts[i].x;
      sxvy += dx * scanPts[i].y;
      syvy += dy * scanPts[i].y;
      svy  += scanPts[i].y;
    }

    const solX = solve3(M, [sxvx, syvx, svx]);
    const solY = solve3(M, [sxvy, syvy, svy]);
    if (!solX || !solY) {
      return { ok: false, reason: 'singular', pointCount: n, eigenRatio };
    }

    // solX = [a, c, e']，solY = [b, d, f']（e'、f' 为中心化平移量）
    const [a, c, ec] = solX;
    const [b, d, fc] = solY;
    const e = ec - a * mx - c * my;
    const f = fc - b * mx - d * my;

    // 逐点残差
    const residuals = [];
    let sumSq = 0;
    let maxIdx = -1;
    let maxRes = -1;
    for (let i = 0; i < n; i++) {
      const px = a * refPts[i].x + c * refPts[i].y + e;
      const py = b * refPts[i].x + d * refPts[i].y + f;
      const rx = scanPts[i].x - px;
      const ry = scanPts[i].y - py;
      const res = Math.hypot(rx, ry);
      residuals.push({
        index: i,
        ref: { x: refPts[i].x, y: refPts[i].y },
        scan: { x: scanPts[i].x, y: scanPts[i].y },
        predicted: { x: px, y: py },
        residualX: rx,
        residualY: ry,
        residual: res,
        isMax: false
      });
      sumSq += res * res;
      if (res > maxRes) { maxRes = res; maxIdx = i; }
    }
    if (maxIdx >= 0) residuals[maxIdx].isMax = true;
    const rms = Math.sqrt(sumSq / n);

    return {
      ok: true,
      pointCount: n,
      params: { a, b, c, d, e, f },
      inverse: invertAffine(a, b, c, d, e, f),
      residuals,
      rms,
      maxResidual: { index: maxIdx, value: maxRes },
      eigenRatio
    };
  }

  /** 选主元高斯消元求解 3 阶线性方程组；奇异返回 null。 */
  function solve3(matrix, rhs) {
    const m = matrix.map((row, i) => [...row, rhs[i]]);
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) {
        if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
      }
      if (Math.abs(m[piv][col]) < 1e-12) return null;
      if (piv !== col) { const tmp = m[col]; m[col] = m[piv]; m[piv] = tmp; }
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const factor = m[r][col] / m[col][col];
        for (let k = col; k <= 3; k++) m[r][k] -= factor * m[col][k];
      }
    }
    return [0, 1, 2].map((i) => m[i][3] / m[i][i]);
  }

  /** 六参数仿射矩阵求逆；不可逆返回 null。 */
  function invertAffine(a, b, c, d, e, f) {
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return null;
    const ia = d / det;
    const ic = -c / det;
    const ib = -b / det;
    const id = a / det;
    const ie = -(ia * e + ic * f);
    const iff = -(ib * e + id * f);
    return { a: ia, b: ib, c: ic, d: id, e: ie, f: iff };
  }

  return { affineFit, solve3, invertAffine, COLLINEAR_RATIO };
});
