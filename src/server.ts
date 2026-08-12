import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { initJobSystem, shutdownJobSystem } from "./jobs/sync.queue.js";
import { initSocketServer } from "./realtime/socket.js";

const app = createApp();
const httpServer = createServer(app);
initSocketServer(httpServer);

await initJobSystem();

httpServer.listen(env.PORT, () => {
  console.log(`DevFlow AI API listening on http://localhost:${env.PORT}`);
});

async function shutdown() {
  await shutdownJobSystem();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
