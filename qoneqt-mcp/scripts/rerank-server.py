"""
Tiny rerank server — TEI-compatible /rerank endpoint, backed by sentence-transformers.

Default model: Qwen/Qwen3-Reranker-8B. Use a GPU for practical latency.
Override with QONEQT_MCP_RERANK_MODEL.

Run:
  .venv/bin/python scripts/rerank-server.py

API:
  POST /rerank
    body: {"query": "...", "documents": ["...", ...], "top_n": 10}
    resp: {"results": [{"index": 0, "relevance_score": 0.83, "document": "..."}], ...]}
  GET  /health
"""

from __future__ import annotations

import logging
import os
from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("rerank")

MODEL_NAME = os.environ.get("QONEQT_MCP_RERANK_MODEL", "Qwen/Qwen3-Reranker-8B")
MAX_LEN = int(os.environ.get("QONEQT_MCP_RERANK_MAXLEN", "512"))
DEVICE = os.environ.get("QONEQT_MCP_RERANK_DEVICE", "cpu")

log.info(f"Loading reranker: {MODEL_NAME} on {DEVICE} (max_length={MAX_LEN}) — first run downloads ~1.1GB")
model = CrossEncoder(MODEL_NAME, max_length=MAX_LEN, device=DEVICE)
log.info("Reranker ready.")

app = FastAPI(title="qoneqt-mcp-rerank", version="0.1.0")


class RerankRequest(BaseModel):
    query: str
    documents: List[str]
    top_n: Optional[int] = None
    return_documents: Optional[bool] = False
    raw_scores: Optional[bool] = False


class RerankResultItem(BaseModel):
    index: int
    relevance_score: float
    document: Optional[str] = None


class RerankResponse(BaseModel):
    results: List[RerankResultItem]
    model: str


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "device": DEVICE}


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest) -> RerankResponse:
    if not req.documents:
        return RerankResponse(results=[], model=MODEL_NAME)

    pairs = [(req.query, d) for d in req.documents]
    scores = model.predict(pairs, batch_size=16, show_progress_bar=False)

    indexed = sorted(
        ((i, float(s)) for i, s in enumerate(scores)),
        key=lambda x: x[1],
        reverse=True,
    )
    if req.top_n is not None:
        indexed = indexed[: req.top_n]

    results = []
    for idx, score in indexed:
        results.append(
            RerankResultItem(
                index=idx,
                relevance_score=score,
                document=req.documents[idx] if req.return_documents else None,
            )
        )
    return RerankResponse(results=results, model=MODEL_NAME)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("QONEQT_MCP_RERANK_PORT", "8081"))
    host = os.environ.get("QONEQT_MCP_RERANK_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="warning")
