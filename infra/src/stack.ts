import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";

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
  }
}