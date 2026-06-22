import os 
from typing import Any
import chromadb
from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from services.embedding_service import get_embedding_model
from services.text_utils import clean_reviews


class VectorStoreService:
    def __init__(self) -> None :
        self.client = chromadb.Client()
        self.chunk_size = int(os.getenv("RAG_CHUNK_SIZE", "700"))
        self.chunk_overlap = int(os.getenv("RAG_CHUNK_OVERLAP", "100"))

        self._store: dict[str, Chroma] = {}

    def create_session_store(
        self,
        session_id: str,
        collection_name: str,
        reviews: list[str],
        page_url: str | None,
        page_title: str | None,
        review_sentiments: list[dict[str, Any]] | None = None,
    ) -> tuple[int, int]:
        cleaned_reviews = clean_reviews(reviews)

        if not cleaned_reviews:
            raise ValueError("No valid review text found for RAG indexing.")

        documents = self._build_documents(
            session_id=session_id,
            reviews=cleaned_reviews,
            page_url=page_url,
            page_title=page_title,
            review_sentiments=review_sentiments,
        )
        
        chunks = self._split_documents(documents)

        if not chunks :
            raise ValueError("No chunks were created for RAG indexing.")

        store = Chroma(
            collection_name = collection_name,
            embedding_function=get_embedding_model(),
            client=self.client,
        )

        safe_session_id = session_id.replace("-", "")
        ids: list[str] = []

        for index, chunk in enumerate(chunks):
            chunk_id = f"{safe_session_id}_chunk_{index}"
            chunk.metadata["chunk_id"] = chunk_id
            chunk.metadata["chunk_index"] = index
            ids.append(chunk_id)

        store.add_documents(
            documents=chunks,
            ids=ids,
        )

        self._store[session_id] = store

        return len(cleaned_reviews), len(chunks)
    

    def query(
        self,
        session_id: str,
        question: str,
        top_k: int,
        sentiment_labels: set[str] | None = None,
        fetch_k: int | None = None,
    ) -> list[dict[str, Any]]:
        store = self._store.get(session_id)

        if store is None:
            raise KeyError(f"No vector store found for session: {session_id}")

        allowed_labels = set(sentiment_labels or [])
        metadata_filter = self._build_sentiment_filter(allowed_labels)
        search_k = max(top_k, fetch_k or top_k)

        try:
            results = store.similarity_search_with_relevance_scores(
                question,
                k=search_k,
                filter=metadata_filter,
            )

        except Exception:
            try:
                results = store.similarity_search_with_score(
                    question,
                    k=search_k,
                    filter=metadata_filter,
                )
            except Exception:
                results = store.similarity_search_with_score(
                    question,
                    k=search_k,
                )

        items = [
            {
                "document": document,
                "score": float(score),
            }
            for document, score in results
        ]

        if allowed_labels:
            items = [
                item for item in items
                if self._document_sentiment(item["document"]) in allowed_labels
            ]

        return items[:top_k]
    
    def delete_session_store(self, session_id: str, collection_name: str,) -> None:
        self._store.pop(session_id, None)

        try:
            self.client.delete_collection(collection_name)
        except Exception:
            pass

    
    def _build_documents(
        self,
        session_id: str,
        reviews: list[str],
        page_url: str | None,
        page_title: str | None,
        review_sentiments: list[dict[str, Any]] | None = None,
    ) -> list[Document]:
        documents: list[Document] = []

        for index, review in enumerate(reviews):
            review_id = f"review_{index}"
            sentiment = self._review_sentiment_at(review_sentiments, index)

            documents.append(
                Document(
                    page_content=review,
                    metadata={
                        "session_id": session_id,
                        "review_id": review_id,
                        "review_index": index,
                        "page_url": page_url or "",
                        "page_title": page_title or "",
                        "sentiment_label": sentiment["sentiment_label"],
                        "sentiment_score": sentiment["sentiment_score"],
                    },
                )
            )

        return documents
    
    def _split_documents(
        self,
        documents: list[Document],
    ) -> list[Document]:
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            length_function=len,
        )

        return splitter.split_documents(documents)

    def _build_sentiment_filter(self, sentiment_labels: set[str]) -> dict[str, Any] | None:
        if not sentiment_labels:
            return None

        labels = sorted(sentiment_labels)

        if len(labels) == 1:
            return {
                "sentiment_label": labels[0],
            }

        return {
            "sentiment_label": {
                "$in": labels,
            },
        }

    def _document_sentiment(self, document: Document) -> str:
        metadata = document.metadata or {}
        return str(metadata.get("sentiment_label") or "unknown")

    def _review_sentiment_at(
        self,
        review_sentiments: list[dict[str, Any]] | None,
        index: int,
    ) -> dict[str, str | float]:
        if review_sentiments and index < len(review_sentiments):
            sentiment = review_sentiments[index]
            return {
                "sentiment_label": str(sentiment.get("sentiment_label") or "unknown"),
                "sentiment_score": float(sentiment.get("sentiment_score") or 0.0),
            }

        return {
            "sentiment_label": "unknown",
            "sentiment_score": 0.0,
        }
