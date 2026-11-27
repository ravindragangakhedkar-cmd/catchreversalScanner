from __future__ import annotations

import builtins
import csv
import getpass
import os
import queue
import threading
import time
import uuid
import requests
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Catch Reversals Nubra SDK Service", version="1.0.0")

_sdk_lock = threading.RLock()
_auth_worker_lock = threading.Lock()
_sdk_client: Any | None = None
_sdk_created_at = 0.0
SDK_MAX_AGE_SECONDS = 6 * 60 * 60
_auth_attempts: dict[str, dict[str, Any]] = {}
_auth_attempts_lock = threading.RLock()


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
        _sdk_client = None
        raise HTTPException(
            status_code=401,
            detail="Nubra is not connected. Open Broker Connect and complete SMS OTP plus MPIN verification.",
        )


def _run_sms_sdk_login(attempt: dict[str, Any]) -> None:
    global _sdk_client, _sdk_created_at
    mobile = attempt["mobile"]
    mpin = attempt["mpin"]
    otp_queue: queue.Queue[str] = attempt["otp_queue"]
    otp_requested: threading.Event = attempt["otp_requested"]
    done: threading.Event = attempt["done"]

    def prompt_value(prompt: str = "") -> str:
        prompt_text = (prompt or "").lower()
        if "phone" in prompt_text or "mobile" in prompt_text:
            return mobile
        if "mpin" in prompt_text or "pin" in prompt_text:
            return mpin
        # With totp_login=False, Nubra's SDK asks for the SMS OTP here.
        otp_requested.set()
        try:
            return otp_queue.get(timeout=240)
        except queue.Empty as exc:
            raise RuntimeError("Timed out waiting for the SMS OTP entered in Broker Connect.") from exc

    with _auth_worker_lock:
        original_input = builtins.input
        original_getpass = getpass.getpass
        try:
            os.environ["PHONE_NO"] = mobile
            os.environ["MPIN"] = mpin
            builtins.input = prompt_value
            getpass.getpass = prompt_value
            from nubra_python_sdk.start_sdk import InitNubraSdk, NubraEnv
            client = InitNubraSdk(
                env=NubraEnv.PROD,
                totp_login=False,
                env_creds=True,
            )
            with _sdk_lock:
                _sdk_client = client
                _sdk_created_at = time.time()
            attempt["result"] = {"authenticated": True, "method": "sms-otp"}
        except Exception as exc:
            attempt["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            builtins.input = original_input
            getpass.getpass = original_getpass
            os.environ.pop("PHONE_NO", None)
            os.environ.pop("MPIN", None)
            done.set()


class SmsLoginStart(BaseModel):
    mobile: str = Field(pattern=r"^[6-9][0-9]{9}$")
    mpin: str = Field(pattern=r"^[0-9]{4}$")


class SmsLoginVerify(BaseModel):
    challenge_id: str = Field(min_length=16, max_length=80)
    otp: str = Field(pattern=r"^[0-9]{6}$")


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



@app.get("/v1/auth-status", dependencies=[Depends(_authorize)])
def auth_status():
    """Report whether a manual SMS OTP + MPIN SDK session is active."""
    with _sdk_lock:
        authenticated = _sdk_client is not None and time.time() - _sdk_created_at < SDK_MAX_AGE_SECONDS
    return {
        "authenticated": authenticated,
        "method": "sms-otp",
        "service": "nubra-python-sdk",
    }


@app.post("/v1/auth/start", dependencies=[Depends(_authorize)])
def auth_start(request: SmsLoginStart):
    """Start the SDK's normal phone/SMS OTP/MPIN login and wait until it requests the SMS code."""
    with _sdk_lock:
        if _sdk_client is not None and time.time() - _sdk_created_at < SDK_MAX_AGE_SECONDS:
            return {"authenticated": True, "method": "sms-otp", "message": "Nubra is already connected."}

    challenge_id = uuid.uuid4().hex
    attempt: dict[str, Any] = {
        "mobile": request.mobile,
        "mpin": request.mpin,
        "otp_queue": queue.Queue(maxsize=1),
        "otp_requested": threading.Event(),
        "done": threading.Event(),
        "created_at": time.time(),
    }
    with _auth_attempts_lock:
        _auth_attempts.clear()
        _auth_attempts[challenge_id] = attempt

    worker = threading.Thread(target=_run_sms_sdk_login, args=(attempt,), daemon=True)
    attempt["worker"] = worker
    worker.start()

    if not attempt["otp_requested"].wait(timeout=30):
        if attempt["done"].is_set():
            with _auth_attempts_lock:
                _auth_attempts.pop(challenge_id, None)
            raise HTTPException(status_code=502, detail=attempt.get("error", "Nubra SDK did not request an SMS OTP."))
        raise HTTPException(status_code=504, detail="Nubra did not reach the SMS OTP prompt within 30 seconds.")

    return {
        "challenge_id": challenge_id,
        "message": f"Nubra requested the SMS OTP for the registered mobile ending {request.mobile[-4:]}.",
        "method": "sms-otp",
    }


@app.post("/v1/auth/verify", dependencies=[Depends(_authorize)])
def auth_verify(request: SmsLoginVerify):
    with _auth_attempts_lock:
        attempt = _auth_attempts.get(request.challenge_id)
    if not attempt:
        raise HTTPException(status_code=404, detail="OTP challenge not found or expired. Start Broker Connect again.")
    if time.time() - attempt["created_at"] > 240:
        with _auth_attempts_lock:
            _auth_attempts.pop(request.challenge_id, None)
        raise HTTPException(status_code=408, detail="SMS OTP challenge expired. Request a new OTP.")

    try:
        attempt["otp_queue"].put_nowait(request.otp)
    except queue.Full:
        raise HTTPException(status_code=409, detail="An OTP was already submitted for this challenge.")

    if not attempt["done"].wait(timeout=60):
        raise HTTPException(status_code=504, detail="Nubra SDK did not finish OTP and MPIN verification in time.")
    with _auth_attempts_lock:
        _auth_attempts.pop(request.challenge_id, None)
    if attempt.get("error"):
        raise HTTPException(status_code=502, detail=f"Nubra SMS OTP authentication failed: {attempt['error']}")
    return {"authenticated": True, "method": "sms-otp", "service": "nubra-python-sdk"}


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
    asset_type: str | None = None,
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
        # Do not retain or duplicate the full instrument master in a 512 MB
        # container. Fetch it for this request and filter the original frame.
        frame = InstrumentData(_get_sdk()).get_instruments_dataframe(exchange=exchange)
        if frame is None or frame.empty:
            return {"exchange": exchange, "count": 0, "items": []}

        selected = frame
        del frame  # release the extra reference so filtered frames can be reclaimed
        if asset is not None and "asset" in selected.columns:
            selected = selected[selected["asset"].astype(str).str.upper() == asset.upper()]
        if derivative_type == "STOCK":
            if "asset_type" in selected.columns:
                selected = selected[selected["asset_type"].astype(str).str.upper().eq("STOCKS")]
            elif "derivative_type" in selected.columns:
                selected = selected[selected["derivative_type"].isna()]
        elif derivative_type is not None and "derivative_type" in selected.columns:
            selected = selected[selected["derivative_type"].astype(str).str.upper() == derivative_type.upper()]
        if option_type is not None and "option_type" in selected.columns:
            selected = selected[selected["option_type"].astype(str).str.upper() == option_type.upper()]
        if asset_type is not None and "asset_type" in selected.columns:
            selected = selected[selected["asset_type"].astype(str).str.upper() == asset_type.upper()]
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


@app.get("/v1/indices", dependencies=[Depends(_authorize)])
def indices_master(symbol: str | None = None):
    """Nubra public Index Master is separate from the tradable instruments DataFrame."""
    try:
        response = requests.get("https://api.nubra.io/public/indexes?format=csv", timeout=15)
        response.raise_for_status()
        rows = list(csv.DictReader(response.text.splitlines()))
        if symbol:
            needle = symbol.strip().upper()
            rows = [row for row in rows if any(needle in str(value).upper() for value in row.values())]
        return {"count": len(rows), "items": rows, "source": "Nubra public Index Master"}
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Nubra Index Master request failed: {exc}") from exc


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
        # Avoid loading the full NSE/BSE instrument master just to decorate
        # option-chain rows. The option-chain response itself remains complete;
        # the optional symbol label is simply omitted when unavailable.
        symbol_by_ref: dict[str, str] = {}
        underlying_snapshot = None
        try:
            underlying_snapshot = md.current_price(instrument.strip().upper(), exchange=exchange)
        except Exception:
            underlying_snapshot = None
        return {
            "exchange": exchange,
            "instrument": instrument.strip().upper(),
            "asset": _json_value(_attr(chain, "asset")),
            "expiry": _json_value(_attr(chain, "expiry")),
            "all_expiries": [_json_value(x) for x in (_attr(chain, "all_expiries", []) or [])],
            "current_price": _json_value(_attr(chain, "current_price")),
            "underlying_instrument": {"ltp": _json_value(_attr(underlying_snapshot, "price")), "prev_close": _json_value(_attr(underlying_snapshot, "prev_close"))} if underlying_snapshot is not None else None,
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
            "price": (float(_attr(result, "price")) / 100.0) if _attr(result, "price") is not None else None,
            "previous_close": (float(_attr(result, "prev_close")) / 100.0) if _attr(result, "prev_close") is not None else None,
            "change_percent": _json_value(_attr(result, "change")),
            "timestamp": _json_value(_attr(result, "timestamp")),
        }
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nubra current-price request failed: {type(exc).__name__}: {exc}") from exc
