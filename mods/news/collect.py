# Herdr's News: what is new in Claude Code (new concepts), AI and tech, as one small JSON.
# New concepts come without AI: a page that appears in the docs' page list (llms.txt) is a
# new concept, and its one-line description is the card's text. Feeds are fetched in
# parallel with a short timeout each, so the whole run stays well under Herdr's 30 s.
# The weekly "What's new" is curate.py's work (claude -p); this only starts it when a new
# Claude Code version is out and reads what it wrote.
# State: ~/.cache/herdr-news/ (pages.json, concepts.json, curated.json, curate.log).
import html, json, os, re, subprocess, sys, time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET

home = os.path.expanduser("~")
cache = f"{home}/.cache/herdr-news"
os.makedirs(cache, exist_ok=True)
here = os.path.dirname(os.path.abspath(__file__))
now = time.time()
UA = "Mozilla/5.0 (Macintosh) herdr-news/1"

def load(name, default):
    try:
        with open(f"{cache}/{name}") as fh: return json.load(fh)
    except Exception: return default

def save(name, value):
    tmp = f"{cache}/{name}.tmp"
    with open(tmp, "w") as fh: json.dump(value, fh)
    os.replace(tmp, f"{cache}/{name}")

def get(url, timeout=7):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(3_000_000).decode("utf-8", "replace")

def when(text):
    if not text: return None
    text = text.strip()
    try: return parsedate_to_datetime(text).timestamp()
    except Exception: pass
    try: return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except Exception: return None

def clean(s, n=240):
    s = re.sub(r"<[^>]+>", " ", html.unescape(s or ""))
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"

# RSS 2.0 and Atom alike: title, link, time, a short summary, and HN's points and comments.
def items(text):
    root = ET.fromstring(text.encode("utf-8"))
    out = []
    for e in root.iter():
        tag = e.tag.split("}")[-1]
        if tag not in ("item", "entry"): continue
        f = {}
        for c in e:
            k = c.tag.split("}")[-1]
            if k == "link":
                f["link"] = c.get("href") or (c.text or "").strip() or f.get("link")
                if c.get("rel") not in (None, "alternate") and f.get("link0"): continue
                f["link0"] = True
            elif k in ("title", "pubDate", "published", "updated", "date", "description", "summary", "comments"):
                f.setdefault(k, (c.text or "").strip())
        t = when(f.get("pubDate") or f.get("published") or f.get("updated") or f.get("date"))
        desc = f.get("description") or f.get("summary") or ""
        pts = re.search(r"Points:\s*(\d+)", desc)
        com = re.search(r"# Comments:\s*(\d+)", desc)
        out.append({
            "title": clean(f.get("title"), 160), "link": f.get("link"), "at": t,
            "summary": "" if pts else clean(desc),
            "points": int(pts.group(1)) if pts else None,
            "comments": int(com.group(1)) if com else None,
            "discuss": f.get("comments") if pts else None,
        })
    return out

HN = "https://hnrss.org/newest"
FEEDS = [
    # id, name, section, url, days kept, at most
    ("claude-blog", "Claude blog", "claude", "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_claude.xml", 21, 6),
    ("anthropic", "Anthropic", "claude", "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml", 21, 4),
    ("hn-cc", "HN · Claude Code", "claude", f"{HN}?q=%22Claude+Code%22&points=100", 10, 6),
    ("willison", "Simon Willison", "claude", "https://simonwillison.net/tags/claude-code.atom", 14, 3),
    ("tldr-ai", "TLDR AI", "ai", "https://tldr.tech/api/rss/ai", 7, 6),
    ("openai", "OpenAI", "ai", "https://openai.com/news/rss.xml", 7, 4),
    ("techmeme", "Techmeme", "tech", "https://www.techmeme.com/feed.xml", 2, 8),
    ("hn-top", "Hacker News", "split", f"{HN}?points=300", 3, 30),
]
CHANGELOG = "https://code.claude.com/docs/en/changelog/rss.xml"
LLMS = "https://code.claude.com/docs/llms.txt"
AI_WORDS = re.compile(r"\b(ai|llm|llms|gpt|openai|anthropic|claude|gemini|deepmind|mistral|llama|model|models|agent|agents|agentic|copilot|cursor|chatgpt|transformer|inference|nvidia)\b", re.I)
RISK_WORDS = re.compile(r"\b(backdoor\w*|vulnerab\w*|exploit\w*|malware|leak\w*|breach\w*|cve-[\d-]+|outage|compromis\w*|supply.chain|prompt.injection|hijack\w*|expos\w*|password\w*|credential\w*|secret\w*|privacy|tracking|sends? (your|each))\b", re.I)

def fetch(feed):
    fid, name, section, url, days, most = feed
    try:
        got = items(get(url))
        got = [x for x in got if x["at"] is None or now - x["at"] < days * 86400]
        return fid, {"ok": True, "items": got, "most": most, "section": section, "name": name}
    except Exception as e:
        return fid, {"ok": False, "error": clean(str(e), 90), "section": section, "name": name}

def pages():
    # "- [Title](url.md): one sentence" lines; the heading above each is its group.
    text = get(LLMS)
    group, out = "", {}
    for line in text.splitlines():
        h = re.match(r"^#{2,4}\s+(.*)", line)
        if h: group = h.group(1).strip(); continue
        m = re.match(r"^- \[([^\]]+)\]\((https://[^)]+?)(?:\.md)?\)(?::\s*(.*))?$", line.strip())
        if m: out[m.group(2)] = {"title": m.group(1), "desc": m.group(3) or "", "group": group}
    return out

def changelog():
    got = items(get(CHANGELOG))
    return [{"version": x["title"], "at": x["at"], "link": x["link"]} for x in got[:12]]

with ThreadPoolExecutor(max_workers=12) as pool:
    feed_jobs = [pool.submit(fetch, f) for f in FEEDS]
    pages_job, log_job = pool.submit(pages), pool.submit(changelog)
    results = dict(j.result() for j in feed_jobs)

sources = []
sections = {"claude": [], "ai": [], "tech": []}
seen_links = set()
for fid, name, section, *_ in FEEDS:
    r = results[fid]
    sources.append({"id": fid, "name": name, "ok": r["ok"], "count": len(r.get("items", [])), "error": r.get("error")})
    if not r["ok"]: continue
    picked = []
    for x in r["items"]:
        if not x.get("link") or x["link"] in seen_links: continue
        sec = section
        if section == "split": sec = "ai" if AI_WORDS.search(x["title"]) else "tech"
        x = dict(x, source=name, risk=bool(fid.startswith("hn") and RISK_WORDS.search(x["title"])))
        picked.append((sec, x))
    # Each feed gives at most its share to each section.
    per = {}
    for sec, x in picked:
        if per.get(sec, 0) >= (r["most"] if section != "split" else 8): continue
        per[sec] = per.get(sec, 0) + 1
        seen_links.add(x["link"])
        sections[sec].append(x)
for sec in sections:
    sections[sec].sort(key=lambda x: -(x["at"] or 0))

# New concepts: pages that were not in the list last time. The first run only remembers
# the list; a page whose title was already known under another address counts as renamed.
concepts = load("concepts.json", [])
try:
    cur = pages_job.result()
    old = load("pages.json", None)
    if old is not None:
        old_titles = {v["title"].lower() for v in old.values()}
        for url, p in cur.items():
            if url in old: continue
            concepts.insert(0, {"title": p["title"], "desc": p["desc"], "group": p["group"], "link": url, "at": now,
                                "renamed": p["title"].lower() in old_titles})
    save("pages.json", cur)
    concepts = [c for c in concepts if now - c["at"] < 45 * 86400][:40]
    save("concepts.json", concepts)
    sources.insert(0, {"id": "docs", "name": "Claude Code docs", "ok": True, "count": len(cur), "error": None})
except Exception as e:
    sources.insert(0, {"id": "docs", "name": "Claude Code docs", "ok": False, "count": 0, "error": clean(str(e), 90)})

# The changelog: the version chip, and the cue for the curator.
versions = []
try:
    versions = log_job.result()
    sources.insert(1, {"id": "changelog", "name": "Changelog", "ok": True, "count": len(versions), "error": None})
except Exception as e:
    sources.insert(1, {"id": "changelog", "name": "Changelog", "ok": False, "count": 0, "error": clean(str(e), 90)})

curated = load("curated.json", None)
state = load("curate-state.json", {})
running = False
try:
    if state.get("pid"): os.kill(state["pid"], 0); running = True
except Exception: running = False
latest = versions[0]["version"] if versions else None
want = latest and (not curated or curated.get("version") != latest)
recent = now - state.get("startedAt", 0) < 20 * 3600
if "--curate" in sys.argv[1:]: want, recent = bool(latest), False
if want and not recent and not running:
    # Started on its own, outside Herdr's exec: it takes a minute or two and outlives this run.
    with open(f"{cache}/curate.log", "a") as log:
        p = subprocess.Popen([sys.executable, "-I", f"{here}/curate.py"], stdout=log, stderr=log,
                             stdin=subprocess.DEVNULL, start_new_session=True)
    state = {"pid": p.pid, "startedAt": now, "for": latest}
    save("curate-state.json", state)
    running = True

print(json.dumps({
    "at": now, "sections": sections, "concepts": concepts, "sources": sources,
    "version": latest, "versionAt": versions[0]["at"] if versions else None,
    "curated": curated, "curating": running,
}))
