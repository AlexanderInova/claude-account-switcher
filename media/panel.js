(function () {
  const vscode = acquireVsCodeApi();
  let state = { accounts: [], warnThreshold: 80, sync: { enabled: false, windows: 0 } };

  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");
  const syncEl = document.getElementById("syncBar");

  document.getElementById("addBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "add" });
  });
  document.getElementById("refreshBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "refreshAll" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "state") {
      state = msg;
      render();
    }
  });

  function fmtReset(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const diff = t - Date.now();
    if (diff <= 0) return "resets soon";
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `resets in ${mins} min`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hours < 24) return `resets in ${hours}h ${rem}m`;
    const days = Math.floor(hours / 24);
    return `resets in ${days}d ${hours % 24}h`;
  }

  function fmtAgo(ts, prefix) {
    if (!ts) return "no data yet";
    const diff = Date.now() - ts;
    const s = Math.round(diff / 1000);
    if (s < 60) return `${prefix} ${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${prefix} ${m} min ago`;
    const h = Math.floor(m / 60);
    return `${prefix} ${h}h ${m % 60}m ago`;
  }

  function meter(w, warn) {
    const cls = w.percent >= warn ? "danger" : w.percent >= warn * 0.75 ? "warn" : "";
    const wrap = document.createElement("div");
    wrap.className = "meter";

    const label = document.createElement("div");
    label.className = "meter-label";
    const left = document.createElement("span");
    left.textContent = w.label;
    const right = document.createElement("span");
    right.textContent = w.percent + "%";
    label.append(left, right);

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "fill " + cls;
    fill.style.width = Math.min(100, Math.max(0, w.percent)) + "%";
    bar.appendChild(fill);

    wrap.append(label, bar);
    const reset = fmtReset(w.resetsAt);
    if (reset) {
      const r = document.createElement("div");
      r.className = "reset";
      r.textContent = reset;
      wrap.appendChild(r);
    }
    return wrap;
  }

  function iconButton(text, title, onClick) {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function badge(text, cls, title) {
    const b = document.createElement("span");
    b.className = "badge" + (cls ? " " + cls : "");
    b.textContent = text;
    if (title) b.title = title;
    return b;
  }

  function card(acc, warn) {
    const el = document.createElement("div");
    el.className = "card" + (acc.isActive ? " active" : "");

    const head = document.createElement("div");
    head.className = "card-head";

    const title = document.createElement("div");
    title.className = "title";
    const name = document.createElement("span");
    name.textContent = acc.label;
    if (acc.email) name.title = acc.email;
    title.appendChild(name);

    if (acc.isActive) {
      title.appendChild(badge("active", "active"));
    } else if (acc.subscriptionType) {
      title.appendChild(badge(acc.subscriptionType));
    }
    if (!acc.updatesEnabled) {
      title.appendChild(badge("paused", "paused", "Automatic usage updates are paused"));
    }
    if (acc.suspendedReason === "rate-limit") {
      title.appendChild(badge("rate-limited", "danger-badge", "Updates suspended after a 429. Click Retry."));
    } else if (acc.suspendedReason === "invalid-grant") {
      title.appendChild(
        badge("token invalid", "danger-badge", acc.suspendedDetail || "Refresh token no longer valid. Click Retry.")
      );
    }
    head.appendChild(title);

    const headBtns = document.createElement("div");
    headBtns.className = "head-btns";
    headBtns.appendChild(
      iconButton(acc.updatesEnabled ? "⏸" : "▶", acc.updatesEnabled ? "Pause usage updates" : "Resume usage updates", () =>
        vscode.postMessage({ type: "togglePause", id: acc.id })
      )
    );
    headBtns.appendChild(
      iconButton("⟳", "Refresh usage limits", () => vscode.postMessage({ type: "refresh", id: acc.id }))
    );
    head.appendChild(headBtns);
    el.appendChild(head);

    // Parked / in-use chips.
    const chips = document.createElement("div");
    chips.className = "chips";
    const parkedChip = document.createElement("span");
    parkedChip.className = "chip";
    parkedChip.textContent = `⛁ ${acc.parkedCount} parked`;
    if (acc.invalidCount) parkedChip.textContent += ` · ${acc.invalidCount} invalid`;
    parkedChip.title = "Parked credentials available for switching";
    chips.appendChild(parkedChip);
    if (acc.inUseByOthers && acc.inUseByOthers.length) {
      const useChip = document.createElement("span");
      useChip.className = "chip";
      useChip.textContent = `in use: ${acc.inUseByOthers.join(", ")}`;
      useChip.title = "Windows where this account is currently deployed";
      chips.appendChild(useChip);
    }
    el.appendChild(chips);

    if (acc.windows && acc.windows.length) {
      for (const w of acc.windows) {
        el.appendChild(meter(w, warn));
      }
    } else if (!acc.error) {
      const s = document.createElement("div");
      s.className = "sub";
      s.style.marginTop = "8px";
      s.textContent = "No usage data — click ⟳";
      el.appendChild(s);
    }

    if (acc.error) {
      const e = document.createElement("div");
      e.className = "error";
      e.textContent = "⚠ " + acc.error;
      el.appendChild(e);
    }

    const foot = document.createElement("div");
    foot.className = "sub";
    foot.style.marginTop = "6px";
    foot.textContent = acc.error ? fmtAgo(acc.fetchedAt, "data from") : fmtAgo(acc.fetchedAt, "updated");
    el.appendChild(foot);

    const actions = document.createElement("div");
    actions.className = "actions";
    if (!acc.isActive) {
      const sw = document.createElement("button");
      sw.className = "primary";
      sw.textContent = "Switch";
      if (acc.parkedCount === 0) {
        sw.disabled = true;
        sw.title =
          acc.inUseByOthers && acc.inUseByOthers.length
            ? "No parked credential (in use in another window)"
            : "No parked credential — log in to this account in a window and park it";
      } else {
        sw.addEventListener("click", () => vscode.postMessage({ type: "switch", id: acc.id }));
      }
      actions.appendChild(sw);
    }
    if (acc.suspendedReason) {
      const retry = document.createElement("button");
      retry.textContent = "Retry";
      retry.title = "Clear the suspension and refresh now";
      retry.addEventListener("click", () => vscode.postMessage({ type: "refresh", id: acc.id }));
      actions.appendChild(retry);
    }
    actions.appendChild(
      iconButton("✎", "Rename", () => vscode.postMessage({ type: "rename", id: acc.id }))
    );
    actions.appendChild(
      iconButton("🗑", "Remove profile", () => vscode.postMessage({ type: "remove", id: acc.id }))
    );
    el.appendChild(actions);

    return el;
  }

  function renderSync() {
    if (!syncEl) return;
    const s = state.sync || {};
    if (s.enabled) {
      const n = s.windows || 1;
      syncEl.textContent = `⇄ synced · ${n} window${n === 1 ? "" : "s"}`;
      syncEl.title = s.folder ? "Store: " + s.folder : "";
      syncEl.classList.remove("warn-text");
    } else {
      syncEl.textContent = "⚠ not synced — account switching disabled";
      syncEl.title =
        "No shared store. Enable claudeSwitcher.sync.enabled or set claudeSwitcher.sync.folder.";
      syncEl.classList.add("warn-text");
    }
  }

  function render() {
    renderSync();
    listEl.innerHTML = "";
    const accounts = state.accounts || [];
    if (accounts.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    for (const acc of accounts) {
      listEl.appendChild(card(acc, state.warnThreshold || 80));
    }
  }

  // Refresh countdowns/relative times every 30s.
  setInterval(render, 30000);

  vscode.postMessage({ type: "ready" });
})();
