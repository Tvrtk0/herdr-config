// News, the Home space's fifth tab: what is new in Claude Code (our own weekly "What's new",
// written by claude -p from the changelog, and the docs pages that appeared, each a new
// concept), then AI and tech headlines. Data: collect.py, every 30 minutes and on R; R twice
// asks for a new digest now. A new docs page posts a toast once. Items newer than your last
// visit carry a dot.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, run, openOverlay, nextCommand, notify, shared, setShared } from "herdr";

const alpha = (c, a) => (c.length === 9 ? c.slice(0, 7) : c) + a;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SEEN_KEY = "news.seenAt";
const TOASTED_KEY = "news.toastedAt";

// How long ago, in one short word.
function ago(sec) {
  if (!sec) return "";
  const m = Math.max(0, Math.round((Date.now() * 0.001 - sec) * (1 / 60)));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m * (1 / 60));
  if (h < 36) return `${h}h`;
  return `${Math.round(h * (1 / 24))}d`;
}
const dayOf = (sec) => { const d = new Date(sec * 1000); return `${d.getDate()} ${MON[d.getMonth()]}`; };
const open = (url) => { if (url) exec("open", [url]).catch(() => {}); };

// [ and ] step through the Home dashboards, ? shows every key.
function homeKeys(key) {
  if (key === "[") { run("my-agents.home:prev"); return true; }
  if (key === "]") { run("my-agents.home:next"); return true; }
  if (key === "?") { openOverlay({ mod: "keys-help", kind: "dialog", width: 760, height: 0.86, props: { context: "news" } }); return true; }
  return false;
}

export default class News extends View {
  init(_props, cx) {
    this.data = null;
    this.handle = cx.focus_handle();
    // What counts as new: newer than the visit before this one.
    this.seenAt = Number(shared(SEEN_KEY) ?? 0);
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "focus") { this.handle.focus(); this.visit(cx); } cx.notify(); } });
    this.load(cx);
    cx.timer.every(1800000, (cx) => this.load(cx));
    // While the digest is being written, look again sooner.
    cx.timer.every(20000, (cx) => { if (this.data?.curating) this.load(cx); });
  }

  // Marks everything as seen a little after you look, so the dots last this visit.
  visit(cx) {
    const at = Date.now() * 0.001;
    cx.timer.after(15000, () => setShared(SEEN_KEY, at));
  }

  load(cx, curate = false) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const args = ["-I", `${appHome()}/mods/news/collect.py`];
        if (curate) args.push("--curate");
        const r = await exec("python3", args);
        if (r.code === 0) {
          this.data = JSON.parse(r.stdout);
          this.error = null;
          this.toast();
        } else this.error = r.stderr.trim().split("\n").pop();
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      cx.notify();
    });
  }

  // One toast for docs pages that appeared since the last toast (renames stay quiet).
  toast() {
    const last = Number(shared(TOASTED_KEY) ?? 0);
    const fresh = (this.data?.concepts ?? []).filter((c) => !c.renamed && c.at > last);
    if (!fresh.length) return;
    setShared(TOASTED_KEY, Math.max(...fresh.map((c) => c.at)));
    notify({
      title: fresh.length > 1 ? `${fresh.length} new pages in the Claude Code docs` : `New in Claude Code: ${fresh[0].title}`,
      body: fresh.length > 1 ? fresh.map((c) => c.title).join(", ") : fresh[0].desc,
      level: "info", timeout: 12000,
      action: { name: "my-agents.home:news" },
    });
  }

  onKey(e, cx) {
    const m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt) return;
    const key = e.key_char ?? e.key;
    if (homeKeys(key)) { cx.stop_propagation(); return; }
    if (key === "R") {
      cx.stop_propagation();
      const twice = Date.now() - (this.lastR ?? 0) < 1500;
      this.lastR = twice ? 0 : Date.now();
      this.load(cx, twice);
      cx.notify();
    }
  }

  render(cx) {
    const t = theme();
    const d = this.data;
    const ink = t.accent ?? t.ansi4;
    const label = (text) => div().text_size(11).font_semibold().text_color(t.dim).child(text);
    const small = (text, color) => div().text_size(11.5).text_color(color ?? t.dim).child(text);
    const card = (id) => v_flex().id(id).flex_1().min_w(0).p(16).gap(12).rounded(12).border_1().border_color(t.border).bg(t.raised);
    const isNew = (sec) => Boolean(sec) && sec > this.seenAt && this.seenAt > 0;
    const dot = (on) => div().flex_none().size(6).mt(6).rounded(3).bg(on ? ink : "#00000000");

    const header = h_flex().gap(12).items_end()
      .child(v_flex().flex_1().gap(3)
        .child(div().text_size(24).font_semibold().text_color(t.foreground).child("News"))
        .child(small(d ? `Claude Code ${d.version ?? "?"}${d.versionAt ? ` · released ${dayOf(d.versionAt)}` : ""} · updated ${ago(d.at)} ago${this.busy ? " · refreshing" : ""}` : "Loading…")))
      .when(Boolean(this.error), (e) => e.child(small(this.error, t.ansi1)))
      .child(h_flex().gap(12).text_size(11).text_color(t.dim)
        .children([["R", "refresh"], ["[ ]", "dashboards"], ["?", "all keys"]].map(([k, w]) =>
          h_flex().gap(5).child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child(k)).child(div().child(w)))));

    let page = v_flex().w_full().max_w(1240).mx_auto().px(28).py(24).gap(20).child(header);
    if (!d) {
      const ghost = (h) => div().flex_1().h(h).rounded(12).border_1().border_color(alpha(t.foreground, "0d")).bg(alpha(t.foreground, "04"));
      page = page.child(h_flex().gap(12).child(ghost(96)).child(ghost(96)).child(ghost(96)).child(ghost(96)))
        .child(h_flex().gap(12).child(ghost(240)).child(ghost(240)))
        .child(h_flex().gap(12).child(ghost(320)).child(ghost(320)).child(ghost(320)));
      return this.frame(t, page);
    }

    const cur = d.curated;
    const concepts = d.concepts ?? [];
    const sec = d.sections ?? {};
    const freshConcepts = concepts.filter((c) => !c.renamed && Date.now() * 0.001 - c.at < 14 * 86400);
    const hero = (id, title, value, sub, color) => card(`nw-h-${id}`).gap(4)
      .child(label(title))
      .child(div().text_size(26).font_semibold().text_color(color ?? t.foreground).child(value))
      .child(small(sub || " "));
    const unread = ["claude", "ai", "tech"].reduce((n, k) => n + (sec[k] ?? []).filter((x) => isNew(x.at)).length, 0);
    page = page.child(h_flex().gap(12)
      .child(hero("wn", "WHAT'S NEW", d.curating ? "…" : String(cur?.items?.length ?? 0), d.curating ? "Writing a new digest" : cur ? `${cur.versions?.length ?? 0} releases since ${dayOf(cur.from)}` : "No digest yet"))
      .child(hero("cn", "NEW IN THE DOCS", String(freshConcepts.length), "pages in the last 14 days", freshConcepts.length ? ink : null))
      .child(hero("ai", "AI THIS WEEK", String((sec.ai ?? []).length), "headlines"))
      .child(hero("un", "SINCE YOUR LAST VISIT", String(unread), this.seenAt ? `last visit ${ago(this.seenAt)} ago` : "first visit")));

    // Our own weekly What's new: the headline large, the rest as rows; each opens its link.
    const wnRow = (x, i) => h_flex().id(`nw-wn-${i}`).gap(12).items_start().p(10).rounded(8).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => open(x.link)).tooltip(x.link)
      .child(div().flex_none().mt(1).w(58).h(18).flex().items_center().justify_center().rounded(5).bg(alpha(t.foreground, "10")).text_size(10.5).text_color(t.muted).child(x.version))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(13).font_medium().text_color(t.foreground).child(x.title))
        .child(div().text_size(12).text_color(t.muted).child(String(x.why ?? "").replace(/\x60/g, ""))));
    const head = cur?.items?.find((x) => x.headline) ?? cur?.items?.[0];
    const rest = (cur?.items ?? []).filter((x) => x !== head);
    let wn = card("nw-wn").flex_grow(3)
      .child(h_flex().gap(8).items_center()
        .child(label("WHAT'S NEW IN CLAUDE CODE"))
        .child(div().flex_1())
        .when(Boolean(d.curating), (e) => e.child(h_flex().gap(6).items_center()
          .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900))
          .child(small("Writing", t.working)))));
    if (head) {
      wn = wn.child(v_flex().id("nw-head").gap(6).p(14).rounded(10).cursor_pointer().bg(alpha(ink, "12")).border_1().border_color(alpha(ink, "40"))
        .hover((s) => s.bg(alpha(ink, "1c"))).on_click(() => open(head.link)).tooltip(head.link)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(10.5).font_semibold().text_color(ink).child("HEADLINE"))
          .child(div().text_size(10.5).text_color(t.dim).child(head.version)))
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child(head.title))
        .child(div().text_size(12.5).text_color(t.muted).child(String(head.why ?? "").replace(/\x60/g, ""))))
        .children(rest.map(wnRow));
    } else {
      wn = wn.child(small(cur ? "Nothing new enough to mention since the last digest." : d.curating ? "Reading the changelog…" : "No digest yet. Press R twice to write one."));
    }
    if (cur) wn = wn.child(small(`From ${cur.versions?.at(-1) ?? "?"} to ${cur.versions?.[0] ?? "?"} · written by Sonnet ${ago(cur.at)} ago · R R writes a new one`));

    // Docs pages that appeared: a new page is a new concept; renames stay quiet.
    const docs = card("nw-docs").flex_grow(2)
      .child(label("NEW IN THE DOCS"))
      .when(!concepts.length, (e) => e.child(small("No new pages yet. The page list is watched from today; a new page shows up here and as a toast.")))
      .children(concepts.slice(0, 8).map((c, i) => h_flex().id(`nw-c-${i}`).gap(10).items_start().p(8).rounded(8).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => open(c.link)).tooltip(c.link)
        .child(dot(isNew(c.at) && !c.renamed))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(13).font_medium().text_color(c.renamed ? t.muted : t.foreground).child(c.title))
            .when(Boolean(c.renamed), (e) => e.child(div().px(5).h(16).flex().items_center().rounded(4).bg(alpha(t.foreground, "10")).text_size(10).text_color(t.dim).child("renamed"))))
          .when(Boolean(c.desc), (e) => e.child(div().text_size(12).text_color(t.muted).child(c.desc)))
          .child(small(`${c.group ? `${c.group} · ` : ""}${dayOf(c.at)}`)))));
    page = page.child(h_flex().gap(12).items_start().child(wn).child(docs));

    // Headlines: one column a section, newest first.
    const row = (x, i, id) => h_flex().id(`nw-${id}-${i}`).gap(8).items_start().px(8).py(7).rounded(8).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => open(x.link)).tooltip(x.summary || x.link)
      .child(dot(isNew(x.at)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_start()
          .when(Boolean(x.risk), (e) => e.child(div().flex_none().text_size(12.5).text_color(t.blocked).child("⚠")))
          .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(x.title)))
        .child(h_flex().gap(6).text_size(11).text_color(t.dim)
          .child(div().child(x.source))
          .when(Boolean(x.at), (e) => e.child(div().child(`· ${ago(x.at)}`)))
          .when(x.points != null, (e) => e.child(div().child(`· ${x.points} points`)))));
    const column = (id, title, list, most) => card(`nw-col-${id}`)
      .child(h_flex().child(label(title)).child(div().flex_1()).child(small(String(list.length))))
      .when(!list.length, (e) => e.child(small("Nothing right now.")))
      .children(list.slice(0, most).map((x, i) => row(x, i, id)));
    page = page.child(h_flex().gap(12).items_start()
      .child(column("claude", "CLAUDE & ANTHROPIC", sec.claude ?? [], 10))
      .child(column("ai", "AI · 7 DAYS", sec.ai ?? [], 10))
      .child(column("tech", "TECH · 2 DAYS", sec.tech ?? [], 10)));

    // Every source with its state: a quiet failure is worse than a loud one.
    const bad = (d.sources ?? []).filter((s) => !s.ok);
    page = page.child(h_flex().flex_wrap().gap(6).items_center()
      .child(small(bad.length ? `Sources: ${bad.length} failing` : `Sources: all ${(d.sources ?? []).length} ok`, bad.length ? t.blocked : t.dim))
      .children((d.sources ?? []).map((s) => h_flex().id(`nw-src-${s.id}`).gap(5).items_center().px(7).h(20).rounded(10)
        .bg(alpha(s.ok ? t.foreground : t.ansi1, s.ok ? "0a" : "1f"))
        .tooltip(s.ok ? `${s.count} items` : s.error ?? "failed")
        .child(div().size(6).rounded(3).bg(s.ok ? t.ansi2 : t.ansi1))
        .child(div().text_size(10.5).text_color(s.ok ? t.dim : t.ansi1).child(s.name)))));
    return this.frame(t, page);
  }

  frame(t, page) {
    return v_flex().id("nw-root").size_full().track_focus(this.handle).bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .child(div().id("nw-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(page));
  }
}
