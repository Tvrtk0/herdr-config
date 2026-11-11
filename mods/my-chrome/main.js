// The sidebar's top row, in place of the shipped workspace-chrome's header and footer: no
// title and no collapse button (cmd-b hides the whole sidebar), just icons on the right of
// the traffic lights: notifications, search, settings (a dot when an update is ready) and
// add a machine. On the narrow rail the traffic lights fill the row, so it stays empty.
//
// Notifications: Herdr keeps no history of its toasts, so this keeps its own. The row's copy
// watches every agent and notes when one finishes or needs you (what Herdr toasts about);
// other mods add theirs to the same list (shared "notif.history", newest first). The bell
// shows how many came since you last opened it; the list (this mod again, as a popup, with
// props.history) opens the agent on a click. Entries older than three days are dropped.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, window, updates, layout, agents, shared, setShared, openOverlay, closeOverlay, props, exec, appHome } from "herdr";

const KEY = "notif.history";
const SEEN = "notif.seenAt";
const KEEP_MS = 3 * 24 * 3600 * 1000;
const MAX = 80;
// The popup: as tall as its items, up to LIST_MAX, then it scrolls.
const ROW = 54, HEAD = 41, LIST_MAX = 420;
const listH = (n) => Math.min(LIST_MAX, Math.max(80, n * ROW + 12));

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const history = () => (Array.isArray(shared(KEY)) ? shared(KEY) : []);
const nameOf = (a) => (a.title || a.tab_name || a.program?.name || a.address).replace(/^[^\p{L}\p{N}]+\s*/u, "");
function ago(ms) {
  const m = Math.floor(ms * (1 / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m * (1 / 60));
  return h < 24 ? `${h}h` : `${Math.floor(h * (1 / 24))}d`;
}

// Adds one to the list (any mod may write the same shape: { at, title, body, level, terminal }).
function remember(item) {
  const now = Date.now();
  const list = [{ at: now, ...item }, ...history()].filter((x) => now - x.at < KEEP_MS).slice(0, MAX);
  setShared(KEY, list);
}

export default class MyChrome extends View {
  init(_props, cx) {
    if (props()?.history) return;
    // The bell's picture lives in Herdr's own icons folder (a linked mod folder's new files
    // are not seen until a restart).
    exec("cp", ["-n", `${appHome()}/mods/my-chrome/bell.svg`, `${appHome()}/icons/my-chrome-bell.svg`]).catch(() => {});
    // Agent changes, looked at every two seconds; the first look only learns where they are.
    this.last = null;
    cx.timer.every(2000, (cx) => this.watch(cx));
    this.watch(cx);
  }

  // A turn that ends counts whether Herdr calls it "done" or, when you were already looking,
  // "idle"; the last statuses are kept in shared state so a reload of this mod misses nothing.
  watch(cx) {
    const prev = this.last ?? shared("notif.lastStatus") ?? null;
    const now = new Map(agents().map((a) => [a.address, a]));
    if (prev) {
      for (const [addr, a] of now) {
        const was = prev[addr];
        if (!was || was === a.status) continue;
        const where = a.space_name ? `in ${a.space_name}` : "";
        if (a.status === "blocked") remember({ title: `${nameOf(a)} needs you`, body: where, level: "warning", terminal: addr });
        else if ((was === "working" || was === "blocked") && (a.status === "done" || a.status === "idle")) remember({ title: `${nameOf(a)} finished`, body: where, level: "success", terminal: addr });
      }
    }
    const next = Object.fromEntries([...now].map(([k, a]) => [k, a.status]));
    this.last = next;
    if (JSON.stringify(next) !== JSON.stringify(shared("notif.lastStatus") ?? null)) setShared("notif.lastStatus", next);
  }

  button(id, icon, tip, action, dot = false) {
    const t = theme();
    return div().id(id).relative().size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(svg(icon.includes("/") ? icon : `mods/workspace-chrome/${icon}.svg`).size(15))
      .when(dot, (el) => el.child(div().absolute().top(4).right(4).size(6).rounded(3).bg(t.accent)));
  }

  // The list, drawn by this mod opened as a popup.
  list() {
    const t = theme();
    const items = history();
    const now = Date.now();
    const color = { success: t.ansi2, warning: t.blocked, error: t.ansi1, info: t.accent ?? t.ansi4 };
    return v_flex().id("nt-root").w_full().h(HEAD + listH(items.length)).bg(t.surface ?? t.popover).border_1().border_color(t.border).rounded(10).overflow_hidden().text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); } })
      .child(h_flex().flex_none().h(HEAD).px(14).items_center().border_b(1).border_color(t.border).bg(t.raised)
        .child(div().flex_1().text_size(13).font_semibold().child("Notifications"))
        .when(items.length > 0, (e) => e.child(div().id("nt-clear").px(8).h(24).flex().items_center().rounded(6).cursor_pointer()
          .text_size(11.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { setShared(KEY, []); cx.notify(); })
          .child("Clear all"))))
      // A fixed height: a scroll area left to flex collapses to nothing in a popup.
      .child(div().id("nt-scroll").h(listH(items.length)).overflow_y_scrollbar()
        .child(v_flex().p(6).gap(2)
          .when(!items.length, (e) => e.child(div().p(16).text_size(12).text_color(t.dim).text_center().child("Nothing yet. Finished agents and anything that needs you show up here.")))
          .children(items.map((x, i) => h_flex().id(`nt-${i}`).h(ROW - 4).gap(10).items_start().px(10).py(8).rounded(8)
            .when(Boolean(x.terminal), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
            .on_click(() => {
              if (!x.terminal) return;
              run("agent.focus", { terminal: x.terminal });
              closeOverlay(props().overlay);
            })
            .child(div().flex_none().mt(5).size(7).rounded(4).bg(color[x.level] ?? t.dim))
            .child(v_flex().flex_1().min_w(0).gap(1)
              .child(div().text_size(12.5).text_color(t.foreground).child(x.title ?? ""))
              .when(Boolean(x.body), (e) => e.child(div().text_size(11.5).text_color(t.dim).truncate().child(x.body))))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(now - x.at)))))));
  }

  render() {
    if (props()?.history) return this.list();
    const t = theme();
    const row = h_flex().size_full().bg(t.chrome).pr(10).gap(2).items_center().justify_end();
    if (narrow()) return row;
    const seen = Number(shared(SEEN) ?? 0);
    const fresh = history().filter((x) => x.at > seen).length;
    const bell = div().id("bell").relative().size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(fresh ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(fresh ? `${fresh} new notification${fresh > 1 ? "s" : ""}` : "Notifications")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => {
        setShared(SEEN, Date.now());
        openOverlay({ mod: "my-chrome", kind: "popup", width: 340, height: HEAD + listH(history().length) + 2, props: { history: true } });
      })
      .child(svg("icons/my-chrome-bell.svg").size(15))
      // Something new: a small dot, not a count.
      .when(fresh > 0, (el) => el.child(div().absolute().top(4).right(4).size(6).rounded(3).bg(t.accent ?? t.ansi4)));
    return row
      .child(bell)
      .child(this.button("search", "search", "Search (⌘P)", () => run("mod.open", { name: "my-picker" })))
      .child(this.button("settings", "settings", updates().app.ready ? "Settings · update ready" : "Settings", () => run("app.settings"), Boolean(updates().app.ready)))
      .child(this.button("machine", "server", "Add machine", () => run("mod.open", { name: "machine-add" })));
  }
}
