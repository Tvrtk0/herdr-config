// A Claude Code session, read rather than scrolled in a terminal: its transcript drawn as a
// document (real headings, tables and code, your prompts as bubbles, tool calls folded to a
// line). The terminal stays beside it for typing, permissions and questions.
// props: { terminal } (the address of the terminal Claude runs in, e.g. "t8"), and `part`:
// "chat" draws the conversation, "side" the side panel (what is happening, the turn's steps,
// your messages), anything else both. The mod claude-steps is this same file, opened as the side;
// claude-reading is it too, opened as an overlay (reading mode, cmd-shift-r): the chat of the
// focused Claude session alone, Esc closes it.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, hc, home, appHome, props, theme, panes, readTextFile, nextCommand, settings, run, shared, setShared, focused, agents, closeOverlay, openOverlay, layout } from "herdr";

// Where the side pane asks the chat pane to scroll: { terminal, id, at }.
const JUMP_KEY = "claude-reader.jump";

const alpha = (c, a) => (c.length === 9 ? c.slice(0, 7) : c) + a;

// How much of the transcript's end is read at first; "Ranije" reads more.
const FIRST_BYTES = 8000000;
const MAX_BYTES = 48000000;

// The transcript's end as entries: what you typed (with its pictures), what Claude wrote, and
// each run of tool calls between them folded into one (with any pictures they returned and
// whether they failed). Also what is still running, and a question or permission it waits on.
// Pictures go to ~/.config/herdr-app/pr-images/reader, where Herdr's image() reads from.
// $1 file, $2 bytes from the end, $3 the pictures' folder.
const PARSE = String.raw`
import json, os, sys, base64, hashlib, struct, subprocess
path, want, imgdir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
os.makedirs(imgdir, exist_ok=True)
size = os.path.getsize(path)
with open(path, "rb") as fh:
    fh.seek(max(0, size - want))
    data = fh.read().decode("utf-8", "replace")
lines = data.split("\n")
if size > want: lines = lines[1:]
out = []
def short(s, n=90):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"
def what(name, i):
    if not isinstance(i, dict): return ""
    for k in ("description", "file_path", "path", "command", "pattern", "query", "skill", "url", "prompt"):
        v = i.get(k)
        if v:
            v = str(v)
            if k in ("file_path", "path"): v = v.rstrip("/").split("/")[-1]
            return short(v)
    return ""
def picture(block):
    src = block.get("source") or {}
    if src.get("type") != "base64" or not src.get("data"): return None
    raw = base64.b64decode(src["data"])
    kind = "png" if raw[:8] == b"\x89PNG\r\n\x1a\n" else "jpg" if raw[:2] == b"\xff\xd8" else None
    if not kind: return None
    name = hashlib.md5(raw).hexdigest()[:16] + "." + kind
    full = os.path.join(imgdir, name)
    if not os.path.exists(full):
        with open(full, "wb") as fh: fh.write(raw)
    w = h = 0
    if kind == "png": w, h = struct.unpack(">II", raw[16:24])
    else:
        try:
            o = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", full], capture_output=True, text=True).stdout
            w = int(o.split("pixelWidth:")[1].split()[0]); h = int(o.split("pixelHeight:")[1].split()[0])
        except Exception: pass
    return {"path": "pr-images/reader/" + name, "w": w, "h": h} if w and h else None
items_by_id = {}
used, done = [], set()
asked_at = spoke_at = None
# Every tool call as a step: its turn (which of your messages it answers), when it began and
# ended, whether it failed, and for an edit the file and how many lines came and went.
steps, turn, turn_text = [], 0, {}
def lines_of(v): return len(str(v).splitlines()) if v else 0
def change(name, i):
    if not isinstance(i, dict): return None
    f = i.get("file_path") or i.get("notebook_path")
    if not f: return None
    if name == "Write": return {"file": f, "add": lines_of(i.get("content")), "del": 0}
    if name == "Edit": return {"file": f, "add": lines_of(i.get("new_string")), "del": lines_of(i.get("old_string"))}
    if name == "MultiEdit":
        e = i.get("edits") or []
        return {"file": f, "add": sum(lines_of(x.get("new_string")) for x in e), "del": sum(lines_of(x.get("old_string")) for x in e)}
    if name == "NotebookEdit": return {"file": f, "add": lines_of(i.get("new_source")), "del": 0}
    return None
import re
agent_by_id = {}
for line in lines:
    try: r = json.loads(line)
    except Exception: continue
    if r.get("isSidechain"): continue
    # A background agent's report comes back as a queued <agent-message from="its id">.
    body0 = str(r.get("content") if r.get("type") == "queue-operation" else (r.get("attachment") or {}).get("prompt") if r.get("type") == "attachment" else "")
    if "<agent-message from=" in body0:
        m = re.search(r'<agent-message from="([^"]+)">', body0)
        item = agent_by_id.get(m.group(1)) if m else None
        if item and not item.get("said"):
            rep = body0.split("The report follows:", 1)[1] if "The report follows:" in body0 else ""
            rep = rep.split("</agent-message>", 1)[0]
            item["said"] = short(" ".join(l.strip() for l in rep.strip().splitlines()), 220)
        continue
    # A background agent's finish comes later as a queued <task-notification>.
    if r.get("type") == "queue-operation" and r.get("operation") == "enqueue" and "<task-notification>" in str(r.get("content")):
        body = str(r.get("content"))
        m = re.search(r"<tool-use-id>([^<]+)</tool-use-id>", body)
        item = items_by_id.get(m.group(1)) if m else None
        if item:
            st = re.search(r"<status>([^<]+)</status>", body)
            item["finished"] = True
            item["ended"] = r.get("timestamp")
            if st and st.group(1) != "completed": item["failed"] = True
        continue
    kind = r.get("type"); msg = r.get("message") or {}; c = msg.get("content"); uid = r.get("uuid") or str(len(out))
    if kind == "user":
        if r.get("isMeta"): continue
        if isinstance(c, list):
            results = [x for x in c if isinstance(x, dict) and x.get("type") == "tool_result"]
            if results:
                for x in results:
                    tid = x.get("tool_use_id"); done.add(tid)
                    item = items_by_id.get(tid)
                    if not item: continue
                    item["done"] = True
                    inner0 = x.get("content")
                    text0 = inner0 if isinstance(inner0, str) else " ".join(b.get("text", "") for b in (inner0 or []) if isinstance(b, dict))
                    if item.get("agent") and "Async agent launched" in text0:
                        item["bg"] = True
                        m = re.search(r"agentId: (\w+)", text0)
                        if m: agent_by_id[m.group(1)] = item
                    else:
                        if not item.get("finished"): item["ended"] = r.get("timestamp")
                        if item.get("agent") and text0.strip(): item["said"] = short(text0, 220)
                    if x.get("is_error"): item["failed"] = True
                    inner = x.get("content")
                    if isinstance(inner, list):
                        for b in inner:
                            if isinstance(b, dict) and b.get("type") == "image":
                                pic = picture(b)
                                if pic: item.setdefault("images", []).append(pic)
                continue
            pics = [p for p in (picture(x) for x in c if isinstance(x, dict) and x.get("type") == "image") if p]
            c = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
        else:
            pics = []
        t = (c or "").strip()
        if t.startswith("<command-name>"):
            nm = t.split("<command-name>")[1].split("</command-name>")[0].strip()
            ar = t.split("<command-args>")[1].split("</command-args>")[0].strip() if "<command-args>" in t else ""
            out.append({"k": "cmd", "id": uid, "name": nm, "args": ar}); continue
        if (not t and not pics) or t.startswith("<"): continue
        if t.startswith("[Request interrupted"):
            out.append({"k": "note", "id": uid, "text": "Prekinuto"}); continue
        asked_at = r.get("timestamp") or asked_at
        turn += 1
        turn_text[turn] = t[:140]
        out.append({"k": "you", "id": uid, "text": t, "images": pics})
    elif kind == "assistant" and isinstance(c, list):
        spoke_at = r.get("timestamp") or spoke_at
        for j, x in enumerate(c):
            if not isinstance(x, dict): continue
            if x.get("type") == "text" and x.get("text", "").strip():
                out.append({"k": "text", "id": f"{uid}-{j}", "text": x["text"]})
            elif x.get("type") == "tool_use":
                item = {"name": x.get("name", "tool"), "what": what(x.get("name"), x.get("input")), "turn": turn, "began": r.get("timestamp")}
                ch = change(x.get("name"), x.get("input"))
                if ch: item.update(ch)
                if x.get("name") in ("Agent", "Task"):
                    ai = x.get("input") if isinstance(x.get("input"), dict) else {}
                    item["agent"] = True
                    item["kind"] = ai.get("subagent_type") or "general-purpose"
                    item["bg"] = bool(ai.get("run_in_background"))
                    item["model"] = ai.get("model")
                items_by_id[x.get("id")] = item
                steps.append(item)
                used.append((x.get("id"), x.get("name"), x.get("input")))
                if out and out[-1]["k"] == "tools": out[-1]["items"].append(item)
                else: out.append({"k": "tools", "id": f"{uid}-{j}", "items": [item]})
pending = [{"name": n, "what": what(n, i), "input": i if n == "AskUserQuestion" else None} for (tid, n, i) in used[-8:] if tid not in done]
print(json.dumps({"entries": out[-400:], "partial": size > want, "size": size, "pending": pending, "askedAt": asked_at, "spokeAt": spoke_at, "steps": steps[-400:], "turns": {str(k): v for k, v in turn_text.items()}, "turn": turn}))
`;

// Prose and fenced code apart, so each code block can carry a copy button.
function pieces(text) {
  const out = [];
  const re = /^(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    const body = m[0].replace(/^[^\n]*\n/, "").replace(/\n[^\n]*$/, "");
    out.push({ code: true, text: m[0], body });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out.filter((p) => p.text.trim());
}

// Things worth copying out of the conversation: links (GitHub PRs and commits named as such),
// paths, commands and commit hashes, newest first, each once. Read from what you and Claude
// wrote: bare links anywhere, the rest only from `code` spans and shell blocks.
const CMD_WORDS = new Set(["git", "gh", "yarn", "npm", "npx", "pnpm", "node", "cd", "ls", "cat", "rtk", "brew", "hc", "herdr-app", "claude", "fnm", "python3", "make", "open", "curl", "rm", "mkdir", "cp", "mv", "ln", "sed", "grep", "rg", "find", "docker", "kubectl", "ssh", "zsh", "sh", "bash", "defaults", "xcrun", "pod", "bundle"]);
function refsOf(entries) {
  const seen = new Set(), out = [];
  const add = (kind, value, label) => {
    value = value.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ kind, value, label: label ?? value });
  };
  const kindOf = (v) => {
    if (/\s/.test(v)) {
      const first = v.split(/\s+/)[0];
      return CMD_WORDS.has(first) || /^\/[a-z][\w:-]*$/.test(first) ? "command" : null;
    }
    if (/^\/[a-z][\w:-]*$/.test(v) && !v.slice(1).includes("/")) return "command";
    if (/^[0-9a-f]{7,40}$/.test(v) && /\d/.test(v) && /[a-f]/.test(v)) return "commit";
    if (/^[0-9a-f]{7,12}\.\.\.?[0-9a-f]{7,12}$/.test(v)) return "commit";
    if (/^(~|\.{1,2})?\//.test(v) && v.length > 2) return "path";
    if (v.includes("/") && /\.[A-Za-z]{1,6}(:\d+)?$/.test(v) && !v.includes("://")) return "path";
    return null;
  };
  for (const x of [...entries].reverse()) {
    if (x.k !== "you" && x.k !== "text") continue;
    const text = x.text ?? "";
    for (const m of text.matchAll(/https?:\/\/[^\s<>()\[\]`"'*]+/g)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      const pr = url.match(/github\.com\/[^\s]+?\/([^/\s]+)\/pull\/(\d+)/);
      add("link", url, pr ? `${pr[1]} #${pr[2]}` : url.replace(/^https?:\/\//, ""));
    }
    for (const p of pieces(text)) {
      if (p.code) {
        const lang = (p.text.match(/^\S*[\x60~]{3,}\s*(\w*)/) ?? [])[1] ?? "";
        if (/^(sh|bash|zsh|shell|console)$/.test(lang) && p.body.trim().split("\n").length <= 8) add("command", p.body);
        continue;
      }
      for (const m of p.text.matchAll(/\x60([^\x60\n]{2,300})\x60/g)) {
        const v = m[1].trim();
        const k = kindOf(v);
        if (k) add(k, v);
      }
    }
    if (out.length >= 150) break;
  }
  return out;
}

export default class ClaudeReader extends View {
  init(_props, cx) {
    this.entries = [];
    this.heights = {};
    this.bytes = FIRST_BYTES;
    this.open = new Set();
    // Scrolling of our own: off from the top, the view and the content's heights; it follows
    // the end while you are at the end.
    this.st = { off: 0, view: 0, full: 0 };
    this.follow = true;
    this.handle = cx.focus_handle();
    if (props()?.overlay) { this.handle.focus(); cx.timer.after(150, () => this.handle.focus()); }
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        // From keys.json (claude-steps:refs, claude-steps:files): the footer's buttons by key.
        if (c === "refs") this.refsOpen = !this.refsOpen;
        if (c === "prev") this.prevOpen = !this.prevOpen;
        if (c === "files") this.toggleFiles();
        cx.notify();
      }
    });
    // The file changes as Claude writes: a cheap look every second and a half.
    cx.timer.every(1500, (cx) => this.poll(cx));
    cx.timer.every(1000, (cx) => { if (this.pane()?.status === "working") cx.notify(); });
    // The session can change (/clear, a resume): find it again now and then.
    cx.timer.every(30000, (cx) => { this.file = null; this.poll(cx); });
    this.poll(cx);
    // Pictures copied out of transcripts: anything untouched for three days goes; a picture
    // still in view is written again on the next read.
    exec("find", [`${appHome()}/pr-images/reader`, "-type", "f", "-mtime", "+3", "-delete"]).catch(() => {});
    this.diffs = {};
  }

  // A changed file's diff, from git in the file's folder (an untracked file against nothing).
  loadDiff(f, cx) {
    if (this.diffs[f]) return;
    this.diffs[f] = { loading: true };
    cx.spawn(async (cx) => {
      const dir = f.split("/").slice(0, -1).join("/") || "/";
      let r = await exec("git", ["-C", dir, "diff", "--no-color", "-U2", "HEAD", "--", f]);
      if (r.code === 0 && !r.stdout.trim()) r = await exec("git", ["-C", dir, "diff", "--no-color", "--no-index", "/dev/null", f]);
      const text = (r.stdout ?? "").trim();
      this.diffs[f] = text
        ? { lines: text.split("\n").filter((l) => !["diff --git", "index ", "--- ", "+++ ", "new file mode"].some((h) => l.startsWith(h))) }
        : { error: r.code !== 0 && r.code !== 1 ? "Not in a git repo" : "No difference" };
      cx.notify();
    });
  }

  // The session's terminal: given, or in reading mode the focused one (its pane's, else the
  // first agent's).
  terminal() {
    if (props()?.terminal) return props().terminal;
    if (!this.chosen) {
      const f = focused();
      const pane = panes().find((p) => p.pane === f?.pane);
      this.chosen = f?.terminal ?? (pane?.app === "claude-code" ? pane.terminal : null)
        ?? panes().find((p) => p.tab === f?.tab && p.app === "claude-code")?.terminal
        ?? agents()[0]?.address ?? null;
    }
    return this.chosen;
  }

  pane() {
    return panes().find((p) => p.terminal === this.terminal()) ?? null;
  }

  async findFile() {
    const got = await hc(["get", this.terminal() ?? "", "--json"]);
    const pid = got.code === 0 ? JSON.parse(got.stdout)?.foreground?.pid : null;
    const session = pid ? JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`)) ?? "null") : null;
    if (!session?.sessionId || !session?.cwd) return null;
    return `${home()}/.claude/projects/${session.cwd.replace(/[^A-Za-z0-9]/g, "-")}/${session.sessionId}.jsonl`;
  }

  poll(cx, force = false) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.file) { this.file = await this.findFile(); force = true; }
        if (this.file) {
          const sid = this.file.split("/").pop().replace(/\.jsonl$/, "");
          this.line = JSON.parse((await readTextFile(`${home()}/.claude/state/statusline/${sid}.json`)) ?? "null");
          this.ask = JSON.parse((await readTextFile(`${home()}/.claude/state/ask-mode/${this.terminal()}.json`)) ?? "null");
          const st = await exec("stat", ["-f", "%m %z", this.file]);
          const stamp = st.stdout.trim();
          if (force || stamp !== this.stamp) {
            this.stamp = stamp;
            const r = await exec("python3", ["-I", "-c", PARSE, this.file, String(this.bytes), `${appHome()}/pr-images/reader`]);
            if (r.code === 0) {
              const got = JSON.parse(r.stdout);
              this.entries = got.entries;
              this.refs = refsOf(got.entries);
              this.partial = got.partial;
              this.pending = got.pending ?? [];
              this.steps = got.steps ?? [];
              this.turnText = got.turns ?? {};
              this.turnNow = got.turn ?? 0;
              this.askedAt = got.askedAt ? Date.parse(got.askedAt) : null;
              // The plan Claude keeps for this request (the plan-steps mod writes it).
              this.plan = JSON.parse((await readTextFile(`${home()}/.claude/state/plan/${this.terminal()}.json`)) ?? "null");
              this.spokeAt = got.spokeAt ? Date.parse(got.spokeAt) : null;
              // What each slash command printed: reader-quiet keeps it, as the transcript does not.
              const log = (await readTextFile(`${home()}/.claude/state/reader/${this.terminal()}.commands.jsonl`)) ?? "";
              this.commandOut = log.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
              this.error = null;
            } else this.error = r.stderr.trim().split("\n").pop();
          }
        } else this.error = "No Claude session found for this terminal.";
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  scrollBy(dy) {
    const st = this.st;
    const max = Math.max(0, st.full - st.view);
    st.off = Math.max(0, Math.min(max, st.off + dy));
    this.follow = st.off >= max - 2;
  }

  // Keyboard scrolling (d/u, gg/G) glides to where it is going over ~150ms (ease-out); a
  // second press mid-glide adds to the goal.
  glide(cx, dy) {
    // A held key repeats faster than a glide lasts: each repeat jumps at once instead.
    if (this.held) { const to = (this.goal ?? this.st.off) + dy; this.stopGlide(); this.scrollBy(to - this.st.off); return; }
    const st = this.st;
    const max = Math.max(0, st.full - st.view);
    const goal = Math.max(0, Math.min(max, (this.goal ?? st.off) + dy));
    const from = st.off;
    this.goal = goal;
    const id = (this.anim = (this.anim ?? 0) + 1);
    const FRAMES = 9;
    for (let k = 1; k <= FRAMES; k++) {
      cx.timer.after(k * 16, (cx) => {
        if (this.anim !== id) return;
        const x = k / FRAMES;
        this.scrollBy(from + (goal - from) * (1 - Math.pow(1 - x, 3)) - st.off);
        if (k === FRAMES) this.goal = null;
        cx.notify();
      });
    }
  }

  // The wheel and trackpad move at once and stop any glide.
  stopGlide() {
    this.anim = (this.anim ?? 0) + 1;
    this.goal = null;
  }

  onKey(e, cx) {
    const m = e.modifiers ?? {};
    if (e.key === "escape" && props()?.overlay) { cx.stop_propagation(); closeOverlay(props().overlay); return; }
    if (m.platform || m.alt) return;
    const key = e.key_char ?? e.key;
    const half = Math.max(80, this.st.view / 2);
    this.held = !!e.is_held;
    const act = m.control
      ? { d: () => this.glide(cx, half), u: () => this.glide(cx, -half) }[key]
      : {
          j: () => { this.stopGlide(); this.scrollBy(60); },
          k: () => { this.stopGlide(); this.scrollBy(-60); },
          d: () => this.glide(cx, half),
          u: () => this.glide(cx, -half),
          G: () => this.glide(cx, 1e9),
          g: () => { if (Date.now() - (this.lastG ?? 0) < 1000) { this.glide(cx, -1e9); this.lastG = 0; } else this.lastG = Date.now(); },
        }[key];
    if (!act) return;
    cx.stop_propagation();
    act();
    cx.notify();
  }

  // A picture at most this wide, keeping its shape.
  picture(p, maxW, t) {
    const w = Math.min(maxW, p.w), h = Math.round((p.h * w) / p.w);
    return div().id(`rd-img-${p.path}`).flex_none().rounded(8).overflow_hidden().border_1().border_color(t.border).cursor_pointer()
      .tooltip("Open")
      .on_click(() => exec("open", [`${appHome()}/${p.path}`]).catch(() => {}))
      .child(image(p.path).w(w).h(h));
  }

  you(x, t) {
    const text = (x.text ?? "").replace(/\[Image #\d+\]\s*/g, "").trim();
    return h_flex().w_full().justify_end().child(
      v_flex().max_w(620).gap(8).px(14).py(10).rounded(14).bg(alpha(t.accent, "24")).border_1().border_color(alpha(t.accent, "40"))
        .text_size(13.5).text_color(t.foreground)
        .when((x.images ?? []).length > 0, (e) => e.child(h_flex().gap(8).flex_wrap().children(x.images.map((p) => this.picture(p, 280, t)))))
        .when(Boolean(text), (e) => e.child(TextView.markdown(`rd-you-${x.id}`, text).selectable(true))));
  }

  copy(text, key, cx) {
    exec("zsh", ["-c", 'printf %s "$1" | pbcopy', "zsh", text]).catch(() => {});
    this.copied = key;
    cx.timer.after(1500, (cx) => { if (this.copied === key) { this.copied = null; cx.notify(); } });
  }

  text(x, t) {
    const link = (v) => v.on_link_click((url) => exec("open", [url]).catch(() => {}));
    return v_flex().w_full().gap(10).text_size(14).text_color(t.foreground)
      .children(pieces(x.text).map((p, i) => {
        const key = `${x.id}-${i}`;
        if (!p.code) return link(TextView.markdown(`rd-${key}`, p.text).selectable(true));
        return div().w_full().relative()
          .child(link(TextView.markdown(`rd-${key}`, p.text).selectable(true)))
          .child(div().id(`rd-copy-${key}`).absolute().top(8).right(8).px(8).h(22).flex().items_center().rounded(6)
            .bg(t.popover).border_1().border_color(t.border).text_size(11).text_color(this.copied === key ? t.ansi2 : t.muted)
            .cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.copy(p.body, key, cx); cx.notify(); })
            .child(this.copied === key ? "Copied" : "Copy"));
      }));
  }

  tools(x, t) {
    const open = this.open.has(x.id);
    const names = [...new Set(x.items.map((i) => i.name))];
    const n = x.items.length;
    const failed = x.items.filter((i) => i.failed).length;
    const pics = x.items.flatMap((i) => i.images ?? []);
    return v_flex().w_full().gap(6)
      .child(h_flex().id(`rd-tools-${x.id}`).gap(8).items_center().cursor_pointer().text_size(12).text_color(t.dim)
        .hover((s) => s.text_color(t.muted))
        .on_click((_e, cx) => { open ? this.open.delete(x.id) : this.open.add(x.id); cx.notify(); })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.dim))
        .child(div().child(`${n} ${n === 1 ? "tool" : "tools"}`))
        .child(div().min_w(0).truncate().child(`· ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}`))
        .when(failed > 0, (e) => e.child(div().flex_none().text_color(t.ansi1).child(`· ${failed} failed`))))
      .when(open, (e) => e.child(v_flex().pl(19).gap(3).text_size(12)
        .children(x.items.map((i) => h_flex().gap(8).min_w(0)
          .child(div().flex_none().w(84).text_color(i.failed ? t.ansi1 : t.muted).child(i.name))
          .child(div().min_w(0).truncate().text_color(t.dim).child(i.what))))))
      .when(pics.length > 0, (e) => e.child(h_flex().pl(19).gap(8).flex_wrap().children(pics.slice(-4).map((p) => this.picture(p, 240, t)))));
  }

  // A slash command you ran, with what it printed when reader-quiet caught it.
  command(x, t, outFor) {
    const out = outFor.get(x.id);
    return v_flex().w_full().items_end().gap(4)
      .child(div().px(8).h(22).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12)
        .font_family(settings().font_family ?? "JetBrains Mono").text_color(t.muted).child(`${x.name}${x.args ? ` ${x.args}` : ""}`))
      .when(Boolean(out), (e) => e.child(div().max_w(620).text_size(12).text_color(out.errored ? t.ansi1 : t.dim)
        .child(TextView.markdown(`rd-cmd-${x.id}`, out.text).selectable(true))));
  }

  // In the chat a run of tool calls leaves only what it showed: its pictures.
  toolPictures(x, t) {
    const pics = x.items.flatMap((i) => i.images ?? []);
    if (!pics.length) return div();
    return h_flex().gap(8).flex_wrap().children(pics.slice(-4).map((p) => this.picture(p, 260, t)));
  }

  // Scrolls the chat so an entry sits near the top: the measured heights above it, the gaps
  // between entries and the page's top padding.
  jumpTo(id) {
    const GAP = 24;
    let y = 22 + (this.partial ? 26 + GAP : 0);
    for (const x of this.entries) {
      if (x.id === id) break;
      y += (this.heights[x.id] ?? 0) + GAP;
    }
    const st = this.st;
    st.off = Math.max(0, Math.min(Math.max(0, st.full - st.view), y - 12));
    this.follow = st.off >= Math.max(0, st.full - st.view) - 2;
  }

  // One step as a quiet line: how it ended, the tool, what it did, lines changed, how long.
  stepLine(i, t, status) {
    const running = !i.done && status === "working";
    const dur = (a, b) => {
      if (!a) return "";
      const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    };
    return h_flex().gap(8).items_start().py(2).text_size(12).min_w(0)
      .child(div().pt(1).flex_none().w(12).child(running
        ? svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900)
        : div().text_color(i.failed ? t.ansi1 : i.done ? t.ansi2 : t.dim).child(i.failed ? "✗" : i.done ? "✓" : "·")))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).min_w(0)
          .child(div().flex_none().font_medium().text_color(i.failed ? t.ansi1 : running ? t.working : t.muted).child(i.name))
          .child(div().flex_1())
          .when(Boolean(i.file && (i.add || i.del)), (e) => e.child(h_flex().flex_none().gap(4).text_size(11)
            .child(div().text_color(t.ansi2).child(`+${i.add ?? 0}`)).child(div().text_color(t.ansi1).child(`−${i.del ?? 0}`))))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(dur(i.began, i.ended))))
        .when(Boolean(i.what), (e) => e.child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(i.what))));
  }

  // Where an entry starts in the chat: the measured heights above it, the gaps between entries
  // and the page's top padding (as jumpTo).
  topOf(id) {
    const GAP = 24;
    let y = 22 + (this.partial ? 26 + GAP : 0);
    for (const x of this.entries) {
      if (x.id === id) break;
      y += (this.heights[x.id] ?? 0) + GAP;
    }
    return y;
  }

  // Reading mode's slim list of your prompts: a click glides the chat to that prompt, and the
  // one you are reading under is marked.
  toc(t) {
    const you = this.entries.filter((x) => x.k === "you");
    if (!you.length) return div();
    const st = this.st;
    // About two lines of the panel: the start of the prompt, images left out.
    const short = (text) => {
      const one = (text ?? "").replace(/\[Image #\d+\]\s*/g, "").replace(/\s+/g, " ").trim();
      return !one ? "Image" : one.length > 72 ? `${one.slice(0, 70).trimEnd()}…` : one;
    };
    let here = you[0].id;
    for (const x of you) { if (this.topOf(x.id) - 12 <= st.off + 40) here = x.id; }
    // At the end of the chat the last prompt is the one in view.
    if (this.follow) here = you[you.length - 1].id;
    return v_flex().id("rd-toc").w(250).flex_none().h_full().min_h(0).border_r(1).border_color(t.border).overflow_y_scrollbar()
      .child(v_flex().px(10).py(14).gap(2)
        .child(div().px(8).pb(6).text_size(11).font_semibold().text_color(t.dim).child(`PROMPTS · ${you.length}`))
        .children(you.map((x) => {
          const on = x.id === here;
          return div().id(`rd-tc-${x.id}`).px(8).py(6).rounded(6).cursor_pointer().text_size(12)
            .when(on, (el) => el.bg(t.selected))
            .hover((sx) => sx.bg(t.hover))
            .on_click((_e, cx) => { this.glide(cx, Math.max(0, this.topOf(x.id) - 12) - (this.goal ?? st.off)); cx.notify(); })
            .child(div().text_color(on ? t.foreground : t.muted).child(short(x.text)));
        })));
  }

  // The side panel, beside the Claude terminal: where the request stands (state, the step it
  // is on), Claude's plan in plain words (from the plan-steps mod: done steps with what they
  // produced, the active one with the tool running under it), and once it is finished a card
  // of what was done, whether it was tested, what is left for you and the files changed.
  // Without a plan (a short request) the turn's tools stand in for it.
  // The Files panel on the right of the window, open or closed.
  filesOpen() {
    const findIn = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((f, c) => f ?? findIn(c, id), null));
    const lay = layout(), panel = findIn(lay, "panel"), body = findIn(lay, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "files");
  }
  toggleFiles() {
    if (this.filesOpen()) run("layout.hide", { id: "panel" });
    else { run("layout.select", { stack: "panel-body", child: "files" }); run("layout.show", { id: "panel" }); }
  }

  side(t, status, alone = false) {
    const asked = this.askedAt ?? 0;
    const plan = this.plan ?? {};
    const wrap = (plan.wrapAt ?? 0) >= asked ? plan.wrap : null;
    // A plan still under way stays current through a message you send mid-turn.
    const live = (plan.stepsAt ?? 0) >= asked || (status === "working" && !plan.wrap && Boolean(plan.steps?.length));
    // The request before this one, folded to a line (the mod keeps it; an older file's plan
    // from before this prompt counts too).
    const prev = plan.prev ?? (!live && plan.steps?.length ? { steps: plan.steps, wrap: plan.wrapAt >= plan.stepsAt ? plan.wrap : null } : null);
    // What Claude waits on: its questions, or a permission for a tool.
    const pend = this.pending ?? [];
    const askQ = status === "blocked" ? pend.find((x) => x.name === "AskUserQuestion" && x.input?.questions)?.input.questions ?? null : null;
    const permit = status === "blocked" && !askQ ? pend.at(-1) ?? null : null;
    // Once wrapped up, no step is still under way.
    const steps = (live ? plan.steps ?? [] : [])
      .map((x) => wrap && (x.status === "active" || x.status === "pending") ? { ...x, status: "done" } : x);
    const tools = (this.steps ?? []).filter((x) => x.turn === (this.turnNow ?? 0) && !String(x.name).startsWith("mcp__plan-steps"));
    const working = status === "working";
    const agentsNow = tools.filter((x) => x.agent);
    const plainTools = tools.filter((x) => !x.agent);
    const nowTool = working ? [...tools].reverse().find((x) => !x.done) ?? null : null;
    const doneN = steps.filter((x) => x.status === "done").length;
    const active = steps.find((x) => x.status === "active");
    const files = new Map();
    for (const x of tools) {
      if (!x.file) continue;
      const f = files.get(x.file) ?? { add: 0, del: 0 };
      f.add += x.add ?? 0; f.del += x.del ?? 0;
      files.set(x.file, f);
    }
    const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
    const took = asked ? dur((working ? Date.now() : (this.spokeAt ?? Date.now())) - asked) : "";
    const label = (text) => div().text_size(11).font_semibold().text_color(t.dim).child(text);
    const stateColor = working ? t.working : status === "blocked" ? t.blocked : t.ansi2;
    const stateText = working ? "Working" : status === "blocked" ? "Needs you" : "Done";
    // What the card says under the state: the active step, else Claude's own last words.
    let said = null;
    for (const x of [...this.entries].reverse()) { if (x.k === "you") break; if (x.k === "text") { said = x.text; break; } }
    const lead = status === "blocked" ? "Waiting for your answer or permission in the terminal."
      : working && active ? active.title
      : sentence(said);
    const mono = settings().font_family ?? "JetBrains Mono";

    // Claude's first words as a lead: its first paragraph up to a sentence's end that fits,
    // else cut at a word with an ellipsis, never mid-word.
    function sentence(text) {
      const para = ((text ?? "").split(/\n\s*\n/)[0] ?? "").replace(/[*`#>]/g, "").replace(/\s+/g, " ").trim();
      if (para.length <= 220) return para;
      const cut = para.slice(0, 220);
      const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
      return end > 60 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "") + "…";
    }

    const stepRow = (x, k) => {
      const on = x.status === "active";
      const icon = x.status === "done" ? div().text_color(t.ansi2).child("✓")
        : x.status === "failed" ? div().text_color(t.ansi1).child("✗")
        : on && working ? svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900)
        : on ? div().size(7).mt(4).rounded(4).bg(t.working)
        : div().size(7).mt(4).rounded(4).border_1().border_color(t.dim);
      return h_flex().id(`sd-st-${k}`).gap(10).items_start().px(10).py(7).rounded(8)
        .when(on, (e) => e.bg(alpha(t.working, "14")))
        .child(div().flex_none().w(12).pt(1).flex().justify_center().child(icon))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(12.5).text_color(on ? t.foreground : x.status === "pending" ? t.dim : t.muted).when(on, (e) => e.font_medium()).child(x.title ?? ""))
          .when(Boolean(x.result) && x.status !== "pending", (e) => e.child(div().text_size(11.5).text_color(x.status === "failed" ? t.ansi1 : t.dim).child(x.result)))
          .when(on && Boolean(nowTool), (e) => e.child(h_flex().gap(6).min_w(0).text_size(11).text_color(t.dim)
            .child(div().flex_none().text_color(t.working).child(nowTool.name))
            .child(div().min_w(0).truncate().child(nowTool.what ?? "")))));
    };

    const testedChip = (w) => {
      const m = { yes: [t.ansi2, "Tested"], failed: [t.ansi1, "Tests failed"], no: [t.working, "Not tested"], "n/a": [t.dim, "No tests"] }[w.tested] ?? [t.dim, "?"];
      return h_flex().gap(6).items_center().px(8).h(22).rounded(11).bg(alpha(m[0], "1f")).text_size(11).text_color(m[0])
        .child(div().size(6).rounded(3).bg(m[0]))
        .child(div().child(w.testedHow ? `${m[1]} · ${w.testedHow}` : m[1]));
    };

    // Built a section at a time: QuickJS refuses one chain this long.
    let col = v_flex().p(16).gap(18);
    col = col
        // Where it stands
        .child(v_flex().gap(8).p(12).rounded(10).border_1().border_color(alpha(stateColor, "59")).bg(alpha(stateColor, "0f"))
          .child(h_flex().gap(8).items_center()
            .child(working ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(stateColor).spin(900) : div().size(7).rounded(4).bg(stateColor))
            .child(div().text_size(12.5).font_semibold().text_color(stateColor).child(stateText))
            .child(div().flex_1())
            .when(steps.length > 0, (e) => e.child(div().text_size(11).text_color(t.muted).child(`${doneN}/${steps.length}`)))
            .when(Boolean(took), (e) => e.child(div().text_size(11).text_color(t.dim).child(took))))
          .when(steps.length > 0, (e) => e.child(div().h(4).w_full().rounded(2).bg(t.raised).overflow_hidden()
            .on_size_change((size, cx) => { if (Math.abs(size.width - (this.barW ?? 0)) >= 1) { this.barW = size.width; cx.notify(); } })
            .child(div().h_full().rounded(2).bg(stateColor).w(Math.max(4, Math.round((this.barW ?? 300) * doneN / steps.length))))))
          .when(Boolean(lead), (e) => e.child(div().text_size(12.5).text_color(t.foreground).child(lead))));
    col = col
        // What it waits on
        .when(status === "blocked", (e) => e.child(v_flex().gap(12).p(12).rounded(10).border_1().border_color(alpha(t.blocked, "73")).bg(alpha(t.blocked, "12"))
          .child(h_flex().gap(8).items_center().text_size(11).font_semibold().text_color(t.blocked)
            .child(div().size(7).rounded(4).bg(t.blocked))
            .child(div().child(askQ ? (askQ.length > 1 ? `NEEDS YOU · ${askQ.length} QUESTIONS` : "NEEDS YOU · QUESTION") : "NEEDS YOU · PERMISSION")))
          .when(Boolean(askQ), (el) => el.children(askQ.map((q, qi) => v_flex().gap(6)
            .child(h_flex().gap(6).items_center()
              .when(Boolean(q.header), (x) => x.child(div().px(6).h(18).flex().items_center().rounded(5).bg(alpha(t.blocked, "26")).text_size(10.5).text_color(t.blocked).child(q.header)))
              .when(Boolean(q.multiSelect), (x) => x.child(div().text_size(10.5).text_color(t.dim).child("pick several"))))
            .child(div().text_size(13).font_medium().text_color(t.foreground).child(q.question))
            .children((q.options ?? []).map((o, oi) => h_flex().gap(8).items_start()
              .child(div().flex_none().w(18).h(18).rounded(9).flex().items_center().justify_center().bg(t.raised).text_size(10.5).text_color(t.muted).child(String(oi + 1)))
              .child(v_flex().flex_1().min_w(0).gap(1)
                .child(div().text_size(12.5).text_color(t.foreground).child(o.label))
                .when(Boolean(o.description), (x) => x.child(div().text_size(11.5).text_color(t.dim).child(o.description)))))))))
          .when(Boolean(permit), (el) => el.child(v_flex().gap(4)
            .child(div().text_size(13).font_medium().text_color(t.foreground).child(`Claude wants to run ${permit.name}`))
            .when(Boolean(permit.what), (x) => x.child(div().px(8).py(6).rounded(6).bg(t.raised).font_family(mono).text_size(11.5).text_color(t.muted).child(permit.what)))))
          .child(div().text_size(11).text_color(t.dim).child("Answer in the terminal on the left."))));
    col = col
        // The plan
        .when(steps.length > 0, (e) => e.child(v_flex().gap(4)
          .child(label("PLAN"))
          .child(v_flex().gap(1).children(steps.map(stepRow)))));
    col = col
        // No plan: the turn's tools, the last few
        .when(!steps.length && plainTools.length > 0 && !wrap, (e) => e.child(v_flex().gap(2)
          .child(label(`ALATI · ${plainTools.length}`))
          .children(plainTools.slice(-6).map((i) => this.stepLine(i, t, status)))));
    col = col
        // Subagents of this request: what each does, its kind, running or done and how long
        .when(agentsNow.length > 0, (e) => e.child(v_flex().gap(4)
          .child(label(`AGENTS · ${agentsNow.length}`))
          .children(agentsNow.map((a, k) => {
            // A background agent runs until its notification, even after Claude's turn ends.
            const run = a.bg ? !a.finished : !a.done && working;
            const tone = a.failed ? t.ansi1 : run ? t.working : t.ansi2;
            const state = a.failed ? "Failed" : run ? (a.bg ? "Working in background" : "Working") : "Done";
            const time = a.began ? dur((a.ended && !run ? Date.parse(a.ended) : Date.now()) - Date.parse(a.began)) : "";
            const chip = (text) => div().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(10.5).text_color(t.muted).child(text);
            const model = a.model ? a.model[0].toUpperCase() + a.model.slice(1) : null;
            return v_flex().id(`sd-ag-${k}`).gap(8).p(12).rounded(10)
              .border_1().border_color(run ? alpha(t.working, "59") : t.border)
              .bg(run ? alpha(t.working, "0d") : t.raised)
              // Top: state and time
              .child(h_flex().gap(7).items_center()
                .child(run ? svg("mods/workspace-chrome/spinner.svg").size(11).text_color(tone).spin(900) : div().size(7).rounded(4).bg(tone))
                .child(div().text_size(11).font_medium().text_color(tone).child(state))
                .child(div().flex_1())
                .when(Boolean(time), (e) => e.child(div().text_size(11).text_color(t.dim).child(time))))
              // What it was asked to do
              .child(div().text_size(13).font_medium().text_color(run ? t.foreground : t.muted).child(a.what || "Subagent"))
              // Kind and model
              .child(h_flex().gap(5).child(chip(a.kind)).when(Boolean(model), (e) => e.child(chip(model))))
              // What it answered, once done
              .when(Boolean(a.said) && !run, (e) => e.child(div().pl(10).border_l(2).border_color(alpha(tone, "66"))
                .text_size(11.5).text_color(t.dim).child(a.said)));
          }))));
    col = col
        // What was done
        .when(Boolean(wrap), (e) => e.child(v_flex().gap(10).p(12).rounded(10).border_1().border_color(t.border).bg(t.raised)
          .child(h_flex().gap(8).items_center().child(label("DONE")).child(div().flex_1()).child(testedChip(wrap)))
          .child(v_flex().gap(5).children((wrap.done ?? []).map((line) => h_flex().gap(8).items_start().text_size(12.5)
            .child(div().flex_none().text_color(t.ansi2).child("•"))
            .child(div().flex_1().min_w(0).text_color(t.foreground).child(String(line))))))
          .when(Boolean(wrap.forYou), (el) => el.child(v_flex().gap(3).p(10).rounded(8).bg(alpha(t.blocked, "1a")).border_1().border_color(alpha(t.blocked, "4d"))
            .child(div().text_size(11).font_semibold().text_color(t.blocked).child("FOR YOU"))
            .child(div().text_size(12.5).text_color(t.foreground).child(wrap.forYou))))));
    col = col
        // Files changed in this request
        .when(files.size > 0, (e) => e.child(v_flex().gap(4)
          .child(label(`FILES · ${files.size}`))
          .children([...files].map(([f, c], k) => {
            const open = this.fileOpen === f;
            const d = this.diffs?.[f];
            return v_flex().gap(4)
              .child(h_flex().id(`sd-f-${k}`).gap(8).items_center().px(10).py(4).rounded(6).text_size(11.5).cursor_pointer()
                .when(open, (x) => x.bg(t.selected)).hover((x) => x.bg(t.hover))
                .on_click((_e, cx) => { this.fileOpen = open ? null : f; if (!open) this.loadDiff(f, cx); cx.notify(); })
                .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
                .child(h_flex().flex_1().min_w(0).gap(6).tooltip(f)
                  .child(div().flex_none().font_family(mono).text_color(t.muted).child(f.split("/").pop()))
                  .child(div().min_w(0).truncate().text_color(t.dim).child(f.split("/").slice(-3, -1).join("/"))))
                .child(div().flex_none().text_color(t.ansi2).child(`+${c.add}`))
                .child(div().flex_none().text_color(t.ansi1).child(`−${c.del}`)))
              .when(open, (x) => x.child(v_flex().mx(10).py(6).rounded(6).border_1().border_color(t.border).bg(t.raised).overflow_hidden()
                .font_family(mono).text_size(11)
                .when(!d || d.loading, (y) => y.child(div().px(10).text_color(t.dim).child("Loading…")))
                .when(Boolean(d?.error), (y) => y.child(div().px(10).text_color(t.dim).child(d.error)))
                .when(Boolean(d?.lines), (y) => y
                  .children(d.lines.slice(0, 120).map((l) => {
                    const add = l.startsWith("+"), del = l.startsWith("-"), hunk = l.startsWith("@@");
                    return div().px(10).min_w(0).truncate()
                      .when(add, (z) => z.bg(alpha(t.ansi2, "1a")).text_color(t.ansi2))
                      .when(del, (z) => z.bg(alpha(t.ansi1, "1a")).text_color(t.ansi1))
                      .when(hunk, (z) => z.text_color(t.dim).mt(4))
                      .when(!add && !del && !hunk, (z) => z.text_color(t.muted))
                      .child(l || " ");
                  }))
                  .when(d.lines.length > 120, (y) => y.child(div().px(10).pt(4).text_color(t.dim).child(`… ${d.lines.length - 120} more lines`))))));
          }))));
    // The keys that open what the buttons below open, for when the mouse is far away.
    // Instead of the progress: what the conversation mentioned, to copy (and links to open).
    if (this.refsOpen) {
      const refs = this.refs ?? [];
      const groups = [["link", "LINKS"], ["path", "PATHS"], ["command", "COMMANDS"], ["commit", "COMMITS"]];
      col = v_flex().p(16).gap(18)
        .when(!refs.length, (e) => e.child(div().text_size(12.5).text_color(t.dim).child("Nothing to copy yet: links, paths, commands and commits the conversation mentions show up here.")));
      for (const [kind, name] of groups) {
        const list = refs.filter((r) => r.kind === kind);
        if (!list.length) continue;
        col = col.child(v_flex().gap(2)
          .child(label(`${name} · ${list.length}`))
          .children(list.map((r, k) => {
            const key = `ref-${kind}-${k}`;
            const done = this.copied === key;
            return h_flex().id(`sd-${key}`).gap(8).items_center().px(10).py(5).rounded(6).cursor_pointer()
              .hover((x) => x.bg(t.hover))
              .tooltip(done ? "Copied" : `Copy: ${r.value}`)
              .on_click((_e, cx) => { this.copy(r.value, key, cx); cx.notify(); })
              .child(div().flex_1().min_w(0).truncate().text_size(11.5)
                .when(kind !== "link", (x) => x.font_family(mono))
                .text_color(done ? t.ansi2 : t.muted).child(done ? "Copied" : r.label.replace(/\s+/g, " ")))
              .when(kind === "link", (x) => x.child(div().id(`sd-${key}-open`).flex_none().px(6).h(20).flex().items_center().rounded(5)
                .text_size(11).text_color(t.dim).hover((y) => y.bg(t.raised).text_color(t.foreground))
                .tooltip("Open in the browser")
                .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [r.value]).catch(() => {}); })
                .child("Open")));
          })));
      }
    }
    // Every file the whole session changed, in any repo: the side-by-side view (cmd-shift-g).
    // The bottom strip: the previous request on the left, all the session's changes as a small
    // button on the right; the previous request opens upwards from it.
    // A shortcut as a quiet keycap inside its button, shown while the footer has room.
    const cap = (k) => div().flex_none().ml(2).px(4).h(16).flex().items_center().rounded(4).bg(alpha(t.foreground, "0d"))
      .font_family(mono).text_size(10).text_color(t.dim).child(k);
    let foot = v_flex().id("rd-side-foot").absolute().left(0).right(0).bottom(0)
      .on_size_change((size, cx) => { if (Math.abs(size.width - (this.footW ?? 0)) >= 1) { this.footW = size.width; cx.notify(); } })
      .px(12).py(8).gap(6).border_t(1).border_color(t.border).bg(t.popover);
    const allButton = (h_flex().id("sd-all").flex_none().gap(6).items_center().px(8).h(28).rounded(7).border_1().border_color(t.border).cursor_pointer().text_size(11.5)
      .hover((x) => x.bg(t.hover))
      .tooltip("All session changes (⌘⇧G)")
      .on_click(() => openOverlay({ mod: "claude-changes", kind: "dialog", width: 0.95, height: 0.92, props: { changes: { terminal: this.terminal() } } }))
      .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.muted))
      .child(div().text_color(t.muted).child("Changes")));
    // The session's chat in reading mode (⌘R), for this terminal.
    const readButton = h_flex().id("sd-read").flex_none().gap(6).items_center().px(8).h(28).rounded(7).border_1().border_color(t.border).cursor_pointer().text_size(11.5)
      .hover((x) => x.bg(t.hover))
      .tooltip("Reading mode (⌘R)")
      .on_click(() => openOverlay({ mod: "claude-reading", kind: "dialog", width: 0.92, height: 0.92, props: { terminal: this.terminal() } }))
      .child(svg("mods/workspace-chrome/file-text.svg").size(12).flex_none().text_color(t.muted))
      .child(div().text_color(t.muted).child("Read"));
    // What the conversation mentioned: links, paths, commands, commits (in place of the progress).
    const refsButton = h_flex().id("sd-refs").flex_none().gap(6).items_center().px(8).h(28).rounded(7).border_1().cursor_pointer().text_size(11.5)
      .border_color(this.refsOpen ? alpha(t.working, "80") : t.border)
      .when(Boolean(this.refsOpen), (x) => x.bg(alpha(t.working, "14")))
      .hover((x) => x.bg(t.hover))
      .tooltip(this.refsOpen ? "Back to progress" : "Links, paths and commands from the conversation")
      .on_click((_e, cx) => { this.refsOpen = !this.refsOpen; cx.notify(); })
      .child(div().text_color(this.refsOpen ? t.foreground : t.muted).child("Refs"))
      .when(Boolean(this.refs?.length), (x) => x.child(div().text_size(11).text_color(t.dim).child(String(this.refs.length))));
    // A side question about this session, answered apart from it (⌘⇧A).
    const askButton = h_flex().id("sd-ask").flex_none().gap(6).items_center().px(8).h(28).rounded(7).border_1().border_color(t.border).cursor_pointer().text_size(11.5)
      .hover((x) => x.bg(t.hover))
      .tooltip("Ask about this session without interrupting it (⌘⇧A)")
      .on_click(() => openOverlay({ mod: "aside", kind: "dialog", width: 760, height: 0.8, props: { terminal: this.terminal() } }))
      .child(svg("icons/aside-message.svg").size(12).flex_none().text_color(t.muted))
      .child(div().text_color(t.muted).child("Ask"));
    const filesOn = this.filesOpen();
    const filesButton = h_flex().id("sd-files").flex_none().gap(6).items_center().px(8).h(28).rounded(7).border_1().cursor_pointer().text_size(11.5)
      .border_color(filesOn ? alpha(t.working, "80") : t.border)
      .when(filesOn, (x) => x.bg(alpha(t.working, "14")))
      .hover((x) => x.bg(t.hover))
      .tooltip(filesOn ? "Hide files" : "Files")
      .on_click(() => this.toggleFiles())
      .child(svg("mods/files/file.svg").size(12).flex_none().text_color(filesOn ? t.foreground : t.muted))
      .child(div().text_color(filesOn ? t.foreground : t.muted).child("Files"));
    const buttons = h_flex().flex_none().gap(6).child(refsButton).child(askButton).child(readButton).child(filesButton).child(allButton);
    // Kept at the bottom, under the scrolling part: the previous request, then all changes.
    foot = foot
        // The request before this one, folded to a line
        .when(Boolean(prev), (e) => {
          const pDone = prev.steps.filter((x) => x.status === "done" || (prev.wrap && x.status !== "failed")).length;
          const pFailed = prev.steps.filter((x) => x.status === "failed").length;
          const tested = prev.wrap ? { yes: "Tested", failed: "Tests failed", no: "Not tested", "n/a": "" }[prev.wrap.tested] ?? "" : "";
          return e.child(v_flex().gap(4)
            .when(Boolean(this.prevOpen), (x) => x.child(v_flex().gap(1).pl(6)
              // Quieter than the live plan: one line a step, its result beside it.
              .children(prev.steps.map((st, k) => {
                const failed = st.status === "failed";
                const done = failed ? false : st.status === "done" || Boolean(prev.wrap);
                return h_flex().id(`sd-pv-${k}`).gap(8).items_start().px(10).py(3).text_size(11.5)
                  .child(div().flex_none().w(12).text_color(failed ? t.ansi1 : done ? alpha(t.ansi2, "b3") : t.dim).child(failed ? "✗" : done ? "✓" : "·"))
                  .child(v_flex().flex_1().min_w(0)
                    .child(div().text_color(t.muted).child(st.title ?? ""))
                    .when(Boolean(st.result), (z) => z.child(div().text_size(11).text_color(failed ? alpha(t.ansi1, "cc") : t.dim).child(st.result))));
              }))
              .when(Boolean(prev.wrap?.done?.length), (y) => y.child(v_flex().gap(3).mx(10).mt(6).pt(8).border_t(1).border_color(t.border)
                .children(prev.wrap.done.map((line) => h_flex().gap(8).items_start().text_size(11.5)
                  .child(div().flex_none().text_color(t.ansi2).child("•"))
                  .child(div().flex_1().min_w(0).text_color(t.muted).child(String(line)))))))))
            .child(h_flex().gap(6).items_center().justify_end()
              .child(h_flex().id("sd-prev").flex_none().gap(6).items_center().px(8).h(28).rounded(7).border_1().border_color(t.border).cursor_pointer().text_size(11.5)
              .hover((x) => x.bg(t.hover))
              .tooltip(`${prev.wrap?.done?.[0] ?? prev.steps[0]?.title ?? ""}${tested ? ` · ${tested}` : ""}`)
              .on_click((_e, cx) => { this.prevOpen = !this.prevOpen; cx.notify(); })
              .child(svg(`mods/workspace-chrome/chevron-${this.prevOpen ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
              // What it did (its wrap-up's first line), not where its plan ended.
              .child(div().flex_none().text_color(t.muted).child("Previous"))
              .child(div().flex_none().text_size(11).text_color(pFailed ? t.ansi1 : t.dim).child(`${pDone}/${prev.steps.length}${pFailed ? " ✗" : prev.wrap?.tested === "yes" ? " ✓" : ""}`)))
              .child(buttons)));
        });
    if (!prev) foot = foot.child(h_flex().gap(8).items_center().child(div().flex_1()).child(buttons));
    // Under the buttons, the keys that open the same things, in the same order.
    const KEYS = [["Previous", "⌘⇧H"], ["Refs", "⌘⇧E"], ["Ask", "⌘⇧A"], ["Read", "⌘R"], ["Files", "⌘⇧F"], ["Changes", "⌘⇧G"], ["Hide", "⌘⇧S"]];
    foot = foot.child(h_flex().flex_wrap().justify_end().items_center().gap_x(14).gap_y(4).text_size(10.5)
      .children(KEYS.map(([w, k]) => h_flex().gap(5).items_center()
        .child(div().text_color(t.dim).child(w))
        .child(cap(k).ml(0)))));
    return div().id("rd-side-wrap").relative().when(!alone, (e) => e.w(360).flex_none().border_l(1).border_color(t.border)).when(alone, (e) => e.size_full()).h_full().min_h(0)
      .child(div().id("rd-side").size_full().overflow_y_scrollbar().child(col.pb(80)))
      .child(foot);
  }

  // The end of the page while Claude works or waits: what is running now, or what it asks.
  live(t, status) {
    const pend = this.pending ?? [];
    const ask = pend.find((x) => x.name === "AskUserQuestion" && x.input?.questions);
    if (status === "blocked" && ask) {
      return v_flex().w_full().gap(12).px(16).py(14).rounded(12).border_1().border_color(alpha(t.blocked, "73")).bg(alpha(t.blocked, "12"))
        .child(h_flex().gap(8).items_center().text_size(11).font_semibold().text_color(t.blocked)
          .child(div().size(7).rounded(4).bg(t.blocked)).child("CLAUDE ASKS · answer in the terminal below"))
        .children(ask.input.questions.map((q, qi) => v_flex().gap(8)
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child(q.question))
          .children((q.options ?? []).map((o, oi) => h_flex().gap(10).items_start()
            .child(div().flex_none().w(20).h(20).rounded(10).flex().items_center().justify_center().bg(t.raised).text_size(11).text_color(t.muted).child(String(oi + 1)))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().text_size(13).text_color(t.foreground).child(o.label))
              .when(Boolean(o.description), (e) => e.child(div().text_size(12).text_color(t.dim).child(o.description))))))));
    }
    if (status === "blocked") {
      const tool = pend.at(-1);
      return h_flex().gap(10).items_center().px(14).py(10).rounded(10).border_1().border_color(alpha(t.blocked, "73")).bg(alpha(t.blocked, "12")).text_size(12.5)
        .child(div().size(7).flex_none().rounded(4).bg(t.blocked))
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(tool
          ? `Claude asks permission: ${tool.name}${tool.what ? ` · ${tool.what}` : ""}`
          : "Claude is asking you something"))
        .child(div().flex_none().text_color(t.blocked).child("answer in the terminal below"));
    }
    if (status === "working") {
      // The chat only says that Claude is at it; what exactly is in the side panel.
      return h_flex().gap(8).items_center().text_size(12.5).text_color(t.working)
        .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
        .child(div().child("Claude is working…"));
    }
    return null;
  }

  // The session at a glance, on top of the page: what it is about, the model and effort,
  // lines changed, the limits, the context and the turn.
  bar(t, p) {
    const line = this.line;
    const status = p?.status;
    const title = p?.title && p.title !== p.program?.name ? p.title.replace(/^[^\p{L}\p{N}]+\s*/u, "") : "Claude";
    const dur = (ms) => {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
    };
    const chip = (text, color, tip) => div().flex_none().px(7).h(20).flex().items_center().rounded(10).text_size(11).text_color(color)
      .when(Boolean(tip), (e) => e.tooltip(tip)).child(text);
    const lim = (label, x) => {
      if (!x) return null;
      const pct = Math.round(x.used_percentage ?? 0);
      return h_flex().gap(4).text_size(11).child(div().text_color(t.dim).child(label))
        .child(div().text_color(pct < 60 ? t.muted : pct < 85 ? t.working : t.ansi1).child(`${pct}%`));
    };
    const cw = line?.context_window;
    const pct = cw?.used_percentage ?? null;
    const ctxColor = pct == null ? t.dim : pct < 50 ? t.ansi2 : pct < 80 ? t.working : t.ansi1;
    const since = this.askedAt;
    const turn = status === "working"
      ? h_flex().flex_none().gap(6).items_center().px(8).h(22).rounded(11).bg(alpha(t.working, "1f")).text_size(11).text_color(t.working)
          .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900))
          .child(div().child(since ? `Working · ${dur(Date.now() - since)}` : "Working"))
      : status === "blocked"
      ? h_flex().flex_none().gap(6).items_center().px(8).h(22).rounded(11).bg(alpha(t.blocked, "26")).text_size(11).font_semibold().text_color(t.blocked)
          .child(div().size(6).rounded(3).bg(t.blocked)).child(div().child("Needs you"))
      : h_flex().flex_none().gap(6).items_center().px(8).h(22).rounded(11).text_size(11).text_color(status === "done" ? t.done : t.dim)
          .child(div().size(6).rounded(3).bg(status === "done" ? t.done : t.dim))
          .child(div().child(`Done${since && this.spokeAt >= since ? ` · ${dur(this.spokeAt - since)}` : ""}`));
    const ask = this.ask?.level && this.ask.level !== "off" ? this.ask.level : null;
    const added = line?.cost?.total_lines_added, removed = line?.cost?.total_lines_removed;
    return h_flex().flex_none().h(40).px(16).gap(12).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_none().max_w(460).truncate().font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(line?.model?.display_name), (e) => e.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).border_1().border_color(t.input).text_size(10.5).text_color(t.muted)
        .child(`${line.model.display_name}${line.effort?.level ? ` · ${line.effort.level}` : ""}`)))
      .when(Boolean(ask), (e) => e.child(chip(`🔒 ${ask}`, t.working, "Read-only: /ask off to leave")))
      .child(div().flex_1())
      .when(Boolean(added || removed), (e) => e.child(h_flex().flex_none().gap(5).text_size(11)
        .child(div().text_color(t.ansi2).child(`+${added ?? 0}`)).child(div().text_color(t.ansi1).child(`−${removed ?? 0}`))))
      .child(lim("5h", line?.rate_limits?.five_hour) ?? div())
      .child(lim("7d", line?.rate_limits?.seven_day) ?? div())
      .when(pct != null, (e) => e.child(h_flex().flex_none().gap(6).items_center().text_size(11)
        .tooltip(cw?.context_window_size ? `Context of ${Math.round(cw.context_window_size / 1000)}k tokens` : "Context")
        .child(div().text_color(t.dim).child("ctx"))
        .child(div().w(56).h(5).rounded(3).bg(t.raised).overflow_hidden().child(div().h_full().w(Math.max(2, Math.round(0.56 * pct))).rounded(3).bg(ctxColor)))
        .child(div().text_color(t.muted).child(`${Math.round(pct)}%`))))
      .child(turn)
      // Closing the reader: the terminal below takes the tab again.
      .child(div().id("rd-close").flex_none().size(24).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
        .tooltip("Close (esc)")
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => { if (props()?.overlay) closeOverlay(props().overlay); })
        .child(svg("mods/pane/close.svg").size(13).text_color(t.dim)));
  }

  render(cx) {
    const t = theme();
    const p = this.pane();
    const st = this.st;
    // A jump asked from the side pane, for this session's chat.
    const jump = shared(JUMP_KEY);
    if (jump && !props()?.overlay && jump.terminal === props()?.terminal && jump.at !== this.jumpSeen && Date.now() - jump.at < 3000 && (props()?.part ?? "both") !== "side") {
      this.jumpSeen = jump.at;
      this.jumpTo(jump.id);
    }
    const max = Math.max(0, st.full - st.view);
    if (this.follow) st.off = max;
    st.off = Math.max(0, Math.min(st.off, max));
    const keysHere = this.handle.is_focused?.() ?? false;
    const status = p?.status;
    const title = p?.title && p.title !== p.program?.name ? p.title.replace(/^[^\p{L}\p{N}]+\s*/u, "") : "Claude";

    // Each command's output: the logged runs matched to the commands, newest to newest.
    const outFor = new Map();
    const logs = [...(this.commandOut ?? [])];
    for (const x of [...this.entries].reverse()) {
      if (x.k !== "cmd") continue;
      const i = logs.findLastIndex((l) => `/${l.command}` === x.name || l.command === x.name.replace(/^\//, ""));
      if (i >= 0) { outFor.set(x.id, logs[i]); logs.splice(i, 1); }
    }
    const body = v_flex().w_full().max_w(820).mx_auto().px(28).pt(22).pb(32).gap(24)
      .when(Boolean(this.partial), (e) => e.child(h_flex().justify_center().child(
        div().id("rd-more").px(10).h(26).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.bytes = Math.min(MAX_BYTES, this.bytes * 2); this.follow = false; this.poll(cx, true); })
          .child("Show earlier"))))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12.5).text_color(t.blocked).child(this.error)))
      .children(this.entries.map((x) => div().id(`rd-e-${x.id}`).w_full()
        .on_size_change((size) => { this.heights[x.id] = size.height; })
        .child(x.k === "you" ? this.you(x, t) : x.k === "text" ? this.text(x, t)
        : x.k === "cmd" ? this.command(x, t, outFor)
        : x.k === "note" ? h_flex().justify_end().text_size(11.5).text_color(t.dim).child(x.text) : this.toolPictures(x, t))))
      .child(this.live(t, status) ?? div());

    const thumb = st.full > st.view + 1 && st.view > 0;
    const thumbH = thumb ? Math.max(28, (st.view * st.view) / st.full) : 0;
    const thumbTop = thumb ? ((st.view - thumbH) * st.off) / (st.full - st.view) : 0;

    const part = props()?.overlay ? "reading" : props()?.part ?? "both";
    if (part === "side") {
      return v_flex().id("rd-root").size_full().min_h(0).text_color(t.foreground)
        .when((t.background ?? "").length !== 9, (e) => e.bg(t.background))
        .child(this.side(t, status, true));
    }
    return v_flex().id("rd-root").size_full().min_h(0).text_color(t.foreground)
      .when((t.background ?? "").length !== 9, (e) => e.bg(t.background))
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .when(part === "reading", (e) => e.bg(t.popover).child(this.bar(t, p)))
      .child(h_flex().flex_1().min_h(0).w_full()
      .when(part === "reading", (e) => e.child(this.toc(t)))
      .child(div().id("rd-view").flex_1().min_w(0).h_full().relative().overflow_hidden()
        .on_size_change((size, cx) => { if (Math.abs(size.height - st.view) >= 1) { st.view = size.height; cx.notify(); } })
        .on_scroll_wheel((e, cx) => { this.stopGlide(); this.scrollBy(-(e.delta?.y ?? 0)); cx.stop_propagation(); cx.notify(); })
        .child(div().id("rd-content").absolute().left(0).w_full().top(-st.off)
          .on_size_change((size, cx) => { if (Math.abs(size.height - st.full) >= 1) { st.full = size.height; cx.notify(); } })
          .child(body))
        .when(thumb, (e) => e.child(div().absolute().right(3).top(thumbTop).w(4).h(thumbH).rounded(2).bg(t.border)))
        .when(!this.follow, (e) => e.child(div().id("rd-end").absolute().bottom(12).right(18).px(10).h(26).flex().items_center().rounded(13)
          .bg(t.popover).border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.follow = true; cx.notify(); })
          .child("↓ To the end"))))
      .when(part !== "chat" && part !== "reading", (e) => e.child(this.side(t, status))))
      .when(keysHere, (e) => e.child(h_flex().flex_none().px(14).h(24).gap(14).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().text_color(t.muted).child(title))
        .children([["j/k", "scroll"], ["d/u", "half page"], ["gg/G", "top/end"]].map(([k, w]) =>
          h_flex().gap(5).child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(w))))));
  }
}
