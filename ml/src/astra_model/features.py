from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import cos, isfinite, sin, tau
from typing import TypedDict

FEATURE_VERSION = 1
SENSOR_TYPES = (
    "WATER_LEVEL",
    "RAINFALL",
    "TRAFFIC",
    "AIR_QUALITY",
    "TEMPERATURE",
    "POWER",
)


class Reading(TypedDict, total=False):
    zoneId: str
    zone: str
    sensorType: str
    type: str
    value: float
    timestamp: str
    recordedAt: str


class Snapshot(TypedDict):
    zoneId: str
    timestamp: str
    readings: list[Reading]


class ContextualSnapshot(Snapshot, total=False):
    historicalIncidentCount: int
    populationCategory: int


class LabeledSnapshot(ContextualSnapshot):
    flood: bool


def parse_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO-8601 timestamp string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{field} must be a valid ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _reading_values(snapshot: Snapshot) -> list[tuple[datetime, str, float]]:
    snapshot_zone = snapshot.get("zoneId")
    if not isinstance(snapshot_zone, str) or not snapshot_zone:
        raise ValueError("zoneId must be a non-empty string")
    as_of = parse_timestamp(snapshot.get("timestamp"), "timestamp")
    raw_readings = snapshot.get("readings")
    if not isinstance(raw_readings, list) or not raw_readings:
        raise ValueError("readings must be a non-empty list")

    parsed: list[tuple[datetime, str, float]] = []
    for index, reading in enumerate(raw_readings):
        if not isinstance(reading, dict):
            raise ValueError(f"readings[{index}] must be an object")
        zone = reading.get("zoneId", reading.get("zone"))
        sensor_type = reading.get("sensorType", reading.get("type"))
        value = reading.get("value")
        reading_timestamp = reading.get("timestamp", reading.get("recordedAt"))
        if zone != snapshot_zone:
            continue
        if sensor_type not in SENSOR_TYPES:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
            raise ValueError(f"readings[{index}].value must be a finite number")
        timestamp = parse_timestamp(reading_timestamp, f"readings[{index}].timestamp")
        if timestamp <= as_of:
            parsed.append((timestamp, sensor_type, float(value)))
    if not parsed:
        raise ValueError("no supported readings for zoneId at or before snapshot timestamp")
    return sorted(parsed)


def feature_vector(snapshot: ContextualSnapshot) -> dict[str, float | str]:
    """Build a deterministic zone/time feature vector from raw sensor records."""
    as_of = parse_timestamp(snapshot.get("timestamp"), "timestamp")
    readings = _reading_values(snapshot)
    features: dict[str, float | str] = {"zoneId": snapshot["zoneId"]}
    hour = as_of.hour + as_of.minute / 60 + as_of.second / 3600
    features["hour_sin"] = sin(tau * hour / 24)
    features["hour_cos"] = cos(tau * hour / 24)
    features["weekday_sin"] = sin(tau * as_of.weekday() / 7)
    features["weekday_cos"] = cos(tau * as_of.weekday() / 7)

    historical_incidents = snapshot.get("historicalIncidentCount", 0)
    population_category = snapshot.get("populationCategory", 1)
    if (
        isinstance(historical_incidents, bool)
        or not isinstance(historical_incidents, (int, float))
        or not isfinite(historical_incidents)
        or historical_incidents < 0
    ):
        raise ValueError("historicalIncidentCount must be a finite non-negative number")
    if isinstance(population_category, bool) or population_category not in (0, 1, 2):
        raise ValueError("populationCategory must be 0, 1, or 2")
    features["historical_incident_count"] = float(historical_incidents)
    features["population_category"] = float(population_category)

    for sensor_type in SENSOR_TYPES:
        values = [(timestamp, value) for timestamp, kind, value in readings if kind == sensor_type]
        values_24h = [(timestamp, value) for timestamp, value in values if timestamp >= as_of - timedelta(hours=24)]
        values_1h = [(timestamp, value) for timestamp, value in values if timestamp >= as_of - timedelta(hours=1)]
        latest = values_24h[-1][1] if values_24h else None
        features[f"{sensor_type.lower()}_present"] = float(latest is not None)
        features[f"{sensor_type.lower()}_latest"] = latest if latest is not None else 0.0
        features[f"{sensor_type.lower()}_mean_1h"] = (
            sum(value for _, value in values_1h) / len(values_1h) if values_1h else 0.0
        )
        features[f"{sensor_type.lower()}_max_1h"] = max((value for _, value in values_1h), default=0.0)

        recent = [(timestamp, value) for timestamp, value in values_24h if timestamp >= as_of - timedelta(minutes=15)]
        features[f"{sensor_type.lower()}_change_15m"] = (
            recent[-1][1] - recent[0][1] if len(recent) >= 2 else 0.0
        )
        features[f"{sensor_type.lower()}_samples_1h"] = float(len(values_1h))

    return features