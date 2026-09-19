#!/usr/bin/env python3
"""Claude Code の圧縮を実測する。

各圧縮は transcript の compact_boundary に記録されている（前後トークン数と所要時間）。
そこから「誰が圧縮したか（Jev かどうか）」「どれだけ減ったか」「圧縮後に読み直しが
起きたか」を集計する。設定を変えた前後で走らせて数字を比べるために使う。

  python3 compaction-stats.py              # 全期間
  python3 compaction-stats.py --since 2026-09-19
  python3 compaction-stats.py --since 2026-09-19 --detail
"""
import argparse, collections, glob, json, os, statistics, sys

# Jev は 1 秒前後、内蔵の要約は 90 秒以上かかる。その差で判別する。
JEV_MAX_MS = 15_000
# 圧縮の何ターン後までを「読み直し」とみなすか。
REREAD_WINDOW = 12
READ_TOOLS = {"Read", "Grep", "Glob", "NotebookRead"}


def target_of(block):
    """ツール呼び出しが触れた対象を 1 つの文字列にする。読み直し判定の鍵。"""
    if block.get("type") != "tool_use":
        return None
    name, inp = block.get("name"), block.get("input") or {}
    if not isinstance(inp, dict):
        return None
    if name in READ_TOOLS:
        p = inp.get("file_path") or inp.get("path") or inp.get("pattern")
        return f"{name}:{p}" if p else None
    if name == "Bash":
        cmd = (inp.get("command") or "").strip()
        return f"Bash:{cmd[:120]}" if cmd else None
    return None


def scan(path):
    """1 つの transcript から圧縮イベントと、その前後のツール対象を拾う。"""
    events, targets, skipped = [], [], []   # targets: (順序, 対象)
    order = 0
    for line in open(path, errors="ignore"):
        if '"compact_boundary"' not in line and '"tool_use"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("subtype") == "compact_boundary":
            m = d.get("compactMetadata") or {}
            # 古い transcript は postTokens/durationMs を持たない。所要時間で
            # Jev と内蔵を見分けるので、欠けている記録は測定対象から外す。
            if m.get("preTokens") and m.get("postTokens") and m.get("durationMs"):
                events.append({
                    "order": order, "ts": d.get("timestamp", ""),
                    "trigger": m.get("trigger"), "pre": m["preTokens"],
                    "post": m["postTokens"], "ms": m["durationMs"],
                })
            elif m.get("preTokens"):
                skipped.append(d.get("timestamp", ""))
            continue
        content = ((d.get("message") or {}).get("content")) or []
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict):
                t = target_of(b)
                if t:
                    order += 1
                    targets.append((order, t))
    # 各圧縮について、直前に触れていた対象が直後に再び現れたかを数える
    for e in events:
        before = {t for o, t in targets if o <= e["order"]}
        after = [t for o, t in targets if e["order"] < o <= e["order"] + REREAD_WINDOW]
        e["after_n"] = len(after)
        e["reread_n"] = sum(1 for t in after if t in before)
    return events, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="この日付以降のみ (YYYY-MM-DD)")
    ap.add_argument("--detail", action="store_true", help="1 件ずつ表示")
    ap.add_argument("--root", default="~/.claude/projects")
    a = ap.parse_args()

    events, skipped = [], []
    for f in glob.glob(os.path.expanduser(f"{a.root}/*/*.jsonl")):
        try:
            e, s_ = scan(f)
            events += e
            skipped += s_
        except Exception:
            pass
    if a.since:
        events = [e for e in events if e["ts"][:10] >= a.since]
    if not events:
        print("該当する圧縮記録がありません。")
        return 1
    events.sort(key=lambda e: e["ts"])

    groups = collections.defaultdict(list)
    for e in events:
        groups["Jev" if e["ms"] <= JEV_MAX_MS else "内蔵の要約"].append(e)

    print(f"対象: {len(events)} 件の圧縮" + (f"（{a.since} 以降）" if a.since else "（全期間）"))
    if skipped:
        print(f"（所要時間が記録されていない古い形式 {len(skipped)} 件は除外）")
    print()
    head = f"{'圧縮した主体':<12}{'件数':>5}{'中央値 所要':>12}{'削減率 中央値':>14}{'圧縮前 中央値':>14}{'読み直し率':>12}"
    print(head)
    print("-" * len(head))
    for name in ("Jev", "内蔵の要約"):
        g = groups.get(name)
        if not g:
            continue
        red = [100 * (1 - e["post"] / e["pre"]) for e in g if e["pre"]]
        after = sum(e["after_n"] for e in g)
        reread = sum(e["reread_n"] for e in g)
        rate = f"{100 * reread / after:.0f}%" if after else "-"
        print(f"{name:<12}{len(g):>5}"
              f"{statistics.median(e['ms'] for e in g) / 1000:>10.1f}秒"
              f"{statistics.median(red):>13.0f}%"
              f"{statistics.median(e['pre'] for e in g):>13,.0f}"
              f"{rate:>12}")
    print()
    print(f"読み直し率 = 圧縮直後の {REREAD_WINDOW} 回のツール呼び出しのうち、"
          "圧縮前にも触れていた対象の割合。高いほど必要なものを捨てている。")

    if a.detail:
        print()
        for e in events:
            who = "Jev  " if e["ms"] <= JEV_MAX_MS else "内蔵 "
            red = 100 * (1 - e["post"] / e["pre"])
            print(f"  {e['ts'][:16]}  {who} {e['trigger']:<6} "
                  f"{e['pre']:>7,} -> {e['post']:>6,} ({red:>3.0f}%) "
                  f"{e['ms']/1000:>6.1f}秒  読み直し {e['reread_n']}/{e['after_n']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
