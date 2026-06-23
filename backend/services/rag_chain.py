import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

from schemas import RagChatResponse, RagDebug, RagSource
from services.session_manager import SessionManager
from services.vector_store import VectorStoreService


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROMPT_DIR = PROJECT_ROOT / "prompts"

FALLBACK_ANSWER = "I could not find anything relevant to that in the indexed reviews/comments."

BALANCED_QUERY_PHRASES = {
    "pros and cons",
    "positive and negative",
    "good and bad",
    "strengths and weaknesses",
    "advantages and disadvantages",
}

NEGATIVE_QUERY_PHRASES = {
    "do not like",
    "don't like",
    "did not like",
    "didn't like",
    "not good",
    "not worth",
    "went wrong",
}

POSITIVE_QUERY_PHRASES = {
    "works well",
    "worth buying",
    "worth it",
}

NEGATIVE_QUERY_TERMS = {
    "bad",
    "complaint",
    "complaints",
    "concern",
    "concerns",
    "con",
    "cons",
    "damage",
    "damaged",
    "defect",
    "defective",
    "delay",
    "delayed",
    "disappointing",
    "dislike",
    "drawback",
    "drawbacks",
    "fail",
    "failed",
    "failure",
    "issue",
    "issues",
    "late",
    "negative",
    "poor",
    "problem",
    "problems",
    "refund",
    "return",
    "risk",
    "risks",
    "worse",
    "worst",
}

POSITIVE_QUERY_TERMS = {
    "benefit",
    "benefits",
    "best",
    "good",
    "great",
    "happy",
    "like",
    "liked",
    "likes",
    "love",
    "loved",
    "positive",
    "praise",
    "pro",
    "pros",
    "recommend",
    "satisfied",
    "strength",
    "strengths",
}

OVERALL_QUERY_PHRASES = {
    "overall sentiment",
    "general sentiment",
    "overall opinion",
    "overall verdict",
    "worth buying",
    "worth it",
    "should i buy",
    "should we buy",
    "would you recommend",
}

OVERALL_QUERY_TERMS = {
    "consensus",
    "majority",
    "overall",
    "recommendation",
    "sentiment",
    "summary",
    "summarize",
    "takeaway",
    "verdict",
}

DETAILED_QUERY_TERMS = {
    "breakdown",
    "compare",
    "comparison",
    "detail",
    "details",
    "example",
    "examples",
    "list",
}

SOURCE_QUERY_PHRASES = {
    "exact reviews",
    "show reviews",
    "show me reviews",
    "source reviews",
    "which reviews",
}


@dataclass(frozen=True)
class GenerationResult:
    answer: str
    truncated: bool
    prompt_echo: bool = False
    unsafe: bool = False


@lru_cache(maxsize=1)
def get_rag_generator():
    model_name = os.getenv("RAG_LLM_MODEL", "HuggingFaceTB/SmolLM2-135M-Instruct")
    trust_remote_code = os.getenv("RAG_TRUST_REMOTE_CODE", "false").lower() == "true"
    load_in_4bit = os.getenv("RAG_LOAD_IN_4BIT", "false").lower() == "true"

    tokenizer = AutoTokenizer.from_pretrained(
        model_name,
        trust_remote_code=trust_remote_code,
    )

    model_kwargs = {
        "trust_remote_code": trust_remote_code,
    }

    if torch.cuda.is_available():
        model_kwargs["device_map"] = "auto"
        model_kwargs["torch_dtype"] = "auto"

        if load_in_4bit:
            model_kwargs["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True)
    else:
        model_kwargs["torch_dtype"] = torch.float32

    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        **model_kwargs,
    )

    if not torch.cuda.is_available():
        model.to("cpu")

    model.eval()

    if tokenizer.pad_token_id is None and tokenizer.eos_token_id is not None:
        tokenizer.pad_token = tokenizer.eos_token

    return tokenizer, model


@lru_cache(maxsize=None)
def load_prompt_template(filename: str) -> str:
    path = PROMPT_DIR / filename

    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")

    return path.read_text(encoding="utf-8").strip()


def render_prompt(template: str, values: dict[str, str]) -> str:
    rendered = template

    for key, value in values.items():
        rendered = rendered.replace("{" + key + "}", value)

    return rendered



class RagChainService :
    def __init__(self, vector_store: VectorStoreService) -> None:
        self.vector_store = vector_store
        self.top_k = int(os.getenv("RAG_TOP_K", "6"))

        self.max_context_tokens = int(os.getenv("RAG_MAX_CONTEXT_TOKENS", "1600"))
        self.debug_enabled = os.getenv("RAG_DEBUG", "false").lower() == "true"
        self.model_name = os.getenv("RAG_LLM_MODEL", "HuggingFaceTB/SmolLM2-135M-Instruct")
        self.min_relevance = float(os.getenv("RAG_MIN_RELEVANCE", "0.25"))
        self.relevance_score_drop = float(os.getenv("RAG_RELEVANCE_SCORE_DROP", "0.20"))
        self.fetch_multiplier = max(1, int(os.getenv("RAG_FETCH_MULTIPLIER", "2")))
        self.min_source_count = min(
            self.top_k,
            max(1, int(os.getenv("RAG_MIN_SOURCE_COUNT", "3"))),
        )
        self.source_score_floor = float(os.getenv("RAG_SOURCE_SCORE_FLOOR", "0.08"))
        self.max_source_count = max(
            self.top_k,
            int(os.getenv("RAG_MAX_SOURCE_COUNT", "16")),
        )
        self.max_new_tokens = int(os.getenv("RAG_MAX_NEW_TOKENS", "220"))
        self.max_recent_messages = int(os.getenv("RAG_MAX_RECENT_MESSAGES", "8"))
        self.max_summary_tokens = int(os.getenv("RAG_MAX_SUMMARY_TOKENS", "180"))       
    
    def answer_question(
        self,
        session_id: str,
        question: str,
        session_manager: SessionManager,
    ) -> RagChatResponse:
        record = session_manager.get_session(session_id)
        if record is None:
            raise KeyError(f"Session not found: {session_id}")

        clean_question = question.strip()

        if not clean_question:
            raise ValueError("Question cannot be empty.")

        query_sentiment = self._detect_query_sentiment(clean_question)
        query_intent = self._detect_query_intent(clean_question, query_sentiment)
        sentiment_labels = self._sentiment_labels_for_query(query_sentiment)
        top_k = self._top_k_for_intent(query_intent)
        max_source_count = self._max_source_count_for_intent(query_intent)
        min_source_count = self._min_source_count_for_intent(query_intent)
        max_context_tokens = self._context_token_limit_for_intent(query_intent)
        max_new_tokens = self._new_token_limit_for_intent(query_intent)

        retrieved_items = self.vector_store.query(
            session_id=session_id,
            question=clean_question,
            top_k=top_k,
            sentiment_labels=sentiment_labels,
            fetch_k=self._fetch_k_for_intent(
                top_k=top_k,
                max_source_count=max_source_count,
            ),
        )

        retrieved_items = self._select_relevant_items(
            retrieved_items,
            max_source_count=max_source_count,
            min_source_count=min_source_count,
        )

        if not retrieved_items:
            answer = self._fallback_answer_for_query_sentiment(query_sentiment)

            session_manager.append_chat_message(session_id, "user", clean_question)
            session_manager.append_chat_message(session_id, "assistant", answer)

            self._compact_chat_history_if_needed(
                session_id=session_id,
                session_manager=session_manager,
            )

            return RagChatResponse(
                session_id=session_id,
                answer=answer,
                sources=[],
                debug=None,
            )

        tokenizer, _ = get_rag_generator()

        context, context_items = self._format_context(
            retrieved_items=retrieved_items,
            tokenizer=tokenizer,
            max_context_tokens=max_context_tokens,
        )
        sources = self._build_sources(context_items)

        recent_history = self._format_history(record.chat_history[-self.max_recent_messages:])

        conversation_summary = getattr(
            record,
            "conversation_summary",
            "",
        ) or "No earlier conversation summary."

        session_analytics = self._format_session_analytics(
            record=record,
            query_intent=query_intent,
            query_sentiment=query_sentiment,
        )

        messages = self._build_messages(
            context=context,
            recent_history=recent_history,
            conversation_summary=conversation_summary,
            session_analytics=session_analytics,
            answer_style=self._answer_style_for_intent(query_intent),
            question=clean_question,
        )

        generation = self._generate_answer_result(
            messages,
            max_new_tokens=max_new_tokens,
        )

        if generation.prompt_echo or generation.unsafe:
            retry_generation = self._retry_concise_answer(
                messages,
                max_new_tokens=max_new_tokens,
            )

            if (
                not retry_generation.prompt_echo
                and not retry_generation.unsafe
                and retry_generation.answer != FALLBACK_ANSWER
            ):
                generation = retry_generation

        if generation.truncated:
            retry_generation = self._retry_concise_answer(
                messages,
                max_new_tokens=max_new_tokens,
            )

            if (
                not retry_generation.unsafe
                and retry_generation.answer != FALLBACK_ANSWER
            ):
                generation = retry_generation

        answer = generation.answer
        grounded_answer = self._grounded_summary_from_items(
            context_items=context_items,
            query_intent=query_intent,
        )

        if generation.unsafe and grounded_answer:
            answer = grounded_answer

        session_manager.append_chat_message(session_id, "user", clean_question)
        session_manager.append_chat_message(session_id, "assistant", answer)

        self._compact_chat_history_if_needed(
            session_id=session_id,
            session_manager=session_manager,
        )

        debug = None

        if self.debug_enabled:
            debug = RagDebug(
                retrieved_count=len(context_items),
                collection_name=record.collection_name,
                model=self.model_name,
                prompt_preview=self._preview_messages(messages)[:1200],
            )

        return RagChatResponse(
            session_id=session_id,
            answer=answer,
            sources=sources,
            debug=debug,
        )
    
    def _select_relevant_items(
        self,
        retrieved_items: list[dict],
        max_source_count: int | None = None,
        min_source_count: int | None = None,
    ) -> list[dict]:
        max_source_count = max_source_count or self.max_source_count
        min_source_count = min_source_count or self.min_source_count
        scored_items = [
            item for item in retrieved_items
            if item.get("score") is not None
        ]

        scored_items.sort(key=lambda item: float(item["score"]), reverse=True)

        if not scored_items:
            return []

        best_score = float(scored_items[0]["score"])
        strong_score_cutoff = max(
            self.min_relevance,
            best_score - self.relevance_score_drop,
        )

        selected_items: list[dict] = []
        seen_reviews: set[str] = set()

        for item in scored_items:
            score = float(item["score"])

            if score < strong_score_cutoff:
                continue

            review_key = self._review_key_for_item(item)

            if review_key in seen_reviews:
                continue

            seen_reviews.add(review_key)
            selected_items.append(item)

            if len(selected_items) >= max_source_count:
                return selected_items

        for item in scored_items:
            score = float(item["score"])

            if score < self.min_relevance:
                continue

            review_key = self._review_key_for_item(item)

            if review_key in seen_reviews:
                continue

            seen_reviews.add(review_key)
            selected_items.append(item)

            if len(selected_items) >= max_source_count:
                return selected_items

        if len(selected_items) >= min_source_count:
            return selected_items

        for item in scored_items:
            if len(selected_items) >= min_source_count:
                break

            score = float(item["score"])

            if score < self.source_score_floor:
                continue

            review_key = self._review_key_for_item(item)

            if review_key in seen_reviews:
                continue

            seen_reviews.add(review_key)
            selected_items.append(item)

            if len(selected_items) >= max_source_count:
                break

        return selected_items


    def _build_sources(
        self,
        retrieved_items: list[dict],
    ) -> list[RagSource]:
        source_entries: dict[str, dict] = {}

        for item in retrieved_items:
            document = item["document"]
            metadata = dict(document.metadata)
            score = item.get("score")
            review_key = self._review_key_for_item(item)
            text = self._source_text_for_item(item)

            if not text:
                continue

            metadata.pop("review_text", None)

            if review_key not in source_entries:
                source_entries[review_key] = {
                    "review_id": str(metadata.get("review_id", "")),
                    "chunk_id": metadata.get("chunk_id"),
                    "review_index": metadata.get("review_index"),
                    "text": text,
                    "score": float(score) if score is not None else None,
                    "metadata": metadata,
                }
                continue

            entry = source_entries[review_key]

            if entry["score"] is None and score is not None:
                entry["score"] = float(score)

            if score is not None and entry["score"] is not None:
                entry["score"] = max(entry["score"], float(score))

        sources = [
            RagSource(
                review_id=entry["review_id"],
                chunk_id=entry["chunk_id"],
                review_index=entry["review_index"],
                text=entry["text"],
                score=round(float(entry["score"]), 4) if entry["score"] is not None else None,
                metadata=entry["metadata"],
            )
            for entry in source_entries.values()
        ]

        sources.sort(
            key=lambda source: source.score if source.score is not None else 0.0,
            reverse=True,
        )

        return sources


    def _source_text_for_item(self, item: dict) -> str:
        document = item["document"]
        metadata = dict(document.metadata or {})
        text = str(metadata.get("review_text") or document.page_content or "")
        return text.strip()


    def _review_key_for_item(self, item: dict) -> str:
        document = item["document"]
        metadata = dict(document.metadata or {})

        return str(
            metadata.get("review_id")
            or metadata.get("review_index")
            or metadata.get("chunk_id")
            or hash(document.page_content)
        )


    def _detect_query_sentiment(self, question: str) -> str:
        normalized = question.lower()

        if any(phrase in normalized for phrase in BALANCED_QUERY_PHRASES):
            return "balanced"

        negative_score = sum(
            2 for phrase in NEGATIVE_QUERY_PHRASES
            if phrase in normalized
        )
        positive_score = sum(
            2 for phrase in POSITIVE_QUERY_PHRASES
            if phrase in normalized
        )

        tokens = re.findall(r"[a-z][a-z\-']*", normalized)
        negative_score += sum(1 for token in tokens if token in NEGATIVE_QUERY_TERMS)
        positive_score += sum(1 for token in tokens if token in POSITIVE_QUERY_TERMS)

        if negative_score > positive_score:
            return "negative"

        if positive_score > negative_score:
            return "positive"

        return "neutral"


    def _detect_query_intent(self, question: str, query_sentiment: str) -> str:
        normalized = question.lower()
        tokens = set(re.findall(r"[a-z][a-z\-']*", normalized))

        if any(phrase in normalized for phrase in SOURCE_QUERY_PHRASES):
            return "sources"

        if query_sentiment == "balanced":
            return "balanced"

        if query_sentiment == "negative":
            return "negative"

        if (
            any(phrase in normalized for phrase in OVERALL_QUERY_PHRASES)
            or bool(tokens & OVERALL_QUERY_TERMS)
        ):
            return "overall"

        if query_sentiment == "positive":
            return "positive"

        if bool(tokens & DETAILED_QUERY_TERMS):
            return "detailed"

        return "neutral"


    def _top_k_for_intent(self, query_intent: str) -> int:
        if query_intent in {"balanced", "detailed", "sources"}:
            return min(8, self.top_k)

        if query_intent in {"overall", "neutral"}:
            return min(self.top_k, 5)

        return self.top_k


    def _max_source_count_for_intent(self, query_intent: str) -> int:
        target_by_intent = {
            "balanced": 14,
            "detailed": 14,
            "sources": 16,
            "negative": 12,
            "positive": 12,
            "overall": 10,
            "neutral": 8,
        }
        target = target_by_intent.get(query_intent, 8)
        return max(self.min_source_count, min(self.max_source_count, target))


    def _min_source_count_for_intent(self, query_intent: str) -> int:
        if query_intent in {"overall", "neutral"}:
            return min(self.min_source_count, 2)

        return self.min_source_count


    def _fetch_k_for_intent(self, top_k: int, max_source_count: int) -> int:
        target = max(top_k * self.fetch_multiplier, max_source_count)
        return max(top_k, min(self.max_source_count, target))


    def _context_token_limit_for_intent(self, query_intent: str) -> int:
        target_by_intent = {
            "balanced": 1600,
            "detailed": 1600,
            "sources": 1600,
            "negative": 1300,
            "positive": 1300,
            "overall": 1100,
            "neutral": 1000,
        }
        return min(self.max_context_tokens, target_by_intent.get(query_intent, 1000))


    def _new_token_limit_for_intent(self, query_intent: str) -> int:
        target_by_intent = {
            "balanced": 220,
            "detailed": 220,
            "sources": 220,
            "negative": 180,
            "positive": 180,
            "overall": 170,
            "neutral": 150,
        }
        return min(self.max_new_tokens, target_by_intent.get(query_intent, 150))


    def _sentiment_labels_for_query(self, query_sentiment: str) -> set[str] | None:
        if query_sentiment == "negative":
            return {"negative", "mixed"}

        if query_sentiment == "positive":
            return {"positive", "mixed"}

        return None


    def _fallback_answer_for_query_sentiment(self, query_sentiment: str) -> str:
        if query_sentiment == "negative":
            return "I could not find negative review evidence relevant to that in the indexed reviews/comments."

        if query_sentiment == "positive":
            return "I could not find positive review evidence relevant to that in the indexed reviews/comments."

        return FALLBACK_ANSWER


    def _format_context(
        self,
        retrieved_items: list[dict],
        tokenizer,
        max_context_tokens: int,
    ) -> tuple[str, list[dict]]:
        grouped_reviews: dict[str, dict] = {}

        for item in retrieved_items:
            document = item["document"]
            metadata = dict(document.metadata or {})
            text = document.page_content.strip()

            if not text:
                continue

            review_key = str(
                metadata.get("review_id")
                or metadata.get("review_index")
                or hash(text)
            )

            if review_key not in grouped_reviews:
                grouped_reviews[review_key] = {
                    "metadata": metadata,
                    "items": [],
                    "texts": [],
                }

            grouped_reviews[review_key]["items"].append(item)

            if text not in grouped_reviews[review_key]["texts"]:
                grouped_reviews[review_key]["texts"].append(text)

        blocks: list[str] = []
        context_items: list[dict] = []
        used_tokens = 0

        for index, review in enumerate(grouped_reviews.values(), start=1):
            metadata = review["metadata"]
            text = "\n".join(review["texts"]).strip()

            label_parts = [f"Review {index}"]

            rating = metadata.get("rating")
            if rating is not None:
                rating_max = metadata.get("rating_max")
                if rating_max is not None:
                    label_parts.append(f"rating: {rating}/{rating_max}")
                else:
                    label_parts.append(f"rating: {rating}")

            review_date = metadata.get("review_date") or metadata.get("date")
            if review_date:
                label_parts.append(f"date: {review_date}")

            upvotes = metadata.get("upvotes")
            if upvotes is not None:
                label_parts.append(f"upvotes: {upvotes}")

            downvotes = metadata.get("downvotes")
            if downvotes is not None:
                label_parts.append(f"downvotes: {downvotes}")

            helpfulness = metadata.get("helpfulness")
            if helpfulness:
                label_parts.append(f"helpfulness: {helpfulness}")
            else:
                helpful_votes = metadata.get("helpful_votes")
                total_votes = metadata.get("total_votes")

                if helpful_votes is not None and total_votes is not None:
                    label_parts.append(f"helpfulness: {helpful_votes}/{total_votes}")
                elif helpful_votes is not None:
                    label_parts.append(f"helpful votes: {helpful_votes}")

            label = " | ".join(label_parts)

            block = f"[{label}]\n{text}"

            token_count = len(
                tokenizer.encode(
                    block,
                    add_special_tokens=False,
                )
            )

            if used_tokens + token_count > max_context_tokens:
                break

            blocks.append(block)
            context_items.extend(review["items"])
            used_tokens += token_count

        if not blocks:
            return "No review context available.", []

        return "\n\n".join(blocks), context_items
    

    def _format_history(
        self,
        chat_history: list[dict[str, str]],
    ) -> str:
        if not chat_history:
            return "No previous chat history."

        lines: list[str] = []

        for message in chat_history:
            role = message.get("role", "user").strip().lower()
            content = message.get("content", "").strip()

            if not content:
                continue

            if role not in {"user", "assistant"}:
                role = "user"

            lines.append(f"{role.title()}: {content}")

        return "\n".join(lines) if lines else "No previous chat history."
    

    def _compact_chat_history_if_needed(
        self,
        session_id: str,
        session_manager: SessionManager,
    ) -> None:
        record = session_manager.get_session(session_id)

        if record is None:
            return

        chat_history = getattr(record, "chat_history", []) or []

        if len(chat_history) <= self.max_recent_messages:
            return

        older_messages = chat_history[:-self.max_recent_messages]
        recent_messages = chat_history[-self.max_recent_messages:]

        old_summary = getattr(record, "conversation_summary", "") or "No earlier conversation summary."

        new_summary = self._summarize_old_history(
            old_summary=old_summary,
            older_messages=older_messages,
        )

        session_manager.update_conversation_memory(
            session_id=session_id,
            conversation_summary=new_summary,
            recent_chat_history=recent_messages,
        )


    def _summarize_old_history(
        self,
        old_summary: str,
        older_messages: list[dict[str, str]],
    ) -> str:
        older_chat = self._format_history(older_messages)

        summary_template = load_prompt_template("review_chat_summary_prompt.txt")

        summary_prompt = render_prompt(
            summary_template,
            {
                "OLD_SUMMARY": old_summary.strip() or "No earlier conversation summary.",
                "OLDER_CHAT": older_chat.strip() or "No older chat.",
            },
        )

        messages = [
            {
                "role": "system",
                "content": (
                    "You summarize old chat history for a review-based shopping assistant. "
                    "Do not add new facts. Keep only useful memory for future follow-up questions."
                ),
            },
            {
                "role": "user",
                "content": summary_prompt,
            },
        ]

        summary = self._generate_answer(
            messages=messages,
            max_new_tokens=self.max_summary_tokens,
        )

        return summary.strip() or old_summary


    def _format_session_analytics(
        self,
        record,
        query_intent: str,
        query_sentiment: str,
    ) -> str:
        metrics = getattr(record, "metrics", {}) or {}
        analytics = getattr(record, "analytics", {}) or {}
        lines: list[str] = []

        page_title = (getattr(record, "page_title", "") or "").strip()
        page_url = (getattr(record, "page_url", "") or "").strip()

        if page_title:
            lines.append(f"Page title: {page_title[:160]}")
        elif page_url:
            lines.append(f"Page URL: {page_url[:160]}")

        total_reviews = metrics.get("total_reviews") or getattr(record, "review_count", 0)
        if total_reviews:
            lines.append(f"Indexed reviews/comments: {total_reviews}")

        if metrics:
            if query_sentiment == "negative":
                lines.append(
                    "Relevant distribution: "
                    f"negative {self._count_pct(metrics, 'negative')}; "
                    f"mixed {self._count_pct(metrics, 'mixed')}"
                )
            elif query_sentiment == "positive":
                lines.append(
                    "Relevant distribution: "
                    f"positive {self._count_pct(metrics, 'positive')}; "
                    f"mixed {self._count_pct(metrics, 'mixed')}"
                )
            else:
                lines.append(
                    "Sentiment distribution: "
                    f"positive {self._count_pct(metrics, 'positive')}; "
                    f"negative {self._count_pct(metrics, 'negative')}; "
                    f"mixed {self._count_pct(metrics, 'mixed')}"
                )

            confidence = metrics.get("average_confidence")
            if confidence is not None:
                lines.append(f"Average sentiment confidence: {float(confidence):.2f}")

        if query_intent == "negative":
            self._append_terms_line(lines, "Common complaint terms", analytics.get("top_negative_terms"))
            self._append_terms_line(lines, "Mixed-signal terms", analytics.get("top_mixed_terms"))
        elif query_intent == "positive":
            self._append_terms_line(lines, "Common praise terms", analytics.get("top_positive_terms"))
            self._append_terms_line(lines, "Mixed-signal terms", analytics.get("top_mixed_terms"))
        elif query_intent == "balanced":
            self._append_terms_line(lines, "Common praise terms", analytics.get("top_positive_terms"))
            self._append_terms_line(lines, "Common complaint terms", analytics.get("top_negative_terms"))
        else:
            self._append_terms_line(lines, "Common overall terms", analytics.get("top_overall_terms"))
            self._append_terms_line(lines, "Common praise terms", analytics.get("top_positive_terms"))
            self._append_terms_line(lines, "Common complaint terms", analytics.get("top_negative_terms"))

        return "\n".join(lines) if lines else "No session analytics available."


    def _count_pct(self, metrics: dict, key: str) -> str:
        count = int(metrics.get(key) or 0)
        pct = float(metrics.get(f"{key}_pct") or 0.0)
        return f"{count} ({pct:.1f}%)"


    def _append_terms_line(
        self,
        lines: list[str],
        label: str,
        terms: list[dict] | None,
    ) -> None:
        formatted_terms = self._format_terms(terms or [])

        if formatted_terms:
            lines.append(f"{label}: {formatted_terms}")


    def _format_terms(self, terms: list[dict], limit: int = 6) -> str:
        formatted: list[str] = []

        for item in terms[:limit]:
            term = str(item.get("term") or "").strip()

            if not term:
                continue

            count = int(item.get("count") or 0)
            formatted.append(f"{term} ({count})")

        return ", ".join(formatted)


    def _answer_style_for_intent(self, query_intent: str) -> str:
        if query_intent == "negative":
            return (
                "Write one short paragraph summarizing complaint/dislike themes only. "
                "Do not list individual reviews, chunks, or customer comments. "
                "Do not use Positive/Negative/Mixed labels. "
                "Do not use bullets, numbering, headings, or Markdown bold."
            )

        if query_intent == "positive":
            return (
                "Write one short paragraph summarizing what customers like. "
                "Do not list individual reviews, chunks, or exact comments. "
                "Do not use Positive/Negative/Mixed labels. "
                "Do not use bullets, numbering, headings, or Markdown bold."
            )

        if query_intent == "balanced":
            return (
                "Summarize pros and cons as themes, not as individual reviews or chunks. "
                "Do not quote exact comments. Do not use Markdown bold."
            )

        if query_intent == "sources":
            return (
                "Answer briefly, then let the separate sources panel show exact comments. "
                "Do not use Markdown bold."
            )

        return (
            "Answer briefly in natural language. Do not quote exact comments unless asked. "
            "Do not use Markdown bold."
        )


    def _build_messages(
        self,
        context: str,
        recent_history: str,
        conversation_summary: str,
        session_analytics: str,
        answer_style: str,
        question: str,
    ) -> list[dict[str, str]]:
        system_prompt = load_prompt_template("review_rag_system_prompt.txt")
        user_template = load_prompt_template("review_rag_user_prompt.txt")

        user_prompt = render_prompt(
            user_template,
            {
                "CONTEXT": context.strip() or "No review context available.",
                "RECENT_CHAT": recent_history.strip() or "No previous chat history.",
                "CONVERSATION_SUMMARY": conversation_summary.strip() or "No earlier conversation summary.",
                "SESSION_ANALYTICS": session_analytics.strip() or "No session analytics available.",
                "ANSWER_STYLE": answer_style.strip(),
                "USER_QUERY": question.strip(),
            },
        )

        return [
            {
                "role": "system",
                "content": system_prompt,
            },
            {
                "role": "user",
                "content": user_prompt,
            },
        ]
    

    def _generate_answer(
        self,
        messages: list[dict[str, str]],
        max_new_tokens: int | None = None,
    ) -> str:
        return self._generate_answer_result(
            messages=messages,
            max_new_tokens=max_new_tokens,
        ).answer


    def _retry_concise_answer(
        self,
        messages: list[dict[str, str]],
        max_new_tokens: int | None = None,
    ) -> GenerationResult:
        retry_messages = self._build_concise_retry_messages(messages)
        return self._generate_answer_result(
            retry_messages,
            max_new_tokens=max_new_tokens,
        )


    def _build_concise_retry_messages(
        self,
        messages: list[dict[str, str]],
    ) -> list[dict[str, str]]:
        system_prompt = messages[0].get("content", "") if messages else ""
        user_prompt = messages[1].get("content", "") if len(messages) > 1 else ""

        system_prompt = (
            f"{system_prompt}\n\n"
            "If the answer would be long, prioritize a complete concise answer over detail. "
            "Do not mention token limits, truncation, or retries."
        ).strip()

        concise_instruction = (
            "Reply with only the final user-facing answer. "
            "For complaint or dislike questions, write one plain paragraph of themes only. "
            "Do not use bullets, numbering, headings, Markdown, opinion labels, or exact comments."
        )

        if "\nAnswer:" in user_prompt:
            user_prompt = user_prompt.replace(
                "\nAnswer:",
                f"\n{concise_instruction}\n\nAnswer:",
            )
        else:
            user_prompt = f"{user_prompt}\n\n{concise_instruction}".strip()

        return [
            {
                "role": "system",
                "content": system_prompt,
            },
            {
                "role": "user",
                "content": user_prompt,
            },
        ]


    def _generate_answer_result(
        self,
        messages: list[dict[str, str]],
        max_new_tokens: int | None = None,
    ) -> GenerationResult:
        tokenizer, model = get_rag_generator()
        token_limit = max_new_tokens or self.max_new_tokens

        model_inputs = tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_tensors="pt",
            return_dict=True,
        )

        model_inputs = model_inputs.to(model.device)

        with torch.inference_mode():
            generated_ids = model.generate(
                **model_inputs,
                max_new_tokens=token_limit,
                do_sample=False,
                repetition_penalty=1.08,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
            )

        input_token_count = model_inputs["input_ids"].shape[-1]
        new_tokens = generated_ids[0][input_token_count:]
        hit_token_limit = len(new_tokens) >= token_limit
        ended_with_eos = (
            tokenizer.eos_token_id is not None
            and len(new_tokens) > 0
            and int(new_tokens[-1]) == int(tokenizer.eos_token_id)
        )

        answer = tokenizer.decode(
            new_tokens,
            skip_special_tokens=True,
        ).strip()
        user_question = self._extract_user_question(messages)
        prompt_echo = self._has_prompt_echo(answer, user_question)
        cleaned_answer = self._clean_answer(answer, user_question=user_question)
        unsafe = self._is_unsafe_generated_answer(
            raw_answer=answer,
            cleaned_answer=cleaned_answer,
            user_question=user_question,
        )

        return GenerationResult(
            answer=cleaned_answer,
            truncated=(
                hit_token_limit
                and not ended_with_eos
                and cleaned_answer != FALLBACK_ANSWER
            ),
            prompt_echo=prompt_echo,
            unsafe=unsafe,
        )
    

    def _extract_user_question(self, messages: list[dict[str, str]]) -> str:
        if len(messages) < 2:
            return ""

        user_prompt = messages[1].get("content", "")
        match = re.search(
            r"<user_question>\s*(.*?)\s*</user_question>",
            user_prompt,
            flags=re.IGNORECASE | re.DOTALL,
        )

        return match.group(1).strip() if match else ""


    def _clean_answer(self, answer: str, user_question: str = "") -> str:
        if not answer:
            return FALLBACK_ANSWER

        answer = answer.strip()
        answer = self._strip_model_wrapper_tags(answer)

        bad_markers = [
            "<conversation_summary>",
            "</conversation_summary>",
            "<recent_chat>",
            "</recent_chat>",
            "<reviews>",
            "</reviews>",
            "<session_analytics>",
            "</session_analytics>",
            "<answer_style>",
            "</answer_style>",
            "<user_question>",
            "</user_question>",
            "<previous_chat>",
            "</previous_chat>",
        ]

        for marker in bad_markers:
            if marker in answer:
                answer = answer.split(marker)[0].strip()

        answer = self._remove_leading_prompt_echo(answer)
        answer = self._strip_leading_answer_labels(answer)
        answer = self._remove_markdown_emphasis(answer)
        answer = self._remove_forbidden_openers(answer)
        answer = self._remove_meta_commentary(answer)
        answer = self._remove_forbidden_sections(answer)
        answer = self._remove_markdown_emphasis(answer)
        answer = self._collapse_report_style_answer(answer, user_question)

        if not answer or self._is_question_echo(answer, user_question):
            return FALLBACK_ANSWER

        return answer


    def _strip_model_wrapper_tags(self, answer: str) -> str:
        cleaned = re.sub(
            r"</?(?:response|text|answer|assistant|message|content)[^>]*>",
            "",
            answer,
            flags=re.IGNORECASE,
        )
        cleaned = re.sub(
            r"```(?:xml|json|text)?\s*|\s*```",
            "",
            cleaned,
            flags=re.IGNORECASE,
        )
        return cleaned.strip()


    def _remove_leading_prompt_echo(self, answer: str) -> str:
        lines = answer.splitlines()

        while lines:
            first_line = lines[0].strip()

            if not first_line:
                lines.pop(0)
                continue

            if not re.match(r"^(?:user\s*question|question)\s*:", first_line, flags=re.IGNORECASE):
                break

            inline_answer = re.split(
                r"\b(?:answer|assistant|response)\s*:\s*",
                first_line,
                maxsplit=1,
                flags=re.IGNORECASE,
            )

            if len(inline_answer) > 1 and inline_answer[1].strip():
                lines[0] = inline_answer[1].strip()
                break

            lines.pop(0)

        return "\n".join(lines).strip()


    def _strip_leading_answer_labels(self, answer: str) -> str:
        label_pattern = re.compile(
            r"^\s*(?:final\s+answer|answer|assistant|response|users?'?\s+responses?)\s*:\s*",
            flags=re.IGNORECASE,
        )

        for _ in range(3):
            updated = label_pattern.sub("", answer, count=1).strip()

            if updated == answer:
                break

            answer = updated

        return answer


    def _remove_forbidden_openers(self, answer: str) -> str:
        opener_patterns = [
            r"^\s*based\s+on\b.*(?:review|reviews|excerpts|context|provided).*$",
            r"^\s*here\s+(?:is|are)\b.*$",
            r"^\s*users?'?\s+responses?\s*:\s*$",
        ]
        lines = answer.splitlines()

        while lines:
            first_line = lines[0].strip()

            if not first_line:
                lines.pop(0)
                continue

            if not any(
                re.match(pattern, first_line, flags=re.IGNORECASE)
                for pattern in opener_patterns
            ):
                break

            lines.pop(0)

        return "\n".join(lines).strip()


    def _remove_meta_commentary(self, answer: str) -> str:
        meta_patterns = [
            r"^\s*note\s+that\b.*$",
            r"^\s*note:\s+.*$",
            r"^\s*this\s+answer\b.*$",
            r"^\s*the\s+answer\b.*$",
            r"^\s*the\s+user'?s\s+question\b.*$",
            r"^\s*the\s+user\s+is\s+asking\b.*$",
            r"^\s*the\s+prompt\b.*$",
            r"^\s*here'?s\s+a\s+response\b.*$",
            r"^\s*users?'?\s+responses?\s*:\s*$",
            r"^\s*i\s+(?:will|should|must|need to)\b.*$",
        ]

        kept_lines: list[str] = []

        for line in answer.splitlines():
            stripped = line.strip()

            if any(
                re.match(pattern, stripped, flags=re.IGNORECASE)
                for pattern in meta_patterns
            ):
                continue

            kept_lines.append(line)

        cleaned = "\n".join(kept_lines).strip()
        cleaned = re.sub(
            r"\n{3,}",
            "\n\n",
            cleaned,
        )

        return cleaned.strip()


    def _remove_forbidden_sections(self, answer: str) -> str:
        cleaned = re.split(
            r"(?im)^\s*recommendations?\s*:\s*$",
            answer,
            maxsplit=1,
        )[0]
        cleaned = re.split(
            r"(?im)^\s*(?:buying\s+advice|suggestions?)\s*:\s*$",
            cleaned,
            maxsplit=1,
        )[0]
        return cleaned.strip()


    def _remove_markdown_emphasis(self, answer: str) -> str:
        cleaned = answer.replace("**", "")
        cleaned = re.sub(r"__([^_\n]+)__", r"\1", cleaned)
        cleaned = re.sub(r"^\s{0,3}#{1,6}\s+", "", cleaned, flags=re.MULTILINE)
        return cleaned.strip()


    def _collapse_report_style_answer(self, answer: str, user_question: str) -> str:
        query_sentiment = self._detect_query_sentiment(user_question)

        if query_sentiment not in {"negative", "positive"}:
            return answer

        has_report_shape = re.search(
            r"(?im)^\s*(?:\d+\.\s+|[-*]\s+(?:positive|negative|mixed)\s*:)",
            answer,
        )

        if not has_report_shape:
            return answer

        summary = self._theme_summary_from_report(answer, query_sentiment)

        if summary:
            return summary

        paragraphs = [
            paragraph.strip()
            for paragraph in re.split(r"\n\s*\n", answer)
            if paragraph.strip()
        ]
        narrative_paragraphs = [
            paragraph
            for paragraph in paragraphs
            if not re.search(r"(?m)^\s*(?:\d+\.\s+|[-*]\s+)", paragraph)
        ]

        if not narrative_paragraphs:
            return answer

        candidate = narrative_paragraphs[-1]

        if len(candidate.split()) < 6:
            return answer

        return candidate


    def _grounded_summary_from_items(
        self,
        context_items: list[dict],
        query_intent: str,
    ) -> str:
        if query_intent not in {"negative", "positive", "balanced"}:
            return ""

        texts: list[str] = []
        seen: set[str] = set()

        for item in context_items:
            text = self._source_text_for_item(item)
            normalized_key = self._normalize_echo_text(text)

            if not normalized_key or normalized_key in seen:
                continue

            seen.add(normalized_key)
            texts.append(text)

        if not texts:
            return ""

        joined_text = " ".join(texts).lower()

        if query_intent == "positive":
            positive_themes = self._positive_themes_from_text(joined_text)

            if positive_themes:
                return f"Customers mostly praise {self._join_theme_list(positive_themes)}."

            return "Customers mention some positive experiences, but the retrieved comments do not show a clear repeated praise theme."

        complaint_themes = self._complaint_themes_from_text(joined_text)

        if query_intent == "balanced":
            positive_themes = self._positive_themes_from_text(joined_text)

            if positive_themes and complaint_themes:
                return (
                    f"Customers like {self._join_theme_list(positive_themes)}, "
                    f"while complaints focus on {self._join_theme_list(complaint_themes)}."
                )

            if positive_themes:
                return f"Customers mostly mention positives around {self._join_theme_list(positive_themes)}."

        if complaint_themes:
            return f"Customers mainly complain about {self._join_theme_list(complaint_themes)}."

        return "The retrieved comments include complaints, but they do not show a clear repeated complaint theme."


    def _theme_summary_from_report(self, answer: str, query_sentiment: str) -> str:
        normalized = answer.lower()

        if query_sentiment == "positive":
            positive_themes = self._positive_themes_from_text(normalized)

            if positive_themes:
                return f"Customers mostly praise {self._join_theme_list(positive_themes)}."

            return ""

        complaint_themes = self._complaint_themes_from_text(normalized)

        if complaint_themes:
            return f"Customers mainly complain about {self._join_theme_list(complaint_themes)}."

        return ""


    def _positive_themes_from_text(self, text: str) -> list[str]:
        return self._detect_themes(
            text,
            [
                ("appearance and style", {"look", "looks", "beautiful", "style", "cute", "design", "eye-catching"}),
                ("comfort", {"comfort", "comfortable", "fit", "fits"}),
                ("quality and durability", {"quality", "durable", "sturdy", "well made"}),
                ("value", {"price", "value", "worth", "affordable"}),
                ("ease of use", {"easy", "simple", "convenient"}),
                ("working lights or features", {"light", "lights", "lit", "led", "feature"}),
            ],
        )


    def _complaint_themes_from_text(self, text: str) -> list[str]:
        complaint_themes = self._detect_themes(
            text,
            [
                ("lights failing or not working", {"light", "lights", "lit", "led", "lighting"}),
                ("fit and comfort problems", {"fit", "fits", "comfort", "comfortable", "put on", "get off", "wear"}),
                ("sizing issues", {"size", "sizing", "small", "large", "tight", "loose"}),
                ("quality or durability issues", {"broken", "defect", "defective", "damage", "damaged", "stopped working", "not working", "worn", "wore"}),
                ("delivery or packaging issues", {"delivery", "shipping", "package", "packaging", "late", "delayed"}),
                ("returns or refunds", {"return", "refund"}),
                ("price or value concerns", {"price", "expensive", "worth", "value", "steep"}),
                ("appearance or color concerns", {"color", "colors", "dull", "uninspired"}),
            ],
        )

        if "lights failing or not working" in complaint_themes:
            complaint_themes = [
                theme for theme in complaint_themes
                if theme != "quality or durability issues"
            ]

        return complaint_themes


    def _detect_themes(
        self,
        text: str,
        theme_terms: list[tuple[str, set[str]]],
        limit: int = 4,
    ) -> list[str]:
        themes: list[str] = []

        for theme, terms in theme_terms:
            if any(term in text for term in terms):
                themes.append(theme)

            if len(themes) >= limit:
                break

        return themes


    def _join_theme_list(self, themes: list[str]) -> str:
        if len(themes) == 1:
            return themes[0]

        if len(themes) == 2:
            return f"{themes[0]} and {themes[1]}"

        return f"{', '.join(themes[:-1])}, and {themes[-1]}"


    def _is_question_echo(self, answer: str, user_question: str) -> bool:
        normalized_answer = self._normalize_echo_text(answer)
        normalized_question = self._normalize_echo_text(user_question)

        if not normalized_answer or not normalized_question:
            return False

        if normalized_answer == normalized_question:
            return True

        if answer.strip().endswith("?"):
            answer_terms = set(normalized_answer.split())
            question_terms = set(normalized_question.split())

            if not question_terms:
                return False

            overlap = len(answer_terms & question_terms) / len(question_terms)
            return overlap >= 0.75

        return False


    def _normalize_echo_text(self, text: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


    def _is_unsafe_generated_answer(
        self,
        raw_answer: str,
        cleaned_answer: str,
        user_question: str,
    ) -> bool:
        combined = f"{raw_answer}\n{cleaned_answer}".lower()
        query_sentiment = self._detect_query_sentiment(user_question)

        unsafe_patterns = [
            r"</?(?:response|text|assistant|message|content)\b",
            r"\bthe\s+user\s+is\s+asking\b",
            r"\bhere'?s\s+a\s+response\b",
            r"(?m)^\s*recommendations?\s*:",
            r"(?m)^\s*(?:complaint|dislike)\s*:\s*$",
            r"\bconsider\s+(?:upgrading|buying|purchasing|trying)\b",
            r"\bfrom\s+a\s+brand\s+that\b",
            r"\bnot\s+sure\s+if\s+i'?d\s+want\s+to\s+buy\b",
        ]

        if any(re.search(pattern, combined, flags=re.IGNORECASE) for pattern in unsafe_patterns):
            return True

        if query_sentiment in {"negative", "positive"} and re.search(
            r"(?im)^\s*(?:\d+\.\s+|[-*]\s+(?:positive|negative|mixed)\s*:)",
            cleaned_answer,
        ):
            return True

        return False


    def _has_prompt_echo(self, answer: str, user_question: str) -> bool:
        first_line = ""

        for line in answer.splitlines():
            first_line = line.strip()

            if first_line:
                break

        if re.match(r"^(?:user\s*question|question)\s*:", first_line, flags=re.IGNORECASE):
            return True

        answer_without_label = self._strip_leading_answer_labels(answer)
        return self._is_question_echo(answer_without_label, user_question)


    def _preview_messages(self, messages: list[dict[str, str]]) -> str:
            lines: list[str] = []

            for message in messages:
                role = message.get("role", "unknown")
                content = message.get("content", "")
                lines.append(f"{role.upper()}:\n{content}")

            return "\n\n".join(lines)
