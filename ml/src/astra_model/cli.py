from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import cast

from .features import LabeledSnapshot, Snapshot
from .model import load_model, predict_flood_risk, save_model, train_model


def read_jsonl(path: Path) -> list[object]:
    records: list[object] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSON on line {line_number}: {error.msg}") from error
    return records


def train_command(dataset: Path, model_path: Path) -> None:
    raw_records = read_jsonl(dataset)
    snapshots: list[LabeledSnapshot] = []
    for index, value in enumerate(raw_records, start=1):
        if not isinstance(value, dict) or not isinstance(value.get("flood"), bool):
            raise ValueError(f"training record {index} must be an object with a boolean flood label")
        snapshots.append(cast(LabeledSnapshot, value))
    model = train_model(snapshots)
    save_model(model, model_path)
    print(json.dumps({"trained": True, "samples": len(snapshots), "modelPath": str(model_path)}))


def predict_command(model_path: Path, snapshot_path: Path) -> None:
    raw_snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    if not isinstance(raw_snapshot, dict):
        raise ValueError("inference input must be a JSON snapshot object")
    result = predict_flood_risk(load_model(model_path), cast(Snapshot, raw_snapshot))
    print(json.dumps({
        "floodProbability": result.flood_probability,
        "riskCategory": result.risk_category,
        "method": "supervised_logistic_regression",
    }))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train or run the AstraGrid flood-risk model.")
    commands = parser.add_subparsers(dest="command", required=True)

    train = commands.add_parser("train", help="train from labeled snapshot JSONL")
    train.add_argument("dataset", type=Path)
    train.add_argument("--model", type=Path, default=Path("artifacts/flood-risk.joblib"))

    predict = commands.add_parser("predict", help="predict flood probability for a snapshot JSON file")
    predict.add_argument("snapshot", type=Path)
    predict.add_argument("--model", type=Path, default=Path("artifacts/flood-risk.joblib"))
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        if args.command == "train":
            train_command(args.dataset, args.model)
        else:
            predict_command(args.model, args.snapshot)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"astra-model: {error}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()