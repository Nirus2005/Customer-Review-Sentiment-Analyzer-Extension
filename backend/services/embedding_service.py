import os
from functools import lru_cache

import torch
from langchain_huggingface import HuggingFaceEmbeddings


@lru_cache(maxsize=1)
def get_embedding_model() -> HuggingFaceEmbeddings:
    model_name = os.getenv(
        "EMBEDDING_MODEL",
        "sentence-transformers/all-MiniLM-L6-v2",
    )

    device = "cuda" if torch.cuda.is_available() else "cpu"

    return HuggingFaceEmbeddings(
        model_name=model_name,
        model_kwargs={
            "device": device,
        },
        encode_kwargs={
            "normalize_embeddings": True,
        },
    )