import React from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Info,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  Send,
  UserRound,
} from "lucide-react";
import "./styles.css";

const API_BASE_URL = "http://127.0.0.1:8000";
const SCRAPE_LIMIT = 100;

const SUGGESTED_QUESTIONS = [
  {
    label: "Main complaints",
    question: "What are the main customer complaints?",
  },
  {
    label: "What people like",
    question: "What do customers like most?",
  },
  {
    label: "What people don't like",
    question: "What do customers dislike most?",
  },
  {
    label: "Pros and cons",
    question: "Summarize the pros and cons.",
  },
  {
    label: "Delivery issues",
    question: "Are there delivery, packaging, or shipping issues?",
  },
  {
    label: "Quality issues",
    question: "Are there quality or durability issues?",
  },
];

function scrapeReviewsFromPage(limit) {
  function parseCompactNumberInPage(value) {
    const match = String(value || "")
      .replace(/,/g, "")
      .match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);

    if (!match) {
      return null;
    }

    const multiplier = match[2]?.toLowerCase() === "m"
      ? 1_000_000
      : match[2]?.toLowerCase() === "k"
        ? 1_000
        : 1;
    const parsed = Number(match[1]) * multiplier;

    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }

  function cleanCandidateText(value) {
    return String(value || "")
      .replace(/\b(?:Read more|Show less|Verified Purchase|Helpful|Report)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isUsefulReviewText(text) {
    const normalized = cleanCandidateText(text);
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;

    if (normalized.length < 20 || normalized.length > 1800 || wordCount < 4) {
      return false;
    }

    const lowerText = normalized.toLowerCase();
    const blockedTexts = [
      "customer reviews",
      "write a review",
      "sort by",
      "filter by",
      "back to top",
      "loading",
    ];

    return !blockedTexts.some((blockedText) => lowerText === blockedText);
  }

  function extractRatingFromTextInPage(text) {
    const normalized = String(text || "").replace(/\s+/g, " ");
    const outOfMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*(5|10)\s*(?:stars?|rating)?/i);

    if (outOfMatch) {
      return {
        rating: Number(outOfMatch[1]),
        rating_max: Number(outOfMatch[2]),
      };
    }

    const starMatch = normalized.match(/(\d+(?:\.\d+)?)\s*stars?/i);

    if (starMatch) {
      return {
        rating: Number(starMatch[1]),
        rating_max: 5,
      };
    }

    return {};
  }

  function closestReviewContainer(element) {
    return (
      element.closest(
        [
          "ytd-comment-thread-renderer",
          "[data-hook='review']",
          "[data-review-id]",
          "[data-testid*='review' i]",
          "[aria-label*='review' i]",
          "[class*='review' i]",
          "[class*='comment' i]",
          ".review",
          ".comment",
          "article",
        ].join(","),
      ) || element
    );
  }

  function extractElementNumberInPage(container, selectors, blockedWords = []) {
    const candidates = Array.from(container.querySelectorAll(selectors.join(",")));

    for (const candidate of candidates) {
      const text = [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.getAttribute("data-count"),
        candidate.getAttribute("data-testid"),
        candidate.innerText,
        candidate.textContent,
      ]
        .filter(Boolean)
        .join(" ");
      const lowerText = text.toLowerCase();

      if (blockedWords.some((word) => lowerText.includes(word))) {
        continue;
      }

      const count = parseCompactNumberInPage(text);

      if (count !== null) {
        return count;
      }
    }

    return null;
  }

  function extractTextCountInPage(text, patterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);

      if (match) {
        return parseCompactNumberInPage(match[1]);
      }
    }

    return null;
  }

  function extractReviewMetadataInPage(element) {
    const container = closestReviewContainer(element);
    const containerText = cleanCandidateText(container.innerText || container.textContent || "");
    const metadata = {};
    const ratingElement = container.querySelector(
      [
        "[itemprop='ratingValue']",
        "[data-hook='review-star-rating']",
        "[data-hook='cmps-review-star-rating']",
        "[aria-label*='star' i]",
        "[aria-label*='rating' i]",
        "[title*='star' i]",
        "[title*='rating' i]",
        "[class*='rating' i]",
        "[class*='star' i]",
      ].join(","),
    );
    const ratingText = [
      ratingElement?.getAttribute("content"),
      ratingElement?.getAttribute("aria-label"),
      ratingElement?.getAttribute("title"),
      ratingElement?.innerText,
      container.getAttribute("aria-label"),
      containerText,
    ]
      .filter(Boolean)
      .join(" ");

    Object.assign(metadata, extractRatingFromTextInPage(ratingText));

    const upvotes = extractElementNumberInPage(
      container,
      [
        "[data-hook='helpful-vote-statement']",
        "[aria-label*='like' i]",
        "[aria-label*='upvote' i]",
        "[aria-label*='helpful' i]",
        "[title*='like' i]",
        "[title*='upvote' i]",
        "[title*='helpful' i]",
        "[class*='like' i]",
        "[class*='upvote' i]",
        "[class*='helpful' i]",
      ],
      ["dislike", "downvote"],
    ) ?? extractTextCountInPage(containerText, [
      /(\d[\d,.]*\s*[kKmM]?)\s*(?:people\s+found\s+this\s+helpful|found\s+this\s+helpful|helpful|upvotes?|likes?)/i,
    ]);

    if (upvotes !== null) {
      metadata.upvotes = upvotes;
    }

    const downvotes = extractElementNumberInPage(
      container,
      [
        "[aria-label*='dislike' i]",
        "[aria-label*='downvote' i]",
        "[title*='dislike' i]",
        "[title*='downvote' i]",
        "[class*='dislike' i]",
        "[class*='downvote' i]",
      ],
    ) ?? extractTextCountInPage(containerText, [
      /(\d[\d,.]*\s*[kKmM]?)\s*(?:downvotes?|dislikes?)/i,
    ]);

    if (downvotes !== null) {
      metadata.downvotes = downvotes;
    }

    const helpfulMatch = containerText.match(/(\d[\d,.]*\s*[kKmM]?)\s+(?:people\s+)?(?:found\s+this\s+)?helpful/i);

    if (helpfulMatch) {
      const helpfulVotes = parseCompactNumberInPage(helpfulMatch[1]);

      if (helpfulVotes !== null) {
        metadata.helpful_votes = helpfulVotes;
        metadata.helpfulness = `${helpfulVotes} helpful`;
      }
    }

    return metadata;
  }

  function addReviewFromElement(element, seen, reviews) {
    const text = cleanCandidateText(element.innerText || element.textContent || "");

    if (!isUsefulReviewText(text)) {
      return false;
    }

    const key = text.toLowerCase();

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    reviews.push({
      text,
      ...extractReviewMetadataInPage(element),
    });

    return true;
  }

  function addReviewFromContainer(container, seen, reviews) {
    const preferredTextElement = container.querySelector(
      [
        "[data-hook='review-body']",
        "[data-hook='review-collapsed']",
        "[data-hook='review-title']",
        "[data-testid*='review-body' i]",
        "[data-testid*='comment' i]",
        "[class*='review-body' i]",
        "[class*='review-text' i]",
        "[class*='review-content' i]",
        "[class*='comment-text' i]",
        "[class*='content-text' i]",
      ].join(","),
    );

    return addReviewFromElement(preferredTextElement || container, seen, reviews);
  }

  const selectors = [
    "ytd-comment-thread-renderer #content-text",
    "[data-hook='review-body']",
    "[data-hook='review-collapsed']",
    "[data-hook='review-title']",
    "[data-testid*='review-body' i]",
    "[data-testid*='comment' i]",
    "[data-review-id]",
    "[data-testid*='review' i]",
    "[aria-label*='review' i]",
    "[class*='review' i]",
    ".review",
    ".review-text",
    ".review-content",
    ".comment",
    ".comment-text",
    "article",
    "p",
  ];
  const containerSelectors = [
    "ytd-comment-thread-renderer",
    "[data-hook='review']",
    "[data-review-id]",
    "[data-testid*='review' i]",
    "[aria-label*='review' i]",
    "[class*='review' i]",
    "[class*='comment' i]",
    "article",
  ];

  const seen = new Set();
  const reviews = [];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));

    for (const element of elements) {
      addReviewFromElement(element, seen, reviews);

      if (reviews.length >= limit) {
        return {
          reviews,
          hitLimit: true,
        };
      }
    }

    if (reviews.length >= 10) {
      return {
        reviews,
        hitLimit: false,
      };
    }
  }

  for (const selector of containerSelectors) {
    const containers = Array.from(document.querySelectorAll(selector));

    for (const container of containers) {
      addReviewFromContainer(container, seen, reviews);

      if (reviews.length >= limit) {
        return {
          reviews,
          hitLimit: true,
        };
      }
    }

    if (reviews.length >= 10) {
      return {
        reviews,
        hitLimit: false,
      };
    }
  }

  return {
    reviews,
    hitLimit: false,
  };
}

function App() {
  const [sessionId, setSessionId] = React.useState(null);
  const [sessionMeta, setSessionMeta] = React.useState(null);
  const [dashboard, setDashboard] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [question, setQuestion] = React.useState("");
  const [error, setError] = React.useState("");
  const [emptyState, setEmptyState] = React.useState(false);
  const [isIndexing, setIsIndexing] = React.useState(false);
  const [isChatBusy, setIsChatBusy] = React.useState(false);
  const chatMessagesRef = React.useRef(null);
  const hasSession = Boolean(sessionId);
  const popupHeightClass = hasSession ? "min-h-[520px]" : "";

  React.useEffect(() => {
    const chatMessages = chatMessagesRef.current;

    if (!chatMessages) {
      return;
    }

    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isChatBusy]);

  async function createOrRefreshSession(shouldRefresh = false) {
    setIsIndexing(true);
    setError("");
    setEmptyState(false);

    try {
      if (shouldRefresh && sessionId) {
        await deleteSessionQuietly(sessionId);
      }

      resetSessionState();

      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id) {
        throw new Error("No active browser tab found.");
      }

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrapeReviewsFromPage,
        args: [SCRAPE_LIMIT],
      });

      const scrapeResult = injectionResults?.[0]?.result || {
        reviews: [],
        hitLimit: false,
      };
      const reviews = scrapeResult.reviews || [];

      if (!reviews.length) {
        setEmptyState(true);
        return;
      }

      const sessionData = await createRagSession(tab, reviews);
      applySessionData(sessionData, Boolean(scrapeResult.hitLimit));
    } catch (caughtError) {
      setError(caughtError.message || "Failed to create RAG session.");
    } finally {
      setIsIndexing(false);
    }
  }

  async function createRagSession(tab, reviews) {
    const response = await fetch(`${API_BASE_URL}/v1/rag/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_url: tab.url || null,
        page_title: tab.title || null,
        reviews,
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      throw new Error(errorPayload?.detail || `Backend error: ${response.status}`);
    }

    return response.json();
  }

  function applySessionData(sessionData, hitLimit) {
    setSessionId(sessionData.session_id);
    setSessionMeta({
      reviewCount: sessionData.review_count,
      chunkCount: sessionData.chunk_count,
      hitLimit,
    });
    setDashboard(buildDashboardFromSession(sessionData));
    setMessages([
      {
        id: makeMessageId(),
        role: "assistant",
        content:
          "Session ready. Ask me about complaints, positives, risks, delivery issues, quality issues, or anything else in the indexed reviews/comments.",
        sources: [],
      },
    ]);
  }

  function buildDashboardFromSession(sessionData) {
    const metrics = sessionData.metrics || {};

    return {
      totalReviews: metrics.total_reviews ?? sessionData.review_count ?? 0,
      positiveCount: metrics.positive ?? 0,
      negativeCount: metrics.negative ?? 0,
      mixedCount: metrics.mixed ?? 0,
      positivePct: metrics.positive_pct ?? 0,
      negativePct: metrics.negative_pct ?? 0,
      mixedPct: metrics.mixed_pct ?? 0,
    };
  }

  async function sendQuestion(nextQuestion) {
    const cleanQuestion = nextQuestion.trim();

    if (!sessionId) {
      setError("Create a RAG session first.");
      return;
    }

    if (!cleanQuestion || isChatBusy) {
      return;
    }

    setError("");
    setQuestion("");
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: makeMessageId(),
        role: "user",
        content: cleanQuestion,
      },
    ]);
    setIsChatBusy(true);

    try {
      const response = await fetch(`${API_BASE_URL}/v1/rag/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: cleanQuestion }),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        throw new Error(errorPayload?.detail || `Backend error: ${response.status}`);
      }

      const data = await response.json();
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: makeMessageId(),
          role: "assistant",
          content: data.answer,
          sources: data.sources || [],
        },
      ]);
    } catch (caughtError) {
      setError(caughtError.message || "Chat request failed.");
    } finally {
      setIsChatBusy(false);
    }
  }

  function resetSessionState() {
    setSessionId(null);
    setSessionMeta(null);
    setDashboard(null);
    setMessages([]);
    setQuestion("");
    setIsChatBusy(false);
  }

  async function deleteSessionQuietly(targetSessionId) {
    try {
      await fetch(`${API_BASE_URL}/v1/rag/sessions/${targetSessionId}`, {
        method: "DELETE",
      });
    } catch {
      // Ignore cleanup errors in the popup.
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    sendQuestion(question);
  }

  return (
    <main className={`${popupHeightClass} w-[430px] bg-shell p-3.5 text-ink transition-[min-height] duration-200`}>
      <header className="rounded-lg bg-primary px-3 py-3 text-white shadow-popup">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 rounded-lg border border-white/20 bg-accent p-2 text-white">
            <MessageSquareText size={18} strokeWidth={2.25} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight">Review RAG Assistant</h1>
            <p className="mt-1 text-[13px] leading-snug text-white/75">
              Index up to 100 visible reviews or comments from the current page, then ask questions about them.
            </p>
          </div>
        </div>
      </header>

      <section className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <button
          type="button"
          onClick={() => createOrRefreshSession(false)}
          disabled={isIndexing}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-bold text-primary shadow-bubble transition hover:bg-primary-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isIndexing ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
          Analyse Comments On Current Page
        </button>

        <button
          type="button"
          onClick={() => createOrRefreshSession(true)}
          disabled={isIndexing || !sessionId}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-primary/20 bg-white px-3 py-2 text-[13px] font-bold text-primary transition hover:border-contrast hover:text-contrast disabled:cursor-not-allowed disabled:opacity-60"
          title="Refresh session"
        >
          <RefreshCw size={15} className={isIndexing ? "animate-spin" : ""} />
          Refresh
        </button>
      </section>

      {isIndexing && (
        <StatusPanel tone="loading" icon={<Loader2 className="animate-spin" size={18} />}>
          Indexing visible reviews and creating a RAG session...
        </StatusPanel>
      )}

      {error && (
        <StatusPanel tone="error" icon={<AlertCircle size={18} />}>
          {error}
        </StatusPanel>
      )}

      {emptyState && (
        <StatusPanel tone="warning" title="No review text found" icon={<AlertCircle size={18} />}>
          Open a page where reviews or comments are visible, scroll them into view, then run the analyzer again.
        </StatusPanel>
      )}

      {sessionMeta && <SessionSummary sessionMeta={sessionMeta} />}
      {dashboard && <Metrics dashboard={dashboard} />}

      {hasSession && (
        <Suggestions
          disabled={isChatBusy}
          onSelect={(suggestedQuestion) => sendQuestion(suggestedQuestion)}
        />
      )}

      {hasSession && <AiDisclaimer />}

      {hasSession && (
        <ChatPanel
          messages={messages}
          isChatBusy={isChatBusy}
          question={question}
          onQuestionChange={setQuestion}
          onSubmit={handleSubmit}
          chatMessagesRef={chatMessagesRef}
        />
      )}
    </main>
  );
}

function AiDisclaimer() {
  return (
    <aside className="mt-3 flex items-start gap-2 rounded-lg border border-primary/10 bg-white px-3 py-2 text-[11px] leading-snug text-muted shadow-sm">
      <Info size={14} className="mt-0.5 shrink-0 text-accent" />
      <p>AI answers are not always 100% correct. If a reply is not relevant, rephrase your question and try again.</p>
    </aside>
  );
}

function StatusPanel({ tone, title, icon, children }) {
  const toneClasses = {
    loading: "border-l-accent bg-white text-primary",
    error: "border-l-contrast bg-white text-contrast",
    warning: "border-l-contrast bg-white text-contrast",
    success: "border-l-accent bg-white text-primary",
  };

  return (
    <section className={`mt-3 rounded-lg border border-primary/10 border-l-4 p-3 text-[13px] leading-snug shadow-sm ${toneClasses[tone]}`}>
      <div className="flex gap-2">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="min-w-0">
          {title && <h2 className="mb-1 text-sm font-bold">{title}</h2>}
          <p>{children}</p>
        </div>
      </div>
    </section>
  );
}

function SessionSummary({ sessionMeta }) {
  const limitText = sessionMeta.hitLimit
    ? ` Scrape limit reached: ${SCRAPE_LIMIT} visible matches.`
    : "";

  return (
    <StatusPanel tone="success" title="Session Ready" icon={<CheckCircle2 size={18} />}>
      Indexed {sessionMeta.reviewCount} reviews into {sessionMeta.chunkCount} chunks.
      {limitText}
    </StatusPanel>
  );
}

function Metrics({ dashboard }) {
  const sentimentPercents = formatSentimentPercentages(dashboard);

  return (
    <section className="mt-3 grid grid-cols-4 gap-2">
      <MetricCard label="Reviews" value={String(dashboard.totalReviews)} tone="primary" />
      <MetricCard label="Positive" value={`${sentimentPercents.positive}%`} tone="accent" />
      <MetricCard label="Negative" value={`${sentimentPercents.negative}%`} tone="contrast" />
      <MetricCard label="Mixed" value={`${sentimentPercents.mixed}%`} tone="mixed" />
    </section>
  );
}

function MetricCard({ label, value, tone }) {
  const toneClasses = {
    primary: "border-primary bg-primary text-white",
    accent: "border-accent bg-accent text-primary",
    contrast: "border-contrast bg-contrast text-white",
    mixed: "border-primary/15 bg-white text-primary",
  };

  return (
    <div className={`min-w-0 rounded-lg border p-2.5 text-center shadow-sm ${toneClasses[tone]}`}>
      <span className="block text-[11px] font-semibold opacity-75">{label}</span>
      <strong className="mt-1 block break-words text-[17px] leading-tight">{value}</strong>
    </div>
  );
}

function Suggestions({ disabled, onSelect }) {
  return (
    <section className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-primary/10 bg-white p-3 shadow-sm">
      <h2 className="col-span-2 text-sm font-bold text-primary">Suggested questions</h2>
      {SUGGESTED_QUESTIONS.map((suggestion) => (
        <button
          key={suggestion.question}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(suggestion.question)}
          className="min-h-9 rounded-lg border border-primary/10 bg-surface px-3 py-2 text-left text-[13px] font-bold leading-tight text-primary transition hover:border-accent hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {suggestion.label}
        </button>
      ))}
    </section>
  );
}

function ChatPanel({
  messages,
  isChatBusy,
  question,
  onQuestionChange,
  onSubmit,
  chatMessagesRef,
}) {
  return (
    <section className="mt-3 overflow-hidden rounded-lg border border-primary/10 bg-white shadow-popup">
      <div className="flex items-center justify-between border-b border-primary/10 bg-primary px-3 py-2.5 text-white">
        <h2 className="text-sm font-bold">Review chat</h2>
      </div>

      <div
        ref={chatMessagesRef}
        className="scrollbar-thin flex min-h-[180px] max-h-[330px] flex-col gap-2.5 overflow-y-auto bg-surface p-3"
        aria-live="polite"
      >
        {messages.length === 0 && (
          <div className="m-auto text-center text-xs text-muted/75">
            Messages will appear here once a session is ready.
          </div>
        )}

        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}

        {isChatBusy && (
          <ChatMessage
            message={{
              id: "loading",
              role: "assistant",
              content: "",
              loading: true,
            }}
          />
        )}
      </div>

      <form onSubmit={onSubmit} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-primary/10 bg-white p-2.5">
        <textarea
          rows={2}
          value={question}
          disabled={isChatBusy}
          onChange={(event) => onQuestionChange(event.target.value)}
          aria-label="Ask about the indexed reviews/comments"
          placeholder="Ask about the indexed reviews/comments..."
          className="min-h-[42px] max-h-24 w-full resize-none rounded-lg border border-primary/15 bg-surface px-3 py-2 text-[13px] leading-snug text-ink outline-none transition placeholder:text-muted/45 focus:border-accent focus:bg-white focus:ring-4 focus:ring-accent/15 disabled:bg-primary-soft/45 disabled:text-muted/70"
        />
        <button
          type="submit"
          disabled={isChatBusy || !question.trim()}
          className="inline-flex min-w-[64px] items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-bold text-primary transition hover:bg-primary hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Send size={15} />
          Send
        </button>
      </form>
    </section>
  );
}

function ChatMessage({ message }) {
  const isUser = message.role === "user";

  return (
    <article
      className={`flex max-w-[86%] flex-col rounded-lg px-2.5 py-2 text-[13px] leading-snug ${
        isUser
          ? "self-end rounded-br-sm bg-primary text-white shadow-bubble"
          : "self-start rounded-bl-sm border border-primary/10 bg-white text-ink shadow-sm"
      } ${message.loading ? "w-fit min-w-[76px]" : ""}`}
    >
      <div
        className={`mb-1 flex items-center gap-1.5 text-[11px] font-extrabold ${
          isUser ? "text-white/80" : "text-accent"
        }`}
      >
        {isUser ? <UserRound size={12} /> : <Bot size={12} />}
        {isUser ? "You" : "Assistant"}
      </div>

      {message.loading ? (
        <TypingIndicator />
      ) : (
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
      )}

      {message.sources?.length > 0 && <Sources sources={message.sources} />}
    </article>
  );
}

function TypingIndicator() {
  return (
    <span
      className="typing-indicator"
      role="status"
      aria-label="Assistant is typing"
    >
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  );
}

function Sources({ sources }) {
  return (
    <details className="mt-2 border-t border-primary/10 pt-2">
      <summary className="cursor-pointer text-xs font-extrabold text-accent">
        Show relevant reviews/comments ({sources.length})
      </summary>

      <div className="mt-2 space-y-2">
        {sources.map((source, index) => {
          const opinion = formatOpinionLabel(source.metadata?.sentiment_label);
          const relevance = formatConfidencePercent(source.score);
          const metadataBadges = sourceMetadataBadges(source.metadata || {});

          return (
            <div
              key={`${source.chunk_id || source.review_id || "source"}-${index}`}
              className="rounded-lg border border-primary/10 bg-surface p-2 text-xs text-primary"
            >
              <div className="mb-2 flex flex-wrap gap-1.5 font-bold">
                <span className={`rounded border px-2 py-0.5 ${opinion.className}`}>
                  Opinion: {opinion.label}
                </span>
                <span className="rounded border border-primary/10 bg-white px-2 py-0.5 text-muted">
                  Query relevance: {relevance}
                </span>
                {metadataBadges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded border border-primary/10 bg-white px-2 py-0.5 text-muted"
                  >
                    {badge}
                  </span>
                ))}
              </div>
              <p className="max-h-24 overflow-auto leading-snug">{source.text || ""}</p>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function formatOpinionLabel(label) {
  const normalizedLabel = String(label || "mixed").toLowerCase();

  if (normalizedLabel === "positive") {
    return {
      label: "Positive",
      className: "border-accent bg-accent text-primary",
    };
  }

  if (normalizedLabel === "negative") {
    return {
      label: "Negative",
      className: "border-contrast bg-contrast text-white",
    };
  }

  return {
    label: "Mixed",
    className: "border-primary/15 bg-white text-primary",
  };
}

function sourceMetadataBadges(metadata) {
  const badges = [];

  if (metadata.rating !== undefined && metadata.rating !== null && metadata.rating !== "") {
    const ratingMax = metadata.rating_max || 5;
    badges.push(`Rating: ${metadata.rating}/${ratingMax}`);
  }

  if (metadata.helpfulness) {
    badges.push(`Helpfulness: ${metadata.helpfulness}`);
  } else if (metadata.helpful_votes !== undefined && metadata.helpful_votes !== null) {
    badges.push(`Helpful: ${formatCount(metadata.helpful_votes)}`);
  }

  if (metadata.upvotes !== undefined && metadata.upvotes !== null) {
    badges.push(`Upvotes: ${formatCount(metadata.upvotes)}`);
  }

  if (metadata.downvotes !== undefined && metadata.downvotes !== null) {
    badges.push(`Downvotes: ${formatCount(metadata.downvotes)}`);
  }

  return badges;
}

function formatCount(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  return Intl.NumberFormat("en", {
    notation: numericValue >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(numericValue);
}

function formatConfidencePercent(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return "N/A";
  }

  const clampedValue = Math.min(Math.max(numericValue, 0), 1);
  return `${Math.round(clampedValue * 100)}%`;
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

function formatSentimentPercentages(dashboard) {
  const counts = [
    Number(dashboard.positiveCount),
    Number(dashboard.negativeCount),
    Number(dashboard.mixedCount),
  ];
  const countTotal = counts.reduce(
    (sum, count) => sum + (Number.isFinite(count) ? count : 0),
    0,
  );

  if (countTotal > 0) {
    const rawTenths = counts.map((count) => (Math.max(count, 0) / countTotal) * 1000);
    const floorTenths = rawTenths.map(Math.floor);
    let remainingTenths = 1000 - floorTenths.reduce((sum, value) => sum + value, 0);
    const order = rawTenths
      .map((rawValue, index) => ({
        index,
        remainder: rawValue - floorTenths[index],
      }))
      .sort((left, right) => right.remainder - left.remainder);

    for (const item of order) {
      if (remainingTenths <= 0) {
        break;
      }

      floorTenths[item.index] += 1;
      remainingTenths -= 1;
    }

    return {
      positive: formatPercent(floorTenths[0] / 10),
      negative: formatPercent(floorTenths[1] / 10),
      mixed: formatPercent(floorTenths[2] / 10),
    };
  }

  const positive = Number(dashboard.positivePct) || 0;
  const negative = Number(dashboard.negativePct) || 0;
  const mixed = Math.max(0, 100 - positive - negative);

  return {
    positive: formatPercent(positive),
    negative: formatPercent(negative),
    mixed: formatPercent(mixed),
  };
}

function makeMessageId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

createRoot(document.getElementById("root")).render(<App />);
