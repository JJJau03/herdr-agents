# Recipe: Herdr Agents

This is a build brief for Herdr Agents, a terminal-first Herdr layout. The packaged layout is `layouts/herdr-agents.json`. Add a privacy-reviewed gallery image at `preview.png` before sharing. Source attribution and licenses are recorded in `THIRD-PARTY-NOTICES`.

## Goal and principles

Build a compact workspace for several terminals and coding agents. Keep the terminal prominent, show projects and agent activity on the left, and offer Files and Git on demand rather than leaving a permanent right panel open, and launch Insights in a full tab. Use English UI text and Herdr's current theme and fonts. Preserve the user's existing shortcuts and settings. Never run automatic worktree or branch deletion.

## Window structure

Use a root horizontal row with `canvas` background, a 1px `border` divider, no system title bar, traffic-light offset `[12,16]`, and terminal padding `[14,12]`.

- **Sidebar:** a 268px `chrome` column, minimum 44px and maximum 480px. It has a 46px `workspace-chrome` brand block; resizable `spaces-plus` and `agents-plus` lists, each minimum 90px; a 256px `status-quota` block with 28px minimum; and a 69px `workspace-chrome` footer.
- **Work area:** a 42px `tabs-plus` bar, an 8px-padded and 8px-gapped body, and a 28px `workspace-status-plus` bar. The active tab's terminals use Herdr's `pane` header (30px, always visible), background, 1px border, accent focus border, 10px radius and 8px split gap.
- **Optional right panel:** a hidden-by-default 368px column, resizable between 280px and 900px. It switches between `files-plus` and Git. Git has a 72px `git-hub` header and a stack for Herdr's `changes`, `git-graph`, and `git-remote` views. Tabs expose Changes, Graph, PRs, Issues and CI.
- Use `toast-plus` for small notifications. Do not add persistent notification history or a permanent right-hand drawer.

## Interaction and behavior

1. **Spaces and agents:** `spaces-plus` groups projects and worktrees by machine, nests worktrees under their repositories, and uses terminal, Git, branch or folder icons instead of initial tiles. Do not show Pi/Codex count pills on space rows. `agents-plus` provides grouped or priority views, sub-agent trees and working/blocked/done/idle states when a terminal actually reports them. Keep the normal agent navigation order and shortcuts.
2. **Tab bar and launcher:** `tabs-plus` has tabs, a **+** launcher, and Files/Git buttons. `new-menu-plus` lists the selected machine's installed agents and preserves the existing numeric shortcuts; additional installed OpenClaw, Oh My Pi (`omp`) and Hermes (`hermes`) entries receive available keys 1–9. Numbered entries are in numeric order; unavailable entries appear below. Use the provided icons. Launch `omp` and `hermes` in new tabs. OpenClaw uses the reuse-first behavior below.
3. **OpenClaw:** the Agents area can show a separate service entry for a running local or connected-remote default gateway. Check Linux systemd or macOS launchd and recognize matching manually started gateway processes. A green indicator means the gateway is running, not that an agent is working; an unreachable previously seen machine is unknown. On click, find an identifiable foreground OpenClaw process in Herdr's panes on the same machine and focus it; otherwise create a terminal in `~/.openclaw` and run `openclaw`. Do not open a duplicate when terminal lookup fails. This cannot reliably find external terminal windows or processes hidden in multiplexers. No named-profile or Windows service support is promised.
4. **Git and Insights:** present changes, history and remote information on demand. Review is a dialog. Pull must be fast-forward-only. Push must be non-force, target the current branch's configured upstream, and be disabled without an upstream. Show the latest Push result in a compact popup that can be reopened; never silently claim success. The Insights button opens the local token-usage dashboard in a full-size tab, or focuses the existing Insights tab in the current space. It does not change the right-panel selection.
5. **Usage:** `status-quota` shows available Claude and Codex quota without implying stale values are current. Codex uses `codex app-server` rate limits. Claude checks an independently configured `~/.claude/.statusline.input` every five seconds for new local observations, prefers recent data, falls back to the usage endpoint, respects retry cooldowns, preserves a prior valid observation when a later status-line update omits quota fields, labels old fallback data stale for up to six hours, removes expired windows, and does not alert on stale readings. Do not install or modify the user's status-line script.
6. **Safety:** disable the automatic worktree cleanup timer; explicit, user-invoked worktree actions remain. Do not force push, change existing keybindings, delete user branches, or overwrite existing layout/mod names. The optional old-Pi status compatibility extension is separate and must not be installed alongside native Pi reporting.

## Mod composition and external dependencies

The layout uses Herdr's shipped `workspace-chrome`, `changes`, and `pane` mods/assets, plus the packaged `spaces-plus`, `agents-plus`, `status-quota`, `tabs-plus`, `files-plus`, `git-hub`, `git-graph`, `git-remote`, `insights`, `toast-plus`, and `workspace-status-plus`. Supporting packaged mods are `new-menu-plus`, `notification-detail`, `review`, `worktree-plus`, `system-monitor`, `scrollback`, `picker-copy` and `tmux-prefix`. Referenced assets are shipped either in these mod folders or with Herdr.

Use Herdr's GPUI mod API, `spaces()`, `panes()`, `terminals()`, `machines()`, `knownAgents()`, `exec`, `hc`, shared state and overlays. Do not use a webview for the layout. To show the Oh My Pi icon in Herdr's own pane headers and agent lists, optionally merge `optional/programs/omp.json` into the user's existing `programs.json` without replacing other entries; the installer must not alter that file automatically. The launcher checks commands in the selected machine's Bash login shell. OpenClaw detection checks service state and the user's process arguments, returning status only; the reuse check reads terminal metadata and foreground arguments, not terminal contents. Insights requires Node.js 22.15 or newer and reads local agent session files on the machine running Herdr; it does not automatically collect remote-machine sessions. Other optional integrations may call Git, `gh`, Python, Codex, provider endpoints or `macmon`; see `README.md` for the privacy implications and limitations.

## Packaging and acceptance

- Keep `layouts/herdr-agents.json`, `mods/`, this `RECIPE.md` and `preview.png` together. Preserve licenses and third-party notices. Never include runtime state, account files, credentials, caches or unredacted terminal content.
- `install.sh` must preflight every destination, refuse conflicts, and leave user settings, shortcuts and the active layout untouched. Its copies are not transactional after preflight.
- On a clean Herdr installation, check every included mod with `herdr-app check`; select the layout and exercise Files, Git tabs, launcher, service detection and agent navigation. Confirm worktrees are not automatically deleted and that Pull/Push do not perform unsafe updates.
- Test unavailable, disconnected and stale states as well as successful ones. A mod check only tests initial loading; it does not prove all dynamic states.
- Review the preview, logo redistribution rights and all included files before publishing. To appear in the Herdr gallery later, use a public GitHub repository tagged `herdr-layout`; publication is a separate user decision.
