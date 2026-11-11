// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, nextCommand, home, readTextFile, exec, appHome } from "herdr";
// A space's colour (shared "space.colors", the same in every mod that draws space letters).
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
function spaceFill(w, t) {
  const c = (shared("space.colors") ?? {})[w.id] ?? "ansi6";
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}
// New spaces get the least used colour; gone ones lose theirs.
function keepColors(sp) {
  const ids = new Set(sp.map((w) => w.id));
  const was = shared("space.colors") ?? {};
  const kept = Object.fromEntries(Object.entries(was).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(was).length;
  for (const w of sp) {
    if (kept[w.id] || w.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[w.id] = PALETTE.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
}
const alpha = (c, a) => ((c ?? "").length === 9 ? c.slice(0, 7) : c ?? "#888888") + a;

// Moves a tab to another space (the tab menu asks through shared "tab.move"). Herdr has no
// command for it: each terminal leaves its pane (terminal.park, the empty tab goes) and comes
// back in the other space (terminal.keep: the first as a new tab, the rest split beside it),
// then the new tab gets the old name. Mod panes stay behind (the steps pane opens again).
// The Home space: the three dashboards as tabs, always loaded (Overview, Review, Worktrees).
// "my-agents.home" goes there (to the tab you left it on), "home:<id>" to one dashboard,
// "home:next" / "home:prev" step through them. A missing space or tab is made again.
const HOME = [["agents", "Agents", "pregled"], ["review", "Review", "review-dashboard"], ["worktrees", "Worktrees", "my-worktrees"], ["stats", "Stats", "stats"], ["news", "News", "news"]];
function homeSpace() {
  return spaces().find((s) => s.name.toLowerCase() === "home") ?? null;
}
function homeTabOf(space, mod) {
  return space?.tabs.find((tb) => panes().some((p) => p.tab === tb.id && p.mod === mod)) ?? null;
}
// Made one step at a time (given in one moment, the commands trip over each other); then
// `done` runs with the space.
function ensureHome(cx, done) {
  let space = homeSpace();
  const steps = [];
  let spare = null;
  if (!space) {
    steps.push(() => run("space.new", { name: "Home", folder: home() }));
    steps.push(() => { space = homeSpace(); spare = space?.tabs[0]?.id ?? null; });
  }
  HOME.forEach(([, name, mod]) => steps.push(() => {
    space = homeSpace();
    if (space && !homeTabOf(space, mod)) run("tab.new", { space: space.id, name, mod });
  }));
  HOME.forEach(([, name, mod], i) => steps.push(() => {
    const tab = homeTabOf(homeSpace(), mod);
    if (tab && tab.index !== i + 1) run("tab.move", { id: tab.id, index: i + 1 });
    if (tab && tab.name !== name) run("tab.rename", { id: tab.id, name });
  }));
  steps.push(() => { if (spare && homeSpace()?.tabs.some((tb) => tb.id === spare)) run("tab.close", { id: spare }); });
  steps.push(() => done(homeSpace()));
  // Nothing to make: straight on.
  if (space && HOME.every(([, name, mod], i) => { const tb = homeTabOf(space, mod); return tb?.index === i + 1 && tb.name === name; })) return done(space);
  steps.forEach((f, i) => cx.timer.after(i * 250, () => f()));
}
// The dashboard shown gets the keyboard at once: its pane is focused and it is told to take
// focus (each listens for "<mod>.focus").
function focusHome(mod) {
  const tab = homeTabOf(homeSpace(), mod);
  const pane = tab && panes().find((p) => p.tab === tab.id && p.mod === mod);
  if (pane) run("pane.focus", { pane: pane.pane });
  run(`${mod}.focus`);
}
function goHome(which, cx) {
  ensureHome(cx, (space) => {
    if (!space) return;
    run("space.select", { id: space.id });
    const at = HOME.findIndex(([, , mod]) => homeTabOf(space, mod)?.active);
    const idx = !which ? Math.max(0, at)
      : which === "next" ? (Math.max(0, at) + 1) % HOME.length
      : which === "prev" ? (Math.max(0, at) + HOME.length - 1) % HOME.length
      : HOME.findIndex(([id]) => id === which || (which === "overview" && id === "agents"));
    if (idx < 0) return;
    const mod = HOME[idx][2];
    const tab = homeTabOf(space, mod);
    if (tab && !tab.active) cx.timer.after(150, () => run("tab.select", { id: tab.id }));
    cx.timer.after(350, () => focusHome(mod));
  });
}

function moveTab(cx) {
  const req = shared("tab.move");
  if (!req?.id || !req.space || Date.now() - (req.at ?? 0) > 10000) return;
  setShared("tab.move", null);
  const tab = spaces().flatMap((s) => s.tabs).find((x) => x.id === req.id);
  const terms = panes().filter((p) => p.tab === req.id && p.terminal).map((p) => p.terminal);
  if (!tab || !terms.length) return;
  // One step at a time: given in the same moment, the commands trip over each other.
  for (const t of terms) run("terminal.park", { terminal: t });
  cx.timer.after(250, () => run("space.select", { id: req.space }));
  terms.forEach((t, i) => cx.timer.after(500 + i * 250, () => run("terminal.keep", i === 0 ? { terminal: t } : { terminal: t, place: "right" })));
  if (!tab.named) return;
  // The new tab shows up a moment later: then it takes the name back.
  for (const ms of [900, 1500, 2500]) cx.timer.after(ms + terms.length * 250, () => {
    const now = panes().find((p) => p.terminal === terms[0]);
    const nt = now && spaces().flatMap((s) => s.tabs).find((x) => x.id === now.tab);
    if (nt && nt.name !== tab.name) run("tab.rename", { id: nt.id, name: tab.name });
  });
}

// One pane of a tab at a time: show this pane (its tab comes up), zoomed when the
// tab has others, so a review agent and its PR take turns on the whole tab.
function showPane(paneId) {
  const me = panes().find((p) => p.pane === paneId);
  if (!me) return;
  const ps = panes().filter((p) => p.tab === me.tab);
  const zoomed = ps.find((p) => p.zoomed);
  run("pane.focus", { pane: paneId });
  // A tab with a Claude reader is one view (the reader over its prompt): never zoom one half,
  // and undo a zoom left behind.
  if (ps.some((p) => (p.mod === "claude-reader" || p.mod === "claude-steps"))) {
    if (zoomed) run("pane.zoom", { pane: zoomed.pane });
    return;
  }
  if (ps.length < 2 || zoomed?.pane === paneId) return;
  if (zoomed) run("pane.zoom", { pane: zoomed.pane });
  run("pane.zoom", { pane: paneId });
}

// The PR pane (pr-diff) sharing an agent's tab, if it has one.
const prPaneOf = (a) => panes().find((p) => p.tab === a.tab && p.mod === "pr-diff") ?? null;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// The steps pane (what Claude is doing: state, this turn's steps, your messages) to the right
// of the focused tab's Claude terminal; again closes it. Keys stay in the terminal.
// Tabs where the steps pane was closed by hand: it is not opened there again on its own.
const stepsHidden = new Set(JSON.parse(localStorage.getItem("stepsHidden") ?? "[]"));
const keepHidden = () => localStorage.setItem("stepsHidden", JSON.stringify([...stepsHidden].slice(-200)));

function toggleSteps() {
  const f = focused();
  if (!f) return;
  const open = panes().filter((q) => q.tab === f.tab && q.mod === "claude-steps");
  if (open.length) { for (const q of open) run("pane.close", { pane: q.pane }); stepsHidden.add(f.tab); keepHidden(); return; }
  stepsHidden.delete(f.tab); keepHidden();
  const term = f.app === "claude-code" ? f : panes().find((q) => q.tab === f.tab && q.app === "claude-code");
  if (!term?.terminal) return;
  run("pane.split", { direction: "right", pane: term.pane, mod: "claude-steps", props: { terminal: term.terminal, part: "side" } });
  run("pane.focus", { pane: term.pane });
}

// The steps pane opens on its own beside a Claude terminal in the tab you are in: only a tab
// of plain terminals (a PR's tab with its diff keeps its own layout), not zoomed, and not one
// where you closed it. The focus goes back where it was.
const stepsSeen = new Set();
function autoSteps() {
  // A steps pane that went away (its close button, cmd-shift-w) counts as closed by hand.
  const withSteps = new Set(panes().filter((q) => q.mod === "claude-steps").map((q) => q.tab));
  for (const tab of stepsSeen) if (!withSteps.has(tab)) { stepsSeen.delete(tab); stepsHidden.add(tab); keepHidden(); }
  for (const tab of withSteps) stepsSeen.add(tab);
  const f = focused();
  if (!f?.tab || stepsHidden.has(f.tab)) return;
  const here = panes().filter((q) => q.tab === f.tab);
  if (here.some((q) => q.mod) || here.some((q) => q.zoomed)) return;
  const term = here.find((q) => q.app === "claude-code" && q.terminal);
  if (!term) return;
  run("pane.split", { direction: "right", pane: term.pane, mod: "claude-steps", props: { terminal: term.terminal, part: "side" } });
  run("pane.focus", { pane: f.pane ?? term.pane });
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    // keys.json binds cmd-shift-s to "my-agents.steps": this panel is always shown, so it can
    // open the Claude steps pane beside the focused Claude terminal, or close it again.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "steps") toggleSteps();
        if (c === "movetab") moveTab(cx);
        if (c === "home") goHome(null, cx);
        if (c.startsWith("home:")) goHome(c.slice(5), cx);
        // "my-agents.movetab:<tab id>:<space id>": the same move without the menu.
        if (c.startsWith("movetab:")) { const [, id, space] = c.split(":"); setShared("tab.move", { id, space, at: Date.now() }); moveTab(cx); }
        cx.notify();
      }
    });
    cx.timer.every(1500, () => autoSteps());
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    // The critter's frames, where Herdr looks for icons (a new file in the linked mod is not seen until restart).
    for (const n of ["work-a", "cheer", "wave", "arm-up", "arm-out", "nap"]) exec("cp", ["-n", `${appHome()}/mods/my-agents/crab-${n}.svg`, `${appHome()}/icons/my-agents-crab-${n}.svg`]).catch(() => {});
    this.pressed = null;
    this.over = null;
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    // How many drafts each review agent has written (review-drafts keeps them as JSON).
    this.drafts = {};
    cx.timer.every(5000, (cx) => this.loadDrafts(cx));
  }

  loadDrafts(cx) {
    const recs = shared("pr-diff.agents") ?? {};
    const base = `${home()}/.claude/state/review`;
    cx.spawn(async (cx) => {
      const next = {};
      for (const [k, rec] of Object.entries(recs)) {
        const m = k.match(/^([^/]+)\/([^#]+)#(\d+)$/);
        if (!m || !rec?.tab) continue;
        const txt = await readTextFile(`${base}/${m[1]}-${m[2]}-${m[3]}.json`).catch(() => null);
        try { next[rec.tab] = JSON.parse(txt ?? "{}").drafts?.length ?? 0; } catch { next[rec.tab] = 0; }
      }
      if (JSON.stringify(next) === JSON.stringify(this.drafts)) return;
      this.drafts = next;
      cx.notify();
    });
  }

  saveFolded() {
    localStorage.setItem("folded", JSON.stringify([...this.folded].filter((id) => id.startsWith("sp-") || id === "pinned")));
  }

  // The review chip: where the review is; on an approved one under the pointer, Close.
  reviewChip(t, a, review, now) {
    const armed = this.closeArm?.address === a.address && now - this.closeArm.at < 3000;
    const closing = review.approved && (this.hovered === a.address || armed);
    const look = closing ? [armed ? "Close?" : "Close", armed ? t.blocked : t.muted] : review.look;
    return div().id(`ag-pr-${a.address}`).flex_none().w(70).h(18).flex().items_center().justify_center().rounded(5).text_size(10.5).font_semibold().cursor_pointer()
      .when(Boolean(look), (x) => x.bg(alpha(look[1], "26")).text_color(look[1]))
      .when(!look, (x) => x.border_1().border_color(t.border).text_color(t.dim))
      .hover((s) => s.opacity(0.85))
      .tooltip(closing ? (armed ? "Click again: ends the agent and closes its tab" : "Done with it: ends the agent and closes its tab") : `${review.tip} · click for the agent`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!closing) { showPane(a.pane); return; }
        if (armed) { this.closeArm = null; this.closeReview(a, cx); }
        else { this.closeArm = { address: a.address, at: Date.now() }; cx.timer.after(3100, (cx) => cx.notify()); }
        cx.notify();
      })
      .child(closing && !armed
        ? h_flex().gap(4).items_center().child(svg("mods/workspace-chrome/x.svg").size(11)).child("Close")
        : look ? look[0] : "To review");
  }

  // A review is over: its Claude ends and its tab (the agent and the PR) goes.
  closeReview(a, cx) {
    run("terminal.kill", { terminal: a.address });
    cx.timer.after(400, () => { if (spaces().some((sp) => sp.tabs.some((tb) => tb.id === a.tab))) run("tab.close", { id: a.tab }); });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // The state as one mark in a 14px slot: a soft halo round a dot for what wants you
  // (done, needs you), the spinner while working, a quiet dot when idle.
  status(t, a) {
    const slot = () => div().size(14).flex_none().flex().items_center().justify_center();
    if (a.status === "working") return slot().child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900));
    if (a.status === "blocked" || a.status === "done") {
      const c = t[a.status] ?? t.dim;
      return slot().child(div().size(14).rounded(7).bg(alpha(c, "2e")).flex().items_center().justify_center()
        .child(div().size(6).rounded(3).bg(c)));
    }
    return slot().child(div().size(5).rounded(3).bg(alpha(t.idle ?? t.dim, "88")));
  }

  // The agent's critter: its mood is its state, tinted by it (working yellow, done green,
  // needs you red, idle grey). Layers on top move natively (loop), so nothing re-renders.
  crab(t, a) {
    const W = 22, H = 18;
    const layer = (name) => svg(`icons/my-agents-crab-${name}.svg`).absolute().left(0).top(0).w(W).h(H);
    const box = () => div().relative().w(W).h(H).flex_none();
    // Working: a small, steady hop. Done: cheering, arms up. Idle: asleep, its z drawn in.
    // Working wears Claude's own orange.
    if (a.status === "working") return box().text_color("#d97757")
      .child(layer("work-a").loop("top", { from: 0, to: -1.5, period: 500 }));
    // The session in front, when not working: Claude's orange, standing still.
    if (a.focused) return box().text_color("#d97757").child(layer("work-a"));
    if (a.status === "done") return box().text_color(t.ansi2 ?? t.done).child(layer("cheer"));
    if (a.status === "blocked") return box().text_color(t.blocked)
      .child(layer("wave"))
      .child(layer("arm-up").loop("opacity", { from: 1, to: 0, period: 700, easing: "linear" }))
      .child(layer("arm-out").loop("opacity", { from: 0, to: 1, period: 700, easing: "linear" }));
    return box().text_color(t.dim).child(layer("nap").opacity(0.75));
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = SORTS[1];
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabLabels = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, title(tab, leads.get(tab.id))]));
    // A name you gave the session (the pane header's double-click) wins over the rest.
    const custom = new Map(terminals().filter((x) => x.labels?.["my.name"]).map((x) => [x.address, x.labels["my.name"]]));
    const labels = new Map(list.map(a => [a.address, custom.get(a.address) ?? tabLabels.get(a.tab) ?? (a.title || a.program?.name || "")]));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        // The rail: the agent's icon, its state on the corner, its name and space on hover.
        return h_flex()
          .id(`ag-${a.address}`)
          .h(30)
          .mx(6)
          .flex_none()
          .items_center()
          .justify_center()
          .rounded(6)
          .when(Boolean(a.focused), (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .tooltip(`${label(a) || a.program?.name || a.address} · ${a.space_name ?? ""}`)
          .on_click(() => showPane(prPaneOf(a)?.pane ?? a.pane))
          .child(div().relative().size(18).flex().items_center().justify_center()
            .child(pic ?? div().size(8).rounded(4).bg(t.muted))
            .child(div().absolute().right(-6).bottom(-5).child(this.status(t, a, true))));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const review = prPaneOf(a) ? (() => {
        const num = ((a.tab_name ?? "").match(/#(\d+)/) ?? [])[1];
        const mine = Object.entries(shared("review.mine") ?? {}).find(([k]) => num && k.endsWith(`#${num}`))?.[1];
        // Drafts: the review-drafts file, else what the PR view counted from the prose.
        const key = Object.entries(shared("pr-diff.agents") ?? {}).find(([, r]) => r?.tab === a.tab)?.[0];
        const n = this.drafts[a.tab] || (key ? shared("review.draftCount")?.[key] ?? 0 : 0);
        const gh = { APPROVED: ["Approved", t.ansi2, "You approved"], CHANGES_REQUESTED: ["Changes", t.ansi1, "You requested changes"], COMMENTED: ["Commented", t.accent ?? t.ansi4, "You commented"] }[mine?.state];
        const look = gh ? gh.slice(0, 2)
          : a.status === "working" ? ["Reviewing", t.working]
          : a.status === "blocked" ? ["Needs you", t.blocked]
          : n > 0 ? [`${n} draft${n === 1 ? "" : "s"}`, t.done ?? t.accent]
          // The agent ran and stopped: its review is there, whatever it counted.
          : ["Ready", t.done ?? t.accent];
        const tip = gh ? gh[2] : a.status === "working" ? "The agent is reading the PR" : a.status === "blocked" ? "The agent is waiting for you" : n > 0 ? "Drafts are ready in the PR view" : "The agent is done: its review is in the PR view";
        return { look, tip, approved: mine?.state === "APPROVED" };
      })() : null;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .when(Boolean(review?.approved) && this.hovered !== a.address, (el) => el.opacity(0.5))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => showPane(prPaneOf(a)?.pane ?? a.pane))
        // The state where the icon was (every row had the same one); the program on hover.
        .child(div().id(`agent-fold-${a.address}`).w(22).h(18).flex_none().flex().items_center().justify_center()
          .tooltip(a.program?.name ?? "")
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(this.crab(t, a)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        // Fixed columns at the right, so chips and ages line up row to row: [chip] [age or pin].
        .when(Boolean(review), (el) => el.child(this.reviewChip(t, a, review, now)))
        .child(div().flex_none().w(26).flex().justify_end().items_center()
          .when(this.hovered === a.address, (x) => x.child(pin))
          .when(this.hovered !== a.address && Boolean(when), (x) => x.text_size(11).text_color(t.dim).child(duration(now - when))));
    };

    // A group per space, in the spaces' own order, those without agents too (Home).
    const sp = spaces();
    keepColors(sp);
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const w of sp) groups.push({ id: `sp-${w.id}`, space: w, label: w.name, status: null, members: rest.filter((a) => a.space === w.id) });
    const stray = rest.filter((a) => !sp.some((w) => w.id === a.space));
    if (stray.length) groups.push({ id: "sp-other", label: "Other", status: null, members: stray });
    setAgentOrder(groups.flatMap((g) => g.members).map((a) => a.address));

    const spaceMenu = (w) => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
    // A space's header: its name goes there, the rest of the row folds it (a space with no
    // agents only goes there); drag reorders, right-click is its menu.
    const spaceHeader = (g) => {
      const w = g.space;
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      const i = sp.findIndex((x) => x.id === w.id);
      const from = this.pressed === null ? -1 : sp.findIndex((x) => x.id === this.pressed);
      return h_flex()
        .id(g.id)
        .relative()
        // A short label with a modest gap above it does the separating.
        .mt(8)
        .px(8)
        .h(22)
        .flex_none()
        .gap(6)
        .items_center()
        // A gap under it, so its hover fill and a selected row below don't touch.
        .mb(2)
        .rounded(6)
        .text_size(11.5)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => { this.hoverHead = on ? g.id : this.hoverHead === g.id ? null : this.hoverHead; cx.notify(); })
        .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
        .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
          div().absolute().left(0).right(0).h(2).bg(t.accent)
            .when(from < i, (line) => line.bottom(0))
            .when(from > i, (line) => line.top(0))))
        .on_mouse_down("left", () => { this.pressed = w.id; this.over = w.id; this.onName = this.nameDown === w.id; this.nameDown = null; })
        .on_mouse_move((_e, cx) => {
          if (this.pressed !== null && this.over !== w.id) { this.over = w.id; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => {
          const was = this.pressed;
          this.pressed = null;
          this.over = null;
          if (was && was !== w.id) run("space.move", { id: was, index: i + 1 });
          else if (was === w.id && (this.onName || g.members.length === 0)) run("space.select", { id: w.id });
          else if (was === w.id) { open ? this.folded.add(g.id) : this.folded.delete(g.id); this.saveFolded(); }
          this.onName = false;
          cx.notify();
        })
        .on_mouse_down("right", () => spaceMenu(w))
        .child(h_flex().flex_1().min_w(0)
          // The name only as wide as it is: the rest of the row is for folding.
          .child(div().id(`spn-${w.id}`).min_w(0).truncate().text_size(10.5).font_semibold().text_color(w.active ? t.foreground : t.dim)
            .hover((s) => s.text_color(t.foreground))
            .tooltip(`Go to ${w.name}`)
            .on_mouse_down("left", () => { this.nameDown = w.id; })
            .child(w.name.toUpperCase())))
        .when(!open && g.members.length > 0, (el) => el
          .when(Boolean(top) && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(div().text_size(11).text_color(t.dim).child(String(g.members.length))))
        .when(g.members.length > 0, (el) => el.child(div().id(`fold-${g.id}`).flex_none().p(3).rounded(4).text_color(this.hoverHead === g.id ? t.foreground : t.dim)
          .hover((s) => s.bg(t.raised).text_color(t.foreground))
          // On mouse down, so the header under it neither selects nor starts a drag.
          .on_mouse_down("left", (_e, cx) => {
            cx.stop_propagation();
            open ? this.folded.add(g.id) : this.folded.delete(g.id);
            this.saveFolded();
            cx.notify();
          })
          .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11))));
    };
    // The rail: each space's letter, then its agents.
    const spaceLetter = (w) => h_flex()
      .id(`spc-${w.id}`)
      .h(28)
      .mt(4)
      .flex_none()
      .justify_center()
      .items_center()
      .tooltip(w.name)
      .on_click(() => run("space.select", { id: w.id }))
      .on_mouse_down("right", () => spaceMenu(w))
      .child(h_flex().size(18).rounded(5).bg(w.active ? t.selected : t.hover).items_center().justify_center().text_size(10.5).font_semibold().text_color(w.active ? t.foreground : t.dim)
        .child([...w.name][0]?.toUpperCase() ?? "?"));

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? groups.flatMap((g) => [...(g.space ? [spaceLetter(g.space)] : []), ...g.members.flatMap(withKids)])
      : groups.flatMap((g) => [g.space ? spaceHeader(g) : header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).pt(4).pb(8).overflow_y_scrollbar().mode("always")
        // A drag let go outside a header ends there.
        .on_mouse_up("left", (_e, cx) => { if (this.pressed !== null) { this.pressed = null; this.over = null; cx.notify(); } })
        .children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
