// Every git worktree of the repos below, each labelled by whether it is done with:
// its PR merged or closed, its commits already in master, no commits for a month,
// or work that only exists here (uncommitted, unpushed). Remove asks first and runs
// `git worktree remove` (git itself refuses a folder with changes); the branch stays.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, theme, run, panes, shared, setShared, home, focused, nextCommand, openOverlay, readTextFile, appHome } from "herdr";

// The Home space's three dashboards (my-agents keeps them as its tabs): [ and ] step through
// them, ? shows every key.
const HOME_TABS = [["overview", "Overview"], ["review", "Review"], ["worktrees", "Worktrees"]];
// Herdr's own tab bar already shows the three dashboards: this adds nothing on top.
function homeBar() {
  return div();
}
function homeKeys(key, context) {
  if (key === "[") { run("my-agents.home:prev"); return true; }
  if (key === "]") { run("my-agents.home:next"); return true; }
  if (key === "?") { openOverlay({ mod: "keys-help", kind: "dialog", width: 760, height: 0.86, props: { context } }); return true; }
  return false;
}


// A see-through look (glass) has a translucent background: panes let it show through,
// and cards get a faint tint of their own, since its surface is opaque for tooltips.
const glassy = (t) => (t.background ?? "").length === 9;
const cardBg = (t) => (glassy(t) ? (t.foreground.slice(0, 7) + "0d") : t.surface);


// Stamped by review-prs and my-tabs when Herdr's focused pane changes: { pane, at }.
const FOCUS_KEY = "focus.moved";
// What the confirm dialog's "my-worktrees.remove" acts on.
const REMOVE_KEY = "worktrees.remove";

// Which repos, folders and review skills: machine-local, read from
// ~/.config/herdr-app/local.json (outside the dotfiles repo; local.example.json shows its shape).
const LOCAL = readTextFile(`${appHome()}/local.json`)
  .then((t) => { try { return JSON.parse(t ?? "{}") ?? {}; } catch { return {}; } })
  .catch(() => ({}));
// local.json's "worktreeRepos": { id, dir, gh } each, the repos whose worktrees are listed.
const REPOS = [];

const DAY = 86400000;
const STALE_DAYS = 30;
// A worktree this new with nothing in it yet is a task just started, not leftovers.
const FRESH_DAYS = 3;

const VERDICTS = {
  missing: { label: "Folder gone", color: "ansi2", about: "The folder no longer exists; git still lists it. Prune forgets it." },
  remove: { label: "Safe to remove", color: "ansi2", about: "PR merged or closed, or nothing beyond master. Nothing uncommitted or unpushed." },
  stale: { label: "Probably stale", color: "working", about: `No open PR and no commits in ${STALE_DAYS}+ days. Nothing uncommitted or unpushed.` },
  check: { label: "Check first", color: "blocked", about: "Looks finished, but has work that exists only here." },
  active: { label: "In use", color: "accent", about: "Open PR, recent commits, or local work not on GitHub yet." },
  main: { label: "Main checkout", color: "dim", about: "The repo's own checkout. Not removable." },
};
const ORDER = ["missing", "remove", "stale", "check", "active", "main"];

// One worktree's facts as key=value lines. $1 folder, $2 branch ("" when detached), $3 base ref.
const PROBE = String.raw`
p=$1 b=$2 base=$3
cd "$p" 2>/dev/null || { echo missing=1; exit 0; }
print -r -- "time=$(git log -1 --format=%ct HEAD 2>/dev/null)"
print -r -- "subject=$(git log -1 --format=%s HEAD 2>/dev/null)"
print -r -- "dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
print -r -- "unpushed=$(git rev-list --count HEAD --not --remotes 2>/dev/null)"
print -r -- "ahead=$(git rev-list --count "$base..HEAD" 2>/dev/null)"
git merge-base --is-ancestor HEAD "$base" 2>/dev/null && echo inbase=1 || echo inbase=0
if [ -n "$b" ]; then
  print -r -- "track=$(git for-each-ref --format='%(upstream:track)' "refs/heads/$b")"
  print -r -- "upstream=$(git for-each-ref --format='%(upstream:short)' "refs/heads/$b")"
fi
print -r -- "created=$(stat -f %m .git 2>/dev/null)"
`;

// Of the commits on no remote, how many aren't in the PR either, even as the same patch
// (a force-push or rebase leaves the old copies behind). $1 folder, $2 PR head, $3 PR number.
// Prints "raw" when the PR's head can't be had.
const UNPUSHED = String.raw`
cd "$1" 2>/dev/null || { echo raw; exit 0; }
git cat-file -e "$2^{commit}" 2>/dev/null || git fetch -q origin "refs/pull/$3/head" 2>/dev/null || { echo raw; exit 0; }
git cat-file -e "$2^{commit}" 2>/dev/null || { echo raw; exit 0; }
here=$(git rev-list HEAD --not --remotes)
[ -z "$here" ] && { echo 0; exit 0; }
git cherry "$2" HEAD | awk '$1=="+"{print $2}' | grep -Fxc -f <(print -r -- "$here")
`;

// Removing can take a while (node_modules), longer than exec's 30 s, so it runs on its
// own and writes to a log this mod polls. $1 repo, $2 folder.
const REMOVE = String.raw`
log=$(mktemp -t herdr-worktree)
( git -C "$1" worktree remove -- "$2"; echo "exit=$?" ) >"$log" 2>&1 </dev/null &!
print -r -- "$log"
`;

const PR_FIELDS = "nodes{number state url title headRefOid mergedAt closedAt author{login}}";

function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const kv = (text) => Object.fromEntries(text.split("\n").filter(Boolean).map((l) => {
  const i = l.indexOf("=");
  return [l.slice(0, i), l.slice(i + 1)];
}));

function parseList(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) out.push(cur = { path: line.slice(9) });
    else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare") cur.bare = true;
    else if (line === "detached") cur.detached = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  return out;
}

// The verdict and the reasons behind it.
function judge(w, now) {
  if (w.main) return { verdict: "main", reasons: [] };
  if (w.missing || w.prunable) return { verdict: "missing", reasons: ["folder no longer exists"] };
  const reasons = [];
  const pr = w.pr;
  // A squash-merged PR leaves its commits on no remote; the PR's own head counts as pushed.
  const unpushed = pr && pr.headRefOid === w.head ? 0 : w.unpushed;
  const local = [];
  if (w.dirty > 0) local.push(`${w.dirty} uncommitted`);
  if (unpushed > 0) local.push(`${unpushed} unpushed`);
  let done = false;
  if (pr?.state === "MERGED") { done = true; reasons.push(`PR #${pr.number} merged ${ago(Date.parse(pr.mergedAt), now)} ago`); }
  else if (pr?.state === "CLOSED") { done = true; reasons.push(`PR #${pr.number} closed ${ago(Date.parse(pr.closedAt), now)} ago`); }
  else if (pr?.state === "OPEN") reasons.push(`PR #${pr.number} open`);
  else if (w.inbase) {
    const fresh = w.created && now - w.created < FRESH_DAYS * DAY;
    if (!fresh) { done = true; reasons.push(w.detached ? "detached, already in master" : "nothing beyond master"); }
    else reasons.push("new, nothing committed yet");
  } else if (w.track === "[gone]") { done = true; reasons.push("branch deleted on GitHub"); }
  else if (!pr && w.branch) reasons.push(w.upstream ? "no PR" : "never pushed");
  reasons.push(...local);
  const old = w.time && now - w.time > STALE_DAYS * DAY;
  if (w.time) reasons.push(`last commit ${ago(w.time, now)} ago`);
  let verdict;
  if (done) verdict = local.length ? "check" : "remove";
  else if (pr?.state === "OPEN" || local.length || !old) verdict = "active";
  else verdict = "stale";
  return { verdict, reasons };
}

export default class MyWorktrees extends View {
  init(_props, cx) {
    this.repo = localStorage.getItem("repo");
    this.data = {};
    try { this.data = JSON.parse(localStorage.getItem("data") ?? "{}"); } catch { this.data = {}; }
    this.loading = {};
    this.errors = {};
    this.removing = {};
    this.sel = 0;
    this.handle = cx.focus_handle();
    this.scroller = VirtualListScrollHandle.new();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        if (c === "remove") {
          const r = shared(REMOVE_KEY);
          if (r && Date.now() - r.at < 60000) { setShared(REMOVE_KEY, null); this.remove(r.repo, r.path, r.prune, cx); }
        }
        cx.notify();
      }
    });
    // Ages tick.
    cx.timer.every(60000, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      const local = await LOCAL;
      REPOS.splice(0, REPOS.length, ...(local.worktreeRepos ?? []));
      if (!REPOS.some((r) => r.id === this.repo)) this.repo = REPOS[0]?.id ?? null;
      if (this.repo) this.refresh(this.repo, cx, true);
      cx.notify();
    });
  }

  repoOf(id) { return REPOS.find((r) => r.id === id) ?? REPOS[0] ?? { id: "", dir: "~", gh: "" }; }
  dirOf(repo) { return repo.dir.replace(/^~/, home()); }

  // Everything about one repo's worktrees. fetch: update origin first, so "merged" and
  // "gone" are current.
  refresh(id, cx, fetch = true) {
    if (this.loading[id]) return;
    const repo = this.repoOf(id);
    const dir = this.dirOf(repo);
    this.loading[id] = true;
    this.errors[id] = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (fetch) {
          const f = await exec("git", ["-C", dir, "fetch", "--prune", "--quiet", "origin"]).catch((e) => ({ code: 1, stderr: String(e) }));
          if (f.code !== 0) this.errors[id] = `Fetch failed, labels use what was fetched before: ${f.stderr.trim().split("\n")[0]}`;
        }
        const base = (await exec("git", ["-C", dir, "rev-parse", "--verify", "-q", "origin/master"])).code === 0 ? "origin/master" : "origin/main";
        const list = await exec("git", ["-C", dir, "worktree", "list", "--porcelain"]);
        if (list.code !== 0) throw new Error(list.stderr.trim() || "git worktree list failed");
        const all = parseList(list.stdout);
        const hasBare = all.some((w) => w.bare);
        const trees = all.filter((w) => !w.bare).map((w, i) => ({
          ...w,
          // A plain repo's first entry is its own checkout; a bare one's is its master.
          main: (!hasBare && i === 0) || (hasBare && (w.branch === "master" || w.branch === "main")),
          name: w.path.startsWith(dir + "/") ? w.path.slice(dir.length + 1) : w.path.replace(home(), "~"),
        }));
        await Promise.all(trees.map(async (w) => {
          if (w.prunable) return;
          const r = await exec("zsh", ["-c", PROBE, "zsh", w.path, w.branch ?? "", base]).catch(() => null);
          const f = kv(r?.stdout ?? "");
          if (f.missing) { w.missing = true; return; }
          w.time = Number(f.time) * 1000 || null;
          w.subject = f.subject ?? "";
          w.dirty = Number(f.dirty) || 0;
          w.unpushed = Number(f.unpushed) || 0;
          w.ahead = Number(f.ahead) || 0;
          w.inbase = f.inbase === "1";
          w.track = f.track ?? "";
          w.upstream = f.upstream ?? "";
          w.created = Number(f.created) * 1000 || null;
        }));
        // Each branch's PRs in one query: open first, else the newest.
        const named = trees.filter((w) => w.branch && !w.main);
        if (named.length) {
          const [owner, name] = repo.gh.split("/");
          const fields = named.map((w, i) => `b${i}: pullRequests(headRefName: ${JSON.stringify(w.branch)}, first: 5, states: [OPEN, MERGED, CLOSED], orderBy: {field: CREATED_AT, direction: DESC}) { ${PR_FIELDS} }`).join("\n");
          const q = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
          const r = await exec("gh", ["api", "graphql", "-f", `query=${q}`]).catch((e) => ({ code: 1, stderr: String(e) }));
          if (r.code === 0) {
            const got = JSON.parse(r.stdout)?.data?.repository ?? {};
            named.forEach((w, i) => {
              const prs = got[`b${i}`]?.nodes ?? [];
              w.pr = prs.find((p) => p.state === "OPEN") ?? prs[0] ?? null;
            });
          } else {
            this.errors[id] = `GitHub didn't answer, PR states are missing: ${r.stderr.trim().split("\n")[0]}`;
          }
        }
        // Commits only here, against the PR's own head: old copies of its patches don't count.
        await Promise.all(trees.filter((w) => w.pr && w.unpushed > 0 && w.pr.headRefOid !== w.head).map(async (w) => {
          const r = await exec("zsh", ["-c", UNPUSHED, "zsh", w.path, w.pr.headRefOid, String(w.pr.number)]).catch(() => null);
          const n = Number(r?.stdout?.trim());
          if (r && r.stdout.trim() !== "raw" && Number.isFinite(n)) w.unpushed = n;
        }));
        this.data[id] = { at: Date.now(), trees };
        localStorage.setItem("data", JSON.stringify(this.data));
      } catch (e) {
        this.errors[id] = String(e?.message ?? e);
      }
      this.loading[id] = false;
      cx.notify();
    });
  }

  // The shown repo's worktrees, judged and sorted: what can go first, oldest first.
  rows(now) {
    const trees = this.data[this.repo]?.trees ?? [];
    return trees
      .map((w) => ({ ...w, ...judge(w, now) }))
      .sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || (a.time ?? 0) - (b.time ?? 0));
  }

  // List items: a heading per verdict, then its worktrees.
  items(rows) {
    const out = [];
    for (const v of ORDER) {
      const group = rows.filter((w) => w.verdict === v);
      if (!group.length) continue;
      out.push({ key: `h:${v}`, h: 34, head: v, count: group.length });
      group.forEach((w) => out.push({ key: `w:${w.path}`, h: 54, w }));
    }
    return out;
  }

  ask(w) {
    if (!w || w.main || this.removing[w.path]) return;
    const prune = w.verdict === "missing";
    const warn = [];
    if (w.dirty > 0) warn.push(`It has ${w.dirty} uncommitted change${w.dirty > 1 ? "s" : ""}: git will refuse, and nothing is deleted.`);
    const unpushed = w.pr && w.pr.headRefOid === w.head ? 0 : w.unpushed;
    if (unpushed > 0) warn.push(`${unpushed} commit${unpushed > 1 ? "s are" : " is"} not on GitHub. They stay on the branch ${w.branch ?? "(detached: they would be lost)"}.`);
    if (w.verdict === "active") warn.push("This one looks in use.");
    const detail = prune
      ? `${w.path}\n\nThe folder is already gone; git forgets the entry.`
      : `${w.path}\n\nDeletes the folder, node_modules included.${w.branch ? ` The branch ${w.branch} stays, so it can be checked out again.` : ""}${warn.length ? `\n\n${warn.join("\n")}` : ""}`;
    setShared(REMOVE_KEY, { repo: this.repo, path: w.path, prune, at: Date.now() });
    openOverlay({
      mod: "confirm",
      kind: "dialog",
      width: 460,
      height: warn.length ? 250 : 200,
      props: { title: prune ? `Prune ${w.name}?` : `Remove worktree ${w.name}?`, detail, command: { name: "my-worktrees.remove" } },
    });
  }

  remove(id, path, prune, cx) {
    const dir = this.dirOf(this.repoOf(id));
    this.removing[path] = { at: Date.now() };
    cx.notify();
    cx.spawn(async (cx) => {
      const done = (err) => {
        delete this.removing[path];
        if (err) this.errors[id] = err;
        else {
          const d = this.data[id];
          if (d) d.trees = d.trees.filter((w) => w.path !== path);
          localStorage.setItem("data", JSON.stringify(this.data));
        }
        cx.notify();
      };
      if (prune) {
        const r = await exec("git", ["-C", dir, "worktree", "prune"]).catch((e) => ({ code: 1, stderr: String(e) }));
        return done(r.code === 0 ? null : r.stderr.trim());
      }
      const r = await exec("zsh", ["-c", REMOVE, "zsh", dir, path]).catch((e) => ({ code: 1, stderr: String(e) }));
      const log = r.stdout?.trim();
      if (r.code !== 0 || !log) return done(r.stderr?.trim() || "Couldn't start git worktree remove");
      this.poll(log, done, cx);
    });
  }

  poll(log, done, cx) {
    cx.timer.after(1000, (cx) => {
      cx.spawn(async (cx) => {
        const r = await exec("cat", [log]).catch(() => null);
        const out = r?.stdout ?? "";
        const m = out.match(/exit=(\d+)\s*$/);
        if (!m) return this.poll(log, done, cx);
        exec("rm", ["-f", log]).catch(() => {});
        done(m[1] === "0" ? null : out.replace(/exit=\d+\s*$/, "").trim() || `git exited ${m[1]}`);
      });
    });
  }

  openSpace(w) {
    if (!w || w.missing) return;
    run("space.new", { folder: w.path, name: w.name.split("/").pop() });
  }

  openPr(w) {
    if (w?.pr?.url) exec("open", [w.pr.url]).catch(() => {});
  }

  pickRepo(id, cx) {
    this.repo = id;
    this.sel = 0;
    localStorage.setItem("repo", id);
    if (!this.data[id] && !this.loading[id]) this.refresh(id, cx);
    cx.notify();
  }

  select(i, list) {
    this.sel = Math.max(0, Math.min(list.length - 1, i));
    const key = list[this.sel] && `w:${list[this.sel].path}`;
    const at = this.lastItems?.findIndex((it) => it.key === key) ?? -1;
    if (at >= 0) this.scroller.scroll_to_item(at);
  }

  // h/l or 1-3 repo, j/k worktree, gg/G first/last, x remove, enter open as a space,
  // o PR, R refresh. Chords pass through.
  onKey(e, cx) {
    const m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt) return;
    const key = e.key === "enter" ? "enter" : e.key_char ?? e.key;
    if (homeKeys(key, "worktrees")) { cx.stop_propagation(); return; }
    const ri = Math.max(0, REPOS.findIndex((r) => r.id === this.repo));
    const list = this.lastRows ?? [];
    const w = list[this.sel];
    const act = {
      h: () => this.pickRepo(REPOS[Math.max(0, ri - 1)].id, cx),
      l: () => this.pickRepo(REPOS[Math.min(REPOS.length - 1, ri + 1)].id, cx),
      j: () => this.select(this.sel + 1, list),
      k: () => this.select(this.sel - 1, list),
      G: () => this.select(list.length - 1, list),
      g: () => {
        if (Date.now() - (this.lastG ?? 0) < 1000) { this.select(0, list); this.lastG = 0; } else this.lastG = Date.now();
      },
      x: () => this.ask(w),
      enter: () => this.openSpace(w),
      o: () => this.openPr(w),
      R: () => this.refresh(this.repo, cx),
      ...Object.fromEntries(REPOS.map((r, i) => [String(i + 1), () => this.pickRepo(r.id, cx)])),
    }[key];
    if (!act) return;
    cx.stop_propagation();
    act();
    cx.notify();
  }

  chip(text, color, t) {
    return div().flex_none().px(6).h(20).flex().items_center().rounded(5).text_size(11).bg(color + "1f").text_color(color).child(text);
  }

  button(id, label, t, onClick, kind = "plain") {
    const danger = kind === "danger";
    return div().id(id).flex_none().px(12).h(30).flex().items_center().justify_center().rounded(7).text_size(12.5).cursor_pointer()
      .when(danger, (e) => e.bg(t.ansi1 + "26").text_color(t.ansi1).border_1().border_color(t.ansi1 + "59").hover((s) => s.bg(t.ansi1 + "40")))
      .when(!danger, (e) => e.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  repoTabs(t) {
    return h_flex().gap(4).mb(14).border_b(1).border_color(t.border)
      .children(REPOS.map((r) => {
        const on = r.id === this.repo;
        const d = this.data[r.id];
        const n = d ? d.trees.filter((w) => !w.main).length : null;
        const done = d ? d.trees.map((w) => judge(w, Date.now()).verdict).filter((v) => v === "remove" || v === "missing" || v === "stale").length : 0;
        return h_flex().id(`wt-tab-${r.id}`).px(12).h(36).gap(8).items_center().cursor_pointer().mb(-1)
          .border_b(2).border_color(on ? t.accent : "#00000000")
          .text_size(13.5).text_color(on ? t.foreground : t.muted)
          .when(on, (e) => e.font_semibold())
          .when(!on, (e) => e.hover((s) => s.text_color(t.foreground)))
          .on_click((_e, cx) => this.pickRepo(r.id, cx))
          .child(div().child(r.id))
          .when(n != null, (e) => e.child(this.chip(String(n), on ? t.accent : t.muted, t)))
          .when(done > 0, (e) => e.child(this.chip(`${done} to clean`, t.ansi2, t)));
      }));
  }

  head(it, t) {
    const v = VERDICTS[it.head];
    const color = t[v.color] ?? t.dim;
    return h_flex().h(34).px(10).pt(10).gap(8).items_center().text_size(11.5)
      .child(div().size(8).rounded(4).bg(color))
      .child(div().font_semibold().text_color(t.foreground).child(v.label))
      .child(div().text_color(t.dim).child(String(it.count)));
  }

  row(w, t, now, selected) {
    const v = VERDICTS[w.verdict];
    const color = t[v.color] ?? t.dim;
    const busy = Boolean(this.removing[w.path]);
    return h_flex().h(54).px(10).gap(10).items_center().rounded(8).cursor_pointer()
      .when(selected, (e) => e.bg(t.selected))
      .when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
      .when(busy, (e) => e.opacity(0.5))
      .child(div().w(3).h(30).rounded(2).flex_none().bg(color))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(w.name))
          .when(Boolean(w.branch) && w.branch !== w.name.split("/").pop(), (e) => e.child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(w.branch)))
          .when(!w.branch && !w.missing, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.dim).child("detached"))))
        .child(div().text_size(11.5).text_color(t.muted).truncate().child(busy ? "Removing…" : w.reasons.join(" · ") || v.about)))
      .when(busy, (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.dim).spin(900)));
  }

  // The chosen worktree: why it got its label, and what can be done with it.
  details(w, t, now) {
    if (!w) return v_flex().w(340).flex_none().p(18).text_color(t.dim).child("Pick a worktree.");
    const v = VERDICTS[w.verdict];
    const color = t[v.color] ?? t.dim;
    const fact = (k, val, c) => h_flex().gap(10).text_size(12.5)
      .child(div().w(92).flex_none().text_color(t.dim).child(k))
      .child(div().flex_1().min_w(0).text_color(c ?? t.foreground).child(val));
    const unpushed = w.pr && w.pr.headRefOid === w.head ? 0 : w.unpushed;
    const pr = w.pr;
    const busy = Boolean(this.removing[w.path]);
    return v_flex().w(340).flex_none().h_full().min_h(0).p(18).gap(14).border_l(1).border_color(t.border).overflow_y_scrollbar()
      .child(v_flex().gap(6)
        .child(h_flex().child(this.chip(v.label, color, t)))
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(w.name))
        .child(div().text_size(12).text_color(t.dim).child(v.about)))
      .child(v_flex().gap(7)
        .child(fact("Folder", w.path.replace(home(), "~"), t.muted))
        .child(fact("Branch", w.branch ?? "detached HEAD", w.branch ? t.foreground : t.muted))
        .when(!w.missing && !w.main, (e) => e
          .child(fact("PR", pr ? `#${pr.number} ${pr.state.toLowerCase()}${pr.author ? ` · ${pr.author.login}` : ""}` : "none",
            pr ? (pr.state === "OPEN" ? t.accent : pr.state === "MERGED" ? t.ansi5 : t.dim) : t.muted))
          .when(Boolean(pr?.title), (e) => e.child(fact("", pr.title, t.muted)))
          .child(fact("Uncommitted", String(w.dirty ?? 0), w.dirty ? t.blocked : t.muted))
          .child(fact("Unpushed", String(unpushed ?? 0), unpushed ? t.blocked : t.muted))
          .child(fact("Ahead", `${w.ahead ?? 0} of master`, t.muted))
          .when(Boolean(w.time), (e) => e.child(fact("Last commit", `${ago(w.time, now)} ago`, t.muted)))
          .when(Boolean(w.subject), (e) => e.child(fact("", w.subject, t.dim)))
          .when(Boolean(w.created), (e) => e.child(fact("Created", `${ago(w.created, now)} ago`, t.muted)))))
      .child(v_flex().gap(8).pt(4)
        .when(!w.main && !busy, (e) => e.child(this.button("wt-remove", w.verdict === "missing" ? "Prune" : "Remove worktree…", t, () => this.ask(w), "danger")))
        .when(busy, (e) => e.child(h_flex().gap(8).items_center().text_color(t.dim).text_size(12.5)
          .child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.dim).spin(900)).child("Removing…")))
        .when(!w.missing, (e) => e.child(this.button("wt-open", "Open as space", t, () => this.openSpace(w))))
        .when(Boolean(pr?.url), (e) => e.child(this.button("wt-pr", `Open PR #${pr.number} ↗`, t, () => this.openPr(w)))));
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const rows = this.rows(now);
    const items = this.items(rows);
    this.lastRows = rows;
    this.lastItems = items;
    this.sel = Math.min(this.sel, Math.max(0, rows.length - 1));
    const w = rows[this.sel];
    const selKey = w && `w:${w.path}`;
    const focusedHere = this.handle.is_focused?.() ?? false;

    // Herdr moving its focus onto this pane gives it the keyboard too (see review-dashboard).
    const f = focused(), want = shared(FOCUS_KEY);
    if (f?.pane && want?.pane === f.pane && this.focusStamp !== want.at
      && panes().some((p) => p.pane === f.pane && p.mod === "my-worktrees")) {
      this.focusStamp = want.at;
      const stamp = want.at;
      for (const ms of [0, 60, 150, 300, 600]) cx.timer.after(ms, (cx) => {
        if (this.focusStamp !== stamp || focused()?.pane !== want.pane) return;
        if (!this.handle.is_focused()) { this.handle.focus(); cx.notify(); }
      });
    }

    const d = this.data[this.repo];
    const loading = this.loading[this.repo];
    const error = this.errors[this.repo];
    const counts = ORDER.map((v) => [v, rows.filter((r) => r.verdict === v).length]).filter(([, n]) => n);
    const listId = `wt-list-${this.repo}`;
    const list = !rows.length
      ? div().p(14).text_color(t.dim).child(loading ? "Looking through the worktrees…" : "No worktrees.")
      : div().flex_1().min_w(0).h_full().relative()
        .child(div().size_full().p(6)
          .child(v_virtual_list(listId, items.length, items.map((it) => it.h), (i) => items[i].key, (range) =>
            items.slice(range.start, range.end).map((it) => it.head ? this.head(it, t) : this.row(it.w, t, now, it.key === selKey)))
            .size_full().track_scroll(this.scroller)
            .on_item_click((key, cx) => {
              if (!key.startsWith("w:")) return;
              const i = rows.findIndex((r) => r.path === key.slice(2));
              if (i >= 0) this.sel = i;
              this.handle.focus();
              cx.notify();
            })))
        .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());

    const hint = h_flex().gap(14).text_size(11).text_color(t.dim).pt(10)
      .when(!focusedHere, (e) => e.child(div().child("Click here for keys")))
      .when(focusedHere, (e) => e.children([["h/l 1-3", "repo"], ["j/k", "worktree"], ["x", "remove"], ["enter", "open as space"], ["o", "PR"], ["R", "refresh"], ["[ ]", "dashboards"], ["?", "all keys"]]
        .map(([k, what]) => h_flex().gap(5).child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(what)))));

    return v_flex().id("wt-root").size_full().min_h(0).when(!glassy(t), (e) => e.bg(t.background)).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .child(homeBar(t, "worktrees"))
      .child(v_flex().w_full().flex_1().min_h(0).max_w(1200).mx_auto().px(28).py(22)
        .child(h_flex().gap(12).items_center().mb(18)
          .child(v_flex().flex_1().gap(4)
            .child(div().text_size(22).font_semibold().child("Worktrees"))
            .child(h_flex().gap(10).text_size(12.5).text_color(t.dim)
              .children(counts.map(([v, n]) => h_flex().gap(5).items_center()
                .child(div().size(7).rounded(4).bg(t[VERDICTS[v].color] ?? t.dim))
                .child(div().child(`${n} ${VERDICTS[v].label.toLowerCase()}`))))
              .when(Boolean(d?.at), (e) => e.child(div().child(`· checked ${ago(d.at, now)} ago`)))))
          .child(loading
            ? svg("mods/workspace-chrome/spinner.svg").size(16).text_color(t.dim).spin(900)
            : this.button("wt-refresh", "↻ Refresh", t, (cx) => this.refresh(this.repo, cx))))
        .when(Boolean(error), (e) => e.child(div().mb(12).px(12).py(8).rounded(8).bg(t.blocked + "1f").text_color(t.blocked).text_size(12.5).child(error)))
        .child(this.repoTabs(t))
        .child(h_flex().flex_1().min_h(0).rounded(10).border_1().border_color(t.border).bg(cardBg(t)).overflow_hidden()
          .child(list)
          .child(this.details(w, t, now)))
        .child(hint));
  }
}
