import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  closeOverlay,
  exec,
  home,
  layout,
  notify,
  openOverlay,
  props,
  readTextFile,
  run,
  setShared,
  shared,
  theme,
} from "herdr";
import { alertMessage, fmtDuration, itemKey, step } from "./alerts.js";

const STATE_KEY = "status-quota.alert-state";

// "約 2h 10m 後用盡" when, at the recent pace, a window runs out before it resets.
const etaText = (p, it) => {
  if (p.stale) return "";
  const e = shared("status-quota.eta")?.[itemKey(p, it)];
  return e ? `Estimated ${fmtDuration(e.ms)} remaining` : "";
};

const scriptPath = () => `${home()}/.config/herdr-app/mods/status-quota/fetch-quota.py`;
const POLL_MS = 120_000;
const CLAUDE_WATCH_MS = 5_000;

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function pctColor(t, rem) {
  if (rem == null) return t.dim;
  if (rem <= 10) return t.blocked ?? t.ansi1 ?? t.foreground;
  if (rem <= 30) return t.warning ?? t.ansi3 ?? t.foreground;
  return t.foreground;
}

function barColor(t, rem) {
  if (rem == null) return t.dim;
  if (rem <= 10) return t.blocked ?? t.ansi1 ?? t.accent;
  if (rem <= 30) return t.warning ?? t.ansi3 ?? t.accent;
  return t.accent;
}

function sidebarItems(provider) {
  const items = provider.items ?? [];
  if (!provider.id?.startsWith("agy")) return items;
  // For Gemini in sidebar: show 5h, 7d, Argon (skip C/G if 100% to keep sidebar clean, or show if <100%)
  const out = items.filter((x) => x.label === "5h" || x.label === "7d" || x.label === "Argon");
  const cg = items.filter((x) => x.label.startsWith("C/G") && x.remaining < 100);
  if (cg.length) out.push(cg[0]);
  return out;
}

function parseProviderHeader(p) {
  if (p.id?.startsWith("agy-")) {
    return { title: "Gemini", badge: p.id.slice(4) };
  }
  const m = /^([^(]+)\(([^)]+)\)$/.exec(p.name || "");
  if (m) return { title: m[1].trim(), badge: m[2].trim() };
  return { title: p.name, badge: p.account || "" };
}
function providerIconEl(p, size) {
  if (p.id === "claude") {
    return image("icons/claude.svg").size(size).flex_none();
  }
  if (p.id === "codex") {
    return image("icons/codex.svg").size(size).flex_none();
  }
  if (p.id?.startsWith("agy")) {
    return svg("icons/gemini.svg").size(size).flex_none().text_color("#8e75b2");
  }
  return image(p.icon).size(size).flex_none();
}

export default class StatusQuota extends View {
  init(_props, cx) {
    this.loading = false;
    this.folded = localStorage.getItem("status-quota.folded") === "1";
    this.lastAutoKey = "";
    this.handle = cx.focus_handle();
    if (props()?.overlay) {
      this.handle.focus();
      cx.timer.after(30, () => this.handle.focus());
      if (!shared("status-quota.data")) this.refresh(false, cx);
      return;
    }
    this.lastClaudeObservation = null;
    this.refresh(false, cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(false, cx));
    // Status-line payloads are shared by Claude sessions and can be replaced
    // before the normal quota poll sees them. This reads locally; it makes no
    // request unless a new valid quota observation appears.
    cx.timer.every(CLAUDE_WATCH_MS, (cx) => this.observeClaudeStatusline(cx));
  }

  observeClaudeStatusline(cx) {
    if (this.checkingClaudeStatusline) return;
    this.checkingClaudeStatusline = true;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(`${home()}/.claude/.statusline.input`);
        const data = raw ? JSON.parse(raw) : null;
        const rates = data?.rate_limits;
        const windows = [rates?.five_hour, rates?.seven_day].filter((w) =>
          typeof w?.used_percentage === "number" && Number.isFinite(w.used_percentage) &&
          w.used_percentage >= 0 && w.used_percentage <= 100 &&
          typeof w.resets_at === "number" && Number.isFinite(w.resets_at) && w.resets_at * 1000 > Date.now());
        if (!windows.length) {
          this.lastClaudeObservation = null;
        } else {
          // Only observation metadata is retained in memory; never store the input body.
          const signature = JSON.stringify([windows, data.session_id, data.context_window?.total_input_tokens, data.context_window?.total_output_tokens]);
          if (signature !== this.lastClaudeObservation && !this.loading && await this.refresh(false, cx)) {
            this.lastClaudeObservation = signature;
          }
        }
      } catch { this.lastClaudeObservation = null; }
      this.checkingClaudeStatusline = false;
    });
  }

  syncHeight(count) {
    const key = `${this.folded ? 1 : 0}:${count}`;
    if (key === this.lastAutoKey) return;
    this.lastAutoKey = key;
    const n = Math.max(1, count);
    const px = this.folded ? 28 : 36 + n * 52 + (n - 1) * 3;
    run("layout.resize", { id: "quota", px });
  }

  // The helper asks Codex for live limits and respects Claude's retry cooldown.
  async refresh(force, cx) {
    if (this.loading) return false;
    let succeeded = false;
    this.loading = true;
    setShared("status-quota.loading", true);
    cx.notify();
    try {
      const args = force ? [scriptPath(), "--force"] : [scriptPath()];
      const r = await exec("python3", args);
      if (r.code === 0 && r.stdout.trim()) {
        const data = JSON.parse(r.stdout);
        setShared("status-quota.data", data);
        succeeded = true;
        if (!props()?.overlay) {
          try { this.checkAlerts(data); }
          catch (e) { notify({ title: "Quota alert failed", body: String(e?.message ?? e), level: "error" }); }
        }
      }
    } catch {}
    this.loading = false;
    setShared("status-quota.loading", false);
    cx.notify();
    return succeeded;
  }

  // Notify when a window newly crosses the low / critical threshold, and update the run-out estimates.
  checkAlerts(data) {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null"); } catch {}
    const { state: next, alerts, eta } = step((data?.providers ?? []).filter((p) => !p.stale), state, Date.now());
    localStorage.setItem(STATE_KEY, JSON.stringify(next));
    setShared("status-quota.eta", eta);
    if (alerts.length) {
      const m = alertMessage(alerts, (p) => parseProviderHeader(p).title + (p.id?.startsWith("agy-") ? ` ${p.id.slice(4)}` : ""));
      notify({ ...m, timeout: 10000 });
    }
  }

  openDetailPopup() {
    openOverlay({
      mod: "status-quota",
      kind: "popup",
      width: 480,
      height: 540,
    });
  }

  renderPopup(t) {
    const data = shared("status-quota.data");
    const loading = shared("status-quota.loading");
    const providers = data?.providers ?? [];

    return v_flex()
      .id("status-quota-popup")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" || e.key === "q") {
          cx.stop_propagation();
          closeOverlay(props()?.overlay);
        } else if (e.key === "r") {
          cx.stop_propagation();
          this.refresh(true, cx);
        }
      })
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().text_size(14).font_semibold().child("AI usage and reset times"))
              .when(Boolean(data?.updatedText), (el) =>
                el.child(div().text_size(11).text_color(t.dim).child(`Updated ${data.updatedText}`))
              )
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .id("quota-refresh-btn")
                  .px(8)
                  .py(3)
                  .rounded(5)
                  .bg(t.surface)
                  .text_size(11)
                  .text_color(loading ? t.dim : t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.refresh(true, cx))
                  .child(loading ? "Updating…" : "↻ Refresh (r)")
              )
              .child(
                div()
                  .id("quota-close-btn")
                  .px(6)
                  .py(3)
                  .rounded(5)
                  .text_size(11)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click(() => closeOverlay(props()?.overlay))
                  .child("Esc closes")
              )
          )
      )
      .child(
        v_flex()
          .h(470)
          .gap(8)
          .overflow_y_scrollbar()
          .children(
            providers.map((p) =>
              v_flex()
                .p(10)
                .gap(6)
                .rounded(8)
                .border_1()
                .border_color(t.border)
                .bg(t.surface)
                .child(
                  h_flex()
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .gap(7)
                        .items_center()
                        .child(providerIconEl(p, 15))
                        .child(div().font_semibold().text_size(12.5).child(p.name))
                        .when(Boolean(p.account), (el) =>
                          el.child(div().text_size(11).text_color(t.dim).child(p.account))
                        )
                    )
                    .when(Boolean(p.error), (el) =>
                      el.child(div().text_size(11).text_color(t.warning ?? t.working).child(p.error))
                    )
                )
                .when(Boolean((p.items ?? []).length), (el) =>
                  el.child(
                    v_flex()
                      .gap(5)
                      .children(
                        (p.items ?? []).map((it) => {
                          const barW = Math.max(2, Math.round(1.3 * it.remaining));
                          const color = pctColor(t, it.remaining);
                          return h_flex()
                            .items_center()
                            .gap(8)
                            .child(
                              div()
                                .w(115)
                                .truncate()
                                .text_size(11)
                                .text_color(t.muted)
                                .child(it.fullLabel || it.label)
                            )
                            .child(
                              h_flex()
                                .w(130)
                                .h(6)
                                .rounded(3)
                                .bg(t.background)
                                .overflow_hidden()
                                .child(div().h_full().w(barW).rounded(3).bg(barColor(t, it.remaining)))
                            )
                            .child(
                              div()
                                .w(54)
                                .text_size(11)
                                .text_color(color)
                                .font_semibold()
                                .child(`${it.remaining}% remaining`)
                            )
                            .child(
                              div()
                                .flex_1()
                                .truncate()
                                .text_size(10.5)
                                .text_color(t.dim)
                                .child([it.resetText ?? "", etaText(p, it)].filter(Boolean).join(" · "))
                            );
                        })
                      )
                  )
                )
            )
          )
      );
  }

  renderSidebarRow(p, t) {
    const items = sidebarItems(p);
    const { title, badge } = parseProviderHeader(p);
    const tip =
      (p.items ?? [])
        .map((it) => `${it.fullLabel || it.label}: ${it.remaining}% remaining (${it.resetText || ""})${etaText(p, it) ? ` · ${etaText(p, it)}` : ""}`)
        .join("  |  ") ||
      p.error ||
      p.name;

    return v_flex()
      .id(`quota-side-${p.id}`)
      .px(8)
      .py(5)
      .gap(4)
      .rounded(7)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(`${p.name}${p.account ? ` (${p.account})` : ""} — ${tip}\nClick for detailed reset times`)
      .on_click(() => this.openDetailPopup())
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(providerIconEl(p, 13))
              .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(title))
          )
          .when(Boolean(badge), (el) =>
            el.child(div().truncate().text_size(10.5).text_color(t.dim).child(badge))
          )
      )
      .when(Boolean(p.error && !items.length), (el) =>
        el.child(div().text_size(10.5).text_color(t.warning ?? t.working).child(p.error))
      )
      .when(items.length > 0, (el) =>
        el.child(
          h_flex()
            .gap(8)
            .items_center()
            .children(
              items.map((it) => {
                const segTotal = Math.floor(216 / items.length);
                const fillW = Math.max(2, Math.round((segTotal * it.remaining) / 100));
                return v_flex()
                  .flex_1()
                  .gap(2)
                  .child(
                    h_flex()
                      .items_center()
                      .justify_between()
                      .child(div().text_size(10).text_color(t.dim).child(it.label))
                      .child(
                        div()
                          .text_size(10.5)
                          .font_semibold()
                          .text_color(pctColor(t, it.remaining))
                          .child(`${it.remaining}%`)
                      )
                  )
                  .child(
                    h_flex()
                      .w_full()
                      .h(3.5)
                      .rounded(2)
                      .bg(t.surface)
                      .overflow_hidden()
                      .child(div().h_full().w(fillW).rounded(2).bg(barColor(t, it.remaining)))
                  );
              })
            )
        )
      );
  }

  render() {
    const t = theme();
    if (props()?.overlay) return this.renderPopup(t);

    const collapsed = narrow();
    const data = shared("status-quota.data");
    const loading = shared("status-quota.loading");
    const providers = data?.providers ?? [];

    if (collapsed) {
      const worst = providers
        .flatMap((p) => p.items ?? [])
        .reduce((min, it) => (it.remaining < min ? it.remaining : min), 100);
      return v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .bg(t.chrome)
        .cursor_pointer()
        .on_click(() => this.openDetailPopup())
        .child(div().text_size(10.5).font_semibold().text_color(pctColor(t, worst)).child(`${worst}%`));
    }

    if (providers.length > 0 || this.folded) {
      this.syncHeight(providers.length);
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(12)
      .child(
        h_flex()
          .id("sidebar-quota-header")
          .h(28)
          .flex_none()
          .pl(12)
          .pr(10)
          .items_center()
          .justify_between()
          .text_size(11)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.folded = !this.folded;
            localStorage.setItem("status-quota.folded", this.folded ? "1" : "0");
            this.syncHeight(providers.length);
            cx.notify();
          })
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                svg(`mods/workspace-chrome/chevron-${this.folded ? "right" : "down"}.svg`).size(11).flex_none()
              )
              .child("Quotas")
              .when(Boolean(data?.updatedText), (el) =>
                el.child(div().text_size(10).text_color(t.dim).child(data.updatedText))
              )
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                div()
                  .id("sidebar-quota-refresh")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .cursor_pointer()
                  .tooltip("Refresh quota now")
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.refresh(true, cx);
                  })
                  .child(loading ? "…" : "↻")
              )
              .child(
                div()
                  .id("sidebar-quota-expand")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .cursor_pointer()
                  .tooltip("Open detailed reset times")
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.openDetailPopup();
                  })
                  .child("⤢")
              )
          )
      )
      .when(!this.folded, (el) =>
        el.child(
          v_flex()
            .flex_1()
            .min_h(0)
            .px(6)
            .pb(6)
            .gap(3)
            .overflow_y_scrollbar()
            .children(
              providers.length
                ? providers.map((p) => this.renderSidebarRow(p, t))
                : [
                    div()
                      .px(10)
                      .py(6)
                      .text_size(11)
                      .text_color(t.dim)
                      .child(loading ? "Loading quota…" : "No quota data"),
                  ]
            )
        )
      );
  }
}
