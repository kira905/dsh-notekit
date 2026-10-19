#!/usr/bin/env node
// dsh-notekit / selftest.mjs —— 器具自测。夹具全部建在系统临时目录的 dsh-notekit-selftest\ 下，**生产零接触**。
//
// 覆盖：正例（单行/多行块/两种插入模式/CRLF/LF/混用 EOL/BOM/美元符序列/多文件一批）
//      反例必红（命中数 0 / 命中数 2 / 幂等重复 apply / 撤销目标不存在 / 注外篡改 /
//                注文含 "|" / 事务性一处失败整批不写 / 计划非法）
//      回滚（dry-run 默认 · LIFO · 逐字节还原 · 幂等再跑）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLY = path.join(HERE, 'apply-note.mjs');
const RESTORE = path.join(HERE, 'restore-note.mjs');
const DIR = path.join(os.tmpdir(), 'dsh-notekit-selftest');
const PLANS = path.join(DIR, 'plans');

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const read = (f) => fs.readFileSync(f, 'utf8');
const run = (args) => { const r = spawnSync(process.execPath, args, { encoding: 'utf8' }); return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
let fail = 0;
const chk = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' · ' + extra : ''}`); if (!cond) fail++; };
const sec = (t) => console.log(`\n──── ${t} ────`);

/** 只删白名单前缀下的自建目录（前缀口径判，junction 下也不会误伤别处）。 */
function safeReset(dir) {
  const rp = path.resolve(dir);
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!rp.startsWith(tmpRoot) || !path.basename(rp).startsWith('dsh-notekit-')) throw new Error('拒删（不在白名单前缀内）: ' + rp);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('拒删（是链接）: ' + dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

const F = {
  table: path.join(DIR, 'table-crlf.md'),
  plain: path.join(DIR, 'plain-lf.md'),
  mixed: path.join(DIR, 'mixed-eol.md'),
  bom: path.join(DIR, 'bom.md'),
  block: path.join(DIR, 'block.md'),
  dollar: path.join(DIR, 'dollar.md'),
  dup: path.join(DIR, 'dup-anchor.md'),
  txn: path.join(DIR, 'transaction.md'),
};

const MARK = 'dsh-notekit-selftest';
const HEADER = `<br>🪪 **订正注（自测 · 卡「${MARK}」执行会话）**：`;
const N = {
  t1: '本行是 J 域销账注（自测样本）。',
  t2: '本行是 plain 追加注（after-anchor 形态）。',
  t3: '本行是混用 EOL 文件的注。',
  t4: '本行是 BOM 文件的注。',
  t5: '本行是**多行块锚点**注（插在块末行）。',
  dollar: "替换串实险：$& 与 $' 与 $` 与 $1 与 $$ 都应原样留下。",
};
const full = (n) => HEADER + n;

const TABLE_CRLF = ['| 项 | 判定 | 说明 |', '| --- | --- | --- |', '| J | L478 | B3 tidy-readme-gen | 🟡 | 部分生效 |', '| K | L479 | 别的项 | ✅ | 已生效 |'].join('\r\n') + '\r\n';
const PLAIN_LF = ['# 标题', '', '- 项一：普通行', '- 项二：另一个普通行', ''].join('\n');
const MIXED_TXT = '# 混用 EOL\r\n第一行用 CRLF\n第二行用 LF\r\n第三行用 CRLF\n';
const BOM_TXT = '\uFEFF| 项 | 判定 |\r\n| B | L500 | 🟡 |\r\n';
const BLOCK_TXT = ['## 段一', '行 A', '行 B', '## 段二', '行 C'].join('\r\n') + '\r\n';
const DOLLAR_TXT = '| D | L600 | 目标行 | 🟡 | 部分 |\r\n';
const DUP_TXT = ['| 重复项 | A |', '| 重复项 | B |'].join('\r\n') + '\r\n';
const TXN_TXT = ['| 有的项 | X |', '| 另一项 | Y |'].join('\r\n') + '\r\n';

const writePlan = (name, obj) => { const p = path.join(PLANS, name + '.json'); fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); return p; };
const mfOf = (name) => path.join(DIR, name + '.manifest.json');

/** 把注文从改后文本里摘掉 ⇒ 应逐字节还原成原文（最强判据：EOL 混用 / BOM 一并验证）。 */
function stripNote(after, note) {
  const i = after.indexOf(note);
  if (i < 0) return null;
  if (after.indexOf(note, i + 1) >= 0) return null;
  return after.slice(0, i) + after.slice(i + note.length);
}

console.log(`=== dsh-notekit 自测 === 夹具树 = ${DIR}（生产零接触）`);
safeReset(DIR);
fs.mkdirSync(PLANS, { recursive: true });
fs.writeFileSync(F.table, TABLE_CRLF, 'utf8');
fs.writeFileSync(F.plain, PLAIN_LF, 'utf8');
fs.writeFileSync(F.mixed, MIXED_TXT, 'utf8');
fs.writeFileSync(F.bom, BOM_TXT, 'utf8');
fs.writeFileSync(F.block, BLOCK_TXT, 'utf8');
fs.writeFileSync(F.dollar, DOLLAR_TXT, 'utf8');
fs.writeFileSync(F.dup, DUP_TXT, 'utf8');
fs.writeFileSync(F.txn, TXN_TXT, 'utf8');

sec('① 夹具准备');
for (const [k, f] of Object.entries(F)) console.log(`   ${k.padEnd(7)} = ${path.basename(f)} · ${Buffer.byteLength(read(f), 'utf8')} B · sha256=${sha(read(f)).slice(0, 16)}…`);

const goodPlan = {
  mark: MARK,
  noteHeader: HEADER,
  targets: [
    { file: F.table, label: 'T-table', anchor: { mode: 'prefix', text: '| J | L478 |' }, insert: 'before-trailing-pipe', note: N.t1 },
    { file: F.plain, label: 'T-plain', anchor: { mode: 'contains', text: '- 项一：' }, insert: 'after-anchor', note: N.t2 },
    { file: F.mixed, label: 'T-mixed', anchor: { mode: 'prefix', text: '# 混用 EOL' }, insert: 'end', note: N.t3 },
    { file: F.bom, label: 'T-bom', anchor: { mode: 'contains', text: '| B | L500 |' }, insert: 'before-trailing-pipe', note: N.t4 },
    { file: F.block, label: 'T-block', anchor: { mode: 'block', text: '行 A\n行 B' }, insert: 'end', note: N.t5 },
  ],
};
const P_GOOD = writePlan('good', goodPlan);
const P_DOLLAR = writePlan('dollar', { mark: MARK, noteHeader: HEADER, targets: [{ file: F.dollar, label: 'T-dollar', anchor: { mode: 'prefix', text: '| D | L600 |' }, insert: 'before-trailing-pipe', note: N.dollar }] });

const S0 = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, sha(read(f))]));

sec('② dry-run（默认不写盘）');
const d1 = run([APPLY, '--plan', P_GOOD, '--manifest-out', mfOf('good')]);
console.log(d1.out.trim().split('\n').slice(-4).join('\n'));
chk('dry-run rc=0', d1.rc === 0, 'rc=' + d1.rc);
chk('dry-run 五个夹具零写盘', Object.entries(F).every(([k, f]) => sha(read(f)) === S0[k]));

sec('③ apply（真写）· 逐字节断言');
const a1 = run([APPLY, '--plan', P_GOOD, '--manifest-out', mfOf('good'), '--before-dir', path.join(DIR, 'before'), '--apply']);
chk('apply rc=0', a1.rc === 0, 'rc=' + a1.rc);
if (a1.rc !== 0) console.log('   ↳ apply 输出尾部：\n' + a1.out.trim().split('\n').slice(-30).map((s) => '     ' + s).join('\n'));
chk('apply 覆盖 5 个文件', /已加注 5 处 \/ 5 个文件/.test(a1.out));
const pairAll = [
  ['table', full(N.t1)], ['plain', full(N.t2)], ['mixed', full(N.t3)], ['bom', full(N.t4)], ['block', full(N.t5)],
];
for (const [k, note] of pairAll) {
  const after = read(F[k]);
  const before = { table: TABLE_CRLF, plain: PLAIN_LF, mixed: MIXED_TXT, bom: BOM_TXT, block: BLOCK_TXT }[k];
  chk(`${k}：去掉注文后**逐字节 == 原文**（EOL/缩进一字未动）`, stripNote(after, note) === before);
  chk(`${k}：行数不变`, after.split(/\r?\n/).length === before.split(/\r?\n/).length, `${before.split(/\r?\n/).length} → ${after.split(/\r?\n/).length}`);
}
chk('bom：BOM（EF BB BF）原样保留', read(F.bom).charCodeAt(0) === 0xFEFF, '首字符 U+' + read(F.bom).charCodeAt(0).toString(16).toUpperCase());
chk('mixed：EOL 混用原样保留（CRLF 与 LF 都在）', /\r\n/.test(read(F.mixed)) && /[^\r]\n/.test(read(F.mixed)));
chk('manifest 记录 5 条', JSON.parse(read(mfOf('good'))).targets.length === 5);
chk('before 副本 == 原档（仅供比对）', sha(read(path.join(DIR, 'before', fs.readdirSync(path.join(DIR, 'before')).find((n) => n.endsWith('table-crlf.md'))))) === S0.table);

sec('④ 美元符序列（$& / $\' / $` / $1 / $$ 当数据不当模式）');
const d2 = run([APPLY, '--plan', P_DOLLAR, '--manifest-out', mfOf('dollar'), '--apply']);
chk('apply rc=0', d2.rc === 0, 'rc=' + d2.rc);
const dl = read(F.dollar);
chk('五个字面序列都在', ["$&", "$'", '$`', '$1', '$$'].every((s) => dl.includes(s)));
chk('去掉注文后逐字节 == 原文（文件没被复制/撑大）', stripNote(dl, full(N.dollar)) === DOLLAR_TXT);
chk('字节增量 == 注文字节数', Buffer.byteLength(dl, 'utf8') - Buffer.byteLength(DOLLAR_TXT, 'utf8') === Buffer.byteLength(full(N.dollar), 'utf8'));
const rD = run([RESTORE, '--manifest', mfOf('dollar'), '--apply']);
chk('④b 一行式回滚（dollar 档）：逐字节还原', rD.rc === 0 && sha(read(F.dollar)) === S0.dollar, 'sha=' + sha(read(F.dollar)).slice(0, 16) + '…');

sec('⑤ 反例必红 · 幂等重复 apply');
const S_AFTER = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, read(f)]));
const a2 = run([APPLY, '--plan', P_GOOD, '--manifest-out', mfOf('good2'), '--apply']);
chk('再跑同一计划 rc≠0（拒动）', a2.rc !== 0, 'rc=' + a2.rc);
chk('拒动理由含幂等/已含 mark', /已存在|已含 mark/.test(a2.out), '');
chk('五个夹具 sha 一字未变', Object.entries(F).every(([k, f]) => sha(read(f)) === sha(S_AFTER[k])));

sec('⑥ restore dry-run（默认不写盘）');
const r1 = run([RESTORE, '--manifest', mfOf('good')]);
chk('restore dry-run rc=0', r1.rc === 0, 'rc=' + r1.rc);
if (r1.rc !== 0) console.log('   ↳ restore 输出：\n' + r1.out.trim().split('\n').map((s) => '     ' + s).join('\n'));
chk('dry-run 零写盘', Object.entries(F).every(([k, f]) => read(f) === S_AFTER[k]));
chk('dry-run 提示未写盘', /未写盘/.test(r1.out));

sec('⑦ restore --apply（LIFO · 逐字节还原）');
const r2 = run([RESTORE, '--manifest', mfOf('good'), '--apply']);
chk('restore rc=0', r2.rc === 0, 'rc=' + r2.rc);
chk('LIFO 次序 = appliedSeq 降序', /LIFO/.test(r2.out));
console.log('   回滚后 sha：');
for (const [k, f] of Object.entries(F)) {
  const now = sha(read(f));
  const same = now === S0[k];
  console.log(`     ${k.padEnd(7)} ${now.slice(0, 16)}… ${same ? '== 原件 ✅' : '≠ 原件 ❌'}`);
  chk(`${k}：逐字节还原（sha 相等）`, same);
}

sec('⑧ 幂等 · restore 再跑一次');
const r3 = run([RESTORE, '--manifest', mfOf('good'), '--apply']);
chk('再跑 rc=0（幂等跳过）', r3.rc === 0, 'rc=' + r3.rc);
chk('提示跳过 5 处', /跳过 5 处/.test(r3.out));
chk('五个夹具仍 == 原件 sha', Object.entries(F).every(([k, f]) => sha(read(f)) === S0[k]));

sec('⑨ 反例必红 · 命中数 0');
const P_MISS = writePlan('miss', { mark: MARK, noteHeader: HEADER, targets: [{ file: F.table, label: 'T-miss', anchor: { mode: 'prefix', text: '| 不存在的项 |' }, insert: 'end', note: 'x' }] });
const b1 = run([APPLY, '--plan', P_MISS, '--manifest-out', mfOf('miss'), '--apply']);
chk('rc≠0', b1.rc !== 0, 'rc=' + b1.rc);
chk('理由 = 命中数 ≠ 1', /命中 0 ≠ 1/.test(b1.out));
chk('零写盘', sha(read(F.table)) === S0.table);

sec('⑩ 反例必红 · 命中数 2（重复锚点）');
const P_DUP = writePlan('dup', { mark: MARK, noteHeader: HEADER, targets: [{ file: F.dup, label: 'T-dup', anchor: { mode: 'prefix', text: '| 重复项 |' }, insert: 'before-trailing-pipe', note: 'x' }] });
const b2 = run([APPLY, '--plan', P_DUP, '--manifest-out', mfOf('dup'), '--apply']);
chk('rc≠0', b2.rc !== 0, 'rc=' + b2.rc);
chk('理由 = 命中 2 ≠ 1', /命中 2 ≠ 1/.test(b2.out));
chk('零写盘', sha(read(F.dup)) === S0.dup);

sec('⑪ 反例必红 · 撤销目标已不存在（行被改成既非原始态也非注态）');
const P_TXN2 = writePlan('undo-gone', { mark: MARK, noteHeader: HEADER, targets: [{ file: F.txn, label: 'T-txn2', anchor: { mode: 'prefix', text: '| 有的项 |' }, insert: 'before-trailing-pipe', note: 'x' }] });
run([APPLY, '--plan', P_TXN2, '--manifest-out', mfOf('undo-gone'), '--apply']);
fs.writeFileSync(F.txn, read(F.txn).replace('| 有的项 |', '| 被整行换成别的了 |'), 'utf8');
const b3 = run([RESTORE, '--manifest', mfOf('undo-gone'), '--apply']);
chk('rc≠0', b3.rc !== 0, 'rc=' + b3.rc);
chk('理由 = 找不到可还原行', /找不到可还原行/.test(b3.out));
chk('零写盘（篡改文本仍在）', read(F.txn).includes('| 被整行换成别的了 |'));

sec('⑫ 反例必红 · 注外篡改（注之前的内容被改）');
fs.writeFileSync(F.table, TABLE_CRLF, 'utf8');
run([APPLY, '--plan', P_GOOD, '--manifest-out', mfOf('good'), '--only', 'T-table', '--apply']);
fs.writeFileSync(F.table, read(F.table).replace('部分生效', '部分生效X'), 'utf8');
const b4 = run([RESTORE, '--manifest', mfOf('good'), '--target', 'T-table', '--apply']);
chk('rc≠0（拒动）', b4.rc !== 0, 'rc=' + b4.rc);
chk('理由 = 找不到可还原行', /找不到可还原行/.test(b4.out));
chk('零写盘（篡改文本仍在）', read(F.table).includes('部分生效X'));

sec('⑬ 反例必红 · 注文含 "|"（会破坏 Markdown 表格列）');
fs.writeFileSync(F.table, TABLE_CRLF, 'utf8');
const P_PIPE = writePlan('pipe', { mark: MARK, noteHeader: HEADER, targets: [{ file: F.table, label: 'T-pipe', anchor: { mode: 'prefix', text: '| J | L478 |' }, insert: 'before-trailing-pipe', note: '注文里有 | 竖线 |' }] });
const b5 = run([APPLY, '--plan', P_PIPE, '--manifest-out', mfOf('pipe'), '--apply']);
chk('rc≠0', b5.rc !== 0, 'rc=' + b5.rc);
chk('理由 = 注文本含 "|"', /注文本含/.test(b5.out));
chk('零写盘', sha(read(F.table)) === S0.table);

sec('⑭ 反例必红 · 事务性（一处失败 ⇒ 整批一处都不写）');
fs.writeFileSync(F.txn, TXN_TXT, 'utf8');
const P_TXN = writePlan('txn', { mark: MARK, noteHeader: HEADER, targets: [
  { file: F.txn, label: 'T-ok', anchor: { mode: 'prefix', text: '| 有的项 |' }, insert: 'before-trailing-pipe', note: '本应能加，但同批有失败项。' },
  { file: F.txn, label: 'T-bad', anchor: { mode: 'prefix', text: '| 不存在的项 |' }, insert: 'end', note: 'x' },
] });
const b6 = run([APPLY, '--plan', P_TXN, '--manifest-out', mfOf('txn'), '--apply']);
chk('rc≠0', b6.rc !== 0, 'rc=' + b6.rc);
chk('整批不写盘（sha 一字未变）', sha(read(F.txn)) === S0.txn);
chk('通过预检的那一条也没落盘', !read(F.txn).includes(MARK));

sec('⑮ 反例必红 · 计划非法（缺 mark）');
const P_BAD = writePlan('bad', { noteHeader: HEADER, targets: [{ file: F.table, label: 'T-bad2', anchor: { mode: 'prefix', text: '| J | L478 |' }, insert: 'end', note: 'x' }] });
const b7 = run([APPLY, '--plan', P_BAD, '--manifest-out', mfOf('bad'), '--apply']);
chk('rc=2（计划校验失败）', b7.rc === 2, 'rc=' + b7.rc);
chk('理由 = plan.mark 必填', /plan\.mark 必填/.test(b7.out));
chk('零写盘', sha(read(F.table)) === S0.table);

sec('⑯ 纪律自检 · --help 真实现（禁"参数被忽略后直接执行真动作"）');
const h1 = run([APPLY, '--help']);
const h2 = run([RESTORE, '--help']);
chk('apply --help rc=0 且含用法', h1.rc === 0 && /用法/.test(h1.out));
chk('restore --help rc=0 且含一行式回滚', h2.rc === 0 && /--manifest/.test(h2.out));
chk('--help 不写盘', sha(read(F.table)) === S0.table);

console.log(`\n=== 自测结论：${fail === 0 ? 'PASS（全部断言通过）' : 'FAIL（' + fail + ' 项不过）'} ===`);
process.exitCode = fail === 0 ? 0 : 1;
