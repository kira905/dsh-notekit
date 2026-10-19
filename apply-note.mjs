#!/usr/bin/env node
// dsh-notekit / apply-note.mjs —— 锚定式「加订正注」落地器。**默认 dry-run，--apply 才写。**
//
// 计划文件（plan.json）格式：
// {
//   "mark": "V3.0.0-R038",                    // 必填：幂等判据 + 回滚定位（noteHeader+note 里必须出现它）
//   "noteHeader": "<br>🪪 **订正注（…）**：",   // 可选：缺省按 mark 自动生成
//   "targets": [
//     { "file": "X:\\...\\x.md", "label": "R-038行",
//       "anchor": { "mode": "prefix", "text": "| **R-038** |" },   // mode: prefix | contains | exact
//       "insert": "before-trailing-pipe",                          // end | before-trailing-pipe | after-anchor
//       "note": "注文正文（禁含 \"|\"）" }
//   ]
// }
import fs from 'node:fs';
import path from 'node:path';
import { runApply, TOOLKIT, VERSION } from './lib/notekit.mjs';

const USAGE = `${TOOLKIT} v${VERSION} · apply-note.mjs —— 锚定式加注（默认 dry-run）

用法：
  node apply-note.mjs --plan <计划.json>                 # dry-run（只预检，不写盘）
  node apply-note.mjs --plan <计划.json> --apply         # 真写（预检全绿才写）

参数：
  --plan <path>          计划文件（必填）
  --apply                真写盘；缺省 = dry-run
  --only <label>         只处理某个 label（演练/dogfood 用）
  --manifest-out <path>  回滚 manifest 落点（缺省 <计划名>.manifest.json）
  --before-dir <path>    改前副本目录（**仅证据**，回滚器不读它；缺省 <manifest 同目录>\\.before）
  --json                 以 JSON 摘要输出
  --help                 显示本帮助

纪律：命中数 ≠ 1 拒动 · 幂等重复 apply 拒动 · 注文禁含 "|" · 事务性（任一失败整批不写）·
      同一文件多处 = 降序应用 + 一次写盘 · 全程字节切片（$& / $' 之类当数据不当模式）。
`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? (argv[i + 1] ?? null) : null; };

function main() {
  if (has('--help') || has('-h')) { console.log(USAGE); return 0; }
  const planPath = valOf('--plan');
  if (!planPath) { console.error('❌ 缺 --plan <计划文件.json>（用 --help 看用法）'); return 2; }
  if (!fs.existsSync(planPath)) { console.error('❌ 计划文件不存在: ' + planPath); return 3; }
  let plan;
  try { plan = JSON.parse(fs.readFileSync(planPath, 'utf8')); }
  catch (e) { console.error('❌ 计划文件不是合法 JSON: ' + e.message); return 3; }

  const apply = has('--apply');
  const base = path.basename(planPath).replace(/\.json$/i, '');
  const manifestOut = valOf('--manifest-out') || path.join(path.dirname(planPath), `${base}.manifest.json`);
  const beforeDir = valOf('--before-dir') || path.join(path.dirname(manifestOut), '.before');
  const only = valOf('--only');

  const log = has('--json') ? () => {} : (s) => console.log(s);
  const r = runApply({ plan, apply, manifestOut, beforeDir, only, planFile: planPath, log });

  if (has('--json')) {
    console.log(JSON.stringify({ ok: r.ok, rc: r.rc, dryRun: r.dryRun, planned: r.planned, changed: r.changed, errors: r.errors, files: r.files, manifestPath: r.manifestPath }, null, 2));
  } else {
    console.log(`\nrc=${r.rc}${r.dryRun ? '（dry-run）' : ''}`);
    if (r.rc !== 0) console.log(`❌ 有 ${r.errors.length} 项被拒 ⇒ 一个字节都没写。逐条：\n  · ` + r.errors.join('\n  · '));
  }
  return r.rc;
}

process.exitCode = main();
