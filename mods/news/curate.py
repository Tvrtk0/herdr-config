# Herdr's News, the weekly "What's new": the official digest stopped in September, so this
# writes our own from the changelog. claude -p (Sonnet, no tools, none of your hooks or mods)
# reads the last seven days of releases, the docs pages that appeared meanwhile, and two
# official digests as the level to aim for, and keeps only what is a new idea, not an
# improvement to an old one. Started by collect.py when a new version is out (at most once
# in 20 hours) or by R twice; runs a minute or two, outside Herdr.
# Writes ~/.cache/herdr-news/curated.json.
import html, json, os, re, subprocess, sys, time
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

home = os.path.expanduser("~")
cache = f"{home}/.cache/herdr-news"
os.makedirs(cache, exist_ok=True)
UA = "Mozilla/5.0 (Macintosh) herdr-news/1"
CLAUDE = next((p for p in (f"{home}/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude") if os.path.exists(p)), "claude")
SAMPLES = ["https://code.claude.com/docs/en/whats-new/2026-w36.md", "https://code.claude.com/docs/en/whats-new/2026-w37.md"]

def get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(3_000_000).decode("utf-8", "replace")

def load(name, default):
    try:
        with open(f"{cache}/{name}") as fh: return json.load(fh)
    except Exception: return default

def text_of(h):
    h = re.sub(r"</(p|li|h\d)>", "\n", h or "")
    h = re.sub(r"<li>", "- ", h)
    return html.unescape(re.sub(r"<[^>]+>", "", h)).strip()

print(time.strftime("%Y-%m-%d %H:%M:%S"), "curate: start", flush=True)
root = ET.fromstring(get("https://code.claude.com/docs/en/changelog/rss.xml").encode("utf-8"))
releases = []
for it in root.iter("item"):
    f = {c.tag.split("}")[-1]: (c.text or "") for c in it}
    try: at = parsedate_to_datetime(f.get("pubDate", "")).timestamp()
    except Exception: at = 0
    releases.append({"version": f.get("title", "").strip(), "at": at, "link": f.get("link", ""), "notes": text_of(f.get("encoded") or f.get("description"))})
if not releases: sys.exit("no releases")

# Always the last seven days, written again on each new version: a rolling weekly digest.
since = time.time() - 7 * 86400
fresh = [r for r in releases if r["at"] > since] or releases[:3]
concepts = [c for c in load("concepts.json", []) if c.get("at", 0) > since - 86400 and not c.get("renamed")]

samples = []
for u in SAMPLES:
    try: samples.append(get(u)[:5000])
    except Exception: pass

notes = "\n\n".join(f"## {r['version']} ({time.strftime('%d %b', time.gmtime(r['at']))})\nLink: {r['link']}\n{r['notes'][:6000]}" for r in fresh)[:60000]
pages = "\n".join(f"- {c['title']} ({c['link']}): {c['desc']}" for c in concepts) or "(none)"
prompt = f"""You write a short weekly "What's new in Claude Code" for one developer who uses Claude Code all day and wants to hear about new concepts and features, never a changelog of small fixes.

Keep an item only if it is a new idea or capability someone would change how they work for: a new command, mode, setting family, extension point, integration, or a new docs page that introduces a concept. Drop fixes, polish, small options, renames, performance, platform-specific minutiae. Merge related lines into one item. Zero items is a valid answer when nothing qualifies.

For each item: a short title (a few words, plain), one sentence on why it matters to a heavy user, the release version it shipped in, and the best link (a docs page from the list below if one covers it, else the release's changelog link). Pick one item as the headline, the one most worth knowing. Write in English, plain and concrete, no hype, no em dashes.

Two official digests, as the level to aim for (format differs, the selection bar is what matters):
{chr(10).join(samples) or "(unavailable)"}

Docs pages that appeared in this period (each may be a new concept):
{pages}

Releases in this period:
{notes}
"""
schema = {
    "type": "object", "additionalProperties": False, "required": ["items"],
    "properties": {"items": {"type": "array", "maxItems": 6, "items": {
        "type": "object", "additionalProperties": False, "required": ["title", "why", "version", "link", "headline"],
        "properties": {"title": {"type": "string"}, "why": {"type": "string"}, "version": {"type": "string"},
                       "link": {"type": "string"}, "headline": {"type": "boolean"}}}}},
}
r = subprocess.run([CLAUDE, "-p", "--safe-mode", "--tools", "", "--model", "sonnet", "--output-format", "json",
                    "--json-schema", json.dumps(schema)], input=prompt, capture_output=True, text=True, timeout=600, cwd=cache)
if r.returncode != 0: sys.exit(f"claude failed: {r.stderr.strip()[-400:] or r.stdout.strip()[-400:]}")
out = json.loads(r.stdout)
got = out.get("structured_output")
if got is None:
    res = out.get("result") or ""
    m = re.search(r"\{[\s\S]*\}", res)
    got = json.loads(m.group(0)) if m else {"items": []}
items = got.get("items") or []
items.sort(key=lambda x: not x.get("headline"))
value = {"version": releases[0]["version"], "at": time.time(), "from": since, "to": time.time(),
         "versions": [r["version"] for r in fresh], "items": items, "cost": out.get("total_cost_usd")}
tmp = f"{cache}/curated.json.tmp"
with open(tmp, "w") as fh: json.dump(value, fh)
os.replace(tmp, f"{cache}/curated.json")
print(time.strftime("%Y-%m-%d %H:%M:%S"), f"curate: {len(items)} items from {len(fresh)} releases", flush=True)
