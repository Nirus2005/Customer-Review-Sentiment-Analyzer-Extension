const SCRAPER_CONTENT_SCRIPT_FILE = "dist/contentScraper.js";

export async function scrapeReviewsInTab({
  tabId,
  frameId,
  allFrames = false,
  limit = null,
  options = {},
}) {
  const target = targetForFrame(tabId, frameId, allFrames);

  await chrome.scripting.executeScript({
    target,
    files: [SCRAPER_CONTENT_SCRIPT_FILE],
  });

  const injectionResults = await chrome.scripting.executeScript({
    target,
    func: runVerdictScraper,
    args: [limit, options],
  });

  return injectionResults?.[0]?.result || {
    reviews: [],
    hitLimit: false,
  };
}

export async function scrapeSelectionInTab({
  tabId,
  frameId,
  limit = null,
  options = {},
}) {
  const selectionOptions = {
    ...(options && typeof options === "object" ? options : {}),
    selectionOnly: true,
  };

  if (Number.isInteger(frameId)) {
    return scrapeReviewsInTab({
      tabId,
      frameId,
      limit,
      options: selectionOptions,
    });
  }

  try {
    const allFrameResults = await scrapeReviewsInAllFrames({
      tabId,
      limit,
      options: selectionOptions,
    });
    const selectedFrameResult = allFrameResults.find((item) => item.result?.selectionFound);

    if (selectedFrameResult?.result) {
      return selectedFrameResult.result;
    }
  } catch {
    // Some pages include protected frames. Fall back to the top frame below.
  }

  return scrapeReviewsInTab({
    tabId,
    limit,
    options: selectionOptions,
  });
}

async function scrapeReviewsInAllFrames({
  tabId,
  limit = null,
  options = {},
}) {
  const target = targetForFrame(tabId, undefined, true);

  await chrome.scripting.executeScript({
    target,
    files: [SCRAPER_CONTENT_SCRIPT_FILE],
  });

  return chrome.scripting.executeScript({
    target,
    func: runVerdictScraper,
    args: [limit, options],
  });
}

function targetForFrame(tabId, frameId, allFrames = false) {
  if (Number.isInteger(frameId)) {
    return {
      tabId,
      frameIds: [frameId],
    };
  }

  if (allFrames) {
    return {
      tabId,
      allFrames: true,
    };
  }

  return { tabId };
}

function runVerdictScraper(limit, options) {
  const scraper = globalThis.__VERDICT_SCRAPER__;

  if (!scraper?.scrapeReviewsFromPage) {
    throw new Error("Verdict scraper failed to load in the page.");
  }

  return scraper.scrapeReviewsFromPage(limit, options);
}
