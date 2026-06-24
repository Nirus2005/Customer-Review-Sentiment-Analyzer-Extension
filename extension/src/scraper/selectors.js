export const REVIEW_CONTAINER_SELECTORS = [
  "ytd-comment-thread-renderer",
  "[data-hook='review']",
  "[data-review-id]",
  "[itemprop='review']",
  "[itemtype*='Review' i]",
  "[data-testid*='review' i]",
  "[aria-label*='review' i]",
  "[class*='review' i]",
  "[class*='comment' i]",
  "article",
];

export const CLOSEST_REVIEW_CONTAINER_SELECTORS = [
  ...REVIEW_CONTAINER_SELECTORS,
  ".review",
  ".comment",
];

export const FALLBACK_TEXT_SELECTORS = [
  "ytd-comment-thread-renderer #content-text",
  "[data-hook='review-body']",
  "[data-hook='review-collapsed']",
  "[data-testid*='review-body' i]",
  "[data-testid*='comment' i]",
  "[itemprop='reviewBody']",
  ".review-text",
  ".review-content",
  ".comment-text",
];

export const REVIEW_TEXT_SELECTORS = [
  "[data-hook='review-title']",
  "[data-hook='review-body']",
  "[data-hook='review-collapsed']",
  "[data-testid*='review-title' i]",
  "[data-testid*='review-body' i]",
  "[data-testid*='comment' i]",
  "[itemprop='reviewBody']",
  "[class*='review-title' i]",
  "[class*='review-body' i]",
  "[class*='review-text' i]",
  "[class*='review-content' i]",
  "[class*='comment-text' i]",
  "[class*='content-text' i]",
  "#content-text",
];

export const RATING_SELECTORS = [
  "[itemprop='ratingValue']",
  "[itemprop='reviewRating']",
  "[data-hook='review-star-rating']",
  "[data-hook='cmps-review-star-rating']",
  "[aria-label*='star' i]",
  "[aria-label*='rating' i]",
  "[title*='star' i]",
  "[title*='rating' i]",
  "[class*='rating' i]",
  "[class*='star' i]",
  "._3LWZlK",
  ".XQDdHH",
];

export const TITLE_SELECTORS = [
  "[data-hook='review-title']",
  "[data-testid*='review-title' i]",
  "[itemprop='name']",
  "[class*='review-title' i]",
  "[class*='title' i]",
  "h1",
  "h2",
  "h3",
  "h4",
];

export const AUTHOR_SELECTORS = [
  "[itemprop='author'] [itemprop='name']",
  "[itemprop='author']",
  "[data-hook='review-author']",
  "[data-hook='genome-widget']",
  "[data-testid*='author' i]",
  "[data-testid*='user' i]",
  "[class*='author' i]",
  "[class*='user' i]",
  "[class*='profile' i]",
  "[aria-label*='author' i]",
];

export const DATE_SELECTORS = [
  "time[datetime]",
  "[datetime]",
  "[itemprop='datePublished']",
  "[data-hook*='review-date' i]",
  "[class*='date' i]",
  "[aria-label*='date' i]",
];

export const UPVOTE_SELECTORS = [
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
];

export const DOWNVOTE_SELECTORS = [
  "[aria-label*='dislike' i]",
  "[aria-label*='downvote' i]",
  "[title*='dislike' i]",
  "[title*='downvote' i]",
  "[class*='dislike' i]",
  "[class*='downvote' i]",
];
