import {
  scrapeReviewsFromPage,
  scrapeReviewsFromSelection,
} from "./pageScraper.js";

const scraperApi = {
  scrapeReviewsFromPage,
  scrapeReviewsFromSelection,
};

globalThis.__VERDICT_SCRAPER__ = scraperApi;
