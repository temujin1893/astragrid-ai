from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from math import exp, sin, tau
from pathlib import Path

import numpy as np

from .features import LabeledSnapshot, Reading

ZONE_IDS = ("KATPADI", "VELLORE_CENTRAL", "SATHUVACHARI", "INDUSTRIAL_AREA")
DEFAULT_SAMPLE_COUNT = 8_000
DEFAULT_RANDOM_STATE = 42
TARGET_HORIZON_MINUTES = 30
DATASET_DESCRIPTION = (
    "SYNTHETIC academic-project telemetry; not real Vellore municipal, government, "
    "emergency-response, or production sensor data."
)


def _sigmoid(value: float) -> float:
    if value >= 0:
        return 1 / (1 + exp(-value))
    exp_value = exp(value)
    return exp_value / (1 + exp_value)


def _reading(zone: str, kind: str, value: float, timestamp: datetime) -> Reading:
    return {
        "zoneId": zone,
        "sensorType": kind,
        "value": round(float(value), 2),
        "timestamp": timestamp.isoformat().replace("+00:00", "Z"),
    }


def generate_synthetic_snapshots(
    sample_count: int = DEFAULT_SAMPLE_COUNT,
    random_state: int = DEFAULT_RANDOM_STATE,
) -> list[LabeledSnapshot]:
    """Generate labeled, synthetic zone snapshots with noisy future-risk labels."""
    if sample_count < 20:
        raise ValueError("sample_count must be at least 20 to support a useful evaluation split")

    rng = np.random.default_rng(random_state)
    population_weights = {
        "KATPADI": (0.20, 0.50, 0.30),
        "VELLORE_CENTRAL": (0.10, 0.40, 0.50),
        "SATHUVACHARI": (0.15, 0.50, 0.35),
        "INDUSTRIAL_AREA": (0.35, 0.50, 0.15),
    }
    zone_offsets = {
        "KATPADI": 3.0,
        "VELLORE_CENTRAL": -1.0,
        "SATHUVACHARI": 1.0,
        "INDUSTRIAL_AREA": 2.0,
    }
    base_time = datetime(2022, 1, 1, tzinfo=timezone.utc)
    snapshots: list[LabeledSnapshot] = []

    for index in range(sample_count):
        zone = str(rng.choice(ZONE_IDS))
        population_category = int(rng.choice((0, 1, 2), p=population_weights[zone]))
        timestamp = base_time + timedelta(minutes=30 * index)
        hour = timestamp.hour + timestamp.minute / 60
        daily_rain_effect = 2.0 * sin(tau * (hour - 14) / 24)

        rainfall = float(np.clip(rng.gamma(shape=2.0, scale=21.0) + daily_rain_effect, 0, 160))
        rainfall_change = float(rng.normal(0.2 + 0.10 * (rainfall - 42), 8.0))
        water_level = float(np.clip(
            rng.normal(59 + zone_offsets[zone] + 0.27 * rainfall, 14.5),
            8,
            145,
        ))
        water_level_change = float(rng.normal(-0.4 + 0.22 * rainfall_change + 0.025 * (water_level - 70), 4.8))
        traffic = float(np.clip(rng.normal(54 + 5 * (zone == "VELLORE_CENTRAL") + 2 * population_category, 17), 5, 100))
        air_quality = float(np.clip(rng.normal(54 + 32 * (zone == "INDUSTRIAL_AREA") + 5 * population_category, 23), 5, 260))
        temperature = float(np.clip(29 + 3.2 * sin(tau * (hour - 8) / 24) + rng.normal(0, 2.2), 16, 46))
        power = float(np.clip(49 + 0.17 * traffic + 0.62 * (temperature - 29) + rng.normal(0, 9), 15, 115))
        incident_rate = 0.45 + 0.28 * population_category + 0.25 * (zone == "KATPADI") + 0.18 * (zone == "INDUSTRIAL_AREA")
        historical_incidents = int(min(rng.poisson(incident_rate), 10))

        zone_effect = {
            "KATPADI": 0.16,
            "VELLORE_CENTRAL": 0.02,
            "SATHUVACHARI": 0.08,
            "INDUSTRIAL_AREA": 0.10,
        }[zone]
        logit = (
            -0.82
            + 0.92 * ((water_level - 82) / 13)
            + 0.62 * ((water_level_change - 1) / 5)
            + 0.84 * ((rainfall - 58) / 20)
            + 0.34 * ((rainfall_change - 1) / 8)
            + 0.29 * np.log1p(historical_incidents)
            + 0.13 * ((traffic - 62) / 25)
            + 0.10 * ((air_quality - 75) / 55)
            + 0.07 * ((temperature - 30) / 8)
            + 0.08 * ((power - 68) / 22)
            + 0.14 * population_category
            + zone_effect
            + 0.08 * sin(tau * hour / 24)
            + rng.normal(0, 0.65)
        )
        flood_probability = _sigmoid(float(logit))
        flood = bool(rng.random() < flood_probability)

        prior_timestamp = timestamp - timedelta(minutes=10)
        readings = [
            _reading(zone, "WATER_LEVEL", water_level - water_level_change, prior_timestamp),
            _reading(zone, "RAINFALL", rainfall - rainfall_change, prior_timestamp),
            _reading(zone, "WATER_LEVEL", water_level, timestamp),
            _reading(zone, "RAINFALL", rainfall, timestamp),
            _reading(zone, "TRAFFIC", traffic, timestamp),
            _reading(zone, "AIR_QUALITY", air_quality, timestamp),
            _reading(zone, "TEMPERATURE", temperature, timestamp),
            _reading(zone, "POWER", power, timestamp),
        ]
        snapshots.append({
            "zoneId": zone,
            "timestamp": timestamp.isoformat().replace("+00:00", "Z"),
            "readings": readings,
            "historicalIncidentCount": historical_incidents,
            "populationCategory": population_category,
            "targetHorizonMinutes": TARGET_HORIZON_MINUTES,
            "flood": flood,
        })

    return snapshots


def write_jsonl(snapshots: list[LabeledSnapshot], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as destination:
        for snapshot in snapshots:
            destination.write(json.dumps(snapshot, separators=(",", ":"), allow_nan=False))
            destination.write("\n")