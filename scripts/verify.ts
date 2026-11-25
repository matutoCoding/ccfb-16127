/**
 * 无头验收：npm run verify
 * 检查 1) HDR 合成辐照度 vs 造图真值平均相对误差 < 5%
 *       2) 渲染过同一响应曲线后 vs 健侧照片的虹膜环带平均 ΔE00 < 3
 * 同时验证手抖组对齐、全过曝组拦截。退出码非 0 即不达标。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runSelfCheck } from '../src/core/selfcheck';

function bar(pct: number) {
  const n = Math.round(pct / 4);
  return `[${'█'.repeat(n)}${' '.repeat(25 - n)}] ${pct.toFixed(0)}%`;
}

async function main() {
  console.log('义眼片 HDR 配色链路 · 数值验收');
  console.log('='.repeat(72));
  const report = await runSelfCheck({
    size: 320,
    onProgress: (msg, pct) => {
      if (pct % 20 === 0 || pct === 100) process.stdout.write(`\r${bar(pct)} ${msg.padEnd(40)}`);
    },
  });
  process.stdout.write('\n\n');

  const outPath = resolve(process.cwd(), 'verify-report.json');
  writeFileSync(outPath, JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  console.log(`机器可读报告已写入 ${outPath}\n`);

  for (const e of report.eyes) {
    console.log(`● ${e.archetype} · ${e.kind}`);
    console.log(
      `  HDR相对误差 ${e.hdrRelErrorPct.toFixed(2)}% (中位 ${e.hdrMedianErrorPct.toFixed(2)}%)` +
      `  | 环带平均 ΔE00 ${e.meanDeltaE.toFixed(2)}  最大 ${e.maxBandDeltaE.toFixed(2)}`,
    );
    console.log(`  各环带 ΔE: ${e.bandDeltaE.map((d) => d.toFixed(2)).join(' ')}`);
    console.log(
      `  MTB 失配 ${(e.alignBefore * 100).toFixed(1)}% → ${(e.alignAfter * 100).toFixed(1)}%` +
      `  位移解算${e.offsetRecovered ? '正确' : '有偏差'}`,
    );
    console.log(`  四场景 ΔE: ${e.sceneMeanDeltaE.map((s) => `${s.name}=${s.de.toFixed(2)}`).join('  ')}`);
    console.log('');
  }

  console.log('-'.repeat(72));
  console.log(`全过曝组拦截: ${report.blownCorrectlyRejected ? '正确识别为不可用 ✓' : '未拦截 ✗'}`);
  console.log(`  ${report.blownMessage}`);
  console.log('-'.repeat(72));
  console.log(`总体 HDR 平均相对误差 : ${report.overallHdrRelErrorPct.toFixed(3)}%  (阈值 < ${report.hdrThresholdPct}%)`);
  console.log(`总体环带平均 ΔE00     : ${report.overallMeanDeltaE.toFixed(3)}   (阈值 < ${report.deThreshold})`);
  if (report.notes.length) console.log(`备注: ${report.notes.join('；')}`);

  if (report.ok) {
    console.log('\n✅ 验收通过：HDR 误差 <5%，平均 ΔE00 <3。');
    process.exit(0);
  } else {
    console.error('\n❌ 验收未通过：');
    for (const f of report.failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
