import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, exec, run, openOverlay, closeOverlay, props, window, keys, shared, setShared } from "herdr";

// The last agents each machine reported, shown at once while knownAgents() checks again.
const KNOWN = "new-menu.agents";
const CUSTOM = [
  { key: "openclaw", name: "OpenClaw", icon: "mods/agents-plus/openclaw.png", argv: ["bash", "-lic", 'cd "$HOME/.openclaw" && openclaw; exec bash -i'] },
  { key: "omp", name: "Oh My Pi", icon: "mods/new-menu-plus/oh-my-pi.png", argv: ["omp"] },
  { key: "hermes", name: "Hermes Agent", icon: "mods/new-menu-plus/hermes.svg", tint: true, argv: ["hermes"] },
];

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(_props, cx) {
    const machine = spaces().find(s => s.active)?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.custom = {};
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async cx => {
      await Promise.all(CUSTOM.map(async (a) => {
        try {
          const r = await exec("bash", ["-lic", 'command -v -- "$1" >/dev/null 2>&1', "check", a.key], { on: machine ?? null, timeout: 8000 });
          this.custom[a.key] = r.code === 0 ? "installed" : r.code === 1 ? "missing" : "unknown";
        } catch { this.custom[a.key] = "unknown"; }
        cx.notify();
      }));
    });
    cx.spawn(async cx => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }
  row(id, icon, name, action, hint = "", enabled = true) {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.hover(s => s.bg(t.selected)))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
  }
  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const installed = this.agents.filter(a => a.installed);
    // Preserve the built-in shortcuts, including holes while a duplicate custom
    // agent is unavailable. Assign new custom agents the next free numbers.
    const customKey = (a) => CUSTOM.find(c => a.run?.[0] === c.key)?.key;
    const shortcuts = installed.map((a) => {
      const custom = CUSTOM.find((c) => c.key === customKey(a));
      return custom ? (this.custom[custom.key] === "installed" ? { custom } : null) : { agent: a };
    });
    for (const a of CUSTOM) {
      if (this.custom[a.key] === "installed" && !installed.some((item) => customKey(item) === a.key)) shortcuts.push({ custom: a });
    }
    const choices = (this.failed ? installed : [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)]).filter(a => !customKey(a));
    // OpenClaw shares the sidebar's reuse-first launcher; the plus menu still
    // creates a new tab for Oh My Pi and the other agents.
    const start = (a) => a.key === "openclaw"
      ? run("agents-plus.openclaw")
      : run("tab.new", { name: a.name, space: space?.id, argv: a.argv });
    return v_flex().min_h(0).w_full().h(Math.min(491, 167 + Math.max(1, choices.length + CUSTOM.length + (this.failed ? 1 : 0)) * 31)).bg(t.popover).p(5).text_size(12.8)
      .id("new-menu").track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const choice = /^[1-9]$/.test(e.key) ? shortcuts[Number(e.key) - 1] : null;
        if (!choice) return;
        closeOverlay(props().overlay);
        if (choice.custom) start(choice.custom);
        else run("tab.new", { name: choice.agent.name, space: space?.id, argv: choice.agent.run });
      })
      .child(this.row("terminal", svg("icons/shell.svg").size(14), "Terminal", () => run("tab.new", { space: space?.id }), shortcut("tab.new")))
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(shortcuts.flatMap((choice, i) => {
          if (!choice) return [];
          if (choice.custom) {
            const a = choice.custom;
            const pic = a.tint ? svg(a.icon).size(16).text_color(t.foreground) : image(a.icon).size(16);
            return [this.row(`custom-${a.key}`, pic, a.name, () => start(a), i < 9 ? String(i + 1) : "")];
          }
          const a = choice.agent;
          return [this.row(a.key, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
            () => run("tab.new", { name: a.name, space: space?.id, argv: a.run }), i < 9 ? String(i + 1) : "")];
        }))
        .children(CUSTOM.filter((a) => this.custom[a.key] !== "installed").map((a) => {
          const state = this.custom[a.key];
          const hint = state === "missing" ? "not installed" : state === "unknown" ? "unavailable" : "checking…";
          const pic = a.tint ? svg(a.icon).size(16).text_color(t.dim) : image(a.icon).size(16);
          return this.row(`custom-${a.key}`, pic, a.name, () => start(a), hint, false);
        }))
        .children(choices.filter((a) => !a.installed).map((a) => this.row(a.key,
          a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
          () => run("tab.new", { name: a.name, space: space?.id, argv: a.run }), "not installed", false)))
        .when(this.failed || this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("space", div().w(14).child("+"), "New space", () => run("space.new"), shortcut("space.new")))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree…", () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree\u2026", () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "open" } }), "", Boolean(space)));
  }
}
