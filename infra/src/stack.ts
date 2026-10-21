import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
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

    // The deployed frontend origin drives the API's CORS allow-list. Pass it at
    // synth/deploy time once the Amplify app exists:
    //   npx cdk deploy -c amplifyOrigin=https://<app-id>.amplifyapp.com
    // Fail closed: without the context the API only accepts browser calls from
    // localhost, so a deploy that omits the flag cannot open CORS to everyone.
    const requestedOrigin = String(this.node.tryGetContext("amplifyOrigin") ?? "").trim().replace(/\/$/, "");
    const frontendOrigin = requestedOrigin === "" ? "http://localhost:5173" : requestedOrigin;
    if (!/^https?:\/\/[^/\s]+$/.test(frontendOrigin)) {
      throw new Error(
        `amplifyOrigin must look like https://<app-id>.amplifyapp.com, received: ${frontendOrigin}`,
      );
    }

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

    // ---- Public API: the shared Express app adapted for Lambda ----
    // The handler entry lives beside the Express app it wraps (apps/api), so the
    // local server and the deployed function run the exact same routes, CORS
    // policy, request validation, and error handling (see apps/api/src/app.ts).
    const apiLogGroup = new logs.LogGroup(this, "ApiLambdaLogGroup", {
      logGroupName: "/aws/lambda/AstraGridApiLambda",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const apiRole = new iam.Role(this, "AstraGridApiLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    // Logs: only the API function's own log group, mirroring the detection role.
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [`${apiLogGroup.logGroupArn}:*`],
    }));
    // Data: only the item actions the repository actually issues, scoped to the
    // operational table and its indexes. No stream reads, no EventBridge, no
    // Scan/DescribeTable, no permissions outside this table.
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:Query",
        "dynamodb:BatchGetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:TransactWriteItems",
      ],
      resources: [operationalTable.tableArn, `${operationalTable.tableArn}/index/*`],
    }));

    const apiLambda = new NodejsFunction(this, "AstraGridApiLambda", {
      functionName: "AstraGridApiLambda",
      entry: path.join(process.cwd(), "..", "apps", "api", "src", "lambda.ts"),
      handler: "handler",
      // nodejs20.x (the existing detection Lambda's runtime) stops accepting
      // NEW functions on 2027-02-01, which would block future redeploys and
      // rollbacks of this one; the existing function's runtime is left as-is.
      // The bundle target stays node20 — its syntax runs unmodified on 24.
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      role: apiRole,
      logGroup: apiLogGroup,
      // AWS_REGION is injected by the Lambda runtime (always this region);
      // ASTRAGRID_TABLE_NAME comes from the existing table (never hard-coded).
      environment: {
        ASTRAGRID_TABLE_NAME: operationalTable.tableName,
        ALLOWED_ORIGINS: frontendOrigin,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
      },
    });

    // Public HTTPS endpoint: an API Gateway HTTP API in front of the same
    // Lambda, with no auth stage/authorizer — any client that learns the URL can
    // invoke it (see docs/deployment.md for the security trade-offs).
    // Lambda Function URLs are unavailable in ap-south-2 (the regional endpoint
    // rejects FunctionUrlConfig operations and CloudFormation has no
    // AWS::Lambda::Url type there), so an HTTP API is the equivalent serverless
    // endpoint that keeps everything in this region. HTTP APIs emit payload
    // format 2.0, the event shape apps/api/src/lambda.ts is written for.
    const httpApi = new apigatewayv2.HttpApi(this, "AstraGridHttpApi", {
      apiName: "astragrid-api",
      // CORS stays in the Express app (ALLOWED_ORIGINS) rather than the
      // gateway: gateway CORS would add a second Access-Control-Allow-Origin
      // header on responses and browsers reject duplicates. Preflight OPTIONS
      // routes to the Lambda, where the cors middleware answers it.
      defaultIntegration: new apigatewayv2Integrations.HttpLambdaIntegration(
        "AstraGridApiIntegration",
        apiLambda,
      ),
    });

    // Throttle the unauthenticated endpoint: demo traffic is a few requests per
    // second at most, so anything past these limits gets 429s instead of
    // running up Lambda usage if the URL is probed.
    const apiStage = httpApi.defaultStage?.node.defaultChild as apigatewayv2.CfnStage | undefined;
    if (apiStage) {
      apiStage.defaultRouteSettings = { throttlingBurstLimit: 50, throttlingRateLimit: 25 };
    }

    const apiBaseUrl = (httpApi.apiEndpoint ?? "").replace(/\/$/, "");

    new CfnOutput(this, "AstraGridApiEndpoint", {
      value: apiBaseUrl,
      description: "Public HTTPS base URL of the AstraGrid Express API (API Gateway HTTP API)",
    });
    new CfnOutput(this, "AstraGridApiHealthEndpoint", {
      value: `${apiBaseUrl}/api/health`,
      description: "Public health endpoint of the AstraGrid Express API",
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