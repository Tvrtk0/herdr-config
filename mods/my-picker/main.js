// Go to a tab. Drops from the Terminals layout's space chip (popup, at: "top"). Spaces with
// something that needs you come first, quiet spaces (no agent running)
// fold into "earlier". Type to filter, ↑/↓ and Enter to go, ctrl+d to close
// a tab, Esc to leave. Last rows: new work (a tab here, a space on this
// computer or on each connected machine).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, terminals, panes, run, hc, exec, theme, settings, props, closeOverlay, openOverlay, shared, setShared, home } from "herdr";

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// Space colors, kept by space id in shared "space.colors": a theme
// color name ("ansi6") or a picked #rrggbb. A space seen without one gets
// the theme color fewest spaces use, once; every mod does the same in the
// same order, so they agree, and adding or renaming spaces moves nothing.
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
function spaceColors() {
  const ids = new Set(spaces().map((p) => p.id));
  const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
  for (const p of spaces()) {
    if (kept[p.id] || p.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[p.id] = PROJECT_COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
  return kept;
}
function spaceColor(t, p) {
  if (p.name === "~") return t.dim;
  const c = spaceColors()[p.id] ?? PROJECT_COLORS[0];
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// What a tab without an agent holds, by its first pane: a mod's own glyph, else a shell.
const MOD_ICON = { "pr-diff": "git-compare", "review-dashboard": "layers", "my-worktrees": "git-branch", files: "files", changes: "git-branch" };

// Fuzzy match: every query character in order. Higher is better (runs of
// characters and word starts count more); -1 when it doesn't match.
function fuzzy(q, text) {
  if (!q) return 0;
  const s = text.toLowerCase();
  let at = -1, score = 0, run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = s.indexOf(ch, at + 1);
    if (i < 0) return -1;
    run = i === at + 1 ? run + 1 : 0;
    score += 1 + run * 2 + (i === 0 || /[\s\-_/#.]/.test(s[i - 1]) ? 3 : 0);
    at = i;
  }
  return score - s.length * 0.01;
}

// What the list shows: every tab, tabs with an agent, or the review queue.
const SCOPES = [["all", "All"], ["agents", "Agents"], ["review", "Review"], ["themes", "Themes"]];
const URGENT = { blocked: 0, done: 1, working: 2, idle: 3 };
// review-prs keeps the queue here and opens a PR's tab on "review-prs.open".
const PRS_KEY = "review.prs", OPEN_KEY = "review.open";

// The status words beside a tab; the dot on its icon carries the same color.
const STATUS = { working: "working", blocked: "needs you", done: "finished", idle: "idle" };

const PICKABLE = new Set(["ctx", "new", "space", "tool", "pr", "theme", "look"]);

// Herdr's own themes; the rest are themes/*.json. Their swatches are kept in shared
// state the first time each is shown (a preset's colors are only known while it's on).
const PRESETS = [["graphite", true], ["ink", true]];
// Looks are whole layouts (standard repainted, built by looks/build.py): a gradient or a
// background image needs a layout, a theme only sets colors.
const LOOKS = [["standard", "Standard", "your layout, with the theme below"], ["dune", "Dune", "soft brown waves behind see-through panes"]];
const SWATCH_KEY = "picker.swatches";
// Layout-own themes (named like a layout) aren't offered elsewhere.
const HIDDEN_THEMES = new Set(["win98", "atom-one-dark", "dune"]);

// Prints one line per theme file, "name<TAB>json", then the shown layout's state: "@state<TAB>json".
const THEMES_SCRIPT = String.raw`
H="$HOME/.config/herdr-app"
for f in "$H"/themes/*.json(N); do printf '%s\t' "$f:t:r"; tr -d '\n' < "$f"; echo; done
L=$("$HOME/.local/bin/herdr-app" status 2>/dev/null | sed -n 's/.*"layout": "\(.*\)".*/\1/p' | head -1)
printf '@layout\t%s\n' "$L"
[ -n "$L" ] && [ -f "$H/layouts/.state/$L.json" ] && { printf '@state\t'; tr -d '\n' < "$H/layouts/.state/$L.json"; echo; }
`;

const lum = (hex) => {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
};

export default class Picker extends View {
  init(_props, cx) {
    // Tab and shift-tab step the scope. As plain keys they never reach the picker: the search
    // field takes Tab first (focus moves on), so they are bound as actions in its context.
    try {
      cx.bind_keys([
        { keystroke: "tab", action: "my_picker_next_scope", context: "MyPicker" },
        { keystroke: "shift-tab", action: "my_picker_prev_scope", context: "MyPicker" },
        // ⌘P again, with the picker open: the next scope, so a few presses walk them all.
        { keystroke: "cmd-p", action: "my_picker_next_scope", context: "MyPicker" },
      ]);
    } catch {}
    this.filter = "";
    // props.scope opens on one scope (a key binding can pass it); else the last one used.
    try { this.scope = props()?.scope ?? localStorage.getItem("scope") ?? "all"; } catch { this.scope = props()?.scope ?? "all"; }
    if (!SCOPES.some(([id]) => id === this.scope)) this.scope = "all";
    this.input = InputState.new({ placeholder: "Search…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.rows().filter((r) => PICKABLE.has(r.kind))[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.at = null;
    this.scroll = 0;
    this.showEarlier = false;
    this.machines = [];
    this.handle = cx.focus_handle();
    // Themes: the files, and the theme the shown layout uses now (to go back to on Esc).
    this.themeFiles = [];
    this.themeNow = null;
    this.previewed = null;
    this.committed = false;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("/bin/zsh", ["-c", THEMES_SCRIPT]);
        for (const line of r.stdout.split("\n")) {
          const tab = line.indexOf("\t");
          if (tab < 0) continue;
          const name = line.slice(0, tab);
          if (name === "@layout") { this.layoutNow = line.slice(tab + 1).trim() || null; continue; }
          try {
            const json = JSON.parse(line.slice(tab + 1));
            if (name === "@state") this.themeNow = json.theme ?? null;
            else if (name === "@layout") this.layoutNow = json;
            else if (!HIDDEN_THEMES.has(name)) this.themeFiles.push({ name, json });
          } catch {}
        }
      } catch {}
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary).map((m) => m.name);
      } catch {}
      cx.notify();
    });
  }

  // Also Herdr's teardown hook: closing without Enter puts back the theme a preview replaced.
  close() {
    this.revertTheme();
    closeOverlay(props().overlay);
  }

  // The theme name the shown appearance uses now.
  currentTheme() {
    const now = this.themeNow;
    if (!now) return null;
    return typeof now === "string" ? now : (settings().dark === false ? now.light : now.dark);
  }

  previewTheme(r) {
    if (r?.kind === "look") {
      if (r.name === this.previewedLook) return;
      this.previewedLook = r.name;
      run("layout.switch", { name: r.name });
      return;
    }
    if (r?.kind !== "theme" || r.name === this.previewed) return;
    this.previewed = r.name;
    run("app.theme", { name: r.name });
  }

  revertTheme() {
    if (this.previewedLook && !this.committed && this.layoutNow) {
      this.previewedLook = null;
      run("layout.switch", { name: this.layoutNow });
    }
    if (!this.previewed || this.committed) return;
    const back = this.currentTheme();
    this.previewed = null;
    if (back) run("app.theme", { name: back });
  }

  themeRows() {
    const f = this.filter.toLowerCase();
    const sw = shared(SWATCH_KEY) ?? {};
    const cur = this.currentTheme();
    const rows = [
      ...PRESETS.map(([name, dark]) => ({ name, dark, colors: sw[name] ?? null, own: false })),
      ...this.themeFiles.map(({ name, json }) => {
        const c = json.colors ?? {};
        const a = json.ansi ?? [];
        return { name, dark: lum(json.background ?? "#000000") < 128, own: true,
          colors: [json.background, c.surface ?? c.chrome ?? json.selection, c.accent ?? a[4], a[2], a[1], json.foreground].filter(Boolean) };
      }),
    ].map((r) => ({ kind: "theme", ...r, current: r.name === cur, score: fuzzy(f, `${r.name} ${r.dark ? "dark" : "light"}`) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => (f ? b.score - a.score : 0));
    const dark = rows.filter((r) => r.dark), light = rows.filter((r) => !r.dark);
    const out = [];
    const looks = LOOKS.map(([name, label, about]) => ({ kind: "look", name, label, about, current: name === this.layoutNow, score: fuzzy(f, `${name} ${label} ${about}`) }))
      .filter((r) => r.score >= 0);
    if (looks.length) out.push({ kind: "head", w: { id: "looks", name: "looks" }, label: "Looks" }, ...looks);
    if (dark.length) out.push({ kind: "head", w: { id: "themes-dark", name: "dark" }, label: "Themes" }, ...dark);
    if (false && light.length) out.push({ kind: "head", w: { id: "themes-light", name: "light" }, label: settings().dark === false ? "Light" : "Light (shows in light mode)" }, ...light);
    return out.length ? out : [{ kind: "empty", text: "No theme matches." }];
  }

  stepScope(d) {
    const i = SCOPES.findIndex(([id]) => id === this.scope);
    this.setScope(SCOPES[(i + SCOPES.length + d) % SCOPES.length][0]);
  }

  setScope(id) {
    this.scope = id;
    this.at = null;
    this.scroll = 0;
    try { localStorage.setItem("scope", id); } catch {}
  }

  rows() {
    if (this.scope === "agents") return this.agentRows();
    if (this.scope === "review") return this.reviewRows();
    if (this.scope === "themes") return this.themeRows();
    const f = this.filter.toLowerCase();
    const all = agents();
    const live = terminals().filter((x) => x.state === "live");
    const teamOf = (addrs) => {
      let n = 0;
      const walk = (a) => live.filter((x) => x.parent === a).forEach((k) => (n++, walk(k.address)));
      addrs.forEach(walk);
      return n;
    };
    const groups = spaces().map((w) => {
      const ctxs = w.tabs
        .map((ctx) => {
          const mine = all.filter((a) => a.tab === ctx.id);
          return { w, ctx, mine, team: teamOf(mine.map((a) => a.address)) };
        })
        .map((c) => ({ ...c, score: fuzzy(f, [c.ctx.name, w.name, ...c.mine.map((a) => a.program?.name ?? "")].join(" ")) }))
        .filter((c) => c.score >= 0)
        .sort((a, b) => (f ? b.score - a.score : 0));
      return { w, ctxs };
    });
    const busy = groups.filter((p) => p.w.status && p.ctxs.length);
    const quiet = groups.filter((p) => !p.w.status && p.ctxs.length);
    busy.sort((a, b) => (b.w.status === "blocked") - (a.w.status === "blocked"));
    const out = [];
    const add = (p) => {
      out.push({ kind: "head", w: p.w });
      for (const c of p.ctxs) out.push({ kind: "ctx", ...c });
    };
    busy.forEach(add);
    if (quiet.length) {
      out.push({ kind: "earlier", count: quiet.length });
      if (this.showEarlier || f) quiet.forEach(add);
    }
    out.push({ kind: "new" });
    out.push({ kind: "space", machine: null });
    for (const m of this.machines) out.push({ kind: "space", machine: m });
    out.push({ kind: "tool", mod: "my-worktrees", label: "worktrees", icon: "git-branch" });
    return out;
  }

  // Every tab with an agent, wherever it is: the ones that need you first.
  agentRows() {
    const f = this.filter.toLowerCase();
    const all = agents();
    const out = [];
    for (const w of spaces()) for (const ctx of w.tabs) {
      const mine = all.filter((a) => a.tab === ctx.id);
      if (!mine.length) continue;
      const score = fuzzy(f, [ctx.name, w.name, ...mine.map((a) => a.program?.name ?? "")].join(" "));
      if (score >= 0) out.push({ kind: "ctx", w, ctx, mine, team: 0, score, showSpace: true });
    }
    out.sort((a, b) => (f ? b.score - a.score : 0) || (URGENT[a.ctx.status] ?? 4) - (URGENT[b.ctx.status] ?? 4));
    return out.length ? out : [{ kind: "empty", text: f ? "No agent matches." : "No agents running." }];
  }

  // The review space's open tabs, then the PRs waiting for you that have no tab yet.
  reviewRows() {
    const f = this.filter.toLowerCase();
    const all = agents();
    const space = spaces().find((w) => w.name.toLowerCase() === "review");
    const out = [];
    const tabs = (space?.tabs ?? [])
      .map((ctx) => ({ kind: "ctx", w: space, ctx, mine: all.filter((a) => a.tab === ctx.id), team: 0, score: fuzzy(f, ctx.name) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => (f ? b.score - a.score : 0));
    if (tabs.length) out.push({ kind: "head", w: space, label: "Open" }, ...tabs);
    const open = new Set((space?.tabs ?? []).map((tb) => tb.name));
    const prs = (shared(PRS_KEY) ?? [])
      .filter((pr) => !open.has(`#${pr.number}`))
      .map((pr) => ({ kind: "pr", pr, score: fuzzy(f, `#${pr.number} ${pr.title} ${pr.author?.login ?? ""} ${pr.repository.nameWithOwner}`) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => (f ? b.score - a.score : 0));
    if (prs.length) out.push({ kind: "head", w: space ?? { id: "review", name: "review" }, label: "Waiting for your review" }, ...prs);
    return out.length ? out : [{ kind: "empty", text: f ? "Nothing matches." : "Nothing waiting for your review." }];
  }

  go(r) {
    if (!r) return;
    if (r.kind === "look") {
      this.committed = true;
      run("layout.switch", { name: r.name });
      this.close();
      return;
    }
    if (r.kind === "theme") {
      this.committed = true;
      run("app.theme", { name: r.name });
      this.close();
      return;
    }
    this.close();
    if (r.kind === "pr") {
      setShared(OPEN_KEY, { ...r.pr, at: Date.now() });
      run("review-prs.open");
      return;
    }
    if (r.kind === "ctx") run("tab.select", { id: r.ctx.id });
    else if (r.kind === "new") run("tab.new");
    else if (r.kind === "space") run("space.new", { machine: r.machine ?? "" });
    else if (r.kind === "tool") {
      // Its tab when one is open, else a new one.
      const open = panes().find((p) => p.mod === r.mod);
      if (open) run("tab.select", { id: open.tab });
      else run("tab.new", { name: r.label[0].toUpperCase() + r.label.slice(1), mod: r.mod });
    }
  }

  // A tab's icon: its agent's logo with a status dot in the corner, or what the tab shows.
  tabIcon(t, r, on) {
    const a = r.mine[0];
    const box = div().relative().size(22).flex_none().rounded(6).flex().items_center().justify_center()
      .bg(on ? t.raised : t.surface).border_1().border_color(t.border);
    if (a) {
      const st = r.ctx.status ?? a.status;
      const pic = programIcon(a.program, 14, t.foreground) ?? svg("icons/agent.svg").size(14).text_color(t.foreground);
      return box.child(pic)
        .when(Boolean(st), (el) => el.child(div().absolute().right(-3).bottom(-3).size(9).rounded(5)
          .border_2().border_color(t.popover).bg(t[st] ?? t.dim)));
    }
    const mod = panes().find((p) => p.tab === r.ctx.id)?.mod;
    return box.child(svg(`mods/workspace-chrome/${MOD_ICON[mod] ?? (mod ? "square" : "terminal")}.svg`).size(13).text_color(t.dim));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => PICKABLE.has(r.kind));
    // Opens on where you are.
    if (this.at === null) this.at = Math.max(0, pickable.findIndex((r) => (r.kind === "ctx" && r.w.active && r.ctx.active) || ((r.kind === "theme" || r.kind === "look") && r.current)));
    this.at = Math.min(this.at, pickable.length - 1);
    const sel = pickable[this.at];
    // One continuous strip: each row (and the group title before it) at a fixed
    // y. Scrolling moves the strip only as far as it takes to keep the selected
    // row in view, so the arrows can't run the selection off the list.
    const H = { head: 32, earlier: 35, new: 40, ctx: 38, space: 34, tool: 34, pr: 38, empty: 44, theme: 38, look: 38 };
    // A preset's swatches are learned while it is the shown theme.
    const curName = this.previewed ?? this.currentTheme();
    if (curName && PRESETS.some(([n]) => n === curName) && !(shared(SWATCH_KEY) ?? {})[curName]) {
      const sw = [t.background, t.surface, t.accent, t.ansi2, t.ansi1, t.foreground];
      Promise.resolve().then(() => setShared(SWATCH_KEY, { ...(shared(SWATCH_KEY) ?? {}), [curName]: sw }));
    }
    const tops = [];
    let y = 0;
    rows.forEach((r) => { tops.push(y); y += H[r.kind] ?? 32; });
    const total = y;
    const height = Math.min(480, this.listHeight ?? 480);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const si = rows.indexOf(sel);
    if (si >= 0) {
      if (tops[si] < this.scroll) this.scroll = tops[si];
      if (tops[si] + (H[sel.kind] ?? 32) > this.scroll + height) this.scroll = tops[si] + (H[sel.kind] ?? 32) - height;
    }
    const place = (el, i) =>
      fixed
        ? el.absolute().left(0).right(0).top(tops[i] - this.scroll).bottom(height - (tops[i] + (H[rows[i].kind] ?? 32) - this.scroll))
        : el;
    const visible = (i) => !fixed || (tops[i] + (H[rows[i].kind] ?? 32) > this.scroll && tops[i] < this.scroll + height);

    const row = (r) => {
      if (r.kind === "head") {
        return h_flex()
          .px(12)
          .pt(12)
          .pb(4)
          .gap(7)
          .items_center()
          .text_size(10.5)
          .font_semibold()
          .text_color(t.dim)
          .child(div().size(8).rounded(2).bg(spaceColor(t, r.w)))
          .child(div().child((r.label ?? r.w.name).toUpperCase()))
          .child(div().h(1).flex_1().bg(t.border).ml(4));
      }
      if (r.kind === "look") {
        const on = r === sel;
        const pic = { standard: [t.canvas, t.chrome, t.accent], dune: ["#140f0a", "#2e1f13", "#120d09"] }[r.name] ?? [];
        return h_flex().id(`pk-look-${r.name}`).mx(6).px(8).h(H.look - 2).rounded(8).gap(10).items_center().cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .child(h_flex().flex_none().w(84).h(22).rounded(6).overflow_hidden().border_1().border_color(t.border)
            .children(pic.map((c) => div().flex_1().h_full().bg(c))))
          .child(div().flex_none().text_size(13).text_color(t.foreground).when(on || r.current, (d) => d.font_medium()).child(r.label))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.about))
          .when(r.current, (el) => el.child(div().flex_none().px(5).rounded(4).text_size(10).text_color(t.dim).border_1().border_color(t.border).child("current")));
      }
      if (r.kind === "theme") {
        const on = r === sel;
        const chips = (r.colors ?? []).slice(0, 6);
        return h_flex().id(`pk-theme-${r.name}`).mx(6).px(8).h(H.theme - 2).rounded(8).gap(10).items_center().cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .child(h_flex().flex_none().h(22).rounded(6).overflow_hidden().border_1().border_color(t.border)
            .when(!chips.length, (el) => el.w(22 * 3).items_center().justify_center().text_size(10).text_color(t.dim).child("?"))
            .children(chips.map((c) => div().w(14).h_full().bg(c))))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).when(on || r.current, (d) => d.font_medium()).child(r.name))
          .when(r.current, (el) => el.child(div().flex_none().px(5).rounded(4).text_size(10).text_color(t.dim).border_1().border_color(t.border).child("current")))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(r.own ? "yours" : "herdr"));
      }
      if (r.kind === "empty") return div().px(14).py(14).text_size(12.5).text_color(t.dim).child(r.text);
      if (r.kind === "pr") {
        const on = r === sel;
        return h_flex().id(`pk-pr-${r.pr.url}`).mx(6).px(8).h(H.pr - 2).rounded(8).gap(10).items_center().cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .child(div().size(22).flex_none().rounded(6).flex().items_center().justify_center().border_1().border_color(t.border).bg(t.surface)
            .child(svg("mods/workspace-chrome/git-compare.svg").size(13).text_color(t.dim)))
          .child(div().flex_none().text_size(12.5).text_color(t.dim).child(`#${r.pr.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).when(on, (d) => d.font_medium()).child(r.pr.title))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${r.pr.author?.login ?? ""} · ${r.pr.repository.nameWithOwner.split("/")[1]}`));
      }
      if (r.kind === "earlier") {
        return h_flex()
          .id("pk-earlier")
          .mt(6)
          .px(10)
          .py(6)
          .border_t(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.showEarlier = !this.showEarlier;
            cx.notify();
          })
          .child(`earlier: ${r.count} quiet space${r.count > 1 ? "s" : ""} ${this.showEarlier ? "▴" : "▾"}`);
      }
      const on = r === sel;
      if (r.kind === "new" || r.kind === "space" || r.kind === "tool") {
        const label = r.kind === "tool" ? r.label : r.kind === "new" ? "new tab" : r.machine ? `new space on ${r.machine}` : "new space";
        return h_flex()
          .id(r.kind === "new" ? "pk-new" : r.kind === "tool" ? `pk-tool-${r.mod}` : `pk-space-${r.machine ?? "here"}`)
          .mx(6)
          .when(r.kind === "new", (el) => el.mt(6))
          .px(8)
          .h(H[r.kind] - (r.kind === "new" ? 6 : 2))
          .items_center()
          .rounded(8)
          .gap(10)
          .text_size(12.5)
          .text_color(on ? t.foreground : t.muted)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .child(div().size(22).flex_none().rounded(6).flex().items_center().justify_center().border_1().border_color(t.border)
            .child(svg(`mods/workspace-chrome/${r.kind === "tool" ? r.icon : r.kind === "new" ? "plus" : r.machine ? "server" : "folder-plus"}.svg`).size(13).text_color(t.dim)))
          .child(label);
      }
      const who = r.mine.map((a) => a.program?.name ?? "agent").join(" · ");
      const here = r.w.active && r.ctx.active;
      const st = r.ctx.status;
      return h_flex()
        .id(`pk-${r.ctx.id}`)
        .mx(6)
        .px(8)
        .h(H.ctx - 2)
        .rounded(8)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(this.tabIcon(t, r, on))
        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).when(here || on, (d) => d.font_medium()).child(r.ctx.name))
          .when(Boolean(r.showSpace), (el) => el.child(h_flex().flex_none().gap(5).items_center().text_size(11).text_color(t.dim)
            .child(div().size(7).rounded(2).bg(spaceColor(t, r.w))).child(div().child(r.w.name))))
          .when(here, (el) => el.child(div().flex_none().px(5).rounded(4).text_size(10).text_color(t.dim).border_1().border_color(t.border).child("current")))
          .when(Boolean(who), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(who + (r.team ? ` +${r.team}` : "")))))
        .when(st === "working", (el) => el.child(h_flex().flex_none().gap(5).items_center().text_size(11).text_color(t.working)
          .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900)).child(div().child(STATUS.working))))
        .when(Boolean(st) && st !== "working", (el) => el.child(div().flex_none().px(6).py(1).rounded(5).text_size(10.5)
          .bg((t[st] ?? t.dim) + "22").text_color(t[st] ?? t.dim).child(STATUS[st] ?? st)));
    };

    return v_flex()
      .id("picker")
      .key_context("MyPicker")
      .on_action("my_picker_next_scope", (_e, cx) => { this.stepScope(1); cx.stop_propagation(); cx.notify(); })
      .on_action("my_picker_prev_scope", (_e, cx) => { this.stepScope(-1); cx.stop_propagation(); cx.notify(); })
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(12)
      .gap(8)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        // tab / shift-tab: the next or previous scope.
        if (k === "p" && e.modifiers.platform && !e.modifiers.shift && !e.modifiers.control && !e.modifiers.alt) {
          this.stepScope(1);
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (k === "tab") {
          this.stepScope(e.modifiers.shift ? -1 : 1);
          cx.stop_propagation();
          cx.notify();
          return;
        }
        // ctrl-n / ctrl-p move like the arrows, as in Emacs, vim's completion menus and fzf.
        const ctrlOnly = e.modifiers.control && !e.modifiers.platform && !e.modifiers.alt;
        if (k === "down" || (ctrlOnly && k === "n")) { this.at = (this.at + 1) % pickable.length; this.previewTheme(pickable[this.at]); }
        else if (k === "up" || (ctrlOnly && k === "p")) { this.at = (this.at + pickable.length - 1) % pickable.length; this.previewTheme(pickable[this.at]); }
        else if (k === "d" && e.modifiers.control) {
          if (sel?.kind === "ctx") {
            this.close();
            run("tab.close", { id: sel.ctx.id });
          }
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex().h(42).flex_none().px(12).gap(10).items_center().rounded(10).border_1().border_color(t.border).bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(16).text_color(t.muted))
          .child(Input.new(this.input).flex_1().h_full().text_size(14).text_color(t.foreground))
          .child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.dim).child("esc")),
      )
      .child(h_flex().flex_none().gap(4).items_center()
        .children(SCOPES.map(([id, label]) => {
          const on = this.scope === id;
          return div().id(`pk-scope-${id}`).px(10).h(24).flex().items_center().rounded(6).cursor_pointer().text_size(12)
            .when(on, (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
            .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
            .on_click((_e, cx) => { this.setScope(id); cx.notify(); })
            .child(label);
        }))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child("tab switches")))
      .child(
        v_flex()
          .id("pk-list")
          .on_size_change((size, cx) => {
            this.listHeight = size.height / settings().zoom;
            cx.notify();
          })
          .h(Math.min(480, total))
          .min_h(0)
          .when(fixed, (el) =>
            el.overflow_hidden().on_scroll_wheel((e, cx) => {
              this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
              // The selection follows the wheel, so the next frame doesn't scroll back to it.
              while (this.at < pickable.length - 1 && tops[rows.indexOf(pickable[this.at])] < this.scroll) this.at++;
              while (this.at > 0 && tops[rows.indexOf(pickable[this.at])] + (H[pickable[this.at].kind] ?? 32) > this.scroll + height) this.at--;
              cx.notify();
            }))
          .children(rows.map((r, i) => (visible(i) ? place(row(r), i) : null)).filter(Boolean)),
      )
      .child(h_flex().flex_none().pt(8).px(4).gap(14).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .children((this.scope === "themes" ? [["↑↓ ^n ^p", "preview"], ["enter", "keep"], ["esc", "put back"], ["tab", "scope"]] : [["↑↓ ^n ^p", "move"], ["enter", "go"], ["tab", "scope"], ["^d", "close tab"]]).map(([k, what]) =>
          h_flex().gap(5).items_center().child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(what))))
        .child(div().flex_1())
        .child(h_flex().gap(5).items_center().child(div().size(7).rounded(4).bg(t.working)).child(div().child("working"))
          .child(div().size(7).rounded(4).bg(t.blocked).ml(6)).child(div().child("needs you"))
          .child(div().size(7).rounded(4).bg(t.done).ml(6)).child(div().child("finished"))));
  }
}
