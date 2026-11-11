// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "my-pane" } } } }
// Every pane: the program's icon, its name or the terminal's title, the folder; buttons
// split, zoom and close it on hover. A Claude Code pane also shows what its session says:
// the model, how full the context is, and the turn (running, or how long the last one took).
// Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, Input, InputState } from "gpui-base";
import { panes, props, run, theme, home, hc, readTextFile, exec, terminals, focused } from "herdr";

// A color at some opacity, whether it came as #rrggbb or already #rrggbbaa.
const alpha = (c, a) => (c.length === 9 ? c.slice(0, 7) : c) + a;

// How much of the end of a transcript is read: enough for the last turn, small at any size.
const TAIL_BYTES = 1500000;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// "claude-opus-5-5" -> "Opus 5.5".
function modelName(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id ?? "");
  if (!m) return id ?? "";
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

// The context a model reads, in tokens: the current Claude 5 models take 1M, older ones 200k.
const windowOf = (id, used) => (/claude-(opus|sonnet)-5/.test(id ?? "") || used > 200000 ? 1000000 : 200000);

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// What was typed (not a tool's result, not the harness's own lines).
function typed(r) {
  const c = r.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join(" ") : "";
  return Boolean(text.trim()) && !text.trimStart().startsWith("<") && !r.isMeta && !(Array.isArray(c) && c.some((x) => x?.type === "tool_result"));
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.info = null;
    // Renaming the session (double-click its title): a name of your own, kept on its terminal
    // as the label "my.name", which this header, the overview and the agents list show.
    this.renaming = false;
    this.nameInput = InputState.new({ placeholder: "Session name" });
    this.nameInput.on("submit", (_e, cx) => this.saveName(cx));
    this.nameInput.on("blur", (_e, cx) => { this.renaming = false; cx.notify(); });
    // While Claude works: its facts every few seconds, the clock every second.
    cx.timer.every(1000, (cx) => {
      const p = this.subject();
      if (!p || p.app !== "claude-code") return;
      // A header in a tab behind: its facts are read again when it comes to the front.
      if (this.me() && this.me().tab !== focused()?.tab) return;
      const now = Date.now();
      const changed = p.status !== this.lastStatus;
      const due = now - (this.readAt ?? 0) > (p.status === "working" ? 4000 : 20000);
      this.lastStatus = p.status;
      if (changed || due) this.load(cx);
      if (p.status === "working") cx.notify();
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // Whose session this header describes: its own pane, or for a Claude reader the Claude
  // terminal beside it in the same tab.
  subject() {
    const me = this.me();
    if (me?.mod !== "claude-reader" && me?.mod !== "claude-steps") return me;
    return panes().find((q) => q.tab === me.tab && q.app === "claude-code") ?? null;
  }

  // The name you gave the session, if any.
  customName(p) {
    return p?.terminal ? terminals().find((x) => x.address === p.terminal)?.labels?.["my.name"] || null : null;
  }

  startRename(p, cx) {
    this.renaming = true;
    this.nameInput.set_value(this.customName(p) ?? "");
    this.nameInput.focus();
    cx.notify();
  }

  // Enter keeps the name (an empty one goes back to Claude's title).
  saveName(cx) {
    const p = this.subject();
    const name = this.nameInput.value().trim();
    this.renaming = false;
    if (p?.terminal) exec("hc", ["label", p.terminal, `my.name=${name}`]).catch(() => {});
    cx.notify();
  }

  readerOf(p) {
    return panes().find((q) => q.tab === p.tab && (q.mod === "claude-reader" || q.mod === "claude-steps")) ?? null;
  }

  // Opens the reader around this Claude terminal: the chat on the left at full height, the
  // side panel top right and the terminal under it; the keys stay in the terminal. Again:
  // closes both reader panes.
  toggleReader(p) {
    const open = panes().filter((q) => q.tab === p.tab && (q.mod === "claude-reader" || q.mod === "claude-steps"));
    if (open.length) { for (const q of open) run("pane.close", { pane: q.pane }); return; }
    const props = (part) => ({ terminal: p.terminal, part });
    run("pane.split", { direction: "right", pane: p.pane, mod: "claude-reader", props: props("chat") });
    run("pane.swap", { direction: "left" });
    run("pane.split", { direction: "down", pane: p.pane, mod: "claude-steps", props: props("side") });
    run("pane.swap", { direction: "up" });
    run("pane.focus", { pane: p.pane });
  }

  textButton(t, id, label, onClick) {
    return div().id(id).px(6).h(20).flex().items_center().rounded(4).text_size(11).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .child(label);
  }

  // The pane's Claude session: its process, the session file Claude keeps for it, the end of
  // its transcript. Facts: model, context used, when the turn began and when it last spoke.
  load(cx) {
    if (this.loading) return;
    const p = this.subject();
    if (!p?.terminal) return;
    this.loading = true;
    this.readAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const got = await hc(["get", p.terminal, "--json"]);
        const pid = got.code === 0 ? JSON.parse(got.stdout)?.foreground?.pid : null;
        const session = pid ? JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`)) ?? "null") : null;
        if (session?.sessionId && session?.cwd) {
          const file = `${home()}/.claude/projects/${session.cwd.replace(/[^A-Za-z0-9]/g, "-")}/${session.sessionId}.jsonl`;
          const tail = await exec("tail", ["-c", String(TAIL_BYTES), file]);
          let model = null, used = null, askedAt = null, spokeAt = null;
          for (const line of (tail.stdout ?? "").split("\n")) {
            let r;
            try { r = JSON.parse(line); } catch { continue; }
            if (r.type === "assistant") {
              const u = r.message?.usage;
              if (r.message?.model && r.message.model !== "<synthetic>") model = r.message.model;
              if (u) used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
              if (r.timestamp) spokeAt = Date.parse(r.timestamp);
            } else if (r.type === "user" && typed(r) && r.timestamp) {
              askedAt = Date.parse(r.timestamp);
            }
          }
          // What Claude last handed its status line (~/.claude/statusline-command.sh keeps it
          // per session): the context as it counts it, the effort, the 5-hour and weekly limits.
          const line = JSON.parse((await readTextFile(`${home()}/.claude/state/statusline/${session.sessionId}.json`)) ?? "null");
          const cw = line?.context_window;
          // What the Claude Code mods leave for Herdr: ask-mode's level, the latest notice.
          const ask = JSON.parse((await readTextFile(`${home()}/.claude/state/ask-mode/${p.terminal}.json`)) ?? "null");
          const notice = JSON.parse((await readTextFile(`${home()}/.claude/state/reader/${p.terminal}.notice.json`)) ?? "null");
          this.info = {
            ask: ask?.level && ask.level !== "off" ? ask.level : null,
            notice: notice?.text && Date.now() - (notice.at ?? 0) < 15 * 60000 ? notice : null,
            added: line?.cost?.total_lines_added ?? null,
            removed: line?.cost?.total_lines_removed ?? null,
            model: line?.model?.id ?? model,
            modelLabel: line?.model?.display_name ?? null,
            effort: line?.effort?.level ?? null,
            used: cw?.current_usage ? (cw.current_usage.input_tokens ?? 0) + (cw.current_usage.cache_read_input_tokens ?? 0) + (cw.current_usage.cache_creation_input_tokens ?? 0) : used,
            window: cw?.context_window_size ?? windowOf(model, used ?? 0),
            percent: cw?.used_percentage ?? null,
            limits: line?.rate_limits ?? null,
            askedAt,
            spokeAt,
          };
        }
      } catch {
        // A pane whose session can't be read keeps the plain header.
      }
      this.loading = false;
      cx.notify();
    });
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  // The context as a thin bar and a number; warmer as it fills.
  ctx(t, info, bar = true) {
    if (info?.used == null && info?.percent == null) return null;
    const pct = Math.round(info.percent ?? (100 * info.used) / info.window);
    const share = Math.min(1, pct / 100);
    const color = pct < 50 ? t.ansi2 : pct < 80 ? t.working : t.ansi1;
    return h_flex().flex_none().gap(6).items_center().text_size(11).text_color(t.muted)
      .tooltip(info.used != null ? `Context: ${Math.round(info.used / 1000)}k of ${Math.round(info.window / 1000)}k tokens` : "Context")
      .child(div().text_color(t.dim).child("ctx"))
      .when(bar, (e) => e.child(div().w(56).h(5).rounded(3).bg(t.raised).overflow_hidden()
        .child(div().h_full().w(Math.max(2, Math.round(56 * share))).rounded(3).bg(color))))
      .child(div().when(bar, (e) => e.w(28)).text_color(bar ? t.muted : color).child(`${pct}%`));
  }

  // The 5-hour and weekly limits, quiet; warmer as they fill.
  limits(t, info, weekly = true) {
    const l = info?.limits;
    if (!l?.five_hour && !l?.seven_day) return null;
    const when = (at) => {
      if (!at) return "";
      const d = new Date(at * 1000), now = new Date();
      const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      if (d.toDateString() === now.toDateString()) return `today ${hm}`;
      return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`;
    };
    const one = (label, x) => {
      if (!x) return null;
      const pct = Math.round(x.used_percentage ?? 0);
      const color = pct < 60 ? t.muted : pct < 85 ? t.working : t.ansi1;
      return h_flex().gap(4).items_center().tooltip(`${label === "5h" ? "5-hour" : "Weekly"} limit: ${pct}%, resets ${when(x.resets_at)}`)
        .child(div().text_color(t.dim).child(label))
        .child(div().text_color(color).child(`${pct}%`));
    };
    return h_flex().flex_none().gap(10).items_center().text_size(11)
      .child(one("5h", l.five_hour) ?? div())
      .child((weekly && one("7d", l.seven_day)) || div());
  }

  // The turn: running with its clock, waiting on you, or done with how long it took.
  turn(t, st, info) {
    const since = info?.askedAt;
    if (st === "working") {
      return h_flex().flex_none().gap(6).items_center().px(7).h(20).rounded(10).bg(alpha(t.working, "1f")).text_size(11).text_color(t.working)
        .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900))
        .child(div().child(since ? `Working · ${duration(Date.now() - since)}` : "Working"));
    }
    if (st === "blocked") {
      return h_flex().flex_none().gap(6).items_center().px(7).h(20).rounded(10).bg(alpha(t.blocked, "26")).text_size(11).font_semibold().text_color(t.blocked)
        .child(div().size(6).rounded(3).bg(t.blocked))
        .child(div().child("Needs you"));
    }
    if (st === "done" || st === "idle") {
      const took = since && info?.spokeAt && info.spokeAt >= since ? ` · ${duration(info.spokeAt - since)}` : "";
      const color = st === "done" ? t.done : t.dim;
      return h_flex().flex_none().gap(6).items_center().px(7).h(20).rounded(10).text_size(11).text_color(color)
        .child(div().size(6).rounded(3).bg(color))
        .child(div().child(`Done${took}`));
    }
    return null;
  }

  render(cx) {
    const t = theme();
    const me = this.me();
    if (!me) return div();
    // A reader shows its session's header; the Claude terminal under a reader keeps a thin one.
    const isReader = me.mod === "claude-reader";
    // The reader's side panel: a thin label, the chat's header carries the session.
    if (me.mod === "claude-steps") {
      return h_flex().id(`pane-head-${me.pane}`).size_full().px(12).gap(8).items_center()
        .border_b(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .on_click(() => run("pane.focus", { pane: me.pane }))
        .child(div().child("Session"));
    }
    const p = this.subject() ?? me;
    // The reader draws its session's facts itself; its header and the terminal's under it carry
    // only a label and the pane's buttons.
    const compact = !isReader && me.app === "claude-code" && panes().some((q) => q.tab === me.tab && q.mod === "claude-reader");
    const claude = p.app === "claude-code";
    const info = claude ? this.info : null;
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    // A Claude session titles its terminal by what it is doing: that names the pane best.
    const title = this.customName(p) ?? (claude && p.title && p.title !== p.program?.name ? p.title.replace(/^[^\p{L}\p{N}]+\s*/u, "") : null);
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = me.pane;
    // Whether the header is at least this wide (before the first measure: yes).
    const fits = (px) => (this.w ?? 9999) >= px;
    // The prompt under a reader: a thin label; the reader's header carries the session.
    if (compact) {
      return h_flex().id(`pane-head-${pane}`).relative().size_full().px(12).gap(8).items_center()
        .border_b(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
        .on_click(() => run("pane.focus", { pane }))
        .when(Boolean(pic), (el) => el.child(pic))
        .child(div().child("Prompt"))
        .child(div().flex_1())
        .when(this.hovered, (el) => el.child(h_flex().gap(1).items_center()
          .child(this.textButton(t, `ph-rd-${pane}`, "Close reader", () => this.toggleReader(me)))
          .child(this.button(t, `ph-z-${pane}`, me.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))));
    }
    return h_flex()
      .id(`pane-head-${pane}`)
      .relative()
      .size_full()
      .px(12)
      .gap(10)
      .items_center()
      .when((t.background ?? "").length !== 9, (el) => el.bg(t.background))
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_size_change((size, cx) => { if (Math.abs(size.width - (this.w ?? 0)) >= 1) { this.w = size.width; cx.notify(); } })
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      // The title gives way first (it truncates); the facts on the right never get cut, they
      // drop one by one as the pane narrows: folder, lines changed, the bar, effort, weekly.
      .when(this.renaming, (el) => el.child(div().w(260).flex_none().px(6).h(22).flex().items_center().rounded(5).border_1().border_color(t.accent ?? t.input).bg(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => { if (e.key === "escape") { this.renaming = false; cx.stop_propagation(); cx.notify(); } })
        .child(Input.new(this.nameInput).flex_1().text_size(12).text_color(t.foreground))))
      .when(!this.renaming, (el) => el
        .child(div().id(`ph-title-${pane}`).flex_shrink(1).min_w(40).truncate().max_w(title ? 420 : 260).font_medium().text_color(t.foreground)
        .when(Boolean(title), (e) => e.tooltip(name)).child(title ?? name)
          // Double-click: rename the session.
          .on_mouse_down("left", (e, cx) => { if (e.click_count === 2 && claude) { cx.stop_propagation(); this.startRename(p, cx); } })))
      .when(Boolean(title) && !claude, (el) => el.child(div().flex_none().text_color(t.dim).child(name)))
      .when(Boolean(info?.model) && fits(620), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).border_1().border_color(t.input).text_size(10.5).text_color(t.muted)
        .tooltip(`${info.modelLabel ?? modelName(info.model)}${info.effort ? ` · ${info.effort}` : ""}`)
        .child(`${info.modelLabel ?? modelName(info.model)}${info.effort && fits(680) ? ` · ${info.effort}` : ""}`)))
      .when(Boolean(info?.ask), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(alpha(t.working, "26")).text_size(10.5).font_semibold().text_color(t.working)
        .tooltip("Read-only: Claude changes nothing. /ask off to leave").child(`🔒 ${info.ask}`)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim)
        .when(!claude || fits(1100), (e) => e.child(`${folder(p.cwd)}${p.branch ? `  ·  ${p.branch}` : ""}`)))
      .when(claude && (info?.added || info?.removed) && fits(940), (el) => el.child(h_flex().flex_none().gap(5).text_size(11)
        .tooltip("Lines changed in this session")
        .child(div().text_color(t.ansi2).child(`+${info.added ?? 0}`))
        .child(div().text_color(t.ansi1).child(`−${info.removed ?? 0}`))))
      .when(Boolean(info?.notice) && fits(1000), (el) => el.child(div().flex_none().max_w(260).truncate().px(6).h(18).flex().items_center().rounded(5).border_1().border_color(t.input).text_size(10.5).text_color(t.muted)
        .tooltip(`${info.notice.text}${info.notice.command ? ` (${info.notice.command})` : ""}`).child(info.notice.text)))
      .when(claude, (el) => el
        .child((fits(560) && this.limits(t, info, fits(660))) || div())
        .child(this.ctx(t, info, fits(820)) ?? div())
        // The steps pane beside it shows the state already.
        .child((!panes().some((q) => q.tab === me.tab && q.mod === "claude-steps") && this.turn(t, st, info)) || div()))
      .when(!claude && st === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(!claude && st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(alpha(t.blocked, "26")).text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(!claude && st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      // On hover the pane's buttons float over the right end, so nothing in the row moves.
      .when(this.hovered, (el) => el.child(h_flex().absolute().right(6).top(0).bottom(0).items_center()
        .child(h_flex().gap(1).px(3).h(24).items_center().rounded(7).bg(t.popover).border_1().border_color(t.border)
          .when(!isReader, (x) => x
            .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
            .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane })))
          .child(this.button(t, `ph-z-${pane}`, me.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
          .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })))));
  }
}
