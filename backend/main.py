import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    DeleteSessionResponse,
    RagChatRequest,
    RagChatResponse,
    RagSessionCreateRequest,
    RagSessionCreateResponse,
    RagSessionInfo,
)
from services.rag_chain import RagChainService
from services.sentiment_service import SentimentService
from services.session_manager import SessionManager
from services.vector_store import VectorStoreService


load_dotenv()


sentiment_service = SentimentService()
session_manager = SessionManager()
vector_store_service = VectorStoreService()
rag_chain_service = RagChainService(vector_store_service)


def parse_allowed_origins() -> list[str]:
    raw_origins = os.getenv("ALLOW_ORIGINS", "*")

    return [
        origin.strip()
        for origin in raw_origins.split(",")
        if origin.strip()
    ]


def cleanup_expired_sessions() -> None:
    expired_sessions = session_manager.cleanup_expired_sessions()

    for record in expired_sessions:
        vector_store_service.delete_session_store(
            session_id=record.session_id,
            collection_name=record.collection_name,
        )


app = FastAPI(
    title="Customer Review Sentiment Analyzer + RAG API",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=parse_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {
        "status": "ok",
        "service": "customer-review-sentiment-rag-api",
        "version": "2.0.0",
    }


@app.get("/health")
def health_check():
    return {
        "status": "ok",
    }


@app.post("/v1/analyze", response_model=AnalyzeResponse)
def analyze_reviews(payload: AnalyzeRequest):
    try:
        return sentiment_service.analyze(payload.reviews)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Analysis failed: {str(exc)}",
        ) from exc
    

@app.post("/v1/rag/sessions", response_model=RagSessionCreateResponse)
def create_rag_session(payload: RagSessionCreateRequest):
    cleanup_expired_sessions()

    record = session_manager.create_session(
        page_url=payload.page_url,
        page_title=payload.page_title,
    )

    try:
        review_sentiments = sentiment_service.classify_reviews_for_rag(payload.reviews)

        review_count, chunk_count = vector_store_service.create_session_store(
            session_id=record.session_id,
            collection_name=record.collection_name,
            reviews=payload.reviews,
            page_url=payload.page_url,
            page_title=payload.page_title,
            review_sentiments=review_sentiments,
        )

        session_manager.update_counts(
            session_id=record.session_id,
            review_count=review_count,
            chunk_count=chunk_count,
        )

        return RagSessionCreateResponse(
            session_id=record.session_id,
            review_count=review_count,
            chunk_count=chunk_count,
            message="RAG session created.",
        )

    except ValueError as exc:
        session_manager.delete_session(record.session_id)
        vector_store_service.delete_session_store(
            session_id=record.session_id,
            collection_name=record.collection_name,
        )

        raise HTTPException(status_code=400, detail=str(exc)) from exc

    except Exception as exc:
        session_manager.delete_session(record.session_id)
        vector_store_service.delete_session_store(
            session_id=record.session_id,
            collection_name=record.collection_name,
        )

        raise HTTPException(
            status_code=500,
            detail=f"Failed to create RAG session: {str(exc)}",
        ) from exc
    

@app.get("/v1/rag/sessions/{session_id}", response_model=RagSessionInfo)
def get_rag_session(session_id: str):
    record = session_manager.get_session(session_id)

    if record is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    return RagSessionInfo(
        session_id=record.session_id,
        collection_name=record.collection_name,
        page_url=record.page_url,
        page_title=record.page_title,
        review_count=record.review_count,
        chunk_count=record.chunk_count,
        created_at=record.created_at,
        last_accessed_at=record.last_accessed_at,
        expires_at=session_manager.expires_at(record),
        chat_turns=len(record.chat_history),
    )


@app.post("/v1/rag/sessions/{session_id}/chat", response_model=RagChatResponse)
def chat_with_rag_session(
    session_id: str,
    payload: RagChatRequest,
):
    cleanup_expired_sessions()

    try:
        return rag_chain_service.answer_question(
            session_id=session_id,
            question=payload.question,
            session_manager=session_manager,
        )

    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found.") from exc

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"RAG chat failed: {str(exc)}",
        ) from exc
    

@app.delete("/v1/rag/sessions/{session_id}", response_model=DeleteSessionResponse)
def delete_rag_session(session_id: str):
    record = session_manager.delete_session(session_id)

    if record is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    vector_store_service.delete_session_store(
        session_id=record.session_id,
        collection_name=record.collection_name,
    )

    return DeleteSessionResponse(
        deleted=True,
        session_id=session_id,
    )
