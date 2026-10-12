from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import cast

import joblib
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .features import FEATURE_VERSION, ContextualSnapshot, LabeledSnapshot, Snapshot, feature_vector

RISK_THRESHOLDS = {"LOW": 0.33, "MEDIUM": 0.67}
ARTIFACT_FORMAT_VERSION = 1
MODEL_VERSION = "1.0"


@dataclass(frozen=True)
class RiskPrediction:
    flood_probability: float
    risk_category: str


def risk_category(probability: float) -> str:
    if not 0 <= probability <= 1:
        raise ValueError("probability must be between 0 and 1")
    if probability < RISK_THRESHOLDS["LOW"]:
        return "LOW"
    if probability < RISK_THRESHOLDS["MEDIUM"]:
        return "MEDIUM"
    return "HIGH"


def train_model(snapshots: list[LabeledSnapshot]) -> Pipeline:
    if len(snapshots) < 4:
        raise ValueError("at least four labeled snapshots are required for training")
    labels = [snapshot["flood"] for snapshot in snapshots]
    if not all(isinstance(label, bool) for label in labels):
        raise ValueError("each training snapshot must include a boolean flood label")
    if set(labels) != {False, True}:
        raise ValueError("training data must contain both flood and non-flood labels")
    if min(labels.count(False), labels.count(True)) < 2:
        raise ValueError("training data must contain at least two examples of each label")

    features = [feature_vector(cast(ContextualSnapshot, snapshot)) for snapshot in snapshots]
    pipeline = Pipeline([
        ("encode", DictVectorizer(sparse=True)),
        ("scale", StandardScaler(with_mean=False)),
        ("classifier", LogisticRegression(class_weight="balanced", max_iter=1000, random_state=42)),
    ])
    pipeline.fit(features, labels)
    return pipeline


def save_model(model: Pipeline, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({
        "format_version": ARTIFACT_FORMAT_VERSION,
        "model_version": MODEL_VERSION,
        "feature_version": FEATURE_VERSION,
        "model": model,
    }, output_path)


def load_model(model_path: Path) -> Pipeline:
    if not model_path.is_file():
        raise FileNotFoundError(f"trained model not found at {model_path}; train it from labeled data first")
    artifact = joblib.load(model_path)
    if not isinstance(artifact, dict) or artifact.get("format_version") != ARTIFACT_FORMAT_VERSION:
        raise ValueError("unsupported or invalid AstraGrid model artifact")
    if artifact.get("feature_version") != FEATURE_VERSION:
        raise ValueError("model artifact feature version does not match this package")
    model = artifact.get("model")
    if not isinstance(model, Pipeline):
        raise ValueError("model artifact does not contain a scikit-learn pipeline")
    return model


def predict_flood_risk(model: Pipeline, snapshot: Snapshot) -> RiskPrediction:
    features = feature_vector(snapshot)
    probabilities = model.predict_proba([features])[0]
    try:
        positive_index = list(model.classes_).index(True)
    except ValueError as error:
        raise ValueError("loaded model was not trained with the positive flood class") from error
    probability = float(probabilities[positive_index])
    return RiskPrediction(probability, risk_category(probability))