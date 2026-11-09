// One PR's diff, read from GitHub (gh pr diff), no checkout needed.
// props: { repo: "owner/name", number, url? }. Files on the left, the picked file's diff on the right.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, TextView, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { exec, hc, home, props, theme, settings, shared, setShared, focused, panes, spaces, agents, run, nextCommand, openOverlay, closeOverlay, readTextFile, appHome } from "herdr";

// A see-through look (glass) has a translucent background: panes let it show through,
// and cards get a faint tint of their own, since its surface is opaque for tooltips.
const glassy = (t) => (t.background ?? "").length === 9;
// A color at some opacity, whether it came as #rrggbb or already #rrggbbaa.
const alpha = (c, a) => (c.length === 9 ? c.slice(0, 7) : c) + a;
// "[Web] Add a drawer" -> ["Web", "Add a drawer"].
const splitTitle = (title) => {
  const m = (title ?? "").match(/^\s*\[([^\]]{1,16})\]\s*(.*)$/);
  return m ? [m[1], m[2]] : [null, title ?? ""];
};
const cardBg = (t) => (glassy(t) ? (t.foreground.slice(0, 7) + "0d") : t.surface);


// Diff code is wrapped, not scrolled sideways: a monospace cell at 11.5px is
// about 6.9px, so 7 keeps a wrapped line inside the column.
const CH = 7;
// Gutters left of the code: unified two numbers and the marker, split one of each.
const GUTTER_U = 40 + 8 + 40 + 8 + 10 + 8;
const GUTTER_S = 40 + 8 + 10 + 8;

// Styled segments cut into lines of at most n characters.
function wrapSegs(segs, n) {
  if (!(n > 0)) return [segs];
  const lines = [[]];
  let used = 0;
  for (const s of segs) {
    let text = s.text.replace(/\t/g, "  ");
    while (text.length) {
      if (used >= n) { lines.push([]); used = 0; }
      const take = text.slice(0, n - used);
      lines[lines.length - 1].push({ ...s, text: take });
      used += take.length;
      text = text.slice(take.length);
    }
  }
  return lines;
}

const MAX_LINES = 20000;

// Splits `gh pr diff` output into files with their status, counts and hunk lines.
function parse(text, colored) {
  const files = [];
  let f = null;
  const all = text.split("\n");
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (head) {
      f = { path: head[2], from: head[1], status: "M", add: 0, del: 0, lines: [], ansi: [], binary: false };
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (!f.lines.length) {
      if (line.startsWith("new file mode")) f.status = "A";
      else if (line.startsWith("deleted file mode")) f.status = "D";
      else if (line.startsWith("rename from")) f.status = "R";
      else if (line.startsWith("Binary files")) f.binary = true;
      if (!line.startsWith("@@")) continue;
    }
    if (line.startsWith("\\ No newline")) continue;
    if (line[0] === "+") f.add++;
    else if (line[0] === "-") f.del++;
    f.lines.push(line);
    f.ansi.push(colored[i]);
  }
  return files;
}

// gh writes the diff to a temp file; out come the plain copy, a NUL, then delta's
// colored copy: the same lines, syntax colors as truecolor SGR, changed words on a
// stronger background.
const DIFF_SCRIPT = String.raw`
f=$(mktemp) || exit 1
trap 'rm -f "$f"' EXIT
gh pr diff "$1" --repo "$2" --color=never > "$f" || exit 1
/bin/cat "$f"
printf '\0'
command -v delta >/dev/null || exit 0
delta --color-only --true-color=always --paging=never --syntax-theme="$3" \
  --zero-style=syntax --minus-style='syntax #3f0001' --minus-emph-style='syntax #901011' \
  --plus-style='syntax #002800' --plus-emph-style='syntax #006000' < "$f" 2>/dev/null
exit 0
`;

// Images in the description, reviews, conversation and review threads. Private repos
// serve them only through short-lived signed URLs, which GraphQL's bodyHTML carries.
// Each image is keyed by what its markdown says: the asset UUID of a
// user-attachments link, else the original URL (data-canonical-src behind camo).
// Each is downloaded once into ~/.config/herdr-app/pr-images and measured; each run
// also drops images no PR has shown for 14 days.
// Out: one line per image, "key<TAB>path<TAB>width<TAB>height".
const IMAGES_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
bodyHTML reviews(first:100){nodes{bodyHTML}} comments(first:100){nodes{bodyHTML}}
reviewThreads(first:100){nodes{comments(first:100){nodes{bodyHTML}}}}}}}`;
const IMAGES_JQ = `.data.repository.pullRequest | [.bodyHTML, .reviews.nodes[].bodyHTML, .comments.nodes[].bodyHTML, .reviewThreads.nodes[].comments.nodes[].bodyHTML] | join("\\n")`;
const IMAGES_SCRIPT = String.raw`
dir="$HOME/.config/herdr-app/pr-images"
mkdir -p "$dir" || exit 1
# Cache upkeep: a file's mtime is its last use; unused for 14 days, it goes.
find "$dir" -type f -mtime +14 -delete 2>/dev/null
gh api graphql -F n="$1" -f o="$2" -f r="$3" -f query="$4" -q "$5" | grep -oE '<img [^>]*>' | sort -u \
  | while IFS= read -r tag; do
  src=$(printf '%s' "$tag" | sed -nE 's/.* src="([^"]+)".*/\1/p' | sed 's/&amp;/\&/g')
  [ -n "$src" ] || continue
  canon=$(printf '%s' "$tag" | sed -nE 's/.* data-canonical-src="([^"]+)".*/\1/p' | sed 's/&amp;/\&/g')
  uuid=$(printf '%s' "$src" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  case "$src" in
    *private-user-images*|*user-attachments*) key="$uuid";;
    *) key="$canon";;
  esac
  [ -n "$key" ] || key=$(printf '%s' "$src" | cut -d'?' -f1)
  name=$(md5 -q -s "$key")
  f=$(find "$dir" -maxdepth 1 -type f -name "$name.*" ! -name '*.part' | head -1)
  if [ -z "$f" ]; then
    tmp="$dir/$name.part"
    if curl -sfL --max-time 20 -o "$tmp" "$src"; then
      case $(file -b --mime-type "$tmp") in
        image/png) e=png;; image/jpeg) e=jpg;; image/gif) e=gif;; image/webp) e=webp;; image/svg+xml) e=svg;; *) e=bin;;
      esac
      f="$dir/$name.$e"; mv "$tmp" "$f"
    else
      rm -f "$tmp"; continue
    fi
  else
    touch "$f"
  fi
  wh=$(sips -g pixelWidth -g pixelHeight "$f" 2>/dev/null | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w "\t" h}')
  printf '%s\tpr-images/%s\t%s\n' "$key" "$(basename "$f")" "$wh"
done
exit 0
`;
const UUID_RE = /user-attachments\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
// The key an image's markdown URL is downloaded under.
const imageKey = (url) => UUID_RE.exec(url ?? "")?.[1] ?? (url ?? "").replace(/&amp;/g, "&");
// Markdown and HTML images in a description, in document order.
const IMG_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*>/gi;
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1] ?? "";

// Text and image parts of a piece of markdown. counter.n numbers images in document
// order, the same order as the <img> tags in body_html.
function inlineParts(text, counter) {
  const parts = [];
  let last = 0, m;
  const re = new RegExp(IMG_RE.source, "gi");
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const tag = m[0].startsWith("<");
    parts.push({ image: counter.n++, alt: tag ? attr(m[0], "alt") : m[1], url: tag ? attr(m[0], "src") : m[2] });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.filter((p) => p.image !== undefined || p.text.trim());
}

const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
// GitHub turns a bare attachment link on its own line into a video player.
const VIDEO_RE = /^\s*(https:\/\/github\.com\/user-attachments\/assets\/[\w-]+)\s*$/;

// The description as parts: text, images, tables that hold images (drawn as a
// grid, since the markdown table would come apart around them) and videos.
function bodyParts(body) {
  const counter = { n: 0 }, out = [], lines = body.split("\n");
  let buf = [];
  const flush = () => { if (buf.length) out.push(...inlineParts(buf.join("\n"), counter)); buf = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const video = VIDEO_RE.exec(l);
    if (video) { flush(); out.push({ video: video[1] }); continue; }
    if (isRow(l) && isSep(lines[i + 1] ?? "")) {
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) j++;
      const block = lines.slice(i, j);
      if (/!\[|<img\b/i.test(block.join("\n"))) {
        flush();
        const header = cells(block[0]).map((c) => inlineParts(c, counter));
        const rows = block.slice(2).map((r) => cells(r).map((c) => inlineParts(c, counter)));
        out.push({ table: { header, rows } });
        i = j - 1;
        continue;
      }
    }
    buf.push(l);
  }
  flush();
  return out;
}

// Unified rows into split pairs: a change block's removed lines on the left
// beside its added lines on the right, context on both sides.
function splitRows(rows) {
  const out = [];
  let dels = [], adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "pair", l: dels[i] ?? null, r: adds[i] ?? null });
    dels = []; adds = [];
  };
  for (const r of rows) {
    if (r.kind === "-") { if (adds.length) flush(); dels.push(r); }
    else if (r.kind === "+") adds.push(r);
    else {
      flush();
      out.push(r.kind === "@" ? { kind: "@", text: r.text } : { kind: "pair", l: r, r });
    }
  }
  flush();
  return out;
}

// Review threads: where each sits (path, line, side), whether it's resolved or
// outdated, and its comments.
const THREADS_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine diffSide
comments(first:100){nodes{author{login} body createdAt url}}}}}}}`;

function parseThreads(stdout) {
  const nodes = JSON.parse(stdout)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes.filter((n) => n.comments.nodes.length).map((n) => ({
    id: n.id,
    path: n.path,
    line: n.line,
    originalLine: n.originalLine,
    side: n.diffSide,
    resolved: n.isResolved,
    outdated: n.isOutdated,
    comments: n.comments.nodes.map((c) => ({ author: c.author?.login ?? "ghost", body: c.body, at: c.createdAt, url: c.url })),
  }));
}

// Review bodies and conversation comments, oldest first. A COMMENTED review with
// no text only carries inline comments, which the diff already shows.
function conversationOf(info) {
  const isBot = (login) => /\[bot\]$|^github-actions$/.test(login ?? "");
  const reviews = (info?.reviews ?? [])
    .filter((r) => r.body?.trim() || r.state !== "COMMENTED")
    .map((r) => ({ id: r.id, kind: "review", author: r.author?.login ?? "ghost", state: r.state, body: r.body ?? "", at: r.submittedAt, bot: isBot(r.author?.login) }));
  const comments = (info?.comments ?? []).map((c) => ({
    id: c.id, kind: "comment", author: c.author?.login ?? "ghost", body: c.body ?? "", at: c.createdAt, url: c.url,
    minimized: c.isMinimized, bot: isBot(c.author?.login),
  }));
  return [...reviews, ...comments].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const REVIEW_STATE = {
  APPROVED: ["Approved", "ansi2"],
  CHANGES_REQUESTED: ["Changes requested", "ansi1"],
  COMMENTED: ["Reviewed", "dim"],
  DISMISSED: ["Dismissed", "dim"],
  PENDING: ["Pending", "dim"],
};

function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// One pane of a tab at a time: zoom the next pane (the agent after the PR, the PR
// after the agent) and give it the keyboard. With no pane zoomed, the one not
// focused comes up.
function swapZoom(tabId) {
  const ps = panes().filter((p) => p.tab === tabId);
  // A Claude reader and its prompt are one view, not two to swap.
  if (ps.length < 2 || ps.some((p) => (p.mod === "claude-reader" || p.mod === "claude-steps"))) return;
  const zoomed = ps.find((p) => p.zoomed);
  const cur = zoomed ?? ps.find((p) => p.focused) ?? ps[0];
  const next = ps[(ps.indexOf(cur) + 1) % ps.length];
  if (zoomed) run("pane.zoom", { pane: zoomed.pane });
  run("pane.zoom", { pane: next.pane });
  run("pane.focus", { pane: next.pane });
}

// Which repos, folders and review skills: machine-local, read from
// ~/.config/herdr-app/local.json (outside the dotfiles repo; local.example.json shows its shape).
const LOCAL = readTextFile(`${appHome()}/local.json`)
  .then((t) => { try { return JSON.parse(t ?? "{}") ?? {}; } catch { return {}; } })
  .catch(() => ({}));
// Which review skill runs for a repo, and in which folder (its skills load from there);
// filled from local.json's "reviewers" once read.
const REVIEWERS = { default: { dir: "~", skill: "/comment-pr-frontend" } };
LOCAL.then((local) => {
  Object.assign(REVIEWERS, local.reviewers ?? {});
  if (local.defaultReviewer) REVIEWERS.default = local.defaultReviewer;
});
// shared: "owner/repo#123" → { tab } of the tab its review agent was started in.
const AGENTS_KEY = "pr-diff.agents";
// shared: what the confirm dialog's "pr-diff.post" sends: { repo, number, nums, at }.
const POST_KEY = "pr-diff.post";

// The review agent's own transcript (Claude Code writes one per session under
// ~/.claude/projects/<its folder>/): the session whose first message ran the review skill
// on this PR, and the text of every reply in it. $1 project folder, $2 PR url, $3 known file.
const TRANSCRIPT = String.raw`
import json, os, sys, glob, subprocess, time
d, url, known = sys.argv[1], sys.argv[2], sys.argv[3]
needle = "<command-args>" + url + "</command-args>"
def first_user(f):
    with open(f, errors="replace") as fh:
        for line in fh:
            try: r = json.loads(line)
            except Exception: continue
            if r.get("type") == "user":
                c = r.get("message", {}).get("content")
                if isinstance(c, list): c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                return c or ""
    return ""
if known and os.path.exists(known): files = [known]
else:
    recent = [f for f in glob.glob(os.path.join(d, "*.jsonl")) if time.time() - os.path.getmtime(f) < 14 * 86400]
    out = subprocess.run(["grep", "-l", "-F", needle] + recent, capture_output=True, text=True).stdout.splitlines() if recent else []
    files = sorted([f for f in out if f], key=os.path.getmtime, reverse=True)
for f in files:
    if needle not in first_user(f): continue
    texts, turns = [], []
    with open(f, errors="replace") as fh:
        for line in fh:
            try: r = json.loads(line)
            except Exception: continue
            kind = r.get("type")
            content = r.get("message", {}).get("content")
            if kind == "user":
                # What was typed; tool results and the skill's own expansion are not.
                said = content if isinstance(content, str) else " ".join(c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text")
                said = (said or "").strip()
                if said and not said.startswith("<") and not r.get("isMeta"): turns.append({"role": "user", "text": said, "at": len(texts)})
            elif kind == "assistant":
                for c in content or []:
                    if isinstance(c, dict) and c.get("type") == "text" and c.get("text", "").strip():
                        texts.append(c["text"])
                        turns.append({"role": "assistant", "text": c["text"], "at": len(texts) - 1})
    print(json.dumps({"file": f, "mtime": os.path.getmtime(f), "texts": texts, "turns": turns}))
    sys.exit(0)
print(json.dumps({"file": None}))
`;

// The review skill's drafts, as it renders them (both skills share the shape):
//   ### 1 · 185 znakova  (medijan 78–105 · p75 143–196)
//   `path:line` (a note)
//   ```markdown … ```
//   **Zašto:** …   **Ako ostane:** …
// then **Izbačeno:**. A later reply that re-renders a number replaces it.
function parseDrafts(texts) {
  const drafts = new Map();
  let intro = null, dropped = null, lastBlocks = -1;
  for (const [at, raw] of texts.entries()) {
    let text = raw;
    const cut = text.search(/^\*\*Izbačeno:?\*\*:?/m);
    if (cut >= 0) {
      dropped = text.slice(cut).replace(/^\*\*Izbačeno:?\*\*:?\s*/, "").replace(/\n\s*\n(?!\s*[-*] )[\s\S]*$/, "").trim();
      text = text.slice(0, cut);
    }
    const parts = text.split(/^### (?=\d+\s*·)/m);
    if (parts.length < 2) continue;
    lastBlocks = at;
    if (parts[0].trim()) intro = parts[0].trim();
    for (const part of parts.slice(1)) {
      const lines = part.split("\n");
      const n = parseInt(lines[0], 10);
      if (!n) continue;
      const count = Number(lines[0].match(/·\s*(\d+)\s*znak/)?.[1] ?? 0);
      let i = 1;
      while (i < lines.length && !lines[i].trim()) i++;
      const am = lines[i]?.match(/^\s*\x60([^\x60]+?)\x60\s*(.*)$/);
      let path = null, line = null, note = "";
      if (am) {
        // A note can sit inside the backticks too: `path:12 (outside the diff)`.
        const inner = am[1].match(/^(.*?)\s*\(([^)]*)\)\s*$/);
        const where = inner ? inner[1] : am[1];
        const lm = where.match(/^(.*?):(\d+)(?:[-–]\d+)?$/);
        path = lm ? lm[1] : where;
        line = lm ? Number(lm[2]) : null;
        note = (inner ? inner[2] : am[2].replace(/^\(|\)$/g, "")).trim();
      }
      const open = lines.findIndex((l, k) => k > i - 1 && /^\s*(\x60{3,})markdown\s*$/.test(l));
      if (open < 0) continue;
      const fence = lines[open].trim().match(/^\x60+/)[0];
      const whyAt = lines.findIndex((l, k) => k > open && /^\*\*[^*]+:\*\*/.test(l));
      let close = -1;
      for (let k = (whyAt < 0 ? lines.length : whyAt) - 1; k > open; k--) if (lines[k].trim() === fence) { close = k; break; }
      if (close < 0) continue;
      const body = lines.slice(open + 1, close).join("\n").trim();
      const rest = lines.slice(close + 1).join("\n");
      const field = (name) => rest.match(new RegExp("\\*\\*" + name + ":\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*[^*\\n]+:\\*\\*|$)"))?.[1]?.trim() ?? null;
      drafts.set(n, { n, count: count || body.replace(/\n/g, "").length, path, line, note, body, why: field("Zašto"), ifStays: field("Ako ostane"), shape: field("Oblik") });
    }
  }
  // What the agent said last, when it is not a fresh set of drafts: an answer to a question,
  // or the links of what it posted.
  const reply = texts.slice(lastBlocks + 1).at(-1)?.trim() || null;
  return { intro, dropped, reply, lastBlocks, list: [...drafts.values()].sort((a, b) => a.n - b.n) };
}

// Whitespace-blind, for spotting a draft that is already on GitHub.
const squash = (s) => (s ?? "").replace(/\s+/g, " ").trim();

// Diff rows are this tall; an open thread at most this tall (more scrolls inside it).
const ROW_H = 20;
const THREAD_MAX_H = 640;

const TAB = "    ";
// Template comments and hidden blocks say nothing to a reader.
const cleanBody = (body) => (body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").replace(/\n[ \t]*(\n[ \t]*)+\n/g, "\n\n").trim();
const hex = (r, g, b) => "#" + [r, g, b].map((n) => (n | 0).toString(16).padStart(2, "0")).join("");

// One colored line into [{ text, fg, emph }] without its +/-/space prefix.
// emph: a background other than the line's own, which is how delta marks changed words.
function spans(ansi) {
  const out = [];
  let fg = null, bg = null, base, last = 0, m;
  const push = (text) => {
    if (!text) return;
    const emph = bg !== null && base !== undefined && bg !== base;
    const prev = out.at(-1);
    if (prev && prev.fg === fg && prev.emph === emph) prev.text += text;
    else out.push({ text, fg, emph });
  };
  const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
  while ((m = re.exec(ansi))) {
    push(ansi.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== "m") continue;
    const p = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) { fg = null; bg = null; }
      else if (c === 39) fg = null;
      else if (c === 49) bg = null;
      else if ((c === 38 || c === 48) && p[i + 1] === 2) {
        const color = hex(p[i + 2], p[i + 3], p[i + 4]);
        if (c === 38) fg = color;
        else { bg = color; if (base === undefined) base = color; }
        i += 4;
      } else if ((c === 38 || c === 48) && p[i + 1] === 5) i += 2;
    }
  }
  push(ansi.slice(last));
  // Drop the prefix column.
  const first = out.find((s) => s.text.length);
  if (first) first.text = first.text.slice(1);
  for (const s of out) s.text = s.text.replace(/\t/g, TAB);
  return out.filter((s) => s.text.length);
}

// Numbers each line on both sides once, so a frame only draws the rows on screen.
function diffRows(lines, ansi = []) {
  let old = 0, next = 0;
  return lines.slice(0, MAX_LINES).map((raw, i) => {
    const long = raw.length > 4000;
    const line = (long ? raw.slice(0, 4000) + "…" : raw).replace(/\t/g, TAB);
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1) || " ", src = long ? undefined : ansi[i];
    if (kind === "-") return { kind, a: old++, text, src };
    if (kind === "+") return { kind, b: next++, text, src };
    return { kind: " ", a: old++, b: next++, text, src };
  });
}

// A file's diff in a few characters: a viewed mark holds while this stays the same.
function hashOf(lines) {
  let h = 5381;
  for (const l of lines) for (let i = 0; i < l.length; i++) h = ((h << 5) + h + l.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}:${lines.length}`;
}

// Checks as { name, state: ok | fail | pending | skip, url }, the latest run per name.
function checksOf(info) {
  const byName = new Map();
  for (const c of info?.statusCheckRollup ?? []) {
    const ctx = c.__typename === "StatusContext";
    const name = ctx ? c.context : c.name ?? c.workflowName ?? "check";
    const state = ctx
      ? c.state === "SUCCESS" ? "ok" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "fail"
      : c.status !== "COMPLETED" ? "pending"
      : c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" ? "ok"
      : c.conclusion === "SKIPPED" || c.conclusion === "CANCELLED" ? "skip" : "fail";
    byName.set(name, { name, state, url: ctx ? c.targetUrl : c.detailsUrl });
  }
  return [...byName.values()];
}

function ciOf(checks) {
  if (checks.some((c) => c.state === "fail")) return "fail";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return checks.some((c) => c.state === "ok") ? "ok" : null;
}

// The deepest folder every file shares, shown once above the tree.
function commonDir(paths) {
  if (!paths.length) return "";
  const split = paths.map((p) => p.split("/").slice(0, -1));
  const first = split[0];
  let n = 0;
  while (n < first.length && split.every((s) => s[n] === first[n])) n++;
  return first.slice(0, n).join("/");
}

// Stamped by review-prs when Herdr's focused pane changes: { pane, at }.
const FOCUS_KEY = "focus.moved";
const VIEWED_KEY = "pr-diff.viewed";
// Every file a Claude session changed, wherever it lives: the files its Edit/Write calls
// named, and in each git repo its shell commands pointed at (and its own folder) the
// uncommitted files touched since the session began. Out: one unified diff (each file under
// its repo's name; a file outside git from its edits), then \0, then delta's colors for it.
// $1 transcript, $2 session folder, $3 syntax theme, $4 where to write <$4>.diff and <$4>.color
// (a diff this big is too much for exec's output).
const CHANGES_SCRIPT = String.raw`
import json, os, re, subprocess, sys
tp, cwd, theme, dest = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
os.makedirs(os.path.dirname(dest), exist_ok=True)
home = os.path.expanduser("~")
start = os.stat(tp).st_birthtime
touched, dirs, edits, refs, cmds = set(), {cwd}, {}, set(), {}
for line in open(tp, errors="replace"):
    if '"tool_use"' not in line: continue
    try: r = json.loads(line)
    except Exception: continue
    c = (r.get("message") or {}).get("content")
    if not isinstance(c, list): continue
    for b in c:
        if not isinstance(b, dict) or b.get("type") != "tool_use": continue
        n, i = b.get("name"), b.get("input") or {}
        if n in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            f = i.get("file_path") or i.get("notebook_path")
            if f:
                f = os.path.realpath(os.path.expanduser(f)); touched.add(f); edits.setdefault(f, []).append((n, i))
        elif n == "Bash":
            for m in re.finditer(r"(?:~|/Users/[A-Za-z0-9._-]+)(?:/[^\s'\"\x60;|&()<>]*)?", str(i.get("command", ""))):
                q = os.path.expanduser(m.group(0).rstrip(".,:"))
                if os.path.isfile(q):
                    rq = os.path.realpath(q); refs.add(rq); cmds.setdefault(rq, []).append(str(i.get("command", "")))
                while q and not os.path.isdir(q): q = os.path.dirname(q)
                if q and q != home: dirs.add(q)
def top(d):
    while d and not os.path.isdir(d): d = os.path.dirname(d)
    if not d: return None
    r = subprocess.run(["git", "-C", d, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return os.path.realpath(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None
roots = {}
for d in list(dirs)[:80]:
    t = top(d)
    if t: roots.setdefault(t, set())
outside = []
for f in touched:
    t = top(os.path.dirname(f))
    if t: roots.setdefault(t, set()).add(f)
    else: outside.append(f)
def name(root):
    b = os.path.basename(root)
    same = [x for x in roots if os.path.basename(x) == b]
    return b if len(same) < 2 else os.path.basename(os.path.dirname(root)) + "-" + b
out, meta = [], {}
def stamp(display, real):
    try: m = os.path.getmtime(real)
    except OSError: m = 0
    meta[display] = {"real": real, "mtime": m}
for root in sorted(roots):
    st = subprocess.run(["git", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], capture_output=True, text=True).stdout
    parts = st.split("\0"); k = 0; files = []
    while k < len(parts):
        e = parts[k]; k += 1
        if len(e) < 4: continue
        code, rel = e[:2], e[3:]
        if code[0] in "RC": k += 1
        full = os.path.realpath(os.path.join(root, rel))
        mine = full in roots[root]
        if not mine and os.path.exists(full):
            try: mine = os.path.getmtime(full) >= start
            except OSError: mine = False
        if mine and not (code == "??" and os.path.islink(os.path.join(root, rel))): files.append((code, rel))
    nm = name(root)
    pre = ["--src-prefix=a/" + nm + "/", "--dst-prefix=b/" + nm + "/"]
    for code, rel in sorted(files, key=lambda x: x[1]):
        if code == "??":
            d = subprocess.run(["git", "-C", root, "diff", "--no-color", "--no-index"] + pre + ["/dev/null", rel], capture_output=True, text=True).stdout
        else:
            d = subprocess.run(["git", "-C", root, "diff", "--no-color", "HEAD"] + pre + ["--", rel], capture_output=True, text=True).stdout
        if d.strip():
            out.append(d.rstrip("\n")); stamp(nm + "/" + rel, os.path.join(root, rel))
for f in sorted(outside):
    shown = "~" + f[len(home):] if f.startswith(home) else f.lstrip("/")
    stamp(shown, f)
    lines = ["diff --git a/" + shown + " b/" + shown]
    if any(n == "Write" for n, _ in edits[f]) and os.path.exists(f):
        body = open(f, errors="replace").read().split("\n")
        if body and body[-1] == "": body = body[:-1]
        lines += ["new file mode 100644", "--- /dev/null", "+++ b/" + shown, "@@ -0,0 +1,%d @@" % len(body)] + ["+" + l for l in body]
    else:
        lines += ["--- a/" + shown, "+++ b/" + shown]
        for n, i in edits[f]:
            pairs = [(i.get("old_string", ""), i.get("new_string", ""))] if n == "Edit" else [(x.get("old_string", ""), x.get("new_string", "")) for x in i.get("edits", [])]
            for old, new in pairs:
                o, w = old.split("\n"), new.split("\n")
                lines.append("@@ -1,%d +1,%d @@" % (len(o), len(w)))
                lines += ["-" + l for l in o] + ["+" + l for l in w]
    out.append("\n".join(lines))
# Files outside git that a shell command named and that changed since the session began:
# there is no earlier version to compare with, so they are listed with a note.
for f in sorted(refs - touched):
    # State the apps write themselves, not the session's work.
    noise = ("/.claude/projects/", "/pr-images/", "/.claude/state/", "/.state/", "/.config/herdr-app/shared.json",
             "/.config/herdr-app/view.json", "/.config/herdr-app/window.json", "/.config/herdr-app/seen.json",
             "/.config/herdr-app/installed.json", "/.config/herdr-app/AGENTS.md")
    if top(os.path.dirname(f)) or any(x in f for x in noise): continue
    try:
        if os.path.getmtime(f) < start: continue
    except OSError: continue
    shown = "~" + f[len(home):] if f.startswith(home) else f.lstrip("/")
    stamp(shown, f)
    # No earlier version to compare with: the commands that touched it show what was done,
    # the latest few, each cut to its first lines.
    body = ["Outside git, changed by a command. The commands that touched it:"]
    writes = [c for c in cmds.get(f, []) if re.search(r"(?<![0-9&])>(?!&)|sed -i|\.write\(|json\.dump|\btee\b|\bmv\b|\bcp\b|\brm\b|\bln\b|open\([^)]*['\"]w", c)]
    for c in (writes or cmds.get(f, []))[-4:]:
        ls = c.split("\n")
        body += [""] + ["$ " + ls[0]] + ["  " + l for l in ls[1:40]] + (["  … %d more lines" % (len(ls) - 40)] if len(ls) > 40 else [])
    out.append("\n".join(["diff --git a/" + shown + " b/" + shown, "--- a/" + shown, "+++ b/" + shown, "@@ -1,%d +1,%d @@" % (len(body), len(body))]
        + [" " + l for l in body]))
plain = "\n".join(out) + ("\n" if out else "")
# Herdr reads a text file of at most 1 MiB: each output goes in parts under that, by line.
def parts(name, text):
    chunks, cur, size = [], [], 0
    for line in text.split("\n"):
        n = len(line.encode()) + 1
        if cur and size + n > 900000: chunks.append("\n".join(cur)); cur, size = [], 0
        cur.append(line); size += n
    chunks.append("\n".join(cur))
    for k, c in enumerate(chunks): open("%s.%s.%d" % (dest, name, k), "w").write(c)
    return len(chunks)
meta["_parts"] = {"diff": parts("diff", plain)}
col = ""
try:
    col = subprocess.run(["delta", "--color-only", "--true-color=always", "--paging=never", "--syntax-theme=" + theme,
        "--zero-style=syntax", "--minus-style=syntax #3f0001", "--minus-emph-style=syntax #901011",
        "--plus-style=syntax #002800", "--plus-emph-style=syntax #006000"], input=plain, capture_output=True, text=True).stdout
except Exception: pass
meta["_parts"]["color"] = parts("color", col)
open(dest + ".meta.json", "w").write(json.dumps(meta))
print(len(plain))
`;

const TABS = [["desc", "Description"], ["files", "Files"], ["comments", "Comments"], ["agent", "Claude"]];

const STATUS_COLOR = (t, s) => (s === "A" ? t.ansi2 : s === "D" ? t.ansi1 : s === "R" ? t.ansi4 : t.blocked);

export default class PrDiff extends View {
  init(_props, cx) {
    const p = props() ?? {};
    // Scroll positions belong to element ids; this copy's own keep tabs from sharing them.
    this.uid = Math.random().toString(36).slice(2, 10);
    this.repo = p.repo;
    this.number = p.number;
    // props.changes (or no PR at all, as the claude-changes overlay opens it): every file a
    // Claude session changed, from its transcript, in the Files tab alone.
    this.changes = p.changes ?? (!p.repo ? { terminal: p.terminal ?? null } : null);
    this.url = p.url ?? `https://github.com/${p.repo}/pull/${p.number}`;
    this.files = [];
    this.rows = [];
    // props.file: the file to show first, on the Files tab (else the Description tab).
    this.open = p.file ?? null;
    this.tab = this.changes ? "files" : p.tab ?? (p.file ? "files" : "desc");
    this.foldedDirs = new Set();
    this.view = p.view ?? (this.changes ? "split" : null);
    this.info = null;
    // Keys: pane.go (cmd-ctrl-h/j/k/l) lands here with "focus"; a click focuses too.
    this.handle = cx.focus_handle();
    // As an overlay (the session's changes) it takes the keyboard at once, so j/k work.
    if (p.overlay) { this.handle.focus(); cx.timer.after(150, () => this.handle.focus()); }
    // The diff's scroll position, so keys can move it; reset to the top per file.
    this.scroller = VirtualListScrollHandle.new();
    // The file tree's, so j/k keep the picked file in view.
    this.treeScroller = VirtualListScrollHandle.new();
    // The diff column's width (on_size_change), what lines wrap at.
    this.codeW = 0;
    // The rows the diff list drew in its latest frame (it only draws what's on screen).
    this.shown = { min: 0, max: 0 };
    // The review agent's drafts, read from its transcript; which ones are ticked to post.
    this.drafts = null;
    this.chosen = new Set();
    // With the ticked comments: "comment" only, "approve", or "changes" (request changes).
    this.reviewMode = "comment";
    // The draft j/k point at on the Claude tab, and the one being changed (e).
    this.cardSel = 0;
    this.editing = null;
    this.drHeights = {};
    // Typing in one of the Claude tab's fields: the pane's keys stand aside until esc.
    this.typing = false;
    const field = (placeholder, onSubmit) => {
      const f = InputState.new({ placeholder });
      f.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      f.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
      f.on("submit", (_e, cx) => { onSubmit(cx); cx.notify(); });
      f.on("change", (_e, cx) => cx.notify());
      return f;
    };
    this.askInput = field("Ask Claude, or tell it what to look at…", () => this.ask());
    this.editInput = field("What should change in this comment?", () => this.sendEdit());
    this.bodyInput = field("Tekst reviewa (obavezan za Request changes)", () => this.askPost());
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        if (c === "post") this.postChosen();
        cx.notify();
      }
    });
    this.load(cx);
    this.loadDrafts(cx);
    // While an agent is on this PR its drafts can change; a cheap re-read when its file did.
    cx.timer.every(4000, (cx) => { if (this.reviewAgent() || this.tab === "agent") this.loadDrafts(cx); });
  }

  loadDrafts(cx) {
    if (this.draftsLoading || this.changes) return;
    const { dir } = REVIEWERS[this.repo] ?? REVIEWERS.default;
    const folder = `${home()}/.claude/projects/${dir.replace(/^~/, home()).replace(/[\/.]/g, "-")}`;
    this.draftsLoading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", "-c", TRANSCRIPT, folder, this.url, this.draftsFile ?? ""]);
        const got = r.code === 0 ? JSON.parse(r.stdout || "{}") : {};
        if (got.file && (got.file !== this.draftsFile || got.mtime !== this.draftsMtime)) {
          this.draftsFile = got.file;
          this.draftsMtime = got.mtime;
          this.drafts = parseDrafts(got.texts ?? []);
          // The conversation since the drafts: what was asked, what Claude answered.
          const last = this.drafts.lastBlocks;
          this.drafts.talk = (got.turns ?? []).filter((x) => (x.role === "user" ? x.at > last : x.at > last)).slice(-12);
          for (const n of [...this.chosen]) if (!this.drafts.list.some((d) => d.n === n)) this.chosen.delete(n);
        }
      } catch (e) {
        this.draftsError = String(e?.message ?? e);
      }
      this.draftsLoading = false;
      cx.notify();
    });
  }

  // A draft already on the PR: an inline thread or a conversation comment with its text.
  posted(d) {
    const want = squash(d.body);
    if (!want) return null;
    for (const th of this.threads ?? []) for (const c of th.comments) if (squash(c.body) === want) return c.url ?? true;
    for (const c of this.conversation ?? []) if (squash(c.body) === want) return c.url ?? true;
    return null;
  }

  // What the agent is told to do: the ticked comments as the skill expects ("komentiraj 1 i 3"),
  // then the review itself when it is more than comments. Null when there is nothing to send.
  postMessage(nums, mode, body) {
    const list = nums.length === 1 ? `${nums[0]}` : `${nums.slice(0, -1).join(", ")} i ${nums.at(-1)}`;
    const text = body.trim().replace(/"/g, "'");
    const comments = nums.length ? `komentiraj ${list}` : null;
    if (mode === "comment") return comments;
    if (mode === "approve") {
      const review = `approvaj PR (gh pr review --approve${text ? ` s točno ovim tekstom: "${text}"` : ", bez teksta"})`;
      return comments ? `${comments}, then ${review}` : `No inline comments: ${review}`;
    }
    if (!text) return null;
    const review = `post a Request changes review (gh pr review --request-changes) with exactly this text: "${text}"`;
    return comments ? `${comments}, then ${review}` : `No inline comments: ${review}`;
  }

  // Asks first, saying exactly what Claude will be told; the confirm dialog runs "pr-diff.post".
  askPost() {
    const nums = [...this.chosen].sort((a, b) => a - b);
    const a = this.reviewAgent();
    const mode = this.reviewMode;
    const body = this.bodyInput.value();
    const message = this.postMessage(nums, mode, body);
    if (!a || !message) return;
    setShared(POST_KEY, { repo: this.repo, number: this.number, nums, mode, body, at: Date.now() });
    const what = { comment: "Post the comments on", approve: nums.length ? "Post the comments and approve" : "Approve", changes: nums.length ? "Post the comments and request changes on" : "Request changes on" }[mode];
    openOverlay({
      mod: "confirm",
      kind: "dialog",
      width: 480,
      height: 230,
      props: {
        title: `${what} PR #${this.number}?`,
        detail: `Sent to Claude:\n"${message}"\n\nPosts under your name. A post can only be taken back by deleting it on GitHub.`,
        command: { name: "pr-diff.post" },
      },
    });
  }

  postChosen() {
    const req = shared(POST_KEY);
    if (!req || req.repo !== this.repo || req.number !== this.number || Date.now() - req.at > 120000) return;
    setShared(POST_KEY, null);
    const message = this.postMessage(req.nums, req.mode ?? "comment", req.body ?? "");
    if (!message) return;
    this.sendToAgent(message, () => { this.chosen.clear(); this.bodyInput.set_value(""); });
  }

  // Types into the review agent's pane and presses enter, as if typed there.
  sendToAgent(text, done) {
    const a = this.reviewAgent();
    if (!a || !text.trim()) return;
    hc(["send", a.address, text]).then((r) => {
      this.sendError = r.code === 0 ? null : (r.stderr || r.stdout).trim();
      if (r.code === 0) done?.();
    }).catch((e) => { this.sendError = String(e); });
  }

  // A question or an instruction about the review as a whole.
  ask() {
    const text = this.askInput.value().trim();
    if (!text) return;
    this.sendToAgent(text, () => this.askInput.set_value(""));
    this.handle.focus();
  }

  // A change to one draft; the agent renders it again under its number, and the card follows.
  sendEdit() {
    const text = this.editInput.value().trim();
    const n = this.editing;
    if (!text || n == null) return;
    this.sendToAgent(`For comment ${n}: ${text}. Redo it in the same shape under number ${n}; leave the others alone.`, () => {
      this.editInput.set_value("");
      this.editing = null;
    });
    this.handle.focus();
  }

  startEdit(n) {
    this.editing = n;
    this.editInput.set_value("");
    this.editInput.focus();
  }

  // Keeps the chosen draft in view on the Claude tab.
  revealCard(cx) {
    const list = this.drafts?.list ?? [];
    const st = this.page("agent");
    if (!list.length || !st.view) return;
    let top = this.drAbove ?? 0;
    for (let i = 0; i < this.cardSel; i++) top += this.drHeights[list[i].n] ?? 0;
    const h = this.drHeights[list[this.cardSel]?.n] ?? 0;
    const pad = 16, from = st.off;
    let to = from;
    if (top - pad < from) to = top - pad;
    else if (top + h + pad > from + st.view) to = Math.min(top - pad, top + h + pad - st.view);
    to = Math.max(0, Math.min(Math.max(0, st.full - st.view), to));
    if (Math.abs(to - from) >= 1) this.animate(cx, (frac) => { st.off = from + (to - from) * frac; });
  }

  // The Claude tab's keys: j/k draft, space tick, c/a/x what goes with them, enter post,
  // e change this draft, i ask Claude. True when the key was one of them.
  agentKey(key, cx) {
    const list = this.drafts?.list ?? [];
    const d = list[this.cardSel];
    const open = list.filter((x) => !this.posted(x));
    const tick = () => { if (d && !this.posted(d)) this.chosen.has(d.n) ? this.chosen.delete(d.n) : this.chosen.add(d.n); };
    const modes = ["comment", "approve", "changes"];
    const table = {
      j: () => { this.cardSel = Math.min(list.length - 1, this.cardSel + 1); this.revealCard(cx); },
      k: () => { this.cardSel = Math.max(0, this.cardSel - 1); this.revealCard(cx); },
      // GPUI names it "space"; its character is " ".
      space: tick,
      " ": tick,
      // T: every draft not posted yet, or none when they all are ticked already.
      T: () => {
        const all = open.length > 0 && open.every((x) => this.chosen.has(x.n));
        this.chosen = all ? new Set() : new Set(open.map((x) => x.n));
      },
      c: () => { this.reviewMode = "comment"; },
      a: () => { this.reviewMode = "approve"; },
      x: () => { this.reviewMode = "changes"; this.bodyInput.focus(); },
      m: () => { this.reviewMode = modes[(modes.indexOf(this.reviewMode) + 1) % modes.length]; },
      b: () => { if (this.reviewMode === "comment") this.reviewMode = "approve"; this.bodyInput.focus(); },
      enter: () => this.askPost(),
      e: () => d && this.startEdit(d.n),
      i: () => this.askInput.focus(),
    };
    const act = table[key];
    if (!act) return false;
    act();
    return true;
  }

  // From a draft's anchor to that line in the diff, in the middle of the view.
  goToDraft(d) {
    if (!d.path || !this.files.some((f) => f.path === d.path)) return;
    this.tab = "files";
    this.pick(d.path);
    if (d.line == null) return;
    const items = (this.splitHere ? this.splitItems : this.unifiedItems) ?? [];
    const i = items.findIndex((it) => it.type === "row" && (this.splitHere ? it.r.r?.b === d.line : it.r.kind !== "-" && it.r.b === d.line));
    if (i >= 0) this.scroller.scroll_to_item(i, "center");
  }

  // Half a screen down or up: bring the row half a screen past the bottom (or
  // above the top) into view; the list scrolls just far enough to show it.
  halfPage(dir, cx) {
    const items = (this.splitHere ? this.splitItems : this.unifiedItems) ?? [];
    if (!items.length) return;
    const sizes = this.sizes ?? [];
    const { min, max } = this.shown;
    let screen = 0;
    for (let i = min; i <= max; i++) screen += sizes[i] ?? ROW_H;
    const half = screen / 2;
    // Down: the row half a screen below the bottom comes into view at the bottom.
    // Up: the row half a screen above the top comes into view at the top.
    let i = dir > 0 ? max : min, moved = 0;
    const path = [];
    while (moved < half && (dir > 0 ? i < items.length - 1 : i > 0)) { i += dir; moved += sizes[i] ?? ROW_H; path.push([i, moved]); }
    if (!path.length) return;
    // Smooth: a few frames, each bringing a row a little further along into view.
    this.animate(cx, (frac) => {
      const want = frac * moved;
      this.jump((path.find(([, m]) => m >= want) ?? path[path.length - 1])[0]);
    });
  }

  // Runs step(0..1, eased) over ~140ms of frames; a new animation cancels the running one.
  animate(cx, step) {
    const id = (this.anim = (this.anim ?? 0) + 1);
    const FRAMES = 9;
    for (let k = 1; k <= FRAMES; k++) {
      cx.timer.after(k * 16, (cx) => {
        if (this.anim !== id) return;
        const x = k / FRAMES;
        step(1 - Math.pow(1 - x, 3));
        cx.notify();
      });
    }
  }

  // A tab by id; Files opens on its first file when none is picked yet.
  setTab(id) {
    this.tab = id;
    if (id === "files" && !this.open) this.pick(this.fileOrder()[0] ?? null);
  }

  // scroll_to_item brings the row to the nearer edge of the view.
  jump(index, strategy = "top") {
    if (index === "bottom") this.scroller.scroll_to_bottom();
    else this.scroller.scroll_to_item(index, strategy);
  }

  // h/l or 1/2/3 tabs; on Files: j/k file, v viewed (then the next unviewed),
  // ctrl-d/ctrl-u half a screen, gg/G top/bottom; s unified/split, o GitHub,
  // r review agent, R reload. Other chords pass through to the app.
  onKey(e, cx) {
    const m = e.modifiers ?? {};
    // In a field: its keys are its own; esc gives them back to the pane.
    if (this.typing) {
      if (e.key === "escape") { cx.stop_propagation(); this.editing = null; this.handle.focus(); cx.notify(); }
      return;
    }
    const onFiles = this.tab === "files" && this.open;
    const paged = this.tab === "desc" || this.tab === "comments" || this.tab === "agent";
    const plain = !m.platform && !m.control && !m.alt;
    // d/u or ctrl-d/ctrl-u: half a screen, on the diff and on the Description and Comments pages.
    if ((plain || (m.control && !m.platform && !m.alt)) && (e.key === "d" || e.key === "u") && (onFiles || paged)) {
      cx.stop_propagation();
      if (onFiles) this.halfPage(e.key === "d" ? 1 : -1, cx);
      else {
        const key = this.tab, st = this.page(key), from = st.off;
        const to = Math.max(0, Math.min(Math.max(0, st.full - st.view), from + (e.key === "d" ? 1 : -1) * Math.max(80, st.view / 2)));
        this.animate(cx, (frac) => { st.off = from + (to - from) * frac; });
      }
      cx.notify();
      return;
    }
    if (!plain) return;
    if (this.tab === "agent" && this.agentKey(e.key === "enter" || e.key === "space" ? e.key : (e.key_char ?? e.key), cx)) {
      cx.stop_propagation();
      cx.notify();
      return;
    }
    // enter on Files: like v, mark the file viewed and go to the next unviewed one.
    if (e.key === "enter" && onFiles) {
      cx.stop_propagation();
      this.markViewed(this.open, true);
      cx.notify();
      return;
    }
    const key = e.key_char ?? e.key;
    // On Description and Comments: j/k a few lines, gg/G top and bottom.
    if (paged && (key === "j" || key === "k" || key === "G" || key === "g")) {
      cx.stop_propagation();
      if (key === "g") {
        if (Date.now() - (this.lastG ?? 0) < 1000) { this.scrollPage(this.tab, "top"); this.lastG = 0; }
        else this.lastG = Date.now();
      } else this.scrollPage(this.tab, key === "G" ? "bottom" : key === "j" ? 60 : -60);
      cx.notify();
      return;
    }
    // gg: top (two g within a second); G: bottom.
    if (key === "g" && onFiles) {
      cx.stop_propagation();
      if (Date.now() - (this.lastG ?? 0) < 1000) { this.jump(0); this.lastG = 0; }
      else this.lastG = Date.now();
      cx.notify();
      return;
    }
    if (key === "G" && onFiles) {
      cx.stop_propagation();
      this.jump("bottom");
      cx.notify();
      return;
    }
    const order = this.fileOrder();
    const at = order.indexOf(this.open);
    // j/k walk the files on the Files tab only; elsewhere they do nothing.
    const step = (d) => {
      if (this.tab !== "files") return;
      const next = order[Math.max(0, Math.min(order.length - 1, (at < 0 ? 0 : at + d)))];
      if (next) this.pick(next);
    };
    // The session's changes: its own keys, and none of a PR's (tabs, review, GitHub).
    if (this.changes) {
      const mine = {
        t: () => { this.byTime = !this.byTime; },
        b: () => { this.showHidden = !this.showHidden; this.applyHidden(); },
        o: () => this.openInZed(this.open),
      }[key];
      if (mine) { cx.stop_propagation(); mine(); cx.notify(); return; }
      if (["1", "2", "3", "4", "h", "l", "r"].includes(key)) return;
    }
    const ids = TABS.map(([id]) => id);
    const near = (d) => this.setTab(ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(this.tab) + d))]);
    const act = {
      1: () => this.setTab("desc"),
      2: () => this.setTab("files"),
      3: () => this.setTab("comments"),
      4: () => this.setTab("agent"),
      h: () => near(-1),
      l: () => near(1),
      j: () => step(1),
      k: () => step(-1),
      v: () => { if (onFiles) this.markViewed(this.open, true); },
      z: () => {
        // zz: the open file to the middle of the file tree.
        if (!onFiles) return;
        if (Date.now() - (this.lastZ ?? 0) < 1000) {
          this.lastZ = 0;
          const ti = this.treeItems().findIndex((it) => it.key === `f:${this.open}`);
          if (ti >= 0) this.treeScroller.scroll_to_item(ti, "center");
        } else this.lastZ = Date.now();
      },
      s: () => this.setView(!this.split, cx),
      o: () => exec("open", [this.url]).catch(() => {}),
      r: () => { const a = this.reviewAgent(); a ? swapZoom(a.tab) : this.startReview(); },
      R: () => this.load(cx),
    }[key];
    if (!act) return;
    cx.stop_propagation();
    act();
    cx.notify();
  }

  // Backups (.bak) and scratch files are left out unless asked for (b).
  isHiddenChange(path) {
    return /\.bak[\w.-]*$/.test(path) || path.startsWith("private/tmp/") || path.includes("/scratchpad/");
  }

  applyHidden() {
    const all = this.allFiles ?? [];
    this.hiddenCount = all.filter((f) => this.isHiddenChange(f.path)).length;
    this.files = this.showHidden ? all : all.filter((f) => !this.isHiddenChange(f.path));
  }

  // A group's name in the session's changes: scratch and Claude's memory by what they are.
  groupLabel(dir) {
    if (dir.startsWith("private/tmp/")) return "scratchpad";
    if (/\/\.claude\/projects\/.*\/memory$/.test(dir)) return "Claude memory";
    return dir || "(root)";
  }

  // The file on disk behind a changed path, opened in Zed.
  openInZed(path) {
    const real = this.meta?.[path]?.real;
    if (real) exec("zed", [real]).catch(() => {});
  }

  // Where viewed marks are kept: per PR, or per Claude session for its changes.
  viewKey() {
    return this.changes ? `changes:${this.changes.session ?? ""}` : `${this.repo}#${this.number}`;
  }

  // The session's changes: its terminal (given, else the focused Claude one), the transcript
  // Claude keeps for it, then CHANGES_SCRIPT over it.
  loadChanges(cx) {
    this.loading = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let term = this.changes.terminal;
        if (!term) {
          const f = focused();
          const here = panes().filter((q) => q.tab === f?.tab);
          term = (here.find((q) => q.pane === f?.pane && q.app === "claude-code") ?? here.find((q) => q.app === "claude-code"))?.terminal
            ?? agents()[0]?.address ?? null;
          this.changes.terminal = term;
        }
       
        const got = await hc(["get", term ?? "", "--json"]);
        const pid = got.code === 0 ? JSON.parse(got.stdout)?.foreground?.pid : null;
        const session = pid ? JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`)) ?? "null") : null;
        if (!session?.sessionId) throw new Error("No Claude session found for this terminal.");
        this.changes.cwd = session.cwd;
        this.changes.title = panes().find((q) => q.terminal === term)?.title?.replace(/^[^\p{L}\p{N}]+\s*/u, "") ?? "Claude";
        const file = `${home()}/.claude/projects/${session.cwd.replace(/[^A-Za-z0-9]/g, "-")}/${session.sessionId}.jsonl`;
        const syntax = settings().dark === false ? "OneHalfLight" : "OneHalfDark";
        const dest = `${home()}/.claude/state/changes/${term}`;
        const r = await exec("python3", ["-I", "-c", CHANGES_SCRIPT, file, session.cwd, syntax, dest]);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "Reading the changes failed.");
        this.meta = JSON.parse((await readTextFile(`${dest}.meta.json`)) ?? "{}");
        // The outputs come in parts under Herdr's 1 MiB read limit, joined back by line.
        const joined = async (name) => {
          const out = [];
          for (let k = 0; k < (this.meta._parts?.[name] ?? 0); k++) out.push((await readTextFile(`${dest}.${name}.${k}`)) ?? "");
          return out.join("\n");
        };
        const plain = await joined("diff");
        const colored = (await joined("color")).split("\n");
        this.changes.session = session.sessionId;
        this.allFiles = plain.trim() ? parse(plain, colored) : [];
        for (const f of this.allFiles) f.hash = hashOf(f.lines);
        this.applyHidden();
        this.threads = [];
        this.conversation = [];
        this.checks = [];
        const keep = this.files.find((f) => f.path === this.open);
        this.pick(keep ? keep.path : this.fileOrder()[0] ?? null);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  load(cx) {
    if (this.loading) return;
    if (this.changes) return this.loadChanges(cx);
    if (!this.repo || !this.number) { this.error = "No PR given (props: repo, number)."; return; }
    this.loading = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const syntax = settings().dark === false ? "OneHalfLight" : "OneHalfDark";
        const [owner, name] = this.repo.split("/");
        const [view, diff, threads] = await Promise.all([
          exec("gh", ["pr", "view", String(this.number), "--repo", this.repo, "--json", "title,author,headRefName,baseRefName,isDraft,state,body,reviews,comments,statusCheckRollup,latestReviews,reviewRequests,createdAt,updatedAt"]),
          exec("zsh", ["-c", DIFF_SCRIPT, "pr-diff", String(this.number), this.repo, syntax]),
          exec("gh", ["api", "graphql", "-F", `n=${this.number}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-f", `query=${THREADS_QUERY}`]),
        ]);
        if (view.code === 0) this.info = JSON.parse(view.stdout);
        this.conversation = conversationOf(this.info);
        // Bots and minimized comments start folded.
        this.convFolded ??= new Set(this.conversation.filter((c) => c.bot || c.minimized).map((c) => c.id));
        try {
          this.threads = threads.code === 0 ? parseThreads(threads.stdout) : [];
        } catch {
          this.threads = [];
        }
        // Open threads start expanded; resolved and outdated ones folded. A reload keeps your choices.
        // props.threads "expanded": every thread starts open.
        this.expanded ??= new Set(this.threads.filter((th) => props()?.threads === "expanded" || (!th.resolved && !th.outdated)).map((th) => th.id));
        if (diff.code !== 0) throw new Error(diff.stderr.trim() || `gh exited ${diff.code}`);
        const cut = diff.stdout.indexOf("\0");
        const plain = cut < 0 ? diff.stdout : diff.stdout.slice(0, cut);
        const colored = cut < 0 ? [] : diff.stdout.slice(cut + 1).split("\n");
        this.files = parse(plain, colored);
        for (const f of this.files) f.hash = hashOf(f.lines);
        this.checks = checksOf(this.info);
        const keep = this.files.find((f) => f.path === this.open);
        this.pick(keep ? keep.path : this.fileOrder()[0] ?? null);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
      this.loadImages(cx);
    });
  }

  // Downloads every image the PR's texts show, after the text is up.
  loadImages(cx) {
    const texts = [this.info?.body, ...(this.conversation ?? []).map((c) => c.body), ...(this.threads ?? []).flatMap((th) => th.comments.map((c) => c.body))];
    if (!texts.some((s) => /!\[|<img\b|user-attachments/i.test(s ?? ""))) { this.images = new Map(); return; }
    this.imagesLoading = true;
    const [owner, name] = this.repo.split("/");
    cx.spawn(async (cx) => {
      const images = new Map();
      try {
        const r = await exec("zsh", ["-c", IMAGES_SCRIPT, "pr-images", String(this.number), owner, name, IMAGES_QUERY, IMAGES_JQ]);
        for (const line of r.stdout.split("\n")) {
          const [key, path, w, h] = line.split("\t");
          if (key && path) images.set(key, { path, w: Number(w) || 800, h: Number(h) || 450 });
        }
      } catch {}
      this.images = images;
      this.imagesLoading = false;
      cx.notify();
    });
  }

  // Text with its images, tables and videos. live: handlers allowed (not inside the diff list).
  richBody(text, key, t, maxW = 860, live = true) {
    return v_flex().w_full().children(bodyParts(text).map((p, i) =>
      p.table ? this.tablePart(p.table, `${key}-${i}`, t, maxW, live)
      : p.video ? this.videoPart(p.video, `${key}-${i}`, t, live, maxW)
      : p.image !== undefined ? this.imagePart(p, `${key}-${i}`, t, maxW, 560, live)
      : live
        ? TextView.markdown(`md-${key}-${i}`, p.text).selectable(true).on_link_click((url) => exec("open", [url]).catch(() => {}))
        : TextView.markdown(`md-${key}-${i}`, p.text).selectable(true)));
  }

  // An image part: the downloaded file at a size that fits, else its alt text as a link.
  imagePart(p, key, t, maxW = 860, maxH = 560, live = true) {
    const img = this.images?.get?.(imageKey(p.url));
    const caption = p.alt ? div().text_size(11.5).text_color(t.dim).child(p.alt) : null;
    const opens = (el) => live ? el.cursor_pointer().on_click(() => exec("open", [p.url]).catch(() => {})) : el;
    if (!img) {
      return opens(h_flex().id(`pr-img-${key}`).my(6).gap(6).items_center().text_size(12).text_color(t.dim))
        .child(this.imagesLoading ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.dim).spin(900) : div().child("↗"))
        .child(div().child(`${this.imagesLoading ? "Loading image" : "Image"}${p.alt ? `: ${p.alt}` : ""}`));
    }
    const scale = Math.min(1, maxW / img.w, maxH / img.h);
    return v_flex().id(`pr-img-${key}`).my(8).gap(4).items_start()
      .child(opens(image(img.path).w(Math.round(img.w * scale)).h(Math.round(img.h * scale)).rounded(6).border_1().border_color(t.border)))
      .when(Boolean(caption), (e) => e.child(caption));
  }

  // Inline parts inside a table cell: images sized to the column, text as markdown.
  cellParts(parts, key, t, width, head, live = true) {
    return parts.map((p, i) => p.image !== undefined
      ? this.imagePart(p, `${key}-${i}`, t, width, 760, live)
      : head
        ? div().font_semibold().text_size(12.5).child(p.text.replace(/[*_`]/g, "").trim())
        : live
          ? TextView.markdown(`pr-md-${key}-${i}`, p.text).selectable(true).on_link_click((url) => exec("open", [url]).catch(() => {}))
          : TextView.markdown(`pr-md-${key}-${i}`, p.text).selectable(true));
  }

  // A table holding images, as a grid like GitHub draws it.
  tablePart(table, key, t, maxW = 860, live = true) {
    const cols = Math.max(table.header.length, ...table.rows.map((r) => r.length));
    const colW = Math.floor(maxW / cols);
    const row = (cellsOf, r, head) => h_flex().items_stretch()
      .when(!head || table.rows.length > 0, (e) => e.border_b(1).border_color(t.border))
      .when(head, (e) => e.bg(t.raised))
      .children(Array.from({ length: cols }, (_, c) => v_flex().id(`pr-tc-${key}-${r}-${c}`).w(colW).flex_none().px(8).py(head ? 6 : 4)
        .when(head, (e) => e.items_center())
        .when(c < cols - 1, (e) => e.border_r(1).border_color(t.border))
        .children(this.cellParts(cellsOf[c] ?? [], `${key}-${r}-${c}`, t, colW - 16, head, live))));
    const rows = table.rows.map((cs, r) => row(cs, r + 1, false));
    if (rows.length) rows[rows.length - 1] = rows[rows.length - 1].border_b(0);
    return v_flex().id(`pr-table-${key}`).my(8).w(colW * cols + 2).border_1().border_color(t.border).rounded(6).overflow_hidden()
      .child(row(table.header, 0, true))
      .children(rows);
  }

  // A bare attachment link on its own line: an image when one was downloaded under
  // it, else a video GitHub would play inline, here a link that opens it there.
  videoPart(url, key, t, live = true, maxW = 860) {
    if (this.images?.get?.(imageKey(url))) return this.imagePart({ url, alt: "" }, key, t, maxW, 560, live);
    const el = h_flex().id(`pr-video-${key}`).my(6).px(10).h(30).gap(8).items_center().self_start()
      .rounded(6).border_1().border_color(t.border).text_size(12.5).text_color(t.muted)
      .child(div().child("▶"))
      .child(div().child(live ? "Video (opens on GitHub)" : "Video (right-click the thread to open on GitHub)"));
    return live ? el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => exec("open", [url]).catch(() => {})) : el;
  }

  pick(path) {
    this.open = path;
    // A half page still easing on the last file would scroll this one.
    this.anim = (this.anim ?? 0) + 1;
    this.scroller?.scroll_to_item(0, "top");
    // Again once its list is drawn: the call above can land on the old one.
    this.toTop = true;
    const f = this.files.find((x) => x.path === path);
    if (f) this.foldedDirs.delete(this.dirOf(f.path));
    this.rows = !f || f.binary ? [] : diffRows(f.lines, f.ansi);
    this.pairs = splitRows(this.rows);
    this.unifiedItems = this.withThreads(this.rows, false);
    this.splitItems = this.withThreads(this.pairs, true);
    // Keep the picked file's row in view in the tree.
    const ti = this.treeItems().findIndex((it) => it.key === `f:${path}`);
    if (ti >= 0) this.treeScroller.scroll_to_item(ti);
  }

  // How many characters of code fit on one line of the shown view.
  cols() {
    if (!this.codeW) return 0;
    const w = this.codeW - 14;
    return Math.max(20, Math.floor((this.splitHere ? (w - 1) / 2 - GUTTER_S : w - GUTTER_U) / CH));
  }

  // A row's code as wrapped lines of styled segments, cached per width.
  wrapped(r, n) {
    if (r._wn !== n) {
      if (r.src && !r.spans) r.spans = spans(r.src);
      r._w = wrapSegs(r.spans?.length ? r.spans : [{ text: r.text }], n);
      r._wn = n;
    }
    return r._w;
  }

  // How many lines a row wraps to: its cached wrap, else counted from its plain text, so a
  // big file's rows are not all colored in one frame (QuickJS cuts a frame that runs long).
  lines(r, n) {
    if (r._wn === n) return r._w.length;
    if (!(n > 0)) return 1;
    return Math.max(1, Math.ceil((r.text ?? "").replace(/\t/g, "  ").length / n));
  }

  rowHeight(item, n) {
    if (item.type === "thread") return this.threadHeight(item.th);
    const r = item.r;
    if (r.kind === "@") return ROW_H;
    if (r.kind === "pair") return ROW_H * Math.max(r.l ? this.lines(r.l, n) : 1, r.r ? this.lines(r.r, n) : 1);
    return ROW_H * this.lines(r, n);
  }

  // Diff rows (or split pairs) with this file's threads after the line each is on.
  // A thread whose line isn't in the diff any more (outdated) goes at the top.
  withThreads(src, split) {
    const mine = (this.threads ?? []).filter((th) => th.path === this.open);
    const on = (r, th) => split
      ? r.kind === "pair" && (th.side === "LEFT" ? r.l?.a === th.line : r.r?.b === th.line)
      : r.kind !== "@" && (th.side === "LEFT" ? r.kind !== "+" && r.a === th.line : r.kind !== "-" && r.b === th.line);
    const placed = new Set(), body = [];
    src.forEach((r, i) => {
      body.push({ type: "row", r, key: `r${i}` });
      for (const th of mine) {
        if (th.line == null || placed.has(th) || !on(r, th)) continue;
        placed.add(th);
        body.push({ type: "thread", th, key: `th:${th.id}` });
      }
    });
    const top = mine.filter((th) => !placed.has(th)).map((th) => ({ type: "thread", th, key: `th:${th.id}`, loose: true }));
    return [...top, ...body];
  }

  // A review thread under its line: folded to one line, or every comment in full.
  threadItem(item, t, height) {
    const th = item.th, first = th.comments[0], open = this.expanded?.has(th.id);
    const state = th.resolved ? "Resolved" : th.outdated ? "Outdated" : "Open";
    const tone = th.resolved || th.outdated ? t.dim : t.blocked;
    const head = h_flex().gap(8).items_center().text_size(11.5)
      .child(div().flex_none().px(6).h(18).rounded(4).flex().items_center().text_size(10.5).font_semibold().bg(alpha(tone, "26")).text_color(tone).child(state))
      .when(Boolean(item.loose), (e) => e.child(div().flex_none().text_color(t.dim).child(`line ${th.line ?? th.originalLine ?? "?"} (no longer in the diff)`)))
      .child(div().flex_none().font_semibold().child(first.author))
      .child(div().flex_none().text_color(t.dim).child(`${th.comments.length > 1 ? `${th.comments.length} comments · ` : ""}${ago(th.comments.at(-1).at)}`))
      .when(!open, (e) => e.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(first.body.split("\n")[0])))
      .when(open, (e) => e.child(div().flex_1()))
      .child(div().flex_none().text_color(t.dim).child(open ? "▾" : "▸"));
    const comment = (c, i) => v_flex().gap(4).pt(i ? 8 : 0).when(i > 0, (e) => e.border_t(1).border_color(t.border))
      .when(i > 0, (e) => e.child(h_flex().gap(8).text_size(11.5)
        .child(div().font_semibold().child(c.author))
        .child(div().text_color(t.dim).child(ago(c.at)))))
      .child(this.richBody(c.body, `th-${th.id}-${i}`, t, 780, false));
    return div().w_full().h(height).py(6).pl(110).pr(16)
      .child(v_flex().id(`th-box-${th.id}`).max_w(820).max_h(height - 12).p(10).gap(8).rounded(8).border_1().border_color(open && !th.resolved && !th.outdated ? t.accent : t.border)
        .bg(cardBg(t)).font_family("Geist").text_size(12.5).cursor_pointer().overflow_y_scrollbar()
        .child(head)
        .when(open, (e) => e.children(th.comments.map(comment))));
  }

  // A thread's height in the diff list: folded it is one line; open, an estimate
  // of its comments (text wrapped at the box width, code, images at their drawn
  // size), capped so a long one scrolls inside its box.
  threadHeight(th) {
    const chrome = 12 + 2 + 20 + 18;
    if (!this.expanded?.has(th.id)) return chrome;
    const width = 760, perLine = Math.floor(width / 6.6);
    const textH = (text) => {
      let h = 0, code = false;
      for (const line of text.split("\n")) {
        if (/^\s*```/.test(line)) { code = !code; h += 10; continue; }
        if (code) { h += 18; continue; }
        if (!line.trim()) { h += 10; continue; }
        h += Math.max(1, Math.ceil(line.length / perLine)) * 20 + (/^#{1,6}\s/.test(line) ? 10 : 0);
      }
      return h;
    };
    const imgH = (p, maxW, maxH) => {
      const img = this.images?.get?.(imageKey(p.url));
      if (!img) return 30;
      return Math.round(img.h * Math.min(1, maxW / img.w, maxH / img.h)) + 16 + (p.alt ? 20 : 0);
    };
    let h = chrome;
    th.comments.forEach((c, i) => {
      h += 8 + (i ? 30 : 0);
      for (const p of bodyParts(c.body)) {
        if (p.text !== undefined) h += textH(p.text);
        else if (p.video) h += this.images?.get?.(imageKey(p.video)) ? imgH({ url: p.video }, width, 560) : 42;
        else if (p.image !== undefined) h += imgH(p, width, 560);
        else if (p.table) {
          const cols = Math.max(p.table.header.length, ...p.table.rows.map((r) => r.length));
          h += 40 + p.table.rows.reduce((n, r) => n + Math.max(30, ...r.map((cell) => cell.reduce((m, x) => m + (x.image !== undefined ? imgH(x, width / cols - 16, 760) : textH(x.text)), 0))), 0);
        }
      }
    });
    return Math.min(Math.round(h), THREAD_MAX_H);
  }

  // One review or conversation comment; a click on its header folds it.
  convItem(c, t) {
    const text = cleanBody(c.body);
    const folded = this.convFolded?.has(c.id);
    const [label, tone] = c.kind === "review" ? REVIEW_STATE[c.state] ?? [c.state, "dim"] : [c.minimized ? "Hidden" : "Commented", "dim"];
    const color = t[tone] ?? t.dim;
    const head = h_flex().id(`cv-h-${c.id}`).gap(8).items_center().text_size(12)
      .when(Boolean(text), (e) => e.cursor_pointer().on_click((_e, cx) => {
        folded ? this.convFolded.delete(c.id) : this.convFolded.add(c.id);
        cx.notify();
      }))
      .child(div().flex_none().font_semibold().child(c.author))
      .child(div().flex_none().px(6).h(18).rounded(4).flex().items_center().text_size(10.5).font_semibold().bg(alpha(color, "26")).text_color(color).child(label))
      .child(div().flex_none().text_color(t.dim).child(ago(c.at)))
      .when(folded && Boolean(text), (e) => e.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())))
      .when(!folded || !text, (e) => e.child(div().flex_1()))
      .when(Boolean(c.url), (e) => e.child(div().id(`cv-gh-${c.id}`).flex_none().px(3).rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Open on GitHub")
        .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [c.url]).catch(() => {}); })
        .child("↗")))
      .when(Boolean(text), (e) => e.child(div().flex_none().text_color(t.dim).child(folded ? "▸" : "▾")));
    return v_flex().id(`cv-${c.id}`).mb(8).p(10).gap(8).rounded(8).border_1().border_color(t.border).bg(cardBg(t))
      .child(head)
      .when(!folded && Boolean(text), (e) => e.child(this.richBody(text, `cv-${c.id}`, t, 836)));
  }

  conversationView(t) {
    const conv = this.conversation ?? [];
    if (!conv.length) return div();
    return v_flex().max_w(860).mt(28)
      .child(h_flex().gap(8).items_center().mb(10).pb(6).border_b(1).border_color(t.border)
        .child(div().text_size(15).font_semibold().child("Conversation"))
        .child(div().text_size(12).text_color(t.dim).child(String(conv.length))))
      .children(conv.map((c) => this.convItem(c, t)));
  }

  toggleThread(key, cx) {
    if (!key.startsWith("th:")) return;
    const id = key.slice(3);
    this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id);
    cx.notify();
  }

  openThread(key) {
    if (!key.startsWith("th:")) return;
    const th = this.threads.find((x) => x.id === key.slice(3));
    if (th) exec("open", [th.comments[0].url]).catch(() => {});
  }

  // Unified or split: props.view for this tab until toggled, else the choice
  // remembered across tabs.
  get split() {
    return (this.view ?? shared("pr-diff.view")) === "split";
  }

  // Split only where both sides have something: a new or deleted file shows unified.
  get splitHere() {
    const f = this.files.find((x) => x.path === this.open);
    return this.split && !(f && (f.status === "A" || f.status === "D"));
  }

  setView(split, cx) {
    this.view = null;
    setShared("pr-diff.view", split ? "split" : "unified");
    cx.notify();
  }

  // One side of a split row: its line number, marker and code, or an empty filler.
  // Gutter cells sit on the first line of a wrapped row.
  cell(w, color, text, right = false) {
    return h_flex().w(w).h(ROW_H).flex_none().items_center().when(right, (e) => e.justify_end()).text_color(color).child(text);
  }

  half(r, side, t, n, h) {
    if (!r) return div().flex_1().min_w(0).h(h).bg(glassy(t) ? t.raised : alpha(t.raised, "80"));
    const num = side === "a" ? r.a : r.b;
    const changed = r.kind !== " ";
    return h_flex().flex_1().min_w(0).h(h).gap(8).items_start().overflow_hidden()
      .when(changed && r.kind === "+", (e) => e.bg(alpha(t.ansi2, "1c")))
      .when(changed && r.kind === "-", (e) => e.bg(alpha(t.ansi1, "1c")))
      .child(this.cell(40, t.dim, num === undefined ? "" : String(num), true))
      .child(this.cell(10, r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim, changed ? r.kind : ""))
      .child(this.code(r, t, n));
  }

  splitRow(p, t, n, h) {
    if (p.kind === "@") return div().w_full().px(12).h(ROW_H).flex_none().truncate().bg(t.raised).text_color(t.dim).child(p.text);
    return h_flex().w_full().h(h).flex_none().items_start()
      .child(this.half(p.l, "a", t, n, h))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.half(p.r, "b", t, n, h));
  }

  diffRow(r, t, n, h) {
    if (r.kind === "@") return div().w_full().px(12).h(ROW_H).flex_none().truncate().bg(t.raised).text_color(t.dim).child(r.text);
    return h_flex().w_full().h(h).flex_none().gap(8).items_start().overflow_hidden()
      .when(r.kind === "+", (e) => e.bg(alpha(t.ansi2, "1c")))
      .when(r.kind === "-", (e) => e.bg(alpha(t.ansi1, "1c")))
      .child(this.cell(40, t.dim, r.a === undefined ? "" : String(r.a), true))
      .child(this.cell(40, t.dim, r.b === undefined ? "" : String(r.b), true))
      .child(this.cell(10, r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim, r.kind === " " ? "" : r.kind))
      .child(this.code(r, t, n));
  }

  // Syntax colors when delta gave them, cut into lines that fit the column.
  code(r, t, n) {
    const emph = r.kind === "+" ? alpha(t.ansi2, "45") : alpha(t.ansi1, "45");
    return v_flex().flex_1().min_w(0).children(this.wrapped(r, n).map((line) =>
      h_flex().h(ROW_H).flex_none().items_center().children(line.map((s) =>
        div().flex_none().whitespace_nowrap().text_color(s.fg ?? t.foreground).when(s.emph, (e) => e.bg(emph).rounded(2)).child(s.text)))));
  }

  // Folders as the tree groups them: the path below the shared prefix.
  dirOf(path) {
    // The session's changes group by project: a repo's files under its name, a file outside
    // git under its own folder.
    if (this.changes) {
      const parts = path.split("/");
      return parts[0] === "~" || parts[0] === "private" ? parts.slice(0, -1).join("/") : parts[0];
    }
    const dir = path.split("/").slice(0, -1).join("/");
    const base = this.base ?? "";
    return base && dir.startsWith(base) ? dir.slice(base.length).replace(/^\//, "") : dir;
  }

  // Files grouped by folder, folders and files by name: the order j/k walk.
  groups() {
    this.base = this.changes ? "" : commonDir(this.files.map((f) => f.path));
    const by = new Map();
    for (const f of this.files) {
      const d = this.dirOf(f.path);
      if (!by.has(d)) by.set(d, []);
      by.get(d).push(f);
    }
    if (!this.changes) {
      return [...by.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([dir, files]) => ({ dir, files: files.sort((x, y) => x.path.localeCompare(y.path)) }));
    }
    // The session's changes: each project with the folder its files share shown once, files
    // named below it; by name, or (t) the latest changed first.
    const when = (f) => this.meta?.[f.path]?.mtime ?? 0;
    this.shortName = new Map();
    const out = [...by.entries()].map(([dir, files]) => {
      const rel = (f) => (f.path.startsWith(dir + "/") ? f.path.slice(dir.length + 1) : f.path);
      const prefix = files.length > 1 ? commonDir(files.map(rel)) : "";
      for (const f of files) {
        const r = rel(f);
        this.shortName.set(f.path, prefix && r.startsWith(prefix + "/") ? r.slice(prefix.length + 1) : r);
      }
      files.sort(this.byTime ? (x, y) => when(y) - when(x) : (x, y) => x.path.localeCompare(y.path));
      return { dir, prefix, files, latest: Math.max(...files.map(when)) };
    });
    return out.sort(this.byTime ? (a, b) => b.latest - a.latest : (a, b) => a.dir.localeCompare(b.dir));
  }

  fileOrder() {
    return this.groups().flatMap((g) => g.files.map((f) => f.path));
  }

  // Viewed marks live in shared state per PR; a mark holds while the file's diff is the same.
  // This copy's own map is what it draws and toggles from: shared state is written
  // through for the other mods, but a read straight after a write can still be the old one.
  viewedMap() {
    return (this.viewed ??= { ...(shared(VIEWED_KEY)?.[this.viewKey()] ?? {}) });
  }

  isViewed(f) {
    return Boolean(f) && this.viewedMap()[f.path] === f.hash;
  }

  // Toggles a file's mark; marking it from the keyboard (next) also moves on to the next unviewed file.
  // Flips a file's viewed mark (or sets it, with want). One press can arrive twice; a
  // second flip of the same file within a moment is that, not a new press.
  markViewed(path, next = false, want = null) {
    const f = this.files.find((x) => x.path === path);
    if (!f) return;
    const mine = this.viewedMap();
    const nowViewed = want ?? mine[path] !== f.hash;
    const last = this.lastMark;
    if (want == null && last && last.path === path && Date.now() - last.at < 300) return;
    this.lastMark = { path, at: Date.now() };
    if (nowViewed) mine[path] = f.hash; else delete mine[path];
    const key = this.viewKey();
    setShared(VIEWED_KEY, { ...(shared(VIEWED_KEY) ?? {}), [key]: { ...mine } });
    if (next && nowViewed) {
      const order = this.fileOrder();
      const at = order.indexOf(path);
      const rest = [...order.slice(at + 1), ...order.slice(0, at)];
      const target = rest.find((p) => mine[p] !== this.files.find((x) => x.path === p)?.hash);
      if (target) this.pick(target);
    }
  }

  viewedCount() {
    const m = this.viewedMap();
    return this.files.filter((f) => m[f.path] === f.hash).length;
  }

  fileRow(f, t) {
    // In the session's changes a file is named by its path inside its project.
    const proj = this.changes ? this.dirOf(f.path) : null;
    const name = proj ? this.shortName?.get(f.path) ?? f.path.split("/").pop() : f.path.split("/").pop();
    const viewed = this.isViewed(f);
    const c = this.threadCount(f.path);
    // A row of the tree's virtual list: no handlers here, the list's on_item_click does the clicks.
    return h_flex().h(26).flex_none().pl(22).pr(8).gap(7).items_center().rounded(6).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .child(div().size(14).flex_none().rounded(4).border_1().flex().items_center().justify_center()
        .border_color(viewed ? t.ansi2 : t.input).when(viewed, (e) => e.bg(alpha(t.ansi2, "33")))
        .when(viewed, (e) => e.child(svg("mods/workspace-chrome/check.svg").size(10).text_color(t.ansi2))))
      .child(div().w(10).flex_none().text_size(10.5).text_color(STATUS_COLOR(t, f.status)).child(f.status))
      .child(div().flex_1().min_w(0).when(Boolean(proj), (e) => e.text_ellipsis_start()).when(!proj, (e) => e.truncate()).whitespace_nowrap().overflow_hidden().text_color(viewed ? t.dim : t.foreground).child(name))
      .when(c.all > 0, (e) => e.child(div().flex_none().px(4).rounded(4).text_size(10.5)
        .when(c.open > 0, (x) => x.bg(alpha(t.blocked, "26")).text_color(t.blocked))
        .when(c.open === 0, (x) => x.text_color(t.dim))
        .child(`\u{1F4AC} ${c.open || c.all}`)))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(viewed ? t.dim : t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(viewed ? t.dim : t.ansi1).child(`−${f.del}`)));
  }

  // The file tree: the shared prefix once, then a foldable row per folder.
  // The tree's rows in order: the shared prefix, then each folder and (unless folded) its files.
  treeItems() {
    const groups = this.groups();
    const items = this.base ? [{ key: "base", h: 24 }] : [];
    for (const g of groups) {
      items.push({ key: `d:${g.dir}`, h: 24, g });
      if (!this.foldedDirs.has(g.dir)) for (const f of g.files) items.push({ key: `f:${f.path}`, h: 26, f });
    }
    return items;
  }

  // The file tree: the shared prefix once, then a foldable row per folder.
  // A virtual list, so j/k can scroll it to the picked file.
  fileTree(t) {
    const m = this.viewedMap();
    const items = this.treeItems();
    const head = (g) => {
      const folded = this.foldedDirs.has(g.dir);
      const done = g.files.filter((f) => m[f.path] === f.hash).length;
      const open = g.files.reduce((n, f) => n + this.threadCount(f.path).open, 0);
      return h_flex().h(24).flex_none().px(6).gap(6).items_center().rounded(6).cursor_pointer().text_size(11.5)
        .hover((s) => s.bg(t.hover))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
        .child(h_flex().flex_1().min_w(0).gap(6)
          .child(div().flex_none().text_color(done === g.files.length ? t.dim : this.changes ? t.foreground : t.muted).when(Boolean(this.changes), (x) => x.font_medium())
            .child(this.changes ? this.groupLabel(g.dir) : g.dir || "(root)"))
          .when(Boolean(this.changes && g.prefix), (x) => x.child(div().min_w(0).text_ellipsis_start().whitespace_nowrap().overflow_hidden().text_color(t.dim).child(g.prefix))))
        .when(open > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(`\u{1F4AC} ${open}`)))
        .child(div().flex_none().text_size(10.5).text_color(done === g.files.length ? t.ansi2 : t.dim).child(`${done}/${g.files.length}`));
    };
    const id = `pr-files-${this.uid}`;
    if (!this.files.length) {
      return v_flex().w(320).flex_none().h_full().p(6).border_r(1).border_color(t.border)
        .child(div().p(8).text_color(this.error ? t.blocked : t.dim).child(this.error ?? (this.loading ? "Loading diff…" : "No changed files")));
    }
    // Where the press landed across the row: the viewed box is the 14px after the row's 22px indent.
    return div().w(320).flex_none().h_full().relative().border_r(1).border_color(t.border)
      .on_mouse_down("left", (e) => { this.treeX = e.local_position?.x ?? null; })
      .child(div().size_full().p(6)
        .child(v_virtual_list(id, items.length, items.map((it) => it.h), (i) => items[i].key, (range) =>
          items.slice(range.start, range.end).map((it) => it.key === "base"
            ? div().h(24).px(8).pt(2).text_size(11).text_color(t.dim).truncate().child(`${this.base}/`)
            : it.g ? head(it.g) : this.fileRow(it.f, t)))
          .size_full().track_scroll(this.treeScroller)
          .on_item_click((key, cx) => {
            if (key.startsWith("d:")) {
              const dir = key.slice(2);
              this.foldedDirs.has(dir) ? this.foldedDirs.delete(dir) : this.foldedDirs.add(dir);
            } else if (key.startsWith("f:")) {
              const path = key.slice(2);
              const x = this.treeX;
              if (x != null && x >= 6 + 22 - 4 && x <= 6 + 22 + 14 + 4) {
                const f = this.files.find((y) => y.path === path);
                this.markViewed(path, false, !this.isViewed(f));
              }
              else { this.tab = "files"; this.pick(path); }
            }
            cx.notify();
          })))
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
  }

  // A page that keys can scroll (a plain scroll area can't be moved from code):
  // the content slides up inside a clipped box; the wheel, j/k, d/u and gg/G move it.
  page(key) {
    this.pages ??= {};
    return (this.pages[key] ??= { off: 0, view: 0, full: 0 });
  }

  scrollPage(key, by) {
    const st = this.page(key);
    const max = Math.max(0, st.full - st.view);
    const off = Math.max(0, Math.min(max, by === "top" ? 0 : by === "bottom" ? max : st.off + by));
    if (off === st.off) return false;
    st.off = off;
    return true;
  }

  pager(key, t, content) {
    const st = this.page(key);
    st.off = Math.max(0, Math.min(st.off, Math.max(0, st.full - st.view)));
    const over = st.full > st.view + 1 && st.view > 0;
    const thumbH = over ? Math.max(28, st.view * st.view / st.full) : 0;
    const thumbTop = over ? (st.view - thumbH) * st.off / (st.full - st.view) : 0;
    return div().id(`pg-${key}-${this.uid}`).size_full().relative().overflow_hidden()
      .on_size_change((size, cx) => { if (Math.abs(size.height - st.view) >= 1) { st.view = size.height; cx.notify(); } })
      .on_scroll_wheel((e, cx) => { if (this.scrollPage(key, -(e.delta?.y ?? 0))) { cx.stop_propagation(); cx.notify(); } })
      .child(div().id(`pgc-${key}-${this.uid}`).absolute().left(0).w_full().top(-st.off)
        .on_size_change((size, cx) => { if (Math.abs(size.height - st.full) >= 1) { st.full = size.height; cx.notify(); } })
        .child(content))
      .when(over, (e) => e.child(div().absolute().right(2).top(thumbTop).w(6).h(thumbH).rounded(3).bg(t.border)));
  }

  // Opens a thread from the Comments tab: its file on the Files tab, the thread open and in view.
  goToThread(th) {
    this.tab = "files";
    this.expanded?.add(th.id);
    this.pick(th.path);
    const items = (this.splitHere ? this.splitItems : this.unifiedItems) ?? [];
    const i = items.findIndex((it) => it.key === `th:${th.id}`);
    if (i >= 0) this.scroller.scroll_to_item(i, "center");
  }

  // The Comments tab: review threads by file (open first), then reviews and conversation.
  commentsView(t) {
    const threads = [...(this.threads ?? [])];
    const order = this.fileOrder();
    threads.sort((a, b) => (a.resolved - b.resolved) || (order.indexOf(a.path) - order.indexOf(b.path)) || ((a.line ?? 0) - (b.line ?? 0)));
    const card = (th) => {
      const tone = th.resolved || th.outdated ? t.dim : t.blocked;
      const state = th.resolved ? "Resolved" : th.outdated ? "Outdated" : "Open";
      const folded = th.resolved && !this.expanded?.has(th.id);
      return v_flex().id(`cm-${th.id}`).mb(8).p(10).gap(8).rounded(8).border_1().border_color(th.resolved ? t.border : alpha(t.blocked, "66")).bg(cardBg(t))
        .child(h_flex().id(`cm-h-${th.id}`).gap(8).items_center().text_size(12).cursor_pointer()
          .on_click((_e, cx) => { this.goToThread(th); cx.notify(); })
          .child(div().flex_none().px(6).h(18).rounded(4).flex().items_center().text_size(10.5).font_semibold().bg(alpha(tone, "26")).text_color(tone).child(state))
          .child(div().flex_1().min_w(0).truncate().text_color(t.accent).tooltip("Show in the diff")
            .child(`${th.path.split("/").pop()}${th.line ? `:${th.line}` : th.originalLine ? ` (was :${th.originalLine})` : ""}`))
          .child(div().flex_none().text_color(t.dim).child(`${th.comments[0].author} · ${ago(th.comments.at(-1).at)}${th.comments.length > 1 ? ` · ${th.comments.length} comments` : ""}`))
          .child(div().id(`cm-gh-${th.id}`).flex_none().px(3).rounded(4).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Open on GitHub")
            .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [th.comments[0].url]).catch(() => {}); }).child("↗")))
        .when(folded, (e) => e.child(div().id(`cm-f-${th.id}`).text_size(12).text_color(t.muted).truncate().cursor_pointer()
          .on_click((_e, cx) => { this.expanded.add(th.id); cx.notify(); })
          .child(th.comments[0].body.split("\n")[0])))
        .when(!folded, (e) => e.children(th.comments.map((c, i) => v_flex().gap(4).when(i > 0, (x) => x.pt(8).border_t(1).border_color(t.border)
          .child(h_flex().gap(8).text_size(11.5).child(div().font_semibold().child(c.author)).child(div().text_color(t.dim).child(ago(c.at)))))
          .child(this.richBody(c.body, `cm-${th.id}-${i}`, t, 900)))));
    };
    const open = threads.filter((th) => !th.resolved).length;
    return this.pager("comments", t, div().px(24).py(16)
      .child(v_flex().w_full().max_w(940).mx_auto()
        .child(h_flex().gap(8).items_center().mb(10).pb(6).border_b(1).border_color(t.border)
          .child(div().text_size(15).font_semibold().child("Review threads"))
          .child(div().text_size(12).text_color(open ? t.blocked : t.dim).child(threads.length ? `${open} open of ${threads.length}` : "none")))
        .children(threads.map(card))
        .child(this.conversationView(t))));
  }

  // The Claude tab, in two columns: the drafts and what to post with them on the left (the
  // bar stays on top while the cards scroll), the conversation with Claude on the right,
  // its line at the bottom like a chat, then what it checked and what it dropped.
  draftsView(t) {
    const a = this.reviewAgent();
    const d = this.drafts;
    const list = d?.list ?? [];
    this.cardSel = Math.max(0, Math.min(this.cardSel, list.length - 1));
    const keysHere = this.handle.is_focused?.() ?? false;
    const ink = t.background.length === 9 ? t.background.slice(0, 7) : t.background;
    const status = a ? { working: ["Claude is working…", t.working], blocked: ["Claude is asking you", t.blocked], done: ["Done", t.ansi2], idle: ["Done", t.ansi2] }[a.status] : null;
    const smallButton = (id, label, onClick, on = false) => div().id(id).flex_none().px(10).h(26).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(on, (e) => e.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)))
      .when(!on, (e) => e.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(label);
    const fieldRow = (state, id, button, onSend) => h_flex().gap(8).items_center()
      // A press here is the field's: the pane's own mouse-down would take the keyboard back.
      .child(div().id(`${id}-field`).flex_1().min_w(0).h(34).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(cardBg(t))
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); state.focus(); this.typing = true; cx.notify(); })
        .child(Input.new(state).flex_1().text_size(12.5).text_color(t.foreground)))
      .child(smallButton(id, button, () => onSend()));
    const label = (text, color = t.dim) => div().text_size(11).font_semibold().text_color(color).child(text);

    // ---- right: the conversation, then what was checked and dropped
    // The latest exchange on top (your last message, then the answer); older ones folded.
    const all = d?.talk ?? [];
    let lastAsk = -1;
    all.forEach((x, i) => { if (x.role === "user") lastAsk = i; });
    const talk = lastAsk >= 0 ? all.slice(lastAsk) : all;
    const earlier = lastAsk > 0 ? all.slice(0, lastAsk) : [];
    if (all.length !== this.talkSeen) { this.talkSeen = all.length; this.page("agent-side").off = 0; }
    const bubble = (x, i) => x.role === "user"
      ? h_flex().justify_end().child(div().max_w(300).px(12).py(8).rounded(10).bg(alpha(t.accent, "26")).text_size(12.5).text_color(t.foreground).child(x.text))
      : v_flex().gap(4).child(label("CLAUDE", t.accent)).child(div().text_size(12.5).child(this.richBody(x.text, `dr-talk-${i}`, t, 340)));
    const fold = (id, title, body) => {
      this.drOpen ??= new Set();
      const open = this.drOpen.has(id);
      return v_flex().gap(8).pt(12).mt(12).border_t(1).border_color(t.border)
        .child(h_flex().id(`dr-fold-${id}`).gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => { open ? this.drOpen.delete(id) : this.drOpen.add(id); cx.notify(); })
          .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.dim))
          .child(label(title)))
        .when(open, (e) => e.child(div().text_size(12).text_color(t.muted).child(this.richBody(body, `dr-${id}`, t, 340))));
    };
    const side = v_flex().w(400).flex_none().h_full().min_h(0).rounded(10).border_1().border_color(t.border).bg(cardBg(t)).overflow_hidden()
      .child(h_flex().flex_none().px(14).h(42).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Razgovor s Claudeom"))
        .when(Boolean(status), (e) => e.child(h_flex().gap(5).items_center().text_size(11.5).text_color(status[1])
          .child(a.status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(11).text_color(status[1]).spin(900) : div().size(6).rounded(3).bg(status[1]))
          .child(status[0])))
        .child(div().flex_1())
        .when(Boolean(a), (e) => e.child(smallButton("dr-agent", "Open ↗", () => swapZoom(a.tab)))))
      .child(div().flex_1().min_h(0).child(this.pager("agent-side", t, v_flex().p(14).gap(12)
        // Before any talk: what Claude checked, open and quiet, instead of an empty chat.
        .when(talk.length === 0 && Boolean(d?.intro), (e) => e.child(v_flex().gap(6)
          .child(label("WHAT WAS CHECKED"))
          .child(div().text_size(12.5).opacity(0.6).child(this.richBody(d.intro, "dr-intro-open", t, 340)))))
        .when(talk.length === 0 && !d?.intro, (e) => e.child(div().text_size(12.5).text_color(t.dim).child(a
          ? "Ask why it found or missed something, or tell it what else to look at."
          : "Agent za ovaj PR nije otvoren.")))
        .when(earlier.length > 0, (e) => {
          this.drOpen ??= new Set();
          const open = this.drOpen.has("earlier");
          return e.child(v_flex().gap(10)
            .child(h_flex().id("dr-fold-earlier").gap(6).items_center().cursor_pointer()
              .on_click((_e, cx) => { open ? this.drOpen.delete("earlier") : this.drOpen.add("earlier"); cx.notify(); })
              .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.dim))
              .child(label(`RANIJI RAZGOVOR · ${earlier.length}`)))
            .when(open, (x) => x.children(earlier.map((m, i) => bubble(m, `e${i}`)))));
        })
        .children(talk.map(bubble))
        .when(talk.length > 0 && Boolean(d?.intro), (e) => e.child(fold("intro", "WHAT WAS CHECKED", d.intro)))
        .when(Boolean(d?.dropped), (e) => e.child(fold("dropped", "DROPPED · checked, not going on the PR", d.dropped))))))
      .when(Boolean(a), (e) => e.child(div().flex_none().p(10).border_t(1).border_color(t.border)
        .child(fieldRow(this.askInput, "dr-ask", "Send", () => this.ask()))));

    // ---- left: what to post, then the drafts
    const lenColor = (n) => (n <= 105 ? t.ansi2 : n <= 196 ? t.working : t.ansi1);
    const card = (dr, i) => {
      const ticked = this.chosen.has(dr.n);
      const here = keysHere && i === this.cardSel;
      const done = this.posted(dr);
      const inDiff = dr.path && this.files.some((f) => f.path === dr.path);
      const lc = lenColor(dr.count);
      const editing = this.editing === dr.n;
      return div().id(`dr-w-${dr.n}`).w_full().pb(12)
        .on_size_change((size) => { this.drHeights[dr.n] = size.height; })
        .child(v_flex().id(`dr-${dr.n}`).rounded(10).border_1().overflow_hidden()
          .border_color(here ? t.accent : ticked ? alpha(t.accent, "59") : t.border)
          .bg(ticked ? alpha(t.accent, "12") : cardBg(t))
          .child(h_flex().px(14).py(10).gap(10).items_center().border_b(1).border_color(t.border)
            .child(div().id(`dr-tick-${dr.n}`).size(18).flex_none().rounded(5).border_1().flex().items_center().justify_center()
              .border_color(done ? t.dim : ticked ? t.accent : t.muted).when(ticked, (e) => e.bg(t.accent))
              .when(!done, (e) => e.cursor_pointer().on_click((_e, cx) => { ticked ? this.chosen.delete(dr.n) : this.chosen.add(dr.n); this.cardSel = i; cx.notify(); }))
              .when(ticked, (e) => e.child(svg("mods/workspace-chrome/check.svg").size(12).text_color(ink))))
            .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(String(dr.n)))
            .child(div().id(`dr-at-${dr.n}`).flex_1().min_w(0).truncate().text_size(12).font_family(settings().font_family ?? "JetBrains Mono")
              .text_color(inDiff ? t.accent : t.muted)
              .when(inDiff, (e) => e.cursor_pointer().tooltip("Show in diff").on_click((_e, cx) => { this.goToDraft(dr); cx.notify(); }))
              .child(dr.path ? `${dr.path.split("/").pop()}${dr.line ? `:${dr.line}` : ""}` : "PR komentar"))
            .when(Boolean(dr.note), (e) => e.child(div().flex_none().px(6).h(20).flex().items_center().rounded(5).text_size(11).bg(t.raised).text_color(t.muted).child("izvan diffa")))
            .child(div().flex_none().px(6).h(20).flex().items_center().rounded(5).text_size(11).bg(alpha(lc, "1f")).text_color(lc)
              .tooltip("Medijan 78–105 · p75 143–196").child(`${dr.count} zn.`))
            .when(Boolean(done), (e) => e.child(div().id(`dr-done-${dr.n}`).flex_none().px(6).h(20).flex().items_center().rounded(5).text_size(11)
              .bg(alpha(t.ansi2, "1f")).text_color(t.ansi2).cursor_pointer().tooltip("Open on GitHub")
              .on_click((_e, cx) => { cx.stop_propagation(); if (typeof done === "string") exec("open", [done]).catch(() => {}); })
              .child("Objavljeno ↗")))
            .when(Boolean(a) && !done && !editing, (e) => e.child(smallButton(`dr-edit-${dr.n}`, "Promijeni", () => { this.cardSel = i; this.startEdit(dr.n); }))))
          // The comment as GitHub will show it; the full path under it.
          .child(v_flex().px(16).py(12).gap(6)
            .child(div().text_size(13.5).child(this.richBody(dr.body, `dr-${dr.n}`, t, 880)))
            .when(Boolean(dr.path), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(dr.note ? `${dr.path} · ${dr.note}` : dr.path))))
          .when(Boolean(dr.why || dr.ifStays), (e) => e.child(v_flex().px(16).py(10).gap(6).border_t(1).border_color(t.border).text_size(12.5).text_color(t.muted)
            .when(Boolean(dr.why), (x) => x.child(h_flex().gap(8).items_start()
              .child(div().w(80).flex_none().text_color(t.dim).child("Why"))
              .child(div().flex_1().min_w(0).child(this.richBody(dr.why, `dr-w-${dr.n}`, t, 760)))))
            .when(Boolean(dr.ifStays), (x) => x.child(h_flex().gap(8).items_start()
              .child(div().w(80).flex_none().text_color(t.dim).child("Ako ostane"))
              .child(div().flex_1().min_w(0).child(this.richBody(dr.ifStays, `dr-s-${dr.n}`, t, 760)))))))
          .when(editing, (e) => e.child(div().px(16).py(10).border_t(1).border_color(t.border)
            .child(fieldRow(this.editInput, `dr-edit-send-${dr.n}`, "Send", () => this.sendEdit())))));
    };
    const nums = [...this.chosen].sort((x, y) => x - y);
    const mode = this.reviewMode;
    const body = this.bodyInput.value();
    const ready = Boolean(a) && Boolean(this.postMessage(nums, mode, body));
    const modes = [["comment", "Samo komentar", "c"], ["approve", "Approve", "a"], ["changes", "Request changes", "x"]];
    const modeColor = { comment: t.accent, approve: t.ansi2, changes: t.ansi1 };
    const postLabel = { comment: "Post comments…", approve: nums.length ? "Post and approve…" : "Approve…", changes: nums.length ? "Post and request changes…" : "Request changes…" }[mode];
    const bar = v_flex().flex_none().mb(12).px(14).py(12).gap(10).rounded(10).border_1().border_color(ready ? alpha(modeColor[mode], "73") : t.border).bg(cardBg(t)).text_size(12.5)
      .child(h_flex().gap(10).items_center()
        .child(h_flex().flex_none().h(28).p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .children(modes.map(([id, name, key]) => h_flex().id(`dr-mode-${id}`).px(10).h_full().gap(6).items_center().rounded(5).cursor_pointer().text_size(12)
            .when(mode === id, (x) => x.bg(alpha(modeColor[id], "26")).text_color(modeColor[id]).font_semibold())
            .when(mode !== id, (x) => x.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => { this.reviewMode = id; cx.notify(); })
            .child(div().child(name))
            .child(div().text_size(10.5).text_color(t.dim).child(key)))))
        .child(div().flex_1().min_w(0).truncate().text_color(nums.length ? t.foreground : t.dim).child(nums.length
          ? `Odabrano: ${nums.join(", ")} od ${list.length}`
          : mode === "comment" ? "Tick the comments you want to post." : "No comments, just the review."))
        .child(smallButton("dr-all", h_flex().gap(6).items_center()
          .child(div().child(nums.length && nums.length === list.filter((x) => !this.posted(x)).length ? "Untick all" : "Tick all"))
          .child(div().text_size(10.5).text_color(t.dim).child("T")), () => this.agentKey("T", null)))
        .child(div().id("dr-post").flex_none().px(12).h(28).flex().items_center().rounded(6).text_size(12.5)
          .when(ready, (e) => e.bg(modeColor[mode]).text_color(ink).font_semibold().cursor_pointer().hover((s) => s.opacity(0.9)).on_click(() => this.askPost()))
          .when(!ready, (e) => e.border_1().border_color(t.border).text_color(t.dim)
            .tooltip(!a ? "The agent for this PR is no longer open" : mode === "changes" ? "Write the review text" : "Tick some comments first"))
          .child(h_flex().gap(8).items_center().child(div().child(postLabel))
            .child(div().px(4).rounded(3).text_size(10.5).when(ready, (x) => x.bg(alpha(ink, "26"))).when(!ready, (x) => x.text_color(t.dim)).child("enter")))))
      .when(mode !== "comment", (e) => e.child(div().id("dr-body-field").w_full().h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.input)
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.bodyInput.focus(); this.typing = true; cx.notify(); })
        .child(Input.new(this.bodyInput).flex_1().text_size(12.5).text_color(t.foreground))))
      .when(Boolean(this.sendError), (e) => e.child(div().px(10).py(6).rounded(6).bg(alpha(t.blocked, "1f")).text_color(t.blocked).child(`Slanje agentu nije uspjelo: ${this.sendError}`)))
      .child(h_flex().gap(14).text_size(11).text_color(t.dim)
        .children([["j/k", "comment"], ["space", "tick"], ["T", "all"], ["c/a/x  m", "mode"], ["b", "review text"], ["enter", "post"], ["e", "edit"], ["i", "ask"]]
          .map(([k, what]) => h_flex().gap(5).items_center().child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(what)))));
    this.drAbove = 0;
    const cards = !list.length
      ? v_flex().items_center().gap(10).py(48).rounded(10).border_1().border_color(t.border).bg(cardBg(t))
        .child(div().text_size(14).text_color(t.muted).child(
          !a && !this.draftsFile ? "No review for this PR yet."
          : a?.status === "working" ? "Comments show up here as soon as Claude drafts them."
          : "Claude drafted no comments."))
        .when(!a, (e) => e.child(smallButton("dr-start", "Review with Claude", () => this.startReview(), true)))
      : v_flex().w_full().children(list.map(card));
    const main = v_flex().flex_1().min_w(0).h_full().min_h(0)
      .when(list.length > 0, (e) => e.child(bar))
      .child(div().flex_1().min_h(0).child(this.pager("agent", t, div().pr(6).pb(16).child(cards))));
    return h_flex().size_full().min_h(0).px(24).pt(16).pb(12).justify_center()
      .child(h_flex().w_full().max_w(1400).h_full().min_h(0).gap(16).items_start()
        .child(main)
        .child(side));
  }

  // A person: their initial in a circle, a stable color from the theme's palette.
  avatar(login, t, size = 22) {
    const hues = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1, t.accent];
    let h = 0;
    for (const c of login ?? "?") h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const color = hues[h % hues.length] ?? t.accent;
    return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center()
      .bg(alpha(color, "2e")).border_1().border_color(alpha(color, "59"))
      .text_size(size * 0.45).font_semibold().text_color(color)
      .child((login ?? "?").slice(0, 1).toUpperCase());
  }

  // The Description tab's side column: reviewers, checks and the ticket, on a card.
  metaColumn(t) {
    const info = this.info ?? {};
    const reviews = info.latestReviews ?? [];
    const asked = (info.reviewRequests ?? []).map((r) => r.login ?? r.name ?? r.slug).filter(Boolean)
      .filter((who) => !reviews.some((r) => r.author?.login === who));
    const section = (title, children, first = false) => v_flex().gap(8).when(!first, (e) => e.pt(14).mt(14).border_t(1).border_color(t.border))
      .child(div().text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase()))
      .children(children);
    const pill = (label, color, solid = false) => div().flex_none().px(7).h(20).flex().items_center().rounded(10).text_size(11)
      .when(solid, (e) => e.bg(alpha(color, "26")).text_color(color))
      .when(!solid, (e) => e.border_1().border_color(t.input).text_color(t.muted))
      .child(label);
    const person = (login, right) => h_flex().gap(8).items_center().text_size(12.5)
      .child(this.avatar(login, t))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(login))
      .child(right);
    const reviewRows = [
      ...reviews.map((r) => {
        const [label, tone] = REVIEW_STATE[r.state] ?? [r.state, "dim"];
        return person(r.author?.login ?? "?", pill(label, t[tone] ?? t.muted, tone !== "dim"));
      }),
      ...asked.map((who) => person(who, pill("Waiting", t.muted))),
    ];
    const icon = { ok: ["✓", t.ansi2], fail: ["✗", t.ansi1], pending: ["…", t.working], skip: ["–", t.dim] };
    const checkRows = (this.checks ?? []).map((c) => h_flex().id(`ck-${c.name}`).gap(8).items_center().text_size(12.5).cursor_pointer()
      .text_color(t.foreground).hover((s) => s.text_color(t.accent))
      .on_click(() => c.url && exec("open", [c.url]).catch(() => {}))
      .child(div().size(18).flex_none().rounded(9).flex().items_center().justify_center().text_size(11)
        .bg(alpha(icon[c.state][1], "26")).text_color(icon[c.state][1]).child(icon[c.state][0]))
      .child(div().flex_1().min_w(0).truncate().child(c.name)));
    const links = [...new Set((cleanBody(info.body).match(/https:\/\/youtrack\.[^\s)>\]]+/g) ?? []))];
    const linkRows = links.map((u) => h_flex().id(`lk-${u}`).gap(6).items_center().text_size(12.5).text_color(t.accent).cursor_pointer()
      .hover((s) => s.opacity(0.85))
      .on_click(() => exec("open", [u]).catch(() => {}))
      .child(div().min_w(0).truncate().child(u.replace(/^https:\/\/youtrack\.[^/]+\/issue\//, "")))
      .child(div().flex_none().text_color(t.dim).child("↗")));
    return v_flex().w(280).flex_none().ml(28).p(16).rounded(10).border_1().border_color(t.border).bg(cardBg(t))
      .child(section("Reviewers", reviewRows.length ? reviewRows : [div().text_size(12.5).text_color(t.dim).child("None yet")], true))
      .when(checkRows.length > 0, (e) => e.child(section("Checks", checkRows)))
      .when(linkRows.length > 0, (e) => e.child(section("Ticket", linkRows)));
  }

  threadCount(path) {
    const mine = (this.threads ?? []).filter((th) => !path || th.path === path);
    return { all: mine.length, open: mine.filter((th) => !th.resolved).length };
  }

  // The review agent started for this PR, if its tab still holds one.
  reviewAgent() {
    const rec = shared(AGENTS_KEY)?.[`${this.repo}#${this.number}`];
    return rec ? agents().find((a) => a.tab === rec.tab) ?? null : null;
  }

  // Splits this PR's pane with Claude running the review skill in the PR's repo.
  // The skill only drafts; nothing goes to GitHub until you say so in that pane.
  startReview() {
    // A click lands in the shown tab, so this tab's pr-diff pane is this one.
    const f = focused();
    const mine = f && panes().find((p) => p.tab === f.tab && p.mod === "pr-diff");
    if (!mine) return;
    const { dir, skill } = REVIEWERS[this.repo] ?? REVIEWERS.default;
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    setShared(AGENTS_KEY, { ...(shared(AGENTS_KEY) ?? {}), [`${this.repo}#${this.number}`]: { tab: f.tab, at: Date.now() } });
    run("pane.split", {
      direction: "right",
      pane: mine.pane,
      argv: ["/bin/zsh", "-lc", `cd ${dir} && exec claude ${q(`${skill} ${this.url}`)}`],
    });
    // The agent works out of sight; the PR keeps the whole tab (cmd-ctrl-a or the button shows it).
    run("pane.zoom", { pane: mine.pane });
    run("pane.focus", { pane: mine.pane });
  }

  agentButton(t) {
    const a = this.reviewAgent();
    const base = div().id("review-agent").flex_none().px(10).h(24).flex().items_center().gap(6).rounded(6).text_size(11.5).cursor_pointer();
    if (!a) {
      return base.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9))
        .tooltip(`${(REVIEWERS[this.repo] ?? REVIEWERS.default).skill} in a pane beside the diff`)
        .on_click(() => this.startReview())
        .child("Review with Claude");
    }
    const label = { working: "Reviewing…", blocked: "Needs you", done: "Review ready", idle: "Review ready" }[a.status] ?? "Review";
    const ready = a.status === "done" || a.status === "idle";
    const color = ready ? t.ansi2 : t[a.status] ?? t.muted;
    const ink = t.background.length === 9 ? t.background.slice(0, 7) : t.background;
    if (ready) {
      // The review is done: the loud one, it takes you to the drafts.
      return base.bg(color).text_color(ink).font_semibold().hover((s) => s.opacity(0.9))
        .tooltip("Claudeovi komentari (tab Claude); klik s cmd-ctrl-a za agenta")
        .on_click((_e, cx) => { this.setTab("agent"); cx.notify(); })
        .child(svg("mods/workspace-chrome/check.svg").size(12).text_color(ink))
        .child(label);
    }
    return base.border_1().border_color(color).text_color(color).hover((s) => s.bg(t.hover))
      .tooltip("Show the review agent (cmd-ctrl-a switches back)")
      .on_click(() => swapZoom(a.tab))
      .when(a.status === "working", (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(color).spin(900)))
      .child(label);
  }

  // The session's changes: what session, how much, the reload and the Unified/Split switch.
  changesHeader(t) {
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    return h_flex().flex_none().px(18).h(52).gap(12).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().min_w(0).truncate().font_semibold().text_size(15).text_color(t.foreground).child(`Session changes · ${this.changes?.title ?? "Claude"}`))
        .child(h_flex().min_w(0).gap(6).items_center().text_size(11.5).overflow_hidden()
          .when(!this.files.length, (x) => x.child(div().text_color(t.dim).child(this.loading ? "Looking for changes…" : "No changes")))
          // One chip per project: how many files and lines; a click goes to its first file.
          .children(this.groups().map((g, i) => {
            const add = g.files.reduce((n, f) => n + f.add, 0);
            return h_flex().id(`chp-${i}`).flex_none().gap(5).px(6).h(20).items_center().rounded(5).bg(t.raised).cursor_pointer()
              .hover((x) => x.bg(t.hover))
              .on_click((_e, cx) => { this.foldedDirs.delete(g.dir); this.pick(g.files[0].path); cx.notify(); })
              .child(div().text_color(t.muted).child(this.groupLabel(g.dir).split("/").pop()))
              .child(div().text_color(t.dim).child(String(g.files.length)))
              .when(add > 0, (x) => x.child(div().text_color(alpha(t.ansi2, "cc")).child(`+${add >= 1000 ? (add / 1000).toFixed(1) + "k" : add}`)));
          }))
          .when(this.hiddenCount > 0, (x) => x.child(div().id("ch-hidden").flex_none().px(6).h(20).flex().items_center().rounded(5).cursor_pointer().text_color(t.dim)
            .hover((y) => y.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.showHidden = !this.showHidden; this.applyHidden(); cx.notify(); })
            .child(this.showHidden ? `hide ${this.hiddenCount} (b)` : `${this.hiddenCount} hidden (b)`)))))
      .child(h_flex().flex_none().gap(6).items_center().text_size(12)
        .child(div().text_color(t.ansi2).child(`+${add}`))
        .child(div().text_color(t.ansi1).child(`−${del}`))
        .child(div().text_color(t.muted).child(`· ${this.files.length} ${this.files.length === 1 ? "file" : "files"}`)))
      .child(this.loading
        ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.dim).spin(900)
        : div().id("ch-reload").px(8).h(24).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.load(cx)).child("↻"))
      .child(h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border).text_size(11.5)
        .children([["abc", "Name", false], ["time", "Recent", true]].map(([id, label, on]) =>
          div().id(`chs-${id}`).px(8).h_full().flex().items_center().rounded(4).cursor_pointer()
            .when(Boolean(this.byTime) === on, (x) => x.bg(t.selected).text_color(t.foreground))
            .when(Boolean(this.byTime) !== on, (x) => x.text_color(t.muted).hover((q) => q.text_color(t.foreground)))
            .on_click((_e, cx) => { this.byTime = on; cx.notify(); })
            .child(label))))
      .child(h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border).text_size(11.5)
        .children([["unified", "Unified", false], ["split", "Split", true]].map(([id, label, on]) =>
          div().id(`chv-${id}`).px(8).h_full().flex().items_center().rounded(4).cursor_pointer()
            .when(this.split === on, (x) => x.bg(t.selected).text_color(t.foreground))
            .when(this.split !== on, (x) => x.text_color(t.muted).hover((q) => q.text_color(t.foreground)))
            .on_click((_e, cx) => this.setView(on, cx))
            .child(label))))
      .when(Boolean(props()?.overlay), (e) => e.child(div().id("ch-close").px(8).h(24).flex().items_center().rounded(6).text_size(13).text_color(t.muted).cursor_pointer()
        .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props().overlay)).child("✕")));
  }

  render(cx) {
    const t = theme();
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const info = this.info;
    const current = this.files.find((f) => f.path === this.open);
    const button = (id, label, onClick) => div().id(id).px(8).h(24).flex().items_center().rounded(6).border_1().border_color(t.border)
      .text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick).child(label);
    const chip = (text, color, tip) => div().flex_none().px(6).h(20).flex().items_center().rounded(5).text_size(11).bg(alpha(color, "1f")).text_color(color)
      .when(Boolean(tip), (e) => e.tooltip(tip)).child(text);

    // Header: the title on its own line; under it who/where, the PR's state and the actions.
    const reviews = info?.latestReviews ?? [];
    const approvals = reviews.filter((r) => r.state === "APPROVED").length;
    const changes = reviews.filter((r) => r.state === "CHANGES_REQUESTED").length;
    const ci = ciOf(this.checks ?? []);
    const tc = this.threadCount();
    const [tag, title] = splitTitle(info?.title ?? "");
    const files = this.files.length;
    const fact = (color, text, tip, dot = true) => h_flex().flex_none().gap(6).items_center().text_size(12).text_color(color)
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .when(dot, (e) => e.child(div().size(7).rounded(4).bg(color)))
      .child(div().child(text));
    const ciFact = !ci ? null
      : ci === "ok" ? fact(t.ansi2, "Checks pass")
      : ci === "fail" ? fact(t.ansi1, "Checks fail")
      : h_flex().flex_none().gap(6).items_center().text_size(12).text_color(t.working)
        .child(svg("mods/workspace-chrome/spinner.svg").size(10).text_color(t.working).spin(1400)).child("Checks running");
    // The header and tabs keep to the left edge on every tab: the tabs' content is of different
    // widths (Files edge to edge, the others centred), so no centred column fits them all.
    const header = v_flex().flex_none().px(18).pt(14).pb(12).border_b(1).border_color(t.border)
      .child(v_flex().w_full().gap(10)
      .child(h_flex().gap(12).items_center().min_w(0)
        .child(this.avatar(info?.author?.login ?? "?", t, 34))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(h_flex().gap(8).items_center().min_w(0)
            .when(Boolean(tag), (e) => e.child(div().flex_none().px(6).h(20).flex().items_center().rounded(4).border_1().border_color(t.input).text_size(11).text_color(t.muted).child(tag)))
            .child(div().min_w(0).truncate().font_semibold().text_size(16).text_color(t.foreground).child(title || this.repo || ""))
            .when(Boolean(info?.isDraft), (e) => e.child(chip("Draft", t.dim)))
            .when(Boolean(info) && info.state !== "OPEN", (e) => e.child(chip(info.state === "MERGED" ? "Merged" : "Closed", info.state === "MERGED" ? t.ansi5 : t.dim))))
          .child(h_flex().gap(10).items_center().min_w(0).text_size(12).text_color(t.muted)
            .child(div().flex_none().child(info
              ? [`#${this.number}`, info.author?.login ?? "?", ...(info.createdAt ? [`opened ${ago(info.createdAt)} ago`] : [])].join("  ·  ")
              : `${this.repo ?? ""} #${this.number}`))
            .when(Boolean(info), (e) => e.child(h_flex().min_w(0).gap(5).items_center()
              .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.dim))
              .child(div().min_w(0).truncate().child(`${info.headRefName} → ${info.baseRefName}`))))))
        .child(h_flex().flex_none().gap(6).items_center()
          .child(this.loading
            ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.dim).spin(900)
            : button("reload", "↻", (_e, cx) => this.load(cx)))
          .child(button("gh", "GitHub ↗", () => exec("open", [this.url]).catch(() => {})))
          .child(this.agentButton(t))))
      .child(h_flex().h(26).flex_none().gap(16).items_center().min_w(0).pl(46)
        .when(Boolean(ciFact), (e) => e.child(ciFact))
        .when(approvals > 0, (e) => e.child(fact(t.ansi2, `${approvals} approved`, null)))
        .when(changes > 0, (e) => e.child(fact(t.ansi1, "Changes requested", null)))
        .when(tc.all > 0, (e) => e.child(fact(tc.open ? t.blocked : t.dim, tc.open ? `${tc.open} open thread${tc.open > 1 ? "s" : ""}` : `${tc.all} resolved`, `${tc.open} open of ${tc.all} threads`)))
        .child(h_flex().flex_none().gap(6).items_center().text_size(12)
          .child(div().text_color(t.ansi2).child(`+${add}`))
          .child(div().text_color(t.ansi1).child(`−${del}`))
          .when(files > 0, (e) => e.child(div().text_color(t.muted).child(`· ${files} file${files === 1 ? "" : "s"}`))))
        .child(div().flex_1())
        .when(this.tab === "files", (e) => e.child(h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border).text_size(11.5)
          .children([["unified", "Unified", false], ["split", "Split", true]].map(([id, label, on]) =>
            div().id(`view-${id}`).px(8).h_full().flex().items_center().rounded(4).cursor_pointer()
              .when(this.split === on, (x) => x.bg(t.selected).text_color(t.foreground))
              .when(this.split !== on, (x) => x.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => this.setView(on, cx))
              .child(label)))))));

    // Tabs: Description, Files (with how many are viewed), Comments (with how many are open).
    const viewed = this.viewedCount();
    const counts = {
      desc: null,
      files: [`${viewed}/${this.files.length}`, viewed === this.files.length && this.files.length ? t.ansi2 : null],
      comments: [tc.all + (this.conversation?.length ?? 0) ? `${tc.open} open` : "0", tc.open ? t.blocked : null],
      agent: this.drafts?.list?.length ? [String(this.drafts.list.length), null] : null,
    };
    const tabBar = div().flex_none().px(18).border_b(1).border_color(t.border).child(h_flex().w_full().gap(2)
      .children(TABS.map(([id, label], i) => {
        const on = this.tab === id;
        const count = counts[id];
        return h_flex().id(`pt-${id}`).px(10).h(34).gap(7).items_center().cursor_pointer().mb(-1)
          .border_b(2).border_color(on ? t.accent : "#00000000")
          .text_size(12.5).text_color(on ? t.foreground : t.muted)
          .when(on, (x) => x.font_semibold())
          .when(!on, (x) => x.hover((s) => s.text_color(t.foreground)))
          .tooltip(`${label} (${i + 1})`)
          .on_click((_e, cx) => { this.setTab(id); cx.notify(); })
          .child(div().child(label))
          .when(Boolean(count), (x) => x.child(chip(count[0], count[1] ?? (on ? t.accent : t.muted))));
      })));

    const note = !current ? null
      : current.binary ? "Binary file changed"
      : !current.lines.length ? (current.status === "R" ? "Renamed without changes" : "No text diff")
      : current.lines.length > MAX_LINES ? `Showing the first ${MAX_LINES} lines` : null;

    const body = cleanBody(info?.body);
    const description = this.pager("desc", t, div().px(24).py(16)
      .child(h_flex().items_start().w_full().max_w(1180).mx_auto()
        .child(div().flex_1().min_w(0).max_w(860).child(body
          ? this.richBody(body, "desc", t)
          : div().text_color(t.dim).child(this.loading ? "Loading…" : "No description.")))
        .child(this.metaColumn(t))));

    const items = (this.splitHere ? this.splitItems : this.unifiedItems) ?? [];
    // Each file (and view) scrolls on its own, starting at the top.
    const scrollId = `pr-diff-${this.uid}-${this.splitHere ? "s" : "u"}-${this.open}`;
    // A virtual list places rows by height: a code row is 20px per wrapped line, a thread its estimate.
    const n = this.cols();
    const sizes = items.map((it) => this.rowHeight(it, n));
    this.sizes = sizes;
    const viewedHere = this.isViewed(current);
    if (this.toTop) {
      this.toTop = false;
      cx.timer.after(0, (cx) => { this.scroller.scroll_to_item(0, "top"); cx.notify(); });
    }
    const diff = v_flex().flex_1().min_w(0).h_full()
      .child(h_flex().h(30).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border).text_size(11.5).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child(current ? (current.status === "R" ? `${current.from} → ${current.path}` : current.path) : ""))
        .when(Boolean(current && this.changes), (e) => e.child(div().id("zed-here").flex_none().px(8).h(22).flex().items_center().rounded(5).cursor_pointer()
          .border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.openInZed(current.path)).child("Open in Zed")))
        .when(Boolean(current), (e) => e.child(div().id("viewed-here").flex_none().px(8).h(22).flex().items_center().gap(5).rounded(5).cursor_pointer()
          .border_1().border_color(viewedHere ? t.ansi2 : t.border).text_color(viewedHere ? t.ansi2 : t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.markViewed(current.path, false, !viewedHere); cx.notify(); })
          .when(viewedHere, (x) => x.child(svg("mods/workspace-chrome/check.svg").size(11).text_color(t.ansi2)))
          .child(div().child(this.changes ? (viewedHere ? "Viewed" : "Mark viewed") : viewedHere ? "Viewed" : "Mark viewed")))))
      .when(Boolean(note), (e) => e.child(div().px(12).py(6).text_size(11.5).text_color(t.dim).child(note)))
      .child(div().id(`pr-diff-box-${this.uid}`).flex_1().min_h(0).relative().overflow_hidden().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
        .on_size_change((size, cx) => { if (Math.abs(size.width - this.codeW) >= 1) { this.codeW = size.width; cx.notify(); } })
        .child(v_virtual_list(scrollId, items.length, sizes, (i) => `${this.open}:${items[i].key}`, (range) => {
          // It draws only what's on screen: that range is what ctrl-d/ctrl-u move from.
          this.shown = { min: range.start, max: Math.max(range.start, range.end - 1) };
          // Scrolled past the end (the column got wider, so the lines wrap less): back to the last row.
          if (items.length > 0 && range.start >= items.length && !this.rescue) {
            this.rescue = true;
            cx.timer.after(0, () => { this.rescue = false; this.scroller.scroll_to_item(items.length - 1, "top"); cx.notify(); });
          }
          return items.slice(range.start, range.end).map((item, k) => {
            const h = sizes[range.start + k];
            return item.type === "thread" ? this.threadItem(item, t, h)
              : this.splitHere ? this.splitRow(item.r, t, n, h) : this.diffRow(item.r, t, n, h);
          });
        }).size_full().track_scroll(this.scroller)
          .on_item_click((key, cx) => this.toggleThread(key.slice(key.lastIndexOf(":th:") + 1), cx))
          .on_item_secondary_click((key) => this.openThread(key.slice(key.lastIndexOf(":th:") + 1))))
        .child(Scrollbar.vertical(scrollId).viewport_from_layout().absolute().inset_0()));

    const content = this.tab === "desc" ? description
      : this.tab === "comments" ? this.commentsView(t)
      : this.tab === "agent" ? this.draftsView(t)
      : h_flex().size_full().min_h(0).child(this.fileTree(t)).child(diff);

    // The key strip shows only while this pane has the keyboard.
    const focusedHere = this.handle.is_focused?.() ?? false;
    // Herdr moving its focus onto this pane (a tab picked, cmd-p, cmd-ctrl-a, a click in
    // the sidebar) gives it the keyboard too, so keys work without a click first.
    // review-prs (always shown) stamps each move in shared state; a hidden copy sees it once shown.
    const f = focused();
    const want = shared(FOCUS_KEY);
    const tabName = f && spaces().flatMap((s) => s.tabs).find((tb) => tb.id === f.tab)?.name;
    const herdrHere = Boolean(f?.pane) && want?.pane === f.pane && tabName === `#${this.number}`
      && panes().some((p) => p.pane === f.pane && p.mod === "pr-diff");
    if (herdrHere && this.focusStamp !== want.at) {
      this.focusStamp = want.at;
      // focus() can't run during render: timers run it right after.
      // Retried for a moment: cmd-p's picker hands the keyboard back as it closes, after us.
      const stamp = want.at;
      for (const ms of [0, 60, 150, 300, 600]) cx.timer.after(ms, (cx) => {
        const now = focused();
        if (this.focusStamp !== stamp || now?.pane !== want.pane || this.typing) return;
        if (!this.handle.is_focused()) { this.handle.focus(); cx.notify(); }
      });
    }
    const keyList = this.changes
      ? [["j/k", "file"], ["zz", "center"], ["v/enter", "viewed + next"], ["d/u", "half page"], ["gg/G", "top/bottom"], ["s", "unified/split"], ["t", "name/recent"], ["b", "hidden"], ["o", "open in Zed"], ["R", "reload"], ["esc", "close"]]
      : this.tab === "files"
      ? [["h/l 1-4", "tabs"], ["j/k", "file"], ["zz", "center"], ["v/enter", "viewed + next"], ["d/u", "half page"], ["gg/G", "top/bottom"], ["s", "unified/split"], ["r", "review"], ["o", "GitHub"], ["R", "reload"]]
      : this.tab === "agent"
      ? [["h/l 1-4", "tabs"], ["d/u", "half page"], ["gg/G", "top/bottom"], ["esc", "leave a field"], ["o", "GitHub"], ["R", "reload"]]
      : [["h/l 1-4", "tabs"], ["j/k", "scroll"], ["d/u", "half page"], ["gg/G", "top/bottom"], ["r", "review"], ["o", "GitHub"], ["R", "reload"]];
    const keys = h_flex().flex_none().px(14).h(24).gap(14).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .children(keyList.map(([k, what]) => h_flex().gap(5).child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(what))));

    return v_flex().id("pr-diff-root").size_full().min_h(0).when(!glassy(t), (e) => e.bg(t.background))
      // As an overlay it covers a terminal: solid, so the diff is not read over it.
      .when(Boolean(props()?.overlay), (e) => e.bg(t.popover))
      .text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { if (!this.typing) this.handle.focus(); cx.notify(); })
      .child(this.changes ? this.changesHeader(t) : header)
      .when(!this.changes, (e) => e.child(tabBar))
      .when(Boolean(this.error) && this.files.length > 0, (e) => e.child(div().px(14).py(4).text_size(11.5).text_color(t.blocked).child(this.error)))
      .child(div().flex_1().min_h(0).child(content))
      .when(focusedHere, (e) => e.child(keys));
  }
}
