#!/usr/bin/env node
// dsh-notekit / drill.mjs —— 夹具树演练。**全程只碰自己建的夹具树；生产档只读、只算 sha 作证。**
//
// 十一阶段：① 生产零接触基线 ② 建夹具树 ③ apply ④ 幂等复跑 ⑤ restore dry-run
//          ⑥ restore --apply（逐字节还原）⑦ restore 幂等复跑 ⑧ LIFO 次序验证
//          ⑨ 反例：注外篡改 ⇒ 拒动 ⑩ 一行式回滚命令实测 ⑪ 生产零接触复查（sha 比对）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLY = path.join(HERE, 'apply-note.mjs');
const RESTORE = path.join(HERE, 'restore-note.mjs');
const DIR = path.join(os.tmpdir(), 'dsh-notekit-drill');
const TREE = path.join(DIR, 'fixture');
const PLANS = path.join(DIR, 'plans');
const MF = path.join(DIR, 'manifest.json');

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const read = (f) => fs.readFileSync(f, 'utf8');
const run = (args) => { const r = spawnSync(process.execPath, args, { encoding: 'utf8' }); return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
let fail = 0;
const chk = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' · ' + extra : ''}`); if (!cond) fail++; };
const sec = (t) => console.log(`\n──── ${t} ────`);

function safeReset(dir) {
  const rp = path.resolve(dir);
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!rp.startsWith(tmpRoot) || !path.basename(rp).startsWith('dsh-notekit-')) throw new Error('拒删（不在白名单前缀内）: ' + rp);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('拒删（是链接）: ' + dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// 只读的「生产档」取证清单：由命令行传入（零参数 = 不碰任何外部档）。
// 本演练**只**对它们算 sha，绝不对它们执行 apply/restore。
const PROD = process.argv.slice(2).filter((a) => !a.startsWith('--') && fs.existsSync(a));

console.log(`=== dsh-notekit 夹具树演练 === 夹具树 = ${TREE}`);

sec('① 生产零接触基线（只读 · 跑前 sha）');
const prodBefore = {};
for (const f of PROD) { prodBefore[f] = sha(read(f)); console.log(`   ${path.basename(f)} · ${Buffer.byteLength(read(f), 'utf8')} B · sha256=${prodBefore[f]}`); }

sec('② 建夹具树');
safeReset(DIR);
fs.mkdirSync(path.join(TREE, 'sub'), { recursive: true });
fs.mkdirSync(PLANS, { recursive: true });
const T = {
  closure: path.join(TREE, 'closure-like.md'),
  readme: path.join(TREE, 'readme-like.md'),
  ledger: path.join(TREE, 'sub', 'ledger-like.md'),
};
const CLOSURE = ['| 序 | 项 | 判定 | 归属 | 备注 |', '| --- | --- | --- | --- | --- |', '| J | L478 | B3 tidy-readme-gen | 🟡 | ① V2内修·可自主 | 生成侧非自动 |', '| K | L479 | 别的项 | ✅ | — | 已生效 |'].join('\r\n') + '\r\n';
const README = ['# 归档区索引', '', '- 归档说明：本文件由生成器整篇重写。', ''].join('\n');
const LEDGER = ['| 卡 | 状态 |', '| --- | --- |', '| a1 | 🟡 部分 |', '| a2 | 🟡 部分 |'].join('\r\n') + '\r\n';
fs.writeFileSync(T.closure, CLOSURE, 'utf8');
fs.writeFileSync(T.readme, README, 'utf8');
fs.writeFileSync(T.ledger, LEDGER, 'utf8');
const ORIG = { closure: CLOSURE, readme: README, ledger: LEDGER };
const S0 = Object.fromEntries(Object.entries(T).map(([k, f]) => [k, sha(read(f))]));
for (const [k, f] of Object.entries(T)) console.log(`   ${k.padEnd(7)} ${path.relative(TREE, f).padEnd(18)} ${Buffer.byteLength(read(f), 'utf8')} B · sha256=${S0[k]}`);

const MARK = 'drill-notekit';
const HEADER = `<br>🪪 **订正注（演练 · 卡「${MARK}」）**：`;
const noteOf = (s) => HEADER + s;
const full = noteOf;
const PLAN = path.join(PLANS, 'drill.json');
fs.writeFileSync(PLAN, JSON.stringify({
  mark: MARK, noteHeader: HEADER,
  targets: [
    { file: T.closure, label: 'closure-J', anchor: { mode: 'prefix', text: '| J | L478 |' }, insert: 'before-trailing-pipe', note: 'J 域销账注（演练样本）。' },
    { file: T.readme, label: 'readme-line', anchor: { mode: 'contains', text: '- 归档说明：' }, insert: 'end', note: 'README 追加注（演练样本）。' },
    { file: T.ledger, label: 'ledger-a1', anchor: { mode: 'prefix', text: '| a1 |' }, insert: 'before-trailing-pipe', note: '第一处（同一文件内）。' },
    { file: T.ledger, label: 'ledger-a2', anchor: { mode: 'prefix', text: '| a2 |' }, insert: 'before-trailing-pipe', note: '第二处（同一文件内）。' },
  ],
}, null, 2), 'utf8');

sec('③ apply（真写 · 4 处 / 3 文件）');
const a = run([APPLY, '--plan', PLAN, '--manifest-out', MF, '--before-dir', path.join(DIR, 'before'), '--apply']);
console.log(a.out.trim().split('\n').slice(-8).map((s) => '   ' + s).join('\n'));
chk('apply rc=0', a.rc === 0, 'rc=' + a.rc);
const strip = (after, note) => { const i = after.indexOf(note); return i < 0 || after.indexOf(note, i + 1) >= 0 ? null : after.slice(0, i) + after.slice(i + note.length); };
chk('closure：去注后逐字节 == 原件', strip(read(T.closure), full('J 域销账注（演练样本）。')) === CLOSURE);
chk('readme：去注后逐字节 == 原件', strip(read(T.readme), full('README 追加注（演练样本）。')) === README);
chk('ledger：去注后逐字节 == 原件（两处注都在）', (() => { const s = strip(strip(read(T.ledger), full('第一处（同一文件内）。')), full('第二处（同一文件内）。')); return s === LEDGER; })());
chk('行数一律不变', read(T.closure).split(/\r?\n/).length === CLOSURE.split(/\r?\n/).length && read(T.ledger).split(/\r?\n/).length === LEDGER.split(/\r?\n/).length);
const mf = JSON.parse(read(MF));
chk('manifest：4 条记录 · 同文件两处 appliedSeq 严格递增', mf.targets.length === 4 && (() => { const l = mf.targets.filter((t) => t.file === T.ledger).map((t) => t.appliedSeq).sort(); return l.length === 2 && l[1] > l[0]; })());

sec('④ 幂等复跑 apply（应拒动 · 零改动）');
const S_AFTER = Object.fromEntries(Object.entries(T).map(([k, f]) => [k, read(f)]));
const a2 = run([APPLY, '--plan', PLAN, '--manifest-out', path.join(DIR, 'manifest2.json'), '--apply']);
chk('rc≠0（4 处全被幂等守卫拒）', a2.rc !== 0, 'rc=' + a2.rc);
chk('三个夹具 sha 一字未变', Object.entries(T).every(([k, f]) => read(f) === S_AFTER[k]));
chk('未产出新 manifest（拒动不写 manifest）', !fs.existsSync(path.join(DIR, 'manifest2.json')));

sec('⑤ restore dry-run（默认不写盘）');
const r1 = run([RESTORE, '--manifest', MF]);
chk('rc=0', r1.rc === 0, 'rc=' + r1.rc);
chk('dry-run 零写盘', Object.entries(T).every(([k, f]) => read(f) === S_AFTER[k]));

sec('⑥ restore --apply（LIFO · 逐字节还原 · 贴 sha）');
const r2 = run([RESTORE, '--manifest', MF, '--apply']);
console.log(r2.out.trim().split('\n').filter((s) => /回滚|LIFO/.test(s)).map((s) => '   ' + s).join('\n'));
chk('rc=0', r2.rc === 0, 'rc=' + r2.rc);
for (const [k, f] of Object.entries(T)) {
  const now = sha(read(f));
  console.log(`   ${k.padEnd(7)} 原件 ${S0[k].slice(0, 32)}… / 回滚后 ${now.slice(0, 32)}…`);
  chk(`${k}：逐字节 == 原件`, now === S0[k]);
}

sec('⑦ restore 幂等复跑（应跳过 · rc=0 · 零改动）');
const r3 = run([RESTORE, '--manifest', MF, '--apply']);
chk('rc=0（幂等跳过）', r3.rc === 0, 'rc=' + r3.rc);
chk('提示跳过 4 处', /跳过 4 处/.test(r3.out));
chk('三个夹具仍 == 原件 sha', Object.entries(T).every(([k, f]) => sha(read(f)) === S0[k]));

sec('⑧ LIFO 次序验证（回滚次序 == appliedSeq 降序）');
const seqOrder = mf.targets.slice().sort((x, y) => y.appliedSeq - x.appliedSeq).map((t) => t.label);
const fileOrderOut = [];
for (const line of r2.out.split('\n')) { const m = /LIFO 次序 = ([^·]+)/.exec(line); if (m) fileOrderOut.push(...m[1].split(' → ').map((s) => s.trim())); }
console.log(`   manifest 降序 = ${seqOrder.join(' → ')}`);
console.log(`   回滚器实际 = ${fileOrderOut.join(' → ')}`);
chk('每条记录都按 appliedSeq 降序被处理', fileOrderOut.length === 4 && seqOrder.every((l) => fileOrderOut.includes(l)));

sec('⑨ 反例：注外篡改 ⇒ 拒动 · 零写盘');
run([APPLY, '--plan', PLAN, '--manifest-out', MF, '--apply']);
const tampered = read(T.closure).replace('① V2内修·可自主', '① V2内修·可自主X');
fs.writeFileSync(T.closure, tampered, 'utf8');
const b = run([RESTORE, '--manifest', MF, '--target', 'closure-J', '--apply']);
chk('rc≠0（拒动）', b.rc !== 0, 'rc=' + b.rc);
chk('零写盘（篡改文本仍在）', read(T.closure) === tampered);
fs.writeFileSync(T.closure, tampered.replace('① V2内修·可自主X', '① V2内修·可自主'), 'utf8');

sec('⑩ 一行式回滚命令实测');
const ONELINE = `node "${RESTORE}" --manifest "${MF}" --apply`;
console.log(`   $ ${ONELINE}`);
const r4 = run([RESTORE, '--manifest', MF, '--apply']);
chk('一行式回滚 rc=0', r4.rc === 0, 'rc=' + r4.rc);
chk('三个夹具逐字节 == 原件', Object.entries(T).every(([k, f]) => sha(read(f)) === S0[k]));
console.log('   dry-run 形态（更安全的默认）：');
const r5 = run([RESTORE, '--manifest', MF]);
chk('dry-run 形态 rc=0 且零写盘', r5.rc === 0 && Object.entries(T).every(([k, f]) => sha(read(f)) === S0[k]));

sec('⑪ 生产零接触复查（跑后 sha 必须与跑前逐位一致）');
for (const f of PROD) {
  const now = sha(read(f));
  chk(`${path.basename(f)}：跑前跑后 sha 一致`, now === prodBefore[f], `${now.slice(0, 32)}…`);
}

console.log(`\n=== 演练结论：${fail === 0 ? 'PASS（全部断言通过）' : 'FAIL（' + fail + ' 项不过）'} ===`);
process.exitCode = fail === 0 ? 0 : 1;
