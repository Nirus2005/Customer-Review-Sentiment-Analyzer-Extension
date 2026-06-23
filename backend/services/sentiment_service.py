import os
import re
from collections import Counter
from typing import Any

import torch
from transformers import pipeline

from schemas import AnalyzeResponse, ReviewResult, SentimentBreakdown
from services.text_utils import clean_reviews


STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "was", "were", "are", "but",
    "not", "you", "your", "have", "has", "had", "they", "them", "from", "too",
    "very", "just", "would", "could", "should", "about", "into", "than", "then",
    "there", "their", "its", "it's", "product", "item", "review", "reviews",
    "really", "also", "when", "what", "which", "only", "after", "before",
}

MIXED_REVIEW_NEGATIVE_TERMS = {
    "bad",
    "broken",
    "complaint",
    "complaints",
    "concern",
    "concerns",
    "damage",
    "damaged",
    "defect",
    "defective",
    "delay",
    "delayed",
    "disappointed",
    "disappointing",
    "issue",
    "issues",
    "late",
    "poor",
    "problem",
    "problems",
    "refund",
    "return",
    "worse",
    "worst",
}

MIXED_REVIEW_POSITIVE_TERMS = {
    "best",
    "excellent",
    "good",
    "great",
    "happy",
    "like",
    "liked",
    "love",
    "loved",
    "perfect",
    "recommend",
    "satisfied",
    "worth",
}


class SentimentService:
    def __init__(self) -> None:
        self.sentiment_model_name = os.getenv(
            "SENTIMENT_MODEL",
            "distilbert-base-uncased-finetuned-sst-2-english",
        )
        self.summary_model_name = os.getenv(
            "SUMMARY_MODEL",
            "sshleifer/distilbart-cnn-12-6",
        )
        self.sentiment_analyzer = None
        self.summarizer = None

    def load_sentiment_model(self) -> None:
        if self.sentiment_analyzer is not None:
            return

        device = 0 if torch.cuda.is_available() else -1

        self.sentiment_analyzer = pipeline(
            "sentiment-analysis",
            model=self.sentiment_model_name,
            device=device,
        )

    def load_summarizer_model(self) -> None:
        if self.summarizer is not None:
            return

        device = 0 if torch.cuda.is_available() else -1

        self.summarizer = pipeline(
            "summarization",
            model=self.summary_model_name,
            device=device,
        )

    def load_models(self) -> None:
        self.load_sentiment_model()
        self.load_summarizer_model()

    def analyze(self, reviews: list[str]) -> AnalyzeResponse:
        self.load_models()

        cleaned_reviews = clean_reviews(reviews)

        if not cleaned_reviews:
            raise ValueError("No valid review text found.")

        raw_predictions = self._predict_sentiment(cleaned_reviews)

        review_results: list[ReviewResult] = []
        positive_count = 0
        negative_count = 0
        confidence_sum = 0.0
        negative_review_texts: list[str] = []

        for text, prediction in zip(cleaned_reviews, raw_predictions):
            label = prediction["label"].upper()
            confidence = float(prediction["score"])

            if label == "POSITIVE":
                positive_count += 1
            else:
                negative_count += 1
                negative_review_texts.append(text)

            confidence_sum += confidence

            review_results.append(
                ReviewResult(
                    text=text,
                    label=label,
                    confidence=round(confidence, 4),
                )
            )

        total = len(cleaned_reviews)
        summary_source = negative_review_texts if negative_review_texts else cleaned_reviews

        return AnalyzeResponse(
            total_reviews=total,
            sentiment=SentimentBreakdown(
                positive=positive_count,
                negative=negative_count,
                positive_pct=round((positive_count / total) * 100, 2),
                negative_pct=round((negative_count / total) * 100, 2),
                average_confidence=round(confidence_sum / total, 4),
            ),
            summary=self._summarize_reviews(summary_source),
            top_negative_terms=self._extract_keywords(summary_source),
            reviews=review_results,
        )

    def classify_reviews_for_rag(self, reviews: list[str]) -> list[dict[str, str | float]]:
        cleaned_reviews = clean_reviews(reviews)

        if not cleaned_reviews:
            return []

        raw_predictions = self._predict_sentiment(cleaned_reviews)

        labels: list[dict[str, str | float]] = []

        for review, prediction in zip(cleaned_reviews, raw_predictions):
            raw_label = str(prediction["label"]).lower()
            confidence = float(prediction["score"])
            has_negative_signal = self._has_any_term(review, MIXED_REVIEW_NEGATIVE_TERMS)
            has_positive_signal = self._has_any_term(review, MIXED_REVIEW_POSITIVE_TERMS)

            if confidence < 0.65:
                label = "mixed"
            elif raw_label == "positive" and has_negative_signal:
                label = "mixed"
            elif raw_label != "positive" and has_positive_signal:
                label = "mixed"
            elif raw_label == "positive":
                label = "positive"
            else:
                label = "negative"

            labels.append(
                {
                    "sentiment_label": label,
                    "sentiment_score": round(confidence, 4),
                    "polarity_label": "positive" if raw_label == "positive" else "negative",
                }
            )

        return labels

    def build_rag_analytics(
        self,
        reviews: list[str],
        review_sentiments: list[dict[str, str | float]],
    ) -> dict[str, list[dict[str, Any]]]:
        cleaned_reviews = clean_reviews(reviews)
        grouped_reviews: dict[str, list[str]] = {
            "positive": [],
            "negative": [],
            "mixed": [],
            "all": [],
        }

        for review, sentiment in zip(cleaned_reviews, review_sentiments):
            label = str(sentiment.get("sentiment_label") or "unknown").lower()
            grouped_reviews["all"].append(review)

            if label in grouped_reviews:
                grouped_reviews[label].append(review)

        complaint_reviews = grouped_reviews["negative"] + grouped_reviews["mixed"]
        praise_reviews = grouped_reviews["positive"] + grouped_reviews["mixed"]

        return {
            "top_overall_terms": self._extract_keywords(grouped_reviews["all"], limit=6),
            "top_positive_terms": self._extract_keywords(praise_reviews, limit=6),
            "top_negative_terms": self._extract_keywords(complaint_reviews, limit=6),
            "top_mixed_terms": self._extract_keywords(grouped_reviews["mixed"], limit=4),
        }

    def _predict_sentiment(self, reviews: list[str]):
        self.load_sentiment_model()

        return self.sentiment_analyzer(
            reviews,
            truncation=True,
            batch_size=16,
        )

    def _has_any_term(self, text: str, terms: set[str]) -> bool:
        tokens = set(re.findall(r"[a-z][a-z\-']*", text.lower()))
        return bool(tokens & terms)

    def _summarize_reviews(self, texts: list[str]) -> str:
        if not texts:
            return "No review text was available for summarization."

        combined = " ".join(texts)[:3500]

        if len(combined.split()) < 35:
            return "Not enough review text to generate a reliable summary."

        try:
            result = self.summarizer(
                combined,
                max_length=110,
                min_length=25,
                do_sample=False,
            )
            return result[0]["summary_text"]
        except Exception:
            return "Summary could not be generated for this review batch."

    def _extract_keywords(
        self,
        texts: list[str],
        limit: int = 8,
    ) -> list[dict[str, Any]]:
        joined = " ".join(texts).lower()
        words = re.findall(r"[a-z][a-z\-]{2,}", joined)

        filtered = [
            word
            for word in words
            if word not in STOPWORDS and len(word) > 2
        ]

        return [
            {"term": term, "count": count}
            for term, count in Counter(filtered).most_common(limit)
        ]
