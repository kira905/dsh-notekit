/**
 * dsh-notekit · 核心库 v1.0.0
 *
 * 用途：对生产文档做「锚定式加订正注 + 可逆回滚」。把此前在 4 条线（BD / I / J / W1W3）
 * 各重写一份的一次性脚本，固化成一套可复用件。需求来源 = V3.0.0 需求池 **R-038**。
 *
 * ── 纪律（写死在实现里，调用方绕不过）────────────────────────────────────────────
 *  ① 锚定 = 「项名前缀 / 域名 + 项名」；命中数必须恰 **1**，否则拒动（LF / CRLF 双变体都试）
 *  ② 幂等守卫：apply 前查「新行文本」是否已存在（LF / CRLF 双变体取较大命中数）；行内含 mark 也拒
 *  ③ 回滚 = **严格逆序（LIFO · 按 appliedSeq 降序）** + 行级块替换 + 逐字节断言；
 *     **绝不用 before 快照整档覆盖**（before 副本只作证据，回滚器一行都不读它）
 *  ④ 默认 dry-run，`--apply` 才写；dry-run 是**写盘前函数内的第一道门**
 *  ⑤ **事务性**：全文件全 target 预检全绿才写盘（任一失败 ⇒ 一个字节都不写）
 *  ⑥ 同一文件多处修改 ⇒ 内存内按**字节偏移降序**应用 + **聚合一次写盘**（不做逐处读-改-写）
 *  ⑦ 落盘用**字节切片拼接**（不用 String.replace）⇒ 替换串里的 `$&` / `$'` / `` $` `` / `$1`
 *     一律当数据不当模式（R-038 已记录的真坑：非函数式 replace 曾把整份文件复制一遍）
 *  ⑧ 写前重读整档比对（并发写者守门）；**逐行 EOL 原样保留**（含 BOM 与 EOL 混用的文件）
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const TOOLKIT = 'dsh-notekit';
export const VERSION = '1.0.0';

/** 本器具目录（**入口守卫/路径判据一律 realpath 后比** —— junction 下逻辑路径 != 物理路径）。 */
export const TOOL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 注头固定起始标记（回滚定位用：从 mark 往**前**找最近注头，防摘除后残留注的前半段）。 */
export const NOTE_HEAD = '<br>🪪';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** 默认注头：含 mark，保证「摘注后 == beforeLine」可判。 */
export function defaultNoteHeader(plan, now = new Date()) {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${NOTE_HEAD} **订正注（${d} · 卡「${plan.mark}」执行会话 · 只加注、判定列一字未动）**：`;
}

/** 逐行扫描：给出每行内容在 raw 中的字节区间（start/end **不含** EOL），逐行 EOL 原样留在原文里。 */
export function lineSpans(raw) {
  const spans = [];
  let i = 0;
  for (;;) {
    const nl = raw.indexOf('\n', i);
    if (nl < 0) { spans.push({ start: i, end: raw.length, text: raw.slice(i) }); break; }
    let end = nl;
    if (end > i && raw[end - 1] === '\r') end -= 1;
    spans.push({ start: i, end, text: raw.slice(i, end) });
    i = nl + 1;
  }
  return spans;
}

/** 文件级 EOL 标注（供人读；混用会被明确标出）。 */
export function eolOf(raw) {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const lf = (raw.match(/(?<!\r)\n/g) || []).length;
  if (crlf && lf) return 'MIXED';
  if (crlf) return 'CRLF';
  return 'LF';
}

/** 锚点文本归一化成「逻辑行」数组 —— 对 LF / CRLF 双变体免疫（双变体都试的落点）。 */
export function anchorLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n');
}

/**
 * 定位锚点。返回 { hits, mode, aLines }；hits[i] = { firstIdx, lastIdx, byteStart, byteEnd }。
 *  · 单行锚点：mode = exact（行全等）/ prefix（行首前缀）/ contains（行内包含）
 *  · 多行锚点（anchor.text 含换行）：逐行**全等**匹配，mode 记 'block'
 */
export function locate(raw, anchor) {
  if (!anchor || typeof anchor.text !== 'string' || anchor.text.length === 0) {
    throw new Error('anchor.text 必填且非空');
  }
  const aLines = anchorLines(anchor.text);
  const mode = aLines.length > 1 ? 'block' : (anchor.mode || 'prefix');
  if (!['exact', 'prefix', 'contains', 'block'].includes(mode)) throw new Error('未知 anchor.mode: ' + mode);
  const spans = lineSpans(raw);
  const hits = [];
  for (let i = 0; i + aLines.length <= spans.length; i++) {
    let ok = true;
    for (let k = 0; k < aLines.length; k++) {
      const t = spans[i + k].text;
      const a = aLines[k];
      if (mode === 'block' || mode === 'exact') { if (t !== a) { ok = false; break; } }
      else if (mode === 'prefix') { if (!t.startsWith(a)) { ok = false; break; } }
      else if (mode === 'contains') { if (!t.includes(a)) { ok = false; break; } }
    }
    if (ok) {
      const last = i + aLines.length - 1;
      hits.push({ firstIdx: i, lastIdx: last, byteStart: spans[i].start, byteEnd: spans[last].end });
    }
  }
  return { hits, mode, aLines, totalLines: spans.length };
}

/** 计算插入点（在行文本中的字符索引，插入到该索引**之前**）。 */
export function insertionPoint(lineText, insert, aLines, mode) {
  const anchorLast = aLines[aLines.length - 1];
  switch (insert) {
    case 'end':
      return lineText.length;
    case 'before-trailing-pipe':
      // 表格行：插到行尾 '|' 之前，保持列闭合；非表格行退化为行尾追加
      return lineText.endsWith('|') ? lineText.length - 1 : lineText.length;
    case 'after-anchor': {
      if (aLines.length > 1) throw new Error('insert=after-anchor 不支持多行锚点');
      const idx = mode === 'contains' ? lineText.indexOf(anchorLast) : 0;
      if (idx < 0) throw new Error('insert=after-anchor：行内找不到锚点');
      return idx + anchorLast.length;
    }
    default:
      throw new Error('未知 insert 模式: ' + insert);
  }
}

/** 子串存在性计数：LF / CRLF 双变体各数一遍，取较大值（幂等守卫用）。 */
export function existsVariants(raw, needle) {
  if (!needle) return { lf: 0, crlf: 0, max: 0 };
  const count = (n) => { let c = 0, i = 0; for (;;) { const j = raw.indexOf(n, i); if (j < 0) break; c++; i = j + n.length; } return c; };
  const lfNeedle = needle.replace(/\r\n?/g, '\n');
  const crlfNeedle = lfNeedle.replace(/\n/g, '\r\n');
  const a = count(lfNeedle);
  const b = crlfNeedle === lfNeedle ? a : count(crlfNeedle);
  return { lf: a, crlf: b, max: Math.max(a, b) };
}

/** 最长公共前缀 / 后缀 ⇒ 得到 before→after 的「插入区间」（回滚反演只靠它，与插入模式无关）。 */
export function diffSpan(before, after) {
  let L = 0;
  const maxL = Math.min(before.length, after.length);
  while (L < maxL && before[L] === after[L]) L++;
  let S = 0;
  const maxS = Math.min(before.length - L, after.length - L);
  while (S < maxS && before[before.length - 1 - S] === after[after.length - 1 - S]) S++;
  return { prefixLen: L, suffixLen: S, insertedText: after.slice(L, after.length - S) };
}

/**
 * 回滚反演：把「含注的行」还原成 beforeLine，并**逐字节断言**。
 *  · 前缀 / 后缀不匹配 ⇒ 注外被改 ⇒ 拒动
 *  · 中间段不含 mark ⇒ 不是本批的注 ⇒ 拒动（防把正常编辑误当注摘）
 */
export function revertLine(line, t, mark) {
  const before = t.beforeLine;
  if (line === before) return { ok: false, reason: 'identical' };
  const P = before.slice(0, t.prefixLen);
  const S = t.suffixLen > 0 ? before.slice(before.length - t.suffixLen) : '';
  if (P && !line.startsWith(P)) return { ok: false, reason: 'prefix-mismatch' };
  if (S && !line.endsWith(S)) return { ok: false, reason: 'suffix-mismatch' };
  if (line.length < t.prefixLen + t.suffixLen + 1) return { ok: false, reason: 'too-short' };
  const mid = line.slice(t.prefixLen, line.length - t.suffixLen);
  if (mark && !mid.includes(mark)) return { ok: false, reason: 'mark-missing' };
  const restored = line.slice(0, t.prefixLen) + line.slice(line.length - t.suffixLen);
  if (restored !== before) return { ok: false, reason: 'assert-mismatch' };
  return { ok: true, restored };
}

/** 计划文件校验（错就整批拒动，别猜）。 */
export function validatePlan(plan) {
  const errs = [];
  if (!plan || typeof plan !== 'object') return ['plan 不是对象'];
  if (!plan.mark || typeof plan.mark !== 'string') errs.push('plan.mark 必填（幂等判据 + 回滚定位用）');
  if (!Array.isArray(plan.targets) || plan.targets.length === 0) errs.push('plan.targets 必填且非空');
  const seen = new Set();
  for (const [i, t] of (plan.targets || []).entries()) {
    if (!t || typeof t !== 'object') { errs.push(`targets[${i}] 不是对象`); continue; }
    if (!t.file) errs.push(`targets[${i}] 缺 file`);
    if (!t.label) errs.push(`targets[${i}] 缺 label`);
    else if (seen.has(t.label)) errs.push(`targets[${i}] label 重复: ${t.label}`);
    else seen.add(t.label);
    if (!t.anchor || typeof t.anchor.text !== 'string' || t.anchor.text.length === 0) errs.push(`targets[${i}] 缺 anchor.text`);
    if (typeof t.note !== 'string' || t.note.length === 0) errs.push(`targets[${i}] 缺 note`);
    const ins = t.insert || 'end';
    if (!['end', 'before-trailing-pipe', 'after-anchor'].includes(ins)) errs.push(`targets[${i}] 未知 insert: ${ins}`);
    const note = (plan.noteHeader ?? defaultNoteHeader(plan)) + (t.note || '');
    if (plan.mark && !note.includes(plan.mark)) errs.push(`targets[${i}] noteHeader+note 必须含 mark（回滚定位靠它）`);
  }
  return errs;
}

export const fullNoteOf = (plan, t, now = new Date()) => (plan.noteHeader ?? defaultNoteHeader(plan, now)) + t.note;

/**
 * 加注（默认 dry-run）。事务性：预检全绿 → 写前重读 → 才逐文件写。
 * @returns { ok, rc, dryRun, errors, planned, changed, files, manifestPath, lines }
 */
export function runApply({ plan, apply = false, manifestOut = null, beforeDir = null, only = null, planFile = null, log = () => {}, now = new Date() }) {
  const lines = [];
  const L = (s) => { lines.push(s); log(s); };
  const errors = [];
  const bad = (m) => { errors.push(m); };

  const issues = validatePlan(plan);
  if (issues.length) {
    issues.forEach((m) => L('❌ ' + m));
    return { ok: false, rc: 2, dryRun: !apply, errors: issues, planned: 0, changed: 0, files: [], lines };
  }

  const targets = plan.targets.filter((t) => !only || t.label === only);
  if (targets.length === 0) {
    const m = `--only ${only} 未匹配任何 target`;
    L('❌ ' + m);
    return { ok: false, rc: 3, dryRun: !apply, errors: [m], planned: 0, changed: 0, files: [], lines };
  }

  const fileOrder = [...new Set(targets.map((t) => t.file))];
  const staged = [];
  let seq = 0;

  for (const file of fileOrder) {
    const local = targets.filter((t) => t.file === file);
    L(`\n[文件] ${file}`);
    if (!fs.existsSync(file)) { bad(`${file} 不存在`); L('  ❌ 文件不存在 ⇒ 拒动'); continue; }
    const raw = fs.readFileSync(file, 'utf8');
    const spans = lineSpans(raw);
    L(`  行数=${spans.length} · EOL=${eolOf(raw)} · 字节=${Buffer.byteLength(raw, 'utf8')} · sha256=${sha256(raw).slice(0, 16)}…`);
    const locs = [];
    for (const t of local) {
      const note = fullNoteOf(plan, t, now);
      const insert = t.insert || 'end';
      L(`\n  [${t.label}] 锚定 mode=${t.anchor.mode || 'auto'} text=${JSON.stringify(t.anchor.text).slice(0, 90)}`);
      if (note.includes('|')) { bad(`${t.label}: 注文本含 "|"`); L('    ❌ 注文本含 "|"（会被 Markdown 当列分隔）⇒ 拒动'); continue; }
      let loc;
      try { loc = locate(raw, t.anchor); }
      catch (e) { bad(`${t.label}: ${e.message}`); L(`    ❌ ${e.message} ⇒ 拒动`); continue; }
      L(`    锚点命中=${loc.hits.length}（模式 ${loc.mode}）`);
      if (loc.hits.length !== 1) { bad(`${t.label}: 锚点命中 ${loc.hits.length} ≠ 1`); L('    ❌ 命中数 ≠ 1 ⇒ 拒动'); continue; }
      const hit = loc.hits[0];
      // ⚠️ 多行块锚点：真正被改的是**块末行**（插入只发生在这一行内）——
      //    beforeLine / 字节切片 / 复核行号一律只针对它（2026-10-15 自测抓到的缺陷）
      const insSpan = spans[hit.lastIdx];
      const lineText = insSpan.text;
      const span = { start: insSpan.start, end: insSpan.end };
      if (plan.mark && lineText.includes(plan.mark)) { bad(`${t.label}: 行内已含 mark`); L('    ❌ 行内已存在本批标记 ⇒ 幂等拒动'); continue; }
      let cut;
      try { cut = insertionPoint(lineText, insert, loc.aLines, loc.mode); }
      catch (e) { bad(`${t.label}: ${e.message}`); L(`    ❌ ${e.message} ⇒ 拒动`); continue; }
      const newLine = lineText.slice(0, cut) + note + lineText.slice(cut);
      if (newLine === lineText) { bad(`${t.label}: 新旧相同`); L('    ❌ 新旧相同 ⇒ 拒动'); continue; }
      const already = existsVariants(raw, newLine);
      if (already.max > 0) { bad(`${t.label}: 注文已存在（LF ${already.lf} / CRLF ${already.crlf}）`); L(`    ❌ 幂等守卫：新行文本已存在（LF ${already.lf} / CRLF ${already.crlf}）⇒ 拒动`); continue; }
      const d = diffSpan(lineText, newLine);
      if (d.insertedText.length === 0) { bad(`${t.label}: 插入段为空`); L('    ❌ 插入段为空 ⇒ 拒动'); continue; }
      locs.push({ t, hit, span, lineText, newLine, note, cut, insert, insertIdx: hit.lastIdx, ...d });
      L(`    行号=${hit.firstIdx + 1}${hit.lastIdx !== hit.firstIdx ? '～' + (hit.lastIdx + 1) : ''} · 原行长=${lineText.length} · 新行长=${newLine.length}（+${newLine.length - lineText.length}）· 插入点=${cut} · 增量为 ${d.insertedText.length} 字`);
    }
    // 同一文件：按字节偏移**严格降序**应用，聚合一次写盘
    locs.sort((a, b) => b.span.start - a.span.start);
    locs.forEach((l) => { l.appliedSeq = ++seq; });
    let cur = raw;
    for (const l of locs) cur = cur.slice(0, l.span.start) + l.newLine + cur.slice(l.span.end);
    staged.push({ file, raw, newRaw: cur, locs });
  }

  const planned = staged.reduce((n, s) => n + s.locs.length, 0);
  if (errors.length) {
    L(`\n❌ 预检未全绿（${errors.length} 项）⇒ **整批不写盘**（事务性）`);
    return { ok: false, rc: 1, dryRun: !apply, errors, planned, changed: 0, files: fileOrder, lines };
  }

  // ── 写盘门（dry-run 是这里的第一道门）────────────────────────────────
  if (!apply) {
    L(`\n[dry-run] 预检全绿 · 计划加注 ${planned} 处 / ${staged.length} 个文件 · **未写盘**（真写加 --apply）`);
    return { ok: true, rc: 0, dryRun: true, errors: [], planned, changed: 0, files: fileOrder, lines };
  }

  // 写前全量重读（并发写者守门）——通过后才逐文件写
  for (const s of staged) {
    const re = fs.readFileSync(s.file, 'utf8');
    if (re !== s.raw) { bad(`${s.file}: 预检后已被并发写者改动`); }
  }
  if (errors.length) {
    L(`\n❌ 写前重读发现并发改动 ⇒ **整批不写盘**`);
    errors.forEach((m) => L('  · ' + m));
    return { ok: false, rc: 1, dryRun: false, errors, planned, changed: 0, files: fileOrder, lines };
  }

  const fileStats = [];
  for (const s of staged) {
    fs.writeFileSync(s.file, s.newRaw, 'utf8');
    const back = fs.readFileSync(s.file, 'utf8');
    const backSpans = lineSpans(back);
    let okAll = back === s.newRaw;
    const rows = [];
    for (const l of s.locs) {
      const cell = backSpans[l.insertIdx];
      const txt = cell ? cell.text : '';
      const ok = txt === l.newLine && (!plan.mark || txt.includes(plan.mark));
      if (!ok) okAll = false;
      rows.push({ lineNo: l.insertIdx + 1, ok });
    }
    L(`  ✅ 已写盘 ${s.file} · 改 ${s.locs.length} 行 · 行数=${backSpans.length} · 写后复核=${okAll ? 'PASS' : 'FAIL'}`);
    if (!okAll) bad(`${s.file}: 写后复核失败`);
    fileStats.push({
      file: s.file, lines: backSpans.length,
      bytesBefore: Buffer.byteLength(s.raw, 'utf8'), bytesAfter: Buffer.byteLength(back, 'utf8'),
      sha256Before: sha256(s.raw), sha256After: sha256(back), rows,
    });
  }

  let manifestPath = null;
  if (manifestOut) {
    const manifest = {
      version: 1, toolkit: TOOLKIT, toolkitVersion: VERSION,
      mark: plan.mark, noteHeader: plan.noteHeader ?? defaultNoteHeader(plan, now),
      createdAt: now.toISOString(), planFile,
      targets: staged.flatMap((s) => s.locs.map((l) => ({
        appliedSeq: l.appliedSeq, label: l.t.label, file: s.file, lineNo: l.insertIdx + 1,
        anchor: l.t.anchor, insert: l.insert,
        beforeLine: l.lineText, afterLine: l.newLine,
        prefixLen: l.prefixLen, suffixLen: l.suffixLen,
        insertedText: l.insertedText,
        beforeLineSha256: sha256(l.lineText), afterLineSha256: sha256(l.newLine),
      }))),
      files: fileStats.map((f) => ({ file: f.file, lines: f.lines, bytesBefore: f.bytesBefore, bytesAfter: f.bytesAfter, sha256Before: f.sha256Before, sha256After: f.sha256After })),
    };
    fs.mkdirSync(path.dirname(manifestOut), { recursive: true });
    fs.writeFileSync(manifestOut, JSON.stringify(manifest, null, 2), 'utf8');
    manifestPath = manifestOut;
    L(`\nmanifest（回滚器唯一输入）= ${manifestOut}`);
    if (beforeDir) {
      fs.mkdirSync(beforeDir, { recursive: true });
      for (const s of staged) {
        const dst = path.join(beforeDir, `${sha256(s.file).slice(0, 8)}-${path.basename(s.file)}`);
        fs.writeFileSync(dst, s.raw, 'utf8');
        L(`before 副本（**仅证据**，回滚器不读它）= ${dst}`);
      }
    }
  }

  const changed = planned;
  if (errors.length) return { ok: false, rc: 1, dryRun: false, errors, planned, changed: 0, files: fileOrder, manifestPath, lines };
  L(`\nrc=0 · 已加注 ${changed} 处 / ${staged.length} 个文件`);
  L(`一行式回滚：node "${path.join(TOOL_DIR, 'restore-note.mjs')}" --manifest "${manifestPath || '<manifest.json>'}" --apply`);
  return { ok: true, rc: 0, dryRun: false, errors: [], planned, changed, files: fileOrder, manifestPath, lines };
}

/**
 * 回滚（默认 dry-run）。严格逆序（appliedSeq 降序）+ 行级块替换 + 逐字节断言，禁整档覆盖。
 * @returns { ok, rc, dryRun, errors, restored, skipped, files, lines }
 */
export function runRestore({ manifest, apply = false, only = null, expectFileSha = {}, log = () => {} }) {
  const lines = [];
  const L = (s) => { lines.push(s); log(s); };
  const errors = [];
  const bad = (m) => errors.push(m);

  if (!manifest || !Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    const m = 'manifest 缺失或 targets 为空';
    L('❌ ' + m);
    return { ok: false, rc: 2, dryRun: !apply, errors: [m], restored: 0, skipped: 0, files: [], lines };
  }
  const mark = manifest.mark;
  const picked = manifest.targets.filter((t) => !only || t.label === only);
  if (picked.length === 0) {
    const m = `--target ${only} 未匹配任何记录`;
    L('❌ ' + m);
    return { ok: false, rc: 3, dryRun: !apply, errors: [m], restored: 0, skipped: 0, files: [], lines };
  }
  // LIFO：后落地的先撤
  const ordered = picked.slice().sort((a, b) => (b.appliedSeq || 0) - (a.appliedSeq || 0));
  const fileOrder = [...new Set(ordered.map((t) => t.file))];
  L(`manifest = ${manifest.mark} · 目标 ${ordered.length} 处 / ${fileOrder.length} 个文件 · 顺序 = LIFO（appliedSeq 降序）· apply=${apply}`);

  const staged = [];
  let skipped = 0;
  for (const file of fileOrder) {
    const ts = ordered.filter((t) => t.file === file);
    L(`\n[文件] ${file}`);
    if (!fs.existsSync(file)) { bad(`${file} 不存在`); L('  ❌ 文件不存在 ⇒ 拒动'); continue; }
    const raw = fs.readFileSync(file, 'utf8');
    const spans = lineSpans(raw);
    L(`  行数=${spans.length} · LIFO 次序 = ${ts.map((t) => t.label).join(' → ')} · sha256=${sha256(raw).slice(0, 16)}…`);
    const hits = [];
    for (const t of ts) {
      const cands = [];
      spans.forEach((sp, i) => { const r = revertLine(sp.text, t, mark); if (r.ok) cands.push({ i, span: sp }); });
      if (cands.length === 1) {
        const c = cands[0];
        hits.push({ t, start: c.span.start, end: c.span.end, lineNo: c.i + 1 });
        L(`  [${t.label}] 定位行号=${c.i + 1}（期望 ${t.lineNo}）· 摘注后逐字节 == beforeLine ✅`);
        continue;
      }
      if (cands.length === 0) {
        const orig = spans.filter((sp) => sp.text === t.beforeLine).length;
        if (orig === 1) { skipped++; L(`  [${t.label}] ⚠️ 已是原始态（无本批注）⇒ 幂等跳过`); continue; }
        bad(`${t.label}: 无可还原行（原始态行数 ${orig}）`);
        L(`  [${t.label}] ❌ 找不到可还原行（原始态行 ${orig}）⇒ 拒动（注不存在且非原始态 = 撤销目标已不存在）`);
        continue;
      }
      bad(`${t.label}: 可还原候选 ${cands.length} ≠ 1`);
      L(`  [${t.label}] ❌ 候选 ${cands.length} ≠ 1 ⇒ 拒动`);
    }
    hits.sort((a, b) => b.start - a.start);
    let cur = raw;
    for (const h of hits) cur = cur.slice(0, h.start) + h.t.beforeLine + cur.slice(h.end);
    staged.push({ file, raw, newRaw: cur, count: hits.length, targets: hits.map((h) => h.t) });
  }

  const restored = staged.reduce((n, s) => n + s.count, 0);
  if (errors.length) {
    L(`\n❌ 预检未全绿（${errors.length} 项）⇒ **整批不写盘**`);
    return { ok: false, rc: 1, dryRun: !apply, errors, restored: 0, skipped, files: fileOrder, lines };
  }
  const expectList = Object.entries(expectFileSha || {});
  if (!apply) {
    for (const s of staged) L(`  [dry-run] 将回滚 ${s.count} 处：${s.file}`);
    for (const [f, sha] of expectList) {
      const s = staged.find((x) => x.file === f) || { newRaw: fs.readFileSync(f, 'utf8') };
      const got = sha256(s.newRaw);
      L(got === sha ? `  [dry-run] 整档 sha 断言 ${f} ✅ ${got.slice(0, 16)}…` : `  [dry-run] 整档 sha 断言 ${f} ❌ 预期 ${sha.slice(0, 16)}… 实得 ${got.slice(0, 16)}…`);
      if (got !== sha) bad(`${f}: 整档 sha 断言失败`);
    }
    L(`\n[dry-run] 计划回滚 ${restored} 处 · 跳过 ${skipped} 处 · **未写盘**（真回滚加 --apply）`);
    return { ok: errors.length === 0, rc: errors.length ? 1 : 0, dryRun: true, errors, restored: 0, skipped, files: fileOrder, lines };
  }

  for (const s of staged) {
    const re = fs.readFileSync(s.file, 'utf8');
    if (re !== s.raw) bad(`${s.file}: 预检后已被并发写者改动`);
  }
  if (errors.length) {
    L(`\n❌ 写前重读发现并发改动 ⇒ **整批不写盘**`);
    return { ok: false, rc: 1, dryRun: false, errors, restored: 0, skipped, files: fileOrder, lines };
  }

  for (const s of staged) {
    fs.writeFileSync(s.file, s.newRaw, 'utf8');
    const back = fs.readFileSync(s.file, 'utf8');
    const ok = back === s.newRaw;
    const gone = mark ? !back.includes(mark) || back === s.newRaw : true;
    L(`  ✅ 已回滚 ${s.file} · 撤 ${s.count} 处 · 行数=${lineSpans(back).length} · 写后复核=${ok ? 'PASS' : 'FAIL'} · 该档仍含 mark=${back.includes(mark)}`);
    if (!ok) bad(`${s.file}: 写后复核失败`);
  }
  for (const [f, sha] of expectList) {
    const got = sha256(fs.readFileSync(f, 'utf8'));
    L(got === sha ? `  整档 sha 断言 ${f} ✅ ${got.slice(0, 16)}…` : `  整档 sha 断言 ${f} ❌ 预期 ${sha.slice(0, 16)}… 实得 ${got.slice(0, 16)}…`);
    if (got !== sha) bad(`${f}: 整档 sha 断言失败`);
  }

  if (errors.length) return { ok: false, rc: 1, dryRun: false, errors, restored: 0, skipped, files: fileOrder, lines };
  L(`\nrc=0 · 已回滚 ${restored} 处（跳过 ${skipped} 处已还原的）`);
  return { ok: true, rc: 0, dryRun: false, errors: [], restored, skipped, files: fileOrder, lines };
}
