from datetime import datetime, timedelta, timezone
import json
import tempfile
from pathlib import Path
import unittest

from astra_model.features import feature_vector
from astra_model.model import load_model, predict_flood_risk, risk_category, save_model, train_model
from astra_model.synthetic_dataset import generate_synthetic_snapshots
from astra_model.validation import metric_summary, run_validation, stratified_split


class FeatureEngineeringTests(unittest.TestCase):
    def test_features_use_api_reading_fields_and_filter_other_zones(self) -> None:
        timestamp = datetime(2026, 10, 12, 10, tzinfo=timezone.utc)
        prior = (timestamp - timedelta(minutes=10)).isoformat()
        current = timestamp.isoformat()
        features = feature_vector({
            "zoneId": "KATPADI",
            "timestamp": current,
            "readings": [
                {"zoneId": "KATPADI", "sensorType": "WATER_LEVEL", "value": 80, "timestamp": prior},
                {"zoneId": "KATPADI", "sensorType": "WATER_LEVEL", "value": 95, "timestamp": current},
                {"zoneId": "KATPADI", "sensorType": "RAINFALL", "value": 70, "timestamp": current},
                {"zoneId": "VELLORE_CENTRAL", "sensorType": "WATER_LEVEL", "value": 200, "timestamp": current},
            ],
        })

        self.assertEqual(features["zoneId"], "KATPADI")
        self.assertEqual(features["water_level_latest"], 95)
        self.assertEqual(features["water_level_change_15m"], 15)
        self.assertEqual(features["rainfall_latest"], 70)
        self.assertEqual(features["water_level_samples_1h"], 2)

    def test_accepts_existing_api_type_and_timestamp_aliases(self) -> None:
        features = feature_vector({
            "zoneId": "KATPADI",
            "timestamp": "2026-10-12T10:00:00Z",
            "readings": [{
                "zoneId": "KATPADI",
                "type": "WATER_LEVEL",
                "value": 92,
                "recordedAt": "2026-10-12T09:59:00Z",
            }],
        })
        self.assertEqual(features["water_level_latest"], 92)

    def test_stale_readings_do_not_count_as_present_or_latest(self) -> None:
        features = feature_vector({
            "zoneId": "KATPADI",
            "timestamp": "2026-10-12T10:00:00Z",
            "readings": [{
                "zoneId": "KATPADI",
                "sensorType": "WATER_LEVEL",
                "value": 99,
                "timestamp": "2026-10-10T09:00:00Z",
            }],
        })
        self.assertEqual(features["water_level_present"], 0.0)
        self.assertEqual(features["water_level_latest"], 0.0)


class RiskCategoryTests(unittest.TestCase):
    def test_probability_bands(self) -> None:
        self.assertEqual(risk_category(0.0), "LOW")
        self.assertEqual(risk_category(0.32), "LOW")
        self.assertEqual(risk_category(0.33), "MEDIUM")
        self.assertEqual(risk_category(0.66), "MEDIUM")
        self.assertEqual(risk_category(0.67), "HIGH")
        self.assertEqual(risk_category(1.0), "HIGH")


class SyntheticTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.snapshots = generate_synthetic_snapshots(sample_count=200, random_state=42)

    def test_synthetic_generation_is_reproducible(self) -> None:
        self.assertEqual(self.snapshots, generate_synthetic_snapshots(sample_count=200, random_state=42))

    def test_dataset_contains_both_classes_with_non_extreme_balance(self) -> None:
        labels = [snapshot["flood"] for snapshot in self.snapshots]
        positive_rate = sum(labels) / len(labels)
        self.assertGreater(sum(labels), 0)
        self.assertLess(sum(labels), len(labels))
        self.assertGreater(positive_rate, 0.05)
        self.assertLess(positive_rate, 0.50)

    def test_required_engineered_features_exist(self) -> None:
        features = feature_vector(self.snapshots[0])
        required = {
            "zoneId",
            "water_level_latest",
            "water_level_change_15m",
            "rainfall_latest",
            "rainfall_change_15m",
            "traffic_latest",
            "air_quality_latest",
            "temperature_latest",
            "power_latest",
            "historical_incident_count",
            "population_category",
            "hour_sin",
            "weekday_cos",
        }
        self.assertLessEqual(required, features.keys())

    def test_stratified_train_test_split_is_reproducible(self) -> None:
        train, test = stratified_split(self.snapshots, test_size=0.2, random_state=42)
        train_again, test_again = stratified_split(self.snapshots, test_size=0.2, random_state=42)
        self.assertEqual((len(train), len(test)), (160, 40))
        self.assertEqual(train, train_again)
        self.assertEqual(test, test_again)
        self.assertAlmostEqual(
            sum(item["flood"] for item in train) / len(train),
            sum(item["flood"] for item in test) / len(test),
            delta=0.03,
        )

    def test_logistic_model_trains_saves_loads_and_predicts_probability(self) -> None:
        train, test = stratified_split(self.snapshots, test_size=0.2, random_state=42)
        model = train_model(train)
        with tempfile.TemporaryDirectory() as directory:
            artifact_path = Path(directory) / "flood-risk.joblib"
            save_model(model, artifact_path)
            loaded = load_model(artifact_path)
            prediction = predict_flood_risk(loaded, test[0])
        self.assertTrue(0 <= prediction.flood_probability <= 1)
        self.assertIn(prediction.risk_category, {"LOW", "MEDIUM", "HIGH"})

    def test_evaluation_reports_required_metrics_without_expected_metric_fixtures(self) -> None:
        metrics = metric_summary(
            [False, False, True, True],
            [False, True, True, False],
            [0.1, 0.7, 0.8, 0.4],
        )
        self.assertLessEqual(
            {"accuracy", "precision", "recall", "f1", "pr_auc", "confusion_matrix", "classification_report"},
            metrics.keys(),
        )
        for metric_name in ("accuracy", "precision", "recall", "f1", "pr_auc"):
            self.assertTrue(0 <= metrics[metric_name] <= 1)

    def test_non_finite_sensor_value_is_rejected_before_inference(self) -> None:
        snapshot = {
            "zoneId": "KATPADI",
            "timestamp": "2026-10-12T10:00:00Z",
            "readings": [{
                "zoneId": "KATPADI",
                "sensorType": "WATER_LEVEL",
                "value": float("nan"),
                "timestamp": "2026-10-12T10:00:00Z",
            }],
        }
        train, _ = stratified_split(self.snapshots, test_size=0.2, random_state=42)
        model = train_model(train)
        with self.assertRaisesRegex(ValueError, "finite"):
            predict_flood_risk(model, snapshot)

    def test_validation_runner_writes_evaluation_and_inference_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = run_validation(root, sample_count=200, random_state=42)
            evaluation = json.loads((root / "results" / "evaluation.json").read_text(encoding="utf-8"))
            importance = json.loads((root / "results" / "feature_importance.json").read_text(encoding="utf-8"))
            inference = json.loads((root / "results" / "inference.json").read_text(encoding="utf-8"))

            self.assertEqual(evaluation["dataset"]["samples"], 200)
            self.assertEqual(set(evaluation["models"]), {"baseline", "logistic_regression", "random_forest"})
            self.assertIn("pr_auc", evaluation["models"]["logistic_regression"])
            self.assertTrue(importance["logistic_regression"])
            self.assertTrue(importance["random_forest"])
            self.assertEqual(inference["model_version"], "1.0")
            self.assertEqual(inference["zone"], "KATPADI")
            self.assertEqual(result["split"]["test_samples"], 40)
            for plot in result["outputs"]["plots"]:
                self.assertTrue(Path(plot).is_file())


if __name__ == "__main__":
    unittest.main()