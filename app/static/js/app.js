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
      updateLineTotal(clone);
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
      window.setTimeout(() => row.remove(), 150);
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

function updateLineTotal(row) {
  if (!row) return;
  const quantity = parseFloat(row.querySelector('input[name="quantity[]"]')?.value || "0");
  const rate = parseFloat(row.querySelector('input[name="rate[]"]')?.value || "0");
  const gst = parseFloat(row.querySelector('input[name="gst_percent[]"]')?.value || "0");
  const output = row.querySelector(".line-total-preview");
  if (!output) return;
  const subtotal = quantity * rate;
  output.textContent = formatPreviewMoney(subtotal + subtotal * gst / 100);
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
  const value = input.value.trim().toLowerCase();
  if (!value) return null;
  return Array.from(datalist.options).find((option) => itemOptionLabel(option).toLowerCase() === value) || null;
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
  const query = input.value.trim().toLowerCase();
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
      const visible = !query || row.textContent.toLowerCase().includes(query);
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
  const value = input.value.trim().toLowerCase();
  const options = Array.from(datalist.options);
  const option =
    options.find((item) => item.value.trim().toLowerCase() === value) ||
    options.find((item) => value && item.value.trim().toLowerCase().includes(value));
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
  filterStockBookPair(form, 'select[name="company_id"]', 'select[name="stock_book_id"]', categorySelector);
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
    filterStockBooks(event.target.closest("form"));
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
document.querySelectorAll(".line-row").forEach(updateLineTotal);
initializeItemPickers();
document.querySelectorAll("[data-live-search]").forEach(applyLiveSearch);
