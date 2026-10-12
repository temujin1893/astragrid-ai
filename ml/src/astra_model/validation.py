from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_extraction import DictVectorizer
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_score,
    precision_recall_curve,
    recall_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

from .features import ContextualSnapshot, LabeledSnapshot, feature_vector
from .model import MODEL_VERSION, predict_flood_risk, save_model, train_model, load_model
from .synthetic_dataset import (
    DATASET_DESCRIPTION,
    DEFAULT_RANDOM_STATE,
    DEFAULT_SAMPLE_COUNT,
    TARGET_HORIZON_MINUTES,
    generate_synthetic_snapshots,
    write_jsonl,
)


def stratified_split(
    snapshots: list[LabeledSnapshot],
    test_size: float = 0.2,
    random_state: int = DEFAULT_RANDOM_STATE,
) -> tuple[list[LabeledSnapshot], list[LabeledSnapshot]]:
    if not 0 < test_size < 1:
        raise ValueError("test_size must be strictly between 0 and 1")
    labels = [snapshot["flood"] for snapshot in snapshots]
    train, test = train_test_split(
        snapshots,
        test_size=test_size,
        random_state=random_state,
        stratify=labels,
    )
    return list(train), list(test)


def baseline_prediction(features: dict[str, float | str]) -> bool:
    """Threshold baseline over test-snapshot features; not a learned model."""
    return bool(
        features["water_level_latest"] >= 90
        or features["water_level_change_15m"] >= 3.5
        or features["rainfall_latest"] >= 80
        or features["rainfall_change_15m"] >= 10
        or features["historical_incident_count"] >= 4
    )


def metric_summary(
    actual: list[bool],
    predicted: list[bool],
    scores: list[float],
) -> dict[str, Any]:
    return {
        "accuracy": float(accuracy_score(actual, predicted)),
        "precision": float(precision_score(actual, predicted, zero_division=0)),
        "recall": float(recall_score(actual, predicted, zero_division=0)),
        "f1": float(f1_score(actual, predicted, zero_division=0)),
        "pr_auc": float(average_precision_score(actual, scores)),
        "confusion_matrix": confusion_matrix(actual, predicted, labels=[False, True]).tolist(),
        "classification_report": classification_report(
            actual,
            predicted,
            labels=[False, True],
            target_names=["no_event", "event"],
            output_dict=True,
            zero_division=0,
        ),
    }


def _positive_probabilities(classifier: Any, features: list[dict[str, float | str]]) -> list[float]:
    probabilities = classifier.predict_proba(features)
    classes = list(classifier.classes_)
    positive_index = classes.index(True)
    return [float(probability[positive_index]) for probability in probabilities]


def _fit_random_forest(
    train_features: list[dict[str, float | str]],
    train_labels: list[bool],
    random_state: int,
) -> Pipeline:
    pipeline = Pipeline([
        ("encode", DictVectorizer(sparse=True)),
        ("classifier", RandomForestClassifier(
            n_estimators=180,
            min_samples_leaf=2,
            max_features="sqrt",
            class_weight="balanced_subsample",
            n_jobs=-1,
            random_state=random_state,
        )),
    ])
    pipeline.fit(train_features, train_labels)
    return pipeline


def _feature_importance(logistic_model: Pipeline, forest_model: Pipeline) -> dict[str, Any]:
    feature_names = logistic_model.named_steps["encode"].get_feature_names_out().tolist()
    coefficients = logistic_model.named_steps["classifier"].coef_[0]
    logistic_rows = [
        {
            "feature": name,
            "coefficient": float(coefficient),
            "absolute_coefficient": float(abs(coefficient)),
        }
        for name, coefficient in zip(feature_names, coefficients, strict=True)
    ]
    logistic_rows.sort(key=lambda item: item["absolute_coefficient"], reverse=True)

    forest_values = forest_model.named_steps["classifier"].feature_importances_
    forest_rows = [
        {"feature": name, "importance": float(importance)}
        for name, importance in zip(feature_names, forest_values, strict=True)
    ]
    forest_rows.sort(key=lambda item: item["importance"], reverse=True)
    return {
        "interpretation": (
            "Coefficients and impurity importances are model-relative indicators, not causal relationships. "
            "Logistic coefficients are from the scaled feature space."
        ),
        "logistic_regression": logistic_rows,
        "random_forest": forest_rows,
    }


def _save_plots(
    output_dir: Path,
    actual: list[bool],
    model_results: dict[str, dict[str, Any]],
    importance: dict[str, Any],
) -> None:
    names = list(model_results)
    figure, axes = plt.subplots(1, len(names), figsize=(5 * len(names), 4))
    axes_list = np.atleast_1d(axes)
    for axis, name in zip(axes_list, names, strict=True):
        matrix = np.asarray(model_results[name]["metrics"]["confusion_matrix"])
        axis.imshow(matrix, cmap="Blues")
        axis.set_title(name.replace("_", " ").title())
        axis.set_xlabel("Predicted")
        axis.set_ylabel("Actual")
        axis.set_xticks((0, 1), labels=("No event", "Event"))
        axis.set_yticks((0, 1), labels=("No event", "Event"))
        for (row, column), value in np.ndenumerate(matrix):
            axis.text(column, row, str(value), ha="center", va="center")
    figure.tight_layout()
    figure.savefig(output_dir / "confusion_matrices.png", dpi=150)
    plt.close(figure)

    figure, axis = plt.subplots(figsize=(7, 5))
    for name, result in model_results.items():
        precision, recall, _ = precision_recall_curve(actual, result["scores"])
        axis.plot(recall, precision, label=f"{name.replace('_', ' ').title()} (AP={result['metrics']['pr_auc']:.3f})")
    axis.set_xlabel("Recall")
    axis.set_ylabel("Precision")
    axis.set_title("Precision-recall curve")
    axis.legend(loc="best")
    figure.tight_layout()
    figure.savefig(output_dir / "precision_recall_curve.png", dpi=150)
    plt.close(figure)

    top_features = importance["logistic_regression"][:20]
    labels = [item["feature"] for item in reversed(top_features)]
    values = [item["coefficient"] for item in reversed(top_features)]
    colors = ["#b64b4b" if value < 0 else "#347d69" for value in values]
    figure, axis = plt.subplots(figsize=(9, 7))
    axis.barh(labels, values, color=colors)
    axis.axvline(0, color="#333333", linewidth=0.8)
    axis.set_title("Logistic regression coefficients (top 20 by absolute value)")
    axis.set_xlabel("Coefficient in scaled feature space")
    figure.tight_layout()
    figure.savefig(output_dir / "feature_coefficients.png", dpi=150)
    plt.close(figure)


def _inference_snapshot() -> ContextualSnapshot:
    timestamp = "2026-10-12T12:00:00Z"
    previous = "2026-10-12T11:50:00Z"
    return {
        "zoneId": "KATPADI",
        "timestamp": timestamp,
        "historicalIncidentCount": 4,
        "populationCategory": 2,
        "readings": [
            {"zoneId": "KATPADI", "sensorType": "WATER_LEVEL", "value": 88.8, "timestamp": previous},
            {"zoneId": "KATPADI", "sensorType": "WATER_LEVEL", "value": 93, "timestamp": timestamp},
            {"zoneId": "KATPADI", "sensorType": "RAINFALL", "value": 78, "timestamp": previous},
            {"zoneId": "KATPADI", "sensorType": "RAINFALL", "value": 86, "timestamp": timestamp},
            {"zoneId": "KATPADI", "sensorType": "TRAFFIC", "value": 91, "timestamp": timestamp},
            {"zoneId": "KATPADI", "sensorType": "AIR_QUALITY", "value": 110, "timestamp": timestamp},
            {"zoneId": "KATPADI", "sensorType": "TEMPERATURE", "value": 31, "timestamp": timestamp},
            {"zoneId": "KATPADI", "sensorType": "POWER", "value": 87, "timestamp": timestamp},
        ],
    }


def run_validation(
    output_root: Path,
    sample_count: int = DEFAULT_SAMPLE_COUNT,
    random_state: int = DEFAULT_RANDOM_STATE,
) -> dict[str, Any]:
    data_dir = output_root / "data"
    results_dir = output_root / "results"
    artifacts_dir = output_root / "artifacts"
    results_dir.mkdir(parents=True, exist_ok=True)

    snapshots = generate_synthetic_snapshots(sample_count, random_state)
    write_jsonl(snapshots, data_dir / "synthetic_snapshots.jsonl")
    labels = [snapshot["flood"] for snapshot in snapshots]
    positive_count = sum(labels)
    negative_count = len(labels) - positive_count
    if positive_count == 0 or negative_count == 0:
        raise ValueError("synthetic dataset must contain both target classes")

    train_snapshots, test_snapshots = stratified_split(snapshots, test_size=0.2, random_state=random_state)
    train_labels = [snapshot["flood"] for snapshot in train_snapshots]
    test_labels = [snapshot["flood"] for snapshot in test_snapshots]
    train_features = [feature_vector(snapshot) for snapshot in train_snapshots]
    test_features = [feature_vector(snapshot) for snapshot in test_snapshots]

    logistic_model = train_model(train_snapshots)
    logistic_probabilities = _positive_probabilities(logistic_model, test_features)
    logistic_predictions = [probability >= 0.5 for probability in logistic_probabilities]

    forest_model = _fit_random_forest(train_features, train_labels, random_state)
    forest_probabilities = _positive_probabilities(forest_model, test_features)
    forest_predictions = [probability >= 0.5 for probability in forest_probabilities]

    baseline_predictions = [baseline_prediction(features) for features in test_features]
    model_outputs = {
        "baseline": (baseline_predictions, [float(prediction) for prediction in baseline_predictions]),
        "logistic_regression": (logistic_predictions, logistic_probabilities),
        "random_forest": (forest_predictions, forest_probabilities),
    }
    model_results: dict[str, dict[str, Any]] = {}
    for name, (predictions, scores) in model_outputs.items():
        metrics = metric_summary(test_labels, predictions, scores)
        model_results[name] = {"metrics": metrics, "scores": scores}

    serializable_models = {
        name: result["metrics"] for name, result in model_results.items()
    }
    evaluation = {
        "dataset": {
            "description": DATASET_DESCRIPTION,
            "target": "significant flood/disaster-risk event within the next 30 minutes",
            "samples": len(snapshots),
            "positive_samples": positive_count,
            "negative_samples": negative_count,
            "positive_rate": positive_count / len(snapshots),
            "target_horizon_minutes": TARGET_HORIZON_MINUTES,
            "random_state": random_state,
        },
        "split": {
            "strategy": "stratified random split",
            "train_samples": len(train_snapshots),
            "test_samples": len(test_snapshots),
            "test_fraction": 0.2,
            "random_state": random_state,
            "leakage_note": "Target labels and target horizon are excluded from model features.",
        },
        "models": serializable_models,
    }

    importance = _feature_importance(logistic_model, forest_model)
    (results_dir / "evaluation.json").write_text(
        json.dumps(evaluation, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    (results_dir / "feature_importance.json").write_text(
        json.dumps(importance, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )

    model_path = artifacts_dir / "flood-risk.joblib"
    save_model(logistic_model, model_path)
    loaded_model = load_model(model_path)
    inference = _inference_snapshot()
    prediction = predict_flood_risk(loaded_model, inference)
    inference_output = {
        "zone": inference["zoneId"],
        "prediction_horizon_minutes": TARGET_HORIZON_MINUTES,
        "flood_probability": prediction.flood_probability,
        "risk_category": prediction.risk_category,
        "model_version": MODEL_VERSION,
    }
    (results_dir / "inference.json").write_text(
        json.dumps(inference_output, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    _save_plots(results_dir, test_labels, model_results, importance)

    return {
        "dataset": evaluation["dataset"],
        "split": evaluation["split"],
        "models": serializable_models,
        "inference": inference_output,
        "outputs": {
            "dataset": str(data_dir / "synthetic_snapshots.jsonl"),
            "evaluation": str(results_dir / "evaluation.json"),
            "feature_importance": str(results_dir / "feature_importance.json"),
            "inference": str(results_dir / "inference.json"),
            "model": str(model_path),
            "plots": [
                str(results_dir / "confusion_matrices.png"),
                str(results_dir / "precision_recall_curve.png"),
                str(results_dir / "feature_coefficients.png"),
            ],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic data, train, and evaluate AstraGrid flood models.")
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLE_COUNT)
    parser.add_argument("--seed", type=int, default=DEFAULT_RANDOM_STATE)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="ML package directory that receives data/, results/, and artifacts/",
    )
    args = parser.parse_args()
    print(json.dumps(run_validation(args.output_root, args.samples, args.seed), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()