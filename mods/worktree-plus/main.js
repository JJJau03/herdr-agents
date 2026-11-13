import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  run,
  props,
  closeOverlay,
  theme,
  spaces,
  panes,
  focused,
  exec,
  home,
  nextCommand,
  shared,
  setShared,
} from "herdr";

const helperPath = () => `${home()}/.config/herdr-app/mods/worktree-plus/wt-helper.py`;
const ROOT = (userHome) => `${userHome}/.herdr/worktrees`;
const ROW_H = 44;
const VIEW_H = 308; // 7 rows * 44px

function tilde(path, userHome) {
  if (!path || !userHome) return path ?? "";
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
}

function slug(branch) {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function makeTimestampBranch(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `wt/${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function place(s) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

export default class WorktreePlus extends View {
  init(_props, cx) {
    const req = shared("worktree-plus.request");
    if (req) setShared("worktree-plus.request", null);
    this.mode = req?.action ?? props()?.action ?? "new";
    this.targetSpaceId = req?.space ?? props()?.space ?? spaces().find((s) => s.active)?.id ?? null;
    this.targetFolder = req?.folder ?? props()?.folder ?? null;

    this.on = this.space()?.machine ?? null;
    this.userHome = home();
    this.text = props()?.branch ?? "";
    this.tsBranch = makeTimestampBranch();
    this.at = 0;
    this.scroll = 0;
    this.lastStepAt = 0;
    this.busy = false;
    this.error = "";
    this.repo = undefined;
    this.wtStatus = null;
    this.children = [];
    this.issues = [];
    this.loadingIssues = false;
    this.handle = cx.focus_handle();

    this.input = InputState.new({
      value: this.text,
      placeholder:
        this.mode === "issue"
          ? "Search GitHub issues or enter a task name…"
          : "Filter issues / repositories, or enter a branch name…",
    });
    this.input.on("change", (_e, cx) => {
      this.text = this.input.value();
      this.error = "";
      this.at = 0;
      this.scroll = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.activateSelected(cx));

    if (this.mode === "remove") {
      this.handle.focus();
      cx.timer.after(50, () => this.handle.focus());
      cx.timer.after(200, () => this.handle.focus());
    } else {
      this.input.focus();
      cx.timer.after(50, () => this.input.focus());
      cx.timer.after(250, () => this.input.focus());
      cx.timer.after(600, () => this.input.focus());
    }

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        const items = this.currentItems();
        if (!items.length) continue;
        if (cmd === "down") {
          this.at = (this.at + 1) % items.length;
          this.ensureVisible(items.length);
        } else if (cmd === "up") {
          this.at = (this.at + items.length - 1) % items.length;
          this.ensureVisible(items.length);
        }
        cx.notify();
      }
    });

    cx.spawn(async (cx) => {
      try {
        this.folder =
          this.targetFolder ||
          focused()?.cwd ||
          panes().find((p) => p.focused)?.cwd ||
          place(this.space()) ||
          this.userHome;

        if (this.mode === "remove") {
          const r = await exec("python3", [helperPath(), "check-wt", this.folder]);
          if (r.code === 0 && r.stdout.trim()) {
            const st = JSON.parse(r.stdout);
            this.wtStatus = st;
            this.repo = st.repo ?? null;
            if (st.dirty) this.at = 2;
            else if (st.unpushed > 0) this.at = 1;
            else this.at = 0;
          } else {
            this.repo = null;
          }
          this.handle.focus();
          cx.notify();
          return;
        }

        const r = await exec("python3", [helperPath(), "inspect", this.folder]);
        if (r.code === 0 && r.stdout.trim()) {
          const data = JSON.parse(r.stdout);
          this.repo = data.repo;
          this.children = data.children ?? [];
          this.issues = data.issues ?? [];
        } else {
          this.repo = null;
        }
      } catch (e) {
        this.repo = null;
        this.error = String(e);
      }
      if (this.mode === "remove") this.handle.focus();
      else this.input.focus();
      cx.notify();
    });
  }

  ensureVisible(count) {
    const total = count * ROW_H;
    const height = Math.min(VIEW_H, total);
    if (this.at * ROW_H < this.scroll) this.scroll = this.at * ROW_H;
    if ((this.at + 1) * ROW_H > this.scroll + height) this.scroll = (this.at + 1) * ROW_H - height;
  }

  space() {
    if (this.targetSpaceId) {
      const found = spaces().find((s) => s.id === this.targetSpaceId);
      if (found) return found;
    }
    return spaces().find((s) => s.active);
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  currentBoundIssue() {
    const meta = shared("worktree-plus.meta") ?? {};
    const key = (this.repo?.top || this.folder || "").replace(/\/+$/, "");
    return (
      meta[key]?.issue ??
      (this.targetSpaceId ? meta[`space:${this.targetSpaceId}`]?.issue : null) ??
      null
    );
  }

  currentItems() {
    if (this.mode === "remove") {
      if (!this.wtStatus?.linked) return [];
      const br = this.repo?.branch ?? "HEAD";
      return [
        {
          kind: "rm-all",
          title: "🗑️ Delete worktree directory and local branch",
          sub: `Remove ${tilde(this.repo.top, this.userHome)} and delete branch ${br}`,
        },
        {
          kind: "rm-dir",
          title: "🗑️ Delete worktree directory only (keep local branch)",
          sub: `Remove ${tilde(this.repo.top, this.userHome)}, keep branch ${br}`,
        },
        {
          kind: "keep",
          title: "📁 Keep worktree directory (close window only)",
          sub: `Files remain in ${tilde(this.repo.top, this.userHome)}`,
        },
      ];
    }

    const q = this.text.trim().toLowerCase();
    if (this.repo === null && this.children.length > 0) {
      return this.children
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .map((c) => ({ kind: "repo", repo: c, title: `📁 ${c.name}`, sub: tilde(c.top, this.userHome) }));
    }
    if (!this.repo) return [];

    const out = [];
    if (this.mode === "issue") {
      const cur = this.currentBoundIssue();
      if (q) {
        out.push({
          kind: "set-issue",
          issue: { number: null, title: this.text.trim() },
          title: `📌 Set custom task: ${this.text.trim()}`,
          sub: "Link a custom label (changeable later)",
        });
      } else if (cur) {
        out.push({
          kind: "clear-issue",
          title: "✕ Clear linked issue",
          sub: `Currently linked: ${cur.number ? `#${cur.number} ` : ""}${cur.title}`,
        });
      }
      for (const iss of this.issues) {
        const hay = `#${iss.number} ${iss.title} ${iss.branch}`.toLowerCase();
        if (!q || hay.includes(q)) {
          out.push({
            kind: "set-issue",
            issue: { number: iss.number, title: iss.title },
            title: `#${iss.number}  ${iss.title}`,
            sub: `${this.repo.name} · Click or press Enter to link this issue`,
          });
        }
      }
      return out;
    }

    if (!q) {
      out.push({
        kind: "branch",
        branch: this.tsBranch,
        issue: null,
        title: "⏱ Create from timestamp (omp format)",
        sub: this.tsBranch,
      });
    } else {
      out.push({
        kind: "branch",
        branch: this.text.trim(),
        issue: null,
        title: "✨ Create branch from entered name",
        sub: this.text.trim(),
      });
    }

    for (const iss of this.issues) {
      const hay = `#${iss.number} ${iss.title} ${iss.branch}`.toLowerCase();
      if (!q || hay.includes(q)) {
        out.push({
          kind: "issue",
          branch: iss.branch,
          issue: { number: iss.number, title: iss.title },
          title: `#${iss.number}  ${iss.title}`,
          sub: iss.branch,
        });
      }
    }
    return out;
  }

  selectRepo(repo, cx) {
    this.lastStepAt = Date.now();
    this.repo = repo;
    this.text = "";
    this.input.set_value("", cx);
    this.at = 0;
    this.scroll = 0;
    this.loadingIssues = true;
    this.input.focus();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [helperPath(), "issues", repo.top]);
        if (r.code === 0 && r.stdout.trim()) {
          this.issues = JSON.parse(r.stdout).issues ?? [];
        }
      } catch {}
      this.loadingIssues = false;
      this.input.focus();
      cx.notify();
    });
  }

  saveIssueBinding(issueObj) {
    const meta = { ...(shared("worktree-plus.meta") ?? {}) };
    const key = (this.repo?.top || this.folder || "").replace(/\/+$/, "");
    if (key) {
      const prev = meta[key] ?? {};
      meta[key] = {
        ...prev,
        repoTop: this.repo?.main ?? prev.repoTop,
        repoName: this.repo?.name ?? prev.repoName,
        issue: issueObj,
        updatedAt: Date.now(),
      };
    }
    if (this.targetSpaceId) {
      const skey = `space:${this.targetSpaceId}`;
      const prev = meta[skey] ?? {};
      meta[skey] = {
        ...prev,
        repoTop: this.repo?.main ?? prev.repoTop,
        repoName: this.repo?.name ?? prev.repoName,
        issue: issueObj,
        updatedAt: Date.now(),
      };
    }
    setShared("worktree-plus.meta", meta);
  }

  activateSelected(cx) {
    if (Date.now() - this.lastStepAt < 200) return;
    const items = this.currentItems();
    const sel = items[this.at] ?? items[0];
    if (!sel) return;
    if (sel.kind === "repo") {
      this.selectRepo(sel.repo, cx);
      return;
    }
    if (sel.kind === "rm-all" || sel.kind === "rm-dir" || sel.kind === "keep") {
      this.runRemoveChoice(sel.kind, cx);
      return;
    }
    if (sel.kind === "set-issue") {
      this.saveIssueBinding(sel.issue);
      this.close();
      return;
    }
    if (sel.kind === "clear-issue") {
      this.saveIssueBinding(null);
      this.close();
      return;
    }
    if (sel.branch) {
      this.createBranch(sel.branch, sel.issue ?? null, cx);
    }
  }

  runRemoveChoice(kind, cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const sp = spaces().find(
          (s) => s.id === this.targetSpaceId || (this.repo?.top && place(s) === this.repo.top)
        );
        if (sp) {
          run("space.close", { id: sp.id, confirmed: true });
        }
        if (kind === "keep" && this.repo?.top) {
          await exec("python3", [helperPath(), "keep-wt", this.repo.top]);
        } else if (kind === "rm-all" || kind === "rm-dir") {
          const args = [helperPath(), "remove-wt", this.repo.top];
          if (kind === "rm-all") args.push("--delete-branch");
          const r = await exec("python3", args);
          const res = r.stdout.trim() ? JSON.parse(r.stdout) : { ok: false, error: r.stderr };
          if (!res.ok) {
            this.error = res.error || "Failed to delete worktree";
            this.busy = false;
            cx.notify();
            return;
          }
          const meta = { ...(shared("worktree-plus.meta") ?? {}) };
          const key = (this.repo?.top || "").replace(/\/+$/, "");
          delete meta[key];
          if (sp) delete meta[`space:${sp.id}`];
          setShared("worktree-plus.meta", meta);
        }
        this.close();
      } catch (e) {
        this.error = String(e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  createBranch(branch, issueObj, cx) {
    if (this.busy || !this.repo || !branch) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const path = `${ROOT(this.userHome)}/${this.repo.name}/${slug(branch)}`;
        const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
        const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
        const r = await git(this.repo.top, add, this.on);
        if (!r.ok) {
          this.error = r.err || "git worktree add failed.";
          this.busy = false;
          cx.notify();
          return;
        }
        const meta = { ...(shared("worktree-plus.meta") ?? {}) };
        meta[path.replace(/\/+$/, "")] = {
          parentSpaceId: this.targetSpaceId,
          repoTop: this.repo.main,
          repoName: this.repo.name,
          branch,
          issue: issueObj ?? null,
          updatedAt: Date.now(),
        };
        setShared("worktree-plus.meta", meta);

        const p = props() ?? {};
        run("space.new", { folder: path, machine: this.on, tab: p.tab, argv: p.argv });
        this.close();
      } catch (e) {
        this.error = String(e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  key(e, cx) {
    const k = e.key;
    if (k === "escape") {
      cx.stop_propagation();
      return this.close();
    }
    const items = this.currentItems();
    if (!items.length) return;
    if (k === "down" || ((k === "j" || k === "n") && e.modifiers.control)) {
      this.at = (this.at + 1) % items.length;
      this.ensureVisible(items.length);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "up" || ((k === "k" || k === "p") && e.modifiers.control)) {
      this.at = (this.at + items.length - 1) % items.length;
      this.ensureVisible(items.length);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "enter" && this.mode === "remove") {
      cx.stop_propagation();
      this.activateSelected(cx);
    }
  }

  renderRemove(t) {
    const st = this.wtStatus;
    const r = this.repo;
    const items = this.currentItems();

    return v_flex()
      .id("worktree-plus")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().text_size(14).font_semibold().child(`Leave worktree${r ? ` · ${r.name} (${r.branch ?? ""})` : ""}`))
          .child(div().text_size(11).text_color(t.dim).child("Ctrl+J/K select · Enter confirm · Esc cancel"))
      )
      .when(!st, (el) => el.child(div().text_color(t.muted).child("Checking worktree status…")))
      .when(Boolean(st && !st.linked), (el) =>
        el.child(div().text_color(t.muted).child("Current directory is not a linked Git worktree."))
      )
      .when(Boolean(st && st.linked), (el) =>
        el
          .child(
            v_flex()
              .p(10)
              .gap(4)
              .rounded(6)
              .border_1()
              .border_color(st.dirty || st.unpushed > 0 ? t.warning ?? t.working : t.border)
              .bg(t.surface)
              .child(
                div()
                  .text_size(12)
                  .font_semibold()
                  .text_color(st.dirty ? t.blocked : st.unpushed > 0 ? t.warning ?? t.working : t.accent)
                  .child(
                    st.dirty
                      ? `⚠️ Warning: ${st.dirtyCount} uncommitted files (deleting the directory will lose changes!)`
                      : st.unpushed > 0
                        ? `⚠️ Warning: branch ${r.branch} has ${st.unpushed} unpushed commits`
                        : "✅ Working tree is clean; no uncommitted changes"
                  )
              )
              .child(div().text_size(11).text_color(t.dim).child(`Path: ${tilde(r.top, this.userHome)}`))
          )
          .child(
            v_flex()
              .gap(6)
              .children(
                items.map((it, idx) => {
                  const on = idx === this.at;
                  return v_flex()
                    .id(`wt-rm-${idx}`)
                    .h(ROW_H)
                    .px(10)
                    .justify_center()
                    .gap(2)
                    .rounded(6)
                    .cursor_pointer()
                    .when(on, (el) => el.bg(t.selected))
                    .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
                    .on_click((_e, cx) => {
                      this.at = idx;
                      this.activateSelected(cx);
                    })
                    .child(div().font_semibold().text_color(t.foreground).child(it.title))
                    .child(div().text_size(11).text_color(on ? t.accent : t.dim).child(it.sub));
                })
              )
          )
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)));
  }

  render() {
    const t = theme();
    if (this.mode === "remove") return this.renderRemove(t);

    const r = this.repo;
    const items = this.currentItems();
    if (items.length > 0 && this.at >= items.length) this.at = items.length - 1;
    const pickingRepo = r === null && this.children.length > 0;

    const total = items.length * ROW_H;
    const height = Math.min(VIEW_H, total);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    this.ensureVisible(items.length);

    const placeRow = (el, i) =>
      fixed
        ? el
            .absolute()
            .left(0)
            .right(0)
            .top(i * ROW_H - this.scroll)
            .bottom(height - ((i + 1) * ROW_H - this.scroll))
        : el;
    const visible = (i) => !fixed || ((i + 1) * ROW_H > this.scroll && i * ROW_H < this.scroll + height);

    const isIssueMode = this.mode === "issue";
    const title = pickingRepo
      ? `Step 1/2: Choose repository (${items.length})`
      : isIssueMode
        ? `Change / link current issue${r ? ` · ${r.name}` : ""}`
        : `Step 2/2: Choose creation method or enter a branch name${r ? ` · ${r.name}` : ""}`;
    const subtitle =
      r === undefined
        ? "Loading Git repositories and GitHub issues…"
        : pickingRepo
          ? "This folder contains multiple repositories; choose one:"
          : r === null
            ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not a Git repository.`
            : isIssueMode
              ? `Choose an issue to link to this worktree / space (${this.issues.length} open issues):`
              : `Path: ~/.herdr/worktrees/${r.name}/<branch>  ${this.loadingIssues ? "· Loading issues…" : `· ${this.issues.length} open issues`}`;

    const renderRow = (it, idx) => {
      const on = idx === this.at;
      return v_flex()
        .id(`wt-opt-${idx}`)
        .h(ROW_H)
        .px(10)
        .justify_center()
        .gap(2)
        .rounded(6)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          this.at = idx;
          this.activateSelected(cx);
        })
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().truncate().font_semibold().text_color(t.foreground).child(it.title))
        )
        .child(div().truncate().text_size(11).text_color(on ? t.accent : t.dim).child(it.sub));
    };

    return v_flex()
      .id("worktree-plus")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().text_size(14).font_semibold().child(title))
          .child(div().text_size(11).text_color(t.dim).child("Ctrl+J/K or N/P move · Enter confirm · Esc close"))
      )
      .child(div().text_size(11.5).text_color(t.muted).child(subtitle))
      .child(
        Input.new(this.input)
          .h(32)
          .px(10)
          .items_center()
          .rounded(6)
          .border(1)
          .border_color(t.accent)
          .bg(t.background)
          .text_color(t.foreground)
      )
      .when(Boolean(r || pickingRepo), (el) =>
        el.child(
          v_flex()
            .id("wt-scroll-list")
            .relative()
            .h(height)
            .min_h(0)
            .when(fixed, (el) =>
              el.overflow_hidden().on_scroll_wheel((e, cx) => {
                this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
                while (this.at < items.length - 1 && this.at * ROW_H < this.scroll) this.at++;
                while (this.at > 0 && (this.at + 1) * ROW_H > this.scroll + height) this.at--;
                cx.notify();
              })
            )
            .children(items.map((it, i) => (visible(i) ? placeRow(renderRow(it, i), i) : null)).filter(Boolean))
        )
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(this.busy, (el) => el.child(div().text_color(t.accent).child("Creating worktree and space…")));
  }
}
