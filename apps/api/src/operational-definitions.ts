import type { ResponseTeam, SensorType, Zone } from "./models.js";

export const zoneDefinitions = [
  { id: "KATPADI", name: "Katpadi", area: "North Vellore", coordinates: "12.97° N, 79.14° E" },
  { id: "VELLORE_CENTRAL", name: "Vellore Central", area: "City centre", coordinates: "12.92° N, 79.13° E" },
  { id: "SATHUVACHARI", name: "Sathuvachari", area: "West Vellore", coordinates: "12.94° N, 79.08° E" },
  { id: "INDUSTRIAL_AREA", name: "Industrial Area", area: "South Vellore", coordinates: "12.88° N, 79.10° E" },
] as const satisfies readonly Zone[];

export type ZoneId = (typeof zoneDefinitions)[number]["id"];

export const sensorDefinitions = [
  { suffix: "water-01", type: "WATER_LEVEL", label: "River gauge", unit: "cm" },
  { suffix: "rain-01", type: "RAINFALL", label: "Rain gauge", unit: "mm/h" },
  { suffix: "traffic-01", type: "TRAFFIC", label: "Traffic flow", unit: "%" },
  { suffix: "air-01", type: "AIR_QUALITY", label: "Air quality", unit: "AQI" },
  { suffix: "temp-01", type: "TEMPERATURE", label: "Ambient temperature", unit: "°C" },
  { suffix: "power-01", type: "POWER", label: "Grid load", unit: "%" },
] as const satisfies readonly { suffix: string; type: SensorType; label: string; unit: string }[];

export const responseTeamDefinitions = [
  { id: "team-north-01", name: "North Response", zoneId: "KATPADI", status: "STANDBY" },
  { id: "team-central-01", name: "Central Response", zoneId: "VELLORE_CENTRAL", status: "ON_PATROL" },
  { id: "team-west-01", name: "West Response", zoneId: "SATHUVACHARI", status: "STANDBY" },
  { id: "team-south-01", name: "South Response", zoneId: "INDUSTRIAL_AREA", status: "ON_PATROL" },
] as const satisfies readonly ResponseTeam[];

export function getSensorId(zoneId: ZoneId, suffix: string): string {
  return `${zoneId.toLowerCase()}-${suffix}`;
}

export function getInitialSensorValue(zoneId: ZoneId, type: SensorType): number {
  switch (type) {
    case "WATER_LEVEL":
      return zoneId === "KATPADI" ? 86 : zoneId === "SATHUVACHARI" ? 58 : 42;
    case "RAINFALL":
      return zoneId === "KATPADI" ? 72 : zoneId === "SATHUVACHARI" ? 34 : 18;
    case "TRAFFIC":
      return zoneId === "VELLORE_CENTRAL" ? 68 : 34;
    case "AIR_QUALITY":
      return zoneId === "INDUSTRIAL_AREA" ? 118 : 54;
    case "TEMPERATURE":
      return 31;
    case "POWER":
      return zoneId === "INDUSTRIAL_AREA" ? 78 : 61;
  }
}