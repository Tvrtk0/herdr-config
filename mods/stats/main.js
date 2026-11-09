// Stats, the Home space's fourth tab: the last 14 days of work with Claude and git. Each
// chart shows one measure in one color with a tooltip per bar; numbers come from
// collect.py (transcripts and git log), read again every ten minutes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, run, openOverlay, readTextFile, nextCommand } from "herdr";

const alpha = (c, a) => (c.length === 9 ? c.slice(0, 7) : c) + a;
const LOCAL = readTextFile(`${appHome()}/local.json`).then((t) => JSON.parse(t ?? "{}")).catch(() => ({}));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayOf = (iso) => new Date(`${iso}T12:00:00`);
const short = (n) => (n >= 1e6 ? (n * 1e-6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n * 1e-3) + "k" : String(n));
const sum = (a) => a.reduce((x, y) => x + y, 0);

// [ and ] step through the Home dashboards, ? shows every key.
function homeKeys(key) {
  if (key === "[") { run("my-agents.home:prev"); return true; }
  if (key === "]") { run("my-agents.home:next"); return true; }
  if (key === "?") { openOverlay({ mod: "keys-help", kind: "dialog", width: 760, height: 0.86, props: { context: "stats" } }); return true; }
  return false;
}

export default class Stats extends View {
  init(_props, cx) {
    this.data = null;
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "focus") this.handle.focus(); cx.notify(); } });
    this.load(cx);
    cx.timer.every(600000, (cx) => this.load(cx));
  }

  load(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const local = await LOCAL;
        const dirs = ["~/dotfiles", "~/.claude/mods", ...(local.worktreeRepos ?? []).map((r) => r.dir)];
        const r = await exec("python3", ["-I", `${appHome()}/mods/stats/collect.py`, JSON.stringify(dirs)]);
        if (r.code === 0) { this.data = JSON.parse(r.stdout); this.error = null; } else this.error = r.stderr.trim().split("\n").pop();
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      cx.notify();
    });
  }

  onKey(e, cx) {
    const m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt) return;
    const key = e.key_char ?? e.key;
    if (homeKeys(key)) { cx.stop_propagation(); return; }
    if (key === "R") { cx.stop_propagation(); this.load(cx); cx.notify(); }
  }

  render(cx) {
    const t = theme();
    const d = this.data;
    const ink = t.accent ?? t.ansi4;
    const label = (text) => div().text_size(11).font_semibold().text_color(t.dim).child(text);
    const small = (text, color) => div().text_size(11.5).text_color(color ?? t.dim).child(text);
    const card = (id) => v_flex().id(id).flex_1().min_w(0).p(16).gap(12).rounded(12).border_1().border_color(t.border).bg(t.raised);

    // A column chart: one bar per value, rounded at the top, a 2px gap, a tooltip on each;
    // the peak named above it, a few x labels under it.
    const columns = (id, values, names, tip, height = 120) => {
      const max = Math.max(1, ...values);
      const peak = values.indexOf(Math.max(...values));
      return v_flex().gap(6)
        .child(h_flex().id(id).h(height).items_end().gap(2)
          .children(values.map((v, i) => div().id(`${id}-${i}`).flex_1().h_full().flex().flex_col().justify_end().cursor_pointer()
            .tooltip(tip(v, i))
            .child(div().w_full().h(Math.max(v ? 3 : 1, Math.round((height - 4) * v / max))).rounded(3)
              .bg(v ? (i === peak ? ink : alpha(ink, "99")) : alpha(t.foreground, "14"))))))
        .child(h_flex().gap(2).children(names.map((n) => div().flex_1().text_size(10).text_color(t.dim).text_center().child(n))));
    };
    // A ranked list as horizontal bars, the name and count beside each.
    const ranked = (id, rows) => {
      const max = Math.max(1, ...rows.map(([, n]) => n));
      return v_flex().id(id).gap(8).children(rows.map(([name, n], i) => v_flex().gap(4)
        .child(h_flex().text_size(12).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(name)).child(div().text_color(t.muted).child(String(n))))
        .child(div().h(6).w_full().rounded(3).bg(alpha(t.foreground, "10")).child(div().h_full().rounded(3).bg(i === 0 ? ink : alpha(ink, "99")).w(`${Math.max(2, Math.round(100 * n / max))}%`)))));
    };

    const header = h_flex().gap(12).items_end()
      .child(v_flex().flex_1().gap(3)
        .child(div().text_size(24).font_semibold().text_color(t.foreground).child("Stats"))
        .child(small(`Last 14 days${d?.at ? ` · updated ${Math.max(0, Math.round((Date.now() - d.at * 1000) / 60000))} min ago` : ""}`)))
      .when(Boolean(this.error), (e) => e.child(small(this.error, t.ansi1)))
      .child(h_flex().gap(12).text_size(11).text_color(t.dim)
        .children([["R", "refresh"], ["[ ]", "dashboards"], ["?", "all keys"]].map(([k, w]) =>
          h_flex().gap(5).child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(w)))));

    let page = v_flex().w_full().max_w(1240).mx_auto().px(28).py(24).gap(20).child(header);
    if (!d) {
      const ghost = (h) => div().flex_1().h(h).rounded(12).border_1().border_color(alpha(t.foreground, "0d")).bg(alpha(t.foreground, "04"));
      page = page.child(h_flex().gap(12).child(ghost(96)).child(ghost(96)).child(ghost(96)).child(ghost(96)))
        .child(h_flex().gap(12).child(ghost(200)).child(ghost(200)))
        .child(h_flex().gap(12).child(ghost(200)).child(ghost(200)));
    } else {
      const names = d.days.map((iso, i) => (i % 2 === d.days.length % 2 ? "" : DOW[dayOf(iso).getDay()].slice(0, 2)));
      const when = (i) => { const x = dayOf(d.days[i]); return `${DOW[x.getDay()]} ${x.getDate()} ${MON[x.getMonth()]}`; };
      const week = (a) => sum(a.slice(-7)), last = (a) => sum(a.slice(0, 7));
      const delta = (a) => {
        const now = week(a), was = last(a);
        if (!was) return "";
        const p = Math.round(100 * (now - was) / was);
        return `${p >= 0 ? "+" : ""}${p}% vs the week before`;
      };
      const hero = (title, value, sub) => card(`st-h-${title}`).gap(4)
        .child(label(title)).child(div().text_size(26).font_semibold().text_color(t.foreground).child(value)).child(small(sub || " "));
      const active = d.prompts.slice(-7).filter((n) => n > 0).length;
      page = page
        .child(h_flex().gap(12)
          .child(hero("PROMPTS THIS WEEK", String(week(d.prompts)), delta(d.prompts)))
          .child(hero("OUTPUT TOKENS", short(week(d.tokens)), delta(d.tokens)))
          .child(hero("COMMITS THIS WEEK", String(week(d.commits)), delta(d.commits)))
          .child(hero("ACTIVE DAYS", `${active} / 7`, `${Math.max(...d.sessions.slice(-7))} sessions on the busiest`)))
        .child(h_flex().gap(12).items_start()
          .child(card("st-prompts").child(label("PROMPTS PER DAY")).child(columns("c-p", d.prompts, names, (v, i) => `${when(i)}: ${v} prompts`)))
          .child(card("st-commits").child(label("COMMITS PER DAY")).child(columns("c-c", d.commits, names, (v, i) => `${when(i)}: ${v} commits`))))
        .child(h_flex().gap(12).items_start()
          .child(card("st-tokens").child(label("OUTPUT TOKENS PER DAY")).child(columns("c-t", d.tokens, names, (v, i) => `${when(i)}: ${short(v)} tokens`)))
          .child(card("st-hours").child(label("PROMPTS BY HOUR · 14 DAYS")).child(columns("c-h", d.hours, d.hours.map((_, h) => (h % 6 === 0 ? `${h}h` : "")), (v, h) => `${h}:00–${h + 1}:00: ${v} prompts`))))
        .child(h_flex().gap(12).items_start()
          .child(card("st-proj").child(label("PROMPTS BY PROJECT · 14 DAYS")).child(ranked("r-p", d.projects)))
          .child(card("st-repo").child(label("COMMITS BY REPO · 14 DAYS")).child(d.repos.length ? ranked("r-r", d.repos) : small("No commits."))));
    }
    return v_flex().id("st-root").size_full().track_focus(this.handle).bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .child(div().id("st-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(page));
  }
}
