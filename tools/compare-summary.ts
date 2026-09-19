/**
 * Jev の剪定と、Claude Code の内蔵要約を、同じデータで比べる。
 *
 * 会話ログには実際の圧縮が残っている。境界の直前までが「圧縮対象」、
 * 境界直後の isCompactSummary が「内蔵要約が実際に出した答え」、その後ろが
 * 「実際に起きたこと」。同じ圧縮対象を Jev にも処理させ、後で必要になった
 * ファイルが圧縮後の文脈に残っているかを、両者について同じ基準で数える。
 *
 *   npx tsx tools/compare-summary.ts --files 6
 */
import { readFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { compact } from '../src/compact.js';
import { buildJevRequest, parseJevResponse } from '../src/request.js';
import type { JevAsker, Message, ToolResult, ToolUse } from '../src/types.js';

const RESULT_CAP = 20_000;
const PATH_RE = /[\w.@~/-]*\/[\w.@-]+\.[A-Za-z][\w]{0,5}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|json|md|py|lua|toml|yml|yaml|sh|sql|css|html|txt)\b/g;

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').split('/').filter(Boolean).slice(-2).join('/').toLowerCase();
}

/** 文字列に現れるファイルパスを、比較可能な形で集める。 */
function pathsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.match(PATH_RE) ?? []) {
    const n = normalizePath(m);
    if (n.length > 3) out.add(n);
  }
  return out;
}

/** メッセージ群が「保持している」パス。本文とツール入力の両方を見る。 */
function pathsOf(messages: readonly Message[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    for (const p of pathsIn(m.text)) out.add(p);
    for (const t of m.toolUses) for (const p of pathsIn(JSON.stringify(t.input ?? {}))) out.add(p);
    for (const r of m.toolResults ?? []) for (const p of pathsIn(r.text)) out.add(p);
  }
  return out;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as any).text ?? '') : '')).join('\n');
}

type Split = { head: Message[]; summary: string; future: Message[] };

/**
 * 原文性の指標。パスが「現れる」だけでなく、それを含む元の一行が
 * そのまま残っているかを見る。要約は言い換えるので落ちやすく、
 * Jev は本文を触らないので残りやすい。ここが品質の本質。
 */
function verbatimLines(messages: readonly Message[], needed: readonly string[]): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const p of needed) byPath.set(p, []);
  for (const m of messages) {
    const chunks = [m.text, ...m.toolUses.map((t) => JSON.stringify(t.input ?? {})), ...(m.toolResults ?? []).map((r) => r.text)];
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (line.length < 8 || line.length > 400) continue;
        const paths = pathsIn(line);
        for (const p of needed) if (paths.has(p)) byPath.get(p)!.push(line.trim());
      }
    }
  }
  return byPath;
}

/** 圧縮前に存在した「そのパスを含む具体的な一行」が、圧縮後にも一字一句残っているか。 */
function verbatimKept(
  before: Map<string, string[]>,
  afterText: string,
  needed: readonly string[],
): number {
  let kept = 0;
  for (const p of needed) {
    const lines = before.get(p) ?? [];
    if (lines.some((l) => afterText.includes(l))) kept++;
  }
  return kept;
}

/** メッセージ群を 1 つの文字列にする（原文照合用）。 */
function flatten(messages: readonly Message[]): string {
  return messages
    .map((m) => [m.text, ...m.toolUses.map((t) => JSON.stringify(t.input ?? {})), ...(m.toolResults ?? []).map((r) => r.text)].join('\n'))
    .join('\n');
}

/**
 * 1 本の会話に含まれる圧縮をすべて切り出す。長い会話には圧縮が何度も
 * 起きているので、1 ファイルから複数の標本が取れる。
 *
 * 注: 2 回目以降の「圧縮対象」は、実際には前回の要約＋その後の発言だが、
 * ここでは元の発言をそのまま遡って使う（近似）。
 */
async function splitsAtBoundaries(
  path: string,
  past: number,
  futureN: number,
  maxSplits: number,
): Promise<Split[]> {
  const buffer: Message[] = [];
  const done: Split[] = [];
  let pending: Split | null = null;
  let awaitingSummary = false;

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith('{')) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }

    if (d.subtype === 'compact_boundary') {
      if (!pending && buffer.length >= 20) awaitingSummary = true;
      continue;
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const content = d.message?.content;
    const blocks = Array.isArray(content) ? content : [];

    if (awaitingSummary) {
      awaitingSummary = false;
      if (d.isCompactSummary) {
        const summary = typeof content === 'string' ? content : blockText(content);
        if (summary) { pending = { head: [...buffer], summary, future: [] }; continue; }
      }
      // 要約が無い圧縮（Jev が処理したものなど）は比較に使えない
    }

    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    let text = typeof content === 'string' ? content : '';
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') text += (text ? '\n' : '') + String(b.text ?? '');
      else if (b.type === 'tool_use') toolUses.push({ tool_use_id: String(b.id), tool: String(b.name), input: b.input ?? {} });
      else if (b.type === 'tool_result') toolResults.push({ tool_use_id: String(b.tool_use_id), text: blockText(b.content).slice(0, RESULT_CAP), isError: Boolean(b.is_error) });
    }
    if (!text && !toolUses.length && !toolResults.length) continue;
    const m: Message = { role: d.type, text, toolUses };
    if (toolResults.length) m.toolResults = toolResults;

    if (pending) {
      pending.future.push(m);
      if (pending.future.length >= futureN) {
        done.push(pending);
        pending = null;
        if (done.length >= maxSplits) break;
      }
    }
    buffer.push(m);
    if (buffer.length > past) buffer.shift();
  }
  rl.close();
  if (pending && pending.future.length >= 10) done.push(pending);
  return done;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gatewayAsker(apiKey: string, minIntervalMs: number, retries = 8): JevAsker {
  let gate: Promise<unknown> = Promise.resolve();
  let last = 0;
  return {
    ask(state, questions) {
      const run = async () => {
        const since = Date.now() - last;
        if (last && since < minIntervalMs) await sleep(minIntervalMs - since);
        const req = buildJevRequest({ apiKey, provider: 'gateway' }, state, questions);
        for (let attempt = 0; ; attempt++) {
          last = Date.now();
          const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
          const text = await res.text();
          if (res.status === 429 && attempt < retries) {
            process.stderr.write(`    待機 ${Math.round((minIntervalMs + 5000 * attempt) / 1000)}秒\n`);
            await sleep(minIntervalMs + 5000 * attempt);
            continue;
          }
          return parseJevResponse(res.status, res.ok, text);
        }
      };
      const next = gate.then(run, run);
      gate = next.catch(() => undefined);
      return next;
    },
  };
}

function transcripts(top: number) {
  const root = join(homedir(), '.claude', 'projects');
  const rows: { path: string; size: number }[] = [];
  for (const dir of readdirSync(root)) {
    let entries: string[] = [];
    try { entries = readdirSync(join(root, dir)); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(root, dir, f);
      try {
        const size = statSync(p).size;
        if (size > 1_000_000 && size < 170_000_000) rows.push({ path: p, size });
      } catch { /* ignore */ }
    }
  }
  return rows.sort((a, b) => b.size - a.size).slice(0, top);
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const apiKey = process.env.AI_GATEWAY_API_KEY ?? readFileSync(join(homedir(), '.config', 'jev-gateway', 'key'), 'utf8').trim();
  const past = Number(arg('past', '150'));
  const futureN = Number(arg('future', '60'));
  const asker = gatewayAsker(apiKey, Number(arg('interval', '35000')));
  const paths = arg('transcript') ? [arg('transcript') as string] : transcripts(Number(arg('files', '6'))).map((r) => r.path);

  const totals = { needed: 0, sumHit: 0, jevHit: 0, sumVerb: 0, jevVerb: 0, sumChars: 0, jevChars: 0, n: 0 };
  console.log('同じ圧縮対象に対し、内蔵要約と Jev のどちらが「後で必要になったファイル」を残せたかを比べます\n');
  console.log(`${'会話'.padEnd(10)}${'必要'.padStart(5)}${'要約:言及'.padStart(11)}${'Jev:言及'.padStart(11)}${'要約:原文'.padStart(11)}${'Jev:原文'.padStart(11)}${'要約 字数'.padStart(11)}${'Jev 字数'.padStart(11)}`);
  console.log('-'.repeat(81));

  const want = Number(arg('want', '99'));
  const skip = (arg('skip', '') as string).split(',').filter(Boolean);

  outer: for (const path of paths) {
    const name = path.split('/').pop()!.slice(0, 8);
    if (skip.includes(name)) continue;
    let splits: Split[] = [];
    try { splits = await splitsAtBoundaries(path, past, futureN, Number(arg('per-file', '3'))); } catch { /* ignore */ }
    for (const split of splits) {
    if (totals.n >= want) break outer;
    const { head, summary, future } = split;

    // 正解: 圧縮対象に現れ、かつ圧縮後にも触れられたファイル
    const inHead = pathsOf(head);
    const needed = [...pathsOf(future)].filter((p) => inHead.has(p));
    if (needed.length < 3) continue;

    const summaryPaths = pathsIn(summary);
    const sumHit = needed.filter((p) => summaryPaths.has(p)).length;
    // 圧縮前に、そのパスを含んでいた具体的な行
    const originals = verbatimLines(head, needed);
    const sumVerb = verbatimKept(originals, summary, needed);

    let jevHit = 0, jevVerb = 0, jevChars = 0;
    try {
      const result = await compact(head, asker, { keepThreshold: 0.5, preserveRecentMessages: 6 });
      const kept = pathsOf(result.messages);
      jevHit = needed.filter((p) => kept.has(p)).length;
      jevVerb = verbatimKept(originals, flatten(result.messages), needed);
      jevChars = result.stats.charsAfter;
    } catch (e) {
      console.log(`  ${name} … Jev 失敗: ${(e as Error).message.slice(0, 60)}`);
      continue;
    }

    totals.needed += needed.length; totals.sumHit += sumHit; totals.jevHit += jevHit;
    totals.sumVerb += sumVerb; totals.jevVerb += jevVerb;
    totals.sumChars += summary.length; totals.jevChars += jevChars; totals.n++;
    const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');
    console.log(
      `${(name + '#' + (totals.n)).padEnd(10)}${String(needed.length).padStart(5)}` +
      `${pct(sumHit, needed.length).padStart(11)}${pct(jevHit, needed.length).padStart(11)}` +
      `${pct(sumVerb, needed.length).padStart(11)}${pct(jevVerb, needed.length).padStart(11)}` +
      `${summary.length.toLocaleString().padStart(11)}${jevChars.toLocaleString().padStart(11)}`,
    );
    }
  }

  if (!totals.n) { console.log('\n比較できる圧縮が見つかりませんでした。'); return; }
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  console.log('-'.repeat(81));
  console.log(
    `${'合計'.padEnd(10)}${String(totals.needed).padStart(5)}` +
    `${pct(totals.sumHit, totals.needed).padStart(11)}${pct(totals.jevHit, totals.needed).padStart(11)}` +
    `${pct(totals.sumVerb, totals.needed).padStart(11)}${pct(totals.jevVerb, totals.needed).padStart(11)}` +
    `${totals.sumChars.toLocaleString().padStart(11)}${totals.jevChars.toLocaleString().padStart(11)}`,
  );
  console.log(`
  必要 = 圧縮前にあり、圧縮後にも実際に触れられたファイル（これが正解データ）
  言及 = 圧縮後の文脈に、そのファイル名がまだ出てくる割合
  原文 = そのファイルに触れていた具体的な一行が、一字一句そのまま残っている割合
         （要約は言い換えるので落ちる。ここが「残った内容の品質」の核心）
  字数 = 圧縮後に残った文脈の大きさ
  比較対象 ${totals.n} 件の実際の圧縮`);
}

main().catch((e) => { console.error(e); process.exit(1); });
