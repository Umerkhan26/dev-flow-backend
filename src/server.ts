import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { initSocketServer } from "./realtime/socket.js";

const app = createApp();
const httpServer = createServer(app);
initSocketServer(httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`DevFlow AI API listening on http://localhost:${env.PORT}`);
});
