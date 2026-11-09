# Herdr's Stats: the last 14 days of Claude and git, as one small JSON.
# argv: [1] folders to look in for commits (each repo's worktrees too).
import glob, json, os, subprocess, sys, time
from collections import Counter, defaultdict
from datetime import datetime, timedelta

home = os.path.expanduser("~")
DAYS = 14
today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
start = today - timedelta(days=DAYS - 1)
days = [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(DAYS)]

def prompt_text(r):
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c): return None
        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    t = (c or "").strip()
    return None if not t or t.startswith("<") or r.get("isMeta") else t

prompts, tokens, hours = Counter(), Counter(), Counter()
sessions = defaultdict(set)
projects = Counter()
for tp in glob.glob(f"{home}/.claude/projects/*/*.jsonl"):
    try:
        if os.path.getmtime(tp) < start.timestamp(): continue
    except OSError: continue
    sid = os.path.basename(tp)
    for l in open(tp, errors="replace"):
        if '"timestamp":"' not in l: continue
        try: r = json.loads(l)
        except Exception: continue
        if r.get("isSidechain"): continue
        try: ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")).astimezone()
        except Exception: continue
        if ts.timestamp() < start.timestamp(): continue
        day = ts.strftime("%Y-%m-%d")
        if r.get("type") == "user" and prompt_text(r):
            prompts[day] += 1; hours[ts.hour] += 1; sessions[day].add(sid)
            projects[os.path.basename((r.get("cwd") or "").rstrip("/")) or "?"] += 1
        elif r.get("type") == "assistant":
            tokens[day] += ((r.get("message") or {}).get("usage") or {}).get("output_tokens", 0) or 0

# Commits by you, per day, across the repos and their worktrees (a commit counted once).
me = subprocess.run(["git", "config", "--global", "user.name"], capture_output=True, text=True).stdout.strip()
roots = []
for d in [os.path.expanduser(x) for x in json.loads(sys.argv[1])]:
    found = []
    for g in (d, os.path.join(d, ".bare")):
        r = subprocess.run(["git", "-C", g, "worktree", "list", "--porcelain"], capture_output=True, text=True)
        if r.returncode == 0:
            found = [l[9:] for l in r.stdout.split("\n") if l.startswith("worktree ") and os.path.isdir(os.path.join(l[9:], ".git"))]
            if found: break
    roots += found[:1] or [d]
commits, seen, byRepo = Counter(), set(), Counter()
for root in dict.fromkeys(roots):
    r = subprocess.run(["git", "-C", root, "log", "--all", f"--since={DAYS} days ago", f"--author={me}", "--format=%H %ad", "--date=short"], capture_output=True, text=True)
    if r.returncode != 0: continue
    name = os.path.basename(root.rstrip("/"))
    for line in r.stdout.split("\n"):
        if not line.strip(): continue
        h, day = line.split()[:2]
        if h in seen: continue
        seen.add(h); commits[day] += 1; byRepo[name] += 1

print(json.dumps({
    "days": days,
    "prompts": [prompts[d] for d in days],
    "tokens": [tokens[d] for d in days],
    "sessions": [len(sessions[d]) for d in days],
    "commits": [commits[d] for d in days],
    "hours": [hours[h] for h in range(24)],
    "projects": projects.most_common(6),
    "repos": byRepo.most_common(6),
    "at": time.time(),
}))
