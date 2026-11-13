// Report Pi's lifecycle to herdr-core using OSC 7501.
// This compatibility extension is for older Pi releases without native status reporting.
export default function (pi) {
  if (!process.env.HC_TERMINAL_ID || !process.stdout.isTTY) return;
  let working = false;
  let waiting = false;
  const report = state => process.stdout.write(`\x1b]7501;state=${state}:app=pi\x1b\\`);
  pi.on("session_start", () => { working = false; waiting = false; report("idle"); });
  pi.on("agent_start", () => { working = true; waiting = false; report("working"); });
  pi.on("ui_prompt_start", () => { waiting = true; report("blocked"); });
  pi.on("ui_prompt_end", () => { waiting = false; report(working ? "working" : "idle"); });
  pi.on("agent_settled", event => { working = false; waiting = false; report(event.aborted ? "idle" : "done"); });
  pi.on("session_shutdown", () => { working = false; waiting = false; report("clear"); });
}
