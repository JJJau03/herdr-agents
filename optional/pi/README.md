# Optional: status reporting for older Pi versions

This compatibility extension reports `idle`, `working`, `blocked`, `done` and `clear` to a Herdr terminal using OSC 7501. It was tested with Pi 1.0.2 inside herdr-core on a remote Linux machine. It is **not** installed by `install.sh`.

On the machine where Pi runs, review `herdr-status.js`, then copy it to `~/.pi/agent/extensions/herdr-status.js` only if that path is unused. Start Pi again or run `/reload` in an existing idle session. It only reports when stdout is a TTY and `HC_TERMINAL_ID` is set. It does not alter SSH or Herdr configuration.

Newer Pi versions support OSC 7501 natively. Do not install this extension alongside native reporting; remove it after upgrading to a version that reports status itself. It is a compatibility workaround, not a replacement for updating Pi.
