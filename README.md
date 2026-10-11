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

The Python model is not part of the API persistence pipeline. To run the model placeholder separately:

```sh
python -m venv .venv
# Activate the virtual environment, then:
python -m pip install -e ./ml
python -m astra_model
```

On Windows, activate with `.venv\\Scripts\\Activate.ps1`; on macOS or Linux, use `source .venv/bin/activate`.

## Checks

```sh
npm run typecheck
npm run build
```

To synthesize the CDK app locally (no deployment):

```sh
npm run synth
```

## Layout

```text
apps/web/                 React + TypeScript frontend
apps/api/                 Node.js + Express + TypeScript API backed by DynamoDB
packages/sensor-simulator TypeScript periodic sensor producer
ml/                       Dependency-light Python model package
infra/                    AWS CDK TypeScript DynamoDB table stack
docs/                     Project notes
```

The API stores sensor, reading, zone, incident, and response-team items in one DynamoDB table. Readings receive a seven-day TTL; DynamoDB TTL deletion is asynchronous. The table's GSI1 supports sensor lookup by zone, active incidents, and incidents by zone. DynamoDB Streams are enabled for a later phase, but no stream consumer is included yet. Lambda, API Gateway, EventBridge, Step Functions, and Amazon Bedrock remain future work.