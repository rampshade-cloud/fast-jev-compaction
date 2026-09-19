/**
 * Jev の圧縮判定を、過去の実際の会話で答え合わせする。
 *
 * 会話ログは圧縮しても消えないので、ある時点までを Jev に圧縮させ、
 * 「その後に実際に何が起きたか」を正解として採点できる。Jev が捨てた
 * ツール呼び出しが後で読み直されていれば、それは捨ててはいけなかった。
 *
 *   npx tsx tools/score-jev.ts --list
 *   npx tsx tools/score-jev.ts --transcript <path> --thresholds 0.3,0.5,0.7
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { compact } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
import { buildJevRequest, parseJevResponse } from '../src/request.js';
import type { JevAsker, Message, ToolResult, ToolUse } from '../src/types.js';

const RESULT_CAP = 20_000;           // 1 件のツール結果として保持する最大文字数
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

/**
 * ツール呼び出しが触れた資源（ファイルパス）をすべて拾う。
 *
 * Bash のコマンド全文を鍵にすると二度と一致しないので、入力に現れる
 * パスらしき文字列を取り出す。同じファイルに後でまた触れていれば、
 * その呼び出しは「必要だった」と判断できる。
 */
const PATH_RE = /[\w.@~/-]*\/[\w.@-]+\.[A-Za-z][\w]{0,5}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|json|md|py|lua|toml|yml|yaml|sh|sql|css|html|txt)\b/g;

/** パスを比較可能な形にする。作業ディレクトリ違いを吸収するため末尾2要素で見る。 */
function normalizePath(p: string): string {
  const parts = p.replace(/^\.\//, '').split('/').filter(Boolean);
  return parts.slice(-2).join('/').toLowerCase();
}

function resourcesOf(tool: string, input: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const explicit = input['file_path'] ?? input['path'] ?? input['notebook_path'];
  if (typeof explicit === 'string' && explicit) out.add(normalizePath(explicit));
  const blob = JSON.stringify(input ?? {});
  for (const m of blob.match(PATH_RE) ?? []) {
    const n = normalizePath(m);
    if (n.length > 3) out.add(n);
  }
  if (READ_TOOLS.has(tool)) {
    const pattern = input['pattern'];
    if (typeof pattern === 'string' && pattern.length > 3) out.add(`grep:${pattern.toLowerCase()}`);
  }
  return out;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as any).text ?? '') : ''))
    .join('\n');
}

/** Claude Code の transcript JSONL をライブラリのメッセージ模型に変換する。 */
async function loadMessages(path: string, limit: number): Promise<Message[]> {
  const messages: Message[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (messages.length >= limit) break;
    if (!line.startsWith('{')) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const content = d.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    let text = typeof content === 'string' ? content : '';
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') text += (text ? '\n' : '') + String(b.text ?? '');
      else if (b.type === 'tool_use') {
        toolUses.push({ tool_use_id: String(b.id), tool: String(b.name), input: b.input ?? {} });
      } else if (b.type === 'tool_result') {
        toolResults.push({
          tool_use_id: String(b.tool_use_id),
          text: blockText(b.content).slice(0, RESULT_CAP),
          isError: Boolean(b.is_error),
        });
      }
    }
    if (!text && !toolUses.length && !toolResults.length) continue;
    const m: Message = { role: d.type, text, toolUses };
    if (toolResults.length) m.toolResults = toolResults;
    messages.push(m);
  }
  rl.close();
  return messages;
}

/** 「この後」で実際に触れられた資源。これが正解データになる。 */
function futureEvidence(future: readonly Message[]): Set<string> {
  const resources = new Set<string>();
  for (const m of future) {
    for (const r of resourcesOf('', { text: m.text })) resources.add(r);
    for (const t of m.toolUses) {
      for (const r of resourcesOf(t.tool, t.input)) resources.add(r);
    }
  }
  return resources;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gateway の無料枠は Jev にレート制限をかける。実測では約 31 秒で回復するので、
 * リクエストを直列化して一定間隔を空け、それでも 429 なら待って再試行する。
 */
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
            const wait = minIntervalMs + 5000 * attempt;
            process.stderr.write(`    レート制限。${Math.round(wait / 1000)}秒待って再試行 (${attempt + 1}/${retries})\n`);
            await sleep(wait);
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

function listTranscripts(top: number) {
  const root = join(homedir(), '.claude', 'projects');
  const rows: { path: string; size: number; project: string }[] = [];
  for (const dir of readdirSync(root)) {
    const d = join(root, dir);
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(d, f);
      try {
        const size = statSync(p).size;
        // 大きすぎるものは読み込みに時間がかかるので外す
        if (size > 3_000_000 && size < 120_000_000) rows.push({ path: p, size, project: dir });
      } catch { /* ignore */ }
    }
  }
  rows.sort((a, b) => b.size - a.size);
  return rows.slice(0, top);
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };

  if (argv.includes('--list')) {
    for (const r of listTranscripts(12)) {
      console.log(`${(r.size / 1e6).toFixed(1).padStart(7)}MB  ${r.project.slice(-40)}\n            ${r.path}`);
    }
    return;
  }

  if (argv.includes('--scan')) {
    const past = Number(arg('past', '120'));
    const futureN = Number(arg('future', '80'));
    console.log('Jev を呼ばずに、答え合わせに使える会話を探します（重なりが多いほど良い）\n');
    const rows: { n: number; calls: number; path: string }[] = [];
    for (const r of listTranscripts(Number(arg('files', '15')))) {
      try {
        const all = await loadMessages(r.path, past + futureN);
        if (all.length < past / 2) continue;
        const calls = collectToolCalls(all.slice(0, past), 6);
        const evidence = futureEvidence(all.slice(past));
        const n = calls.filter((c) => [...resourcesOf(c.tool, c.input)].some((x) => evidence.has(x))).length;
        rows.push({ n, calls: calls.length, path: r.path });
        console.log(`  必要だったもの ${String(n).padStart(3)} / 呼び出し ${String(calls.length).padStart(3)}  ${r.path.split('/').slice(-2)[0].slice(-34)}`);
      } catch { /* 壊れたログは飛ばす */ }
    }
    rows.sort((a, b) => b.n - a.n);
    console.log('\n採点に向く会話（上から）:');
    for (const r of rows.slice(0, 5)) if (r.n >= 3) console.log(`  ${r.n} 件  ${r.path}`);
    return;
  }

  const apiKey =
    process.env.AI_GATEWAY_API_KEY ??
    readFileSync(join(homedir(), '.config', 'jev-gateway', 'key'), 'utf8').trim();

  const past = Number(arg('past', '120'));
  const futureN = Number(arg('future', '80'));
  const thresholds = (arg('thresholds', '0.3,0.5,0.7') as string).split(',').map(Number);
  // 無料枠のレート制限（実測 31 秒）を避けるための最小間隔
  const interval = Number(arg('interval', '35000'));
  const asker = gatewayAsker(apiKey, interval);
  const paths = arg('transcript')
    ? [arg('transcript') as string]
    : listTranscripts(Number(arg('files', '3'))).map((r) => r.path);

  for (const path of paths) {
    const all = await loadMessages(path, past + futureN);
    if (all.length < past / 2) {
      console.log(`\n${path}\n  メッセージが少なすぎるので飛ばします (${all.length} 件)`);
      continue;
    }
    const head = all.slice(0, past);
    const future = all.slice(past);
    const evidence = futureEvidence(future);
    const calls = collectToolCalls(head, 6);
    const overlap = calls.filter((c) => [...resourcesOf(c.tool, c.input)].some((r) => evidence.has(r))).length;
    const byId = new Map(calls.map((c) => [c.id, c]));

    console.log(`\n${path.split('/').slice(-2).join('/')}`);
    console.log(`  圧縮対象 ${head.length} メッセージ / 答え合わせに使う「その後」 ${future.length} メッセージ`);
    console.log(`  ツール呼び出し ${calls.length} 件（うち固定 ${calls.filter((c) => c.pinned).length} 件）`);
    console.log(`  そのうち「その後にまた触れられた」= 本当に必要だったもの: ${overlap} 件`);
    if (!overlap) console.log('  ※ 重なりが 0 件のため、この会話では誤削除を検出できません');
    if (!calls.length) { console.log('  ツール呼び出しがないので飛ばします'); continue; }

    console.log();
    console.log(`  ${'しきい値'.padEnd(8)}${'削減率'.padStart(8)}${'捨てた'.padStart(8)}${'うち誤削除'.padStart(12)}${'誤削除率'.padStart(10)}${'必要を保護'.padStart(12)}`);
    console.log('  ' + '-'.repeat(58));

    for (const keepThreshold of thresholds) {
      const result = await compact(head, asker, { keepThreshold, preserveRecentMessages: 6 });
      let dropped = 0, falseDrop = 0, neededTotal = 0, neededKept = 0;
      for (const d of result.decisions) {
        if (d.reason === 'pinned') continue;
        const call = byId.get(d.id);
        if (!call) continue;
        // 「後で必要だった」= その呼び出しが触れた資源に、後からまた触れている
        const needed = [...resourcesOf(call.tool, call.input)].some((r) => evidence.has(r));
        const isDropped = d.action !== 'keep';
        if (isDropped) dropped++;
        if (needed) neededTotal++;
        if (needed && isDropped) falseDrop++;
        if (needed && !isDropped) neededKept++;
      }
      const red = (100 * (1 - result.stats.charsAfter / result.stats.charsBefore)).toFixed(0);
      const falseRate = dropped ? `${((100 * falseDrop) / dropped).toFixed(0)}%` : '-';
      const protect = neededTotal ? `${((100 * neededKept) / neededTotal).toFixed(0)}%` : '-';
      console.log(
        `  ${String(keepThreshold).padEnd(8)}${(red + '%').padStart(8)}${String(dropped).padStart(8)}` +
        `${String(falseDrop).padStart(12)}${falseRate.padStart(10)}${protect.padStart(12)}`,
      );
    }
  }

  console.log(`
  誤削除   = Jev が捨てたが、その後で実際に読み直されたツール呼び出し（少ないほど良い）
  必要を保護 = その後で必要になったもののうち、Jev が残せた割合（高いほど良い）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
