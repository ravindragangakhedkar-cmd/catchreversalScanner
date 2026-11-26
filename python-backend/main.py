from __future__ import annotations

import builtins
import getpass
import os
import threading
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Any

import pyotp
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Catch Reversals Nubra SDK Service", version="1.0.0")

_sdk_lock = threading.RLock()
_sdk_client: Any | None = None
_sdk_created_at = 0.0
SDK_MAX_AGE_SECONDS = 6 * 60 * 60


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise HTTPException(status_code=503, detail=f"Python service is missing {name} configuration.")
    return value


def _authorize(x_service_key: str | None = Header(default=None)) -> None:
    expected = _required_env("SERVICE_API_KEY")
    if not x_service_key or not __import__("hmac").compare_digest(x_service_key, expected):
        raise HTTPException(status_code=401, detail="Invalid service credentials.")


def _get_sdk():
    global _sdk_client, _sdk_created_at
    with _sdk_lock:
        if _sdk_client is not None and time.time() - _sdk_created_at < SDK_MAX_AGE_SECONDS:
            return _sdk_client

        phone = _required_env("NUBRA_PHONE_NO")
        mpin = _required_env("NUBRA_MPIN")
        secret = _required_env("NUBRA_TOTP_SECRET")
        if not secret:
            raise HTTPException(status_code=503, detail="NUBRA_TOTP_SECRET is not configured.")

        # Nubra's documented headless login method: TOTP + pyotp, with
        # PHONE_NO and MPIN loaded by the SDK from environment variables.
        os.environ["PHONE_NO"] = phone
        os.environ["MPIN"] = mpin
        totp = pyotp.TOTP(secret)
        original_input = builtins.input
        original_getpass = getpass.getpass
        try:
            builtins.input = lambda prompt="": totp.now()
            getpass.getpass = lambda prompt="": totp.now()
            from nubra_python_sdk.start_sdk import InitNubraSdk, NubraEnv
            client = InitNubraSdk(
                env=NubraEnv.PROD,
                totp_login=True,
                env_creds=True,
            )
        except Exception as exc:
            _sdk_client = None
            raise HTTPException(status_code=502, detail=f"Nubra Python SDK authentication failed: {type(exc).__name__}: {exc}") from exc
        finally:
            builtins.input = original_input
            getpass.getpass = original_getpass

        _sdk_client = client
        _sdk_created_at = time.time()
        return _sdk_client


def _attr(obj: Any, name: str, default=None):
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _point_rows(points: Any) -> dict[int, float]:
    output: dict[int, float] = {}
    for point in points or []:
        raw_ts = _attr(point, "timestamp")
        raw_value = _attr(point, "value")
        try:
            ts_ns = int(raw_ts)
            value = float(raw_value)
        except (TypeError, ValueError, OverflowError):
            continue
        if ts_ns <= 0:
            continue
        output[ts_ns // 1_000_000] = value
    return output


def _chart_to_bars(chart: Any) -> list[dict[str, float | int]]:
    field_map = {
        "open": "open",
        "high": "high",
        "low": "low",
        "close": "close",
        "cumulative_volume": "volume",
    }
    merged: dict[int, dict[str, float | int]] = {}
    for source, target in field_map.items():
        for timestamp, value in _point_rows(_attr(chart, source)).items():
            row = merged.setdefault(timestamp, {"timestamp": timestamp})
            # Nubra SDK stock prices are represented in paise. Volume is not.
            row[target] = value if target == "volume" else value / 100.0

    bars = []
    for ts, row in sorted(merged.items()):
        if all(k in row for k in ("open", "high", "low", "close")):
            bars.append({
                "timestamp": ts,
                "date": datetime.fromtimestamp(ts / 1000, tz=timezone.utc).astimezone(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d"),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row.get("volume", 0.0)),
            })
    return bars


class InstrumentRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=40)
    exchange: str = Field(default="NSE", pattern="^(NSE|BSE)$")
    instrument_type: str = Field(default="STOCK", pattern="^(STOCK|INDEX)$")


class HistoricalRequest(BaseModel):
    instruments: list[InstrumentRequest] = Field(min_length=1, max_length=5)
    start_date: str
    end_date: str
    interval: str = "1d"


@app.get("/health")
def health():
    return {"ok": True, "service": "nubra-python-sdk", "sdk_authenticated": _sdk_client is not None}


@app.post("/v1/historical", dependencies=[Depends(_authorize)])
def historical(request: HistoricalRequest):
    if request.interval not in {"1d", "1w", "1m", "3m", "5m", "15m", "30m", "1h"}:
        raise HTTPException(status_code=400, detail="Unsupported interval.")
    try:
        start = datetime.fromisoformat(request.start_date.replace("Z", "+00:00"))
        end = datetime.fromisoformat(request.end_date.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="start_date and end_date must be ISO-8601 timestamps.") from exc
    if end <= start:
        raise HTTPException(status_code=400, detail="end_date must be later than start_date.")

    client = _get_sdk()
    from nubra_python_sdk.marketdata.market_data import MarketData
    md = MarketData(client)

    grouped: dict[tuple[str, str], list[InstrumentRequest]] = {}
    for item in request.instruments:
        grouped.setdefault((item.exchange, item.instrument_type), []).append(item)

    results: dict[str, list[dict[str, float | int]]] = {}
    failures: dict[str, str] = {}
    for (exchange, instrument_type), items in grouped.items():
        symbols = [item.symbol.strip().upper() for item in items]
        query = {
            "exchange": exchange,
            "type": instrument_type,
            "values": symbols,
            "fields": ["open", "high", "low", "close", "cumulative_volume"],
            "startDate": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "endDate": end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "interval": request.interval,
            "intraDay": False,
            "realTime": False,
        }
        try:
            response = md.historical_data(query)
            for group in (_attr(response, "result", []) or []):
                for instrument_dict in (_attr(group, "values", []) or []):
                    if not isinstance(instrument_dict, dict):
                        continue
                    for symbol, chart in instrument_dict.items():
                        bars = _chart_to_bars(chart)
                        if bars:
                            results[str(symbol).strip().upper()] = bars
        except Exception as exc:
            # Isolate unsupported symbols so one bad symbol never discards a batch.
            if len(symbols) > 1:
                for symbol in symbols:
                    try:
                        single = dict(query)
                        single["values"] = [symbol]
                        one = md.historical_data(single)
                        found = False
                        for group in (_attr(one, "result", []) or []):
                            for instrument_dict in (_attr(group, "values", []) or []):
                                if isinstance(instrument_dict, dict) and symbol in instrument_dict:
                                    bars = _chart_to_bars(instrument_dict[symbol])
                                    if bars:
                                        results[symbol] = bars
                                        found = True
                        if not found:
                            failures[symbol] = "Nubra returned no historical candles."
                    except Exception as single_exc:
                        failures[symbol] = f"{type(single_exc).__name__}: {single_exc}"
            else:
                failures[symbols[0]] = f"{type(exc).__name__}: {exc}"

    return {
        "items": results,
        "failures": failures,
        "loaded_count": len(results),
        "requested_count": len(request.instruments),
        "interval": request.interval,
        "sdk": "nubra-sdk",
    }
