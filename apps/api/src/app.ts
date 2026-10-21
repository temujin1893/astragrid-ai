import "dotenv/config";
import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { SensorReadingInput } from "./models.js";
import { DynamoDbOperationalRepository } from "./dynamodb-operational-repository.js";
import { InvalidReadingError, isSupportedSensorType, isSupportedZone, OperationalService } from "./operational-service.js";

// Comma-separated list of allowed browser origins. In production this must be
// the deployed frontend origin(s); it never needs an AWS credential.
export function getAllowedOrigins(raw: string | undefined = process.env.ALLOWED_ORIGINS): string[] {
  return (raw ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function sendData<T>(response: Response, data: T, status = 200): void {
  response.status(status).json({ data });
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDynamoDbFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if ("$metadata" in error) return true;
  return typeof error.code === "string" && ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(error.code);
}

// Builds the Express application shared by the local server (index.ts) and the
// AWS Lambda entry point (lambda.ts), so both run the exact same routes, CORS
// policy, request validation, and error handling. Called once per process:
// locally at startup, on Lambda once per cold start and reused when warm.
export function createApp(): express.Express {
  const repository = new DynamoDbOperationalRepository();
  const operationalService = new OperationalService(repository);
  const allowedOrigins = getAllowedOrigins();

  const app = express();
  app.use(cors({
    origin(origin, callback) {
      // Allow non-browser callers (curl, the simulator) that send no Origin header.
      // Only the configured frontend origins are allowed for browser requests.
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.includes(origin.replace(/\/$/, "")));
    },
  }));
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/health", (_request, response) => {
    sendData(response, { status: "ok", service: "astragrid-api", timestamp: new Date().toISOString() });
  });

  app.get("/api/sensors", asyncRoute(async (_request, response) => {
    await operationalService.ensureInitialized();
    sendData(response, await operationalService.getSensors());
  }));

  app.get("/api/sensors/:sensorId", asyncRoute(async (request, response) => {
    await operationalService.ensureInitialized();
    const sensor = await operationalService.getSensor(request.params.sensorId);
    if (!sensor) {
      response.status(404).json({ error: { code: "SENSOR_NOT_FOUND", message: "No sensor exists with that ID." } });
      return;
    }
    sendData(response, sensor);
  }));

  app.post("/api/readings", asyncRoute(async (request, response) => {
    const body: unknown = request.body;
    if (!isRecord(body)) {
      response.status(400).json({ error: { code: "INVALID_READING", message: "A sensor reading object is required." } });
      return;
    }
    const { sensorId, zoneId, type, value, recordedAt } = body;
    if (
      typeof sensorId !== "string" ||
      typeof zoneId !== "string" || !isSupportedZone(zoneId) ||
      typeof type !== "string" || !isSupportedSensorType(type) ||
      typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      typeof recordedAt !== "string" || !Number.isFinite(Date.parse(recordedAt))
    ) {
      response.status(400).json({
        error: {
          code: "INVALID_READING",
          message: "Reading must match a registered sensor and include a valid non-negative value and timestamp.",
        },
      });
      return;
    }

    await operationalService.ensureInitialized();
    const reading: SensorReadingInput = { sensorId, zoneId, type, value, recordedAt };
    const sensor = await operationalService.recordReading(reading);
    sendData(response, sensor, 202);
  }));

  app.get("/api/zones", asyncRoute(async (_request, response) => {
    await operationalService.ensureInitialized();
    sendData(response, await operationalService.getZones());
  }));

  app.get("/api/incidents", asyncRoute(async (_request, response) => {
    await operationalService.ensureInitialized();
    sendData(response, await operationalService.getIncidents());
  }));

  app.get("/api/dashboard", asyncRoute(async (_request, response) => {
    await operationalService.ensureInitialized();
    sendData(response, await operationalService.getDashboardData());
  }));

  app.use((_request: Request, response: Response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "The requested endpoint does not exist." } });
  });

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof InvalidReadingError) {
      response.status(400).json({ error: { code: "INVALID_READING", message: error.message } });
      return;
    }
    if (isRecord(error) && error.type === "entity.parse.failed") {
      response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body must contain valid JSON." } });
      return;
    }

    console.error("API request failed:", error);
    if (isDynamoDbFailure(error)) {
      response.status(503).json({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "Operational data is temporarily unavailable." },
      });
      return;
    }
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected API error occurred." } });
  };
  app.use(handleError);

  // Warm the seed data in the background; data routes await the same promise,
  // so a failure is retried on the next request instead of failing startup.
  void operationalService.ensureInitialized().catch((error: unknown) => {
    console.error("Operational data initialization failed; data routes will retry initialization:", error);
  });

  return app;
}
