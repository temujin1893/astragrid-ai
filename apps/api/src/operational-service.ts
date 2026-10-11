import type { Dashboard, Incident, RiskLevel, Sensor, SensorReadingInput, SensorType, ZoneSummary } from "./models.js";
import {
  getInitialSensorValue,
  getSensorId,
  responseTeamDefinitions,
  sensorDefinitions,
  zoneDefinitions,
  type ZoneId,
} from "./operational-definitions.js";
import { DynamoDbOperationalRepository, makeIncidentId } from "./dynamodb-operational-repository.js";

const staleAfterMs = 15_000;

export class InvalidReadingError extends Error {
  constructor() {
    super("Reading must match a registered sensor and include a valid non-negative value and timestamp.");
    this.name = "InvalidReadingError";
  }
}

export class OperationalService {
  private initialization?: Promise<void>;

  constructor(private readonly repository: DynamoDbOperationalRepository) {}

  ensureInitialized(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeOperationalData().catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  async getSensor(sensorId: string): Promise<Sensor | undefined> {
    return this.repository.getSensor(sensorId);
  }

  async getSensors(): Promise<Sensor[]> {
    return this.repository.getSensors();
  }

  async getZones(): Promise<ZoneSummary[]> {
    const [zones, sensors, incidents] = await Promise.all([
      this.repository.getZones(),
      this.repository.getSensors(),
      this.repository.getIncidents(),
    ]);
    return this.buildZoneSummaries(zones, sensors, incidents);
  }

  async getIncidents(): Promise<Incident[]> {
    return this.repository.getIncidents();
  }

  async getDashboardData(): Promise<Dashboard> {
    const [sensors, incidents, activeIncidents, responseTeams, zones] = await Promise.all([
      this.repository.getSensors(),
      this.repository.getIncidents(),
      this.repository.getActiveIncidents(),
      this.repository.getTeams(),
      this.repository.getZones(),
    ]);
    const zoneSummaries = this.buildZoneSummaries(zones, sensors, incidents);
    const riskOrder: Record<RiskLevel, number> = { NORMAL: 0, ELEVATED: 1, HIGH: 2 };
    const cityRiskLevel = zoneSummaries.reduce<RiskLevel>(
      (highest, zone) => riskOrder[zone.riskLevel] > riskOrder[highest] ? zone.riskLevel : highest,
      "NORMAL",
    );
    const onlineSensorCount = sensors.filter((sensor) => sensor.status === "ONLINE").length;
    const updatedAt = sensors.reduce(
      (latest, sensor) => Date.parse(sensor.recordedAt) > Date.parse(latest) ? sensor.recordedAt : latest,
      new Date(0).toISOString(),
    );

    return {
      city: {
        name: "Vellore",
        status: cityRiskLevel === "HIGH"
          ? "ACTION_REQUIRED"
          : onlineSensorCount < sensors.length ? "DEGRADED" : "OPERATIONAL",
        riskLevel: cityRiskLevel,
      },
      summary: {
        totalSensors: sensors.length,
        onlineSensors: onlineSensorCount,
        activeIncidents: activeIncidents.length,
        highRiskZones: zoneSummaries.filter((zone) => zone.riskLevel === "HIGH").length,
        responseTeams: responseTeams.length,
      },
      zones: zoneSummaries,
      sensors: [...sensors].sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt)),
      incidents: [...incidents]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 12),
      responseTeams,
      updatedAt,
    };
  }

  async recordReading(reading: SensorReadingInput): Promise<Sensor> {
    const current = await this.repository.getSensorState(reading.sensorId);
    if (!current || current.sensor.zoneId !== reading.zoneId || current.sensor.type !== reading.type) {
      throw new InvalidReadingError();
    }
    const saved = await this.repository.saveSensorReading(reading, current);
    await this.updateIncident(saved.sensor, saved.activeIncidentId);
    return saved.sensor;
  }

  private async initializeOperationalData(): Promise<void> {
    const now = new Date().toISOString();
    const zoneWrites = zoneDefinitions.map((zone) => this.repository.putIfMissing({
      PK: `ZONE#${zone.id}`,
      SK: "METADATA",
      entityType: "ZONE",
      zoneId: zone.id,
      name: zone.name,
      area: zone.area,
      coordinates: zone.coordinates,
    }));
    const teamWrites = responseTeamDefinitions.map((team) => this.repository.putIfMissing({
      PK: `TEAM#${team.id}`,
      SK: "METADATA",
      entityType: "TEAM",
      teamId: team.id,
      name: team.name,
      zoneId: team.zoneId,
      status: team.status,
    }));
    const sensorWrites = zoneDefinitions.flatMap((zone) => sensorDefinitions.map(async (definition) => {
      const sensorId = getSensorId(zone.id, definition.suffix);
      const initialValue = getInitialSensorValue(zone.id, definition.type);
      const created = await this.repository.putIfMissing({
        PK: `SENSOR#${sensorId}`,
        SK: "METADATA",
        entityType: "SENSOR",
        sensorId,
        zoneId: zone.id,
        sensorType: definition.type,
        label: definition.label,
        unit: definition.unit,
        latestValue: initialValue,
        latestRecordedAt: now,
        GSI1PK: `ZONE#${zone.id}`,
        GSI1SK: `SENSOR#${sensorId}`,
      });
      if (created) {
        await this.repository.saveSensorReading({
          sensorId,
          zoneId: zone.id,
          type: definition.type,
          value: initialValue,
          recordedAt: now,
        });
      }
    }));
    await Promise.all([...zoneWrites, ...teamWrites, ...sensorWrites]);
  }

  private buildZoneSummaries(
    zones: readonly { id: string; name: string; area: string; coordinates: string }[],
    sensors: readonly Sensor[],
    incidents: readonly Incident[],
  ): ZoneSummary[] {
    const now = Date.now();
    return zones.map((zone) => {
      const zoneSensors = sensors.filter((sensor) => sensor.zoneId === zone.id);
      const activeIncidents = incidents.filter((incident) =>
        incident.zoneId === zone.id && incident.status === "ACTIVE");
      const risk = this.calculateZoneRisk(zone.id as ZoneId, zoneSensors, activeIncidents.length > 0);
      return {
        ...zone,
        sensorCount: zoneSensors.length,
        onlineSensorCount: zoneSensors.filter((sensor) => now - Date.parse(sensor.recordedAt) <= staleAfterMs).length,
        activeIncidentCount: activeIncidents.length,
        riskLevel: risk.level,
        riskScore: risk.score,
      };
    });
  }

  private calculateZoneRisk(
    zoneId: ZoneId,
    sensors: readonly Sensor[],
    hasActiveIncident: boolean,
  ): { level: RiskLevel; score: number } {
    let score = 0;
    for (const sensor of sensors) {
      if (sensor.zoneId !== zoneId) continue;
      const threshold = riskThreshold(sensor.type);
      if (threshold !== undefined) {
        score = Math.max(score, Math.min(100, Math.round((sensor.value / threshold) * 100)));
      }
    }
    return {
      level: hasActiveIncident ? "HIGH" : score >= 70 ? "ELEVATED" : "NORMAL",
      score: hasActiveIncident ? 100 : score,
    };
  }

  private async updateIncident(sensor: Sensor, activeIncidentId?: string): Promise<void> {
    const threshold = riskThreshold(sensor.type);
    if (threshold === undefined) return;

    let active = activeIncidentId ? await this.repository.getIncident(activeIncidentId) : undefined;
    if (active?.status !== "ACTIVE") {
      if (activeIncidentId) await this.repository.clearActiveIncident(sensor.sensorId, activeIncidentId);
      active = undefined;
    }

    if (sensor.value > threshold) {
      if (active) {
        active.updatedAt = sensor.recordedAt;
        active.description = `${sensor.label} is reporting ${sensor.value} ${sensor.unit}, above the ${threshold} ${sensor.unit} threshold.`;
        await this.repository.updateIncident(active);
        return;
      }

      const incident: Incident = {
        id: makeIncidentId(),
        sensorId: sensor.sensorId,
        zoneId: sensor.zoneId,
        type: sensor.type,
        title: `${riskTitle(sensor.type)} detected`,
        description: `${sensor.label} is reporting ${sensor.value} ${sensor.unit}, above the ${threshold} ${sensor.unit} threshold.`,
        severity: "HIGH",
        status: "ACTIVE",
        detectedAt: sensor.recordedAt,
        updatedAt: sensor.recordedAt,
      };
      await this.repository.createIncident(incident);
      const competingIncidentId = await this.repository.attachActiveIncident(sensor.sensorId, incident.id);
      if (competingIncidentId) {
        await this.repository.updateIncident({
          ...incident,
          status: "RESOLVED",
          description: "Superseded by a concurrent active incident for this sensor.",
          updatedAt: new Date().toISOString(),
        });
        const competingIncident = await this.repository.getIncident(competingIncidentId);
        if (competingIncident?.status === "ACTIVE") {
          competingIncident.updatedAt = sensor.recordedAt;
          competingIncident.description = incident.description;
          await this.repository.updateIncident(competingIncident);
        }
      }
      return;
    }

    if (active) {
      active.status = "RESOLVED";
      active.updatedAt = sensor.recordedAt;
      active.description = "Reading has returned below the alert threshold.";
      await this.repository.updateIncident(active);
      await this.repository.clearActiveIncident(sensor.sensorId, active.id);
    }
  }
}

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

export function isSupportedSensorType(value: string): value is SensorType {
  return sensorDefinitions.some((sensor) => sensor.type === value);
}

export function isSupportedZone(value: string): value is ZoneId {
  return zoneDefinitions.some((zone) => zone.id === value);
}