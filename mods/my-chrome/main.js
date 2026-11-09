// The sidebar's top row, in place of the shipped workspace-chrome's header and footer: no
// title and no collapse button (cmd-b hides the whole sidebar), just three icons on the
// right of the traffic lights: search, settings (a dot when an update is ready) and add a
// machine. On the narrow rail the traffic lights fill the row, so it stays empty.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, updates, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class MyChrome extends View {
  button(id, icon, tip, action, dot = false) {
    const t = theme();
    return div().id(id).relative().size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(15))
      .when(dot, (el) => el.child(div().absolute().top(4).right(4).size(6).rounded(3).bg(t.accent)));
  }

  render() {
    const t = theme();
    const row = h_flex().size_full().bg(t.chrome).pr(10).gap(2).items_center().justify_end();
    if (narrow()) return row;
    return row
      .child(this.button("search", "search", "Search (⌘P)", () => run("mod.open", { name: "picker" })))
      .child(this.button("settings", "settings", updates().app.ready ? "Settings · update ready" : "Settings", () => run("app.settings"), Boolean(updates().app.ready)))
      .child(this.button("machine", "server", "Add machine", () => run("mod.open", { name: "machine-add" })));
  }
}
