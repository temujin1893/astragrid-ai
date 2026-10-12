import { EventBridgeClient, PutEventsCommand, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { detectAnomaly, isSensorType, type SensorReadingEvent } from "./anomaly-rules.js";

const eventBridge = new EventBridgeClient({});
const eventBusName = process.env.EVENT_BUS_NAME;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function readingFromRecord(record: DynamoDBRecord): SensorReadingEvent | undefined {
  const image = record.dynamodb?.NewImage;
  if (!image) return undefined;

  const item = unmarshall(image as Record<string, AttributeValue>);
  if (item.entityType !== "READING") return undefined;

  const zone = item.zoneId;
  if (
    typeof item.sensorId !== "string" ||
    typeof zone !== "string" ||
    !isSensorType(item.sensorType) ||
    typeof item.value !== "number" || !Number.isFinite(item.value) ||
    typeof item.timestamp !== "string" || !Number.isFinite(Date.parse(item.timestamp))
  ) {
    throw new Error("Reading stream image is missing valid sensorId, zoneId, sensorType, value, or timestamp fields.");
  }

  return {
    sensorId: item.sensorId,
    zone,
    sensorType: item.sensorType,
    value: item.value,
    timestamp: item.timestamp,
  };
}

function anomalyEntry(record: DynamoDBRecord, reading: SensorReadingEvent): PutEventsRequestEntry | undefined {
  const anomaly = detectAnomaly(reading);
  if (!anomaly) return undefined;

  return {
    EventBusName: eventBusName,
    Source: "astragrid.sensor",
    DetailType: "SensorAnomalyDetected",
    Time: new Date(reading.timestamp),
    Detail: JSON.stringify({
      ...reading,
      ...anomaly,
      streamEventId: record.eventID ?? "unknown",
    }),
  };
}

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  log("stream_invocation", { recordCount: event.Records.length });
  let readingsProcessed = 0;
  const entries: PutEventsRequestEntry[] = [];

  for (const record of event.Records) {
    if (record.eventName === "REMOVE") continue;
    if (record.eventName !== "INSERT" && record.eventName !== "MODIFY") continue;
    if (!record.dynamodb?.NewImage) {
      log("malformed_stream_record", {
        eventID: record.eventID,
        message: "INSERT or MODIFY record did not contain a NEW_IMAGE.",
      });
      continue;
    }

    try {
      const reading = readingFromRecord(record);
      if (!reading) continue;
      readingsProcessed += 1;
      const entry = anomalyEntry(record, reading);
      if (entry) {
        entries.push(entry);
        log("sensor_anomaly_detected", {
          eventID: record.eventID,
          sensorId: reading.sensorId,
          zone: reading.zone,
          sensorType: reading.sensorType,
          value: reading.value,
          riskLevel: "HIGH",
        });
      }
    } catch (error) {
      log("malformed_stream_record", {
        eventID: record.eventID,
        message: error instanceof Error ? error.message : "Unable to decode stream record",
      });
    }
  }

  log("stream_records_processed", {
    recordCount: event.Records.length,
    readingsProcessed,
    anomaliesDetected: entries.length,
  });

  if (entries.length === 0) return;
  if (!eventBusName) throw new Error("EVENT_BUS_NAME is not configured.");

  try {
    const result = await eventBridge.send(new PutEventsCommand({ Entries: entries }));
    if ((result.FailedEntryCount ?? 0) > 0) {
      const failures = result.Entries?.flatMap((entry, index) => entry.ErrorCode
        ? [{ index, code: entry.ErrorCode, message: entry.ErrorMessage }]
        : []) ?? [];
      log("eventbridge_publish_failed", { failedEntryCount: result.FailedEntryCount, failures });
      throw new Error(`EventBridge rejected ${result.FailedEntryCount} anomaly event(s).`);
    }
    log("eventbridge_events_published", { count: entries.length, eventBusName });
  } catch (error) {
    log("eventbridge_publish_error", {
      message: error instanceof Error ? error.message : "Unable to publish anomaly events",
      count: entries.length,
    });
    throw error;
  }
}