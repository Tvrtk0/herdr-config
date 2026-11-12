// YouTrack tasks on you, a Home dashboard: grouped by state, each with the PRs and worktree
// that belong to it (found by its ID in a PR's title, body or branch). Open it, start it in
// Claude (the project's start-task skill in a new tab), change its state, jump to its PR.
// Which YouTrack, query and projects: machine-local, in ~/.config/herdr-app/local.json
// ("youtrack", see local.example.json). The token stays in the Keychain: a shell pipes it
// straight into curl, it never reaches this script.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { exec, theme, run, spaces, shared, setShared, home, focused, panes, nextCommand, readTextFile, appHome, openOverlay } from "herdr";

const LOCAL = readTextFile(`${appHome()}/local.json`)
  .then((t) => { try { return JSON.parse(t ?? "{}") ?? {}; } catch { return {}; } })
  .catch(() => ({}));
const EVERY = 5 * 60 * 1000;
const FOCUS_KEY = "focus.moved";
// States in the order they matter; any other comes after these.
const ORDER = ["In Progress", "In Review", "To Verify", "Reopened", "Open", "Submitted", "Backlog"];

const alpha = (c, a) => ((c ?? "").length === 9 ? c.slice(0, 7) : c ?? "#888888") + a;
const glassy = (t) => (t.background ?? "").length === 9;
const cardBg = (t) => (glassy(t) ? t.foreground.slice(0, 7) + "0d" : t.surface);
const expand = (p) => String(p ?? "").replace(/^~(?=\/|$)/, home());
function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
// "[Web] [Torneo] Bulk import: …" reads as "Bulk import: …"; the tags go to a tooltip.
const short = (s) => String(s ?? "").replace(/^(\s*\[[^\]]*\]\s*)+/, "");

// A YouTrack call: the token from the Keychain becomes curl's header through a pipe.
function yt(cfg, method, path, body) {
  const script = 'security find-generic-password -s "$1" -w | sed "s/^/Authorization: Bearer /" | '
    + 'curl -sS -f -X "$2" -H @- -H "Accept: application/json" -H "Content-Type: application/json" '
    + '${4:+--data-binary "$4"} "$3"';
  return exec("sh", ["-c", script, "sh", cfg.keychain ?? "youtrack", method, `${cfg.url}${path}`, body ?? ""]).then((r) => {
    if (r.code !== 0) throw new Error((r.stderr || `YouTrack answered ${r.code}`).trim().split("\n").pop());
    try { return JSON.parse(r.stdout || "null"); } catch { throw new Error("YouTrack sent something that is not JSON"); }
  });
}

const FIELDS = "idReadable,summary,updated,created,project(shortName),customFields(name,value(name))";

export default class Tasks extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.issues = JSON.parse(localStorage.getItem("issues") ?? "[]");
    this.links = {};
    this.at = Number(localStorage.getItem("at")) || 0;
    this.sel = 0;
    this.stateFor = null; // the task whose state picker is open: { id, values }
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        if (c === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      const local = await LOCAL;
      this.cfg = local.youtrack ?? null;
      this.repos = local.worktreeRepos ?? [];
      this.refresh(cx);
    });
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    cx.timer.every(60000, (cx) => cx.notify());
  }

  refresh(cx) {
    if (!this.cfg?.url) { this.error = "No \"youtrack\" in ~/.config/herdr-app/local.json (see local.example.json)."; cx.notify(); return; }
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const q = encodeURIComponent(this.cfg.query ?? "for: me #Unresolved");
        const list = await yt(this.cfg, "GET", `/api/issues?query=${q}&fields=${FIELDS}&$top=200`);
        this.issues = (list ?? []).map((i) => {
          const f = Object.fromEntries((i.customFields ?? []).map((c) => [c.name, c.value?.name ?? null]));
          return { id: i.idReadable, summary: i.summary ?? "", project: i.project?.shortName ?? "", updated: i.updated ?? 0, created: i.created ?? 0,
            state: f.State ?? "No state", type: f.Type ?? null, priority: f["Priority level"] ?? f.Priority ?? null };
        });
        this.at = Date.now();
        localStorage.setItem("issues", JSON.stringify(this.issues));
        localStorage.setItem("at", String(this.at));
        await this.loadLinks();
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  // Each task's PRs (yours, any state, in the worktree repos) and the worktree on a PR's branch.
  async loadLinks() {
    const repos = [...new Map(this.repos.filter((r) => r.gh).map((r) => [r.gh, r])).values()];
    const prs = [];
    await Promise.all(repos.map(async (r) => {
      const got = await exec("gh", ["pr", "list", "--repo", r.gh, "--author", "@me", "--state", "all", "--limit", "80",
        "--json", "number,title,body,headRefName,url,state,isDraft,updatedAt"]).catch(() => null);
      if (got?.code === 0) for (const p of JSON.parse(got.stdout || "[]")) prs.push({ ...p, repo: r.gh });
    }));
    const trees = [];
    await Promise.all(this.repos.map(async (r) => {
      const got = await exec("git", ["-C", expand(r.dir), "worktree", "list", "--porcelain"]).catch(() => null);
      if (got?.code !== 0) return;
      let path = null;
      for (const line of got.stdout.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice(9);
        if (line.startsWith("branch ") && path) trees.push({ path, branch: line.slice(7).replace(/^refs\/heads\//, "") });
      }
    }));
    const links = {};
    for (const i of this.issues) {
      const re = new RegExp(`\\b${i.id.replace(/[-]/g, "\\-")}\\b`, "i");
      const mine = prs.filter((p) => re.test(p.title) || re.test(p.body ?? "") || re.test(p.headRefName))
        .sort((a, b) => (a.state === "OPEN" ? 0 : 1) - (b.state === "OPEN" ? 0 : 1) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const branches = new Set([...mine.map((p) => p.headRefName)]);
      const tree = trees.find((w) => branches.has(w.branch) || re.test(w.branch)) ?? null;
      if (mine.length || tree) links[i.id] = { prs: mine.slice(0, 3), tree };
    }
    this.links = links;
  }

  groups() {
    const by = new Map();
    for (const i of this.issues) { if (!by.has(i.state)) by.set(i.state, []); by.get(i.state).push(i); }
    const rank = (s) => { const k = ORDER.indexOf(s); return k < 0 ? ORDER.length : k; };
    return [...by.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([state, list]) => ({ state, list: list.sort((a, b) => b.updated - a.updated) }));
  }
  flat() { return this.groups().flatMap((g) => g.list); }

  url(i) { return `${this.cfg?.url ?? ""}/issue/${i.id}`; }

  // A new tab (or space) in the project's place, Claude in it with the start-task skill.
  start(i) {
    const p = this.cfg?.projects?.[i.project];
    if (!p) { this.flash(`No project "${i.project}" under youtrack.projects in local.json`); return; }
    const task = `${p.skill ?? "/start-task"} ${i.id} ${short(i.summary)}`;
    const space = spaces().find((s) => s.name.toLowerCase() === String(p.space ?? "").toLowerCase());
    if (space) run("tab.new", { space: space.id, name: i.id, folder: expand(p.dir), argv: ["claude"], task });
    else run("space.new", { name: p.space ?? i.project.toLowerCase(), folder: expand(p.dir), agent: ["claude"], task });
    this.flash(`Started ${i.id} in Claude`);
  }

  // The task's possible states (its project's State bundle), then the picker opens on the row.
  pickState(i, cx) {
    if (this.stateFor?.id === i.id) { this.stateFor = null; cx.notify(); return; }
    this.stateFor = { id: i.id, values: null };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const fields = await yt(this.cfg, "GET", `/api/issues/${i.id}/customFields?fields=name,$type,projectCustomField(bundle(values(name,archived)))`);
        const f = (fields ?? []).find((x) => x.name === "State");
        const values = (f?.projectCustomField?.bundle?.values ?? []).filter((v) => !v.archived).map((v) => v.name);
        if (this.stateFor?.id === i.id) this.stateFor = { id: i.id, values, type: f?.$type ?? "StateIssueCustomField" };
      } catch (e) { this.stateFor = null; this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  setState(i, name, cx) {
    const type = this.stateFor?.type ?? "StateIssueCustomField";
    this.stateFor = null;
    const was = i.state;
    i.state = name;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await yt(this.cfg, "POST", `/api/issues/${i.id}?fields=idReadable`, JSON.stringify({ customFields: [{ name: "State", $type: type, value: { name } }] }));
        this.flash(`${i.id}: ${was} → ${name}`);
      } catch (e) { i.state = was; this.error = `${i.id}: ${String(e?.message ?? e)}`; }
      cx.notify();
    });
  }

  openPr(p) {
    setShared("review.open", { repository: { nameWithOwner: p.repo }, number: p.number, url: p.url, title: p.title, at: Date.now() });
    run("review-prs.open");
  }

  openTree(w) { run("space.new", { folder: w.path, name: w.path.split("/").pop() }); }

  flash(text) { this.note = { text, at: Date.now() }; }

  onKey(e, cx) {
    const m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt) return;
    const key = e.key === "enter" ? "enter" : e.key === "escape" ? "escape" : e.key_char ?? e.key;
    if (key === "[") { run("my-agents.home:prev"); cx.stop_propagation(); return; }
    if (key === "]") { run("my-agents.home:next"); cx.stop_propagation(); return; }
    if (key === "?") { openOverlay({ mod: "keys-help", kind: "dialog", width: 760, height: 0.86, props: { context: "tasks" } }); cx.stop_propagation(); return; }
    const list = this.flat();
    const i = list[Math.min(this.sel, list.length - 1)];
    const link = i && this.links[i.id];
    // With the state picker open, its numbers pick.
    if (this.stateFor?.values && /^[1-9]$/.test(key)) {
      const v = this.stateFor.values[Number(key) - 1];
      if (v && i) this.setState(i, v, cx);
      cx.stop_propagation(); return;
    }
    const act = {
      j: () => { this.sel = Math.min(list.length - 1, this.sel + 1); this.stateFor = null; },
      k: () => { this.sel = Math.max(0, this.sel - 1); this.stateFor = null; },
      G: () => { this.sel = Math.max(0, list.length - 1); },
      g: () => { if (Date.now() - (this.lastG ?? 0) < 1000) { this.sel = 0; this.lastG = 0; } else this.lastG = Date.now(); },
      enter: () => i && exec("open", [this.url(i)]).catch(() => {}),
      o: () => i && exec("open", [this.url(i)]).catch(() => {}),
      s: () => i && this.start(i),
      m: () => i && this.pickState(i, cx),
      p: () => link?.prs?.[0] && this.openPr(link.prs[0]),
      w: () => link?.tree && this.openTree(link.tree),
      escape: () => { this.stateFor = null; },
      R: () => this.refresh(cx),
    }[key];
    if (!act) return;
    cx.stop_propagation();
    act();
    this.reveal();
    cx.notify();
  }

  reveal() {
    // Rows are the list's direct children after their group headings: find the row's index.
    const idx = this.rowIndex?.[this.sel];
    if (idx != null) this.scroll.scroll_to_item(idx);
  }

  chip(text, color, t, tip) {
    return div().flex_none().px(7).h(20).flex().items_center().rounded(10).bg(alpha(color, "1f")).text_size(11).text_color(color)
      .when(Boolean(tip), (e) => e.tooltip(tip)).child(text);
  }

  button(id, label, t, onClick, tip) {
    return div().id(id).flex_none().px(9).h(24).flex().items_center().rounded(6).border_1().border_color(t.border)
      .text_size(12).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(label);
  }

  stateColor(state, t) {
    if (/progress/i.test(state)) return t.working;
    if (/review|verify|test/i.test(state)) return t.accent ?? t.ansi4;
    if (/reopen|block/i.test(state)) return t.blocked;
    return t.muted;
  }

  row(i, n, on, t, now) {
    const link = this.links[i.id];
    const tags = (String(i.summary).match(/^(\s*\[[^\]]*\]\s*)+/) ?? [""])[0].trim();
    const picking = this.stateFor?.id === i.id;
    return v_flex().id(`tk-${i.id}`).px(16).py(10).gap(8).cursor_pointer()
      .when(on, (e) => e.bg(t.selected))
      .when(!on, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.sel = n; this.handle.focus(); cx.notify(); })
      .child(h_flex().gap(10).items_center()
        .child(div().flex_none().w(96).font_family("JetBrains Mono").text_size(12).text_color(t.dim).child(i.id))
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(t.foreground).when(Boolean(tags), (e) => e.tooltip(`${tags} ${short(i.summary)}`)).child(short(i.summary)))
        .when(Boolean(i.type) && i.type !== "Task", (e) => e.child(this.chip(i.type, t.dim, t)))
        .when(Boolean(i.priority) && !/normal/i.test(i.priority), (e) => e.child(this.chip(i.priority, /critical|show|urgent|major|high/i.test(i.priority) ? t.blocked : t.muted, t)))
        .children((link?.prs ?? []).map((p) => {
          const c = p.state === "MERGED" ? (t.ansi5 ?? t.accent) : p.state === "CLOSED" ? t.dim : p.isDraft ? t.muted : t.ansi2;
          return div().id(`tk-pr-${i.id}-${p.number}`).flex_none().px(7).h(20).flex().items_center().gap(4).rounded(10).bg(alpha(c, "1f")).text_size(11).text_color(c)
            .tooltip(`${p.title}\n${p.repo} · ${p.state.toLowerCase()}${p.isDraft ? " · draft" : ""} · p`)
            .hover((s) => s.opacity(0.8))
            .on_click((_e, cx) => { cx.stop_propagation(); this.openPr(p); })
            .child(svg("mods/workspace-chrome/git-compare.svg").size(11).text_color(c))
            .child(`#${p.number}`);
        }))
        .when(Boolean(link?.tree), (e) => e.child(div().id(`tk-wt-${i.id}`).flex_none().px(7).h(20).flex().items_center().gap(4).rounded(10).bg(alpha(t.muted, "1a")).text_size(11).text_color(t.muted)
          .tooltip(`${link.tree.branch}\n${link.tree.path.replace(home(), "~")} · w`)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.openTree(link.tree); })
          .child(svg("mods/workspace-chrome/git-branch.svg").size(11)).child("worktree")))
        .child(div().flex_none().w(34).flex().justify_end().text_size(11).text_color(t.dim).child(ago(i.updated, now))))
      // The chosen one: its actions, and the states when picking one.
      .when(on, (e) => e.child(h_flex().pl(106).gap(6).items_center().flex_wrap()
        .child(this.button(`tk-open-${i.id}`, "Open ↗", t, () => exec("open", [this.url(i)]).catch(() => {}), "enter"))
        .child(this.button(`tk-start-${i.id}`, "Start in Claude", t, () => this.start(i), "s: a new tab with the project's start-task skill"))
        .child(this.button(`tk-state-${i.id}`, picking ? "Cancel" : `State: ${i.state}`, t, (cx) => this.pickState(i, cx), "m"))
        .when(picking, (e) => e.children(this.stateFor.values == null
          ? [div().text_size(12).text_color(t.dim).child("Loading states…")]
          : this.stateFor.values.map((v, k) => div().id(`tk-sv-${i.id}-${k}`).flex_none().px(9).h(24).flex().items_center().gap(5).rounded(6)
              .bg(v === i.state ? alpha(this.stateColor(v, t), "26") : alpha(t.foreground, "08")).text_size(12)
              .text_color(v === i.state ? this.stateColor(v, t) : t.foreground).cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); if (v !== i.state) this.setState(i, v, cx); })
              .child(div().text_color(t.dim).child(String(k + 1))).child(div().child(v)))))));
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    this.focusedHere = this.handle.is_focused?.() ?? false;
    // Herdr moving its focus onto this pane gives it the keyboard (as the review dashboard).
    const f = focused(), want = shared(FOCUS_KEY);
    if (f?.pane && want?.pane === f.pane && this.focusStamp !== want.at && panes().some((p) => p.pane === f.pane && p.mod === "tasks")) {
      this.focusStamp = want.at;
      const stamp = want.at;
      for (const ms of [0, 60, 150, 300, 600]) cx.timer.after(ms, (cx) => {
        if (this.focusStamp !== stamp || focused()?.pane !== want.pane) return;
        if (!this.handle.is_focused()) { this.handle.focus(); cx.notify(); }
      });
    }
    const groups = this.groups();
    const total = this.issues.length;
    this.sel = Math.min(this.sel, Math.max(0, total - 1));
    const items = [];
    this.rowIndex = [];
    let n = 0;
    for (const g of groups) {
      const c = this.stateColor(g.state, t);
      items.push(h_flex().px(16).pt(14).pb(6).gap(8).items_center().text_size(11.5)
        .child(div().size(7).rounded(4).bg(c))
        .child(div().font_semibold().text_color(t.muted).child(g.state.toUpperCase()))
        .child(div().text_color(t.dim).child(String(g.list.length))));
      for (const i of g.list) {
        this.rowIndex[n] = items.length;
        items.push(this.row(i, n, this.focusedHere && n === this.sel, t, now));
        n++;
      }
    }
    const note = this.note && now - this.note.at < 4000 ? this.note.text : null;
    if (note) cx.timer.after(4100, (cx) => cx.notify());
    const keys = [["j/k", "task"], ["enter", "open"], ["s", "start in Claude"], ["m", "state"], ["p", "PR"], ["w", "worktree"], ["R", "refresh"], ["[ ]", "dashboards"], ["?", "all keys"]];
    return v_flex().id("tk-root").size_full().min_h(0).when(!glassy(t), (e) => e.bg(t.background)).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .child(v_flex().w_full().flex_1().min_h(0).max_w(1200).mx_auto().px(28).pt(24).pb(16)
        .child(h_flex().gap(12).items_center().mb(18)
          .child(v_flex().flex_1().gap(4)
            .child(div().text_size(22).font_semibold().child("Tasks"))
            .child(div().text_size(12.5).text_color(note ? t.ansi2 : t.dim).child(note
              ?? `${total} on you${groups.length ? ` · ${groups.map((g) => `${g.list.length} ${g.state.toLowerCase()}`).join(" · ")}` : ""}${this.at ? ` · updated ${ago(this.at, now)} ago` : ""}`)))
          .child(this.loading
            ? svg("mods/workspace-chrome/spinner.svg").size(16).text_color(t.dim).spin(900)
            : this.button("tk-refresh", "↻ Refresh", t, (cx) => this.refresh(cx))))
        .when(Boolean(this.error), (e) => e.child(div().mb(14).px(12).py(8).rounded(8).bg(alpha(t.blocked, "1f")).text_color(t.blocked).text_size(12.5).child(this.error)))
        .child(v_flex().id("tk-list").flex_1().min_h(0).rounded(12).border_1().border_color(t.border).bg(cardBg(t)).overflow_y_scrollbar().track_scroll(this.scroll)
          .when(!total, (e) => e.child(div().py(40).w_full().flex().justify_center().text_size(14).text_color(t.muted).child(this.loading ? "Loading…" : "Nothing on you")))
          .children(items))
        .child(h_flex().mt(14).gap(14).text_size(11).text_color(t.dim)
          .when(!this.focusedHere, (e) => e.child(div().child("Click here for keys")))
          .when(this.focusedHere, (e) => e.children(keys.map(([k, what]) => h_flex().gap(5).child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(what)))))));
  }
}
