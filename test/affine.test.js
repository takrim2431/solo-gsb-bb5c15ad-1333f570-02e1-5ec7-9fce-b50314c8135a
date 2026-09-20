/* 仿射拟合数值测试：node test/affine.test.js */
const assert = require('assert');
const { affineFit } = require('../public/affine.js');

// 1. 无噪声精确仿射（含旋转/缩放/剪切/平移），3 个非共线点应残差为 0
{
  // M: [1.2, -0.3, 40; 0.5, 0.9, -15]
  const M = (x, y) => [1.2 * x - 0.3 * y + 40, 0.5 * x + 0.9 * y - 15];
  const ref = [{ x: 10, y: 20 }, { x: 300, y: 50 }, { x: 120, y: 400 }];
  const scan = ref.map(p => ({ x: M(p.x, p.y)[0], y: M(p.x, p.y)[1] }));
  const r = affineFit(ref, scan);
  assert.ok(r.ok, '应拟合成功');
  assert.strictEqual(r.pointCount, 3);
  const p = r.params;
  assert.ok(Math.abs(p.a - 1.2) < 1e-9, 'a');
  assert.ok(Math.abs(p.c - -0.3) < 1e-9, 'c');
  assert.ok(Math.abs(p.e - 40) < 1e-8, 'e');
  assert.ok(Math.abs(p.b - 0.5) < 1e-9, 'b');
  assert.ok(Math.abs(p.d - 0.9) < 1e-9, 'd');
  assert.ok(Math.abs(p.f - -15) < 1e-8, 'f');
  assert.ok(r.rms < 1e-8, '残差应近似为 0');
  assert.ok(r.maxResidual.index >= 0 && r.maxResidual.index < 3, '存在最大点索引');
  // 逆矩阵：M * M^-1 应近似单位阵
  const inv = r.inverse;
  assert.ok(Math.abs(inv.a * p.a + inv.c * p.b - 1) < 1e-9, 'inv*M = I (00)');
  assert.ok(Math.abs(inv.b * p.c + inv.d * p.d - 1) < 1e-9, 'inv*M = I (11)');
  console.log('✓ 用例 1：3 点精确仿射，参数与逆矩阵正确');
}

// 2. 5 点含噪声最小二乘：第 5 点故意偏移，应被判为最大异常点
{
  const ref = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 50, y: 50 }];
  const scan = ref.map(p => ({ x: p.x + 3, y: p.y - 2 }));
  scan[4].x += 30; // 异常点
  const r = affineFit(ref, scan);
  assert.ok(r.ok);
  assert.strictEqual(r.maxResidual.index, 4, '第 5 点应为最大异常点');
  assert.ok(r.residuals[4].isMax === true);
  assert.ok(r.residuals[0].isMax === false);
  assert.ok(r.maxResidual.value > 20, '异常点残差应显著偏大');
  assert.ok(r.rms < r.maxResidual.value, 'RMS 应小于最大残差');
  console.log(`✓ 用例 2：5 点噪声拟合，最大异常点识别正确（max=${r.maxResidual.value.toFixed(3)} px, rms=${r.rms.toFixed(3)} px）`);
}

// 3. 近共线点应被拒绝
{
  const ref = [{ x: 0, y: 0 }, { x: 200, y: 0.01 }, { x: 400, y: -0.01 }];
  const scan = [{ x: 5, y: 5 }, { x: 205, y: 5 }, { x: 405, y: 5 }];
  const r = affineFit(ref, scan);
  assert.ok(!r.ok && r.reason === 'collinear', '近共线应拒绝');
  console.log(`✓ 用例 3：近共线被拒绝（eigenRatio=${r.eigenRatio.toExponential(2)}）`);
}

// 4. 完全共线
{
  const ref = [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 10 }];
  const scan = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
  const r = affineFit(ref, scan);
  assert.ok(!r.ok && r.reason === 'collinear');
  console.log('✓ 用例 4：完全共线被拒绝');
}

// 5. 不足 3 对
{
  const r = affineFit([{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.ok(!r.ok && r.reason === 'need-pairs');
  console.log('✓ 用例 5：不足 3 对返回 need-pairs');
}

// 6. 非退化三角形不应误拒（阈值检查）
{
  const ref = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 200, y: 5 }]; // 高 5/底 400 ≈ 1.25%
  const scan = ref.map(p => ({ x: p.x, y: p.y }));
  const r = affineFit(ref, scan);
  assert.ok(r.ok, '稍扁但非共线的三角形应接受');
  console.log(`✓ 用例 6：扁三角形（1.25% 高宽比）正常拟合（eigenRatio=${r.eigenRatio.toExponential(2)}）`);
}

console.log('\n全部测试通过。');
