export type SensorType =
  | "WATER_LEVEL"
  | "RAINFALL"
  | "TRAFFIC"
  | "AIR_QUALITY"
  | "TEMPERATURE"
  | "POWER";

export interface SensorReadingEvent {
  sensorId: string;
  zone: string;
  sensorType: SensorType;
  value: number;
  timestamp: string;
}

export interface DetectedAnomaly {
  detected: true;
  riskLevel: "HIGH";
  reason: string;
}

interface Rule {
  threshold: number;
  reason: string;
}

const criticalRules: Record<SensorType, Rule> = {
  WATER_LEVEL: { threshold: 90, reason: "Water level exceeded critical threshold" },
  RAINFALL: { threshold: 80, reason: "Rainfall exceeded critical threshold" },
  TRAFFIC: { threshold: 90, reason: "Traffic flow exceeded critical threshold" },
  AIR_QUALITY: { threshold: 150, reason: "Air quality index exceeded critical threshold" },
  TEMPERATURE: { threshold: 40, reason: "Temperature exceeded critical threshold" },
  POWER: { threshold: 90, reason: "Power grid load exceeded critical threshold" },
};

const supportedSensorTypes = new Set<string>(Object.keys(criticalRules));

export function isSensorType(value: unknown): value is SensorType {
  return typeof value === "string" && supportedSensorTypes.has(value);
}

export function detectAnomaly(reading: SensorReadingEvent): DetectedAnomaly | undefined {
  const rule = criticalRules[reading.sensorType];
  return reading.value >= rule.threshold
    ? { detected: true, riskLevel: "HIGH", reason: rule.reason }
    : undefined;
}