import { createApp, getAllowedOrigins } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

const app = createApp();

app.listen(port, host, () => {
  console.log(`AstraGrid API listening on http://${host}:${port}`);
  console.log(`Allowed CORS origins: ${getAllowedOrigins().join(", ")}`);
});
