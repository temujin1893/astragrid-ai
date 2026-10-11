export const riskLevels = ["NORMAL", "ELEVATED", "HIGH"] as const;
export type RiskLevel = (typeof riskLevels)[number];

export type SensorStatus = "ONLINE" | "OFFLINE";
export type IncidentStatus = "ACTIVE" | "RESOLVED";
export type SensorType =
  | "WATER_LEVEL"
  | "RAINFALL"
  | "TRAFFIC"
  | "AIR_QUALITY"
  | "TEMPERATURE"
  | "POWER";

export interface Zone {
  id: string;
  name: string;
  area: string;
  coordinates: string;
}

export interface ZoneSummary extends Zone {
  sensorCount: number;
  onlineSensorCount: number;
  activeIncidentCount: number;
  riskLevel: RiskLevel;
  riskScore: number;
}

export interface Sensor {
  sensorId: string;
  zoneId: string;
  type: SensorType;
  label: string;
  value: number;
  unit: string;
  status: SensorStatus;
  recordedAt: string;
}

export interface SensorReadingInput {
  sensorId: string;
  zoneId: string;
  type: SensorType;
  value: number;
  recordedAt: string;
}

export interface SensorReading extends SensorReadingInput {
  label: string;
  unit: string;
  expiresAt: number;
}

export interface Incident {
  id: string;
  sensorId: string;
  zoneId: string;
  type: SensorType;
  title: string;
  description: string;
  severity: "HIGH";
  status: IncidentStatus;
  detectedAt: string;
  updatedAt: string;
}

export interface ResponseTeam {
  id: string;
  name: string;
  zoneId: string;
  status: "STANDBY" | "ON_PATROL";
}

export interface Dashboard {
  city: {
    name: string;
    status: "OPERATIONAL" | "ACTION_REQUIRED" | "DEGRADED";
    riskLevel: RiskLevel;
  };
  summary: {
    totalSensors: number;
    onlineSensors: number;
    activeIncidents: number;
    highRiskZones: number;
    responseTeams: number;
  };
  zones: ZoneSummary[];
  sensors: Sensor[];
  incidents: Incident[];
  responseTeams: ResponseTeam[];
  updatedAt: string;
}