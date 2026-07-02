let audioContext;

async function getAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  audioContext = audioContext || new AudioCtx();
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

function showPageLoading() {
  document.body.classList.add("is-loading");
}

function hidePageLoading() {
  document.body.classList.remove("is-loading");
}

function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle("is-loading", loading);
  button.toggleAttribute("aria-busy", loading);
  if (loading) {
    if (!Object.prototype.hasOwnProperty.call(button.dataset, "originalDisabled")) {
      button.dataset.originalDisabled = String(button.disabled);
    }
    button.disabled = true;
  } else {
    button.disabled = button.dataset.originalDisabled === "true";
    delete button.dataset.originalDisabled;
  }
}

function setFormSubmitting(form, submitter) {
  if (!form || form.classList.contains("is-submitting")) return;
  form.classList.add("is-submitting");
  form.querySelectorAll('button[type="submit"]').forEach((button) => setButtonLoading(button, true));
  if (submitter && submitter.matches("button")) setButtonLoading(submitter, true);
  showPageLoading();
}

async function playTone(kind) {
  const context = await getAudioContext();
  if (!context) return;
  const now = context.currentTime;
  const gain = context.createGain();
  const oscillator = context.createOscillator();
  const settings = {
    add: { start: 640, end: 980, duration: 0.11, volume: 0.09 },
    remove: { start: 460, end: 260, duration: 0.12, volume: 0.075 },
    delete: { start: 260, end: 150, duration: 0.16, volume: 0.09 },
  }[kind] || { start: 520, end: 520, duration: 0.09, volume: 0.07 };

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(settings.start, now);
  oscillator.frequency.exponentialRampToValueAtTime(settings.end, now + settings.duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(settings.volume, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + settings.duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + settings.duration + 0.015);
}

document.addEventListener("click", async (event) => {
  const authNote = event.target.closest("[data-auth-note]");
  if (authNote) {
    event.preventDefault();
    showShortcutHint(authNote.dataset.authNote || "Please contact the owner/admin for help.");
    return;
  }

  const toggle = event.target.closest("[data-toggle-password]");
  if (toggle) {
    const input = document.querySelector(toggle.dataset.togglePassword);
    if (input) {
      input.type = input.type === "password" ? "text" : "password";
      toggle.textContent = input.type === "password" ? "Show" : "Hide";
    }
  }

  const add = event.target.closest("[data-add-line]");
  if (add) {
    const grid = add.previousElementSibling;
    const row = grid && grid.querySelector(".line-row");
    if (grid && row) {
      const clone = row.cloneNode(true);
      clone.querySelectorAll("input").forEach((input) => (input.value = ""));
      clone.querySelectorAll("output").forEach((output) => (output.textContent = "₹0.00"));
      clone.querySelectorAll("[data-item-picker], [data-option-picker]").forEach((picker) => {
        delete picker.dataset.itemPickerReady;
        delete picker.dataset.optionPickerReady;
      });
      clone.classList.add("row-enter");
      grid.appendChild(clone);
      initializeItemPickers(clone);
      syncTransactionGstFields(add.closest("form"));
      updateLineTotal(clone);
      updateDocumentTotal(add.closest("form"));
      playTone("add");
      window.setTimeout(() => clone.classList.remove("row-enter"), 220);
    }
  }

  const remove = event.target.closest("[data-remove-line]");
  if (remove) {
    const grid = remove.closest("[data-line-grid]");
    const rows = grid.querySelectorAll(".line-row");
    if (rows.length > 1) {
      const row = remove.closest(".line-row");
      row.classList.add("row-exit");
      playTone("remove");
      window.setTimeout(() => {
        const form = grid.closest("form");
        row.remove();
        updateDocumentTotal(form);
      }, 150);
    }
  }

  const auto = event.target.closest("[data-auto-ref]");
  if (auto) {
    const target = document.querySelector(auto.dataset.target);
    if (!target) return;
    setButtonLoading(auto, true);
    showPageLoading();
    try {
      const response = await fetch(`/transactions/reference/${auto.dataset.autoRef}`);
      if (!response.ok) throw new Error("Reference request failed");
      const data = await response.json();
      target.value = data.reference;
    } finally {
      setButtonLoading(auto, false);
      hidePageLoading();
    }
  }

  const liveFind = event.target.closest("[data-live-find]");
  if (liveFind) {
    const form = liveFind.closest("[data-live-search-form]");
    const input = form && form.querySelector("[data-live-search]");
    applyLiveSearch(input);
  }

  const customerJumpButton = event.target.closest("[data-customer-jump-form] button");
  if (customerJumpButton) {
    event.preventDefault();
    openCustomerJump(customerJumpButton.closest("[data-customer-jump-form]"));
  }

  const itemOpen = event.target.closest("[data-item-open], [data-option-open]");
  if (itemOpen) {
    const picker = itemOpen.closest("[data-item-picker], [data-option-picker]");
    const input = picker && picker.querySelector("[data-item-search], [data-option-search]");
    if (input) {
      input.focus();
      if (typeof input.showPicker === "function") input.showPicker();
    }
  }
});

const APP_ICON_PATHS = {
  "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  "arrow-left-right": '<path d="M8 7h13"/><path d="m18 4 3 3-3 3"/><path d="M16 17H3"/><path d="m6 20-3-3 3-3"/>',
  "boxes": '<path d="M2.97 12.92 12 18.14l9.03-5.22"/><path d="M2.97 7.08 12 12.3l9.03-5.22"/><path d="M12 2 2.97 7.08 12 12.3l9.03-5.22L12 2Z"/><path d="M12 12.3v9.7"/>',
  "building-2": '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18"/><path d="M6 12H4a2 2 0 0 0-2 2v8"/><path d="M18 9h2a2 2 0 0 1 2 2v11"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  "chart-no-axes-combined": '<path d="M12 16v5"/><path d="M16 14v7"/><path d="M20 10v11"/><path d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.708 0L2 15"/><path d="M4 18v3"/><path d="M8 14v7"/>',
  "chevrons-left": '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
  "circle": '<circle cx="12" cy="12" r="9"/>',
  "calculator": '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/>',
  "calendar-days": '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>',
  "credit-card": '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/>',
  "folder-open": '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6A2 2 0 0 1 18.46 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4.9a2 2 0 0 1 1.69.93l1.15 1.82H20a2 2 0 0 1 2 2v2"/>',
  "gem": '<path d="M6 3h12l4 6-10 12L2 9l4-6Z"/><path d="M11 3 8 9l4 12 4-12-3-6"/><path d="M2 9h20"/>',
  "headphones": '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  "keyboard": '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="14" x="2" y="5" rx="2"/>',
  "layout-dashboard": '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  "more-horizontal": '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  "moon": '<path d="M12 3a6 6 0 0 0 9 7.2A9 9 0 1 1 12 3Z"/>',
  "panel-left": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  "panel-right": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  "pause": '<rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/>',
  "play": '<path d="m6 3 15 9-15 9V3Z"/>',
  "receipt-text": '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1Z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/>',
  "repeat": '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  "search": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  "shopping-bag": '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  "skip-back": '<path d="M19 20 9 12l10-8v16Z"/><path d="M5 19V5"/>',
  "skip-forward": '<path d="m5 4 10 8-10 8V4Z"/><path d="M19 5v14"/>',
  "truck": '<path d="M14 18V6a2 2 0 0 0-2-2H3v14h2"/><path d="M15 18H9"/><path d="M19 18h2v-6l-3-5h-4"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  "user-cog": '<circle cx="18" cy="15" r="3"/><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h5"/><path d="m21.7 16.4-.9-.3"/><path d="m15.2 13.9-.9-.3"/><path d="m16.6 18.7.3-.9"/><path d="m19.1 12.2.3-.9"/><path d="m19.6 18.7-.4-.9"/><path d="m16.8 12.2-.4-.9"/>',
  "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  "volume-2": '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  "volume-x": '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  "wallet-cards": '<rect width="18" height="14" x="3" y="5" rx="2"/><path d="M3 10h18"/><path d="M7 15h.01"/><path d="M11 15h2"/>',
};

function iconSvg(name) {
  const paths = APP_ICON_PATHS[name] || APP_ICON_PATHS.circle;
  const span = document.createElement("span");
  span.className = "app-icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24">${paths}</svg>`;
  return span;
}

function renderAppIcons(root = document) {
  const iconTargets = [];
  if (root.matches?.("[data-icon]")) iconTargets.push(root);
  iconTargets.push(...Array.from(root.querySelectorAll?.("[data-icon]") || []));
  iconTargets.forEach((target) => {
    if (target.dataset.iconReady === "true") return;
    target.textContent = "";
    target.appendChild(iconSvg(target.dataset.icon));
    target.dataset.iconReady = "true";
  });
  root.querySelectorAll(".nav a[data-nav-icon]").forEach((link) => {
    if (link.dataset.iconReady === "true") return;
    link.prepend(iconSvg(link.dataset.navIcon));
    link.dataset.iconReady = "true";
  });
}

function initializeThemeControls() {
  const toggle = document.querySelector("[data-theme-toggle]");
  const saved = localStorage.getItem("fastockflow-theme");
  if (saved === "dark") document.documentElement.dataset.theme = "dark";
  updateThemeToggle(toggle);
  toggle?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    if (next === "dark") {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem("fastockflow-theme", "dark");
    } else {
      delete document.documentElement.dataset.theme;
      localStorage.setItem("fastockflow-theme", "light");
    }
    updateThemeToggle(toggle);
  });
}

function updateThemeToggle(toggle) {
  if (!toggle) return;
  const dark = document.documentElement.dataset.theme === "dark";
  toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  const holder = toggle.querySelector("[data-icon]");
  if (holder) {
    holder.dataset.icon = dark ? "sun" : "moon";
    holder.dataset.iconReady = "false";
    renderAppIcons(holder);
  }
}

APP_ICON_PATHS.sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>';

function initializeSidebarControls() {
  const toggle = document.querySelector("[data-sidebar-toggle]");
  const hide = document.querySelector("[data-sidebar-hide]");
  const show = document.querySelector("[data-sidebar-show]");
  const setState = (state) => {
    const next = ["expanded", "collapsed", "hidden"].includes(state) ? state : "expanded";
    document.body.classList.toggle("sidebar-collapsed", next === "collapsed");
    document.body.classList.toggle("sidebar-hidden", next === "hidden");
    localStorage.setItem("fastockflow-sidebar", next);
    toggle?.setAttribute("aria-expanded", String(next === "expanded"));
    toggle?.setAttribute("aria-label", next === "collapsed" ? "Expand sidebar" : "Minimize sidebar");
    toggle?.setAttribute("title", next === "collapsed" ? "Expand sidebar" : "Minimize sidebar");
    hide?.setAttribute("aria-expanded", String(next !== "hidden"));
    show?.setAttribute("aria-expanded", String(next !== "hidden"));
  };

  setState(localStorage.getItem("fastockflow-sidebar") || "expanded");

  toggle?.addEventListener("click", () => {
    setState(document.body.classList.contains("sidebar-collapsed") ? "expanded" : "collapsed");
  });
  hide?.addEventListener("click", () => setState("hidden"));
  show?.addEventListener("click", () => setState("expanded"));
}

function initializeScrollShadow() {
  const update = () => document.body.classList.toggle("has-scrolled", window.scrollY > 8);
  update();
  window.addEventListener("scroll", update, { passive: true });
}

function initializeGlobalSearch() {
  const input = document.querySelector("[data-global-search]");
  if (!input) return;
  input.addEventListener("input", () => {
    const query = normalizeSearchText(input.value);
    document.querySelectorAll("main .panel, main .metric-card, main .report-card, main .hero-panel").forEach((section) => {
      if (section.closest(".topbar")) return;
      const visible = !query || normalizeSearchText(section.textContent).includes(query);
      section.classList.toggle("is-search-hidden", !visible);
    });
    document.querySelectorAll("main table tbody tr").forEach((row) => {
      if (row.matches("[data-live-empty], .empty")) return;
      row.hidden = Boolean(query) && !normalizeSearchText(row.textContent).includes(query);
    });
    updateReportTotals();
    updateOutstandingSummary();
  });
}

function initializeDashboardVisuals() {
  document.querySelectorAll("[data-auto-bars]").forEach((group) => {
    const rows = Array.from(group.querySelectorAll("[data-bar-value]"));
    const values = rows.map((row) => Math.abs(parseMoneyText(row.dataset.barValue)));
    const max = Math.max(1, ...values);
    rows.forEach((row) => {
      const value = Math.abs(parseMoneyText(row.dataset.barValue));
      row.style.setProperty("--bar-width", `${Math.max(4, Math.round((value / max) * 100))}%`);
    });
  });
  document.querySelectorAll("[data-split-chart]").forEach((chart) => {
    const segments = Array.from(chart.querySelectorAll("[data-split-segment]"));
    const values = segments.map((segment) => Math.max(0, parseMoneyText(segment.dataset.splitValue)));
    const total = values.reduce((sum, value) => sum + value, 0) || 1;
    segments.forEach((segment, index) => {
      segment.style.setProperty("--split-width", `${Math.max(6, (values[index] / total) * 100)}%`);
    });
  });
}

function initializeCounters() {
  const targets = Array.from(document.querySelectorAll("[data-count-value]"));
  const animate = (target) => {
    if (target.dataset.countDone === "true") return;
    target.dataset.countDone = "true";
    const raw = target.textContent.trim();
    const end = Number.parseFloat(raw.replace(/,/g, ""));
    if (!Number.isFinite(end)) return;
    const duration = 620;
    const startTime = performance.now();
    const decimals = raw.includes(".") ? Math.min(3, (raw.split(".")[1] || "").length) : 0;
    const step = (now) => {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = end * eased;
      target.textContent = decimals ? value.toFixed(decimals).replace(/\.?0+$/, "") : String(Math.round(value));
      if (progress < 1) requestAnimationFrame(step);
      else target.textContent = raw;
    };
    requestAnimationFrame(step);
  };
  if (!("IntersectionObserver" in window)) {
    targets.forEach(animate);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        animate(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.4 });
  targets.forEach((target) => observer.observe(target));
}

function initializeRipples() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".primary-button, .secondary-button, .icon-button, .table-action, .floating-tool-button, .music-controls button");
    if (!button || button.classList.contains("link-button")) return;
    const rect = button.getBoundingClientRect();
    const ripple = document.createElement("span");
    const size = Math.max(rect.width, rect.height) * 1.8;
    ripple.className = "button-ripple";
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    button.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 560);
  });
}

const focusModeState = {
  initialized: false,
  playing: false,
  muted: false,
  loop: false,
  track: "rain",
  volume: 0.45,
  gain: null,
  nodes: [],
  timers: [],
};

const FOCUS_TRACKS = ["rain", "ocean", "piano", "forest", "coffee", "lofi"];
const FOCUS_TRACK_NAMES = {
  rain: "Rain",
  ocean: "Ocean Waves",
  piano: "Soft Piano",
  forest: "Forest",
  coffee: "Coffee Shop",
  lofi: "Lo-fi Instrumental",
};

function initializeFocusMode(panel) {
  if (!panel || panel.dataset.focusReady === "true") return;
  panel.dataset.focusReady = "true";
  const saved = JSON.parse(localStorage.getItem("fastockflow-focus-mode") || "{}");
  focusModeState.track = saved.track || "rain";
  focusModeState.volume = Number.isFinite(saved.volume) ? saved.volume : Number(saved.volume || 0.45);
  focusModeState.muted = Boolean(saved.muted);
  focusModeState.loop = Boolean(saved.loop);

  const track = panel.querySelector("[data-music-track]");
  const volume = panel.querySelector("[data-music-volume]");
  if (track) track.value = focusModeState.track;
  if (volume) volume.value = String(Math.round(focusModeState.volume * 100));
  panel.querySelector("[data-music-loop]")?.classList.toggle("is-active", focusModeState.loop);
  updateFocusModeUi(panel);
}

function saveFocusModePrefs() {
  localStorage.setItem("fastockflow-focus-mode", JSON.stringify({
    track: focusModeState.track,
    volume: focusModeState.volume,
    muted: focusModeState.muted,
    loop: focusModeState.loop,
  }));
}

function updateFocusModeUi(panel = document.querySelector("[data-tool-panel='music']")) {
  if (!panel) return;
  panel.classList.toggle("is-playing", focusModeState.playing);
  const name = panel.querySelector("[data-music-track-name]");
  const status = panel.querySelector("[data-music-status]");
  const toggle = panel.querySelector("[data-music-toggle]");
  const mute = panel.querySelector("[data-music-mute]");
  if (name) name.textContent = FOCUS_TRACK_NAMES[focusModeState.track] || "Focus";
  if (status) status.textContent = focusModeState.playing ? "Playing softly" : "Ready when you are";
  toggle?.classList.toggle("is-playing", focusModeState.playing);
  mute?.classList.toggle("is-active", focusModeState.muted);
  const toggleIcon = toggle?.querySelector("[data-icon]");
  if (toggleIcon) {
    toggleIcon.dataset.icon = focusModeState.playing ? "pause" : "play";
    toggleIcon.dataset.iconReady = "false";
  }
  const muteIcon = mute?.querySelector("[data-icon]");
  if (muteIcon) {
    muteIcon.dataset.icon = focusModeState.muted ? "volume-x" : "volume-2";
    muteIcon.dataset.iconReady = "false";
  }
  renderAppIcons(panel);
}

async function startFocusMode() {
  const context = await getAudioContext();
  if (!context) return;
  stopFocusMode(false);
  focusModeState.gain = context.createGain();
  focusModeState.gain.gain.value = focusModeState.muted ? 0 : focusModeState.volume;
  focusModeState.gain.connect(context.destination);
  buildFocusTrack(context, focusModeState.track);
  focusModeState.playing = true;
  updateFocusModeUi();
}

function stopFocusMode(update = true) {
  focusModeState.timers.forEach((timer) => window.clearInterval(timer));
  focusModeState.timers = [];
  focusModeState.nodes.forEach((node) => {
    try {
      if (typeof node.stop === "function") node.stop();
      if (typeof node.disconnect === "function") node.disconnect();
    } catch (_) {
      // Node may already be stopped.
    }
  });
  focusModeState.nodes = [];
  try {
    focusModeState.gain?.disconnect();
  } catch (_) {
    // Gain may already be disconnected.
  }
  focusModeState.gain = null;
  focusModeState.playing = false;
  if (update) updateFocusModeUi();
}

function connectFocusNode(node) {
  node.connect(focusModeState.gain);
  focusModeState.nodes.push(node);
  return node;
}

function makeNoiseBuffer(context, seconds = 2, intensity = 1) {
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < data.length; index += 1) {
    last = (last + (Math.random() * 2 - 1) * intensity) / 2;
    data[index] = last;
  }
  return buffer;
}

function addNoise(context, filterFrequency, gainValue, type = "lowpass") {
  const source = context.createBufferSource();
  source.buffer = makeNoiseBuffer(context, 3);
  source.loop = true;
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = filterFrequency;
  const gain = context.createGain();
  gain.gain.value = gainValue;
  source.connect(filter);
  filter.connect(gain);
  connectFocusNode(gain);
  focusModeState.nodes.push(source, filter);
  source.start();
}

function addDrone(context, frequency, gainValue, type = "sine") {
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  const gain = context.createGain();
  gain.gain.value = gainValue;
  oscillator.connect(gain);
  connectFocusNode(gain);
  focusModeState.nodes.push(oscillator);
  oscillator.start();
}

function addPluck(context, frequency, delay = 0) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  const start = context.currentTime + delay;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.06, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.7);
  oscillator.connect(gain);
  gain.connect(focusModeState.gain);
  oscillator.start(start);
  oscillator.stop(start + 1.8);
  focusModeState.nodes.push(oscillator, gain);
}

function buildFocusTrack(context, track) {
  if (track === "rain") {
    addNoise(context, 1800, 0.18, "bandpass");
    addNoise(context, 5800, 0.04, "highpass");
  } else if (track === "ocean") {
    addNoise(context, 460, 0.16, "lowpass");
    addDrone(context, 0.08, 0.04, "sine");
  } else if (track === "piano") {
    const notes = [261.63, 329.63, 392.0, 493.88, 392.0, 329.63];
    let step = 0;
    addNoise(context, 900, 0.018, "lowpass");
    focusModeState.timers.push(window.setInterval(() => {
      addPluck(context, notes[step % notes.length]);
      step += 1;
    }, 900));
    addPluck(context, notes[0]);
  } else if (track === "forest") {
    addNoise(context, 1200, 0.08, "bandpass");
    focusModeState.timers.push(window.setInterval(() => {
      addPluck(context, 880 + Math.random() * 520);
    }, 1800));
  } else if (track === "coffee") {
    addNoise(context, 700, 0.08, "lowpass");
    focusModeState.timers.push(window.setInterval(() => {
      addPluck(context, 1200 + Math.random() * 420);
    }, 2600));
  } else if (track === "lofi") {
    addNoise(context, 1200, 0.04, "lowpass");
    [196, 246.94, 293.66].forEach((freq) => addDrone(context, freq, 0.025, "triangle"));
  }
}

document.addEventListener("click", async (event) => {
  if (event.target.closest("[data-music-toggle]")) {
    if (focusModeState.playing) stopFocusMode();
    else await startFocusMode();
    saveFocusModePrefs();
    return;
  }
  if (event.target.closest("[data-music-prev], [data-music-next]")) {
    const direction = event.target.closest("[data-music-prev]") ? -1 : 1;
    const current = FOCUS_TRACKS.indexOf(focusModeState.track);
    const next = (current + direction + FOCUS_TRACKS.length) % FOCUS_TRACKS.length;
    focusModeState.track = FOCUS_TRACKS[next];
    const panel = event.target.closest("[data-tool-panel='music']");
    const select = panel?.querySelector("[data-music-track]");
    if (select) select.value = focusModeState.track;
    if (focusModeState.playing) await startFocusMode();
    updateFocusModeUi(panel);
    saveFocusModePrefs();
    return;
  }
  if (event.target.closest("[data-music-mute]")) {
    focusModeState.muted = !focusModeState.muted;
    if (focusModeState.gain) focusModeState.gain.gain.value = focusModeState.muted ? 0 : focusModeState.volume;
    updateFocusModeUi(event.target.closest("[data-tool-panel='music']"));
    saveFocusModePrefs();
    return;
  }
  if (event.target.closest("[data-music-loop]")) {
    focusModeState.loop = !focusModeState.loop;
    event.target.closest("[data-music-loop]").classList.toggle("is-active", focusModeState.loop);
    saveFocusModePrefs();
  }
});

document.addEventListener("input", async (event) => {
  if (event.target.matches("[data-music-volume]")) {
    focusModeState.volume = Math.max(0, Math.min(1, Number(event.target.value) / 100));
    if (focusModeState.gain && !focusModeState.muted) focusModeState.gain.gain.value = focusModeState.volume;
    saveFocusModePrefs();
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.matches("[data-music-track]")) {
    focusModeState.track = event.target.value;
    if (focusModeState.playing) await startFocusMode();
    updateFocusModeUi(event.target.closest("[data-tool-panel='music']"));
    saveFocusModePrefs();
  }
});

const SHORTCUT_GUIDE = [
  ["F1", "Help / shortcut list"],
  ["F2", "Date"],
  ["F3", "Company"],
  ["F4", "Contra / transfer voucher"],
  ["F5", "Payment"],
  ["F6", "Receipt"],
  ["F7", "Journal / opening voucher"],
  ["F8", "Sales"],
  ["F9", "Purchase"],
  ["F10", "Other vouchers"],
  ["F12", "Configure / shortcut list"],
  ["E", "Autofill document number"],
  ["H", "Change mode, for example GST/CASH"],
  ["I", "More details / remarks"],
  ["O", "Related reports"],
  ["L", "Optional / due-date field"],
  ["T", "Post-dated / due-date field"],
  ["J", "Stat adjustment / GST field"],
  ["Esc / Alt + ←", "Go back"],
  ["Ctrl + F", "Focus page search"],
  ["Ctrl + S / Ctrl + Enter", "Save current form"],
  ["Alt + A / Alt + N", "Add line or add entry"],
  ["Alt + E", "Edit selected row"],
  ["Alt + D", "Delete selected row"],
  ["Ctrl + P", "Print selected row or current page"],
  ["Alt + P", "Open PDF for selected row/report"],
  ["Alt + X", "Open XL/XLSX for selected row/report"],
];

let shortcutToastTimer;
const SHORTCUT_INTENT_KEY = "fastockflow:shortcut-intent";

function initializeKeyboardShortcuts() {
  if (document.body.dataset.shortcutsReady === "true") return;
  document.body.dataset.shortcutsReady = "true";
  document.addEventListener("keydown", handleKeyboardShortcut);
}

function handleKeyboardShortcut(event) {
  if (event.defaultPrevented || event.isComposing) return;
  const key = event.key.toLowerCase();
  const primaryKey = event.ctrlKey || event.metaKey;
  const typing = isEditableShortcutTarget(event.target);

  if (key === "f1") {
    event.preventDefault();
    showShortcutHelp();
    return;
  }

  if (key === "escape") {
    if (document.querySelector("[data-action-menu].is-open")) {
      closeActionMenus();
      event.preventDefault();
      return;
    }
    if (closeShortcutHelp()) {
      event.preventDefault();
      return;
    }
    if (typing) return;
    event.preventDefault();
    navigateBack();
    return;
  }

  if (event.altKey && key === "arrowleft") {
    event.preventDefault();
    navigateBack();
    return;
  }

  if (primaryKey && key === "f") {
    event.preventDefault();
    focusPageSearch();
    return;
  }

  if (primaryKey && (key === "s" || key === "enter")) {
    event.preventDefault();
    saveCurrentForm();
    return;
  }

  if (primaryKey && key === "p") {
    event.preventDefault();
    triggerPrintShortcut();
    return;
  }

  if (/^f\d{1,2}$/.test(key)) {
    event.preventDefault();
    handleTallyFunctionKey(key);
    return;
  }

  if (typing && !event.altKey) return;

  if (!event.altKey && !primaryKey) {
    const handled = handleTallyLetterKey(key);
    if (handled) {
      event.preventDefault();
      return;
    }
  }

  if (event.altKey && key === "f") {
    event.preventDefault();
    triggerFindShortcut();
    return;
  }

  if (event.altKey && (key === "a" || key === "n")) {
    event.preventDefault();
    triggerAddShortcut();
    return;
  }

  if ((event.altKey && key === "e") || key === "f2") {
    event.preventDefault();
    triggerActionShortcut([/\bedit\b/], "Edit selected row", "Select a row first, then press F2 or Alt+E");
    return;
  }

  if (event.altKey && key === "d") {
    event.preventDefault();
    triggerActionShortcut([/\bdelete\b/, /\bdeactivate\b/], "Delete selected row", "Select a row first, then press Alt+D", true);
    return;
  }

  if (event.altKey && key === "p") {
    event.preventDefault();
    triggerActionShortcut([/\bpdf\b/, /\bopen pdf\b/], "Open PDF", "No PDF action found on this page");
    return;
  }

  if (event.altKey && key === "x") {
    event.preventDefault();
    triggerActionShortcut([/\bxl\b/, /\bxlsx\b/, /\bcsv\b/], "Open spreadsheet export", "No XL/XLSX action found on this page");
    return;
  }

  if (event.altKey && key === "c") {
    event.preventDefault();
    openFloatingToolShortcut("calculator");
    return;
  }

  if (event.altKey && key === "l") {
    event.preventDefault();
    openFloatingToolShortcut("calendar");
    return;
  }

  if (event.altKey && /^[1-9]$/.test(key)) {
    event.preventDefault();
    openSidebarShortcut(Number(key));
  }
}

function handleTallyFunctionKey(key) {
  const actions = {
    f1: () => showShortcutHelp(),
    f2: () => focusDateShortcut(),
    f3: () => focusCompanyShortcut(),
    f4: () => navigateShortcut("/transactions/transfer", "Contra / transfer voucher"),
    f5: () => openPaymentVoucherShortcut(),
    f6: () => openReceiptVoucherShortcut(),
    f7: () => navigateShortcut("/transactions/opening", "Journal / opening voucher"),
    f8: () => navigateShortcut("/transactions/sale", "Sales voucher"),
    f9: () => navigateShortcut("/transactions/purchase", "Purchase voucher"),
    f10: () => navigateShortcut("/transactions/opening", "Other vouchers"),
    f12: () => showShortcutHelp(),
  };
  const action = actions[key];
  if (action) action();
}

function handleTallyLetterKey(key) {
  const actions = {
    e: () => triggerAutoFillShortcut(),
    h: () => changeModeShortcut(),
    i: () => focusMoreDetailsShortcut(),
    o: () => openRelatedReportShortcut(),
    l: () => focusOptionalShortcut(),
    t: () => focusPostDatedShortcut(),
    j: () => focusStatAdjustmentShortcut(),
  };
  const action = actions[key];
  if (!action) return false;
  action();
  return true;
}

function isEditableShortcutTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isShortcutVisible(element) {
  if (!element || element.hidden) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function visibleShortcutElements(selector, root = document) {
  return Array.from(root.querySelectorAll(selector)).filter(isShortcutVisible);
}

function navigateBack() {
  const button = document.querySelector("[data-back-button]");
  const fallback = button?.dataset.backFallback || "/";
  try {
    const referrer = document.referrer ? new URL(document.referrer) : null;
    if (referrer && referrer.origin === window.location.origin && window.history.length > 1) {
      window.history.back();
      return;
    }
  } catch (_) {
    // Fall through to the in-app fallback below.
  }
  window.location.assign(fallback);
}

function focusPageSearch() {
  const input = visibleShortcutElements("[data-live-search]")[0] || visibleShortcutElements("[data-global-search]")[0];
  if (!input) {
    showShortcutHint("No search box found on this page");
    return false;
  }
  input.focus();
  input.select?.();
  showShortcutHint("Search focused");
  return true;
}

function triggerFindShortcut() {
  const activeForm = document.activeElement?.closest?.("[data-live-search-form]");
  const button = activeForm?.querySelector("[data-live-find]") || visibleShortcutElements("[data-live-find]")[0];
  if (button) {
    button.click();
    showShortcutHint("Find applied");
    return true;
  }
  return focusPageSearch();
}

function saveCurrentForm() {
  const activeForm = document.activeElement?.closest?.("form");
  const activeSubmit = activeForm && primarySubmitButton(activeForm);
  const button = activeSubmit || visibleShortcutElements("form .primary-button[type='submit'], form button[type='submit'].primary-button")[0];
  if (!button) {
    showShortcutHint("No save button found on this page");
    return false;
  }
  button.click();
  showShortcutHint("Save shortcut");
  return true;
}

function primarySubmitButton(form) {
  return visibleShortcutElements(".primary-button[type='submit'], button[type='submit'].primary-button", form)[0];
}

function triggerAddShortcut() {
  const activeForm = document.activeElement?.closest?.("form");
  const addLine = (activeForm && visibleShortcutElements("[data-add-line]", activeForm)[0]) || visibleShortcutElements("[data-add-line]")[0];
  if (addLine) {
    addLine.click();
    showShortcutHint("Line added");
    return true;
  }
  return triggerActionShortcut([/^add$/, /\badd\b/], "Add shortcut", "No add action found on this page");
}

function triggerPrintShortcut() {
  if (triggerActionShortcut([/\bprint\b/], "Print", "", false, true)) return true;
  window.print();
  showShortcutHint("Print current page");
  return true;
}

function triggerActionShortcut(patterns, successMessage, missingMessage, selectedOnly = false, quietMissing = false) {
  const selectedRows = visibleShortcutElements("tbody tr.is-row-selected");
  const roots = selectedRows.length ? selectedRows : [];
  for (const root of roots) {
    const action = findActionByLabel(root, patterns);
    if (action) return clickShortcutAction(action, successMessage);
  }
  if (!selectedOnly) {
    const action = findActionByLabel(document, patterns);
    if (action) return clickShortcutAction(action, successMessage);
  }
  if (!quietMissing && missingMessage) showShortcutHint(missingMessage);
  return false;
}

function findActionByLabel(root, patterns) {
  return visibleShortcutElements("a, button", root).find((element) => {
    if (element.disabled || element.closest("[data-shortcut-help], [data-back-button], [data-theme-toggle]")) return false;
    const label = normalizeSearchText(
      [
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.value,
      ]
        .filter(Boolean)
        .join(" ")
    );
    return patterns.some((pattern) => pattern.test(label));
  });
}

function clickShortcutAction(action, message) {
  action.focus?.({ preventScroll: true });
  action.click();
  if (message) showShortcutHint(message);
  return true;
}

function openFloatingToolShortcut(name) {
  const button = visibleShortcutElements(`[data-tool-toggle="${name}"]`)[0];
  if (!button) {
    showShortcutHint(`${name === "calendar" ? "Calendar" : "Calculator"} is not available here`);
    return false;
  }
  button.click();
  showShortcutHint(name === "calendar" ? "Calendar opened" : "Calculator opened");
  return true;
}

function openSidebarShortcut(position) {
  const links = visibleShortcutElements(".nav a");
  const link = links[position - 1];
  if (!link) {
    showShortcutHint(`No sidebar item at Alt+${position}`);
    return false;
  }
  link.click();
  return true;
}

function navigateShortcut(path, message, intentAction = "") {
  if (intentAction) {
    sessionStorage.setItem(
      SHORTCUT_INTENT_KEY,
      JSON.stringify({ action: intentAction, createdAt: Date.now() })
    );
  }
  if (window.location.pathname === path) {
    if (intentAction) runShortcutIntent(intentAction);
    showShortcutHint(message);
    return true;
  }
  showShortcutHint(message);
  window.location.assign(path);
  return true;
}

function consumeShortcutIntent() {
  let intent;
  try {
    intent = JSON.parse(sessionStorage.getItem(SHORTCUT_INTENT_KEY) || "null");
  } catch (_) {
    intent = null;
  }
  sessionStorage.removeItem(SHORTCUT_INTENT_KEY);
  if (!intent || !intent.action || Date.now() - Number(intent.createdAt || 0) > 15000) return;
  window.setTimeout(() => runShortcutIntent(intent.action), 120);
}

function runShortcutIntent(action) {
  if (action === "payment") {
    focusPaymentVoucherForm("payment");
    return;
  }
  if (action === "receipt") {
    focusPaymentVoucherForm("receipt");
    return;
  }
  if (action === "date") {
    focusDateShortcut();
    return;
  }
  if (action === "company") {
    focusCompanyShortcut();
  }
}

function openPaymentVoucherShortcut() {
  if (window.location.pathname === "/finance/payments") {
    return focusPaymentVoucherForm("payment");
  }
  return navigateShortcut("/finance/payments", "Payment voucher", "payment");
}

function openReceiptVoucherShortcut() {
  if (window.location.pathname === "/finance/payments") {
    return focusPaymentVoucherForm("receipt");
  }
  return navigateShortcut("/finance/payments", "Receipt voucher", "receipt");
}

function focusPaymentVoucherForm(kind) {
  const actionNeedle = kind === "receipt" ? "customer-receipt" : "supplier-payment";
  const form = Array.from(document.querySelectorAll("form")).find((candidate) =>
    String(candidate.getAttribute("action") || "").includes(actionNeedle)
  );
  if (!form) {
    showShortcutHint(kind === "receipt" ? "Receipt form not found" : "Payment form not found");
    return false;
  }
  const selector =
    kind === "receipt"
      ? 'input[name="customer_search"], select[name="receivable_id"], input[name="amount"]'
      : 'input[name="supplier_search"], select[name="payable_id"], input[name="amount"]';
  const target = visibleShortcutElements(selector, form)[0] || visibleShortcutElements("input, select, textarea", form)[0];
  focusShortcutElement(target, kind === "receipt" ? "Receipt voucher ready" : "Payment voucher ready");
  return true;
}

function focusDateShortcut() {
  const form = document.activeElement?.closest?.("form");
  const selector =
    'input[type="date"], input[name="invoice_date"], input[name="bill_date"], input[name="payment_date"], input[name="due_date"], input[name="date_from"], input[name="date_to"]';
  const target = (form && visibleShortcutElements(selector, form)[0]) || visibleShortcutElements(selector)[0];
  if (!target) {
    showShortcutHint("No date field found");
    return false;
  }
  return focusShortcutElement(target, "Date field focused", true);
}

function focusCompanyShortcut() {
  const form = document.activeElement?.closest?.("form");
  const selector = 'select[name="company_id"], select[name="from_company_id"], select[name="to_company_id"]';
  const target = (form && visibleShortcutElements(selector, form)[0]) || visibleShortcutElements(selector)[0];
  if (target) return focusShortcutElement(target, "Company field focused");
  const switcher = visibleShortcutElements(".footer-company-form button, .company-chip")[0];
  if (switcher) return focusShortcutElement(switcher, "Company switcher focused");
  return navigateShortcut("/company/choose", "Company selector");
}

function triggerAutoFillShortcut() {
  const form = document.activeElement?.closest?.("form");
  const button = (form && visibleShortcutElements("[data-auto-ref]", form)[0]) || visibleShortcutElements("[data-auto-ref]")[0];
  if (!button) {
    showShortcutHint("No autofill button on this page");
    return false;
  }
  button.click();
  showShortcutHint("Autofill applied");
  return true;
}

function changeModeShortcut() {
  const form = document.activeElement?.closest?.("form");
  const selector = 'select[name="sale_type"], select[name="purchase_type"]';
  const mode = (form && visibleShortcutElements(selector, form)[0]) || visibleShortcutElements(selector)[0];
  if (mode) {
    const current = mode.value;
    const next = Array.from(mode.options).find((option) => option.value !== current);
    if (next) {
      mode.value = next.value;
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      showShortcutHint(`Mode changed to ${next.textContent.trim() || next.value}`);
      return true;
    }
  }
  const paymentMode = (form && visibleShortcutElements('select[name="mode"]', form)[0]) || visibleShortcutElements('select[name="mode"]')[0];
  if (paymentMode) return focusShortcutElement(paymentMode, "Payment mode focused");
  showShortcutHint("No mode field found");
  return false;
}

function focusMoreDetailsShortcut() {
  const form = document.activeElement?.closest?.("form");
  const target = (form && visibleShortcutElements("textarea", form)[0]) || visibleShortcutElements("textarea")[0];
  if (!target) {
    showShortcutHint("No more details field found");
    return false;
  }
  return focusShortcutElement(target, "More details focused");
}

function openRelatedReportShortcut() {
  const report = visibleShortcutElements("main a").find((link) =>
    /\b(report|monthly|outstanding|ledger|stock)\b/.test(normalizeSearchText(link.textContent))
  );
  if (report) return clickShortcutAction(report, "Related report opened");
  return navigateShortcut("/reports/", "Reports");
}

function focusOptionalShortcut() {
  const form = document.activeElement?.closest?.("form");
  const selector = 'input[name="due_date"], textarea[name="remarks"], textarea';
  const target = (form && visibleShortcutElements(selector, form)[0]) || visibleShortcutElements(selector)[0];
  if (!target) {
    showShortcutHint("No optional field found");
    return false;
  }
  return focusShortcutElement(target, "Optional field focused", target.type === "date");
}

function focusPostDatedShortcut() {
  const form = document.activeElement?.closest?.("form");
  const selector = 'input[name="due_date"], input[name="payment_date"], input[type="date"]';
  const target = (form && visibleShortcutElements(selector, form)[0]) || visibleShortcutElements(selector)[0];
  if (!target) {
    showShortcutHint("No post-dated field found");
    return false;
  }
  return focusShortcutElement(target, "Post-dated field focused", true);
}

function focusStatAdjustmentShortcut() {
  const form = document.activeElement?.closest?.("form");
  const selector = 'input[name="gst_percent[]"], select[name="sale_type"], select[name="purchase_type"]';
  const target = (form && visibleShortcutElements(selector, form)[0]) || visibleShortcutElements(selector)[0];
  if (!target) {
    showShortcutHint("No statutory/GST field found");
    return false;
  }
  return focusShortcutElement(target, "Stat/GST field focused", target.type === "date");
}

function focusShortcutElement(element, message, showPicker = false) {
  if (!element) return false;
  element.scrollIntoView?.({ behavior: "smooth", block: "center" });
  element.focus?.({ preventScroll: true });
  element.select?.();
  if (showPicker && typeof element.showPicker === "function") {
    try {
      element.showPicker();
    } catch (_) {
      // Some browsers only allow showPicker from direct pointer events.
    }
  }
  showShortcutHint(message);
  return true;
}

function showShortcutHelp() {
  closeShortcutHelp();
  const backdrop = document.createElement("div");
  backdrop.className = "shortcut-modal-backdrop";
  backdrop.dataset.shortcutOverlay = "true";
  backdrop.setAttribute("role", "presentation");

  const modal = document.createElement("section");
  modal.className = "shortcut-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "shortcut-help-title");

  const header = document.createElement("div");
  header.className = "shortcut-modal-header";
  const headingWrap = document.createElement("div");
  const heading = document.createElement("h2");
  heading.id = "shortcut-help-title";
  heading.textContent = "Keyboard Shortcuts";
  const subtitle = document.createElement("p");
  subtitle.textContent = "Excel/Tally-style actions for fast daily entry.";
  headingWrap.append(heading, subtitle);
  const close = document.createElement("button");
  close.className = "icon-button";
  close.type = "button";
  close.dataset.shortcutClose = "true";
  close.setAttribute("aria-label", "Close shortcut help");
  close.textContent = "×";
  header.append(headingWrap, close);

  const list = document.createElement("div");
  list.className = "shortcut-list";
  SHORTCUT_GUIDE.forEach(([keys, action]) => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const shortcutKeys = document.createElement("kbd");
    shortcutKeys.textContent = keys;
    const label = document.createElement("span");
    label.textContent = action;
    row.append(shortcutKeys, label);
    list.appendChild(row);
  });

  modal.append(header, list);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  close.focus();
}

function closeShortcutHelp() {
  const overlay = document.querySelector("[data-shortcut-overlay]");
  if (!overlay) return false;
  overlay.remove();
  return true;
}

function showShortcutHint(message) {
  if (!message) return;
  let toast = document.querySelector("[data-shortcut-toast]");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "shortcut-toast";
    toast.dataset.shortcutToast = "true";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  window.clearTimeout(shortcutToastTimer);
  shortcutToastTimer = window.setTimeout(() => toast.remove(), 1800);
}

function closeActionMenus(except = null) {
  document.querySelectorAll("[data-action-menu].is-open").forEach((menu) => {
    if (menu === except) return;
    menu.classList.remove("is-open");
    menu.querySelector("[data-action-menu-toggle]")?.setAttribute("aria-expanded", "false");
  });
}

function positionActionMenu(menu) {
  const toggle = menu?.querySelector("[data-action-menu-toggle]");
  const list = menu?.querySelector(".action-menu-list");
  if (!toggle || !list) return;
  const toggleRect = toggle.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const listWidth = Math.min(Math.max(list.offsetWidth || 190, 190), viewportWidth - 24);
  const listHeight = Math.min(Math.max(list.offsetHeight || 220, 120), viewportHeight - 24);
  const left = Math.max(12, Math.min(toggleRect.right - listWidth, viewportWidth - listWidth - 12));
  const preferredTop = toggleRect.bottom + 8;
  const top = preferredTop + listHeight > viewportHeight - 12
    ? Math.max(12, toggleRect.top - listHeight - 8)
    : preferredTop;
  list.style.setProperty("--action-menu-left", `${left}px`);
  list.style.setProperty("--action-menu-top", `${top}px`);
}

function positionOpenActionMenus() {
  document.querySelectorAll("[data-action-menu].is-open").forEach(positionActionMenu);
}

document.addEventListener("click", (event) => {
  const actionToggle = event.target.closest("[data-action-menu-toggle]");
  if (actionToggle) {
    event.preventDefault();
    const menu = actionToggle.closest("[data-action-menu]");
    const willOpen = !menu?.classList.contains("is-open");
    closeActionMenus(menu);
    if (menu && willOpen) {
      menu.classList.add("is-open");
      actionToggle.setAttribute("aria-expanded", "true");
      positionActionMenu(menu);
    } else {
      actionToggle.setAttribute("aria-expanded", "false");
    }
    return;
  }

  if (!event.target.closest("[data-action-menu]")) {
    closeActionMenus();
  }

  const back = event.target.closest("[data-back-button]");
  if (back) {
    event.preventDefault();
    navigateBack();
    return;
  }
  if (event.target.closest("[data-shortcut-help]")) {
    event.preventDefault();
    showShortcutHelp();
    return;
  }
  if (event.target.closest("[data-shortcut-close]") || event.target.matches("[data-shortcut-overlay]")) {
    event.preventDefault();
    closeShortcutHelp();
  }
});

window.addEventListener("resize", () => closeActionMenus());
window.addEventListener("scroll", positionOpenActionMenus, true);

renderAppIcons();
initializeThemeControls();
initializeSidebarControls();
initializeScrollShadow();
initializeGlobalSearch();
initializeDashboardVisuals();
initializeCounters();
initializeRipples();
initializeSelectableRows();
initializeKeyboardShortcuts();
consumeShortcutIntent();

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (form.matches("[data-customer-jump-form]")) {
    event.preventDefault();
    openCustomerJump(form);
    return;
  }
  if (!validateItemPickers(form)) {
    event.preventDefault();
    return;
  }
  const message = form.dataset.confirm;
  if (message && !window.confirm(message)) {
    event.preventDefault();
    return;
  }
  setFormSubmitting(form, event.submitter);
  if (message && /(delete|deactivate|reverse)/i.test(message)) {
    event.preventDefault();
    playTone("delete");
    window.setTimeout(() => HTMLFormElement.prototype.submit.call(form), 130);
  }
});

window.addEventListener("pageshow", () => {
  hidePageLoading();
  document.querySelectorAll("form.is-submitting").forEach((form) => {
    form.classList.remove("is-submitting");
    form.querySelectorAll("button.is-loading").forEach((button) => setButtonLoading(button, false));
  });
});

function formatPreviewMoney(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-IN");
}

function updateLineTotal(row) {
  if (!row) return;
  const output = row.querySelector(".line-total-preview");
  if (!output) return;
  output.textContent = formatPreviewMoney(linePreviewTotal(row));
  updateDocumentTotal(row.closest("form"));
}

function linePreviewTotal(row) {
  const quantity = parseFloat(row.querySelector('input[name="quantity[]"]')?.value || "0");
  const rate = parseFloat(row.querySelector('input[name="rate[]"]')?.value || "0");
  const gst = isTaxableForm(row.closest("form"))
    ? parseFloat(row.querySelector('input[name="gst_percent[]"]')?.value || "0")
    : 0;
  const subtotal = quantity * rate;
  return subtotal + subtotal * gst / 100;
}

function updateDocumentTotal(form) {
  if (!form) return;
  const preview = form.querySelector("[data-document-total-preview]");
  if (!preview) return;
  const total = Array.from(form.querySelectorAll(".line-row")).reduce(
    (sum, row) => sum + linePreviewTotal(row),
    0
  );
  if ("value" in preview) {
    preview.value = formatPreviewMoney(total);
  } else {
    preview.textContent = formatPreviewMoney(total);
  }
}

function transactionType(form) {
  if (!form) return "";
  const control = form.querySelector(
    'select[name="purchase_type"], select[name="sale_type"], input[name="purchase_type"], input[name="sale_type"]'
  );
  return (control?.value || form.dataset.transactionType || "").trim().toUpperCase();
}

function isTaxableForm(form) {
  const type = transactionType(form);
  return !type || type === "GST";
}

function syncTransactionGstFields(form) {
  if (!form) return;
  const taxable = isTaxableForm(form);
  form.querySelectorAll('input[name="gst_percent[]"]').forEach((input) => {
    if (!taxable) {
      input.value = "0";
      input.readOnly = true;
      input.setAttribute("aria-label", "GST percent fixed at zero for CASH");
    } else {
      input.readOnly = false;
      input.removeAttribute("aria-label");
    }
    updateLineTotal(input.closest(".line-row"));
  });
  updateDocumentTotal(form);
}

function itemOptionLabel(option) {
  return (option?.value || "").trim();
}

function initializeItemPickers(root = document) {
  root.querySelectorAll("[data-item-picker], [data-option-picker]").forEach((picker) => {
    if (picker.dataset.itemPickerReady === "true" || picker.dataset.optionPickerReady === "true") return;
    const input = picker.querySelector("[data-item-search], [data-option-search]");
    const datalist = picker.querySelector("[data-item-options], [data-option-list]");
    if (!input || !datalist) return;
    const prefix = picker.dataset.pickerPrefix || "picker";
    const id = `${prefix}_options_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    datalist.id = id;
    input.setAttribute("list", id);
    picker.dataset.itemPickerReady = "true";
    picker.dataset.optionPickerReady = "true";
    syncItemValue(input);
  });
}

function matchingItemOption(input) {
  const picker = input.closest("[data-item-picker], [data-option-picker]");
  const datalist = picker && picker.querySelector("[data-item-options], [data-option-list]");
  if (!datalist) return null;
  const value = normalizeSearchText(input.value);
  if (!value) return null;
  return Array.from(datalist.options).find((option) => normalizeSearchText(itemOptionLabel(option)) === value) || null;
}

function syncItemValue(input) {
  const picker = input.closest("[data-item-picker], [data-option-picker]");
  const hidden = picker && picker.querySelector("[data-item-value], [data-option-value]");
  if (!hidden) return false;
  const option = matchingItemOption(input);
  hidden.value = option ? option.dataset.itemId || option.dataset.optionId || "" : "";
  const label = picker?.dataset.pickerLabel || "item";
  input.setCustomValidity(input.value.trim() && !hidden.value ? `Select a ${label} from the list.` : "");
  return Boolean(hidden.value);
}

function validateItemPickers(form) {
  const inputs = Array.from(form.querySelectorAll("[data-item-search], [data-option-search]"));
  for (const input of inputs) {
    if (!syncItemValue(input)) {
      input.reportValidity();
      return false;
    }
  }
  return true;
}

function applyLiveSearch(input) {
  if (!input || !input.dataset.liveTarget) return;
  const target = document.querySelector(input.dataset.liveTarget);
  if (!target) return;
  const query = normalizeSearchText(input.value);
  const tables = target.matches("table") ? [target] : Array.from(target.querySelectorAll("table"));

  tables.forEach((table) => {
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    const emptyRows = rows.filter((row) => row.matches("[data-live-empty], .empty"));
    let visibleCount = 0;

    rows.forEach((row) => {
      if (row.matches("[data-live-empty]")) return;
      if (row.classList.contains("empty")) {
        row.hidden = Boolean(query);
        return;
      }
      const visible = !query || normalizeSearchText(row.textContent).includes(query);
      row.hidden = !visible;
      if (visible) visibleCount += 1;
    });

    emptyRows
      .filter((row) => row.matches("[data-live-empty]"))
      .forEach((row) => {
        row.hidden = !query || visibleCount > 0;
      });
  });
  updateReportTotals();
  updateOutstandingSummary();
}

function parseMoneyText(text) {
  const cleaned = String(text || "")
    .replace(/[₹,\s]/g, "")
    .replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return 0;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function formatCountLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function updateReportTotals() {
  document.querySelectorAll("[data-report-totals]").forEach((summary) => {
    const table = document.querySelector(summary.dataset.reportTable);
    if (!table) return;
    const visibleRows = Array.from(table.querySelectorAll("tbody tr")).filter(
      (row) => !row.hidden && !row.matches("[data-live-empty], .empty")
    );
    summary.querySelectorAll("[data-report-total]").forEach((card) => {
      const column = Number.parseInt(card.dataset.column || "", 10);
      if (!Number.isFinite(column)) return;
      const total = visibleRows.reduce((sum, row) => {
        const cell = row.children[column];
        return sum + parseMoneyText(cell?.textContent || "");
      }, 0);
      const value = card.querySelector("strong");
      if (value) value.textContent = formatPreviewMoney(total);
    });
  });
}

function updateOutstandingSummary() {
  const summary = document.querySelector("[data-outstanding-summary]");
  if (!summary) return;
  const target = document.querySelector(summary.dataset.liveSummaryTarget);
  if (!target) return;
  const tables = Array.from(target.querySelectorAll("table"));
  summary.querySelectorAll("[data-summary-table]").forEach((card, index) => {
    const table = tables[index];
    if (!table) return;
    const column = Number.parseInt(card.dataset.summaryColumn || "", 10);
    const visibleRows = Array.from(table.querySelectorAll("tbody tr")).filter(
      (row) => !row.hidden && !row.matches("[data-live-empty], .empty")
    );
    const total = visibleRows.reduce((sum, row) => {
      const cell = row.children[column];
      return sum + parseMoneyText(cell?.textContent || "");
    }, 0);
    const value = card.querySelector("strong");
    const small = card.querySelector("small");
    if (value) value.textContent = formatPreviewMoney(total);
    if (small) {
      const labels = [
        ["customer", "customers"],
        ["supplier", "suppliers"],
        ["advance", "advances"],
      ][index] || ["entry", "entries"];
      small.textContent = formatCountLabel(visibleRows.length, labels[0], labels[1]);
    }
  });
}

function openCustomerJump(form) {
  const input = form && form.querySelector("[data-customer-jump]");
  const datalist = input && document.getElementById(input.getAttribute("list"));
  if (!input || !datalist) return;
  const value = normalizeSearchText(input.value);
  const options = Array.from(datalist.options);
  const option =
    options.find((item) => normalizeSearchText(item.value) === value) ||
    options.find((item) => value && normalizeSearchText(item.value).includes(value));
  if (option?.dataset.url) {
    window.location.href = option.dataset.url;
  } else {
    input.reportValidity();
  }
}

function filterStockBookPair(form, companySelector, stockBookSelector, categorySelector) {
  const company = form.querySelector(companySelector);
  const stockBook = form.querySelector(stockBookSelector);
  const category = categorySelector ? form.querySelector(categorySelector) : null;
  if (!company || !stockBook) return;

  const companyId = company.value;
  const bookType = category ? category.value : "";
  let selectedStillVisible = false;

  stockBook.querySelectorAll("option").forEach((option) => {
    const visible =
      !option.dataset.companyId ||
      (option.dataset.companyId === companyId && (!bookType || option.dataset.bookType === bookType));
    option.hidden = !visible;
    option.disabled = !visible;
    if (visible && option.selected) selectedStillVisible = true;
  });

  if (!selectedStillVisible) {
    const firstVisible = Array.from(stockBook.options).find((option) => !option.disabled);
    if (firstVisible) firstVisible.selected = true;
  }
}

function filterStockBooks(form) {
  if (!form) return;
  const categorySelector = form.querySelector('select[name="purchase_type"]')
    ? 'select[name="purchase_type"]'
    : form.querySelector('select[name="sale_type"]')
      ? 'select[name="sale_type"]'
      : null;
  filterStockBookPair(
    form,
    'select[name="company_id"], input[name="company_id"]',
    'select[name="stock_book_id"]',
    categorySelector
  );
  filterStockBookPair(form, 'select[name="from_company_id"]', 'select[name="from_stock_book_id"]');
  filterStockBookPair(form, 'select[name="to_company_id"]', 'select[name="to_stock_book_id"]');
}

document.addEventListener("change", (event) => {
  if (
    event.target.matches('select[name="company_id"]') ||
    event.target.matches('select[name="from_company_id"]') ||
    event.target.matches('select[name="to_company_id"]') ||
    event.target.matches('select[name="purchase_type"]') ||
    event.target.matches('select[name="sale_type"]')
  ) {
    const form = event.target.closest("form");
    filterStockBooks(form);
    syncTransactionGstFields(form);
    updateDocumentTotal(form);
  }
});

document.addEventListener("input", (event) => {
  if (
    event.target.matches('input[name="quantity[]"]') ||
    event.target.matches('input[name="rate[]"]') ||
    event.target.matches('input[name="gst_percent[]"]')
  ) {
    updateLineTotal(event.target.closest(".line-row"));
  }

  if (event.target.matches("[data-item-search], [data-option-search]")) {
    syncItemValue(event.target);
  }

  if (event.target.matches("[data-live-search]")) {
    applyLiveSearch(event.target);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-customer-jump]")) {
    openCustomerJump(event.target.closest("[data-customer-jump-form]"));
  }
});

document.querySelectorAll("form").forEach(filterStockBooks);
document.querySelectorAll("form").forEach(syncTransactionGstFields);
document.querySelectorAll(".line-row").forEach(updateLineTotal);
document.querySelectorAll("form").forEach(updateDocumentTotal);
initializeItemPickers();
document.querySelectorAll("[data-live-search]").forEach(applyLiveSearch);
initializeSelectableRows();

function initializeSelectableRows(root = document) {
  const tables = Array.from(root.querySelectorAll(".table-wrap table, table[data-selectable-rows]"));
  tables.forEach((table, tableIndex) => {
    if (table.dataset.rowSelectReady === "true") return;
    table.dataset.rowSelectReady = "true";
    const tableKey = table.dataset.rowSelectKey || fallbackTableKey(table, tableIndex);
    table.dataset.rowSelectKey = tableKey;
    const storageKey = `fastockflow:selected-rows:${window.location.pathname}:${window.location.search}:${tableKey}`;
    const selected = loadSelectedRows(storageKey);
    Array.from(table.querySelectorAll("tbody tr")).forEach((row, rowIndex) => {
      if (row.matches("[data-live-empty], .empty") || row.querySelector("td.empty")) return;
      const rowKey = row.dataset.rowKey || fallbackRowKey(row, rowIndex);
      row.dataset.rowKey = rowKey;
      row.dataset.rowSelectable = "true";
      row.tabIndex = 0;
      row.setAttribute("aria-selected", String(selected.has(rowKey)));
      row.classList.toggle("is-row-selected", selected.has(rowKey));
      row.addEventListener("click", (event) => {
        if (event.target.closest("a, button, input, select, textarea, label, summary, [role='button'], [data-no-row-select]")) return;
        if (window.getSelection?.().toString().trim()) return;
        toggleSelectedRow(row, storageKey, selected);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        if (event.target.closest("a, button, input, select, textarea")) return;
        event.preventDefault();
        toggleSelectedRow(row, storageKey, selected);
      });
    });
  });
}

function fallbackTableKey(table, tableIndex) {
  return table.id || normalizeSearchText(table.closest(".panel")?.querySelector("h2, h1")?.textContent || `table-${tableIndex}`);
}

function fallbackRowKey(row, rowIndex) {
  const text = Array.from(row.cells || [])
    .map((cell) => cell.textContent)
    .join("|");
  return `${rowIndex}:${normalizeSearchText(text).slice(0, 180)}`;
}

function loadSelectedRows(storageKey) {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey) || "[]"));
  } catch (_) {
    return new Set();
  }
}

function saveSelectedRows(storageKey, selected) {
  localStorage.setItem(storageKey, JSON.stringify(Array.from(selected)));
}

function toggleSelectedRow(row, storageKey, selected) {
  const rowKey = row.dataset.rowKey;
  const isSelected = selected.has(rowKey);
  if (isSelected) selected.delete(rowKey);
  else selected.add(rowKey);
  row.classList.toggle("is-row-selected", !isSelected);
  row.setAttribute("aria-selected", String(!isSelected));
  saveSelectedRows(storageKey, selected);
}

const calculatorStates = new WeakMap();
const calendarStates = new WeakMap();

function getCalculatorState(panel) {
  if (!calculatorStates.has(panel)) {
    calculatorStates.set(panel, { display: "0", first: null, operator: null, waiting: false });
  }
  return calculatorStates.get(panel);
}

function updateCalculatorDisplay(panel) {
  const state = getCalculatorState(panel);
  const display = panel.querySelector("[data-calc-display]");
  if (display) display.textContent = state.display;
}

function cleanCalculatorNumber(value) {
  if (!Number.isFinite(value)) return "Error";
  const rounded = Math.round((value + Number.EPSILON) * 100000000) / 100000000;
  return String(rounded).slice(0, 16);
}

function calculateValue(first, second, operator) {
  if (operator === "+") return first + second;
  if (operator === "-") return first - second;
  if (operator === "*") return first * second;
  if (operator === "/") return second === 0 ? Number.NaN : first / second;
  return second;
}

function handleCalculatorKey(panel, key) {
  const state = getCalculatorState(panel);
  if (key === "clear") {
    calculatorStates.set(panel, { display: "0", first: null, operator: null, waiting: false });
    updateCalculatorDisplay(panel);
    return;
  }
  if (state.display === "Error") {
    state.display = "0";
    state.first = null;
    state.operator = null;
    state.waiting = false;
  }
  if (/^\d$/.test(key)) {
    state.display = state.waiting || state.display === "0" ? key : `${state.display}${key}`.slice(0, 16);
    state.waiting = false;
  } else if (key === ".") {
    if (state.waiting) {
      state.display = "0.";
      state.waiting = false;
    } else if (!state.display.includes(".")) {
      state.display += ".";
    }
  } else if (key === "back") {
    state.display = state.display.length > 1 ? state.display.slice(0, -1) : "0";
  } else if (key === "negate") {
    state.display = cleanCalculatorNumber(Number(state.display) * -1);
  } else if (key === "%") {
    state.display = cleanCalculatorNumber(Number(state.display) / 100);
  } else if (["+", "-", "*", "/"].includes(key)) {
    const current = Number(state.display);
    if (state.operator && !state.waiting) {
      state.display = cleanCalculatorNumber(calculateValue(state.first, current, state.operator));
      state.first = Number(state.display);
    } else {
      state.first = current;
    }
    state.operator = key;
    state.waiting = true;
  } else if (key === "equals") {
    if (state.operator !== null) {
      const current = Number(state.display);
      state.display = cleanCalculatorNumber(calculateValue(state.first, current, state.operator));
      state.first = null;
      state.operator = null;
      state.waiting = true;
    }
  }
  updateCalculatorDisplay(panel);
}

function closeFloatingTools(root = document) {
  root.querySelectorAll("[data-tool-panel]").forEach((panel) => {
    panel.hidden = true;
  });
  root.querySelectorAll("[data-tool-toggle]").forEach((button) => {
    button.classList.remove("is-active");
    button.setAttribute("aria-expanded", "false");
  });
}

function openFloatingTool(name, root = document) {
  const panel = root.querySelector(`[data-tool-panel="${name}"]`);
  const button = root.querySelector(`[data-tool-toggle="${name}"]`);
  if (!panel || !button) return;
  const willOpen = panel.hidden;
  closeFloatingTools(root);
  if (willOpen) {
    panel.hidden = false;
    button.classList.add("is-active");
    button.setAttribute("aria-expanded", "true");
    if (name === "calendar") initializeCalendar(panel);
    if (name === "music") initializeFocusMode(panel);
  }
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDate(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function getCalendarState(panel) {
  if (!calendarStates.has(panel)) {
    const today = new Date();
    calendarStates.set(panel, {
      monthDate: new Date(today.getFullYear(), today.getMonth(), 1),
      selectedDate: localDateKey(today),
      events: [],
      loadedMonth: "",
    });
  }
  return calendarStates.get(panel);
}

function monthTitle(date) {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(date);
}

async function initializeCalendar(panel) {
  const state = getCalendarState(panel);
  await loadCalendarMonth(panel, state.monthDate);
}

async function loadCalendarMonth(panel, monthDate) {
  const state = getCalendarState(panel);
  const monthKey = `${monthDate.getFullYear()}-${monthDate.getMonth()}`;
  state.monthDate = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const selected = parseLocalDate(state.selectedDate);
  if (selected.getFullYear() !== state.monthDate.getFullYear() || selected.getMonth() !== state.monthDate.getMonth()) {
    state.selectedDate = localDateKey(state.monthDate);
  }
  if (state.loadedMonth !== monthKey) {
    const start = localDateKey(new Date(monthDate.getFullYear(), monthDate.getMonth(), 1));
    const end = localDateKey(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0));
    const url = `${panel.dataset.calendarUrl}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const response = await fetch(url);
    const data = response.ok ? await response.json() : { events: [] };
    state.events = data.events || [];
    state.loadedMonth = monthKey;
  }
  renderCalendar(panel);
}

function eventsByDate(events) {
  return events.reduce((map, event) => {
    map[event.date] = map[event.date] || [];
    map[event.date].push(event);
    return map;
  }, {});
}

function renderCalendar(panel) {
  const state = getCalendarState(panel);
  const byDate = eventsByDate(state.events);
  const title = panel.querySelector("[data-calendar-title]");
  const grid = panel.querySelector("[data-calendar-grid]");
  if (title) title.textContent = monthTitle(state.monthDate);
  if (!grid) return;
  grid.textContent = "";

  const first = new Date(state.monthDate.getFullYear(), state.monthDate.getMonth(), 1);
  const last = new Date(state.monthDate.getFullYear(), state.monthDate.getMonth() + 1, 0);
  const todayKey = localDateKey(new Date());
  for (let index = 0; index < first.getDay(); index += 1) {
    const blank = document.createElement("span");
    blank.className = "calendar-day is-muted";
    grid.appendChild(blank);
  }
  for (let day = 1; day <= last.getDate(); day += 1) {
    const current = new Date(state.monthDate.getFullYear(), state.monthDate.getMonth(), day);
    const key = localDateKey(current);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day";
    if (key === todayKey) button.classList.add("is-today");
    if (key === state.selectedDate) button.classList.add("is-selected");
    button.dataset.calendarDay = key;
    button.textContent = String(day);
    if (byDate[key]?.length) {
      const count = document.createElement("span");
      count.className = "calendar-day-count";
      count.textContent = String(byDate[key].length);
      button.appendChild(count);
    }
    grid.appendChild(button);
  }
  renderCalendarEvents(panel);
}

function renderCalendarEvents(panel) {
  const state = getCalendarState(panel);
  const label = panel.querySelector("[data-calendar-selected]");
  const list = panel.querySelector("[data-calendar-events]");
  if (!list) return;
  const selected = parseLocalDate(state.selectedDate);
  if (label) label.textContent = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(selected);
  list.textContent = "";
  const events = state.events.filter((event) => event.date === state.selectedDate);
  if (!events.length) {
    const empty = document.createElement("small");
    empty.textContent = "No events for this date.";
    list.appendChild(empty);
    return;
  }
  events.forEach((event) => {
    const item = document.createElement(event.url ? "a" : "div");
    item.className = `calendar-event ${event.severity || ""}`.trim();
    if (event.url) item.href = event.url;
    const title = document.createElement("strong");
    title.textContent = event.title;
    const meta = document.createElement("small");
    meta.textContent = [event.kind, event.company, event.amount].filter(Boolean).join(" · ");
    item.append(title, meta);
    list.appendChild(item);
  });
}

document.addEventListener("click", async (event) => {
  const toggle = event.target.closest("[data-tool-toggle]");
  if (toggle) {
    openFloatingTool(toggle.dataset.toolToggle, toggle.closest("[data-floating-tools]"));
    return;
  }
  if (event.target.closest("[data-tool-close]")) {
    closeFloatingTools(event.target.closest("[data-floating-tools]"));
    return;
  }
  const calcKey = event.target.closest("[data-calc-key]");
  if (calcKey) {
    const panel = calcKey.closest("[data-tool-panel='calculator']");
    if (panel) handleCalculatorKey(panel, calcKey.dataset.calcKey);
    return;
  }
  const calendarPanel = event.target.closest("[data-tool-panel='calendar']");
  if (calendarPanel) {
    const state = getCalendarState(calendarPanel);
    if (event.target.closest("[data-calendar-prev]")) {
      await loadCalendarMonth(calendarPanel, new Date(state.monthDate.getFullYear(), state.monthDate.getMonth() - 1, 1));
      return;
    }
    if (event.target.closest("[data-calendar-next]")) {
      await loadCalendarMonth(calendarPanel, new Date(state.monthDate.getFullYear(), state.monthDate.getMonth() + 1, 1));
      return;
    }
    if (event.target.closest("[data-calendar-today]")) {
      const today = new Date();
      state.selectedDate = localDateKey(today);
      await loadCalendarMonth(calendarPanel, new Date(today.getFullYear(), today.getMonth(), 1));
      return;
    }
    const day = event.target.closest("[data-calendar-day]");
    if (day) {
      state.selectedDate = day.dataset.calendarDay;
      renderCalendar(calendarPanel);
    }
  }
});
