const API_BASE_URL = "http://127.0.0.1:8000";
const SCRAPE_LIMIT = 80;

let latestAnalysis = null;

const analyzeBtn = document.getElementById("analyzeBtn");
const exportBtn = document.getElementById("exportBtn");

const loading = document.getElementById("loading");
const errorBox = document.getElementById("errorBox");
const emptyState = document.getElementById("emptyState");
const results = document.getElementById("results");

const totalReviews = document.getElementById("totalReviews");
const positivePct = document.getElementById("positivePct");
const negativePct = document.getElementById("negativePct");
const averageConfidence = document.getElementById("averageConfidence");

const positiveBar = document.getElementById("positiveBar");
const negativeBar = document.getElementById("negativeBar");
const positiveChartLabel = document.getElementById("positiveChartLabel");
const negativeChartLabel = document.getElementById("negativeChartLabel");

const summaryText = document.getElementById("summaryText");
const keywordList = document.getElementById("keywordList");
const sampleNote = document.getElementById("sampleNote");

analyzeBtn.addEventListener("click", handleAnalyzeClick);
exportBtn.addEventListener("click", handleExportClick);

async function handleAnalyzeClick() {
  setLoadingState(true);
  clearError();
  hideEmptyState();
  hideResults();

  latestAnalysis = null;

  try {
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
    const hitLimit = Boolean(scrapeResult.hitLimit);

    if (!reviews.length) {
      showEmptyState();
      return;
    }

    const response = await fetch(`${API_BASE_URL}/v1/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ reviews })
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      throw new Error(
        errorPayload?.detail || `Backend error: ${response.status}`
      );
    }

    const data = await response.json();

    latestAnalysis = {
      exported_at: new Date().toISOString(),
      source_url: tab.url || null,
      source_title: tab.title || null,
      scrape_limit: SCRAPE_LIMIT,
      scraped_reviews_before_backend_filtering: reviews.length,
      hit_scrape_limit: hitLimit,
      analysis: data
    };

    renderResults(data, {
      scrapedCount: reviews.length,
      hitLimit
    });
  } catch (error) {
    showError(error.message || "Something went wrong.");
  } finally {
    setLoadingState(false);
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

    // Stop early if a strong selector found enough useful text.
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

function renderResults(data, scrapeMeta) {
  const positive = Number(data.sentiment?.positive_pct || 0);
  const negative = Number(data.sentiment?.negative_pct || 0);
  const confidence = Number(data.sentiment?.average_confidence || 0) * 100;

  totalReviews.textContent = String(data.total_reviews || 0);
  positivePct.textContent = `${formatPercent(positive)}%`;
  negativePct.textContent = `${formatPercent(negative)}%`;
  averageConfidence.textContent = `${formatPercent(confidence)}%`;

  positiveChartLabel.textContent = `${formatPercent(positive)}%`;
  negativeChartLabel.textContent = `${formatPercent(negative)}%`;

  positiveBar.style.width = `${clampPercent(positive)}%`;
  negativeBar.style.width = `${clampPercent(negative)}%`;

  summaryText.textContent = data.summary || "No summary available.";

  renderKeywords(data.top_negative_terms || []);

  sampleNote.textContent = buildSampleNote(data, scrapeMeta);

  results.classList.remove("hidden");
}

function renderKeywords(keywords) {
  keywordList.innerHTML = "";

  if (!keywords.length) {
    const li = document.createElement("li");
    li.textContent = "No repeated issue terms found.";
    li.className = "keyword-empty";
    keywordList.appendChild(li);
    return;
  }

  for (const item of keywords) {
    const li = document.createElement("li");
    li.textContent = `${item.term} (${item.count})`;
    keywordList.appendChild(li);
  }
}

function buildSampleNote(data, scrapeMeta) {
  const backendCount = data.total_reviews || 0;
  const scrapedCount = scrapeMeta.scrapedCount || backendCount;

  if (scrapeMeta.hitLimit) {
    return `Analyzed ${backendCount} reviews from the first ${scrapedCount} visible matches. Sample limit: ${SCRAPE_LIMIT}.`;
  }

  return `Analyzed ${backendCount} visible reviews found on this page.`;
}

function handleExportClick() {
  if (!latestAnalysis) {
    showError("No analysis available to export yet.");
    return;
  }

  const blob = new Blob(
    [JSON.stringify(latestAnalysis, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  anchor.href = url;
  anchor.download = `review-analysis-${timestamp}.json`;
  anchor.click();

  URL.revokeObjectURL(url);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const rounded = Math.round(value * 10) / 10;

  if (Number.isInteger(rounded)) {
    return String(rounded);
  }

  return rounded.toFixed(1);
}

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}

function setLoadingState(isLoading) {
  analyzeBtn.disabled = isLoading;
  loading.classList.toggle("hidden", !isLoading);
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

function hideResults() {
  results.classList.add("hidden");
}