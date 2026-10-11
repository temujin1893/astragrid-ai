import { App } from "aws-cdk-lib";
import { AstraGridStack } from "./stack.js";

const app = new App();
new AstraGridStack(app, "AstraGridStack");