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
            if len(symbols) == 1:
                failures[symbols[0]] = f"{type(exc).__name__}: {exc}"

        # Some SDK responses can succeed for a batch but omit one unsupported symbol.
        # Retry every missing symbol individually, preserving all valid instruments.
        for symbol in symbols:
            if symbol in results:
                continue
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

    return {
        "items": results,
        "failures": failures,
        "loaded_count": len(results),
        "requested_count": len(request.instruments),
        "interval": request.interval,
        "sdk": "nubra-sdk",
    }


# Generic instrument discovery and market-data endpoints. These use the same
# authenticated SDK client as the scanner candle loader.
class GenericHistoricalRequest(BaseModel):
    exchange: str = Field(default="NSE", pattern="^(NSE|BSE|MCX)$")
    instrument_type: str = Field(pattern="^(STOCK|INDEX|FUT|OPT)$")
    symbols: list[str] = Field(min_length=1, max_length=5)
    fields: list[str] = Field(default_factory=lambda: [
        "open", "high", "low", "close", "cumulative_volume"
    ], min_length=1, max_length=30)
    start_date: str
    end_date: str
    interval: str = "1d"
    intraday: bool = False
    realtime: bool = False


def _json_value(value: Any):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    return str(value)


def _field_series(chart: Any, field: str) -> list[dict[str, Any]]:
    points = _attr(chart, field, None)
    rows = []
    price_fields = {"open", "high", "low", "close", "l1bid", "l1ask"}
    for point in points or []:
        raw_ts = _attr(point, "timestamp")
        raw_value = _attr(point, "value")
        try:
            timestamp_ns = int(raw_ts)
            value = float(raw_value)
        except (TypeError, ValueError, OverflowError):
            continue
        if timestamp_ns <= 0:
            continue
        timestamp_ms = timestamp_ns // 1_000_000
        if field in price_fields:
            value /= 100.0
        date = datetime.fromtimestamp(
            timestamp_ms / 1000, tz=timezone.utc
        ).astimezone(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d")
        rows.append({"timestamp": timestamp_ms, "date": date, "value": value})
    return rows


@app.get("/v1/instruments", dependencies=[Depends(_authorize)])
def instruments(
    exchange: str = "NSE",
    asset: str | None = None,
    derivative_type: str | None = None,
    expiry: str | None = None,
    option_type: str | None = None,
    symbol: str | None = None,
    limit: int = 500,
):
    if exchange not in {"NSE", "BSE", "MCX"}:
        raise HTTPException(status_code=400, detail="exchange must be NSE, BSE or MCX.")
    if derivative_type and derivative_type not in {"STOCK", "FUT", "OPT"}:
        raise HTTPException(status_code=400, detail="derivative_type must be STOCK, FUT or OPT.")
    if option_type and option_type not in {"CE", "PE"}:
        raise HTTPException(status_code=400, detail="option_type must be CE or PE.")
    if limit < 1 or limit > 5000:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 5000.")

    try:
        from nubra_python_sdk.refdata.instruments import InstrumentData
        frame = InstrumentData(_get_sdk()).get_instruments_dataframe(exchange=exchange)
        if frame is None or frame.empty:
            return {"exchange": exchange, "count": 0, "items": []}

        selected = frame.copy()
        filters = {
            "asset": asset,
            "derivative_type": derivative_type,
            "option_type": option_type,
        }
        for column, expected in filters.items():
            if expected is not None and column in selected.columns:
                selected = selected[selected[column].astype(str).str.upper() == expected.upper()]
        if expiry is not None and "expiry" in selected.columns:
            selected = selected[selected["expiry"].astype(str).str.replace(r"\\.0$", "", regex=True) == expiry]
        if symbol is not None:
            search = symbol.strip().upper()
            cols = [c for c in ("stock_name", "asset", "nubra_name") if c in selected.columns]
            mask = False
            for column in cols:
                mask = mask | selected[column].astype(str).str.upper().str.contains(search, regex=False)
            selected = selected[mask]

        columns = [
            "ref_id", "token", "stock_name", "nubra_name", "asset", "exchange",
            "derivative_type", "asset_type", "expiry", "strike_price",
            "option_type", "lot_size", "tick_size", "isin"
        ]
        columns = [c for c in columns if c in selected.columns]
        rows = []
        for record in selected[columns].head(limit).to_dict(orient="records"):
            rows.append({k: _json_value(v) for k, v in record.items()})
        return {"exchange": exchange, "count": len(rows), "items": rows}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nubra instrument master failed: {type(exc).__name__}: {exc}") from exc


@app.post("/v1/history", dependencies=[Depends(_authorize)])
def generic_history(request: GenericHistoricalRequest):
    allowed_intervals = {"1s", "1m", "2m", "3m", "5m", "15m", "30m", "1h", "1d", "1w", "1mth"}
    if request.interval not in allowed_intervals:
        raise HTTPException(status_code=400, detail="Unsupported interval.")
    try:
        start = datetime.fromisoformat(request.start_date.replace("Z", "+00:00"))
        end = datetime.fromisoformat(request.end_date.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="start_date and end_date must be ISO-8601 timestamps.") from exc
    if end <= start:
        raise HTTPException(status_code=400, detail="end_date must be later than start_date.")

    try:
        from nubra_python_sdk.marketdata.market_data import MarketData
        md = MarketData(_get_sdk())
        response = md.historical_data({
            "exchange": request.exchange,
            "type": request.instrument_type,
            "values": [x.strip().upper() for x in request.symbols],
            "fields": request.fields,
            "startDate": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "endDate": end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "interval": request.interval,
            "intraDay": request.intraday,
            "realTime": request.realtime,
        })
        items = {}
        for group in (_attr(response, "result", []) or []):
            for instrument_dict in (_attr(group, "values", []) or []):
                if not isinstance(instrument_dict, dict):
                    continue
                for symbol, chart in instrument_dict.items():
                    mapped = {}
                    for field in request.fields:
                        source_field = "cumulative_volume" if field == "volume" else field
                        if _attr(chart, source_field, None) is not None:
                            mapped[field] = _field_series(chart, source_field)
                    items[str(symbol).strip().upper()] = mapped
        return {
            "exchange": request.exchange,
            "instrument_type": request.instrument_type,
            "interval": request.interval,
            "items": items,
            "loaded_count": len(items),
            "requested_count": len(request.symbols),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nubra historical {request.instrument_type} data failed: {type(exc).__name__}: {exc}") from exc


def _option_item(option: Any, symbol_by_ref: dict[str, str] | None = None) -> dict[str, Any]:
    fields = (
        "ref_id", "timestamp", "strike_price", "lot_size",
        "last_traded_price", "last_traded_price_change",
        "open_interest", "open_interest_change", "volume",
        "iv", "delta", "gamma", "theta", "vega"
    )
    result = {field: _json_value(_attr(option, field)) for field in fields
              if _attr(option, field, None) is not None}
    ref_id = _attr(option, "ref_id")
    symbol = (symbol_by_ref or {}).get(str(ref_id)) if ref_id is not None else None
    if symbol:
        result["symbol"] = symbol
    return result


@app.get("/v1/option-chain", dependencies=[Depends(_authorize)])
def option_chain(instrument: str, exchange: str = "NSE", expiry: str | None = None):
    if exchange not in {"NSE", "BSE", "MCX"}:
        raise HTTPException(status_code=400, detail="exchange must be NSE, BSE or MCX.")
    try:
        from nubra_python_sdk.marketdata.market_data import MarketData
        md = MarketData(_get_sdk())
        result = md.option_chain(instrument.strip().upper(), expiry=expiry, exchange=exchange) if expiry else md.option_chain(instrument.strip().upper(), exchange=exchange)
        chain = _attr(result, "chain")
        if chain is None:
            raise ValueError("Nubra returned an empty option-chain response.")
        symbol_by_ref: dict[str, str] = {}
        try:
            from nubra_python_sdk.refdata.instruments import InstrumentData
            master = InstrumentData(_get_sdk()).get_instruments_dataframe(exchange=exchange)
            if master is not None and not master.empty and "ref_id" in master.columns and "stock_name" in master.columns:
                symbol_by_ref = {
                    str(row["ref_id"]): str(row["stock_name"])
                    for _, row in master[["ref_id", "stock_name"]].dropna().iterrows()
                }
        except Exception:
            # The chain remains useful for snapshot data even if contract-name mapping fails.
            symbol_by_ref = {}
        return {
            "exchange": exchange,
            "instrument": instrument.strip().upper(),
            "asset": _json_value(_attr(chain, "asset")),
            "expiry": _json_value(_attr(chain, "expiry")),
            "all_expiries": [_json_value(x) for x in (_attr(chain, "all_expiries", []) or [])],
            "current_price": _json_value(_attr(chain, "current_price")),
            "at_the_money_strike": _json_value(_attr(chain, "at_the_money_strike")),
            "ce": [_option_item(x, symbol_by_ref) for x in (_attr(chain, "ce", []) or [])],
            "pe": [_option_item(x, symbol_by_ref) for x in (_attr(chain, "pe", []) or [])],
        }
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nubra option chain failed: {type(exc).__name__}: {exc}") from exc


@app.get("/v1/current-price", dependencies=[Depends(_authorize)])
def current_price(instrument: str, exchange: str = "NSE"):
    if exchange not in {"NSE", "BSE", "MCX"}:
        raise HTTPException(status_code=400, detail="exchange must be NSE, BSE or MCX.")
    try:
        from nubra_python_sdk.marketdata.market_data import MarketData
        md = MarketData(_get_sdk())
        result = md.current_price(instrument.strip().upper(), exchange=exchange)
        return {
            "instrument": instrument.strip().upper(),
            "exchange": exchange,
            "message": _json_value(_attr(result, "message")),
            "price": _json_value(_attr(result, "price")),
            "previous_close": _json_value(_attr(result, "prev_close")),
            "change_percent": _json_value(_attr(result, "change")),
            "timestamp": _json_value(_attr(result, "timestamp")),
        }
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nubra current-price request failed: {type(exc).__name__}: {exc}") from exc
