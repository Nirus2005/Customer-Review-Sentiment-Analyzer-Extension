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

FALLBACK_ANSWER = "I could not find anything relevant to that in the visible reviews."

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


@dataclass(frozen=True)
class GenerationResult:
    answer: str
    truncated: bool


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
        self.top_k = int(os.getenv("RAG_TOP_K", "8"))

        self.max_context_tokens = int(os.getenv("RAG_MAX_CONTEXT_TOKENS", "2000"))
        self.debug_enabled = os.getenv("RAG_DEBUG", "false").lower() == "true"
        self.model_name = os.getenv("RAG_LLM_MODEL", "HuggingFaceTB/SmolLM2-135M-Instruct")
        self.min_score = float(os.getenv("RAG_MIN_SCORE", "0.05"))
        self.max_new_tokens = int(os.getenv("RAG_MAX_NEW_TOKENS", "300"))
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
        sentiment_labels = self._sentiment_labels_for_query(query_sentiment)

        retrieved_items = self.vector_store.query(
            session_id=session_id,
            question=clean_question,
            top_k=self.top_k,
            sentiment_labels=sentiment_labels,
            fetch_k=self.top_k * 3 if sentiment_labels else self.top_k,
        )

        retrieved_items = [
            item for item in retrieved_items
            if item.get("score") is not None and item["score"] >= self.min_score
        ]

        sources = self._build_sources(retrieved_items)

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
                truncated=False,
                debug=None,
            )

        tokenizer, _ = get_rag_generator()

        context = self._format_context(
            retrieved_items=retrieved_items,
            tokenizer=tokenizer,
        )

        recent_history = self._format_history(record.chat_history[-self.max_recent_messages:])

        conversation_summary = getattr(
            record,
            "conversation_summary",
            "",
        ) or "No earlier conversation summary."

        messages = self._build_messages(
            context=context,
            recent_history=recent_history,
            conversation_summary=conversation_summary,
            question=clean_question,
        )

        generation = self._generate_answer_result(messages)

        if generation.truncated:
            retry_generation = self._retry_concise_answer(messages)

            if retry_generation.answer != FALLBACK_ANSWER:
                generation = retry_generation

        answer = generation.answer

        session_manager.append_chat_message(session_id, "user", clean_question)
        session_manager.append_chat_message(session_id, "assistant", answer)

        self._compact_chat_history_if_needed(
            session_id=session_id,
            session_manager=session_manager,
        )

        debug = None

        if self.debug_enabled:
            debug = RagDebug(
                retrieved_count=len(retrieved_items),
                collection_name=record.collection_name,
                model=self.model_name,
                prompt_preview=self._preview_messages(messages)[:1200],
            )

        return RagChatResponse(
            session_id=session_id,
            answer=answer,
            sources=sources,
            truncated=generation.truncated,
            debug=debug,
        )
    

    def _build_sources(
        self,
        retrieved_items: list[dict],
    ) -> list[RagSource]:
        sources: list[RagSource] = []

        for item in retrieved_items:
            document = item["document"]
            metadata = dict(document.metadata)
            score = item.get("score")

            sources.append(
                RagSource(
                    review_id=str(metadata.get("review_id", "")),
                    chunk_id=metadata.get("chunk_id"),
                    review_index=metadata.get("review_index"),
                    text=document.page_content,
                    score=round(float(score), 4) if score is not None else None,
                    metadata=metadata,
                )
            )

        return sources


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


    def _sentiment_labels_for_query(self, query_sentiment: str) -> set[str] | None:
        if query_sentiment == "negative":
            return {"negative", "mixed"}

        if query_sentiment == "positive":
            return {"positive", "mixed"}

        return None


    def _fallback_answer_for_query_sentiment(self, query_sentiment: str) -> str:
        if query_sentiment == "negative":
            return "I could not find negative review evidence relevant to that in the visible reviews."

        if query_sentiment == "positive":
            return "I could not find positive review evidence relevant to that in the visible reviews."

        return FALLBACK_ANSWER


    def _format_context(
        self,
        retrieved_items: list[dict],
        tokenizer,
    ) -> str:
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
                    "texts": [],
                }

            if text not in grouped_reviews[review_key]["texts"]:
                grouped_reviews[review_key]["texts"].append(text)

        blocks: list[str] = []
        used_tokens = 0

        for index, review in enumerate(grouped_reviews.values(), start=1):
            metadata = review["metadata"]
            text = "\n".join(review["texts"]).strip()

            label_parts = [f"Review {index}"]

            rating = metadata.get("rating")
            if rating is not None:
                label_parts.append(f"rating: {rating}")

            review_date = metadata.get("date")
            if review_date:
                label_parts.append(f"date: {review_date}")

            label = " | ".join(label_parts)

            block = f"[{label}]\n{text}"

            token_count = len(
                tokenizer.encode(
                    block,
                    add_special_tokens=False,
                )
            )

            if used_tokens + token_count > self.max_context_tokens:
                break

            blocks.append(block)
            used_tokens += token_count

        if not blocks:
            return "No review context available."

        return "\n\n".join(blocks)
    

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


    def _build_messages(
        self,
        context: str,
        recent_history: str,
        conversation_summary: str,
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
    ) -> GenerationResult:
        retry_messages = self._build_concise_retry_messages(messages)
        return self._generate_answer_result(retry_messages)


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
            "Answer the same question again, but keep it complete and concise. "
            "Use at most 4 short bullets or one short paragraph. "
            "Do not copy long review text. Return only the answer."
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
        cleaned_answer = self._clean_answer(answer)

        return GenerationResult(
            answer=cleaned_answer,
            truncated=(
                hit_token_limit
                and not ended_with_eos
                and cleaned_answer != FALLBACK_ANSWER
            ),
        )
    

    def _clean_answer(self, answer: str) -> str:
            if not answer:
                return FALLBACK_ANSWER

            bad_markers = [
                "<reviews>",
                "</reviews>",
                "<user_question>",
                "</user_question>",
                "<previous_chat>",
                "</previous_chat>",
                "Final answer:",
            ]

            for marker in bad_markers:
                if marker in answer:
                    answer = answer.split(marker)[0].strip()

            if not answer:
                return FALLBACK_ANSWER

            return answer


    def _preview_messages(self, messages: list[dict[str, str]]) -> str:
            lines: list[str] = []

            for message in messages:
                role = message.get("role", "unknown")
                content = message.get("content", "")
                lines.append(f"{role.upper()}:\n{content}")

            return "\n\n".join(lines)
