// The overview (cmd-shift-o): every Claude session at a glance (what it does, where its plan
// is, its context), the PRs waiting on you and your own, the limits, today's numbers and git,
// and the next meetings with their Meet link. Data: collect.py (sessions, today, git), gh
// (PRs), cal.swift compiled to ~/.config/herdr-app/bin/herdr-cal (the macOS calendar, which
// MeetingBar's Google calendars sync into).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, home, appHome, props, theme, agents, terminals, panes, focused, run, closeOverlay, openOverlay, readTextFile, setShared, nextCommand } from "herdr";

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


const alpha = (c, a) => (c.length === 9 ? c.slice(0, 7) : c) + a;
const LOCAL = readTextFile(`${appHome()}/local.json`).then((t) => JSON.parse(t ?? "{}")).catch(() => ({}));
const ago = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 1 ? "now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
};
// "Saturday, 7 November" without Intl (QuickJS has none).
const today = () => {
  const d = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
};
// A timestamp's ms, or 0 when there is none (Date.parse(0) is 1 January 2000, not 0).
const stamp = (v) => (v ? Date.parse(v) || 0 : 0);
const hm = (sec) => { const d = new Date(sec * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export default class Overview extends View {
  init(_props, cx) {
    this.data = null;
    this.prs = null;
    this.cal = null;
    this.handle = cx.focus_handle();
    // "pregled.focus" (the Home space hands it the keyboard when its tab is shown).
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "focus") this.handle.focus(); cx.notify(); } });
    if (props()?.overlay) { this.handle.focus(); cx.timer.after(150, () => this.handle.focus()); }
    this.load(cx);
    this.loadCal(cx);
    cx.timer.every(30000, (cx) => this.load(cx));
    cx.timer.every(300000, (cx) => this.loadCal(cx));
    cx.timer.every(1000, (cx) => cx.notify());
    // The board breathes and bounces: a quicker redraw while a session works or needs you.
    cx.timer.every(120, (cx) => { if (this.visible() && agents().some((a) => a.app === "claude-code" && (a.status === "working" || a.status === "blocked"))) cx.notify(); });
  }

  // Shown now: as an overlay, or its tab is the one in front.
  visible() {
    if (props()?.overlay) return true;
    const me = panes().find((p) => p.pane === props()?.pane);
    return !me || me.tab === focused()?.tab;
  }

  load(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const local = await LOCAL;
        // Your name for the greeting, from local.json ("name"); none, a plain greeting.
        this.name = typeof local.name === "string" ? local.name.trim() : "";
        const dirs = ["~/dotfiles", "~/.claude/mods", ...(local.worktreeRepos ?? []).map((r) => r.dir)];
        const terms = agents().filter((a) => a.app === "claude-code").map((a) => a.address);
        const r = await exec("python3", ["-I", `${appHome()}/mods/pregled/collect.py`, JSON.stringify(terms), JSON.stringify(dirs)]);
        if (r.code === 0) {
          // A session read short (it was mid-tool) keeps what the last read knew of it.
          const got = JSON.parse(r.stdout);
          const before = new Map((this.data?.sessions ?? []).map((x) => [x.terminal, x]));
          got.sessions = got.sessions.map((x) => (x.askedAt || x.spokeAt || !before.get(x.terminal) ? x : { ...before.get(x.terminal), ...x, askedAt: before.get(x.terminal).askedAt, spokeAt: before.get(x.terminal).spokeAt }));
          this.data = got;
          this.error = null;
        }
        else this.error = r.stderr.trim().split("\n").pop();
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      cx.notify();
    });
  }

  // The calendar reader is compiled once (a few seconds), then asked every five minutes.
  loadCal(cx) {
    cx.spawn(async (cx) => {
      const bin = `${appHome()}/bin/herdr-cal`;
      if ((await exec("test", ["-x", bin])).code !== 0) {
        await exec("mkdir", ["-p", `${appHome()}/bin`]);
        await exec("swiftc", ["-O", `${appHome()}/mods/pregled/cal.swift`, "-o", bin]);
      }
      // Through herdr-core: it holds the calendar permission, the app itself does not.
      const r = await hc(["exec", bin]);
      try { const got = JSON.parse(r.stdout); this.cal = Array.isArray(got) ? got : []; this.calError = got.error === "no-access" ? "No calendar access: System Settings → Privacy & Security → Calendars → Herdr (Full Access)" : got.error ?? null; }
      catch { this.cal = []; this.calError = "The calendar cannot be read"; }
      cx.notify();
    });
  }

  // The frame: the Home tabs on top (not as an overlay), the page scrolling under them.
  shell(t, page) {
    const overlay = Boolean(props()?.overlay);
    return v_flex().id("ov-root").size_full().track_focus(this.handle).bg(overlay ? t.popover : t.background).text_color(t.foreground)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .when(!overlay, (e) => e.child(homeBar(t, "overview")))
      .child(div().id("ov-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(page));
  }

  // j/k pick a session (its card shows), enter opens it, R refreshes; [ ] and ? as on every
  // dashboard.
  onKey(e, cx) {
    const m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt) return;
    const key = e.key === "enter" ? "enter" : e.key === "escape" ? "escape" : e.key_char ?? e.key;
    if (key === "escape" && props()?.overlay) { cx.stop_propagation(); closeOverlay(props().overlay); return; }
    if (homeKeys(key, "overview")) { cx.stop_propagation(); return; }
    const list = this.order ?? [];
    const at = Math.max(0, list.findIndex((a) => a.address === this.hovered));
    const act = {
      j: () => { if (list.length) this.hovered = list[Math.min(list.length - 1, at + 1)].address; },
      k: () => { if (list.length) this.hovered = list[Math.max(0, at - 1)].address; },
      enter: () => {
        const a = list.find((x) => x.address === this.hovered) ?? list[0];
        if (a) { run("agent.focus", { terminal: a.address }); if (props()?.overlay) closeOverlay(props().overlay); }
      },
      R: () => { this.load(cx); this.loadCal(cx); },
    }[key];
    if (!act) return;
    cx.stop_propagation();
    act();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const d = this.data;
    const now = Date.now();
    const pct = (v) => `${Math.max(2, Math.min(100, Math.round(v)))}%`;
    const warm = (v) => (v < 60 ? t.ansi2 : v < 85 ? t.working : t.ansi1);
    const label = (text) => div().text_size(11).font_semibold().text_color(t.dim).child(text);
    const small = (text, color) => div().text_size(11.5).text_color(color ?? t.dim).child(text);
    const bar = (v, color, h = 5) => div().h(h).w_full().rounded(3).bg(alpha(t.foreground, "12")).overflow_hidden()
      .child(div().h_full().rounded(3).bg(color).w(pct(v)));
    const section = (title, count, extra) => h_flex().gap(10).items_center().pb(2)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title))
      .when(count != null, (e) => e.child(div().px(7).h(18).flex().items_center().rounded(9).bg(alpha(t.foreground, "10")).text_size(11).text_color(t.muted).child(String(count))))
      .when(Boolean(extra), (e) => e.child(extra))
      .child(div().flex_1().h(1).bg(t.border));
    // A tile: a label, the number, a line under it.
    const tile = (id, _accent) => h_flex().id(id).flex_1().min_w(0).rounded(12).border_1().border_color(t.border).bg(t.raised).overflow_hidden();

    // Limits
    const l = d?.limits ?? {};
    const five = l.five_hour, week = l.seven_day;
    const day = (sec) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(sec * 1000).getDay()];
    const limitHalf = (name, x, when) => v_flex().flex_1().min_w(0).gap(5)
      .child(h_flex().gap(6).items_baseline()
        .child(div().text_size(22).font_semibold().text_color(x ? warm(x.used_percentage) : t.dim).child(x ? `${Math.round(x.used_percentage)}%` : "–"))
        .child(small(name)))
      .child(bar(x?.used_percentage ?? 0, warm(x?.used_percentage ?? 0)))
      .child(small(x?.resets_at ? `resets ${when(x.resets_at)}` : " "));
    const limitTile = tile("ov-limits", warm(Math.max(five?.used_percentage ?? 0, week?.used_percentage ?? 0)))
      .child(v_flex().flex_1().min_w(0).p(14).gap(10)
        .child(label("LIMITS"))
        .child(h_flex().gap(18).child(limitHalf("5 hours", five, (s) => hm(s))).child(limitHalf("week", week, (s) => `${day(s)} ${hm(s)}`))));

    // Today
    const td = d?.today ?? {};
    const n = td.tokens ?? 0, millions = (n * 1e-6).toFixed(1), thousands = Math.round(n * 1e-3);
    const tok = n >= 1e6 ? millions + "M" : n >= 1e3 ? thousands + "k" : String(n);
    const stat = (value, what) => v_flex().gap(2).child(div().text_size(22).font_semibold().text_color(t.foreground).child(value)).child(small(what));
    const todayTile = tile("ov-today", t.accent ?? t.ansi4)
      .child(v_flex().flex_1().min_w(0).p(14).gap(10)
        .child(label("TODAY WITH CLAUDE"))
        .child(h_flex().gap(22).child(stat(String(td.prompts ?? "–"), "prompts")).child(stat(String(td.sessions ?? "–"), "sessions")).child(stat(tok, "tokens"))));

    // Git
    const gitRows = (d?.git ?? []).filter((g) => g.commits || g.dirty);
    const commits = gitRows.reduce((k, g) => k + g.commits, 0), dirty = gitRows.reduce((k, g) => k + g.dirty, 0);
    const gitTile = tile("ov-git", commits ? t.ansi2 : t.working)
      .child(v_flex().flex_1().min_w(0).p(14).gap(8)
        .child(label("GIT TODAY"))
        .child(h_flex().gap(22).child(stat(String(commits), "commits")).child(stat(String(dirty), "uncommitted")))
        .child(h_flex().gap(6).flex_wrap().children(gitRows.slice(0, 5).map((g) => h_flex().gap(5).px(6).h(20).items_center().rounded(5).bg(alpha(t.foreground, "0d")).text_size(11)
          .child(div().text_color(t.muted).child(g.repo.split("/").pop()))
          .when(g.commits > 0, (e) => e.child(div().text_color(t.ansi2).child(`✓${g.commits}`)))
          .when(g.dirty > 0, (e) => e.child(div().text_color(t.working).child(`●${g.dirty}`)))))));

    // Next meeting
    const isToday = (sec) => new Date(sec * 1000).toDateString() === new Date().toDateString();
    const upcoming = (this.cal ?? []).filter((e) => e.end * 1000 > now).sort((a, b) => a.start - b.start);
    const next = upcoming[0];
    const until = next ? next.start * 1000 - now : 0;
    const soon = next && until <= 10 * 60000;
    const meetTile = tile("ov-meet", soon ? t.working : t.ansi5 ?? t.ansi4)
      .child(v_flex().flex_1().min_w(0).p(14).gap(8)
        .child(label("NEXT MEETING"))
        .when(!next, (e) => e.child(div().text_size(12.5).text_color(t.dim).child(this.calError ?? (this.cal ? "Nothing in the next 36 h" : "Reading the calendar…"))))
        .when(Boolean(next), (e) => e
          .child(div().text_size(16).font_semibold().text_color(t.foreground).truncate().child(next.title))
          .child(h_flex().gap(8).items_center()
            .child(div().px(7).h(20).flex().items_center().rounded(10).bg(alpha(soon ? t.working : t.foreground, soon ? "26" : "10")).text_size(11.5).text_color(soon ? t.working : t.muted)
              .child(until <= 0 ? `until ${hm(next.end)}` : isToday(next.start) ? `in ${ago(until)}` : "tomorrow"))
            .child(small(`${hm(next.start)} – ${hm(next.end)}`)))
          .when(Boolean(next.meet), (x) => x.child(div().id("ov-join").mt(2).px(10).h(28).flex().items_center().justify_center().rounded(8)
            .bg(alpha(t.ansi2, "26")).text_color(t.ansi2).text_size(12.5).font_medium().cursor_pointer()
            .hover((s) => s.bg(alpha(t.ansi2, "40")))
            .on_click(() => exec("open", [next.meet]).catch(() => {}))
            .child("▶ Join on Meet")))));
    // What wants a look: sessions that need you, results you have not seen, contexts nearly full.
    const liveNow = agents().filter((a) => a.app === "claude-code");
    const needN = liveNow.filter((a) => a.status === "blocked").length;
    const newN = liveNow.filter((a) => a.status === "done").length;
    const fullN = (d?.sessions ?? []).filter((x) => (x.ctx ?? 0) >= 80).length;
    const attnTile = tile("ov-attn", needN ? t.blocked : t.ansi2)
      .child(v_flex().flex_1().min_w(0).p(14).gap(10)
        .child(label("NEEDS A LOOK"))
        .child(h_flex().gap(22)
          .child(v_flex().gap(2).child(div().text_size(22).font_semibold().text_color(needN ? t.blocked : t.foreground).child(String(needN))).child(small("need you")))
          .child(v_flex().gap(2).child(div().text_size(22).font_semibold().text_color(newN ? t.ansi2 : t.foreground).child(String(newN))).child(small("new results")))
          .child(v_flex().gap(2).child(div().text_size(22).font_semibold().text_color(fullN ? t.ansi1 : t.foreground).child(String(fullN))).child(small("context ≥ 80%")))));
    const tiles = h_flex().gap(12).items_stretch().child(limitTile).child(todayTile).child(attnTile);

    // Sessions: one grid of equal cards, three a row; the ones that need you, then working,
    // then done, then the rest by when you last wrote to them. Every card has the same rows
    // (state, title, what it is on, model and context), so the grid lines up.
    const live = agents().filter((a) => a.app === "claude-code");
    const info = new Map((d?.sessions ?? []).map((x) => [x.terminal, x]));
    const rank = { blocked: 0, working: 1, done: 2 };
    const asked = (a) => stamp(info.get(a.address)?.askedAt);
    const ordered = [...live].sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || asked(b) - asked(a));
    const open = (a) => { run("agent.focus", { terminal: a.address }); if (props()?.overlay) closeOverlay(props().overlay); };
    const sessionCard = (a) => {
      const x = info.get(a.address) ?? {};
      const hot = a.status === "blocked" || a.status === "working";
      const color = a.status === "blocked" ? t.blocked : a.status === "working" ? t.working : a.status === "done" ? t.ansi2 : t.dim;
      const state = a.status === "blocked" ? "Needs you" : a.status === "working" ? "Working" : a.status === "done" ? "Done" : "Waiting";
      const since = x.askedAt ? now - Date.parse(x.askedAt) : null;
      const title = (a.title || a.tab_name || a.address).replace(/^[^\p{L}\p{N}]+\s*/u, "");
      // What it is on: the active step with the plan's progress, else the wrap-up, else your
      // last words to it.
      const doing = x.steps && !x.wrap ? x.step : x.wrap ?? null;
      const middle = doing
        ? v_flex().gap(6)
          .child(h_flex().gap(8).text_size(12)
            .child(div().flex_1().min_w(0).truncate().text_color(hot ? t.foreground : t.muted).child(doing))
            .when(Boolean(x.steps), (e) => e.child(div().flex_none().text_color(t.dim).child(`${x.done}/${x.steps}`))))
          .when(Boolean(x.steps), (e) => e.child(bar((100 * (x.done ?? 0)) / x.steps, color, 4)))
        : div().text_size(12).text_color(t.dim).truncate().child(x.asked ? `› ${x.asked}` : "No messages");
      const pill = h_flex().gap(6).px(8).h(22).items_center().rounded(11).bg(alpha(color, hot ? "26" : "18"))
        .child(a.status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(11).text_color(color).spin(900) : div().size(6).rounded(3).bg(color))
        .child(div().text_size(11.5).font_semibold().text_color(color).child(state));
      return v_flex().id(`ov-s-${a.address}`).h(168).p(14).gap(10).rounded(12).border_1().cursor_pointer()
        .border_color(a.status === "blocked" ? alpha(t.blocked, "80") : a.status === "working" ? alpha(t.working, "59") : t.border)
        .bg(a.status === "blocked" ? alpha(t.blocked, "10") : hot ? t.raised : alpha(t.foreground, "05"))
        .hover((h) => h.bg(t.hover).border_color(alpha(color, "80")))
        .on_click(() => open(a))
        // State, how long, where
        .child(h_flex().gap(8).items_center()
          .child(pill)
          .when(since != null, (e) => e.child(small(ago(since))))
          .child(div().flex_1())
          .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${a.space_name} · ${a.tab_name}`)))
        // What it is
        .child(div().text_size(14.5).font_semibold().text_color(hot ? t.foreground : t.muted).truncate().child(title))
        // What it is on
        .child(div().flex_1().min_h(0).child(middle))
        // Model and context
        .child(h_flex().gap(10).items_center().pt(8).border_t(1).border_color(alpha(t.foreground, "0d")).text_size(11)
          .child(div().min_w(0).truncate().text_color(t.dim).child(x.model ? `${x.model}${x.effort ? ` · ${x.effort}` : ""}` : "–"))
          .child(div().flex_1())
          .when(Boolean(x.forYou) && !hot, (e) => e.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(alpha(t.blocked, "1f")).text_color(t.blocked).child("for you")))
          .when(x.ctx != null, (e) => e.child(h_flex().flex_none().gap(6).items_center()
            .child(div().text_color(t.dim).child("ctx"))
            .child(div().w(56).child(bar(x.ctx, warm(x.ctx), 4)))
            .child(div().w(30).text_color(warm(x.ctx)).child(`${Math.round(x.ctx)}%`)))));
    };
    // The board ("aquarium") answers four questions at a glance: who needs me, what is working
    // and how far it is, what finished that I have not looked at, what I can close. Where a
    // bubble sits says its state (zones, no legend); inside it one figure for that state; the
    // name once under it; its space a dot on the rim. Sessions quiet for 12 h sleep in a row
    // of their own. Herdr turns "done" into "idle" once you look at a session, so "done" means
    // not yet seen.
    const tnow = now / 1000;
    const H12 = 12 * 3600000;
    const lastAt = (a) => { const x = info.get(a.address) ?? {}; return Math.max(stamp(x.spokeAt) || 0, stamp(x.askedAt) || 0); };
    const zones = [
      ["blocked", "Needs you", t.blocked, live.filter((a) => a.status === "blocked")],
      ["working", "Working", t.working, live.filter((a) => a.status === "working")],
      ["done", "New results", t.ansi2, live.filter((a) => a.status === "done")],
      ["idle", "Quiet", t.dim, live.filter((a) => !["blocked", "working", "done"].includes(a.status) && !(lastAt(a) > 0 && now - lastAt(a) >= H12))],
    ];
    // Asleep only when its last activity is known to be old; unknown counts as quiet.
    const sleeping = live.filter((a) => !["blocked", "working", "done"].includes(a.status) && lastAt(a) > 0 && now - lastAt(a) >= H12)
      .sort((a, b) => lastAt(b) - lastAt(a));
    const spaceColors = [t.ansi4, t.ansi5, t.ansi6, t.ansi3, t.ansi1, t.ansi2];
    const spaceIds = [...new Set(live.map((a) => a.space))];
    const spaceColor = (a) => spaceColors[spaceIds.indexOf(a.space) % spaceColors.length] ?? t.muted;
    const clean = (txt) => (txt ?? "").replace(/[*`#>_]/g, "").replace(/\s+/g, " ").trim();
    // The name you gave a session (double-click its title in the pane header), else Claude's.
    const custom = new Map(terminals().filter((x) => x.labels?.["my.name"]).map((x) => [x.address, x.labels["my.name"]]));
    const nameOf = (a) => custom.get(a.address) ?? (a.title || a.tab_name || a.address).replace(/^[^\p{L}\p{N}]+\s*/u, "");
    const firstLive = zones.flatMap((z) => z[3])[0] ?? sleeping[0];
    const picked = live.find((a) => a.address === this.hovered) ?? firstLive;

    const bubble = (a, k, small) => {
      const x = info.get(a.address) ?? {};
      const st = a.status;
      const color = st === "blocked" ? t.blocked : st === "working" ? t.working : st === "done" ? t.ansi2 : t.dim;
      const quiet = st !== "blocked" && st !== "working" && st !== "done";
      const base = small ? 44 : quiet ? 60 : 78;
      const size = st === "working" ? base + Math.round(3 * Math.sin(tnow * 1.6 + k)) : base;
      const lift = st === "blocked" ? Math.round(Math.abs(Math.sin(tnow * 4 + k)) * 9) : 0;
      const ctxHot = (x.ctx ?? 0) >= 80;
      const steps = x.steps ?? 0, doneN = x.done ?? 0;
      const since = st === "working" ? now - (stamp(x.askedAt) || now) : now - lastAt(a);
      const figure = st === "blocked" ? "!" : st === "done" ? "✓" : st === "working" ? (steps ? `${doneN}/${steps}` : ago(since)) : lastAt(a) ? ago(since) : "–";
      const on = picked?.address === a.address;
      const box = small ? 56 : 104;
      const half = box / 2;
      return v_flex().id(`ov-b-${a.address}`).w(small ? 96 : 128).items_center().gap(4).cursor_pointer()
        .on_hover((h, cx) => { if (h) { this.hovered = a.address; cx.notify(); } })
        .on_click(() => open(a))
        .child(div().w(box).h(box).relative()
          // The bubble
          .child(div().absolute().top(half - size / 2 - lift).left(half - size / 2).size(size).rounded(size / 2).overflow_hidden()
            .border_2().border_color(ctxHot ? t.ansi1 : on ? color : alpha(color, quiet ? "4d" : "a6"))
            .bg(alpha(color, st === "blocked" ? "30" : st === "working" ? "1c" : st === "done" ? "1a" : "0a"))
            .child(div().absolute().top(0).left(0).size_full().flex().items_center().justify_center()
              .child(div().text_size(small ? 11 : st === "working" && steps ? 15 : 18).font_semibold()
                .text_color(st === "blocked" ? t.blocked : st === "done" ? t.ansi2 : quiet ? t.dim : t.foreground).child(figure))))
          // A ring turning round a working bubble
          .when(st === "working" && !small, (e) => e.child(div().absolute().top(half - (base + 16) / 2).left(half - (base + 16) / 2)
            .child(svg("mods/workspace-chrome/spinner.svg").size(base + 16).text_color(alpha(t.working, "80")).spin(2600))))
          // Its space, a dot on the rim
          .child(div().absolute().top(half + size * 0.36 - 5 - lift).left(half + size * 0.36 - 5).size(small ? 8 : 11).rounded(6)
            .bg(spaceColor(a)).border_2().border_color(t.popover))
          // Subagents still running: a small count on the lower rim
          .when(Boolean(x.agents?.length) && !small, (e) => e.child(div().absolute().top(half + size / 2 - 9 - lift).left(half - 26).w(52).h(18).rounded(9)
            .flex().items_center().justify_center().gap(3).bg(t.popover).border_1().border_color(alpha(t.working, "99"))
            .text_size(10).font_semibold().text_color(t.working)
            .child(`+${x.agents.length} agent${x.agents.length > 1 ? "s" : ""}`)))
          // Context nearly full
          .when(ctxHot && !small, (e) => e.child(div().absolute().top(half - size / 2 - 6 - lift).left(half + size / 2 - 22).px(5).h(16).rounded(8)
            .flex().items_center().bg(t.ansi1).text_size(10).font_semibold().text_color(t.popover).child(`${Math.round(x.ctx)}%`))))
        .child(div().w_full().h(small ? 16 : 36).overflow_hidden().px(2).text_size(small ? 10.5 : 12).text_center()
          .text_color(on ? t.foreground : quiet ? t.dim : t.muted).child(nameOf(a)));
    };

    const emptyLine = { blocked: "Nothing waiting on you", working: "Nothing running", done: "Nothing new", idle: "No quiet sessions" };
    // Zones keep their width whatever they hold (one share, two for a crowded one), so the
    // board does not shift as sessions come and go.
    const zoneBox = ([key, title, color, list]) => v_flex().id(`ov-z-${key}`).flex_grow(list.length > 2 ? 2 : 1).flex_basis(0).min_w(130).gap(10).p(12).rounded(12)
      .bg(list.length ? alpha(color, "08") : "#00000000").border_1().border_color(list.length ? alpha(color, "2e") : alpha(t.foreground, "0d"))
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).bg(color))
        .child(div().text_size(11.5).font_semibold().text_color(list.length ? color : t.dim).child(title))
        .child(div().text_size(11).text_color(t.dim).child(String(list.length))))
      .child(h_flex().flex_wrap().gap(4).justify_center().children(list.map((a, k) => bubble(a, k, false))))
      .when(!list.length, (e) => e.child(v_flex().flex_1().items_center().justify_center().gap(6).py(18)
        .child(div().size(34).rounded(17).border_1().border_color(alpha(t.foreground, "14")))
        .child(div().text_size(11.5).text_color(alpha(t.foreground, "59")).text_center().child(emptyLine[key]))));
    const board = v_flex().id("ov-board").flex_grow(3).flex_basis(0).min_w(0).gap(10)
      .child(h_flex().gap(10).items_stretch().children(zones.map(zoneBox)))
      .when(sleeping.length > 0, (e) => e.child(v_flex().gap(6).px(12).py(10).rounded(12).border_1().border_color(alpha(t.foreground, "0d"))
        .child(h_flex().gap(6).items_center().child(div().text_size(11.5).font_semibold().text_color(t.dim).child("Asleep"))
          .child(div().text_size(11).text_color(t.dim).child(`${sleeping.length} · quiet for over 12 h`)))
        .child(h_flex().flex_wrap().gap(2).children(sleeping.map((a, k) => bubble(a, k, true))))));

    // The card for the bubble under the pointer: only what helps decide what to do next.
    const card = (a) => {
      const x = info.get(a.address) ?? {};
      const st = a.status;
      const color = st === "blocked" ? t.blocked : st === "working" ? t.working : st === "done" ? t.ansi2 : t.dim;
      const word = st === "blocked" ? "Needs you" : st === "working" ? "Working" : st === "done" ? "New result" : lastAt(a) > 0 && now - lastAt(a) >= H12 ? "Asleep" : "Quiet";
      const when = st === "working" ? (x.askedAt ? `working ${ago(now - Date.parse(x.askedAt))}` : "") : lastAt(a) ? (now - lastAt(a) < 60000 ? "just now" : `last ${ago(now - lastAt(a))} ago`) : "";
      const line = st === "working" && x.steps ? "" : clean(x.wrap ?? x.said ?? x.asked ?? "");
      const btn = (id, label, onClick, tone) => div().id(id).px(10).h(26).flex().items_center().rounded(7).cursor_pointer().text_size(12)
        .border_1().border_color(tone ? alpha(tone, "66") : t.border).text_color(tone ?? t.muted)
        .hover((h) => h.bg(t.hover).text_color(tone ?? t.foreground)).on_click(onClick).child(label);
      const closing = this.confirmClose === a.address;
      return v_flex().id("ov-card").p(16).gap(10).rounded(14).border_1().border_color(alpha(color, "66")).bg(t.raised)
        .child(h_flex().gap(8).items_center()
          .child(h_flex().gap(6).px(8).h(22).items_center().rounded(11).bg(alpha(color, "24"))
            .child(div().size(6).rounded(3).bg(color)).child(div().text_size(11.5).font_semibold().text_color(color).child(word)))
          .child(small(when))
          .child(div().flex_1())
          .child(h_flex().gap(5).items_center().child(div().size(8).rounded(4).bg(spaceColor(a))).child(small(`${a.space_name} · ${a.tab_name}`))))
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(nameOf(a)))
        .when(st === "working" && Boolean(x.steps), (e) => e.child(v_flex().gap(6)
          .child(h_flex().text_size(12).child(div().flex_1().text_color(t.muted).child("Plan")).child(div().text_color(t.dim).child(`${x.done}/${x.steps} done`)))
          .child(bar((100 * (x.done ?? 0)) / x.steps, t.working, 5))
          // Every step: done, the one on now, the ones to come.
          .child(v_flex().gap(3).pt(2).children((x.plan ?? []).map((p, i) => {
            const now2 = p.status === "active", ok = p.status === "done", bad = p.status === "failed";
            return h_flex().id(`ov-st-${i}`).gap(8).items_start().px(8).py(4).rounded(6).when(now2, (q) => q.bg(alpha(t.working, "14")))
              .child(div().flex_none().w(12).pt(1).text_size(11.5).text_color(bad ? t.ansi1 : ok ? t.ansi2 : now2 ? t.working : t.dim)
                .child(bad ? "✗" : ok ? "✓" : now2 ? "●" : "○"))
              .child(v_flex().flex_1().min_w(0)
                .child(div().text_size(12).text_color(now2 ? t.foreground : ok ? t.muted : t.dim).child(p.title))
                .when(Boolean(p.result) && (ok || bad), (q) => q.child(div().text_size(11).text_color(t.dim).truncate().child(p.result))));
          })))))
        // Subagents still running (a background one can outlive its session's turn).
        .when(Boolean(x.agents?.length), (e) => e.child(v_flex().gap(4)
          .child(h_flex().text_size(12).child(div().flex_1().text_color(t.muted).child("Subagents")).child(div().text_color(t.dim).child(`${x.agents.length} running`)))
          .children(x.agents.map((g, i) => {
            const secs = g.began ? Math.max(0, Math.round((Date.now() - Date.parse(g.began)) * 0.001)) : null;
            // Kept to one division a template: two in one break Herdr's module loader.
            const mins = secs == null ? 0 : Math.floor(secs * (1 / 60));
            const took = secs == null ? "" : secs < 60 ? `${secs}s` : mins < 60 ? `${mins}m` : `${Math.floor(mins * (1 / 60))}h ${mins % 60}m`;
            const kind = g.model ? `${g.kind} · ${g.model}` : g.kind;
            return h_flex().id(`ov-ag-${i}`).gap(8).items_center().px(8).py(5).rounded(6).bg(alpha(t.working, "10"))
              .child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))
              .child(v_flex().flex_1().min_w(0)
                .child(div().text_size(12).text_color(t.foreground).truncate().child(g.what))
                .child(div().text_size(11).text_color(t.dim).truncate().child(g.bg ? `${kind} · background` : kind)))
              .when(Boolean(took), (q) => q.child(div().flex_none().text_size(11).text_color(t.dim).child(took)));
          }))))
        .when(Boolean(line), (e) => e.child(div().text_size(12.5).text_color(t.muted).child(line.length > 220 ? line.slice(0, 218) + "…" : line)))
        .when(Boolean(x.forYou) && st !== "working", (e) => e.child(div().px(10).py(7).rounded(8).bg(alpha(t.blocked, "1a")).text_size(12).text_color(t.foreground).child(`For you: ${x.forYou}`)))
        .child(h_flex().gap(10).items_center().text_size(11.5)
          .when(Boolean(x.model), (y) => y.child(div().text_color(t.dim).child(`${x.model}${x.effort ? ` · ${x.effort}` : ""}`)))
          .child(div().flex_1())
          .when(x.ctx != null, (y) => y.child(h_flex().gap(6).items_center()
            .child(div().text_color(t.dim).child("ctx"))
            .child(div().w(70).child(bar(x.ctx, warm(x.ctx), 5)))
            .child(div().text_color(warm(x.ctx)).child(`${Math.round(x.ctx)}%`)))))
        .child(h_flex().gap(8).pt(4)
          .child(btn("ov-open", "Open", () => open(a), color))
          .child(btn("ov-changes", "Changes", () => openOverlay({ mod: "claude-changes", kind: "dialog", width: 0.95, height: 0.92, props: { changes: { terminal: a.address } } })))
          .child(div().flex_1())
          // End session: stops its Claude (terminal.kill), which closes its pane and, if it was alone,
          // its tab. Two presses; the conversation stays on disk for claude --resume.
          .child(btn("ov-close-s", closing ? "Sure? End it" : "End session", (_e, cx) => {
            if (!closing) { this.confirmClose = a.address; cx.timer.after(4000, (cx) => { if (this.confirmClose === a.address) { this.confirmClose = null; cx.notify(); } }); }
            else { this.confirmClose = null; run("terminal.kill", { terminal: a.address }); }
            cx.notify();
          }, closing ? t.ansi1 : null)));
    };
    const detail = div().flex_grow(2).flex_basis(0).min_w(0).child(picked ? card(picked) : div());
    const counts = zones.filter(([k, , , l]) => k !== "idle" && l.length).map(([, w, c, l]) => [l.length, w.toLowerCase(), c]);
    let sessions = v_flex().gap(12).child(section("Claude sessions", live.length,
      counts.length ? h_flex().gap(6).children(counts.map(([k, word, c]) => div().px(7).h(18).flex().items_center().rounded(9).bg(alpha(c, "22")).text_size(11).text_color(c).child(`${k} ${word}`))) : null));
    // Until the first read the board would place every session as asleep, then move them all:
    // a quiet placeholder of the same height instead.
    sessions = sessions.child(h_flex().gap(14).items_start().child(board).child(detail));
    if (!live.length) sessions = sessions.child(small("No Claude session is running."));

    const hour = new Date().getHours();
    const greet = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const header = h_flex().gap(12).items_end()
      .child(v_flex().flex_1().gap(3)
        .child(div().text_size(24).font_semibold().text_color(t.foreground).child(this.name ? `${greet}, ${this.name}` : greet))
        .child(small(`${today()}${d?.at ? (now - d.at * 1000 < 60000 ? " · updated just now" : ` · updated ${ago(now - d.at * 1000)} ago`) : ""}`)))
      .when(Boolean(this.error), (e) => e.child(small(this.error, t.ansi1)))
      // The next meeting, small: Join opens its Meet link.
      .when(Boolean(next), (e) => e.child(h_flex().gap(8).items_center().px(10).h(28).rounded(8).border_1().border_color(soon ? alpha(t.working, "66") : t.border)
        .child(div().text_size(11.5).text_color(soon ? t.working : t.dim).child(until <= 0 ? "now" : isToday(next.start) ? `in ${ago(until)}` : `tomorrow ${hm(next.start)}`))
        .child(div().max_w(220).truncate().text_size(12).text_color(t.foreground).child(next.title))
        .when(Boolean(next.meet), (x) => x.child(div().id("ov-join").px(7).h(20).flex().items_center().rounded(6).bg(alpha(t.ansi2, "26")).text_size(11).text_color(t.ansi2).cursor_pointer()
          .hover((h) => h.bg(alpha(t.ansi2, "40"))).on_click(() => exec("open", [next.meet]).catch(() => {})).child("Join")))))
      .child(h_flex().gap(12).text_size(11).text_color(t.dim)
        .children([["j/k", "session"], ["[ ]", "dashboards"], ["?", "all keys"]].map(([k, w]) =>
          h_flex().gap(5).child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(w)))))
      .child(div().id("ov-reload").px(10).h(28).flex().items_center().rounded(8).border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.load(cx); this.loadCal(cx); }).child("↻ Refresh"))
      .when(Boolean(props()?.overlay), (e) => e.child(div().id("ov-close").px(9).h(28).flex().items_center().rounded(8).text_size(14).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props().overlay)).child("✕")));

    let page = v_flex().w_full().max_w(1240).mx_auto().px(28).py(24).gap(26);
    page = page.child(header);
    // Until the first read: blocks the size of what comes, so nothing jumps when it lands.
    const ghost = (h) => div().h(h).w_full().rounded(12).border_1().border_color(alpha(t.foreground, "0d")).bg(alpha(t.foreground, "04"));
    if (!d) {
      page = page.child(h_flex().gap(12).children(Array.from({ length: 3 }, () => div().flex_1().child(ghost(140)))));
      page = page.child(v_flex().gap(12).child(section("Claude sessions", live.length)).child(h_flex().gap(14).items_start()
        .child(div().flex_grow(3).flex_basis(0).child(ghost(482))).child(div().flex_grow(2).flex_basis(0).child(ghost(236)))));
      return this.shell(t, page);
    }
    page = page.child(tiles);
    page = page.child(sessions);
    this.order = [...zones.flatMap((z) => z[3]), ...sleeping];
    return this.shell(t, page);
  }
}
