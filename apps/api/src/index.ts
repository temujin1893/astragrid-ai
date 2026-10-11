import cors from "cors";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT ?? 3001);
const staleAfterMs = 15_000;

const zoneDefinitions = [
  { id: "KATPADI", name: "Katpadi", area: "North Vellore", coordinates: "12.97° N, 79.14° E" },
  { id: "VELLORE_CENTRAL", name: "Vellore Central", area: "City centre", coordinates: "12.92° N, 79.13° E" },
  { id: "SATHUVACHARI", name: "Sathuvachari", area: "West Vellore", coordinates: "12.94° N, 79.08° E" },
  { id: "INDUSTRIAL_AREA", name: "Industrial Area", area: "South Vellore", coordinates: "12.88° N, 79.10° E" },
] as const;

const sensorDefinitions = [
  { suffix: "water-01", type: "WATER_LEVEL", label: "River gauge", unit: "cm" },
  { suffix: "rain-01", type: "RAINFALL", label: "Rain gauge", unit: "mm/h" },
  { suffix: "traffic-01", type: "TRAFFIC", label: "Traffic flow", unit: "%" },
  { suffix: "air-01", type: "AIR_QUALITY", label: "Air quality", unit: "AQI" },
  { suffix: "temp-01", type: "TEMPERATURE", label: "Ambient temperature", unit: "°C" },
  { suffix: "power-01", type: "POWER", label: "Grid load", unit: "%" },
] as const;

type ZoneId = (typeof zoneDefinitions)[number]["id"];
type SensorType = (typeof sensorDefinitions)[number]["type"];
type Severity = "HIGH";
type RiskLevel = "NORMAL" | "ELEVATED" | "HIGH";
type SensorStatus = "ONLINE" | "OFFLINE";

interface SensorReading {
  sensorId: string;
  zoneId: ZoneId;
  type: SensorType;
  label: string;
  value: number;
  unit: string;
  status: SensorStatus;
  recordedAt: string;
}

interface Incident {
  id: string;
  sensorId: string;
  zoneId: ZoneId;
  type: SensorType;
  title: string;
  description: string;
  severity: Severity;
  status: "ACTIVE" | "RESOLVED";
  detectedAt: string;
  updatedAt: string;
}

const sensors = new Map<string, SensorReading>();
const incidents = new Map<string, Incident>();
const activeIncidentIds = new Map<string, string>();

function riskThreshold(type: SensorType): number | undefined {
  switch (type) {
    case "WATER_LEVEL": return 90;
    case "RAINFALL": return 80;
    case "TRAFFIC": return 90;
    case "AIR_QUALITY": return 150;
    default: return undefined;
  }
}

function riskTitle(type: SensorType): string {
  switch (type) {
    case "WATER_LEVEL": return "Flood risk";
    case "RAINFALL": return "Heavy rainfall";
    case "TRAFFIC": return "Traffic disruption";
    case "AIR_QUALITY": return "Air quality alert";
    default: return "Sensor alert";
  }
}

function updateIncident(reading: SensorReading): void {
  const threshold = riskThreshold(reading.type);
  if (threshold === undefined) return;

  const key = `${reading.sensorId}:${reading.type}`;
  const existingId = activeIncidentIds.get(key);
  const existing = existingId ? incidents.get(existingId) : undefined;
  const now = reading.recordedAt;

  if (reading.value > threshold) {
    if (existing?.status === "ACTIVE") {
      existing.updatedAt = now;
      existing.description = `${reading.label} is reporting ${reading.value} ${reading.unit}, above the ${threshold} ${reading.unit} threshold.`;
      return;
    }

    const incident: Incident = {
      id: randomUUID(),
      sensorId: reading.sensorId,
      zoneId: reading.zoneId,
      type: reading.type,
      title: `${riskTitle(reading.type)} detected`,
      description: `${reading.label} is reporting ${reading.value} ${reading.unit}, above the ${threshold} ${reading.unit} threshold.`,
      severity: "HIGH",
      status: "ACTIVE",
      detectedAt: now,
      updatedAt: now,
    };
    incidents.set(incident.id, incident);
    activeIncidentIds.set(key, incident.id);
    while (incidents.size > 100) {
      const oldestResolved = [...incidents.values()].find((item) => item.status === "RESOLVED");
      if (!oldestResolved) break;
      incidents.delete(oldestResolved.id);
    }
    return;
  }

  if (existing?.status === "ACTIVE") {
    existing.status = "RESOLVED";
    existing.updatedAt = now;
    existing.description = "Reading has returned below the alert threshold.";
    activeIncidentIds.delete(key);
  }
}

function seedSensors(): void {
  for (const zone of zoneDefinitions) {
    for (const definition of sensorDefinitions) {
      let value: number;
      switch (definition.type) {
        case "WATER_LEVEL":
          value = zone.id === "KATPADI" ? 86 : zone.id === "SATHUVACHARI" ? 58 : 42;
          break;
        case "RAINFALL":
          value = zone.id === "KATPADI" ? 72 : zone.id === "SATHUVACHARI" ? 34 : 18;
          break;
        case "TRAFFIC":
          value = zone.id === "VELLORE_CENTRAL" ? 68 : 34;
          break;
        case "AIR_QUALITY":
          value = zone.id === "INDUSTRIAL_AREA" ? 118 : 54;
          break;
        case "TEMPERATURE":
          value = 31;
          break;
        case "POWER":
          value = zone.id === "INDUSTRIAL_AREA" ? 78 : 61;
          break;
      }

      const reading: SensorReading = {
        sensorId: `${zone.id.toLowerCase()}-${definition.suffix}`,
        zoneId: zone.id,
        type: definition.type,
        label: definition.label,
        value,
        unit: definition.unit,
        status: "ONLINE",
        recordedAt: new Date().toISOString(),
      };
      sensors.set(reading.sensorId, reading);
      updateIncident(reading);
    }
  }
}

function calculateZoneRisk(zoneId: ZoneId): { level: RiskLevel; score: number } {
  const readings = [...sensors.values()].filter((sensor) => sensor.zoneId === zoneId);
  let score = 0;
  for (const reading of readings) {
    const threshold = riskThreshold(reading.type);
    if (threshold !== undefined) score = Math.max(score, Math.min(100, Math.round((reading.value / threshold) * 100)));
  }
  const hasActiveIncident = [...incidents.values()].some(
    (incident) => incident.zoneId === zoneId && incident.status === "ACTIVE",
  );
  return {
    level: hasActiveIncident ? "HIGH" : score >= 70 ? "ELEVATED" : "NORMAL",
    score: hasActiveIncident ? 100 : score,
  };
}

function sendData<T>(response: Response, data: T, status = 200): void {
  response.status(status).json({ data });
}

function isZoneId(value: unknown): value is ZoneId {
  return typeof value === "string" && zoneDefinitions.some((zone) => zone.id === value);
}

function isSensorType(value: unknown): value is SensorType {
  return typeof value === "string" && sensorDefinitions.some((sensor) => sensor.type === value);
}

seedSensors();

const app = express();
app.use(cors());
app.use(express.json({ limit: "16kb" }));

app.get("/api/health", (_request, response) => {
  sendData(response, { status: "ok", service: "astragrid-api", timestamp: new Date().toISOString() });
});

app.get("/api/sensors", (_request, response) => {
  const now = Date.now();
  const readings = [...sensors.values()]
    .map((sensor) => ({
      ...sensor,
      status: now - Date.parse(sensor.recordedAt) <= staleAfterMs ? "ONLINE" as const : "OFFLINE" as const,
    }))
    .sort((left, right) => left.zoneId.localeCompare(right.zoneId) || left.type.localeCompare(right.type));
  sendData(response, readings);
});

app.get("/api/sensors/:sensorId", (request, response) => {
  const sensor = sensors.get(request.params.sensorId);
  if (!sensor) {
    response.status(404).json({ error: { code: "SENSOR_NOT_FOUND", message: "No sensor exists with that ID." } });
    return;
  }
  const status = Date.now() - Date.parse(sensor.recordedAt) <= staleAfterMs ? "ONLINE" : "OFFLINE";
  sendData(response, { ...sensor, status });
});

app.post("/api/readings", (request, response) => {
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null) {
    response.status(400).json({ error: { code: "INVALID_READING", message: "A sensor reading object is required." } });
    return;
  }

  const candidate = body as Record<string, unknown>;
  const sensorId = candidate.sensorId;
  const zoneId = candidate.zoneId;
  const type = candidate.type;
  const value = candidate.value;
  const recordedAt = candidate.recordedAt;
  const sensorDefinition = sensorDefinitions.find((sensor) => sensor.type === type);
  const existing = typeof sensorId === "string" ? sensors.get(sensorId) : undefined;

  if (
    typeof sensorId !== "string" ||
    !isZoneId(zoneId) ||
    !isSensorType(type) ||
    !sensorDefinition ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    typeof recordedAt !== "string" ||
    !Number.isFinite(Date.parse(recordedAt)) ||
    !existing ||
    existing.zoneId !== zoneId ||
    existing.type !== type
  ) {
    response.status(400).json({
      error: { code: "INVALID_READING", message: "Reading must match a registered sensor and include a valid non-negative value and timestamp." },
    });
    return;
  }

  const reading: SensorReading = {
    sensorId,
    zoneId,
    type,
    label: sensorDefinition.label,
    value,
    unit: sensorDefinition.unit,
    status: "ONLINE",
    recordedAt,
  };
  sensors.set(sensorId, reading);
  updateIncident(reading);
  sendData(response, reading, 202);
});

app.get("/api/zones", (_request, response) => {
  const zones = zoneDefinitions.map((zone) => {
    const zoneSensors = [...sensors.values()].filter((sensor) => sensor.zoneId === zone.id);
    const risk = calculateZoneRisk(zone.id);
    return {
      ...zone,
      sensorCount: zoneSensors.length,
      onlineSensorCount: zoneSensors.filter((sensor) => Date.now() - Date.parse(sensor.recordedAt) <= staleAfterMs).length,
      activeIncidentCount: [...incidents.values()].filter(
        (incident) => incident.zoneId === zone.id && incident.status === "ACTIVE",
      ).length,
      riskLevel: risk.level,
      riskScore: risk.score,
    };
  });
  sendData(response, zones);
});

app.get("/api/incidents", (_request, response) => {
  const result = [...incidents.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 100);
  sendData(response, result);
});

app.get("/api/dashboard", (_request, response) => {
  const allSensors = [...sensors.values()];
  const allIncidents = [...incidents.values()];
  const activeIncidents = allIncidents.filter((incident) => incident.status === "ACTIVE");
  const zones = zoneDefinitions.map((zone) => {
    const zoneSensors = allSensors.filter((sensor) => sensor.zoneId === zone.id);
    const risk = calculateZoneRisk(zone.id);
    return {
      ...zone,
      sensorCount: zoneSensors.length,
      onlineSensorCount: zoneSensors.filter((sensor) => Date.now() - Date.parse(sensor.recordedAt) <= staleAfterMs).length,
      activeIncidentCount: activeIncidents.filter((incident) => incident.zoneId === zone.id).length,
      riskLevel: risk.level,
      riskScore: risk.score,
    };
  });
  const activeResponseTeams = [
    { id: "team-north-01", name: "North Response", zoneId: "KATPADI", status: "STANDBY" },
    { id: "team-central-01", name: "Central Response", zoneId: "VELLORE_CENTRAL", status: "ON_PATROL" },
    { id: "team-west-01", name: "West Response", zoneId: "SATHUVACHARI", status: "STANDBY" },
    { id: "team-south-01", name: "South Response", zoneId: "INDUSTRIAL_AREA", status: "ON_PATROL" },
  ];
  const riskOrder: Record<RiskLevel, number> = { NORMAL: 0, ELEVATED: 1, HIGH: 2 };
  const cityRiskLevel = zones.reduce<RiskLevel>(
    (highest, zone) => riskOrder[zone.riskLevel] > riskOrder[highest] ? zone.riskLevel : highest,
    "NORMAL",
  );
  const onlineSensorCount = allSensors.filter(
    (sensor) => Date.now() - Date.parse(sensor.recordedAt) <= staleAfterMs,
  ).length;
  const updatedAt = allSensors.reduce(
    (latest, sensor) => Date.parse(sensor.recordedAt) > Date.parse(latest) ? sensor.recordedAt : latest,
    new Date(0).toISOString(),
  );

  sendData(response, {
    city: {
      name: "Vellore",
      status: cityRiskLevel === "HIGH"
        ? "ACTION_REQUIRED"
        : onlineSensorCount < allSensors.length ? "DEGRADED" : "OPERATIONAL",
      riskLevel: cityRiskLevel,
    },
    summary: {
      totalSensors: allSensors.length,
      onlineSensors: onlineSensorCount,
      activeIncidents: activeIncidents.length,
      highRiskZones: zones.filter((zone) => zone.riskLevel === "HIGH").length,
      responseTeams: activeResponseTeams.length,
    },
    zones,
    sensors: allSensors
      .map((sensor) => ({
        ...sensor,
        status: Date.now() - Date.parse(sensor.recordedAt) <= staleAfterMs ? "ONLINE" as const : "OFFLINE" as const,
      }))
      .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt)),
    incidents: allIncidents.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, 12),
    responseTeams: activeResponseTeams,
    updatedAt,
  });
});

app.use((_request: Request, response: Response) => {
  response.status(404).json({ error: { code: "NOT_FOUND", message: "The requested endpoint does not exist." } });
});

const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.parse.failed") {
    response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body must contain valid JSON." } });
    return;
  }
  console.error("API request failed:", error);
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected API error occurred." } });
};
app.use(handleError);

app.listen(port, () => {
  console.log(`AstraGrid API listening on http://localhost:${port}`);
});
