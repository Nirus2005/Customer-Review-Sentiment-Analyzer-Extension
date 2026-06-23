import os
import re
from typing import Any


MAX_REVIEWS = int(os.getenv("MAX_REVIEWS", "100"))
MAX_CHARS_PER_REVIEW = int(os.getenv("MAX_CHARS_PER_REVIEW", "1500"))


def clean_text(text:str) -> str :
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[:MAX_CHARS_PER_REVIEW]


def clean_reviews(reviews: list[Any]) -> list[str]:
    return [
        record["text"]
        for record in clean_review_records(reviews)
    ]


def clean_review_records(reviews: list[Any]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()

    for review in reviews:
        record = review_to_record(review)
        text = clean_text(record.get("text", ""))

        if len(text) < 8:
            continue

        normalized_key = text.lower()

        if normalized_key in seen:
            continue

        seen.add(normalized_key)
        record["text"] = text
        cleaned.append(record)

        if len(cleaned) >= MAX_REVIEWS:
            break

    return cleaned


def review_to_record(review: Any) -> dict[str, Any]:
    if isinstance(review, str):
        return {"text": review}

    if hasattr(review, "model_dump"):
        data = review.model_dump()
    elif hasattr(review, "dict"):
        data = review.dict()
    elif isinstance(review, dict):
        data = dict(review)
    else:
        return {"text": str(review or "")}

    text = (
        data.get("text")
        or data.get("review")
        or data.get("content")
        or data.get("comment")
        or ""
    )
    record: dict[str, Any] = {"text": text}

    metadata = data.get("metadata")
    if isinstance(metadata, dict):
        record.update(metadata)

    for key in (
        "rating",
        "rating_max",
        "upvotes",
        "downvotes",
        "helpfulness",
        "helpful_votes",
        "total_votes",
        "review_date",
        "author",
    ):
        if key in data:
            record[key] = data[key]

    return record
