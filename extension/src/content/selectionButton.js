const OPEN_POPUP_FOR_SELECTION = "VERDICT/OPEN_POPUP_FOR_SELECTION";
const BUTTON_ID = "verdict-selection-action-root";
const MIN_SELECTION_LENGTH = 4;
const EDGE_PADDING = 10;
const ESTIMATED_BUTTON_WIDTH = 242;
const ESTIMATED_BUTTON_HEIGHT = 38;

let host = null;
let button = null;
let closeButton = null;
let updateTimer = null;
let hideTimer = null;
let dismissedSelectionKey = "";
let lastSelectionKey = "";

installSelectionListeners();

function installSelectionListeners() {
  document.addEventListener("selectionchange", scheduleUpdate, true);
  document.addEventListener("mouseup", scheduleUpdate, true);
  document.addEventListener("keyup", scheduleUpdate, true);
  window.addEventListener("scroll", scheduleUpdate, true);
  window.addEventListener("resize", scheduleUpdate, true);
}

function scheduleUpdate() {
  window.clearTimeout(updateTimer);
  updateTimer = window.setTimeout(updateSelectionButton, 80);
}

function updateSelectionButton() {
  const selectionDetails = getSelectionDetails();

  if (!selectionDetails) {
    lastSelectionKey = "";
    dismissedSelectionKey = "";
    hideButton();
    return;
  }

  if (selectionDetails.key === dismissedSelectionKey) {
    hideButton();
    return;
  }

  lastSelectionKey = selectionDetails.key;
  ensureButton();
  positionButton(selectionDetails.rect);
  host.style.display = 'block';
  resetButtonLabel();
}

function getSelectionDetails() {
  if (typeof window.getSelection !== "function") {
    return null;
  }

  const selection = window.getSelection();
  const selectedText = String(selection?.toString() || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!selection || selection.rangeCount === 0 || selectedText.length < MIN_SELECTION_LENGTH) {
    return null;
  }

  const range = selection.getRangeAt(selection.rangeCount - 1);
  const rect = bestRangeRect(range);

  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return {
    rect,
    selectedText,
    key: selectionKey(selectedText),
  };
}

function bestRangeRect(range) {
  const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
  const viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
  const boundingRect = range.getBoundingClientRect();

  if (selectionSpansViewport(boundingRect, viewportHeight)) {
    return viewportAnchorRect(viewportWidth);
  }

  const visibleRects = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .filter((rect) => intersectsViewport(rect, viewportWidth, viewportHeight));

  if (visibleRects.length > 0) {
    return visibleRects[visibleRects.length - 1];
  }

  if (intersectsViewport(boundingRect, viewportWidth, viewportHeight)) {
    return boundingRect;
  }

  return viewportAnchorRect(viewportWidth);
}

function ensureButton() {
  if (host && host.isConnected && button) {
    return;
  }

  host = document.getElementById(BUTTON_ID);

  if (!host || !host.isConnected) {
    if (!host) {
      host = document.createElement("div");
      host.id = BUTTON_ID;
    }
    host.style.display = "none";
    host.style.position = "fixed";
    host.style.left = "0";
    host.style.top = "0";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";
    document.documentElement.appendChild(host);
  }

  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });

  if (!shadow.querySelector("style")) {
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
      }

      button {
        border: 0;
        font: inherit;
      }

      .verdict-action {
        align-items: center;
        background: #111111;
        border: 1px solid #111111;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
        color: #ffffff;
        display: inline-flex;
        font: 600 13px/1.2 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        gap: 4px;
        min-height: 34px;
        padding: 4px;
        pointer-events: auto;
        white-space: nowrap;
      }

      .verdict-action:hover {
        background: #000000;
      }

      button:focus-visible {
        outline: 2px solid rgba(255, 255, 255, 0.9);
        outline-offset: 2px;
      }

      .action-button {
        align-items: center;
        background: transparent;
        color: inherit;
        cursor: pointer;
        display: inline-flex;
        gap: 8px;
        min-height: 28px;
        padding: 4px 7px 4px 8px;
      }

      .close-button {
        align-items: center;
        background: transparent;
        border-radius: 6px;
        color: rgba(255, 255, 255, 0.72);
        cursor: pointer;
        display: inline-flex;
        height: 26px;
        justify-content: center;
        width: 26px;
      }

      .close-button:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
      }

      .mark {
        align-items: center;
        background: #ffffff;
        border-radius: 6px;
        color: #111111;
        display: inline-flex;
        font-size: 11px;
        font-weight: 800;
        height: 18px;
        justify-content: center;
        width: 18px;
      }
    `;
    shadow.appendChild(style);
  }

  button = shadow.querySelector(".action-button");
  closeButton = shadow.querySelector(".close-button");

  if (!button || !closeButton) {
    shadow.querySelector(".verdict-action")?.remove();
    const wrapper = document.createElement("div");
    wrapper.className = "verdict-action";
    button = document.createElement("button");
    button.type = "button";
    button.className = "action-button";
    button.innerHTML = '<span class="mark">V</span><span class="label">Analyze Reviews with Verdict</span>';
    button.addEventListener("mousedown", preserveSelection);
    button.addEventListener("click", handleButtonClick);
    closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "close-button";
    closeButton.textContent = "x";
    closeButton.setAttribute("aria-label", "Hide Verdict selection button");
    closeButton.setAttribute("title", "Hide");
    closeButton.addEventListener("mousedown", preserveSelection);
    closeButton.addEventListener("click", handleCloseButtonDismiss);
    wrapper.append(button, closeButton);
    shadow.appendChild(wrapper);
  }
}

function positionButton(rect) {
  const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
  const viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
  const left = clamp(rect.left, EDGE_PADDING, viewportWidth - ESTIMATED_BUTTON_WIDTH - EDGE_PADDING);
  let top = rect.fixedButton ? rect.top : rect.bottom + 8;

  if (!rect.fixedButton && top + ESTIMATED_BUTTON_HEIGHT > viewportHeight - EDGE_PADDING) {
    top = rect.top - ESTIMATED_BUTTON_HEIGHT - 8;
  }

  host.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(EDGE_PADDING, top))}px)`;
}

function preserveSelection(event) {
  event.preventDefault();
  event.stopPropagation();
}

function handleButtonClick(event) {
  event.preventDefault();
  event.stopPropagation();
  window.clearTimeout(hideTimer);
  setButtonLabel("Opening Verdict...");

  const selectionScrapeResult = scrapeSelectedReviews();

  chrome.runtime.sendMessage({
    type: OPEN_POPUP_FOR_SELECTION,
    selectionScrapeResult,
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;

    if (runtimeError || !response?.ok) {
      setButtonLabel(response?.error || "Open Verdict from the toolbar");
      hideTimer = window.setTimeout(hideButton, 2400);
      return;
    }

    hideTimer = window.setTimeout(hideButton, 300);
  });
}

function handleCloseButtonDismiss(event) {
  event.preventDefault();
  event.stopPropagation();
  const selectionDetails = getSelectionDetails();

  dismissedSelectionKey = selectionDetails?.key || lastSelectionKey || "";
  window.clearTimeout(updateTimer);
  window.clearTimeout(hideTimer);
  hideButton();
}

function scrapeSelectedReviews() {
  try {
    const scraper = globalThis.__VERDICT_SCRAPER__;

    if (!scraper?.scrapeReviewsFromSelection) {
      throw new Error("Verdict scraper failed to load in the page.");
    }

    return scraper.scrapeReviewsFromSelection(null, {
      includeJsonLdInSelection: false,
    });
  } catch (error) {
    return {
      reviews: [],
      hitLimit: false,
      selectionFound: true,
      usedSelection: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function setButtonLabel(label) {
  const labelElement = button?.querySelector(".label");

  if (labelElement) {
    labelElement.textContent = label;
  }
}

function resetButtonLabel() {
  setButtonLabel("Analyze Reviews with Verdict");
}

function hideButton() {
  if (host) {
    host.style.display = "none";
  }
}

function clamp(value, min, max) {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function intersectsViewport(rect, viewportWidth, viewportHeight) {
  return (
    rect.right > EDGE_PADDING &&
    rect.left < viewportWidth - EDGE_PADDING &&
    rect.bottom > EDGE_PADDING &&
    rect.top < viewportHeight - EDGE_PADDING
  );
}

function selectionSpansViewport(rect, viewportHeight) {
  return rect.top < EDGE_PADDING && rect.bottom > viewportHeight - EDGE_PADDING;
}

function viewportAnchorRect(viewportWidth) {
  const left = Math.max(EDGE_PADDING, viewportWidth - ESTIMATED_BUTTON_WIDTH - EDGE_PADDING);

  return {
    left,
    right: left + ESTIMATED_BUTTON_WIDTH,
    top: EDGE_PADDING,
    bottom: EDGE_PADDING + ESTIMATED_BUTTON_HEIGHT,
    width: ESTIMATED_BUTTON_WIDTH,
    height: ESTIMATED_BUTTON_HEIGHT,
    fixedButton: true,
  };
}

function selectionKey(text) {
  return `${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`;
}
