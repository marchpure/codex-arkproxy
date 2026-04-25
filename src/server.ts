import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({
    logger: {
      level: config.logLevel
    }
  });

  await registerRoutes(app, config);

  await app.listen({
    host: config.host,
    port: config.port
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
