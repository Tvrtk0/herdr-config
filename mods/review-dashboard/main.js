// The review space's home: every open PR that asks for my review, and my own open
// PRs, with size, CI, approvals, open threads and the review agent's state.
// A row opens the PR in the review space; Review also starts Claude beside it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, run, spaces, agents, panes, shared, setShared, home, focused, nextCommand, readTextFile, appHome, openOverlay } from "herdr";

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


// Stamped by review-prs when Herdr's focused pane changes: { pane, at }.
const FOCUS_KEY = "focus.moved";

const EVERY = 5 * 60 * 1000;
const REVIEW_SPACE = "review";
// Kept in step with pr-diff.
const AGENTS_KEY = "pr-diff.agents";
// Which repos, folders and review skills: machine-local, read from
// ~/.config/herdr-app/local.json (outside the dotfiles repo; local.example.json shows its shape).
const LOCAL = readTextFile(`${appHome()}/local.json`)
  .then((t) => { try { return JSON.parse(t ?? "{}") ?? {}; } catch { return {}; } })
  .catch(() => ({}));
// Filled from local.json once it is read (see useLocal).
// Which review skill runs for a repo, and in which folder.
const REVIEWERS = { default: { dir: "~", skill: "/comment-pr-frontend" } };
// Repos listed first, in this order.
const FIRST = [];
// Home's tabs: review requests per repo, then my own open PRs (any repo).
const TABS = [{ id: "your", label: "Your PRs", section: "mine", review: false }];

const QUERY = `query($q:String!){search(query:$q,type:ISSUE,first:60){nodes{... on PullRequest{
number title url isDraft createdAt updatedAt additions deletions changedFiles headRefName
author{login} repository{nameWithOwner}
latestReviews(first:30){nodes{author{login} state}}
reviewThreads(first:100){nodes{isResolved}}
commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;

const SECTIONS = [
  { id: "waiting", title: "Waiting for your review", q: "is:open is:pr review-requested:@me archived:false", review: true },
  { id: "mine", title: "Your open PRs", q: "is:open is:pr author:@me archived:false", review: false },
];

// local.json's repos into the tables above. A repo marked onlyNeedingReview lists only the
// PRs that still need a review (review:required), from a search of its own.
function useLocal(local) {
  Object.assign(REVIEWERS, local.reviewers ?? {});
  if (local.defaultReviewer) REVIEWERS.default = local.defaultReviewer;
  const repos = local.reviewRepos ?? [];
  FIRST.splice(0, FIRST.length, ...repos.map((r) => r.repo));
  TABS.splice(0, TABS.length - 1, ...repos.map((r) => ({
    id: r.label, label: r.label, repo: r.repo, review: true,
    section: r.onlyNeedingReview ? `only:${r.repo}` : "waiting",
  })));
  for (const r of repos.filter((x) => x.onlyNeedingReview)) {
    if (SECTIONS.some((s) => s.id === `only:${r.repo}`)) continue;
    SECTIONS.push({ id: `only:${r.repo}`, q: `repo:${r.repo} is:pr is:open review-requested:@me review:required archived:false`, keepOrder: false });
  }
}

// A color at some opacity, whether it came as #rrggbb or already #rrggbbaa.
const alpha = (c, a) => (c.length === 9 ? c.slice(0, 7) : c) + a;

function ago(iso, now) {
  const m = Math.floor((now - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function shape(p) {
  const reviews = p.latestReviews?.nodes ?? [];
  const threads = p.reviewThreads?.nodes ?? [];
  return {
    repo: p.repository.nameWithOwner,
    number: p.number,
    title: p.title,
    url: p.url,
    draft: p.isDraft,
    author: p.author?.login ?? "ghost",
    branch: p.headRefName,
    created: p.createdAt,
    updated: p.updatedAt,
    add: p.additions,
    del: p.deletions,
    files: p.changedFiles,
    approvals: reviews.filter((r) => r.state === "APPROVED").length,
    changes: reviews.filter((r) => r.state === "CHANGES_REQUESTED").length,
    threads: threads.length,
    openThreads: threads.filter((t) => !t.isResolved).length,
    ci: p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  };
}

const order = (a, b) => {
  const r = (x) => (FIRST.indexOf(x.repo) + 1 || FIRST.length + 1);
  // Oldest first: what has waited longest comes up first.
  return r(a) - r(b) || Date.parse(a.created) - Date.parse(b.created);
};

export default class ReviewDashboard extends View {
  init(_props, cx) {
    this.data = JSON.parse(localStorage.getItem("data") ?? "{}");
    this.at = Number(localStorage.getItem("at")) || 0;
    this.tab = localStorage.getItem("tab") ?? TABS[0].id;
    // Drafts in the review tabs: hidden unless asked for (D).
    this.showDrafts = localStorage.getItem("showDrafts") === "1";
    // The row j/k point at, in the shown tab.
    this.sel = 0;
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "focus") this.handle.focus();
        cx.notify();
      }
    });
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    // Ages tick once a minute.
    cx.timer.every(60000, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      useLocal(await LOCAL);
      if (!TABS.some((tb) => tb.id === this.tab)) this.tab = TABS[0].id;
      this.refresh(cx);
    });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const results = await Promise.all(SECTIONS.map((s) => exec("gh", ["api", "graphql", "-f", `q=${s.q}`, "-f", `query=${QUERY}`])));
        const data = {};
        SECTIONS.forEach((s, i) => {
          const r = results[i];
          if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exited ${r.code}`);
          data[s.id] = (JSON.parse(r.stdout)?.data?.search?.nodes ?? []).filter((p) => p.number).map(shape);
          if (!s.keepOrder) data[s.id].sort(order);
        });
        this.data = data;
        this.at = Date.now();
        // One fetch for everyone: the sidebar and the picker read this instead of asking GitHub.
        const only = new Set(SECTIONS.filter((x) => x.id.startsWith("only:")).map((x) => x.id.slice(5)));
        const waiting = [
          ...(data.waiting ?? []).filter((p) => !only.has(p.repo)),
          ...SECTIONS.filter((x) => x.id.startsWith("only:")).flatMap((x) => data[x.id] ?? []),
        ].filter((p) => !p.draft);
        setShared("review.feed", { at: Date.now(), prs: waiting.map((p) => ({ number: p.number, title: p.title, url: p.url, updatedAt: p.updated, repository: { nameWithOwner: p.repo }, author: { login: p.author } })) });
        // Stacks: every open PR of these repos, head and base branches, one cheap list per repo.
        const repos = [...new Set(Object.values(data).flat().map((p) => p.repo))];
        const lists = await Promise.all(repos.map((r) => exec("gh", ["pr", "list", "--repo", r, "--state", "open", "--limit", "200", "--json", "number,headRefName,baseRefName,title"])));
        this.stacks = {};
        repos.forEach((r, i) => { try { this.stacks[r] = JSON.parse(lists[i].stdout || "[]"); } catch { this.stacks[r] = []; } });
        this.error = null;
        localStorage.setItem("data", JSON.stringify(data));
        localStorage.setItem("at", String(this.at));
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  // The PR's tab in the review space: the open one, else a new one. Returns its id.
  openPr(pr, show = true) {
    const name = `#${pr.number}`;
    let space = spaces().find((s) => s.name.toLowerCase() === REVIEW_SPACE);
    if (!space) {
      run("space.new", { name: REVIEW_SPACE, folder: home() });
      space = spaces().find((s) => s.name.toLowerCase() === REVIEW_SPACE);
      if (!space) return null;
    }
    let tab = space.tabs.find((tb) => tb.name === name);
    if (!tab) {
      run("tab.new", { space: space.id, name, mod: "pr-diff", props: { repo: pr.repo, number: pr.number, url: pr.url } });
      tab = spaces().find((s) => s.id === space.id)?.tabs.find((tb) => tb.name === name);
    }
    if (show) {
      run("space.select", { id: space.id });
      if (tab) run("tab.select", { id: tab.id });
    }
    return tab?.id ?? null;
  }

  agentFor(pr) {
    const rec = shared(AGENTS_KEY)?.[`${pr.repo}#${pr.number}`];
    return rec ? agents().find((a) => a.tab === rec.tab) ?? null : null;
  }

  // Goes to the agent already on this PR.
  goToAgent(pr) {
    const running = this.agentFor(pr);
    if (!running) return;
    this.openPr(pr);
    run("pane.focus", { pane: running.pane });
  }

  // Starts Claude reviewing the PR beside its diff, out of sight: the PR's tab is made
  // (or reused) with the agent split beside a zoomed diff, and this tab stays shown.
  // Already reviewing: nothing new starts.
  review(pr, cx) {
    const key = `${pr.repo}#${pr.number}`;
    if (this.agentFor(pr)) {
      this.say(`#${pr.number} se već reviewa. Agent te vodi do njega.`, cx);
      return;
    }
    // One start at a time per PR: a second press while the tab is still being made waits.
    if (this.starting === key) return;
    this.starting = key;
    const here = focused();
    // Made out of sight: the dashboard stays shown.
    this.openPr(pr, false);
    const stay = () => {
      const f = focused();
      if (here?.space && f?.space !== here.space) run("space.select", { id: here.space });
      if (here?.tab && f?.tab !== here.tab) run("tab.select", { id: here.tab });
    };
    cx.timer.after(0, stay);
    // Herdr makes the space and the tab a moment after it is asked: look for the PR's pane a
    // few times instead of once, which is why the first press used to do nothing.
    const attempt = (n, cx) => {
      const space = spaces().find((s) => s.name.toLowerCase() === REVIEW_SPACE);
      const tab = space?.tabs.find((tb) => tb.name === `#${pr.number}`);
      const pane = tab && panes().find((p) => p.tab === tab.id && p.mod === "pr-diff");
      if (!pane) {
        // A new review space comes up empty the first time: ask for the PR's tab again.
        if (!tab && n % 4 === 3) { this.openPr(pr, false); cx.timer.after(0, stay); }
        if (n < 20) cx.timer.after(150, (cx) => attempt(n + 1, cx));
        else { this.starting = null; this.say(`#${pr.number} se nije otvorio, probaj opet.`, cx); }
        return;
      }
      const { dir, skill } = REVIEWERS[pr.repo] ?? REVIEWERS.default;
      const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      setShared(AGENTS_KEY, { ...(shared(AGENTS_KEY) ?? {}), [key]: { tab: tab.id, at: Date.now() } });
      run("pane.split", { direction: "right", pane: pane.pane, argv: ["/bin/zsh", "-lc", `cd ${dir} && exec claude ${q(`${skill} ${pr.url}`)}`] });
      // As the PR tab's own button does: the diff keeps the tab, the agent works behind it. No
      // focus moves: the dashboard stays shown (and if Herdr switched anyway, straight back).
      cx.timer.after(0, stay);
      cx.timer.after(120, () => { run("pane.zoom", { pane: pane.pane }); stay(); });
      cx.timer.after(250, (cx) => {
        stay();
        if (here?.pane) run("pane.focus", { pane: here.pane });
        this.starting = null;
        this.say(`Claude reviewa #${pr.number}. Kad završi, PR dobije oznaku Review ready.`, cx);
        // Keys stay here: Herdr hands the keyboard round as the tabs switch.
        for (const ms of [0, 100, 300, 600]) cx.timer.after(ms, (cx) => {
          if (here?.pane && focused()?.pane !== here.pane) return;
          if (!this.handle.is_focused()) { this.handle.focus(); cx.notify(); }
        });
      });
    };
    cx.timer.after(150, (cx) => attempt(0, cx));
    cx.notify();
  }

  // A line under the title for a few seconds, instead of a toast that would take the keys.
  say(text, cx) {
    const at = (this.flash = { text, at: Date.now() }).at;
    cx.notify();
    cx.timer.after(5000, (cx) => { if (this.flash?.at === at) { this.flash = null; cx.notify(); } });
  }

  // A small labelled fact: "✓ 2", "CI", "💬 3".
  chip(text, color, t, tip) {
    return div().flex_none().px(6).h(20).flex().items_center().rounded(5).text_size(11).bg(alpha(color, "1f")).text_color(color)
      .when(Boolean(tip), (e) => e.tooltip(tip)).child(text);
  }

  // The review agent's state. A finished review is what you act on next, so it is the loud one:
  // solid, with a check, beside the title.
  agentState(a, t) {
    if (!a) return null;
    return {
      working: { label: "Reviewing…", color: t.working },
      blocked: { label: "Needs you", color: t.blocked },
      done: { label: "Review ready", color: t.ansi2, ready: true },
      idle: { label: "Review ready", color: t.ansi2, ready: true },
    }[a.status] ?? { label: a.status, color: t.dim };
  }

  agentChip(a, t) {
    const st = this.agentState(a, t);
    if (!st) return null;
    const c = st.color;
    return h_flex().flex_none().gap(5).px(8).h(22).items_center().rounded(11).text_size(11.5).font_semibold()
      .when(Boolean(st.ready), (e) => e.bg(c).text_color(t.background.length === 9 ? t.background.slice(0, 7) : t.background))
      .when(!st.ready, (e) => e.bg(alpha(c, "26")).border_1().border_color(alpha(c, "73")).text_color(c))
      .tooltip(st.ready ? "Claude je složio komentare: tab Claude u PR-u" : st.label)
      .child(a.status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(11).text_color(c).spin(900)
        : st.ready ? svg("mods/workspace-chrome/check.svg").size(12).text_color(t.background.length === 9 ? t.background.slice(0, 7) : t.background)
        : div().size(6).rounded(3).bg(c))
      .child(div().child(st.label));
  }

  button(id, label, t, onClick, primary = false) {
    return div().id(id).flex_none().px(10).h(26).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)))
      .when(!primary, (e) => e.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  // h/l or 1-9 tab, j/k row, gg/G first/last, enter open, r review, o GitHub, R refresh.
  // Chords pass through.
  onKey(e, cx) {
    const m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt) return;
    const key = e.key === "enter" ? "enter" : e.key_char ?? e.key;
    if (homeKeys(key, "review")) { cx.stop_propagation(); return; }
    const tabs = this.tabs();
    const ti = Math.max(0, tabs.findIndex((tb) => tb.id === this.tab));
    const list = tabs[ti]?.list ?? [];
    const pr = list[Math.min(this.sel, list.length - 1)];
    const act = {
      h: () => { this.tab = tabs[Math.max(0, ti - 1)].id; this.sel = 0; },
      l: () => { this.tab = tabs[Math.min(tabs.length - 1, ti + 1)].id; this.sel = 0; },
      j: () => { this.sel = Math.min(list.length - 1, this.sel + 1); this.reveal(cx); },
      k: () => { this.sel = Math.max(0, this.sel - 1); this.reveal(cx); },
      z: () => {
        // zz: the chosen PR to the middle of the screen.
        if (Date.now() - (this.lastZ ?? 0) < 1000) { this.reveal(cx, "center"); this.lastZ = 0; } else this.lastZ = Date.now();
      },
      enter: () => pr && this.openPr(pr),
      r: () => pr && tabs[ti].review && this.review(pr, cx),
      o: () => pr && exec("open", [pr.url]).catch(() => {}),
      R: () => this.refresh(cx),
      D: () => this.toggleDrafts(cx),
      G: () => { this.sel = Math.max(0, list.length - 1); this.scrollTo(cx, "bottom"); },
      g: () => {
        // gg: two g within a second.
        if (Date.now() - (this.lastG ?? 0) < 1000) { this.sel = 0; this.lastG = 0; this.scrollTo(cx, 0); } else this.lastG = Date.now();
      },
      ...Object.fromEntries(tabs.map((tb, i) => [String(i + 1), () => { this.tab = tb.id; this.sel = 0; }])),
    }[key];
    if (!act) return;
    cx.stop_propagation();
    const was = this.tab;
    act();
    if (this.tab !== was) this.list.off = 0;
    localStorage.setItem("tab", this.tab);
    cx.notify();
  }

  // The list scrolls in a clipped box of its own (a plain scroll area can't be moved
  // from code): off is how far it has slid, view the box, full the list, heights each item.
  get list() {
    return (this._list ??= { off: 0, view: 0, full: 0, heights: [] });
  }

  scrollTo(cx, to) {
    const st = this.list;
    const max = Math.max(0, st.full - st.view);
    const target = Math.max(0, Math.min(max, to === "bottom" ? max : to));
    const from = st.off;
    if (Math.abs(target - from) < 1) return;
    // A few frames, eased, like the PR tab's half pages.
    const id = (this.anim = (this.anim ?? 0) + 1);
    for (let k = 1; k <= 8; k++) cx.timer.after(k * 16, (cx) => {
      if (this.anim !== id) return;
      const x = 1 - Math.pow(1 - k / 8, 3);
      st.off = from + (target - from) * x;
      cx.notify();
    });
  }

  // Keeps the chosen PR in view; "center" puts it in the middle (zz).
  reveal(cx, mode = "near") {
    const st = this.list;
    const idx = this.rowItem?.[this.sel];
    if (idx == null || !st.view) return;
    let top = 1;
    for (let i = 0; i < idx; i++) top += st.heights[i] ?? 0;
    const h = st.heights[idx] ?? 0;
    const pad = 16;
    // The first and last PR snap the list to its very top and bottom.
    if (mode === "near" && this.sel === 0) return this.scrollTo(cx, 0);
    if (mode === "near" && this.sel === (this.rowItem?.length ?? 0) - 1) return this.scrollTo(cx, "bottom");
    if (mode === "center") return this.scrollTo(cx, top + h / 2 - st.view / 2);
    if (top - pad < st.off) this.scrollTo(cx, top - pad);
    else if (top + h + pad > st.off + st.view) this.scrollTo(cx, top + h + pad - st.view);
  }

  // The scrolling box: the wheel moves it, a thin thumb shows where it is.
  scroller(t, content) {
    const st = this.list;
    st.off = Math.max(0, Math.min(st.off, Math.max(0, st.full - st.view)));
    const over = st.full > st.view + 1 && st.view > 0;
    const thumbH = over ? Math.max(28, st.view * st.view / st.full) : 0;
    const thumbTop = over ? (st.view - thumbH) * st.off / (st.full - st.view) : 0;
    return div().id("rh-scroll").flex_1().min_h(0).w_full().relative().overflow_hidden()
      .on_size_change((size, cx) => { if (Math.abs(size.height - st.view) >= 1) { st.view = size.height; cx.notify(); } })
      .on_scroll_wheel((e, cx) => {
        const max = Math.max(0, st.full - st.view);
        const off = Math.max(0, Math.min(max, st.off - (e.delta?.y ?? 0)));
        if (off !== st.off) { this.anim = (this.anim ?? 0) + 1; st.off = off; cx.stop_propagation(); cx.notify(); }
      })
      .child(div().id("rh-scroll-content").absolute().left(0).w_full().top(-st.off).pb(4)
        .on_size_change((size, cx) => { if (Math.abs(size.height - st.full) >= 1) { st.full = size.height; cx.notify(); } })
        .child(content))
      .when(over, (e) => e.child(div().absolute().right(3).top(thumbTop).w(4).h(thumbH).rounded(3).bg(t.border)));
  }

  // A stable color per author, from the theme's palette.
  avatar(login, t, size = 28) {
    const hues = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1, t.accent];
    let h = 0;
    for (const c of login) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const color = hues[h % hues.length] ?? t.accent;
    return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center()
      .bg(alpha(color, "2e")).border_1().border_color(alpha(color, "59"))
      .text_size(size * 0.42).font_semibold().text_color(color)
      .tooltip(login).child(login.slice(0, 1).toUpperCase());
  }

  // "[Web] Add a drawer" -> ["Web", "Add a drawer"].
  splitTitle(title) {
    const m = title.match(/^\s*\[([^\]]{1,16})\]\s*(.*)$/);
    return m ? [m[1], m[2]] : [null, title];
  }

  // The checks, in words: passing, running, failing.
  ciLine(state, t) {
    if (!state) return h_flex().gap(6).items_center().text_color(t.dim).child(div().size(7).rounded(4).border_1().border_color(t.dim)).child("No checks");
    const [text, color] = {
      SUCCESS: ["Checks pass", t.ansi2],
      FAILURE: ["Checks fail", t.ansi1],
      ERROR: ["Checks error", t.ansi1],
      PENDING: ["Checks running", t.working],
      EXPECTED: ["Checks waiting", t.working],
    }[state] ?? [state.toLowerCase(), t.dim];
    return h_flex().gap(6).items_center().text_color(color)
      .child(state === "PENDING" || state === "EXPECTED"
        ? svg("mods/workspace-chrome/spinner.svg").size(10).text_color(color).spin(1400)
        : div().size(7).rounded(4).bg(color))
      .child(text);
  }

  // How big, as a five-step meter plus the numbers.
  sizeBlock(pr, t) {
    const n = pr.add + pr.del;
    const step = n < 50 ? 1 : n < 250 ? 2 : n < 800 ? 3 : n < 2000 ? 4 : 5;
    const color = step <= 2 ? t.ansi2 : step === 3 ? t.working : t.ansi1;
    return v_flex().w(132).flex_none().gap(5).items_end().text_size(11.5)
      .child(h_flex().gap(6).items_center()
        .child(div().text_color(t.ansi2).child(`+${pr.add}`))
        .child(div().text_color(t.ansi1).child(`−${pr.del}`)))
      .child(h_flex().gap(6).items_center().text_color(t.dim)
        .tooltip(`${n} lines in ${pr.files} file${pr.files === 1 ? "" : "s"}`)
        .child(div().child(`${pr.files} file${pr.files === 1 ? "" : "s"}`))
        .child(h_flex().gap(2).children([1, 2, 3, 4, 5].map((i) => div().w(4).h(8).rounded(1).bg(i <= step ? color : t.input)))));
  }

  // Approvals, requested changes, open threads and the agent, only what has something to say.
  signals(pr, a, t) {
    const out = [];
    if (pr.approvals > 0) out.push(this.chip(`✓ ${pr.approvals} approved`, t.ansi2, t, `${pr.approvals} approval${pr.approvals > 1 ? "s" : ""}`));
    if (pr.changes > 0) out.push(this.chip(`✗ changes requested`, t.ansi1, t, "Changes requested"));
    if (pr.openThreads > 0) out.push(this.chip(`${pr.openThreads} open thread${pr.openThreads > 1 ? "s" : ""}`, t.blocked, t, `${pr.openThreads} open of ${pr.threads} threads`));
    else if (pr.threads > 0) out.push(this.chip(`${pr.threads} resolved`, t.dim, t, `${pr.threads} threads, all resolved`));
    return out;
  }

  // A PR's stack: the chain from the PR whose base is not another open PR, down to the last
  // one built on it. Null when the PR stands alone.
  stackOf(pr) {
    const all = this.stacks?.[pr.repo] ?? [];
    if (!all.length) return null;
    const byHead = new Map(all.map((p) => [p.headRefName, p]));
    const me = all.find((p) => p.number === pr.number);
    if (!me) return null;
    let root = me;
    for (let i = 0; i < 40 && byHead.has(root.baseRefName); i++) root = byHead.get(root.baseRefName);
    const chain = [root];
    for (let i = 0; i < 40; i++) {
      const kid = all.find((p) => p.baseRefName === chain.at(-1).headRefName);
      if (!kid) break;
      chain.push(kid);
    }
    if (chain.length < 2) return null;
    const at = chain.findIndex((p) => p.number === pr.number);
    return { chain, at, below: chain[at - 1] ?? null, base: root.baseRefName };
  }

  row(pr, section, t, now, selected = false) {
    const a = this.agentFor(pr);
    const key = `${pr.repo}#${pr.number}`;
    const [tag, title] = this.splitTitle(pr.title);
    const fresh = now - Date.parse(pr.created) < 3 * 3600000;
    const signals = this.signals(pr, a, t);
    const meta = [
      `#${pr.number}`,
      pr.author,
      `opened ${ago(pr.created, now)} ago`,
      ...(Math.abs(Date.parse(pr.updated) - Date.parse(pr.created)) > 5 * 60000 ? [`updated ${ago(pr.updated, now)} ago`] : []),
    ];
    // Rows sit inset with rounded corners: hover and selection are soft panels, and the lines
    // between rows are drawn by the list (none inside a stack, where the rail joins them).
    return h_flex().id(`rh-${section.id}-${key}`).mx(6).my(2).px(10).py(10).gap(14).items_center().rounded(10)
      // A hairline frame shows hover and the keys' row on any row, tinted ones included.
      .border_1().border_color("#00000000")
      .when(selected, (e) => e.bg(alpha(t.foreground, "0d")).border_color(alpha(t.foreground, "2e")))
      .when(!selected, (e) => e.hover((s) => s.bg(alpha(t.foreground, "0a")).border_color(alpha(t.foreground, "24"))))
      .when(pr.draft, (e) => e.opacity(0.8))
      .cursor_pointer()
      .on_click(() => this.openPr(pr))
      .when(Boolean(this.agentState(a, t)?.ready) && !selected, (e) => e.bg(alpha(t.ansi2, "0a")))
      // A green mark only for a review that is ready; the row the keys are on is shown by its
      // soft background alone (an accent bar there read as a warning).
      .child(div().w(3).h(36).rounded(2).flex_none().bg(this.agentState(a, t)?.ready ? t.ansi2 : "#00000000"))
      .child(this.avatar(pr.author, t))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(h_flex().gap(8).items_center().min_w(0)
          .when(!section.repo, (e) => e.child(this.chip(pr.repo.split("/")[1], t.muted, t)))
          .when(Boolean(tag), (e) => e.child(div().flex_none().px(5).h(18).flex().items_center().rounded(4).border_1().border_color(t.input).text_size(10.5).text_color(t.muted).child(tag)))
          .child(div().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(title))
          .when(Boolean(this.stackOf(pr)), (e) => {
            const st = this.stackOf(pr);
            const tip = `Stack on ${st.base}:\n${st.chain.map((p, i) => `${i === st.at ? "▸" : " "} ${i + 1}. #${p.number} ${p.title}`).join("\n")}`;
            return e.child(h_flex().id(`rh-stack-${key}`).flex_none().gap(4).items_center().px(6).h(18).rounded(4).text_size(10.5)
              .bg(alpha(t.ansi5 ?? t.accent, "1f")).text_color(t.ansi5 ?? t.accent).tooltip(tip)
              .child(svg("mods/workspace-chrome/layers.svg").size(10).text_color(t.ansi5 ?? t.accent))
              .child(div().child(`${st.at + 1}/${st.chain.length}${st.below ? ` · on #${st.below.number}` : ""}`)));
          })
          .when(pr.draft, (e) => e.child(this.chip("Draft", t.dim, t)))
          .when(fresh && !pr.draft, (e) => e.child(this.chip("New", t.accent, t, "Opened in the last 3 hours")))
          .when(Boolean(a), (e) => e.child(this.agentChip(a, t))))
        .child(h_flex().gap(10).items_center().min_w(0).text_size(11.5).text_color(selected ? t.muted : t.dim)
          .child(div().flex_none().child(meta.join("  ·  ")))
          .child(h_flex().min_w(0).gap(4).items_center().truncate()
            .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none().text_color(t.dim))
            .child(div().min_w(0).truncate().child(pr.branch))))
        .when(signals.length > 0, (e) => e.child(h_flex().gap(6).items_center().children(signals))))
      .child(div().w(118).flex_none().text_size(11.5).child(this.ciLine(pr.ci, t)))
      .child(this.sizeBlock(pr, t))
      .child(h_flex().w(section.review ? 104 : 30).flex_none().gap(6).items_center().justify_end()
        .when(section.review, (e) => e.child(this.button(`rh-rv-${section.id}-${key}`, a ? "Agent" : "Review", t, (cx) => (a ? this.goToAgent(pr) : this.review(pr, cx)), selected && !a)))
        .child(this.button(`rh-gh-${section.id}-${key}`, "↗", t, () => exec("open", [pr.url]).catch(() => {}))));
  }

  // The tabs: review requests per repo, then my own PRs. A repo outside the
  // known ones gets a tab of its own while it has PRs.
  tabs() {
    const waiting = this.data.waiting ?? [];
    const known = TABS.filter((tb) => tb.repo).map((tb) => tb.repo);
    const extra = [...new Set(waiting.map((p) => p.repo).filter((r) => !known.includes(r)))]
      .map((repo) => ({ id: repo, label: repo.split("/")[1], section: "waiting", repo, review: true }));
    const all = [...TABS.filter((tb) => tb.repo), ...extra, ...TABS.filter((tb) => !tb.repo)];
    // Ready PRs first, drafts after them (a stable sort keeps the order within each).
    // Review tabs hide drafts unless shown; my own PRs keep theirs.
    return all.map((tb) => {
      const list = (this.data[tb.section] ?? []).filter((p) => !tb.repo || p.repo === tb.repo)
        .map((p, i) => [p, i]).sort((x, y) => (x[0].draft - y[0].draft) || (x[1] - y[1])).map(([p]) => p);
      const hide = tb.review && !this.showDrafts;
      const shown = this.groupStacks(hide ? list.filter((p) => !p.draft) : list);
      return { ...tb, list: shown, drafts: list.filter((p) => p.draft).length, hidden: hide };
    });
  }

  // PRs of one stack next to each other, in the stack's order, where its first one stood.
  groupStacks(list) {
    const out = [], placed = new Set();
    for (const p of list) {
      if (placed.has(p)) continue;
      const st = this.stackOf(p);
      if (!st) { out.push(p); placed.add(p); continue; }
      const mates = list.filter((q) => !placed.has(q) && q.draft === p.draft && this.stackOf(q)?.chain[0].number === st.chain[0].number);
      mates.sort((a, b) => this.stackOf(a).at - this.stackOf(b).at);
      for (const q of mates) { out.push(q); placed.add(q); }
    }
    return out;
  }

  pickTab(id, cx) {
    if (id !== this.tab) this.list.off = 0;
    this.tab = id;
    this.sel = 0;
    localStorage.setItem("tab", id);
    cx.notify();
  }

  tabBar(tabs, current, t) {
    return h_flex().gap(4).mb(14).border_b(1).border_color(t.border)
      .children(tabs.map((tb) => {
        const on = tb.id === current.id;
        const open = tb.list.reduce((n, p) => n + (p.openThreads > 0 ? 1 : 0), 0);
        return h_flex().id(`rh-tab-${tb.id}`).px(12).h(36).gap(8).items_center().cursor_pointer().mb(-1)
          .border_b(2).border_color(on ? t.accent : "#00000000")
          .text_size(13.5).text_color(on ? t.foreground : t.muted)
          .when(on, (e) => e.font_semibold())
          .when(!on, (e) => e.hover((s) => s.text_color(t.foreground)))
          .on_click((_e, cx) => this.pickTab(tb.id, cx))
          .child(div().child(tb.label))
          .child(this.chip(String(tb.list.length), tb.list.length ? (on ? t.accent : t.muted) : t.dim, t,
            tb.review ? `${tb.list.length} waiting for your review` : `${tb.list.length} open, ${open} with open threads`));
      }));
  }

  toggleDrafts(cx) {
    this.showDrafts = !this.showDrafts;
    localStorage.setItem("showDrafts", this.showDrafts ? "1" : "0");
    cx.notify();
  }

  // The line under a review tab's list: how many drafts there are, and a switch for them.
  draftsLine(tb, t) {
    if (!tb.review || !tb.drafts) return null;
    return h_flex().id(`rh-drafts-${tb.id}`).mt(10).px(4).gap(6).items_center().text_size(12).text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.toggleDrafts(cx))
      .child(svg(`mods/workspace-chrome/chevron-${tb.hidden ? "right" : "down"}.svg`).size(11).text_color(t.dim))
      .child(div().child(tb.hidden ? `${tb.drafts} draft${tb.drafts > 1 ? "s" : ""} hidden · show` : `Hide ${tb.drafts} draft${tb.drafts > 1 ? "s" : ""}`));
  }

  listView(tb, t, now) {
    if (!tb.list.length) {
      return v_flex().w_full().items_center().gap(6).py(40).rounded(12).border_1().border_color(t.border).bg(cardBg(t))
        .child(div().text_size(14).text_color(t.muted).child(this.loading ? "Loading…" : tb.review ? "Nothing waiting for your review" : "You have no open PRs"))
        .when(!this.loading, (e) => e.child(div().text_size(12).text_color(t.dim).child(tb.review ? "New requests show up here every 5 minutes." : "")));
    }
    const sel = this.focusedHere ? Math.min(this.sel, tb.list.length - 1) : -1;
    const ready = tb.list.filter((p) => !p.draft).length;
    const heading = (label, n, about) => h_flex().px(16).pt(14).pb(8).gap(8).items_center().text_size(11.5)
      .child(div().font_semibold().text_color(t.muted).child(label.toUpperCase()))
      .child(div().text_color(t.dim).child(String(n)))
      .child(div().text_color(t.dim).child(about));
    const groups = [];
    this.rowItem = [];
    for (let i = 0; i < tb.list.length; i++) {
      const pr = tb.list[i];
      if (i === 0 && !pr.draft) groups.push(heading(tb.review ? "Ready for review" : "Open", ready, ""));
      if (pr.draft && (i === 0 || !tb.list[i - 1].draft)) groups.push(heading("Drafts", tb.list.length - ready, "· still being worked on"));
      // A stack: a header, then its PRs on a rail like a branch graph, a node per PR, from the
      // one on the base branch at the top to the last one built on it.
      const st = this.stackOf(pr);
      const same = (q) => q && q.draft === pr.draft && this.stackOf(q)?.chain[0].number === st?.chain[0].number;
      const first = Boolean(st) && !same(tb.list[i - 1]), last = Boolean(st) && !same(tb.list[i + 1]);
      const tone = t.ansi5 ?? t.accent;
      // A thin line between rows, inset like them; none between rows of one stack.
      if (i > 0 && !(st && !first)) groups.push(div().mx(16).h(1).bg(alpha(t.foreground, "0f")));
      if (st && first) {
        const n = tb.list.filter(same).length;
        groups.push(h_flex().px(16).pt(12).pb(4).gap(8).items_center()
          .child(div().size(22).flex_none().rounded(6).bg(alpha(tone, "24")).flex().items_center().justify_center()
            .child(svg("mods/workspace-chrome/layers.svg").size(12).text_color(tone)))
          .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("Stack"))
          .child(h_flex().gap(4).items_center().min_w(0).text_size(11.5).text_color(t.dim)
            .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none().text_color(t.dim))
            .child(div().min_w(0).truncate().font_family("JetBrains Mono").child(st.base)))
          .child(div().flex_1())
          .child(div().flex_none().px(7).h(20).flex().items_center().rounded(10).bg(alpha(tone, "1a")).text_size(11).text_color(tone)
            .child(n === st.chain.length ? `${n} PRs` : `${n} of ${st.chain.length} waiting for you`)));
      }
      this.rowItem[i] = groups.length;
      const row = this.row(pr, tb, t, now, i === sel);
      if (!st) { groups.push(row); continue; }
      // The rail continues through the gap between rows, so the dot sits on the row's middle.
      const line = alpha(tone, "66");
      const rail = v_flex().w(22).flex_none().items_center()
        .child(div().w(2).flex_1().bg(first ? "#00000000" : line))
        .child(div().size(10).flex_none().rounded(5).border_2().border_color(tone).bg(i === sel ? tone : t.background))
        .child(div().w(2).flex_1().bg(last ? "#00000000" : line));
      groups.push(h_flex().w_full().items_stretch().pl(10).child(rail).child(div().flex_1().min_w(0).child(row)));
    }
    // Each item measured, so keys know where a PR sits in the list.
    const st = this.list;
    st.heights.length = groups.length;
    return v_flex().w_full().rounded(12).border_1().border_color(t.border).bg(cardBg(t)).overflow_hidden()
      .children(groups.map((g, i) => div().id(`rh-it-${tb.id}-${i}`).w_full()
        .on_size_change((size) => { st.heights[i] = size.height; })
        .child(g)));
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const waiting = this.tabs().filter((tb) => tb.review).reduce((n, tb) => n + tb.list.length, 0);
    const tabs = this.tabs();
    const current = tabs.find((tb) => tb.id === this.tab) ?? tabs[0];
    const reviewing = Object.keys(shared(AGENTS_KEY) ?? {}).filter((k) => {
      const rec = shared(AGENTS_KEY)[k];
      return agents().some((a) => a.tab === rec.tab && a.status === "working");
    }).length;
    this.focusedHere = this.handle.is_focused?.() ?? false;
    // Herdr moving its focus onto this pane (cmd-p, a tab picked, the sidebar's home) gives it
    // the keyboard too; review-prs stamps each move, so a copy that was hidden still sees it.
    const f = focused(), want = shared(FOCUS_KEY);
    if (f?.pane && want?.pane === f.pane && this.focusStamp !== want.at
      && panes().some((p) => p.pane === f.pane && p.mod === "review-dashboard")) {
      this.focusStamp = want.at;
      // focus() can't run during render: timers run it right after, retried for a moment
      // because cmd-p's picker hands the keyboard back as it closes, after us.
      const stamp = want.at;
      for (const ms of [0, 60, 150, 300, 600]) cx.timer.after(ms, (cx) => {
        if (this.focusStamp !== stamp || focused()?.pane !== want.pane) return;
        if (!this.handle.is_focused()) { this.handle.focus(); cx.notify(); }
      });
    }
    const hint = h_flex().mt(14).gap(14).text_size(11).text_color(t.dim)
      .when(!this.focusedHere, (e) => e.child(div().child("Click here or move with cmd-ctrl-h/j/k/l for keys")))
      .when(this.focusedHere, (e) => e.children([["h/l 1-3", "tab"], ["j/k", "PR"], ["zz", "center"], ["gg/G", "first/last"], ["enter", "open"], ["r", "review in background"], ["o", "GitHub"], ["D", "drafts"], ["R", "refresh"], ["[ ]", "dashboards"], ["?", "all keys"]]
        .map(([k, what]) => h_flex().gap(5).child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(what)))));
    return v_flex().id("rh-root").size_full().min_h(0).when(!glassy(t), (e) => e.bg(t.background)).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .child(homeBar(t, "review"))
      .child(v_flex().w_full().flex_1().min_h(0).max_w(1200).mx_auto().px(28).pt(24).pb(16)
        .child(h_flex().gap(12).items_center().mb(22)
          .child(v_flex().flex_1().gap(4)
            .child(div().text_size(22).font_semibold().child("Review"))
            .when(Boolean(this.flash), (e) => e.child(h_flex().gap(6).items_center().text_size(12.5).text_color(t.ansi2)
              .child(svg("mods/workspace-chrome/check.svg").size(12).text_color(t.ansi2)).child(this.flash.text)))
            .when(!this.flash, (e) => e.child(div().text_size(12.5).text_color(t.dim).child(
              `${waiting} waiting for you${reviewing ? ` · ${reviewing} agent${reviewing > 1 ? "s" : ""} reviewing` : ""}${this.at ? ` · updated ${ago(new Date(this.at).toISOString(), now)} ago` : ""}`))))
          .child(this.loading
            ? svg("mods/workspace-chrome/spinner.svg").size(16).text_color(t.dim).spin(900)
            : this.button("rh-refresh", "↻ Refresh", t, (cx) => this.refresh(cx))))
        .when(Boolean(this.error), (e) => e.child(div().mb(16).px(12).py(8).rounded(8).bg(alpha(t.blocked, "1f")).text_color(t.blocked).text_size(12.5).child(this.error)))
        .child(this.tabBar(tabs, current, t))
        .child(this.scroller(t, v_flex().w_full()
          .child(this.listView(current, t, now))
          .child(this.draftsLine(current, t) ?? div())))
        .child(hint));
  }
}
