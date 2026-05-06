"""
KRONOS SIDECAR — FastAPI inference server.

Tryby (zmienna środowiskowa INFERENCE_MODE):
  chronos  — amazon/chronos-t5-base (domyślny, wymaga chronos-forecasting)
  gbm      — Monte Carlo GBM (zawsze działa, bez AI)

Przykład przełączenia na GBM:
  $env:INFERENCE_MODE = "gbm"
  python -m uvicorn main:app --host 0.0.0.0 --port 8000
"""

import os
import time
import logging
from contextlib import asynccontextmanager

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ─── Konfiguracja ────────────────────────────────────────────────────────────

INFERENCE_MODE = os.getenv("INFERENCE_MODE", "chronos").lower()  # "chronos" | "gbm"
CHRONOS_MODEL  = "amazon/chronos-t5-base"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("kronos-sidecar")

# ─── Stan globalny ───────────────────────────────────────────────────────────

pipeline = None   # Chronos pipeline
DEVICE   = "cpu"
MODEL_READY = False
ACTIVE_MODE = "gbm"


def detect_device() -> str:
    if torch.cuda.is_available():
        name = torch.cuda.get_device_name(0)
        vram = torch.cuda.get_device_properties(0).total_mem / 1e9
        logger.info(f"CUDA: {name} ({vram:.1f} GB VRAM)")
        return "cuda"
    logger.info("Brak GPU — używam CPU")
    return "cpu"


def load_chronos():
    global pipeline, DEVICE, MODEL_READY, ACTIVE_MODE

    DEVICE = detect_device()
    logger.info(f"Ładuję Chronos ({CHRONOS_MODEL}) na {DEVICE}...")

    try:
        from chronos import ChronosPipeline

        dtype = torch.bfloat16 if DEVICE == "cuda" else torch.float32
        pipeline = ChronosPipeline.from_pretrained(
            CHRONOS_MODEL,
            device_map=DEVICE,
            torch_dtype=dtype,
        )
        MODEL_READY = True
        ACTIVE_MODE = "chronos"
        logger.info(f"Chronos gotowy na {DEVICE} (dtype={dtype})")

    except Exception as e:
        logger.error(f"Błąd ładowania Chronos: {e}")
        logger.warning("Przełączam na GBM fallback")
        MODEL_READY = False
        ACTIVE_MODE = "gbm"


def load_model():
    if INFERENCE_MODE == "gbm":
        logger.info("Tryb GBM wybrany ręcznie (INFERENCE_MODE=gbm) — pomijam ładowanie modelu AI")
        global ACTIVE_MODE
        ACTIVE_MODE = "gbm"
    else:
        load_chronos()


# ─── Lifespan ────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    yield
    logger.info("Sidecar zatrzymany")


# ─── FastAPI ─────────────────────────────────────────────────────────────────

app = FastAPI(title="Kronos Sidecar", version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ─── Schematy ────────────────────────────────────────────────────────────────

class PredictRequest(BaseModel):
    candles: list[list[float]] = Field(..., min_length=10,
        description="OHLCV: [[open, high, low, close, volume], ...]")
    n_samples: int = Field(default=100, ge=5, le=1000)
    horizon: int   = Field(default=1, ge=1, le=10)


class PredictResponse(BaseModel):
    direction:    str
    prob_up:      float
    prob_down:    float
    confidence:   float
    n_samples:    int
    horizon:      int
    device:       str
    inference_ms: int
    mode:         str


class HealthResponse(BaseModel):
    status:      str
    model:       str
    device:      str
    model_ready: bool
    mode:        str


# ─── Silniki predykcji ───────────────────────────────────────────────────────

def _chronos_predict(candles: np.ndarray, horizon: int, n_samples: int) -> dict:
    """Chronos T5 — probabilistyczna prognoza szeregu czasowego."""
    closes     = candles[:, 3].astype(np.float32)
    last_close = float(closes[-1])

    context  = torch.tensor(closes).unsqueeze(0)   # [1, seq_len]
    forecast = pipeline.predict(context, prediction_length=horizon, num_samples=n_samples)
    # forecast: [1, n_samples, horizon]
    final_prices = forecast[0, :, -1].cpu().numpy()  # wartości po `horizon` świecach

    prob_up    = float((final_prices > last_close).mean())
    direction  = "UP" if prob_up >= 0.5 else "DOWN"
    confidence = max(prob_up, 1 - prob_up)

    return {
        "prob_up":    round(prob_up, 4),
        "prob_down":  round(1 - prob_up, 4),
        "direction":  direction,
        "confidence": round(confidence, 4),
    }


def _gbm_predict(candles: np.ndarray, horizon: int, n_samples: int) -> dict:
    """Monte Carlo GBM — matematyczny model losowego błądzenia ceny."""
    closes      = candles[:, 3]
    log_returns = np.diff(np.log(closes))

    if len(log_returns) < 2:
        return {"prob_up": 0.5, "prob_down": 0.5, "direction": "UP", "confidence": 0.5}

    mu         = np.mean(log_returns)
    sigma      = np.std(log_returns, ddof=1)
    last_close = closes[-1]

    # Wektoryzowana symulacja — szybsza niż pętla
    shocks   = np.random.randn(n_samples, horizon)
    paths    = last_close * np.exp(np.cumsum(mu + sigma * shocks, axis=1))
    final    = paths[:, -1]

    prob_up    = float((final > last_close).mean())
    direction  = "UP" if prob_up >= 0.5 else "DOWN"
    confidence = max(prob_up, 1 - prob_up)

    return {
        "prob_up":    round(prob_up, 4),
        "prob_down":  round(1 - prob_up, 4),
        "direction":  direction,
        "confidence": round(confidence, 4),
    }


# ─── Endpointy ───────────────────────────────────────────────────────────────

@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest):
    t0      = time.perf_counter()
    candles = np.array(req.candles, dtype=np.float32)

    if candles.shape[1] != 5:
        raise HTTPException(400, f"Każda świeca musi mieć 5 wartości [O,H,L,C,V], dostałem {candles.shape[1]}")

    try:
        if ACTIVE_MODE == "chronos" and MODEL_READY:
            result = _chronos_predict(candles, req.horizon, req.n_samples)
            mode   = "chronos"
        else:
            result = _gbm_predict(candles, req.horizon, req.n_samples)
            mode   = "gbm"
    except Exception as e:
        logger.error(f"Błąd predykcji ({ACTIVE_MODE}): {e} — fallback na GBM")
        result = _gbm_predict(candles, req.horizon, req.n_samples)
        mode   = "gbm-emergency-fallback"

    inference_ms = int((time.perf_counter() - t0) * 1000)

    return PredictResponse(
        direction    = result["direction"],
        prob_up      = result["prob_up"],
        prob_down    = result["prob_down"],
        confidence   = result["confidence"],
        n_samples    = req.n_samples,
        horizon      = req.horizon,
        device       = DEVICE,
        inference_ms = inference_ms,
        mode         = mode,
    )


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status      = "ok" if (MODEL_READY or ACTIVE_MODE == "gbm") else "degraded",
        model       = CHRONOS_MODEL if ACTIVE_MODE == "chronos" else "monte-carlo-gbm",
        device      = DEVICE,
        model_ready = MODEL_READY or ACTIVE_MODE == "gbm",
        mode        = ACTIVE_MODE,
    )
