// Aside (cmd-shift-a, or Ask under the steps pane): ask about a Claude session without
// touching it. A question goes to a separate, read-only `claude -p` (it may Read, Grep and
// Glob in the session's folder) with the end of the session's conversation as context; the
// session itself never sees it, so its context stays as it was. Each session's questions and
// answers are kept in ~/.claude/state/aside/<session id>.json and come back when it opens.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, TextView } from "gpui-base";
import { exec, hc, home, appHome, props, theme, panes, focused, agents, readTextFile, writeTextFile, closeOverlay } from "herdr";

// The end of a transcript as plain lines: what you asked, what Claude said, the tools it ran.
const CONTEXT = String.raw`
import json, sys
path, limit = sys.argv[1], int(sys.argv[2])
with open(path, "rb") as f:
    f.seek(0, 2); size = f.tell(); f.seek(max(0, size - 3000000))
    lines = f.read().decode("utf-8", "replace").split("\n")[1:]
out = []
for l in lines:
    try: r = json.loads(l)
    except Exception: continue
    if r.get("isSidechain") or r.get("isMeta"): continue
    c = (r.get("message") or {}).get("content")
    if r.get("type") == "user":
        if isinstance(c, list):
            if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c): continue
            c = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
        t = (c or "").strip()
        if t and not t.startswith("<"): out.append("USER: " + t[:2000])
    elif r.get("type") == "assistant" and isinstance(c, list):
        for b in c:
            if not isinstance(b, dict): continue
            if b.get("type") == "text" and b.get("text", "").strip(): out.append("CLAUDE: " + b["text"].strip()[:3000])
            elif b.get("type") == "tool_use":
                i = b.get("input") or {}
                what = i.get("description") or i.get("file_path") or i.get("command") or i.get("pattern") or ""
                out.append("TOOL: %s %s" % (b.get("name"), str(what)[:160]))
text = "\n".join(out)
print(text[-limit:])
`;

const alpha = (c, a) => (c.length === 9 ? c.slice(0, 7) : c) + a;
const SUGGEST = ["What is it doing right now?", "Why did it choose this approach?", "What is left before it is done?", "Is anything risky in what it changed?"];
const clock = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const secs = (ms) => { const s = Math.max(0, Math.round(ms * 0.001)); return s < 60 ? `${s}s` : `${Math.floor(s * (1 / 60))}m ${s % 60}s`; };

export default class Aside extends View {
  init(_props, cx) {
    this.thread = [];
    this.busy = false;
    this.saved = null;
    this.st = { off: 0, view: 0, full: 0 };
    this.follow = true;
    this.input = InputState.new({ placeholder: "Ask about this session…" });
    this.input.on("submit", (_e, cx) => this.ask(cx));
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.focus();
    cx.timer.after(120, () => this.input.focus());
    // The clock on a question being answered.
    cx.timer.every(1000, (cx) => { if (this.busy) cx.notify(); });
    cx.spawn(async (cx) => { await this.loadHistory(); cx.notify(); });
    // Icons are read from Herdr's own icons folder (a linked mod folder's new files are not
    // seen until a restart): put this mod's copies there once.
    for (const n of ["message", "copy"]) exec("cp", ["-n", `${appHome()}/mods/aside/${n}.svg`, `${appHome()}/icons/aside-${n}.svg`]).catch(() => {});
  }

  // The session asked about: given, the focused Claude terminal, or the first agent.
  terminal() {
    if (props()?.terminal) return props().terminal;
    if (!this.chosen) {
      const f = focused();
      const here = panes().filter((p) => p.tab === f?.tab);
      this.chosen = (here.find((p) => p.pane === f?.pane && p.app === "claude-code") ?? here.find((p) => p.app === "claude-code"))?.terminal
        ?? agents().find((a) => a.app === "claude-code")?.address ?? null;
    }
    return this.chosen;
  }

  // Its Claude session: id, folder and transcript, found through the terminal's process.
  async session() {
    if (this.sess) return this.sess;
    const got = await hc(["get", this.terminal() ?? "", "--json"]);
    let pid = got.code === 0 ? JSON.parse(got.stdout)?.foreground?.pid : null;
    // While Claude runs a tool the foreground is that tool: walk up to Claude itself.
    for (let i = 0; i < 6 && pid; i++) {
      const s = JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`)) ?? "null");
      if (s?.sessionId) {
        this.sess = { id: s.sessionId, cwd: s.cwd, file: `${home()}/.claude/projects/${s.cwd.replace(/[^A-Za-z0-9]/g, "-")}/${s.sessionId}.jsonl` };
        return this.sess;
      }
      const up = await exec("ps", ["-o", "ppid=", "-p", String(pid)]);
      pid = Number(up.stdout.trim()) || null;
      if (pid <= 1) break;
    }
    throw new Error("No Claude session found for this terminal.");
  }

  historyPath() { return `${home()}/.claude/state/aside/${this.sess.id}.json`; }

  async loadHistory() {
    try {
      await this.session();
      const text = await readTextFile(this.historyPath());
      this.saved = text;
      const got = JSON.parse(text ?? "null");
      if (Array.isArray(got?.thread)) this.thread = got.thread.filter((x) => x.a != null);
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
  }

  async save() {
    if (!this.sess) return;
    const text = JSON.stringify({ session: this.sess.id, thread: this.thread.filter((x) => x.a != null).slice(-60) });
    try {
      await exec("mkdir", ["-p", `${home()}/.claude/state/aside`]);
      try { await writeTextFile(this.historyPath(), text, this.saved); }
      catch { await writeTextFile(this.historyPath(), text, await readTextFile(this.historyPath())); }
      this.saved = text;
    } catch {}
  }

  clear(cx) {
    if (this.busy) return;
    this.thread = [];
    this.st.off = 0;
    this.save();
    cx.notify();
  }

  copy(text, key, cx) {
    exec("zsh", ["-c", 'printf %s "$1" | LANG=en_US.UTF-8 pbcopy', "zsh", text]).catch(() => {});
    this.copied = key;
    cx.timer.after(1500, (cx) => { if (this.copied === key) { this.copied = null; cx.notify(); } });
  }

  ask(cx, given) {
    const q = (given ?? this.input.value()).trim();
    if (!q || this.busy) return;
    this.input.set_value("");
    const item = { q, a: null, at: Date.now() };
    this.thread.push(item);
    this.busy = true;
    this.follow = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const s = await this.session();
        const ctx = await exec("python3", ["-I", "-c", CONTEXT, s.file, "60000"]);
        const before = this.thread.slice(0, -1).slice(-6).map((x) => `Earlier aside question: ${x.q}\nYour answer: ${x.a ?? ""}`).join("\n\n");
        const prompt = [
          "You answer side questions about another Claude Code session, without touching it.",
          "You may read files in its folder (Read, Grep, Glob) but change nothing. Answer briefly, in the language of the question. No em dashes.",
          "", "The session's recent conversation:", "<session>", ctx.stdout, "</session>",
          before ? `\n${before}` : "", "", `Question: ${q}`,
        ].join("\n");
        // The GUI's PATH may not hold ~/.local/bin: try that copy first.
        const bin = (await exec("test", ["-x", `${home()}/.local/bin/claude`])).code === 0 ? `${home()}/.local/bin/claude` : "claude";
        const r = await exec(bin, ["-p", prompt, "--model", "sonnet", "--allowedTools", "Read,Grep,Glob", "--output-format", "text"], { cwd: s.cwd });
        if (r.code === 0) item.a = r.stdout.trim();
        else { item.a = (r.stderr || r.stdout).trim().split("\n").pop() || "claude -p failed"; item.failed = true; }
      } catch (e) {
        item.a = String(e?.message ?? e);
        item.failed = true;
      }
      item.took = Date.now() - item.at;
      this.busy = false;
      this.follow = true;
      await this.save();
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const ink = t.accent ?? t.ansi4;
    const st = this.st;
    const name = panes().find((p) => p.terminal === this.terminal())?.title?.replace(/^[^\p{L}\p{N}]+\s*/u, "") ?? "Claude";
    const max = Math.max(0, st.full - st.view);
    if (this.follow) st.off = max;
    st.off = Math.max(0, Math.min(st.off, max));
    const today = new Date().toDateString();
    const when = (ms) => (new Date(ms).toDateString() === today ? clock(ms) : `${new Date(ms).getDate()}.${new Date(ms).getMonth() + 1}. ${clock(ms)}`);
    const small = (text, color) => div().text_size(11).text_color(color ?? t.dim).child(text);

    // Top: what this is and which session it reads.
    const header = h_flex().flex_none().gap(12).items_center().px(18).h(56).border_b(1).border_color(t.border)
      .child(div().flex_none().size(30).rounded(15).flex().items_center().justify_center().bg(alpha(ink, "24"))
        .child(svg("icons/aside-message.svg").size(15).text_color(ink)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(14.5).font_semibold().child("Aside"))
        .child(h_flex().gap(6).items_center().min_w(0).text_size(11.5).text_color(t.dim)
          .child(div().flex_none().child("about"))
          .child(div().min_w(0).truncate().text_color(t.muted).child(name))
          .child(div().flex_none().child("· read-only, the session never sees this"))))
      .when(this.thread.length > 0 && !this.busy, (e) => e.child(h_flex().id("as-clear").px(8).h(24).items_center().rounded(6).cursor_pointer()
        .text_size(11.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Forget this session's questions")
        .on_click((_e, cx) => this.clear(cx))
        .child("Clear")))
      .child(h_flex().gap(5).items_center().text_size(11).text_color(t.dim)
        .child(div().px(4).rounded(3).bg(t.raised).text_color(t.muted).child("esc")).child(div().child("close")));

    // Empty: what it is for, and a few questions to start with.
    const empty = v_flex().items_center().gap(14).pt(56).px(24)
      .child(div().size(48).rounded(24).flex().items_center().justify_center().bg(alpha(ink, "1a"))
        .child(svg("icons/aside-message.svg").size(22).text_color(ink)))
      .child(div().text_size(15).font_semibold().child("Ask without interrupting"))
      .child(div().max_w(460).text_size(12.5).text_color(t.dim).text_center()
        .child("A separate Sonnet reads the end of this conversation and the files it touched. The session keeps working and its context stays clean."))
      .child(h_flex().flex_wrap().justify_center().gap(8).pt(6).max_w(560)
        .children(SUGGEST.map((s, i) => div().id(`as-sg-${i}`).px(12).h(30).flex().items_center().rounded(15).cursor_pointer()
          .border_1().border_color(t.border).bg(t.raised).text_size(12).text_color(t.muted)
          .hover((x) => x.border_color(alpha(ink, "80")).text_color(t.foreground))
          .on_click((_e, cx) => this.ask(cx, s))
          .child(s))));

    // One question and its answer.
    const turn = (x, i) => {
      const key = `a-${i}`;
      const done = this.copied === key;
      const q = h_flex().justify_end().child(v_flex().items_end().gap(3).max_w(520)
        .child(div().px(12).py(8).rounded(12).bg(alpha(ink, "1f")).border_1().border_color(alpha(ink, "3d")).text_size(13).child(x.q))
        .child(small(when(x.at))));
      const card = v_flex().gap(8).p(14).rounded(12).border_1()
        .border_color(x.failed ? alpha(t.ansi1, "59") : t.border).bg(x.failed ? alpha(t.ansi1, "0f") : t.raised);
      if (x.a == null) {
        return v_flex().id(`as-${i}`).gap(10).child(q).child(card
          .child(h_flex().gap(8).items_center()
            .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900))
            .child(div().text_size(12.5).text_color(t.working).child("Reading the session…"))
            .child(div().flex_1())
            .child(small(secs(Date.now() - x.at)))));
      }
      return v_flex().id(`as-${i}`).gap(10).child(q).child(card
        .child(h_flex().gap(8).items_center()
          .child(div().size(6).rounded(3).bg(x.failed ? t.ansi1 : ink))
          .child(div().text_size(11).font_semibold().text_color(x.failed ? t.ansi1 : t.muted).child(x.failed ? "FAILED" : "ASIDE"))
          .when(Boolean(x.took), (e) => e.child(small(secs(x.took))))
          .child(div().flex_1())
          .when(!x.failed, (e) => e.child(h_flex().id(`as-cp-${i}`).gap(5).px(7).h(22).items_center().rounded(6).cursor_pointer()
            .text_size(11).text_color(done ? t.ansi2 : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.copy(x.a, key, cx); cx.notify(); })
            .child(svg("icons/aside-copy.svg").size(11).text_color(done ? t.ansi2 : t.dim))
            .child(div().child(done ? "Copied" : "Copy")))))
        .child(div().text_size(13).text_color(t.foreground).child(TextView.markdown(`as-a-${i}`, x.a).selectable(true))));
    };

    const body = v_flex().px(18).py(16).gap(20)
      .when(Boolean(this.error) && !this.thread.length, (e) => e.child(small(this.error, t.ansi1)))
      .when(!this.thread.length, (e) => e.child(empty))
      .children(this.thread.map(turn));

    // The thread scrolls by offset (plain divs have no programmatic scroll) and keeps to the
    // newest answer unless you scroll up.
    const view = div().id("as-view").flex_1().min_h(0).relative().overflow_hidden()
      .on_size_change((size, cx) => { if (Math.abs(size.height - st.view) >= 1) { st.view = size.height; cx.notify(); } })
      .on_scroll_wheel((e, cx) => {
        st.off = Math.max(0, Math.min(st.off - (e.delta?.y ?? 0), Math.max(0, st.full - st.view)));
        this.follow = st.off >= Math.max(0, st.full - st.view) - 2;
        cx.stop_propagation(); cx.notify();
      })
      .child(div().absolute().left(0).w_full().top(-st.off)
        .on_size_change((size, cx) => { if (Math.abs(size.height - st.full) >= 1) { st.full = size.height; cx.notify(); } })
        .child(body));

    const canAsk = !this.busy && this.input.value().trim().length > 0;
    const composer = v_flex().flex_none().gap(6).px(14).pt(10).pb(10).border_t(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().pl(12).pr(5).h(40).rounded(10).border_1()
        .border_color(this.busy ? t.border : alpha(ink, "66")).bg(t.background)
        .child(Input.new(this.input).flex_1().text_size(13).text_color(t.foreground))
        .child(h_flex().id("as-send").flex_none().px(10).h(30).items_center().rounded(7).text_size(12).font_medium()
          .bg(canAsk ? ink : alpha(t.foreground, "0f")).text_color(canAsk ? t.background : t.dim)
          .when(canAsk, (s) => s.cursor_pointer())
          .on_click((_e, cx) => this.ask(cx))
          .child(this.busy ? "Answering…" : "Ask ↵")))
      .child(h_flex().gap(10).px(2).text_size(10.5).text_color(t.dim)
        .child(div().child("Sonnet · reads, never edits"))
        .child(div().flex_1())
        .when(this.thread.length > 0, (e) => e.child(div().child(`${this.thread.length} question${this.thread.length > 1 ? "s" : ""} kept for this session`))));

    return v_flex().id("as-root").size_full().bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); } })
      .child(header)
      .child(view)
      .child(composer);
  }
}
