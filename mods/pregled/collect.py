# Herdr's overview: one JSON of what the Claude sessions, today's work and git are doing.
# argv: [1] the agents' terminals as JSON, [2] folders to look in for today's commits.
import glob, json, os, re, subprocess, sys, time
from datetime import datetime, timezone

home = os.path.expanduser("~")
terms = json.loads(sys.argv[1])
# Each folder, or every worktree of the repo it holds (a bare container's too).
roots = []
for d in [os.path.expanduser(x) for x in json.loads(sys.argv[2])]:
    found = []
    for g in (d, os.path.join(d, ".bare")):
        r = subprocess.run(["git", "-C", g, "worktree", "list", "--porcelain"], capture_output=True, text=True)
        if r.returncode == 0:
            found = [l[9:] for l in r.stdout.split("\n") if l.startswith("worktree ") and os.path.isdir(os.path.join(l[9:], ".git"))]
            if found: break
    roots += found or [d]
roots = list(dict.fromkeys(roots))
midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

def load(path):
    try: return json.load(open(path))
    except Exception: return None

def tail(path, n=400000):
    with open(path, "rb") as f:
        f.seek(0, 2); size = f.tell(); f.seek(max(0, size - n))
        return f.read().decode("utf-8", "replace").split("\n")[1:]

def prompt_text(r):
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c): return None
        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    t = (c or "").strip()
    return None if not t or t.startswith("<") or r.get("isMeta") else t

sessions, limits, newest = [], None, 0
for t in terms:
    s = {"terminal": t}
    try:
        # The session-bridge mod's file names the session at once; the process walk is the fallback.
        br = load(f"{home}/.claude/state/session/{t}.json") or {}
        sess = {"sessionId": br["sessionId"], "cwd": br.get("launchCwd") or br.get("cwd", "")} if br.get("sessionId") else None
        pid = None
        if not sess:
            got = json.loads(subprocess.run(["hc", "get", t, "--json"], capture_output=True, text=True, timeout=5).stdout or "{}")
            pid = (got.get("foreground") or {}).get("pid")
        # While Claude runs a tool the foreground is that tool's process: walk up its parents
        # to the one Claude keeps a session file for.
        for _ in range(0 if sess else 8):
            if not pid or int(pid) <= 1: break
            sess = load(f"{home}/.claude/sessions/{pid}.json")
            if sess: break
            pid = (subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True).stdout.strip() or "0")
        if sess and sess.get("sessionId"):
            sid, cwd = sess["sessionId"], sess.get("cwd", "")
            s["cwd"] = cwd
            line = load(f"{home}/.claude/state/statusline/{sid}.json") or {}
            cw = line.get("context_window") or {}
            s["ctx"] = cw.get("used_percentage")
            s["model"] = (line.get("model") or {}).get("display_name")
            s["effort"] = (line.get("effort") or {}).get("level")
            st = os.path.getmtime(f"{home}/.claude/state/statusline/{sid}.json") if line else 0
            if line.get("rate_limits") and st > newest: newest, limits = st, line["rate_limits"]
            tp = f"{home}/.claude/projects/{''.join(ch if ch.isalnum() else '-' for ch in cwd)}/{sid}.jsonl"
            if os.path.exists(tp):
                # The transcript's last write stands in when its end holds no message (a few
                # screenshots can fill the part read).
                s["spokeAt"] = datetime.fromtimestamp(os.path.getmtime(tp), timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
                # Subagents: launched by Agent/Task, done when their result comes back (or, run in
                # the background, when their task notification does).
                ags, by_agent = {}, {}
                for l in tail(tp, 2000000):
                    try: r = json.loads(l)
                    except Exception: continue
                    if r.get("isSidechain"): continue
                    body0 = str(r.get("content") or "")
                    if r.get("type") == "queue-operation" and "<task-notification>" in body0:
                        m = re.search(r"<tool-use-id>([^<]+)</tool-use-id>", body0)
                        if m and m.group(1) in ags: ags[m.group(1)]["run"] = False
                        continue
                    for b in ((r.get("message") or {}).get("content") or []) if isinstance((r.get("message") or {}).get("content"), list) else []:
                        if not isinstance(b, dict): continue
                        if b.get("type") == "tool_use" and b.get("name") in ("Agent", "Task"):
                            i = b.get("input") if isinstance(b.get("input"), dict) else {}
                            ags[b.get("id")] = {"what": (i.get("description") or "Subagent")[:80], "kind": i.get("subagent_type") or "general-purpose", "model": i.get("model"), "began": r.get("timestamp"), "run": True}
                        elif b.get("type") == "tool_result" and b.get("tool_use_id") in ags:
                            c0 = b.get("content")
                            txt = c0 if isinstance(c0, str) else " ".join(x.get("text", "") for x in (c0 or []) if isinstance(x, dict))
                            a0 = ags[b["tool_use_id"]]
                            if "Async agent launched" in txt: a0["bg"] = True
                            else: a0["run"] = False
                    if r.get("type") == "user":
                        txt = prompt_text(r)
                        if txt: s["asked"], s["askedAt"] = txt[:200], r.get("timestamp")
                    elif r.get("type") == "assistant":
                        s["spokeAt"] = r.get("timestamp") or s.get("spokeAt")
                        for b in (r.get("message") or {}).get("content") or []:
                            if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip():
                                s["said"] = " ".join(b["text"].split())[:240]
                # Only the ones still running, and none older than three hours (a session closed
                # mid-run never sends its notification).
                cut = time.time() - 3 * 3600
                def ts(v):
                    try: return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
                    except Exception: return 0
                run = [dict(a, began=a["began"]) for a in ags.values() if a.get("run") and ts(a.get("began")) > cut]
                if run: s["agents"] = [{k: a.get(k) for k in ("what", "kind", "model", "began", "bg")} for a in run[-6:]]
            plan = load(f"{home}/.claude/state/plan/{t}.json") or {}
            if plan.get("steps"):
                s["steps"] = len(plan["steps"])
                s["done"] = sum(1 for x in plan["steps"] if x.get("status") == "done") if not plan.get("wrap") else len(plan["steps"])
                act = next((x for x in plan["steps"] if x.get("status") == "active"), None)
                s["step"] = act.get("title") if act and not plan.get("wrap") else None
                s["stepsAt"] = plan.get("stepsAt")
                s["plan"] = [{"title": x.get("title", ""), "status": x.get("status"), "result": x.get("result")} for x in plan["steps"][:10]]
            if plan.get("wrap"):
                s["wrap"] = (plan["wrap"].get("done") or [""])[0]
                s["tested"] = plan["wrap"].get("tested")
                s["forYou"] = plan["wrap"].get("forYou")
                s["wrapAt"] = plan.get("wrapAt")
    except Exception as e:
        s["error"] = str(e)
    sessions.append(s)

# Today: your prompts, Claude's replies and output tokens, in every session touched today.
prompts = replies = tokens = active = 0
for tp in glob.glob(f"{home}/.claude/projects/*/*.jsonl"):
    try:
        if os.path.getmtime(tp) < midnight: continue
    except OSError: continue
    seen = False
    for l in open(tp, errors="replace"):
        if '"timestamp":"' not in l: continue
        try: r = json.loads(l)
        except Exception: continue
        ts = r.get("timestamp") or ""
        try:
            if datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() < midnight: continue
        except Exception: continue
        if r.get("isSidechain"): continue
        if r.get("type") == "user" and prompt_text(r): prompts += 1; seen = True
        elif r.get("type") == "assistant":
            u = (r.get("message") or {}).get("usage") or {}
            tokens += u.get("output_tokens", 0) or 0
            if any(isinstance(b, dict) and b.get("type") == "text" for b in (r.get("message") or {}).get("content") or []): replies += 1
    active += seen

# Git today: commits since midnight by you, and uncommitted files, per repo.
git = []
me = subprocess.run(["git", "config", "--global", "user.name"], capture_output=True, text=True).stdout.strip()
for root in roots:
    if not os.path.isdir(root): continue
    log = subprocess.run(["git", "-C", root, "log", "--all", "--since=midnight", f"--author={me}", "--format=%h"], capture_output=True, text=True)
    if log.returncode != 0: continue
    dirty = subprocess.run(["git", "-C", root, "status", "--porcelain"], capture_output=True, text=True).stdout
    parent = os.path.basename(os.path.dirname(root.rstrip("/")))
    name = os.path.basename(root.rstrip("/"))
    git.append({"repo": name if name in ("dotfiles", "mods") else parent + "/" + name, "commits": len([x for x in log.stdout.split() if x]), "dirty": len([x for x in dirty.split("\n") if x.strip()])})

print(json.dumps({"sessions": sessions, "limits": limits, "today": {"prompts": prompts, "replies": replies, "tokens": tokens, "sessions": active}, "git": git, "at": time.time()}))
