#!/usr/bin/env python3
import concurrent.futures
import datetime
import glob
import json
import os
import queue
import shutil
import sqlite3
import threading
import subprocess
import sys
import time
import urllib.request
import urllib.error

HOME = os.path.expanduser("~")
CACHE_PATH = os.path.join(HOME, ".cache", "herdr-quota", "status-quota.json")
OMP_DB = os.path.join(HOME, ".omp", "agent", "agent.db")
TTL_SEC = 120


def iso_to_ms(val):
    if not val:
        return None
    if isinstance(val, (int, float)):
        return int(val * 1000) if val < 1e12 else int(val)
    try:
        s = str(val).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return int(datetime.datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return None


def fmt_countdown(resets_ms, now_ms):
    if not resets_ms or resets_ms <= now_ms:
        return "Reset"
    sec = int((resets_ms - now_ms) / 1000)
    d, rem = divmod(sec, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    dt = datetime.datetime.fromtimestamp(resets_ms / 1000)
    clock = dt.strftime("%m/%d %H:%M") if d > 0 else dt.strftime("%H:%M")
    if d > 0:
        return f"{d}d {h}h ({clock})"
    if h > 0:
        return f"{h}h {m}m ({clock})"
    return f"{max(1, m)}m ({clock})"


def query_omp_db():
    if not os.path.exists(OMP_DB):
        return {}
    try:
        conn = sqlite3.connect(f"file:{OMP_DB}?mode=ro", uri=True, timeout=2)
        cur = conn.cursor()
        cur.execute(
            """
            SELECT u.provider, u.email, u.label, u.window_label, u.used_fraction, u.resets_at, u.recorded_at
            FROM usage_history u
            JOIN (
                SELECT provider, COALESCE(email, '') AS em, MAX(recorded_at) AS max_rec
                FROM usage_history
                GROUP BY provider, COALESCE(email, '')
            ) latest
              ON u.provider = latest.provider
             AND COALESCE(u.email, '') = latest.em
             AND u.recorded_at = latest.max_rec
            """
        )
        out = {}
        for prov, email, label, win, used_frac, resets_at, rec_at in cur.fetchall():
            out.setdefault((prov, email or ""), []).append(
                {
                    "label": label,
                    "window": win,
                    "used_fraction": float(used_frac or 0.0),
                    "resets_at": int(resets_at) if resets_at else None,
                    "recorded_at": int(rec_at) if rec_at else 0,
                }
            )
        conn.close()
        return out
    except Exception:
        return {}


def read_claude_statusline(now_ms, allow_stale=False):
    """Read unexpired windows; old observations are available only as explicitly stale fallback."""
    path = os.path.join(HOME, ".claude", ".statusline.input")
    try:
        observed_ms = int(os.stat(path).st_mtime * 1000)
        age = now_ms - observed_ms
        if not 0 <= age <= (21600000 if allow_stale else 600000):
            return None
        with open(path, "r", encoding="utf-8") as f:
            rates = json.load(f).get("rate_limits") or {}
        items = []
        for label, key in [("5h", "five_hour"), ("7d", "seven_day")]:
            w = rates.get(key) or {}
            used, reset = w.get("used_percentage"), w.get("resets_at")
            if isinstance(used, bool) or not isinstance(used, (int, float)) or not 0 <= used <= 100:
                continue
            if isinstance(reset, bool) or not isinstance(reset, (int, float)) or reset * 1000 <= now_ms:
                continue
            reset_ms = int(reset * 1000)
            items.append({"label": label, "fullLabel": f"Claude {label}", "remaining": round(100 - used),
                          "used": round(used), "resetsAt": reset_ms, "resetText": fmt_countdown(reset_ms, now_ms)})
        if not items:
            return None
        stamp = datetime.datetime.fromtimestamp(observed_ms / 1000).strftime("%H:%M")
        stale = age > 600000
        return {"id": "claude", "name": "Claude", "account": f"{'stale · ' if stale else 'as of '}{stamp}", "icon": "icons/claude.svg",
                "items": items, "source": "claude-code-stale" if stale else "claude-code-statusline", "stale": stale, "observedAt": observed_ms}
    except (OSError, ValueError, TypeError, AttributeError, OverflowError):
        return None


def restore_claude_observation(provider, now_ms):
    """Keep a previously observed status-line reading if a later update omits quotas."""
    if not isinstance(provider, dict) or provider.get("source") not in ("claude-code-statusline", "claude-code-stale"):
        return None
    observed = provider.get("observedAt")
    if isinstance(observed, bool) or not isinstance(observed, (int, float)) or not 0 <= now_ms - observed <= 21600000:
        return None
    items = []
    for item in provider.get("items", []):
        reset = item.get("resetsAt") if isinstance(item, dict) else None
        if isinstance(reset, bool) or not isinstance(reset, (int, float)) or reset <= now_ms:
            continue
        items.append({**item, "resetText": fmt_countdown(reset, now_ms)})
    if not items:
        return None
    old = now_ms - observed > 600000
    stamp = datetime.datetime.fromtimestamp(observed / 1000).strftime("%H:%M")
    return {**provider, "items": items, "account": f"{'stale · ' if old else 'as of '}{stamp}",
            "source": "claude-code-stale" if old else "claude-code-statusline", "stale": old}


def fetch_claude(now_ms, omp_rows):
    token = None
    plan = None
    failure = "Usage unavailable"
    retry_at = None
    try:
        raw = subprocess.check_output(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            stderr=subprocess.DEVNULL,
            timeout=3,
        ).decode("utf-8")
        oauth = json.loads(raw).get("claudeAiOauth") or {}
        token = oauth.get("accessToken")
        plan = oauth.get("subscriptionType")
    except Exception:
        pass

    if not token:
        try:
            with open(os.path.join(HOME, ".claude", ".credentials.json"), "r", encoding="utf-8") as f:
                oauth = json.load(f).get("claudeAiOauth") or {}
                token = oauth.get("accessToken")
                plan = oauth.get("subscriptionType")
        except Exception:
            pass

    if token:
        try:
            req = urllib.request.Request(
                "https://api.anthropic.com/api/oauth/usage",
                headers={
                    "Authorization": f"Bearer {token}",
                    "anthropic-beta": "oauth-2025-04-20",
                    "User-Agent": "herdr-status-quota/1.0",
                },
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            items = []
            for label, full_label, key in [("5h", "Claude 5h", "five_hour"), ("7d", "Claude 7d", "seven_day")]:
                w = data.get(key)
                if not w:
                    continue
                used = float(w.get("utilization") or 0.0)
                resets_ms = iso_to_ms(w.get("resets_at"))
                rem = max(0, min(100, round(100.0 - used)))
                items.append(
                    {
                        "label": label,
                        "fullLabel": full_label,
                        "remaining": rem,
                        "used": round(used),
                        "resetsAt": resets_ms,
                        "resetText": fmt_countdown(resets_ms, now_ms),
                    }
                )
            if items:
                acct = next((em.split("@")[0] for (p, em) in omp_rows if p == "anthropic" and em), "")
                return {
                    "id": "claude",
                    "name": f"Claude ({plan})" if plan else "Claude",
                    "account": acct,
                    "icon": "icons/claude.svg",
                    "items": items,
                }
        except urllib.error.HTTPError as exc:
            failure = "Rate limited; try later" if exc.code == 429 else f"Usage unavailable (HTTP {exc.code})"
            if exc.code == 429:
                try:
                    seconds = max(60, int(exc.headers.get("Retry-After", "3600")))
                except (ValueError, TypeError):
                    seconds = 3600
                retry_at = now_ms + seconds * 1000
        except Exception:
            pass

    # Only use recent OMP data; expired snapshots cannot establish current usage.
    for (prov, email), rows in omp_rows.items():
        if prov != "anthropic":
            continue
        items = []
        for r in rows:
            if "Fable" in (r["label"] or "") or not r.get("recorded_at") or now_ms - r["recorded_at"] > 600000 or (r.get("resets_at") and r["resets_at"] <= now_ms):
                continue
            lbl = "5h" if "5" in (r["window"] or r["label"] or "") else "7d"
            resets_ms = r["resets_at"]
            used = r["used_fraction"] * 100.0
            if resets_ms and resets_ms <= now_ms:
                used = 0.0
            rem = max(0, min(100, round(100.0 - used)))
            items.append(
                {
                    "label": lbl,
                    "fullLabel": r["label"],
                    "remaining": rem,
                    "used": round(used),
                    "resetsAt": resets_ms,
                    "resetText": fmt_countdown(resets_ms, now_ms),
                }
            )
        items.sort(key=lambda x: 0 if x["label"] == "5h" else 1)
        if not items:
            continue
        return {
            "id": "claude",
            "name": f"Claude ({plan})" if plan else "Claude",
            "account": email.split("@")[0] if email else "",
            "icon": "icons/claude.svg",
            "items": items,
            **({"retryAt": retry_at} if retry_at else {}),
        }

    return {"id": "claude", "name": "Claude", "icon": "icons/claude.svg", "error": failure if token else "Not signed in", "items": [],
            **({"retryAt": retry_at} if retry_at else {})}


def fetch_codex_live():
    """Ask the authenticated Codex app server for current account limits."""
    binary = shutil.which("codex") or os.path.join(HOME, ".local", "bin", "codex")
    process = None
    try:
        process = subprocess.Popen([binary, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, bufsize=1)
        messages = queue.Queue()
        def read_lines():
            for line in process.stdout:
                messages.put(line)
        threading.Thread(target=read_lines, daemon=True).start()
        def send(message):
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()
        def receive(request_id):
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                message = json.loads(messages.get(timeout=max(0.01, deadline - time.monotonic())))
                if message.get("id") == request_id:
                    return message.get("result") or {}
            return {}
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "herdr_quota", "version": "1.0"}, "capabilities": {}}})
        if not receive(1):
            return None
        send({"method": "initialized", "params": {}})
        send({"id": 2, "method": "account/rateLimits/read"})
        return receive(2).get("rateLimits")
    except Exception:
        return None
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def fetch_codex(now_ms, omp_rows):
    live = fetch_codex_live()
    if not live:
        return {"id": "codex", "name": "Codex", "icon": "icons/codex.svg", "error": "Live usage unavailable", "items": []}
    plan = live.get("planType")
    items = []
    for key in ("primary", "secondary"):
        window = live.get(key)
        if not isinstance(window, dict) or window.get("usedPercent") is None:
            continue
        minutes = window.get("windowDurationMins")
        label = "5h" if minutes == 300 else "7d" if minutes == 10080 else f"{minutes}m" if minutes else key
        used = max(0, min(100, float(window["usedPercent"])))
        resets_ms = iso_to_ms(window.get("resetsAt"))
        items.append({"label": label, "fullLabel": f"Codex {label}", "remaining": round(100 - used),
                      "used": round(used), "resetsAt": resets_ms, "resetText": fmt_countdown(resets_ms, now_ms)})
    return {"id": "codex", "name": f"Codex ({plan})" if plan else "Codex", "icon": "icons/codex.svg",
            "items": items, **({"error": "No usage windows reported"} if not items else {})}


def fetch_gemini_accounts(now_ms, omp_rows):
    accounts = []
    # Collect all google-antigravity accounts from omp agent.db
    agy_entries = [(email, rows) for (prov, email), rows in omp_rows.items() if prov == "google-antigravity"]
    # Sort accounts alphabetically for consistent display order
    agy_entries.sort(key=lambda x: x[0])

    order_map = {
        ("Gemini", "5 Hour"): (1, "5h", "Gemini 5h"),
        ("Gemini", "Weekly"): (2, "7d", "Gemini 7d"),
        ("Gemini (Argon)", "Weekly"): (3, "Argon", "Gemini 4 Argon 7d"),
        ("Claude & GPT (shared)", "5 Hour"): (4, "C/G 5h", "Claude/GPT 5h"),
        ("Claude & GPT (shared)", "Weekly"): (5, "C/G 7d", "Claude/GPT 7d"),
    }

    for email, rows in agy_entries:
        short_acct = email.split("@")[0] if email else "default"
        by_key = {}
        for r in rows:
            key = (r["label"], r["window"])
            if key not in order_map:
                continue
            rank, short_lbl, full_lbl = order_map[key]
            resets_ms = r["resets_at"]
            used = r["used_fraction"] * 100.0
            if resets_ms and resets_ms <= now_ms:
                used = 0.0
            rem = max(0, min(100, round(100.0 - used)))
            # Keep the most constrained if duplicate rows exist
            if short_lbl not in by_key or rem < by_key[short_lbl]["remaining"]:
                by_key[short_lbl] = {
                    "_rank": rank,
                    "label": short_lbl,
                    "fullLabel": full_lbl,
                    "remaining": rem,
                    "used": round(used),
                    "resetsAt": resets_ms,
                    "resetText": fmt_countdown(resets_ms, now_ms),
                }
        items = [ {k: v for k, v in it.items() if k != "_rank"} for it in sorted(by_key.values(), key=lambda x: x["_rank"]) ]
        if items:
            accounts.append(
                {
                    "id": f"agy-{short_acct}",
                    "name": f"Gemini ({short_acct})",
                    "account": email,
                    "icon": "icons/antigravity.svg",
                    "items": items,
                }
            )
    return accounts


def main():
    force = "--force" in sys.argv
    now_ms = int(time.time() * 1000)

    cached = {}
    native = read_claude_statusline(now_ms)
    stale = None if native else read_claude_statusline(now_ms, allow_stale=True)
    if os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH, "r", encoding="utf-8") as f:
                cached = json.load(f)
            previous_claude = next((p for p in cached.get("providers", []) if p.get("id") == "claude"), None)
            preserved = restore_claude_observation(previous_claude, now_ms)
            current_observation = native or stale
            if preserved and (not current_observation or preserved["observedAt"] > current_observation["observedAt"]):
                if preserved["stale"]:
                    native, stale = None, preserved
                else:
                    native, stale = preserved, None
            stale_native = previous_claude and ((previous_claude.get("source") == "claude-code-statusline" and not native) or
                                                (previous_claude.get("source") == "claude-code-stale" and not (native or stale)))
            if not force and not stale_native and cached.get("schemaVersion") == 2 and now_ms - cached.get("updatedAt", 0) < TTL_SEC * 1000:
                candidate = native or (stale if previous_claude and (previous_claude.get("error") or previous_claude.get("source") == "claude-code-stale") else None)
                if candidate:
                    if previous_claude and previous_claude.get("retryAt", 0) > now_ms:
                        candidate["retryAt"] = previous_claude["retryAt"]
                    cached["providers"] = [candidate if p.get("id") == "claude" else p for p in cached.get("providers", [])]
                    # Persist observations even on a cache hit; status-line inputs can
                    # be overwritten by another Claude session without quota fields.
                    try:
                        with open(CACHE_PATH, "w", encoding="utf-8") as f:
                            json.dump(cached, f, ensure_ascii=False)
                    except OSError:
                        pass
                # Older cached results may contain the previous interface labels.
                labels = {"\u5df2\u91cd\u7f6e": "Reset", "\u672a\u767b\u5165": "Not signed in", "\u7121\u7d00\u9304": "No data"}
                for index, provider in enumerate(cached.get("providers", [])):
                    if provider.get("id") == "codex" and provider.get("error"):
                        local = fetch_codex(now_ms, {})
                        if local.get("items"):
                            cached["providers"][index] = provider = local
                    if provider.get("error") in labels:
                        provider["error"] = labels[provider["error"]]
                    for item in provider.get("items", []):
                        if item.get("resetText") in labels:
                            item["resetText"] = labels[item["resetText"]]
                print(json.dumps(cached, ensure_ascii=False))
                return
        except Exception:
            pass

    omp_rows = query_omp_db()
    previous = next((p for p in cached.get("providers", []) if p.get("id") == "claude"), None)
    # Older versions retried every two minutes. After their last 429, give the endpoint an hour to recover.
    if previous and previous.get("error") == "Rate limited; try later" and not previous.get("retryAt"):
        previous["retryAt"] = cached.get("updatedAt", now_ms) + 3600000
    retry_at = previous.get("retryAt", 0) if previous else 0
    if native and retry_at > now_ms:
        native["retryAt"] = retry_at
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        f_claude = None if native or retry_at > now_ms else ex.submit(fetch_claude, now_ms, omp_rows)
        f_codex = ex.submit(fetch_codex, now_ms, omp_rows)
        if native:
            claude_res = native
        elif f_claude:
            claude_res = f_claude.result()
        else:
            claude_res = {"id": "claude", "name": "Claude", "icon": "icons/claude.svg", "items": [],
                          "error": "Rate limited; try later", "retryAt": retry_at}
        codex_res = f_codex.result()
    if stale and claude_res.get("error"):
        if claude_res.get("retryAt", 0) > now_ms:
            stale["retryAt"] = claude_res["retryAt"]
        claude_res = stale

    gemini_list = fetch_gemini_accounts(now_ms, omp_rows)
    providers = [claude_res, codex_res, *gemini_list]

    out = {
        "schemaVersion": 2,
        "updatedAt": now_ms,
        "updatedText": datetime.datetime.now().strftime("%H:%M:%S"),
        "providers": providers,
    }
    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        with open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
    except Exception:
        pass

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
