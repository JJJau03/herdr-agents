import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, focused, layout, notify, openOverlay, panes, run, shared, setShared, spaces, theme, window } from "herdr";
import { describeRemote } from "./platform.js";

// How often the upstream is fetched, so "behind" reflects the remote and not just the last manual fetch.
const FETCH_MS = 60_000;

const TABS = [
  ["changes", "Changes", "mods/changes/changes.svg"],
  ["graph", "Graph", "mods/tabs-plus/graph.svg"],
  ["prs", "PRs", "mods/git-remote/icons/pr-open.svg"],
  ["issues", "Issues", "mods/git-remote/icons/issue-open.svg"],
  ["actions", "CI", "mods/git-remote/icons/actions.svg"],
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

// Where the Git panel's repo is: the focused terminal's folder, on its machine
// (the same rule the Changes panel uses).
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

export function selectGitTab(id) {
  setShared("git.subtab", id);
  if (id === "changes" || id === "graph") {
    setShared("git.focus", { target: id, at: Date.now() });
    run("layout.select", { stack: "git-body", child: id });
  } else {
    setShared("git-remote.tab", id);
    setShared("git.focus", { target: "git-remote", at: Date.now() });
    run("layout.select", { stack: "git-body", child: "git-remote" });
  }
}

export default class GitHubSwitcher extends View {
  init(_props, cx) {
    this.sync = null;
    this.busy = false;
    this.context = null;
    this.refreshSync(cx);
    // Ahead/behind come from the last fetch (read-only, no network); keep them current.
    cx.timer.every(10000, (cx) => { if (window()?.active) this.refreshSync(cx); });
  }

  refreshSync(cx) {
    if (this.busy || this.reading) return;
    const { cwd, on } = location();
    const context = JSON.stringify([cwd, on]);
    if (context !== this.context) { this.context = context; this.sync = null; }
    if (!cwd) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", ["--no-optional-locks", ...args], { cwd, on });
        const top = await git(["rev-parse", "--show-toplevel"]);
        if (top.code !== 0) { if (this.context === context) this.sync = { repo: false }; return; }
        const root = top.stdout.trim();
        const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
        const origin = await git(["remote", "get-url", "origin"]);
        const remote = origin.code === 0 ? describeRemote(origin.stdout) : null;
        const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
        const pushRemote = branch !== "HEAD" ? await git(["config", "--get", `branch.${branch}.remote`]) : null;
        const pushRef = branch !== "HEAD" ? await git(["config", "--get", `branch.${branch}.merge`]) : null;
        let ahead = 0, behind = 0;
        if (up.code === 0) {
          const c = await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
          if (c.code === 0) [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number);
        }
        if (this.context === context) {
          this.sync = { repo: true, root, branch, remote, upstream: up.code === 0 ? up.stdout.trim() : null,
            pushRemote: pushRemote?.code === 0 ? pushRemote.stdout.trim() : null,
            pushRef: pushRef?.code === 0 ? pushRef.stdout.trim() : null, ahead, behind, on };
          if (up.code === 0) this.fetchUpstream(root, up.stdout.trim().split("/")[0], on, cx);
        }
      } catch { if (this.context === context) this.sync = null; }
      finally { this.reading = false; cx.notify(); }
    });
  }

  // Fetch the upstream remote in the background (at most once a minute per repo), then re-read ahead/behind.
  // Never prompts for credentials: a remote that needs a password just fails quietly.
  fetchUpstream(root, remote, on, cx) {
    const key = JSON.stringify([root, on]);
    this.fetchedAt ??= {};
    if (this.fetching || Date.now() - (this.fetchedAt[key] ?? 0) < FETCH_MS) return;
    this.fetching = true;
    this.fetchedAt[key] = Date.now();
    cx.spawn(async (cx) => {
      try { await exec("env", ["GIT_TERMINAL_PROMPT=0", "git", "fetch", "--quiet", "--no-tags", remote], { cwd: root, on, timeout: 120000 }); } catch {}
      this.fetching = false;
      this.refreshSync(cx);
    });
  }

  // Fast-forward only: never creates a merge commit or rewrites local work.
  pull(cx) {
    const s = this.sync;
    if (!s?.repo || !s.upstream || this.busy || JSON.stringify([location().cwd, location().on]) !== this.context) return;
    this.busy = "pull";
    cx.notify();
    cx.spawn(async (cx) => {
      let title = "", body = "", level = "info";
      try {
        const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: s.root, on: s.on })).stdout.trim();
        const r = await exec("git", ["pull", "--ff-only"], { cwd: s.root, on: s.on, timeout: 120000 });
        if (r.code !== 0) {
          const why = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).slice(-2).join(" ");
          title = `Pull failed · ${s.branch}`; body = why.slice(0, 160); level = "error";
        } else {
          const after = (await exec("git", ["rev-parse", "HEAD"], { cwd: s.root, on: s.on })).stdout.trim();
          if (before === after) { title = `Already up to date · ${s.branch}`; level = "success"; }
          else {
            const n = (await exec("git", ["rev-list", "--count", `${before}..${after}`], { cwd: s.root, on: s.on })).stdout.trim();
            title = `Pulled ${n} commits · ${s.branch}`; level = "success";
            setShared("git-remote.changed", { at: Date.now() });
          }
        }
      } catch (e) { title = "Pull failed"; body = String(e).slice(0, 160); level = "error"; }
      notify({ title, body, level, timeout: level === "error" ? 8000 : 4000 });
      this.busy = false;
      this.reading = false;
      this.refreshSync(cx);
      cx.notify();
    });
  }

  // Push only the current HEAD to its configured upstream branch; never force or prompt for credentials.
  push(cx) {
    const s = this.sync;
    if (!s?.repo || !s.upstream || !s.pushRemote || s.pushRemote === "." || !s.pushRef?.startsWith("refs/heads/") || this.busy || JSON.stringify([location().cwd, location().on]) !== this.context) return;
    this.busy = "push";
    cx.notify();
    cx.spawn(async (cx) => {
      let title, body = "", level;
      try {
        const r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=Never", "git", "push", "--porcelain", "--", s.pushRemote, `HEAD:${s.pushRef}`], { cwd: s.root, on: s.on, timeout: 120000 });
        body = [r.stdout, r.stderr].filter(Boolean).join("\n").trim().slice(0, 12000);
        if (r.code !== 0) {
          title = `Push failed · ${s.branch}`; level = "error";
          if (!body) body = `Git exited with code ${r.code}.`;
        } else {
          title = `Pushed · ${s.branch}`; level = "success";
          if (!body) body = "Push completed successfully.";
          setShared("git-remote.changed", { at: Date.now() });
        }
      } catch (e) { title = `Push failed · ${s.branch}`; body = String(e).slice(0, 12000); level = "error"; }
      this.lastPush = { title, body, root: s.root, on: s.on };
      notify({ title, body, level, timeout: level === "error" ? 8000 : 4000 });
      this.busy = false;
      this.refreshSync(cx);
      cx.notify();
    });
  }

  syncRow(t) {
    const s = this.sync;
    const label = (text, color) => div().text_size(12).font_semibold().text_color(color).child(text);
    let info;
    if (!s) info = div().text_size(12).text_color(t.dim).child("Loading…");
    else if (!s.repo) info = div().text_size(12).text_color(t.dim).child("Not in a Git repository");
    else {
      info = h_flex().gap(8).items_center().flex_1().min_w(0)
        .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().text_size(12.5).font_semibold().child(s.branch))
        .when(Boolean(s.remote), (e) => {
          const c = s.remote.color ?? t.muted;
          return e.child(div().flex_none().h(18).px(6).flex().items_center().rounded(4).border_1().border_color(`${c}66`)
            .text_size(10.5).text_color(c).tooltip(`origin：${s.remote.host}/${s.remote.slug}`).child(s.remote.label));
        })
        .when(!s.upstream, (e) => e.child(div().text_size(11).text_color(t.dim).child("No upstream branch")))
        .when(s.behind > 0, (e) => e.child(label(`↓${s.behind}`, t.warning ?? t.working)))
        .when(s.ahead > 0, (e) => e.child(label(`↑${s.ahead}`, t.accent)))
        .when(s.upstream && s.behind === 0 && s.ahead === 0, (e) => e.child(div().text_size(11).text_color(t.dim).child("Up to date")));
    }
    // Pull is always available (git pull fetches first, so it can't be stale); it is highlighted when the last fetch shows commits to pull.
    const can = Boolean(s?.repo && s.upstream) && !this.busy;
    const needs = can && s.behind > 0;
    const canPush = Boolean(s?.repo && s.upstream && s.pushRemote && s.pushRemote !== "." && s.pushRef?.startsWith("refs/heads/")) && !this.busy;
    return h_flex().h(32).flex_none().px(8).gap(5).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).child(info))
      .child(div().id("git-review").h(24).px(10).flex_none().flex().items_center().rounded(6)
        .border_1().border_color(t.border).bg(t.surface)
        .text_size(12).font_semibold().text_color(s?.repo ? t.foreground : t.dim)
        .when(Boolean(s?.repo), (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)))
        .tooltip("Review uncommitted, last commit, or branch changes; comment, send to an agent, or commit")
        .on_click(() => { if (s?.repo) openOverlay({ mod: "review", kind: "dialog", width: 0.88, height: 0.92, props: { root: s.root, on: s.on } }); })
        .child(h_flex().gap(5).items_center()
          .child(svg("mods/git-hub/icons/eye.svg").size(14).flex_none().text_color(s?.repo ? t.ansi5 : t.dim))
          .child("Review")))
      .child(div().id("git-pull").h(24).px(10).flex_none().flex().items_center().rounded(6)
        .border_1().border_color(needs ? t.accent : t.border)
        .bg(needs ? t.selected : t.surface)
        .text_size(12).font_semibold().text_color(can ? t.foreground : t.dim)
        .when(can, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)))
        .tooltip(this.busy === "pull" ? "Pulling…"
          : !s?.repo ? "Not in a Git repository"
          : !s.upstream ? "This branch has no upstream to pull from"
          : s.behind > 0 ? `Pull ${s.behind} commits (git pull --ff-only); no merge commit`
          : "Pull with git pull --ff-only; checks for updates in the background")
        .on_click((_e, cx) => this.pull(cx))
        .child(h_flex().gap(5).items_center()
          .child(this.busy === "pull" ? svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.muted).spin(900) : svg("mods/git-hub/icons/arrow-down.svg").size(14).flex_none().text_color(needs ? t.accent : t.dim))
          .child("Pull")))
      .child(div().id("git-push").h(24).px(8).flex_none().flex().items_center().rounded(6)
        .border_1().border_color(canPush && s.ahead > 0 ? t.accent : t.border).bg(canPush && s.ahead > 0 ? t.selected : t.surface)
        .text_size(12).font_semibold().text_color(canPush ? t.foreground : t.dim)
        .when(canPush, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)))
        .tooltip(this.busy === "push" ? "Pushing…" : !s?.repo ? "Not in a Git repository" : !canPush ? "Configure an upstream branch before pushing" : `Push ${s.branch} to ${s.upstream} (never force)`)
        .on_click((_e, cx) => this.push(cx))
        .child(h_flex().gap(4).items_center().child(this.busy === "push" ? svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.muted).spin(900) : div().text_color(canPush ? t.accent : t.dim).child("↑")).child("Push")))
      .when(Boolean(this.lastPush), (e) => e.child(div().id("git-last-push").h(24).px(7).flex_none().flex().items_center().rounded(6)
        .border_1().border_color(t.border).text_size(12).font_semibold().text_color(t.muted).cursor_pointer()
        .hover((x) => x.bg(t.hover)).tooltip("Show the latest push result (this session)")
        .on_click(() => openOverlay({ mod: "notification-detail", kind: "popup", width: 420, height: 320, props: this.lastPush }))
        .child("ⓘ")));
  }

  render(cx) {
    const t = theme();
    // A different focused folder means a different repo: re-read right away.
    const { cwd, on } = location();
    if (JSON.stringify([cwd, on]) !== this.context) this.refreshSync(cx);
    const body = find(layout(), "git-body");
    const stackActive = body?.active ?? "changes";
    const ghTab = shared("git-remote.tab") ?? "prs";
    const active = stackActive === "git-remote" ? (["prs", "issues", "actions"].includes(ghTab) ? ghTab : "prs") : stackActive;

    return v_flex().id("git-switcher").size_full().bg(t.background).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(8).gap(3).items_center().border_b(1).border_color(t.border)
        .children(TABS.map(([id, label, icon]) => {
          const on = active === id;
          return h_flex().id(`git-sub-${id}`).h(28).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
            .bg(on ? t.selected : "#00000000").hover((s) => s.bg(on ? t.selected : t.hover))
            .text_size(12.5).text_color(on ? t.foreground : t.muted).when(on, (x) => x.font_semibold())
            .on_click(() => selectGitTab(id))
            .child(svg(icon).size(13.5).flex_none().text_color(on ? t.accent : t.muted))
            .child(label);
        })))
      .child(this.syncRow(t));
  }
}
