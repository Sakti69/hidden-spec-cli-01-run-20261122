// main.ts is mend, the CLI SPEC.md specifies: one tool that applies AI-written
// edits in four formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON
// edits) to a tree of text files, changing every file or none. Node 22, the
// standard library alone; run as `node main.ts [options] [PATCH]`.
//
// How it is built: section 1 (command line) and section 2 (output, exit codes)
// are in run() at the bottom; section 3 (files, lines, paths) in parseFile /
// renderFile / safe; section 4 (format detection) in detect; section 5 (three
// tiers of line matching, tier-2 re-indentation) in occurrences / findTier /
// applyN; section 6 (unified diffs) in unifiedEdits; section 7 (SEARCH/REPLACE)
// in srEdits; section 8 (V4A) in v4aEdits; section 9 (JSON edits) in jsonEdits;
// section 10 (order and atomicity) in run(), which applies edits in order to a
// Tree, rolls a failed edit back, and writes nothing when any edit failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file's lines, its line break, and whether it ends with a line break. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 5: matching lines at three tiers. */
function tierNorm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  const want = oldLines.map((l) => tierNorm(l, tier));
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (tierNorm(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, oldLines, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** One line of N: `text`, and for a context line the index of its line in O. */
interface NItem {
  text: string;
  ctx: number | null;
}

/**
 * Build the replacement lines: a context line is written as the file's own
 * matched line, never the patch's; at tier 2 every other line is re-indented
 * from O's first line's leading whitespace to the file's.
 */
function applyN(N: NItem[], matched: string[], O: string[], tier: number): string[] {
  const P = O.length > 0 ? leadingWS(O[0]!) : '';
  const F = matched.length > 0 ? leadingWS(matched[0]!) : '';
  return N.map((it) => {
    if (it.ctx !== null) return matched[it.ctx]!;
    if (tier !== 2) return it.text;
    const t = it.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

/** One hunk or chunk: old lines O, new lines N, and whether a `\` line follows its last context or `+` line. */
interface Hunk {
  a: number;
  O: string[];
  N: NItem[];
  noNL: boolean;
  /** One flag per `+` line in body order: whether a `\` line follows that line. */
  plusNoNL: boolean[];
}

/** Split hunk/chunk body lines into O and N, and read the `\` line after the last N line. */
function buildHunk(body: string[], a: number): Hunk {
  const O: string[] = [];
  const N: NItem[] = [];
  const plusNoNL: boolean[] = [];
  let lastN = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l.startsWith(' ') || l === '') {
      const text = l === '' ? '' : l.slice(1);
      O.push(text);
      N.push({ text, ctx: O.length - 1 });
      lastN = i;
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), ctx: null });
      plusNoNL.push(body[i + 1] !== undefined && body[i + 1]!.startsWith('\\'));
      lastN = i;
    }
    // a `\` line refers to the body line before it and is not itself a line of O or N.
  }
  const noNL = lastN >= 0 && body[lastN + 1] !== undefined && body[lastN + 1]!.startsWith('\\');
  return { a, O, N, noNL, plusNoNL };
}

/**
 * Apply hunks in order to a file's text. Each hunk takes, of the occurrences
 * at the tier where O is found, the one nearest to A - 1 + d; an empty O
 * inserts after the first A + d lines. The result keeps the file's line break;
 * its final break changes only when a hunk touches the end of the file.
 */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const st = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.O.length > 0) {
      const found = findTier(st.lines, h.O, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const matched = st.lines.slice(best, best + h.O.length);
      const repl = applyN(h.N, matched, h.O, found.tier);
      const atEnd = best + h.O.length === st.lines.length;
      st.lines = [...st.lines.slice(0, best), ...repl, ...st.lines.slice(best + h.O.length)];
      if (atEnd) st.final = !h.noNL;
      d += h.N.length - h.O.length;
    } else {
      const pos = Math.max(0, Math.min(h.a + d, st.lines.length));
      const repl = h.N.map((it) => it.text);
      const atEnd = pos === st.lines.length;
      st.lines.splice(pos, 0, ...repl);
      if (atEnd) st.final = !h.noNL;
      d += h.N.length;
    }
  }
  return renderFile(st);
}

/** Section 6: unified diffs. */
interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renFrom: string | undefined;
  renTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function uniPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  // A `diff --git` line is one that is exactly that text or starts with it
  // plus a space; section 6 makes one not of the `a/<X> b/<Y>` form a parse
  // fault, bare `diff --git` included.
  const isDiff = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const isBodyLine = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
  const newSection = (s: UniSection): void => {
    sections.push(s);
  };

  let cur: UniSection | null = null;
  let inHeader = false;
  let curHunk: { a: number; body: string[] } | null = null;
  const flushHunk = (): void => {
    if (curHunk !== null && cur !== null) {
      const body = curHunk.body;
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(body, curHunk.a));
    }
    curHunk = null;
  };
  const startDiffSection = (line: string, no: number): void => {
    const m = diffRe.exec(line);
    if (!m) throw new Exit2(`error: parse ${no}`);
    flushHunk();
    cur = { pairOld: undefined, pairNew: undefined, renFrom: undefined, renTo: undefined, diffOld: m[1], diffNew: m[2], create: false, del: false, hunks: [] };
    newSection(cur);
    inHeader = true;
  };
  // A `--- ` line followed by a `+++ ` line starts a bare section, unless it
  // is the header pair of the section already open.
  const takePair = (i: number): boolean => {
    if (cur !== null && inHeader && cur.pairOld === undefined) {
      cur.pairOld = uniPath(lines[i]!.slice(4));
      cur.pairNew = uniPath(lines[i + 1]!.slice(4));
      return true;
    }
    flushHunk();
    cur = { pairOld: uniPath(lines[i]!.slice(4)), pairNew: uniPath(lines[i + 1]!.slice(4)), renFrom: undefined, renTo: undefined, diffOld: undefined, diffNew: undefined, create: false, del: false, hunks: [] };
    newSection(cur);
    inHeader = true;
    return true;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const no = i + 1;
    if (curHunk !== null) {
      if (isDiff(l)) {
        startDiffSection(l, no);
        i++;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        takePair(i);
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) {
        flushHunk();
        const m = hunkRe.exec(l);
        if (!m) throw new Exit2(`error: parse ${no}`);
        curHunk = { a: parseInt(m[1]!, 10), body: [] };
        inHeader = false;
        i++;
        continue;
      }
      if (isBodyLine(l)) {
        curHunk.body.push(l);
        i++;
        continue;
      }
      flushHunk();
      inHeader = false;
      // fall through: re-process this line outside the hunk body.
    }
    if (isDiff(l)) {
      startDiffSection(l, no);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      takePair(i);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${no}`);
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      inHeader = false;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        // A `--- ` line inside a section's header that no `+++ ` line follows.
        throw new Exit2(`error: parse ${no + 1}`);
      }
      if (l.startsWith('rename from ')) cur.renFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  flushHunk();

  return sections.map((s) => {
    const oldP = s.pairOld !== undefined ? s.pairOld : s.renFrom !== undefined ? s.renFrom : s.diffOld !== undefined ? s.diffOld : null;
    const newP = s.pairNew !== undefined ? s.pairNew : s.renTo !== undefined ? s.renTo : s.diffNew !== undefined ? s.diffNew : null;
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (oldP === null && newP === null) return;
      if (oldP === null || s.create) {
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let noNL = false;
        for (const h of s.hunks) {
          for (let k = 0; k < h.N.length; k++) {
            if (h.N[k]!.ctx === null) plus.push(h.N[k]!.text);
          }
          // The `\` line after this hunk's last `+` line, if that is the
          // section's last `+` line overall, decides the final break.
          const bodyPlus = hunkPlusFlags(h);
          if (bodyPlus.length > 0) noNL = bodyPlus[bodyPlus.length - 1]!;
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
        return;
      }
      if (newP === null || s.del) {
        if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
        tree.now.set(oldP!, null);
        return;
      }
      if (oldP !== newP) {
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(before, s.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, out);
        tree.moves.push({ old: oldP, nw: newP });
        return;
      }
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, applyHunks(before, s.hunks, strict, oldP));
    };
  });
}

/** One flag per `+` line of a hunk, in body order: whether a `\` line follows it. */
function hunkPlusFlags(h: Hunk): boolean[] {
  return h.plusNoNL;
}

/** Section 7: SEARCH/REPLACE blocks. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.trimEnd() === '=======';
  const isEnd = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isSearch(lines[i]!)) {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isSep(lines[j]!)) {
        sep = j;
        break;
      }
      // A `>>>>>>> REPLACE` line before any `=======` is the section 7 parse
      // fault: do not let the scan run on into a later block's separator.
      if (isEnd(lines[j]!)) break;
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j++) {
        if (isEnd(lines[j]!)) {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const st = parseFile(cur);
      const found = findTier(st.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const matched = st.lines.slice(pos, pos + oldLines.length);
      const repl = applyN(
        newLines.map((t) => ({ text: t, ctx: null })),
        matched,
        oldLines,
        found.tier,
      );
      st.lines = [...st.lines.slice(0, pos), ...repl, ...st.lines.slice(pos + oldLines.length)];
      tree.now.set(p, renderFile(st));
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */
interface VChunk {
  anchor: string;
  eof: boolean;
  O: string[];
  N: NItem[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const end = last;
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');

  let i = first + 1;
  while (i < end) {
    while (i < end && blank(lines[i]!)) i++;
    if (i >= end) break;
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File:')) {
      kind = 'add';
      path = l.slice('*** Add File:'.length).trim();
    } else if (l.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = l.slice('*** Delete File:'.length).trim();
    } else if (l.startsWith('*** Update File:')) {
      kind = 'update';
      path = l.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const raw: Array<{ text: string; no: number }> = [];
    while (i < end) {
      const cl = lines[i]!;
      if (isSectionStart(cl)) break;
      raw.push({ text: cl, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text === '') content.push('');
        else if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const p = path;
      const text = content.length === 0 ? '' : content.join('\n') + '\n';
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      });
      continue;
    }
    if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      const p = path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // Update: an optional `*** Move to:` first line, then chunks.
    let moveTo: string | null = null;
    let idx = 0;
    if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
      moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    let curChunk: { anchor: string; eof: boolean; body: Array<{ text: string; no: number }> } | null = null;
    // True once a chunk was closed by `*** End of File`: a body line after
    // that cannot start a chunk (section 8 lets a body line start only the
    // first chunk), so it is a parse fault.
    let afterEof = false;
    const closeChunk = (): void => {
      if (curChunk === null) return;
      const O: string[] = [];
      const N: NItem[] = [];
      for (const r of curChunk.body) {
        const t = r.text;
        if (t.startsWith(' ') || t === '') {
          const text = t === '' ? '' : t.slice(1);
          O.push(text);
          N.push({ text, ctx: O.length - 1 });
        } else if (t.startsWith('-')) {
          O.push(t.slice(1));
        } else if (t.startsWith('+')) {
          N.push({ text: t.slice(1), ctx: null });
        }
      }
      chunks.push({ anchor: curChunk.anchor, eof: curChunk.eof, O, N });
      curChunk = null;
    };
    for (; idx < raw.length; idx++) {
      const r = raw[idx]!;
      const t = r.text;
      if (t.startsWith('@@')) {
        closeChunk();
        afterEof = false;
        curChunk = { anchor: t.slice(2).trim(), eof: false, body: [] };
      } else if (t === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${r.no}`);
        curChunk.eof = true;
        closeChunk();
        afterEof = true;
      } else if (t.startsWith('***')) {
        throw new Exit2(`error: parse ${r.no}`);
      } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
        if (curChunk === null) {
          if (afterEof) throw new Exit2(`error: parse ${r.no}`);
          curChunk = { anchor: '', eof: false, body: [] };
        }
        curChunk.body.push(r);
      } else {
        throw new Exit2(`error: parse ${r.no}`);
      }
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
    const p = path;
    const mt = moveTo;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
      const st = parseFile(cur);
      let cursor = 0;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const ch of chunks) {
        if (ch.anchor !== '') {
          let foundAt: number | null = null;
          for (const t of tiers) {
            let hit = -1;
            for (let k = cursor; k < st.lines.length; k++) {
              if (tierNorm(st.lines[k]!, t) === tierNorm(ch.anchor, t)) {
                hit = k;
                break;
              }
            }
            if (hit >= 0) {
              foundAt = hit;
              break;
            }
          }
          if (foundAt === null) throw new Fail('no-match', p);
          cursor = foundAt + 1;
        }
        if (ch.O.length > 0) {
          let pick: { tier: number; pos: number } | null = null;
          for (const t of tiers) {
            const pos = occurrences(st.lines, ch.O, t).filter((q) => q >= cursor && (!ch.eof || q + ch.O.length === st.lines.length));
            if (pos.length > 0) {
              pick = { tier: t, pos: pos[0]! };
              break;
            }
          }
          if (pick === null) throw new Fail('no-match', p);
          const matched = st.lines.slice(pick.pos, pick.pos + ch.O.length);
          const repl = applyN(ch.N, matched, ch.O, pick.tier);
          st.lines = [...st.lines.slice(0, pick.pos), ...repl, ...st.lines.slice(pick.pos + ch.O.length)];
          cursor = pick.pos + repl.length;
        } else {
          const pos = ch.eof ? st.lines.length : cursor;
          const repl = ch.N.map((it) => it.text);
          st.lines.splice(pos, 0, ...repl);
          cursor = pos + repl.length;
        }
      }
      const out = renderFile(st);
      if (mt !== null) {
        tree.now.set(p, null);
        tree.now.set(mt, out);
        tree.moves.push({ old: p, nw: mt });
      } else {
        tree.now.set(p, out);
      }
    });
  }
  return edits;
}

/** Sections 1, 2 and 10: the command line, the output and exit codes, order and atomicity. */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Change {
    kind: 'A' | 'D' | 'M';
    path: string;
  }
  const changes: Change[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changes.push({ kind: was === null ? 'A' : now === null ? 'D' : 'M', path: p });
  }
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const used = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const m of tree.moves) {
    const d = byPath.get(m.old);
    const a = byPath.get(m.nw);
    if (d !== undefined && d.kind === 'D' && a !== undefined && a.kind === 'A') {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      used.add(m.old);
      used.add(m.nw);
    }
  }
  for (const c of changes) {
    if (!used.has(c.path)) rows.push({ key: c.path, line: `${c.kind} ${c.path}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const c of changes) {
      const now = tree.now.get(c.path)!;
      if (now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
