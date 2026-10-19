#!/usr/bin/env node
// dsh-notekit / restore-note.mjs —— 加注的**回滚器**。**默认 dry-run，--apply 才写。**
//
// 一行式回滚（推荐照抄这一条）：
//   node restore-note.mjs --manifest <manifest.json> --apply
//
// 纪律：严格逆序（LIFO · appliedSeq 降序）· 行级块替换 + 逐字节断言 · 命中数 ≠ 1 拒动 ·
//       幂等（已还原 ⇒ 跳过 rc=0；注不存在且非原始态 ⇒ 拒动）· **绝不读 before 快照整档覆盖**。
import fs from 'node:fs';
import path from 'node:path';
import { runRestore, TOOLKIT, VERSION } from './lib/notekit.mjs';

const USAGE = `${TOOLKIT} v${VERSION} · restore-note.mjs —— 按 manifest 回滚（默认 dry-run）

用法：
  node restore-note.mjs --manifest <manifest.json>            # dry-run（只预检，不写盘）
  node restore-note.mjs --manifest <manifest.json> --apply    # 真回滚

参数：
  --manifest <path>          apply 时产出的 manifest（必填；回滚器唯一输入）
  --apply                    真写盘；缺省 = dry-run
  --target <label>           只回滚某一条（缺省全量）
  --expect-file-sha <file>=<sha256>   可选：回滚后整档 sha 断言（可多次给；只在本档没别人动过时用）
  --json                     以 JSON 摘要输出
  --help                     显示本帮助
`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? (argv[i + 1] ?? null) : null; };
const allOf = (f) => argv.reduce((acc, a, i) => (a === f && argv[i + 1] ? acc.concat([argv[i + 1]]) : acc), []);

function main() {
  if (has('--help') || has('-h')) { console.log(USAGE); return 0; }
  const mfPath = valOf('--manifest');
  if (!mfPath) { console.error('❌ 缺 --manifest <manifest.json>（用 --help 看用法）'); return 2; }
  if (!fs.existsSync(mfPath)) { console.error('❌ manifest 不存在: ' + mfPath); return 3; }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8')); }
  catch (e) { console.error('❌ manifest 不是合法 JSON: ' + e.message); return 3; }

  const expectFileSha = {};
  for (const spec of allOf('--expect-file-sha')) {
    const k = spec.lastIndexOf('=');
    if (k <= 0) { console.error('❌ --expect-file-sha 格式应为 <file>=<sha256>：' + spec); return 2; }
    expectFileSha[spec.slice(0, k)] = spec.slice(k + 1).toLowerCase();
  }

  const apply = has('--apply');
  const log = has('--json') ? () => {} : (s) => console.log(s);
  const r = runRestore({ manifest, apply, only: valOf('--target'), expectFileSha, log });

  if (has('--json')) {
    console.log(JSON.stringify({ ok: r.ok, rc: r.rc, dryRun: r.dryRun, restored: r.restored, skipped: r.skipped, errors: r.errors, files: r.files }, null, 2));
  } else {
    console.log(`\nrc=${r.rc}${r.dryRun ? '（dry-run）' : ''}`);
    if (r.rc !== 0) console.log(`❌ 有 ${r.errors.length} 项被拒 ⇒ 一个字节都没写。逐条：\n  · ` + r.errors.join('\n  · '));
  }
  return r.rc;
}

process.exitCode = main();
