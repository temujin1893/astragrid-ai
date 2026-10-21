// The package is CommonJS (module.exports = configure); the named `configure`
// export is the same callable with NodeNext-safe typing.
import { configure as serverlessExpress } from "@codegenie/serverless-express";
import { createApp } from "./app.js";

// AWS Lambda entry point for the API. The public endpoint is an API Gateway
// HTTP API, which invokes the function with payload format 2.0 (see
// infra/src/stack.ts — Lambda Function URLs are unavailable in ap-south-2).
// createApp() runs once per cold start; Lambda reuses the warm container and
// its initialized Express app across invocations. CORS, validation, routes,
// and error handling are the exact code the local server runs (see app.ts),
// with ALLOWED_ORIGINS set to the deployed frontend origin.
const app = createApp();

export const handler = serverlessExpress({ app });
