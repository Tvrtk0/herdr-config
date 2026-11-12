// Every key, on one sheet (cmd-/, or ? in a dashboard): the global ones from keys.json in
// groups, the terminal's, and the keys of the dashboard it was opened from (props.context).
// Typing filters; esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { keys, props, theme, closeOverlay } from "herdr";

// What an action does, in words; anything not here shows its own name.
const WORDS = {
  "app.quit": "Quit", "app.hide": "Hide", "app.hide_others": "Hide others", "app.palette": "Command palette", "app.settings": "Settings",
  "app.zoom_in": "Zoom in", "app.zoom_out": "Zoom out", "app.zoom_reset": "Reset zoom", "app.help": "Herdr help",
  "tab.new": "New tab", "tab.close": "Close tab", "tab.next": "Next tab", "tab.prev": "Previous tab", "tab.rename": "Rename tab",
  "space.new": "New space", "space.next": "Next space", "space.prev": "Previous space", "space.rename": "Rename space",
  "agent.next": "Next agent", "agent.prev": "Previous agent", "layout.switch": "Switch layout", "layout.toggle:sidebar": "Toggle sidebar",
  "pane.split:right": "Split right", "pane.split:down": "Split down", "pane.close": "Close pane", "pane.zoom": "Zoom pane",
  "mod.open:my-picker": "Picker", "mod.open:claude-reading": "Reading mode", "mod.open:claude-changes": "Session changes",
  "mod.open:keys-help": "This sheet", "mod.open:aside": "Aside: ask about the session", "claude-steps.notes": "Notes: quick notes for this session", "claude-steps.prev": "Previous request, open / closed", "claude-steps.refs": "Refs: links, paths and commands from the chat", "claude-steps.files": "Files panel on / off", "mod.open:pregled": "Overview (as a popup)",
  "my-agents.steps": "Session pane on / off", "my-agents.home": "Home dashboards", "review-prs.swap": "PR ⇄ its Claude",
  "terminal.search": "Find", "terminal.copy": "Copy", "terminal.paste": "Paste", "terminal.paste_image": "Paste image",
};
const word = (action) => {
  if (WORDS[action]) return WORDS[action];
  let m = /^pane\.(go|swap):(\w+)$/.exec(action);
  if (m) return `${m[1] === "go" ? "Focus" : "Move"} pane ${m[2]}`;
  m = /^tab\.select:(\d+)$/.exec(action);
  if (m) return `Tab ${m[1]}`;
  m = /^space\.select:(\d+)$/.exec(action);
  if (m) return `Space ${m[1]}`;
  if (action.startsWith("send:")) return "Send keys";
  return action;
};
const GROUPS = [
  ["Claude", (a) => /claude|aside|my-agents\.steps|review-prs/.test(a)],
  ["Home & dashboards", (a) => /my-agents\.home|pregled|keys-help|my-picker/.test(a)],
  ["Panes", (a) => a.startsWith("pane.")],
  ["Tabs", (a) => a.startsWith("tab.")],
  ["Spaces & agents", (a) => a.startsWith("space.") || a.startsWith("agent.")],
  ["App", () => true],
];
// The dashboards' own keys (they are not in keys.json).
const CONTEXT = {
  overview: ["Agents", [["j / k", "Pick a session"], ["enter", "Open it"], ["R", "Refresh"], ["[ / ]", "Other dashboards"]]],
  stats: ["Stats", [["R", "Refresh"], ["[ / ]", "Other dashboards"]]],
  news: ["News", [["R", "Refresh"], ["R R", "Write a new What's new now"], ["Click", "Open in the browser"], ["[ / ]", "Other dashboards"]]],
  review: ["Review", [["h / l, 1-3", "Ready / drafts / mine"], ["j / k", "Pick a PR"], ["enter", "Open it"], ["r", "Review in the background"], ["o", "On GitHub"], ["D", "Drafts on / off"], ["gg / G", "First / last"], ["zz", "Center"], ["R", "Refresh"], ["[ / ]", "Other dashboards"]]],
  tasks: ["Tasks", [["j / k", "Pick a task"], ["enter, o", "Open in YouTrack"], ["s", "Start in Claude"], ["m, then 1-9", "Change its state"], ["p", "Its PR"], ["w", "Its worktree as a space"], ["gg / G", "First / last"], ["R", "Refresh"], ["[ / ]", "Other dashboards"]]],
  worktrees: ["Worktrees", [["h / l, 1-3", "Repo"], ["j / k", "Pick a worktree"], ["enter", "Open as a space"], ["o", "Its PR"], ["x", "Remove (asks first)"], ["gg / G", "First / last"], ["R", "Refresh"], ["[ / ]", "Other dashboards"]]],
};
const pretty = (k) => k.replace(/cmd-/g, "⌘").replace(/shift-/g, "⇧").replace(/alt-/g, "⌥").replace(/ctrl-/g, "⌃").replace(/enter/g, "↵");

export default class KeysHelp extends View {
  init(_props, cx) {
    this.query = InputState.new({ placeholder: "Filter keys…" });
    this.query.on("change", (_e, cx) => cx.notify());
    this.query.focus();
    cx.timer.after(120, () => this.query.focus());
  }

  render(cx) {
    const t = theme();
    const q = this.query.value().trim().toLowerCase();
    const hit = (k, w) => !q || k.toLowerCase().includes(q) || w.toLowerCase().includes(q);
    const all = keys();
    const global = all.filter((b) => b.section === "global").map((b) => [pretty(b.keys), word(b.action), b.action]);
    const term = all.filter((b) => b.section === "terminal").map((b) => [pretty(b.keys), word(b.action), b.action]);
    const used = new Set();
    const groups = GROUPS.map(([name, test]) => {
      const rows = global.filter(([, , a]) => !used.has(a) && test(a));
      rows.forEach(([, , a]) => used.add(a));
      return [name, rows];
    });
    const ctx = CONTEXT[props()?.context];
    const blocks = [
      ...(ctx ? [[`${ctx[0]} (here)`, ctx[1].map(([k, w]) => [k, w])]] : []),
      ...groups.map(([n, rows]) => [n, rows.map(([k, w]) => [k, w])]),
      ["In a terminal", term.map(([k, w]) => [k, w])],
    ].map(([n, rows]) => [n, rows.filter(([k, w]) => hit(k, w))]).filter(([, rows]) => rows.length);
    const block = ([name, rows], i) => v_flex().id(`kb-${i}`).gap(2)
      .child(div().text_size(11).font_semibold().text_color(i === 0 && ctx ? t.accent ?? t.foreground : t.dim).pb(4).child(name.toUpperCase()))
      .children(rows.map(([k, w], j) => h_flex().id(`kr-${i}-${j}`).gap(12).items_center().py(4)
        .child(div().w(140).flex_none().child(h_flex().gap(4).children(k.split(" / ").map((part) =>
          div().px(6).h(20).flex().items_center().rounded(5).bg(t.raised).border_1().border_color(t.border).text_size(11.5).text_color(t.foreground).child(part)))))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(w))));
    // Two columns, the blocks filling them in turn.
    const cols = [[], []];
    blocks.forEach((b, i) => cols[i % 2].push(block(b, i)));
    return v_flex().id("kh-root").size_full().bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); } })
      .child(h_flex().flex_none().gap(12).items_center().px(20).h(54).border_b(1).border_color(t.border)
        .child(div().text_size(16).font_semibold().child("Keys"))
        .child(div().flex_1().px(10).h(30).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
          .child(Input.new(this.query).flex_1().text_size(12.5).text_color(t.foreground)))
        .child(div().text_size(11).text_color(t.dim).child("esc closes")))
      .child(div().id("kh-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().items_start().gap(28).px(20).py(16)
          .children(cols.map((c, i) => v_flex().id(`kc-${i}`).flex_1().min_w(0).gap(18).children(c))))
        .when(!blocks.length, (e) => e.child(div().px(20).py(16).text_size(12.5).text_color(t.dim).child("No key matches."))));
  }
}
