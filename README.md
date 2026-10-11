# AstraGrid AI

AstraGrid AI is a local smart-city monitoring and disaster response platform. The React dashboard polls a Node/Express API, and the sensor simulator posts live readings into the API's in-memory state.

This phase runs entirely on your machine. It does not connect to AWS, provision cloud resources, or require AWS credentials. Sensor data and incidents are held in memory and reset when the API restarts.

## Requirements

- Node.js 20 or newer and npm
- Python 3.10 or newer for the model package

## Install

From the repository root:

```sh
npm install
```

## Run locally

Start each process in a separate terminal from the repository root:

```sh
npm run dev:web
npm run dev:api
npm run dev:simulator
```

The dashboard is served at `http://localhost:5173`; the API listens at `http://localhost:3001`. The simulator publishes a reading for each sensor every three seconds. In particular, KATPADI water level and rainfall rise over time to demonstrate deterministic flood and rainfall incidents.

The API exposes:

- `GET /api/health`
- `GET /api/sensors` and `GET /api/sensors/:sensorId`
- `GET /api/zones`
- `GET /api/incidents`
- `GET /api/dashboard`

The simulator uses `API_URL` (default `http://localhost:3001`) and `SIMULATOR_INTERVAL_MS` (default `3000`) environment variables. The web app uses `VITE_API_URL` (default `http://localhost:3001`). The API port can be changed with `PORT` (default `3001`).

The simulator sends sensor readings to the local `POST /api/readings` ingestion endpoint. The API applies deterministic thresholds for flood, rainfall, traffic, and air quality incidents; no LLM or cloud service is used for risk calculation.

The Python model and empty CDK scaffold are not part of the Phase 1 local monitoring pipeline. To run the model placeholder separately:

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

To synthesize the empty CDK app locally (no deployment or AWS credentials required):

```sh
npm run synth
```

## Layout

```text
apps/web/                 React + TypeScript frontend
apps/api/                 Node.js + Express + TypeScript local API
packages/sensor-simulator TypeScript periodic sensor producer
ml/                       Dependency-light Python model package
infra/                    AWS CDK TypeScript scaffold (empty stack)
docs/                     Project notes
```

AWS integrations with DynamoDB, Lambda, EventBridge, Step Functions, Amazon Bedrock, and other cloud services are future work.