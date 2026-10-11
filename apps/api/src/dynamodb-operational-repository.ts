import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Incident, ResponseTeam, Sensor, SensorReading, SensorReadingInput, SensorType, Zone } from "./models.js";
import { responseTeamDefinitions, sensorDefinitions, zoneDefinitions, type ZoneId } from "./operational-definitions.js";

const ttlSeconds = 7 * 24 * 60 * 60;
const sensorMetadataSortKey = "METADATA";
const incidentMetadataSortKey = "METADATA";
const entityKey = (entity: string, id: string) => `${entity}#${id}`;

export interface SensorState {
  sensor: Sensor;
  activeIncidentId?: string;
}

type PrimitiveItem = Record<string, string | number | boolean>;
type Item = Record<string, unknown>;

function isConditionalCheckFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "ConditionalCheckFailedException";
}

function asItem(value: unknown): Item | undefined {
  return typeof value === "object" && value !== null ? value as Item : undefined;
}

function mapSensor(item: Item): SensorState {
  const recordedAt = typeof item.latestRecordedAt === "string" ? item.latestRecordedAt : new Date(0).toISOString();
  const type = item.sensorType as SensorType;
  const definition = sensorDefinitions.find((sensor) => sensor.type === type);
  const age = Date.now() - Date.parse(recordedAt);
  return {
    sensor: {
      sensorId: String(item.sensorId),
      zoneId: String(item.zoneId),
      type,
      label: String(item.label),
      value: typeof item.latestValue === "number" ? item.latestValue : 0,
      unit: definition?.unit ?? String(item.unit ?? ""),
      status: Number.isFinite(age) && age <= 15_000 ? "ONLINE" : "OFFLINE",
      recordedAt,
    },
    activeIncidentId: typeof item.activeIncidentId === "string" ? item.activeIncidentId : undefined,
  };
}

function mapIncident(item: Item): Incident {
  return {
    id: String(item.incidentId),
    sensorId: String(item.sensorId),
    zoneId: String(item.zoneId),
    type: item.sensorType as SensorType,
    title: String(item.title),
    description: String(item.description),
    severity: "HIGH",
    status: item.status === "RESOLVED" ? "RESOLVED" : "ACTIVE",
    detectedAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

function mapZone(item: Item): Zone {
  return {
    id: String(item.zoneId),
    name: String(item.name),
    area: String(item.area),
    coordinates: String(item.coordinates),
  };
}

function mapTeam(item: Item): ResponseTeam {
  return {
    id: String(item.teamId),
    name: String(item.name),
    zoneId: String(item.zoneId),
    status: item.status === "ON_PATROL" ? "ON_PATROL" : "STANDBY",
  };
}

export class DynamoDbOperationalRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor() {
    const tableName = process.env.ASTRAGRID_TABLE_NAME;
    if (!tableName) {
      throw new Error("ASTRAGRID_TABLE_NAME must be set before starting the API.");
    }
    this.tableName = tableName;
    this.client = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-south-2" }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  }

  async putIfMissing(item: PrimitiveItem): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      }));
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async getSensorState(sensorId: string): Promise<SensorState | undefined> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: { ":pk": entityKey("SENSOR", sensorId), ":sk": sensorMetadataSortKey },
      Limit: 1,
    }));
    const item = asItem(result.Items?.[0]);
    return item ? mapSensor(item) : undefined;
  }

  async getSensor(sensorId: string): Promise<Sensor | undefined> {
    return (await this.getSensorState(sensorId))?.sensor;
  }

  async getSensors(): Promise<Sensor[]> {
    const results = await Promise.all(zoneDefinitions.map(async (zone) => {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sensorPrefix)",
        ExpressionAttributeValues: {
          ":pk": entityKey("ZONE", zone.id),
          ":sensorPrefix": "SENSOR#",
        },
      }));
      return (result.Items ?? []).flatMap((value) => {
        const item = asItem(value);
        return item ? [mapSensor(item).sensor] : [];
      });
    }));
    return results.flat().sort((left, right) =>
      left.zoneId.localeCompare(right.zoneId) || left.type.localeCompare(right.type));
  }

  async getRecentSensorReadings(sensorId: string, limit: number): Promise<SensorReading[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :readingPrefix)",
      ExpressionAttributeValues: {
        ":pk": entityKey("SENSOR", sensorId),
        ":readingPrefix": "READING#",
      },
      ScanIndexForward: false,
      Limit: Math.max(1, Math.floor(limit)),
    }));
    return (result.Items ?? []).flatMap((value) => {
      const item = asItem(value);
      if (!item) return [];
      return [{
        sensorId: String(item.sensorId),
        zoneId: String(item.zoneId),
        type: item.sensorType as SensorType,
        value: Number(item.value),
        recordedAt: String(item.timestamp),
        label: String(item.label),
        unit: String(item.unit),
        expiresAt: Number(item.expiresAt),
      }];
    });
  }

  async saveSensorReading(reading: SensorReadingInput, knownSensor?: SensorState): Promise<SensorState> {
    const sensorState = knownSensor ?? await this.getSensorState(reading.sensorId);
    if (!sensorState || sensorState.sensor.zoneId !== reading.zoneId || sensorState.sensor.type !== reading.type) {
      throw new Error("Reading does not match registered sensor metadata.");
    }

    const definition = sensorDefinitions.find((sensor) => sensor.type === reading.type);
    if (!definition) throw new Error("Reading contains an unsupported sensor type.");
    const expiresAt = Math.floor(Date.parse(reading.recordedAt) / 1000) + ttlSeconds;
    const item: PrimitiveItem = {
      PK: entityKey("SENSOR", reading.sensorId),
      SK: `READING#${reading.recordedAt}`,
      entityType: "READING",
      sensorId: reading.sensorId,
      zoneId: reading.zoneId,
      sensorType: reading.type,
      value: reading.value,
      timestamp: reading.recordedAt,
      label: definition.label,
      unit: definition.unit,
      expiresAt,
    };
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));

    const updated = await this.client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { PK: entityKey("SENSOR", reading.sensorId), SK: sensorMetadataSortKey },
      UpdateExpression: "SET latestValue = :value, latestRecordedAt = :recordedAt",
      ConditionExpression: "attribute_exists(PK) AND zoneId = :zoneId AND sensorType = :sensorType",
      ExpressionAttributeValues: {
        ":value": reading.value,
        ":recordedAt": reading.recordedAt,
        ":zoneId": reading.zoneId,
        ":sensorType": reading.type,
      },
      ReturnValues: "ALL_NEW",
    }));
    const updatedItem = asItem(updated.Attributes);
    if (!updatedItem) throw new Error("Sensor metadata was not returned after saving a reading.");
    return mapSensor(updatedItem);
  }

  async getZone(zoneId: string): Promise<Zone | undefined> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: { ":pk": entityKey("ZONE", zoneId), ":sk": "METADATA" },
      Limit: 1,
    }));
    const item = asItem(result.Items?.[0]);
    return item ? mapZone(item) : undefined;
  }

  async getZones(): Promise<Zone[]> {
    const result = await Promise.all(zoneDefinitions.map((zone) => this.getZone(zone.id)));
    return result.filter((zone): zone is Zone => zone !== undefined);
  }

  async getTeam(teamId: string): Promise<ResponseTeam | undefined> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: { ":pk": entityKey("TEAM", teamId), ":sk": "METADATA" },
      Limit: 1,
    }));
    const item = asItem(result.Items?.[0]);
    return item ? mapTeam(item) : undefined;
  }

  async getTeams(): Promise<ResponseTeam[]> {
    const result = await Promise.all(responseTeamDefinitions.map((team) => this.getTeam(team.id)));
    return result.filter((team): team is ResponseTeam => team !== undefined);
  }

  async getActiveIncidents(): Promise<Incident[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": "INCIDENT_STATUS#ACTIVE" },
      ScanIndexForward: false,
      Limit: 100,
    }));
    return (result.Items ?? []).flatMap((value) => {
      const item = asItem(value);
      return item ? [mapIncident(item)] : [];
    });
  }

  async getIncidentsByZone(zoneId: string): Promise<Incident[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :incidentPrefix)",
      ExpressionAttributeValues: {
        ":pk": entityKey("ZONE", zoneId),
        ":incidentPrefix": "INCIDENT#",
      },
      ScanIndexForward: false,
      Limit: 100,
    }));
    const keys = (result.Items ?? []).flatMap((value) => {
      const item = asItem(value);
      return item && typeof item.incidentId === "string"
        ? [{ PK: entityKey("INCIDENT", item.incidentId), SK: incidentMetadataSortKey }]
        : [];
    });
    if (keys.length === 0) return [];

    const incidents: Incident[] = [];
    for (let offset = 0; offset < keys.length; offset += 100) {
      let requestKeys = keys.slice(offset, offset + 100);
      for (let attempt = 0; requestKeys.length > 0 && attempt < 4; attempt += 1) {
        const response = await this.client.send(new BatchGetCommand({
          RequestItems: { [this.tableName]: { Keys: requestKeys } },
        }));
        incidents.push(...(response.Responses?.[this.tableName] ?? []).flatMap((value) => {
          const item = asItem(value);
          return item ? [mapIncident(item)] : [];
        }));
        const unprocessedKeys = response.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
        requestKeys = unprocessedKeys.flatMap((key) => {
          const item = asItem(key);
          return item && typeof item.PK === "string" && typeof item.SK === "string"
            ? [{ PK: item.PK, SK: item.SK }]
            : [];
        });
        if (requestKeys.length !== unprocessedKeys.length) {
          throw new Error("DynamoDB returned an invalid unprocessed incident key.");
        }
        if (requestKeys.length > 0) await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
      if (requestKeys.length > 0) {
        throw new Error(`DynamoDB left ${requestKeys.length} incident reads unprocessed after retries.`);
      }
    }
    return incidents;
  }

  async getIncidents(): Promise<Incident[]> {
    const byZone = await Promise.all(zoneDefinitions.map((zone) => this.getIncidentsByZone(zone.id)));
    const unique = new Map<string, Incident>();
    for (const incident of byZone.flat()) unique.set(incident.id, incident);
    return [...unique.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 100);
  }

  async getIncident(incidentId: string): Promise<Incident | undefined> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: {
        ":pk": entityKey("INCIDENT", incidentId),
        ":sk": incidentMetadataSortKey,
      },
      Limit: 1,
    }));
    const item = asItem(result.Items?.[0]);
    return item ? mapIncident(item) : undefined;
  }

  async createIncident(incident: Incident): Promise<void> {
    const createdAt = incident.detectedAt;
    const metadata: PrimitiveItem = {
      PK: entityKey("INCIDENT", incident.id),
      SK: incidentMetadataSortKey,
      entityType: "INCIDENT",
      incidentId: incident.id,
      sensorId: incident.sensorId,
      zoneId: incident.zoneId,
      sensorType: incident.type,
      title: incident.title,
      description: incident.description,
      severity: incident.severity,
      status: incident.status,
      createdAt,
      updatedAt: incident.updatedAt,
      GSI1PK: "INCIDENT_STATUS#ACTIVE",
      GSI1SK: `${createdAt}#${incident.id}`,
    };
    const zoneLookup: PrimitiveItem = {
      PK: entityKey("INCIDENT", incident.id),
      SK: `ZONE_INDEX#${incident.zoneId}`,
      entityType: "INCIDENT_ZONE_INDEX",
      incidentId: incident.id,
      zoneId: incident.zoneId,
      GSI1PK: entityKey("ZONE", incident.zoneId),
      GSI1SK: `INCIDENT#${createdAt}#${incident.id}`,
    };
    await this.client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: this.tableName,
            Item: metadata,
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: zoneLookup,
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
          },
        },
      ],
    }));
  }

  async updateIncident(incident: Incident): Promise<void> {
    const item: PrimitiveItem = {
      PK: entityKey("INCIDENT", incident.id),
      SK: incidentMetadataSortKey,
      entityType: "INCIDENT",
      incidentId: incident.id,
      sensorId: incident.sensorId,
      zoneId: incident.zoneId,
      sensorType: incident.type,
      title: incident.title,
      description: incident.description,
      severity: incident.severity,
      status: incident.status,
      createdAt: incident.detectedAt,
      updatedAt: incident.updatedAt,
    };
    if (incident.status === "ACTIVE") {
      item.GSI1PK = "INCIDENT_STATUS#ACTIVE";
      item.GSI1SK = `${incident.detectedAt}#${incident.id}`;
    }
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: item,
      ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
    }));
  }

  async attachActiveIncident(sensorId: string, incidentId: string): Promise<string | undefined> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: entityKey("SENSOR", sensorId), SK: sensorMetadataSortKey },
        UpdateExpression: "SET activeIncidentId = :incidentId",
        ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(activeIncidentId)",
        ExpressionAttributeValues: { ":incidentId": incidentId },
      }));
      return undefined;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
      return (await this.getSensorState(sensorId))?.activeIncidentId;
    }
  }

  async clearActiveIncident(sensorId: string, incidentId: string): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: entityKey("SENSOR", sensorId), SK: sensorMetadataSortKey },
        UpdateExpression: "REMOVE activeIncidentId",
        ConditionExpression: "activeIncidentId = :incidentId",
        ExpressionAttributeValues: { ":incidentId": incidentId },
      }));
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
  }
}

export function makeIncidentId(): string {
  return randomUUID();
}

export function readingExpiry(timestamp: string): number {
  return Math.floor(Date.parse(timestamp) / 1000) + ttlSeconds;
}

export function isKnownZoneId(value: string): value is ZoneId {
  return zoneDefinitions.some((zone) => zone.id === value);
}