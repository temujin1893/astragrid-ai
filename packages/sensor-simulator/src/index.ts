const apiUrl = (process.env.API_URL ?? "http://localhost:3001").replace(/\/$/, "");
const intervalMs = Number(process.env.SIMULATOR_INTERVAL_MS ?? 3_000);

const zones = ["KATPADI", "VELLORE_CENTRAL", "SATHUVACHARI", "INDUSTRIAL_AREA"] as const;
type ZoneId = (typeof zones)[number];
type SensorType = "WATER_LEVEL" | "RAINFALL" | "TRAFFIC" | "AIR_QUALITY" | "TEMPERATURE" | "POWER";

interface SensorDefinition {
  suffix: string;
  type: SensorType;
  min: number;
  max: number;
}

interface Reading {
  sensorId: string;
  zoneId: ZoneId;
  type: SensorType;
  value: number;
  recordedAt: string;
}

const definitions: SensorDefinition[] = [
  { suffix: "water-01", type: "WATER_LEVEL", min: 28, max: 62 },
  { suffix: "rain-01", type: "RAINFALL", min: 8, max: 42 },
  { suffix: "traffic-01", type: "TRAFFIC", min: 25, max: 78 },
  { suffix: "air-01", type: "AIR_QUALITY", min: 35, max: 115 },
  { suffix: "temp-01", type: "TEMPERATURE", min: 27, max: 38 },
  { suffix: "power-01", type: "POWER", min: 45, max: 84 },
];

const zoneOffset: Record<ZoneId, Partial<Record<SensorType, number>>> = {
  KATPADI: { WATER_LEVEL: 25, RAINFALL: 34 },
  VELLORE_CENTRAL: { TRAFFIC: 8 },
  SATHUVACHARI: { WATER_LEVEL: 10, RAINFALL: 8 },
  INDUSTRIAL_AREA: { AIR_QUALITY: 26, POWER: 12 },
};

const alertValue: Partial<Record<SensorType, number>> = {
  WATER_LEVEL: 96,
  RAINFALL: 89,
  TRAFFIC: 97,
  AIR_QUALITY: 178,
};

if (!Number.isFinite(intervalMs) || intervalMs < 500) {
  throw new Error("SIMULATOR_INTERVAL_MS must be a number of at least 500 milliseconds.");
}

let cycle = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildReadings(): Reading[] {
  cycle += 1;
  const recordedAt = new Date().toISOString();
  return zones.flatMap((zoneId) =>
    definitions.map((definition) => {
      const range = definition.max - definition.min;
      const midpoint = (definition.min + definition.max) / 2;
      const offset = zoneOffset[zoneId][definition.type] ?? 0;
      let value = clamp(midpoint + offset + (Math.random() - 0.5) * range * 0.45, definition.min, definition.max);

      if (zoneId === "KATPADI" && definition.type === "WATER_LEVEL") {
        value = 84 + Math.min(cycle * 1.25, 14) + (Math.random() - 0.5) * 2;
      } else if (zoneId === "KATPADI" && definition.type === "RAINFALL") {
        value = 70 + Math.min(cycle * 2, 22) + (Math.random() - 0.5) * 4;
      } else if (alertValue[definition.type] !== undefined && Math.random() < 0.018) {
        value = alertValue[definition.type] ?? value;
      }

      return {
        sensorId: `${zoneId.toLowerCase()}-${definition.suffix}`,
        zoneId,
        type: definition.type,
        value: Number(value.toFixed(definition.type === "TEMPERATURE" ? 1 : 0)),
        recordedAt,
      };
    }),
  );
}

async function publishReadings(): Promise<void> {
  const readings = buildReadings();
  const results = await Promise.allSettled(
    readings.map(async (reading) => {
      const response = await fetch(`${apiUrl}/api/readings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reading),
      });
      if (!response.ok) {
        throw new Error(`${reading.sensorId}: API returned ${response.status} ${await response.text()}`);
      }
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    for (const failure of failures) {
      if (failure.status === "rejected") console.error("Unable to publish sensor reading:", failure.reason);
    }
    return;
  }
  console.log(`Published ${readings.length} readings for cycle ${cycle} at ${new Date().toLocaleTimeString()}`);
}

console.log(`Sensor simulator publishing to ${apiUrl} every ${intervalMs} ms.`);
void publishReadings();
setInterval(() => void publishReadings(), intervalMs);
