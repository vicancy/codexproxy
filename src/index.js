import { DefaultAzureCredential } from "@azure/identity";
import { loadConfig } from "./config.js";
import { TokenManager } from "./auth.js";
import { createProxyServer } from "./proxy.js";

const config = loadConfig();

const logger = {
  info(meta, message) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", message, ...meta }));
  },
  error(meta, message) {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message, ...meta }));
  }
};

const tokenManager = config.upstreamProvider === "azure"
  ? new TokenManager({
    credential: new DefaultAzureCredential(),
    scope: config.scope,
    refreshBufferMs: config.tokenRefreshBufferMs,
    logger
  })
  : null;

const server = createProxyServer({ config, tokenManager, logger });

server.listen(config.listenPort, config.listenHost, () => {
  logger.info(
    {
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      upstreamProvider: config.upstreamProvider,
      upstreamBaseUrl: config.upstreamBaseUrl,
      ...(config.upstreamProvider === "azure" ? { scope: config.scope } : {}),
      stickyHighModels: config.stickyHighModels
    },
    "Codex proxy listening"
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    logger.info({ signal }, "Received shutdown signal");
    server.close(() => {
      logger.info({}, "Server closed");
      process.exit(0);
    });
  });
}
