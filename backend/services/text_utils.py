import os
import re


MAX_REVIEWS = int(os.getenv("MAX_REVIEWS", "100"))
MAX_CHARS_PER_REVIEW = int(os.getenv("MAX_CHARS_PER_REVIEW", "1500"))


def clean_text(text:str) -> str :
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[:MAX_CHARS_PER_REVIEW]


def clean_reviews(reviews: list[str]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()

    for review in reviews:
        text = clean_text(review)

        if len(text) < 8:
            continue

        normalized_key = text.lower()

        if normalized_key in seen:
            continue

        seen.add(normalized_key)
        cleaned.append(text)

        if len(cleaned) >= MAX_REVIEWS:
            break

    return cleaned
