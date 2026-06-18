#!/usr/bin/env python3
"""
extract-session-metrics.py -- deterministic per-session metrics for agent usage analysis.

WHAT IT MEASURES (all OBSERVED, no estimation, no agent):
  - session selection: transcripts with >= MIN_USERS real human prompts in the time window
  - human vs tool-result classification: STRUCTURAL marker, not a gap heuristic
      tool-result user record  := has 'toolUseResult' key OR content list contains a 'tool_result'
      real human prompt        := a 'user' record that is NOT a tool-result
  - agent wall-clock per turn := (human prompt ts) -> (last assistant ts before next human prompt)
      sum over turns = total agent busy-time for the session.
      NOTE: this is MACHINE EFFORT (inference + tool round-trips + waiting on builds/sub-agents).
      It is NOT "time saved" and NOT human-equivalent time. Different axis. Do not conflate.
  - tokens: summed from each assistant record's message.usage (input/output/cache_read/cache_creation).
    Derived: input_used = input + cache_creation (input-side tokens newly processed this run); output
    and cache_read are reported as their own buckets (output is a separate API billing line).
  - KB interaction: Read/Grep/Glob and Write/Edit tool_use calls whose input matches KB_PAT

CAVEATS (carried in METHODOLOGY.md too):
  - wall-clock counts build/sub-agent waiting as agent time (correct: the task took that long,
    but it is "spent" not necessarily "well-spent").
  - timestamps are the logging host clock; consistent within a session, so deltas are sound.
  - the final turn of a session is bounded by the last assistant message (no next human prompt).

USAGE:
  python3 extract-session-metrics.py --single PATH        # print one session's metrics
  python3 extract-session-metrics.py --scan ~/.claude/projects \
      --start 2026-05-21 --end 2026-06-03 --min-users 5 --out runs/
  python3 extract-session-metrics.py --manifest sessions.json --out runs/

  --scan selects transcripts whose mtime falls in the inclusive LOCAL-time [start, end] date
  window (YYYY-MM-DD). The date range governs selection entirely -- there is no relative --days
  and no --exclude-today (a past window excludes today by construction; today's window includes it).
  --out is the runs PARENT dir: a non-clobbering per-run subdir <start>_<end>[_N] is auto-created
  holding metrics.json, temporal.json, run-meta.json, run-meta.md.
  --manifest expects a JSON list of {"path","proj","users",...}; --scan builds the list itself.

  --home-prefix is the encoded home-directory fragment stripped from the project-name label that
  Claude Code derives from each transcript's parent directory. Claude Code encodes the session's
  working directory into that directory name with slashes turned into dashes, so an absolute home
  like /home/alice becomes the fragment "-home-alice-". The default is derived from $HOME, so you
  normally never set it; override it only when scanning transcripts logged under a different home
  than the one running this script.

  All timestamps in temporal analysis are converted to the SYSTEM LOCAL timezone (resolved at
  runtime via astimezone(); the zone name is stamped into run-meta).
"""
import json, sys, os, glob, argparse, re
from datetime import datetime, timezone

# KB_ROOT: where knowledge-base projects live. A path is KB usage ONLY if under this root.
# Out-of-root paths (MEMORY/ISA, USER, source repos, /tmp) are NOT KB metrics. Configurable.
KB_ROOT_DEFAULT = os.path.expanduser('~/ClaudeDesktop')

# Sentinel: a session containing this string is an OBSERVER (running this analysis) and is excluded.
ANALYSIS_SENTINEL = 'AGENT-SESSION-ANALYSIS-RUN::observer'

# Artifact-class ruleset: case-insensitive, applied ONLY to in-KB_ROOT paths, FIRST MATCH WINS.
# (class, value_lean, list of case-insensitive substrings to match in the path-relative-to-root)
# ORDER MATTERS: backlog + decisions come BEFORE plan/spec/tracker so 04-backlog.md is not swept
# into the high tier and 03-decisions.md lands in decisions. Top-level KB files (00-project-brief,
# 02-status) classify as plan/spec/tracker via project-brief/-brief/-status (high, continuity).
KB_CLASS_RULES = [
    ('backlog',           'medium',   ['backlog']),
    ('decisions',         'high',     ['decision']),
    ('plan/spec/tracker', 'high',     ['plans/', 'spec', 'tracker', 'tracking', 'roadmap', 'project-brief', '-brief', '-status']),
    ('reference',         'med-high', ['reference/', '-ref']),
    ('scratch/ephemeral', 'low',      ['scratch/', 'journal/', 'handoff', 'reviews/']),
    ('output',            'low-med',  ['output/']),
    ('index/nav',         'low-enabling', ['document-map']),
]

def default_home_prefix():
    """The encoded home fragment Claude Code embeds in a project dir name, derived from $HOME.
    /home/alice -> '-home-alice-' (slashes -> dashes, with leading+trailing dash)."""
    return os.path.expanduser('~').replace('/', '-') + '-'

def kb_path_in_input(inp_str, kb_root):
    """Extract the first KB_ROOT-relative path mentioned in a tool_use input blob, or None."""
    # tool inputs reference paths as strings; find one under kb_root (handle ~ and absolute)
    root = kb_root.rstrip('/')
    home = os.path.expanduser('~')
    for cand in (root, root.replace(home, '~'), root.replace(home, '$HOME')):
        idx = inp_str.find(cand + '/')
        if idx != -1:
            return inp_str[idx:].split('"')[0].split("'")[0].split()[0]
    return None

def classify_kb_path(path, kb_root):
    """Return (class, value_lean) for an in-root path; 'other' if no rule matches."""
    root = kb_root.rstrip('/')
    home = os.path.expanduser('~')
    rel = path
    for pre in (root, root.replace(home, '~'), root.replace(home, '$HOME')):
        if rel.startswith(pre):
            rel = rel[len(pre):]
            break
    rl = rel.lower()
    for cls, lean, subs in KB_CLASS_RULES:
        if any(s in rl for s in subs):
            return cls, lean
    return 'other', 'unclassified'

def parse_ts(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except Exception:
        return None

def is_tool_result(d):
    if 'toolUseResult' in d:
        return True
    msg = d.get('message', {})
    c = msg.get('content') if isinstance(msg, dict) else None
    if isinstance(c, list):
        return any(isinstance(p, dict) and p.get('type') == 'tool_result' for p in c)
    return False

def is_human_prompt(d):
    if d.get('type') != 'user':
        return False
    return not is_tool_result(d)

def askuserquestion_tooluse_ids(d):
    """Return tool_use ids in this assistant record that are AskUserQuestion calls."""
    ids = []
    msg = d.get('message') if isinstance(d.get('message'), dict) else d
    c = msg.get('content') if isinstance(msg, dict) else None
    if isinstance(c, list):
        for p in c:
            if isinstance(p, dict) and p.get('type') == 'tool_use' and p.get('name') == 'AskUserQuestion':
                ids.append(p.get('id'))
    return ids

def tool_result_for_id(d, target_id):
    """True if this user record is the tool_result answering target_id."""
    msg = d.get('message') if isinstance(d.get('message'), dict) else d
    c = msg.get('content') if isinstance(msg, dict) else None
    if isinstance(c, list):
        for p in c:
            if isinstance(p, dict) and p.get('type') == 'tool_result' and p.get('tool_use_id') == target_id:
                return True
    return False

def session_metrics(path, kb_root=KB_ROOT_DEFAULT, build_timeline=False):
    recs = []
    for line in open(path, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            recs.append(json.loads(line))
        except Exception:
            continue

    # token totals + KB tool calls (KB = under kb_root ONLY) + optional per-output timeline
    inp = out = cr = cc = 0
    kb_reads = 0; kb_writes = 0
    kb_class_counts = {}          # class -> {'reads':n,'writes':n}
    timeline = []
    READ_TOOLS = ('Read', 'Grep', 'Glob')
    WRITE_TOOLS = ('Write', 'Edit', 'NotebookEdit')
    for d in recs:
        msg = d.get('message') if isinstance(d.get('message'), dict) else d
        u = msg.get('usage') if isinstance(msg, dict) else None
        if isinstance(u, dict):
            inp += u.get('input_tokens', 0); out += u.get('output_tokens', 0)
            cr += u.get('cache_read_input_tokens', 0); cc += u.get('cache_creation_input_tokens', 0)
        content = msg.get('content') if isinstance(msg, dict) else None
        if isinstance(content, list):
            for p in content:
                if not isinstance(p, dict):
                    continue
                if p.get('type') == 'tool_use':
                    name = p.get('name', '')
                    inp_str = json.dumps(p.get('input', {}))
                    kb_path = kb_path_in_input(inp_str, kb_root)
                    is_kb = kb_path is not None
                    cls = None
                    if is_kb:
                        cls, _lean = classify_kb_path(kb_path, kb_root)
                        kb_class_counts.setdefault(cls, {'reads': 0, 'writes': 0})
                        if name in READ_TOOLS:
                            kb_reads += 1; kb_class_counts[cls]['reads'] += 1
                        elif name in WRITE_TOOLS:
                            kb_writes += 1; kb_class_counts[cls]['writes'] += 1
                    if build_timeline:
                        timeline.append({
                            'ts': d.get('timestamp'), 'type': 'tool_use', 'tool': name,
                            'kb_artifact': kb_path if is_kb else None, 'kb_class': cls,
                        })
                elif build_timeline and p.get('type') in ('text', 'thinking'):
                    timeline.append({'ts': d.get('timestamp'), 'type': p.get('type'),
                                     'tool': None, 'kb_artifact': None, 'kb_class': None})
    # compute per-output deltas if timeline built
    if build_timeline:
        prev = None
        for row in timeline:
            t = parse_ts(row['ts']) if row['ts'] else None
            row['delta_sec'] = round((t - prev).total_seconds(), 2) if (t and prev) else None
            if t:
                prev = t

    # wall-clock per human turn.
    # Gap A = human prompt -> last assistant before next human prompt.
    # AskUserQuestion correction: subtract (T_answer - T_ask) for each modal within the turn --
    # that span is human decide-time, not agent work (the agent resumes IN-turn after a modal
    # answer, so the decide-time would otherwise be buried inside Gap A). EXACT two-timestamp cut.
    # Applies ONLY to AskUserQuestion; ordinary tool_result gaps ARE agent work.
    seq = [d for d in recs if d.get('type') in ('user', 'assistant') and d.get('timestamp')]
    human_idx = [i for i, d in enumerate(seq) if is_human_prompt(d)]
    turns = []
    aq_excluded_total = 0.0
    for k, hi in enumerate(human_idx):
        start = parse_ts(seq[hi]['timestamp'])
        if start is None:
            continue
        end_i = human_idx[k + 1] if k + 1 < len(human_idx) else len(seq)
        last_assist = None
        for j in range(hi + 1, end_i):
            if seq[j].get('type') == 'assistant':
                last_assist = seq[j]
        if not last_assist:
            continue
        e = parse_ts(last_assist['timestamp'])
        if not e:
            continue
        dur = (e - start).total_seconds()
        if dur < 0:
            continue
        # subtract AskUserQuestion decide-time(s) within this turn
        aq_decide = 0.0
        for j in range(hi + 1, end_i):
            for tid in askuserquestion_tooluse_ids(seq[j]):
                t_ask = parse_ts(seq[j]['timestamp'])
                # find the matching tool_result after j
                for m in range(j + 1, end_i):
                    if tool_result_for_id(seq[m], tid):
                        t_ans = parse_ts(seq[m]['timestamp'])
                        if t_ask and t_ans:
                            gap = (t_ans - t_ask).total_seconds()
                            if gap > 0:
                                aq_decide += gap
                        break
        dur_corrected = max(dur - aq_decide, 0.0)
        aq_excluded_total += aq_decide
        turns.append(dur_corrected)
    turns_sorted = sorted(turns)
    n = len(turns_sorted)
    def pct(p):
        return turns_sorted[min(int(n * p), n - 1)] if n else 0.0

    # Temporal: human-prompt timestamps (when the user was actually at the keyboard) converted to
    # LOCAL time, plus the session start->end span. Histograms/overlap are computed at run level;
    # here we emit the raw local-time prompt timestamps and the span so the run layer can aggregate.
    human_prompt_ts_local = []
    for hi in human_idx:
        t = parse_ts(seq[hi]['timestamp'])
        if t is not None:
            human_prompt_ts_local.append(t.astimezone().isoformat())
    all_ts = [parse_ts(d['timestamp']) for d in seq]
    all_ts = [t for t in all_ts if t is not None]
    session_start_local = min(all_ts).astimezone().isoformat() if all_ts else None
    session_end_local = max(all_ts).astimezone().isoformat() if all_ts else None

    result = {
        "human_turns": n,
        "agent_walltime_sec": round(sum(turns), 1),
        "askuserquestion_excluded_sec": round(aq_excluded_total, 1),
        "turn_median_sec": round(pct(0.5), 1),
        "turn_p90_sec": round(pct(0.9), 1),
        "turn_max_sec": round(max(turns), 1) if turns else 0.0,
        # input_used = uncached input + cache writes (all input-side, newly processed this run).
        # output is its own bucket (separate API billing line). cache_read = input served from cache.
        "tokens": {"input": inp, "output": out, "cache_read": cr, "cache_creation": cc,
                   "input_used": inp + cc},
        "kb_read_count": kb_reads,
        "kb_write_count": kb_writes,
        "kb_class_counts": kb_class_counts,
        "session_start_local": session_start_local,
        "session_end_local": session_end_local,
        "human_prompt_ts_local": human_prompt_ts_local,
    }
    if build_timeline:
        result["timeline"] = timeline
    return result

def has_sentinel(path):
    """True if the transcript contains the analysis sentinel (an OBSERVER session)."""
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if ANALYSIS_SENTINEL in line:
                    return True
    except Exception:
        pass
    return False

def first_human_prompt(path):
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if is_human_prompt(d):
            msg = d.get('message', {})
            c = msg.get('content') if isinstance(msg, dict) else None
            if isinstance(c, str):
                return c.strip().replace('\n', ' ')[:80]
            if isinstance(c, list):
                for p in c:
                    if isinstance(p, dict) and p.get('type') == 'text':
                        return (p.get('text', '') or '').strip().replace('\n', ' ')[:80]
    return ''

def count_human(path):
    return sum(1 for line in open(path, encoding='utf-8', errors='replace')
               if line.strip() and _safe_is_human(line))

def _safe_is_human(line):
    try:
        return is_human_prompt(json.loads(line))
    except Exception:
        return False

def _local_day_bounds(start_date, end_date):
    """Return (start_epoch, end_epoch) for an inclusive [start 00:00, end 23:59:59.999] window
    interpreted in the SYSTEM LOCAL timezone. Dates are 'YYYY-MM-DD'."""
    s = datetime.strptime(start_date, '%Y-%m-%d').astimezone().replace(
        hour=0, minute=0, second=0, microsecond=0)
    e = datetime.strptime(end_date, '%Y-%m-%d').astimezone().replace(
        hour=23, minute=59, second=59, microsecond=999999)
    return s.timestamp(), e.timestamp()

def scan(root, start_date, end_date, min_users, home_prefix, exclude_sentinel=True):
    """Select transcripts whose mtime falls within the inclusive local-time [start, end] date
    window. The date range governs everything: no relative --days, no separate --exclude-today
    (a historical window naturally excludes today; today's range naturally includes it)."""
    start_epoch, end_epoch = _local_day_bounds(start_date, end_date)
    rows = []
    skipped = {'subagents': 0, 'out_of_window': 0, 'sentinel': 0, 'below_min': 0}
    for f in glob.glob(os.path.join(root, '*', '*.jsonl')):
        if '/subagents/' in f:
            skipped['subagents'] += 1; continue
        mt = os.path.getmtime(f)
        if mt < start_epoch or mt > end_epoch:
            skipped['out_of_window'] += 1; continue
        if exclude_sentinel and has_sentinel(f):
            skipped['sentinel'] += 1; continue
        hu = count_human(f)
        if hu < min_users:
            skipped['below_min'] += 1; continue
        proj = os.path.basename(os.path.dirname(f))
        # Strip the encoded home fragment Claude Code prepends to the working-dir-derived name
        # (e.g. '-home-alice-') so the project label reads as just the project path tail.
        proj = proj.replace(home_prefix, '').replace(home_prefix.rstrip('-'), '')
        rows.append({"path": f, "proj": proj, "users": hu,
                     "sizeKB": round(os.path.getsize(f) / 1024), "first": first_human_prompt(f)})
    rows.sort(key=lambda r: -r['users'])
    return rows, skipped

def temporal_analysis(results):
    """Deterministic temporal dimension keyed on human-prompt timestamps (LOCAL time = when the user
    was actually at the keyboard). Returns full per-bucket data; the run layer also derives summary
    stats from it. Overlap is computed from session start->end spans (concurrent sessions)."""
    dow_names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    dow = {d: 0 for d in dow_names}
    hour = {h: 0 for h in range(24)}
    total_prompts = 0
    for r in results:
        for iso in r.get('human_prompt_ts_local', []):
            t = parse_ts(iso)
            if t is None:
                continue
            dow[dow_names[t.weekday()]] += 1
            hour[t.hour] += 1
            total_prompts += 1

    # Overlap: sessions whose [start,end] local spans intersect another session's span.
    spans = []
    for r in results:
        s, e = r.get('session_start_local'), r.get('session_end_local')
        ts, te = parse_ts(s) if s else None, parse_ts(e) if e else None
        if ts and te:
            spans.append((ts, te, r['path']))
    spans.sort(key=lambda x: x[0])
    overlap_pairs = []
    for i in range(len(spans)):
        for j in range(i + 1, len(spans)):
            if spans[j][0] > spans[i][1]:
                break  # sorted by start; no later session can overlap this one's end
            overlap_pairs.append([spans[i][2], spans[j][2]])
    sessions_in_overlap = sorted({p for pair in overlap_pairs for p in pair})

    return {
        "tz": datetime.now().astimezone().tzname(),
        "total_human_prompts": total_prompts,
        "by_day_of_week": dow,
        "by_hour_of_day": {str(h): hour[h] for h in range(24)},
        "overlap": {
            "pair_count": len(overlap_pairs),
            "sessions_involved": len(sessions_in_overlap),
            "pairs": overlap_pairs,
        },
    }

def temporal_summary(temporal):
    """Glanceable stats for the metadata/report (the full buckets stay in temporal.json)."""
    dow = temporal['by_day_of_week']
    hour = {int(k): v for k, v in temporal['by_hour_of_day'].items()}
    busiest_day = max(dow, key=dow.get) if any(dow.values()) else None
    busiest_hour = max(hour, key=hour.get) if any(hour.values()) else None
    return {
        "tz": temporal['tz'],
        "busiest_day": busiest_day,
        "busiest_hour_local": busiest_hour,
        "overlapping_sessions": temporal['overlap']['sessions_involved'],
    }

def make_run_dir(out_parent, start_date, end_date):
    """Create runs/<start>_<end>/ ; on collision append _1, _2, ... Never clobbers an existing run."""
    base = f"{start_date}_{end_date}"
    os.makedirs(out_parent, exist_ok=True)
    cand = os.path.join(out_parent, base)
    if not os.path.exists(cand):
        os.makedirs(cand); return cand
    i = 1
    while os.path.exists(os.path.join(out_parent, f"{base}_{i}")):
        i += 1
    final = os.path.join(out_parent, f"{base}_{i}")
    os.makedirs(final); return final

def render_run_meta_md(meta):
    """Render the mechanical run-meta as a human-glanceable markdown summary."""
    a = meta['totals']; w = meta['window']; ts = meta['temporal_summary']
    lines = [
        f"# Run metadata -- {w['start']} to {w['end']}", "",
        f"- **Script version:** {meta['script_version']}",
        f"- **Run generated:** {meta['generated_local']} ({ts['tz']})",
        f"- **Window (local):** {w['start']} -> {w['end']}  (selection on file mtime)",
        f"- **Observed session date span:** {w['observed_first'] or 'n/a'} -> {w['observed_last'] or 'n/a'}",
        f"- **KB_ROOT:** {meta['kb_root']}",
        f"- **Selection threshold:** >= {meta['min_users']} real human prompts", "",
        "## Mechanical totals", "",
        f"- **Sessions analyzed:** {a['n_sessions']}",
        f"- **Agent working-time:** {a['total_agent_walltime_hr']} hr",
        f"- **Human turns:** {a['total_human_turns']}",
        f"- **Input Tokens Used:** {a['total_input_used_tokens']:,}",
        f"- **Output Tokens Used:** {a['total_output_tokens']:,}",
        f"- **Cache-read Input Tokens:** {a['total_cache_read_tokens']:,}",
        f"- **KB reads / writes:** {a['total_kb_reads']} / {a['total_kb_writes']}", "",
        "## Skipped (not analyzed)", "",
    ]
    for reason, n in meta['skipped'].items():
        lines.append(f"- {reason}: {n}")
    lines += ["", "## Temporal (human-prompt timestamps, local time)", "",
        f"- **Busiest day of week:** {ts['busiest_day'] or 'n/a'}",
        f"- **Busiest hour of day:** {ts['busiest_hour_local'] if ts['busiest_hour_local'] is not None else 'n/a'}:00",
        f"- **Sessions in an overlapping/concurrent span:** {ts['overlapping_sessions']}",
        "", "_(full day/hour histograms + overlap pairs in `temporal.json`)_", "",
        "## Scanned files", "",
        f"{len(meta['scanned_files'])} transcript(s) analyzed:", "",
    ]
    for p in meta['scanned_files']:
        lines.append(f"- `{p}`")
    return "\n".join(lines) + "\n"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest')
    ap.add_argument('--scan')
    ap.add_argument('--start', help='window start date YYYY-MM-DD (local time); required with --scan')
    ap.add_argument('--end', help='window end date YYYY-MM-DD (local time, inclusive); required with --scan')
    ap.add_argument('--min-users', type=int, default=5)
    ap.add_argument('--kb-root', default=KB_ROOT_DEFAULT)
    ap.add_argument('--home-prefix', default=default_home_prefix(),
                    help='encoded home fragment stripped from project labels (default derived from $HOME, e.g. "-home-alice-")')
    ap.add_argument('--timeline', action='store_true', help='include per-output timeline per session')
    ap.add_argument('--out', help='RUNS PARENT dir; a per-run subdir <start>_<end>[_N] is auto-created')
    ap.add_argument('--single', help='single transcript path -> print metrics only')
    a = ap.parse_args()

    if a.single:
        print(json.dumps(session_metrics(a.single, kb_root=a.kb_root, build_timeline=a.timeline), indent=2)); return

    skipped = {}
    if a.scan:
        if not (a.start and a.end):
            ap.error('--scan requires --start and --end (YYYY-MM-DD, local time)')
        sessions, skipped = scan(a.scan, a.start, a.end, a.min_users, a.home_prefix)
    elif a.manifest:
        sessions = json.load(open(a.manifest))
    else:
        ap.error('need --manifest or --scan or --single')

    results = []
    for s in sessions:
        m = session_metrics(s['path'], kb_root=a.kb_root, build_timeline=a.timeline)
        m.update({"path": s['path'], "proj": s.get('proj', ''),
                  "users": s.get('users', m['human_turns']), "first": s.get('first', '')})
        results.append(m)

    agg = {
        "n_sessions": len(results),
        "total_agent_walltime_hr": round(sum(r['agent_walltime_sec'] for r in results) / 3600, 2),
        "total_input_used_tokens": sum(r['tokens']['input_used'] for r in results),
        "total_output_tokens": sum(r['tokens']['output'] for r in results),
        "total_cache_read_tokens": sum(r['tokens']['cache_read'] for r in results),
        "total_kb_reads": sum(r['kb_read_count'] for r in results),
        "total_kb_writes": sum(r['kb_write_count'] for r in results),
        "total_human_turns": sum(r['human_turns'] for r in results),
    }
    agg["skipped"] = skipped
    agg["kb_root"] = a.kb_root
    temporal = temporal_analysis(results)
    out = {"version": "extract-session-metrics", "aggregate": agg, "sessions": results}

    if a.out:
        # --out is the runs PARENT; create a non-clobbering per-run dir from the window.
        if a.scan:
            run_dir = make_run_dir(a.out, a.start, a.end)
        else:
            # manifest mode: no window dates -> use a generic subdir, still non-clobbering
            run_dir = make_run_dir(a.out, 'manifest', 'run')
        metrics_path = os.path.join(run_dir, 'metrics.json')
        json.dump(out, open(metrics_path, 'w'), indent=1)

        json.dump(temporal, open(os.path.join(run_dir, 'temporal.json'), 'w'), indent=1)

        observed = [r['session_start_local'][:10] for r in results if r.get('session_start_local')]
        meta = {
            "script_version": "extract-session-metrics",
            "generated_local": datetime.now().astimezone().isoformat(timespec='seconds'),
            "window": {
                "start": a.start, "end": a.end,
                "observed_first": min(observed) if observed else None,
                "observed_last": max(observed) if observed else None,
            },
            "kb_root": a.kb_root,
            "min_users": a.min_users,
            "totals": agg,
            "skipped": skipped,
            "temporal_summary": temporal_summary(temporal),
            "scanned_files": [r['path'] for r in results],
        }
        json.dump(meta, open(os.path.join(run_dir, 'run-meta.json'), 'w'), indent=1)
        open(os.path.join(run_dir, 'run-meta.md'), 'w').write(render_run_meta_md(meta))
        print(f"wrote run dir {run_dir}/ : metrics.json, temporal.json, run-meta.json, run-meta.md")
        print(f"  {agg}")
    else:
        print(json.dumps(out, indent=1))

if __name__ == '__main__':
    main()
