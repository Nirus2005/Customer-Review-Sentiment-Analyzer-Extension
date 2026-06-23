import os
from datetime import datetime
from typing import Any
from pydantic import BaseModel, Field


MAX_REVIEWS = int(os.getenv("MAX_REVIEWS", "100"))


class ReviewInput(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    rating: float | None = None
    rating_max: float | None = None
    upvotes: int | None = None
    downvotes: int | None = None
    helpfulness: str | None = None
    helpful_votes: int | None = None
    total_votes: int | None = None
    review_date: str | None = None
    author: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AnalyzeRequest(BaseModel):
    reviews: list[str | ReviewInput] = Field(..., min_length=1, max_length=MAX_REVIEWS)


class SentimentBreakdown(BaseModel):
    positive: int
    negative: int
    positive_pct: float
    negative_pct: float
    average_confidence: float


class ReviewResult(BaseModel):
    text: str
    label: str
    confidence: float


class AnalyzeResponse(BaseModel):
    total_reviews: int
    sentiment: SentimentBreakdown
    summary: str
    top_negative_terms: list[dict[str, Any]]
    reviews: list[ReviewResult]


class RagSessionCreateRequest(BaseModel):
    page_url: str | None = None
    page_title: str | None = None
    reviews: list[str | ReviewInput] = Field(..., min_length=1, max_length=MAX_REVIEWS)


class RagSessionMetrics(BaseModel):
    total_reviews: int
    positive: int
    negative: int
    mixed: int = 0
    positive_pct: float
    negative_pct: float
    mixed_pct: float = 0.0
    average_confidence: float = 0.0


class RagSessionCreateResponse(BaseModel):
    session_id: str
    review_count: int
    chunk_count: int
    metrics: RagSessionMetrics | None = None
    message: str


class RagChatRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=1000)


class RagSource(BaseModel):
    review_id: str
    chunk_id: str | None = None
    review_index: int | None = None
    text: str
    score: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RagDebug(BaseModel):
    retrieved_count: int
    collection_name: str
    model : str
    prompt_preview: str


class RagChatResponse(BaseModel):
    session_id: str
    answer: str
    sources: list[RagSource] = Field(default_factory=list)
    debug: RagDebug | None = None


class RagSessionInfo(BaseModel):
    session_id: str
    collection_name: str 
    page_url: str | None = None
    page_title: str | None = None
    review_count: int
    chunk_count: int
    created_at: datetime
    last_accessed_at: datetime
    expires_at: datetime
    chat_turns: int
    chat_history: list[dict[str, str]] = Field(default_factory=list)
    conversation_summary: str = ""


class DeleteSessionResponse(BaseModel):
    deleted : bool
    session_id : str
