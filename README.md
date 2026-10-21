# AstraGrid AI

AstraGrid AI is a smart-city monitoring and disaster response platform. The React dashboard polls the Express API, and the sensor simulator posts readings that the API persists in the deployed DynamoDB single table.

The API connects to the deployed DynamoDB table using the AWS SDK default credential chain. It does not provision cloud resources. Keep credentials in your existing AWS CLI or other standard credential provider configuration; never place them in project files.

## Requirements

- Node.js 20 or newer and npm
- Python 3.10 or newer for the model package

## Install

From the repository root:

```sh
npm install
```

## Run locally

Copy `apps/api/.env.example` to `apps/api/.env`; the API loads it automatically. Keep AWS credentials in your normal AWS CLI credential chain, not in that file. From the repository root, start each process in a separate terminal:

```sh
npm run dev:web
npm run dev:api
npm run dev:simulator
```

The dashboard is served at `http://localhost:5173`; the API listens at `http://localhost:3001`. The simulator publishes a reading for each sensor every three seconds. In particular, KATPADI water level and rainfall rise over time to demonstrate deterministic flood and rainfall incidents. The API uses `AWS_REGION=ap-south-2` and the table name configured in the example environment file.

The API exposes:

- `GET /api/health`
- `GET /api/sensors` and `GET /api/sensors/:sensorId`
- `GET /api/zones`
- `GET /api/incidents`
- `GET /api/dashboard`

The simulator uses `API_URL` (default `http://localhost:3001`) and `SIMULATOR_INTERVAL_MS` (default `3000`) environment variables. The web app uses `VITE_API_URL` (default `http://localhost:3001`). The API port can be changed with `PORT` (default `3001`).

The simulator sends sensor readings to the local `POST /api/readings` ingestion endpoint. The API applies deterministic thresholds for flood, rainfall, traffic, and air quality incidents; no LLM or cloud service is used for risk calculation.

## Flood Risk Model

The standalone Python ML package implements this workflow:

```text
Sensor readings -> feature engineering -> supervised model -> flood probability -> LOW / MEDIUM / HIGH
```

Feature engineering groups actual `zoneId`, `sensorType`, `value`, and `timestamp` reading fields into zone snapshots. It creates current values, 1-hour means/maxima/sample counts, 15-minute changes, sensor-presence indicators, and cyclical time features for all six sensor types. A scikit-learn logistic-regression classifier is trained from operator- or incident-labeled flood snapshots. The probability bands are `LOW` below 0.33, `MEDIUM` from 0.33 to below 0.67, and `HIGH` at or above 0.67.

The local validation runner generates a reproducible 8,000-snapshot synthetic dataset (seed 42), uses a stratified 80/20 holdout, compares a threshold baseline, logistic regression, and random forest, and writes metrics, feature coefficients/importances, plots, a model artifact, and a KATPADI inference result. Run it from the repository root after installing the package:

```sh
python -m pip install -e ./ml
python -m astra_model.validation
```

Generated files are written under `ml/data/`, `ml/results/`, and `ml/artifacts/`; those directories are gitignored. The dataset labels whether a significant flood/disaster-risk event occurs within the next 30 minutes. The weighted probabilistic target includes noise and uses only pre-snapshot sensor/context features; target labels and horizon metadata are excluded from model features.

**Limitation:** "The model is trained and evaluated using synthetic sensor telemetry generated for this academic project. It is not trained on real municipal, government, emergency-response, or production sensor data." Synthetic distributions may not represent real weather, infrastructure, sensor error, incident frequency, or population. Distribution shift is likely, and representative labeled historical data plus independent validation and probability calibration are needed before deployment. Model probabilities are not operational emergency predictions; human/operator oversight would be required. ML output is not connected to the API, dashboard, Detection Lambda, or EventBridge, so live risk behavior remains the existing deterministic rules.

Install the Python package and run its tests:

```sh
python -m venv .venv
# Activate the virtual environment, then run from the repository root:
python -m pip install -e ./ml
python -m unittest discover -s ml/tests -v
```

On Windows, activate with `.venv\\Scripts\\Activate.ps1`; on macOS or Linux, use `source .venv/bin/activate`.

Training data is JSON Lines: one object per labeled zone-time snapshot with a non-empty `readings` list and a boolean `flood` target. Readings use the API fields (`zoneId`, `sensorType`, `value`, and `timestamp`; `type`/`recordedAt` aliases are also accepted). Train and predict with:

```sh
python -m astra_model train path/to/labeled-snapshots.jsonl --model artifacts/flood-risk.joblib
python -m astra_model predict path/to/current-snapshot.json --model artifacts/flood-risk.joblib
```

Prediction output contains `floodProbability`, `riskCategory`, and the method name. `current-snapshot.json` uses the same `zoneId`, `timestamp`, and `readings` fields but does not need the `flood` label.

## Checks

```sh
npm run typecheck
npm run build
```

To synthesize the CDK app locally (no deployment):

```sh
npm run synth
```

## Hosting ($0 free plan — prepared, not yet deployed)

The active plan hosts the frontend on **Cloudflare Pages (free)** and the
existing Express API on a **Render Free Web Service**, while the DynamoDB table,
Streams, Detection Lambda, EventBridge bus, and CloudWatch logs in ap-south-2
stay exactly as they are. Verified free-tier limits, the exact build/start
commands, the least-privilege DynamoDB access design (keys live only in Render's
dashboard, never in git), deployment steps, and the cost/security checklist are
in `docs/deployment-free.md`. Deploy only after connecting GitHub and approving
the one IAM identity step described there. The earlier AWS-native proposal
(Amplify + HTTP API + Lambda) is on hold in `docs/deployment.md` and will not be
deployed unless explicitly re-approved. Lambda Function URLs are unavailable in
ap-south-2 (verified 2026-10-21).

## Layout

```text
apps/web/                 React + TypeScript frontend
apps/api/                 Node.js + Express + TypeScript API backed by DynamoDB
packages/sensor-simulator TypeScript periodic sensor producer
ml/                       Dependency-light Python model package
infra/                    AWS CDK TypeScript DynamoDB table stack
docs/                     Project notes
```

The API stores sensor, reading, zone, incident, and response-team items in one DynamoDB table. Readings receive a seven-day TTL; DynamoDB TTL deletion is asynchronous. The table's GSI1 supports sensor lookup by zone, active incidents, and incidents by zone.

## Phase 3: Stream Detection

### Implemented

The existing DynamoDB table's `NEW_AND_OLD_IMAGES` stream invokes `AstraGridDetectionLambda` for `INSERT` and `MODIFY` records in batches of 10. The Lambda reads `NEW_IMAGE`, filters for `entityType=READING`, and applies deterministic rules; it does not perform ML or AI predictions. Existing API critical thresholds are used for water level (90 cm), rainfall (80 mm/h), traffic (90%), and air quality (150 AQI). Temperature (40 C) and power load (90%) limits extend rule coverage to those simulator types.

Detected anomalies are published to the `astragrid-events` EventBridge bus:

```json
{
	"source": "astragrid.sensor",
	"detail-type": "SensorAnomalyDetected",
	"detail": {
		"sensorId": "katpadi-water-01",
		"zone": "KATPADI",
		"sensorType": "WATER_LEVEL",
		"value": 93,
		"timestamp": "2026-10-11T10:00:00.000Z",
		"detected": true,
		"riskLevel": "HIGH",
		"reason": "Water level exceeded critical threshold",
		"streamEventId": "DynamoDB-stream-event-id"
	}
}
```

The event's sensor values come from the stream image. `streamEventId` is included for correlation and downstream deduplication. DynamoDB Streams and EventBridge provide at-least-once delivery, so a retry can publish a duplicate; there is no separate idempotency database in this phase. A failed EventBridge publish is logged and thrown so Lambda retries the stream batch. Malformed stream images are logged and skipped. Lambda logs have one-month retention, and a matching EventBridge rule writes anomaly events to `/aws/events/astragrid-anomalies` with the same retention.

The Lambda execution role receives only DynamoDB stream read actions for the operational table, `events:PutEvents` for `astragrid-events`, and CloudWatch Logs write actions for its managed log group. The EventBridge rule's CloudWatch Logs delivery permission is scoped to its target log group.

To build and synthesize without deploying:

```sh
npm run typecheck
npm run build
cd infra
npx cdk synth
```

After review, deploy the existing stack (do not create another stack):

```sh
cd infra
npx cdk deploy AstraGridStack
```

For a live check, run the API and simulator, then confirm the Lambda invocation in `/aws/lambda/AstraGridDetectionLambda` and the published anomaly in `/aws/events/astragrid-anomalies` in `ap-south-2`. A simulator reading is not by itself proof of anomaly publication: observe a KATPADI water-level reading at or above 90 cm and verify the corresponding event in both log groups.

### Future

Live ML prediction integration, a validated production training dataset, probability calibration, Bedrock, SageMaker, Step Functions, SQS, SNS, and further automated response workflows are future work. The offline model package is not invoked by the Express API or stream Lambda. DynamoDB Streams are consumed only by the deterministic detection Lambda and EventBridge route in Phase 3.
