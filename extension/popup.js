const API_BASE_URL = "http://127.0.0.1:8000";
const SCRAPE_LIMIT = 100;

let currentSessionId = null;
let chatBusy = false;

const createSessionBtn = document.getElementById("createSessionBtn");
const refreshSessionBtn = document.getElementById("refreshSessionBtn");
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loadingText");
const errorBox = document.getElementById("errorBox");
const emptyState = document.getElementById("emptyState");

const sessionPanel = document.getElementById("sessionPanel");
const sessionStatus = document.getElementById("sessionStatus");

const dashboard = document.getElementById("dashboard");
const totalReviews = document.getElementById("totalReviews");
const positivePct = document.getElementById("positivePct");
const negativePct = document.getElementById("negativePct");

const suggestions = document.getElementById("suggestions");
const chatPanel = document.getElementById("chatPanel");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const questionInput = document.getElementById("questionInput");
const sendBtn = document.getElementById("sendBtn");

createSessionBtn.addEventListener("click", () => createOrRefreshSession(false));
refreshSessionBtn.addEventListener("click", () => createOrRefreshSession(true));
chatForm.addEventListener("submit", handleChatSubmit);

suggestions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-question]");

  if (!button) {
    return;
  }

  sendQuestion(button.dataset.question);
});

async function createOrRefreshSession(shouldRefresh) {
  setBusy(true, "Scraping visible reviews and creating a RAG session...");
  clearError();
  hideEmptyState();

  try {
    if (shouldRefresh && currentSessionId) {
      await deleteSessionQuietly(currentSessionId);
    }

    resetSessionUi();

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab || !tab.id) {
      throw new Error("No active browser tab found.");
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeReviewsFromPage,
      args: [SCRAPE_LIMIT]
    });

    const scrapeResult = injectionResults?.[0]?.result || {
      reviews: [],
      hitLimit: false
    };

    const reviews = scrapeResult.reviews || [];

    if (!reviews.length) {
      showEmptyState();
      return;
    }

    const response = await fetch(`${API_BASE_URL}/v1/rag/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        page_url: tab.url || null,
        page_title: tab.title || null,
        reviews
      })
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      throw new Error(errorPayload?.detail || `Backend error: ${response.status}`);
    }

    const sessionData = await response.json();
    currentSessionId = sessionData.session_id;

    renderSessionReady(sessionData, scrapeResult.hitLimit);
    enableChat();

    appendAssistantMessage(
      "Session ready. Ask me about complaints, positives, risks, delivery issues, quality issues, or anything else in the visible reviews.",
      []
    );

    // Optional: keep your old sentiment dashboard alive without blocking chat.
    runSentimentDashboard(reviews).catch(() => {
      dashboard.classList.add("hidden");
    });
  } catch (error) {
    showError(error.message || "Failed to create RAG session.");
  } finally {
    setBusy(false);
  }
}

function scrapeReviewsFromPage(limit) {
  const selectors = [
    // YouTube comments
    "ytd-comment-thread-renderer #content-text",

    // Common product/review/comment patterns
    "[data-review-id]",
    "[data-testid*='review']",
    "[aria-label*='review']",
    "[class*='review']",
    "[class*='Review']",
    ".review",
    ".review-text",
    ".review-content",
    ".comment",
    ".comment-text",

    // Fallback content blocks
    "article",
    "p"
  ];

  const seen = new Set();
  const reviews = [];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));

    for (const element of elements) {
      const text = (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      const isUsefulLength = text.length >= 25 && text.length <= 2000;
      const isDuplicate = seen.has(text);

      if (isUsefulLength && !isDuplicate) {
        seen.add(text);
        reviews.push(text);
      }

      if (reviews.length >= limit) {
        return {
          reviews,
          hitLimit: true
        };
      }
    }

    // Stop early when a strong selector finds enough review-like text.
    if (reviews.length >= 10) {
      return {
        reviews,
        hitLimit: false
      };
    }
  }

  return {
    reviews,
    hitLimit: false
  };
}

async function runSentimentDashboard(reviews) {
  const response = await fetch(`${API_BASE_URL}/v1/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ reviews })
  });

  if (!response.ok) {
    return;
  }

  const data = await response.json();

  totalReviews.textContent = String(data.total_reviews || 0);
  positivePct.textContent = `${formatPercent(data.sentiment?.positive_pct || 0)}%`;
  negativePct.textContent = `${formatPercent(data.sentiment?.negative_pct || 0)}%`;

  dashboard.classList.remove("hidden");
}

async function handleChatSubmit(event) {
  event.preventDefault();

  const question = questionInput.value.trim();

  if (!question) {
    return;
  }

  await sendQuestion(question);
}

async function sendQuestion(question) {
  if (!currentSessionId) {
    showError("Create a RAG session first.");
    return;
  }

  if (chatBusy) {
    return;
  }

  clearError();

  appendUserMessage(question);
  questionInput.value = "";

  const loadingMessage = appendAssistantMessage("Thinking over the retrieved reviews...", [], true);

  setChatBusy(true);

  try {
    const response = await fetch(
      `${API_BASE_URL}/v1/rag/sessions/${currentSessionId}/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ question })
      }
    );

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      throw new Error(errorPayload?.detail || `Backend error: ${response.status}`);
    }

    const data = await response.json();

    loadingMessage.remove();
    appendAssistantMessage(data.answer, data.sources || []);
  } catch (error) {
    loadingMessage.remove();
    showError(error.message || "Chat request failed.");
  } finally {
    setChatBusy(false);
  }
}

function renderSessionReady(sessionData, hitLimit) {
  const limitText = hitLimit
    ? ` Scrape limit reached: ${SCRAPE_LIMIT} visible matches.`
    : "";

  sessionStatus.textContent =
    `Indexed ${sessionData.review_count} reviews into ${sessionData.chunk_count} chunks.` +
    limitText;

  sessionPanel.classList.remove("hidden");
  suggestions.classList.remove("hidden");
  chatPanel.classList.remove("hidden");
  refreshSessionBtn.disabled = false;
}

function enableChat() {
  questionInput.disabled = false;
  sendBtn.disabled = false;
}

function resetSessionUi() {
  currentSessionId = null;

  sessionPanel.classList.add("hidden");
  dashboard.classList.add("hidden");
  suggestions.classList.add("hidden");
  chatPanel.classList.add("hidden");

  chatMessages.innerHTML = "";
  questionInput.value = "";
  questionInput.disabled = true;
  sendBtn.disabled = true;
  refreshSessionBtn.disabled = true;
}

function appendUserMessage(text) {
  const message = document.createElement("div");
  message.className = "message user";

  const label = document.createElement("strong");
  label.className = "message-label";
  label.textContent = "You";

  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;

  message.appendChild(label);
  message.appendChild(body);
  chatMessages.appendChild(message);
  scrollChatToBottom();

  return message;
}

function appendAssistantMessage(text, sources, isLoading = false) {
  const message = document.createElement("div");
  message.className = isLoading
    ? "message assistant loading-message"
    : "message assistant";

  const label = document.createElement("strong");
  label.className = "message-label";
  label.textContent = "Assistant";

  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;

  message.appendChild(label);
  message.appendChild(body);

  if (sources && sources.length) {
    message.appendChild(renderSources(sources));
  }

  chatMessages.appendChild(message);
  scrollChatToBottom();

  return message;
}

function renderSources(sources) {
  const details = document.createElement("details");
  details.className = "sources";

  const summary = document.createElement("summary");
  summary.textContent = `Show sources (${sources.length})`;
  details.appendChild(summary);

  for (const source of sources) {
    const item = document.createElement("div");
    item.className = "source-item";

    const meta = document.createElement("div");
    meta.className = "source-meta";

    const scoreText =
      typeof source.score === "number"
        ? ` | score: ${source.score}`
        : "";
    const sentimentText = source.metadata?.sentiment_label
      ? ` | ${source.metadata.sentiment_label}`
      : "";

    meta.textContent =
      `${source.review_id || "review"}${sentimentText}${scoreText}`;

    const text = document.createElement("div");
    text.className = "source-text";
    text.textContent = source.text || "";

    item.appendChild(meta);
    item.appendChild(text);
    details.appendChild(item);
  }

  return details;
}
async function deleteSessionQuietly(sessionId) {
  try {
    await fetch(`${API_BASE_URL}/v1/rag/sessions/${sessionId}`, {
      method: "DELETE"
    });
  } catch {
    // Ignore cleanup errors in the popup.
  }
}

function setBusy(isBusy, message = "Working...") {
  createSessionBtn.disabled = isBusy;
  refreshSessionBtn.disabled = isBusy || !currentSessionId;

  loadingText.textContent = message;
  loading.classList.toggle("hidden", !isBusy);
}

function setChatBusy(isBusy) {
  chatBusy = isBusy;
  questionInput.disabled = isBusy;
  sendBtn.disabled = isBusy;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

function showEmptyState() {
  emptyState.classList.remove("hidden");
}

function hideEmptyState() {
  emptyState.classList.add("hidden");
}

function scrollChatToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function formatPercent(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return "0";
  }

  const rounded = Math.round(numericValue * 10) / 10;

  if (Number.isInteger(rounded)) {
    return String(rounded);
  }

  return rounded.toFixed(1);
}
