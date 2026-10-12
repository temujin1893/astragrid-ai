import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "node:path";
import type { Construct } from "constructs";

class AnomalyLogGroupTarget implements events.IRuleTarget {
  constructor(private readonly logGroup: logs.ILogGroup) {}

  bind(_rule: Parameters<events.IRuleTarget["bind"]>[0]): events.RuleTargetConfig {
    return { arn: this.logGroup.logGroupArn };
  }
}

export class AstraGridStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // One table keeps operational entities together while PK/SK prefixes group
    // each entity and its related records into queryable item collections.
    const operationalTable = new dynamodb.Table(this, "OperationalDataTable", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      // Traffic is expected to be modest and variable for a student project;
      // on-demand billing avoids capacity planning and idle provisioned cost.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
     pointInTimeRecoveryEnabled: true,
},
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      // Expiring telemetry can set expiresAt as a Unix epoch timestamp in seconds.
      timeToLiveAttribute: "expiresAt",
      // The stream supports future change-driven processing without adding
      // consumers or other AWS services in this phase.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // GSI1 is intentionally overloaded: writers set these sparse attributes
    // only on records used for active-incident, zone-incident, or zone-sensor
    // lookups. Other records do not incur index entries.
    operationalTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const eventBus = new events.EventBus(this, "AstraGridEventsBus", {
      eventBusName: "astragrid-events",
    });

    const detectionLogGroup = new logs.LogGroup(this, "DetectionLambdaLogGroup", {
      logGroupName: "/aws/lambda/AstraGridDetectionLambda",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const detectionRole = new iam.Role(this, "AstraGridDetectionLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    detectionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [`${detectionLogGroup.logGroupArn}:*`],
    }));

    const detectionLambda = new NodejsFunction(this, "AstraGridDetectionLambda", {
      functionName: "AstraGridDetectionLambda",
      entry: path.join(process.cwd(), "src", "lambda", "detection-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      role: detectionRole,
      logGroup: detectionLogGroup,
      environment: { EVENT_BUS_NAME: eventBus.eventBusName },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
      },
    });

    // Grant only stream reads and event publishing; the Lambda cannot read or
    // write operational table items or administer other AWS resources.
    operationalTable.grantStreamRead(detectionLambda);
    eventBus.grantPutEventsTo(detectionLambda);

    detectionLambda.addEventSource(new lambdaEventSources.DynamoEventSource(operationalTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      bisectBatchOnError: true,
    }));

    const anomalyLogGroup = new logs.LogGroup(this, "AnomalyEventsLogGroup", {
      logGroupName: "/aws/events/astragrid-anomalies",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const anomalyLogRule = new events.Rule(this, "SensorAnomalyLogRule", {
      eventBus,
      eventPattern: {
        source: ["astragrid.sensor"],
        detailType: ["SensorAnomalyDetected"],
      },
      targets: [new AnomalyLogGroupTarget(anomalyLogGroup)],
    });

    new logs.CfnResourcePolicy(this, "AnomalyLogGroupResourcePolicy", {
      policyName: "AstraGridAnomalyEventsDelivery",
      policyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
          Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: `${anomalyLogGroup.logGroupArn}:*`,
          Condition: { ArnEquals: { "aws:SourceArn": anomalyLogRule.ruleArn } },
        }],
      }),
    });

    new CfnOutput(this, "OperationalTableName", {
      value: operationalTable.tableName,
      description: "Generated name of the AstraGrid operational DynamoDB table",
    });
    new CfnOutput(this, "OperationalTableArn", {
      value: operationalTable.tableArn,
      description: "ARN of the AstraGrid operational DynamoDB table",
    });
    new CfnOutput(this, "OperationalTableStreamArn", {
      value: operationalTable.tableStreamArn!,
      description: "Stream ARN for new and old images from the operational table",
    });
    new CfnOutput(this, "AstraGridEventBusArn", {
      value: eventBus.eventBusArn,
      description: "ARN of the AstraGrid anomaly event bus",
    });
    new CfnOutput(this, "AstraGridDetectionLambdaArn", {
      value: detectionLambda.functionArn,
      description: "ARN of the DynamoDB Streams detection Lambda",
    });
    new CfnOutput(this, "AstraGridDetectionLambdaName", {
      value: detectionLambda.functionName,
      description: "Name of the DynamoDB Streams detection Lambda",
    });
  }
}