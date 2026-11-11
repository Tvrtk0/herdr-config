// Open PRs that ask for my review (gh search, review-requested:@me), grouped by repo.
// A click opens the PR in the browser; the list refreshes every five minutes.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
const alpha = (c, a) => (c.length === 9 ? c.slice(0, 7) : c) + a;
import { exec, theme, layout, run, spaces, agents, shared, setShared, home, panes, focused, nextCommand, readTextFile, appHome } from "herdr";

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

// The space PR tabs open in, by name, and the mod its Home tab shows.
const REVIEW_SPACE = "review";
const HOME_MOD = "review-dashboard";
// Kept in step with pr-diff: "owner/repo#123" → { tab } its review agent runs in.
const AGENTS_KEY = "pr-diff.agents";

// Each time Herdr's focused pane changes it is stamped here, so a focusable mod
// (pr-diff, review-dashboard) shown by it takes the keyboard without a click.
const FOCUS_KEY = "focus.moved";

const EVERY = 5 * 60 * 1000;
// Which repos, folders and review skills: machine-local, read from
// ~/.config/herdr-app/local.json (outside the dotfiles repo; local.example.json shows its shape).
const LOCAL = readTextFile(`${appHome()}/local.json`)
  .then((t) => { try { return JSON.parse(t ?? "{}") ?? {}; } catch { return {}; } })
  .catch(() => ({}));
// Repos listed first, in this order; the rest follow by name. From local.json.
const FIRST = [];
// Repos that list only the PRs still needing a review, as on the Review Dashboard.
const ONLY_NEEDING = [];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function age(iso, now) {
  const m = Math.floor((now - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const rankRepo = (r) => {
  const i = FIRST.indexOf(r);
  return i === -1 ? FIRST.length : i;
};

export default class ReviewPrs extends View {
  init(_props, cx) {
    // keys.json binds cmd-ctrl-a to "review-prs.swap"; this panel is always shown, so it can
    // switch the shown tab between its PR and its agent from either pane.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "swap") { const f = focused(); if (f) swapZoom(f.tab); }
        // The picker's Review scope: open the PR it put in shared "review.open".
        if (c === "open") { const pr = shared("review.open"); if (pr?.repository) this.diff(pr); }
        cx.notify();
      }
    });
    this.prs = JSON.parse(localStorage.getItem("prs") ?? "[]");
    this.error = null;
    this.loading = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    // Icons live where Herdr looks for them; a new file in the linked mod is not seen until restart.
    for (const n of ["home", "refresh"]) exec("cp", ["-n", `${appHome()}/mods/review-prs/${n}.svg`, `${appHome()}/icons/review-prs-${n}.svg`]).catch(() => {});
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      const local = await LOCAL;
      const repos = local.reviewRepos ?? [];
      FIRST.splice(0, FIRST.length, ...repos.map((r) => r.repo));
      ONLY_NEEDING.splice(0, ONLY_NEEDING.length, ...repos.filter((r) => r.onlyNeedingReview).map((r) => r.repo));
      this.refresh(cx);
    });
  }

  refresh(cx) {
    // A search that never answers (gh hung, a reload mid-call) must not leave the spinner on
    // for good: after 40 s the next refresh starts over, and each run gives up after 30 s.
    // The dashboard's list, when it is fresh: the same PRs, no second fetch, the same count.
    const feed = shared("review.feed");
    if (feed?.prs && Date.now() - feed.at < 6 * 60000) {
      this.prs = feed.prs;
      this.error = null;
      setShared("review.prs", feed.prs);
      cx.notify();
      return;
    }
    if (this.loading && Date.now() - (this.loadingAt ?? 0) < 40000) return;
    this.loading = true;
    this.loadingAt = Date.now();
    const run = (this.runId = (this.runId ?? 0) + 1);
    cx.notify();
    cx.timer.after(30000, (cx) => { if (this.runId === run && this.loading) { this.loading = false; this.error = "GitHub did not answer in 30 s"; cx.notify(); } });
    cx.spawn(async (cx) => {
      try {
        // Some repos: only PRs that still need a review, as on the Review Dashboard.
        const search = (extra) => exec("gh", [
          "search", "prs",
          "--review-requested=@me", "--state=open", "--draft=false", ...extra,
          "--json", "number,title,repository,author,url,updatedAt",
          "--limit", "60",
        ]);
        const [r, ...only] = await Promise.all([search([]), ...ONLY_NEEDING.map((repo) => search([`--repo=${repo}`, "--review=required"]))]);
        for (const x of [r, ...only]) if (x.code !== 0) throw new Error(x.stderr.trim() || `gh exited ${x.code}`);
        this.prs = [
          ...JSON.parse(r.stdout).filter((pr) => !ONLY_NEEDING.includes(pr.repository.nameWithOwner)),
          ...only.flatMap((x) => JSON.parse(x.stdout)),
        ];
        this.error = null;
        localStorage.setItem("prs", JSON.stringify(this.prs));
        // The picker's Review scope lists these.
        setShared("review.prs", this.prs.map(({ number, title, repository, author, url, updatedAt }) => ({ number, title, repository, author, url, updatedAt })));
      } catch (e) {
        if (this.runId === run) this.error = String(e?.message ?? e);
      }
      if (this.runId !== run) return;
      this.loading = false;
      cx.notify();
    });
  }

  open(url) {
    exec("open", [url]).catch(() => {});
  }

  // The review space, made when it doesn't exist yet: its PR tabs open here (the dashboard
  // is in the Home space).
  reviewSpace() {
    let space = spaces().find((s) => s.name.toLowerCase() === REVIEW_SPACE);
    let spare = null;
    if (!space) {
      run("space.new", { name: REVIEW_SPACE, folder: home() });
      space = spaces().find((s) => s.name.toLowerCase() === REVIEW_SPACE);
      if (!space) return null;
      // space.new opens it with a shell tab; Home takes its place.
      spare = space.tabs[0]?.id;
    }
    // The dashboard itself lives in the Home space now (my-agents keeps it); this space holds
    // the PR tabs. A new space's shell tab stays until a PR tab joins it.
    void spare;
    return spaces().find((s) => s.id === space.id) ?? null;
  }

  // The Review dashboard, in the Home space.
  home() {
    run("my-agents.home:review");
  }

  // The PR's diff in the review space: its tab if one is open there, else a new one.
  diff(pr) {
    const name = `#${pr.number}`;
    const space = this.reviewSpace();
    if (!space) return;
    let tab = space.tabs.find((tb) => tb.name === name);
    if (!tab) {
      run("tab.new", {
        space: space.id,
        name,
        mod: "pr-diff",
        props: { repo: pr.repository.nameWithOwner, number: pr.number, url: pr.url },
      });
      tab = spaces().find((s) => s.id === space.id)?.tabs.find((tb) => tb.name === name);
    }
    run("space.select", { id: space.id });
    if (tab) run("tab.select", { id: tab.id });
  }

  // The review agent pr-diff started for this PR, if its tab still holds one.
  agentFor(pr) {
    const rec = shared(AGENTS_KEY)?.[`${pr.repository.nameWithOwner}#${pr.number}`];
    return rec ? agents().find((a) => a.tab === rec.tab) ?? null : null;
  }

  agentBadge(a, t) {
    if (!a) return null;
    const color = t[a.status] ?? t.dim;
    const label = { working: "reviewing", blocked: "needs you", done: "ready", idle: "ready" }[a.status] ?? a.status;
    return h_flex().flex_none().gap(4).items_center().text_size(10.5).text_color(color)
      .child(a.status === "working"
        ? svg("mods/workspace-chrome/spinner.svg").size(10).text_color(color).spin(900)
        : div().size(6).rounded(3).bg(color))
      .child(div().child(label));
  }

  toggle(repo, cx) {
    this.folded.has(repo) ? this.folded.delete(repo) : this.folded.add(repo);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  // The block hugs its rows from the bottom of the sidebar, up to a third of the sidebar's
  // lists (the window less the brand bar and the footer); past that the list scrolls.
  // Agents, above, takes whatever is left.
  fit() {
    if (this.contentH == null) return;
    const vh = globalThis.window?.viewport_size?.()?.height ?? 900;
    const cap = Math.floor((vh - 46 - 69) / 3);
    const extra = (this.error ? 22 : 0) + (!this.error && !this.loading && (this.todoN ?? this.prs.length) === 0 ? 20 : 0);
    const want = Math.max(90, Math.min(cap, Math.ceil(41 + extra + this.contentH + 8 + 1)));
    if (Math.abs(want - (this.fitted ?? 0)) < 2) return;
    this.fitted = want;
    run("layout.resize", { id: "review", px: want });
  }

  render(cx) {
    const t = theme();
    // A window resize changes the cap: refit after this frame.
    const vh = globalThis.window?.viewport_size?.()?.height;
    if (vh && vh !== this.lastVh) { this.lastVh = vh; cx.timer.after(0, () => this.fit()); }
    const fp = focused()?.pane ?? null;
    if (fp !== this.lastPane) {
      this.lastPane = fp;
      // my-tabs stamps it too (the sidebar can be hidden); whichever renders first writes.
      const last = shared(FOCUS_KEY);
      const fresh = last?.pane === fp && Date.now() - last.at < 1000;
      if (fp && !fresh && panes().some((p) => p.pane === fp && p.mod)) cx.spawn(async () => setShared(FOCUS_KEY, { pane: fp, at: Date.now() }));
    }
    const now = Date.now();

    // Only what is still to do: a PR whose review agent is open is already being handled.
    const todo = this.prs.filter((pr) => !this.agentFor(pr));
    this.todoN = todo.length;
    const groups = new Map();
    for (const pr of todo) {
      const repo = pr.repository.nameWithOwner;
      if (!groups.has(repo)) groups.set(repo, []);
      groups.get(repo).push(pr);
    }
    const repos = [...groups.keys()].sort((a, b) => rankRepo(a) - rankRepo(b) || a.localeCompare(b));
    for (const list of groups.values()) list.sort((a, b) => b.number - a.number);

    if (narrow()) {
      return v_flex()
        .size_full()
        .bg(t.chrome)
        .border_t(1)
        .border_color(t.border)
        .items_center()
        .pt(10)
        .child(
          v_flex()
            .id("rp-count")
            .items_center()
            .gap(3)
            .px(6)
            .py(5)
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .tooltip(`${todo.length} PRs waiting for your review`)
            .on_click(() => run("my-agents.home:review"))
            .child(svg("mods/workspace-chrome/git-compare.svg").size(15).text_color(todo.length ? t.muted : t.dim))
            .child(div().text_size(11.5).font_semibold().text_color(todo.length ? t.foreground : t.dim).child(String(todo.length))),
        );
    }

    // A repo: its name and how many wait; the full list is the dashboard's.
    const header = (repo) =>
      h_flex()
        .id(`rp-g-${repo}`)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .tooltip("All of them on the Review Dashboard")
        .on_click(() => this.home())
        .child(div().truncate().child(repo.split("/")[1]))
        .child(div().flex_1())
        .child(div().px(6).rounded(8).bg(t.raised).text_color(t.foreground).child(String(groups.get(repo).length)));

    const row = (pr) =>
      v_flex()
        .id(`rp-${pr.url}`)
        .px(8)
        .py(5)
        .flex_none()
        .rounded(8)
        .gap(1)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(pr.title)
        .on_hover((on, cx) => {
          if (on) this.hovered = pr.url;
          else if (this.hovered === pr.url) this.hovered = null;
          cx.notify();
        })
        .on_click(() => this.diff(pr))
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().flex_none().text_color(t.dim).child(`#${pr.number}`))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(pr.title))
            .when(Boolean(this.agentFor(pr)), (el) => el.child(this.agentBadge(this.agentFor(pr), t)))
            .when(this.hovered === pr.url, (el) =>
              el.child(
                div()
                  .id(`rp-gh-${pr.url}`)
                  .flex_none()
                  .px(3)
                  .rounded(4)
                  .text_color(t.dim)
                  .hover((s) => s.bg(t.raised).text_color(t.foreground))
                  .tooltip("Open on GitHub")
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.open(pr.url);
                  })
                  .child("↗"),
              ),
            ),
        )
        .child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .truncate()
            .child(`${pr.author?.is_bot ? "bot" : pr.author?.login ?? "?"} · ${age(pr.updatedAt, now)}`),
        );

    // The newest a person opened; a bot's bump only when nothing else waits (it still counts).
    const bot = (pr) => pr.author?.is_bot || /\[bot\]$|^(dependabot|renovate|app\/)/.test(pr.author?.login ?? "");
    const lead = (list) => list.find((pr) => !bot(pr)) ?? list[0];
    // One card a repo: name and count on top, its newest PR on a single line under it.
    const short = (title) => title.replace(/^(\s*\[[^\]]*\]\s*)+/, "");
    const card = (repo) => {
      const list = groups.get(repo);
      const pr = lead(list);
      return v_flex()
        .id(`rp-c-${repo}`)
        .flex_none()
        .cursor_pointer()
        .hover((s) => s.border_color(t.muted))
        .tooltip(`${pr.title}\n${pr.author?.login ?? "?"} · ${age(pr.updatedAt, now)}`)
        .on_click(() => this.diff(pr))
        .px(10)
        .py(7)
        .gap(3)
        .rounded(8)
        .bg(t.hover)
        .border(1)
        .border_color(t.border)
        .child(
          h_flex()
            .id(`rp-g-${repo}`)
            .gap(6)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(div().flex_1().min_w(0).truncate().font_medium().child(repo.split("/")[1]))
            .child(div().font_semibold().text_color(t.foreground).child(String(list.length)))
            .child(div().text_color(t.dim).child(list.length === 1 ? "PR" : "PRs")),
        )
        .child(
          h_flex()
            .id(`rp-${pr.url}`)
            .gap(6)
            .items_center()
            .text_size(12)
            .text_color(t.foreground)
            .child(div().flex_none().text_color(t.dim).child(`#${pr.number}`))
            .child(div().flex_1().min_w(0).truncate().child(short(pr.title)))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(age(pr.updatedAt, now))),
        );
    };
    const rows = repos.map(card);

    const refresh = this.loading
      ? svg("mods/workspace-chrome/spinner.svg").size(15).flex_none().text_color(t.dim).spin(900)
      : div()
          .id("rp-refresh")
          .text_size(13)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .p(3)
          .rounded(5)
          .hover((s) => s.bg(t.hover))
          .tooltip("Refresh")
          .on_click((_e, cx) => this.refresh(cx))
          .child(svg("icons/review-prs-refresh.svg").size(15));

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .child(
        h_flex()
          .px(16)
          .h(41)
          .pt(14)
          .pb(5)
          .flex_none()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Review"))
              .when(todo.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(todo.length)))),
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                div()
                  .id("rp-home")
                  .text_size(13)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .p(3)
                  .rounded(5)
                  .hover((s) => s.bg(t.hover))
                  .tooltip("Review Dashboard (⌘⇧O)")
                  .on_click(() => this.home())
                  .child(svg("icons/review-prs-home.svg").size(15)),
              )
              .child(refresh),
          ),
      )
      .when(Boolean(this.error), (el) =>
        el.child(div().px(16).pb(6).text_size(11.5).text_color(t.blocked).child(this.error)),
      )
      .when(!this.error && !this.loading && todo.length === 0, (el) =>
        el.child(div().px(16).text_size(12).text_color(t.dim).child("Nothing waiting for your review.")),
      )
      .child(v_flex().id("rp-list").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar()
        // The rows at their own height: the block is sized from it (see fit).
        .child(v_flex().id("rp-content").flex_none().w_full().gap(6).pt(2)
          .on_size_change((size) => { this.contentH = size.height; this.fit(); })
          .children(rows)));
  }
}
