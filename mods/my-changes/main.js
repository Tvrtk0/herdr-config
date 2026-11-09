import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// A bare-repo container (a folder holding .bare and its worktrees) isn't a git
// repository itself. For one, this lists its worktrees: path, uncommitted
// changes, newest changed file's mtime, branch. Runs in well under a second.
const WT_SCRIPT = String.raw`
cd "$1" || exit 1
[ -d .bare ] || exit 2
command git --git-dir=.bare worktree list --porcelain | awk '/^worktree /{p=substr($0,10)} /^bare$/{p=""} /^$/{if(p!="")print p; p=""} END{if(p!="")print p}' \
| xargs -P 8 -I{} sh -c '
  wt="$1"; [ -d "$wt" ] || exit 0
  st=$(git -C "$wt" --no-optional-locks status --porcelain 2>/dev/null)
  n=$(printf "%s" "$st" | grep -c . )
  m=0
  if [ "$n" -gt 0 ]; then m=$(printf "%s\n" "$st" | head -30 | cut -c4- | while IFS= read -r f; do stat -f %m "$wt/$f" 2>/dev/null; done | sort -n | tail -1); fi
  [ -n "$m" ] || m=0
  b=$(git -C "$wt" branch --show-current 2>/dev/null)
  printf "%s\t%s\t%s\t%s\n" "$wt" "$n" "$m" "$b"
' sh {}
`;

const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    // No commit box here: it ran `git add -A` and committed in whichever worktree showed.
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        let picked;
        if (top.code !== 0) {
          // Not a repo: a bare-repo container shows one of its worktrees instead.
          const wts = await this.worktreesOf(cwd, on);
          if (key() !== context) return;
          if (!wts?.length) { this.container = null; this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
          this.container = cwd;
          const saved = localStorage.getItem(`wt:${cwd}`);
          picked = (wts.find((w) => w.path === saved) ?? [...wts].sort((a, b) => b.m - a.m || b.n - a.n)[0]).path;
        } else this.container = null;
        const root = picked ?? top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  // The container's worktrees, asked again at most once a minute (or when the list opens).
  async worktreesOf(cwd, on, fresh = false) {
    const c = this.wtCache;
    if (!fresh && c?.cwd === cwd && Date.now() - c.at < 60000) return c.list;
    const r = await exec("zsh", ["-c", WT_SCRIPT, "worktrees", cwd], { on });
    if (r.code !== 0) return null;
    const list = r.stdout.split("\n").filter(Boolean).map((line) => {
      const [path, n, m, branch] = line.split("\t");
      return { path, n: Number(n) || 0, m: Number(m) || 0, branch, name: path.slice(cwd.length + 1) || path };
    });
    this.wtCache = { cwd, at: Date.now(), list };
    return list;
  }

  pickWorktree(path, cx) {
    localStorage.setItem(`wt:${this.container}`, path);
    this.wtOpen = false;
    this.open = null; this.closed = false; this.setLines([]); this.files = [];
    this.refresh(cx);
    cx.notify();
  }

  // Which worktree a container shows, and the list to pick another: most recently changed first.
  wtBar(t) {
    const list = [...(this.wtCache?.list ?? [])].sort((a, b) => b.m - a.m || b.n - a.n || a.name.localeCompare(b.name));
    const cur = list.find((w) => w.path === this.root);
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().id("wt-bar").h(32).px(14).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover)).text_size(12)
        .on_click((_e, cx) => {
          this.wtOpen = !this.wtOpen;
          if (this.wtOpen) cx.spawn(async (cx) => { await this.worktreesOf(this.container, this.on, true); cx.notify(); });
          cx.notify();
        })
        .child(div().text_color(t.dim).child("worktree"))
        .child(div().font_semibold().truncate().child(cur?.name ?? this.root?.split("/").pop() ?? "\u2026"))
        .when(Boolean(cur?.branch) && cur?.branch !== cur?.name, (e) => e.child(div().text_color(t.dim).truncate().child(cur.branch)))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(this.wtOpen ? "\u25be" : "\u25b8")))
      .when(Boolean(this.wtOpen), (e) => e.child(v_flex().id("wt-list").max_h(260).overflow_y_scrollbar().p(6).border_t(1).border_color(t.border)
        .children(list.map((w) => h_flex().id(`wt-${w.path}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12)
          .when(w.path === this.root, (x) => x.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pickWorktree(w.path, cx))
          .child(div().flex_1().min_w(0).truncate().text_color(w.n ? t.foreground : t.muted).child(w.name))
          .when(w.n > 0, (x) => x.child(div().flex_none().text_size(11).text_color(t.blocked).child(`${w.n} changed`)))))));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {

      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .when(Boolean(this.container), (e) => e.child(this.wtBar(t)))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)));
  }
}
