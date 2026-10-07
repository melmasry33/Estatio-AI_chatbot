import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { handleChatRequest } from "./lib/assistant.server.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "estatio-chatbot",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Chat endpoint matching the architecture
app.post("/api/chat", async (req: Request, res: Response) => {
  try {
    const clientIp = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "anonymous";
    const result = await handleChatRequest(req.body, clientIp);
    res.status(result.status).json(result.body);
  } catch (error: any) {
    console.error("[Server] Unhandled chat exception:", error);
    res.status(500).json({ error: "An unexpected error occurred while processing your request." });
  }
});

app.listen(port, () => {
  console.log(`[Estatio Chatbot] Server listening on http://0.0.0.0:${port}`);
  console.log(`[Estatio Chatbot] Ready for POST /api/chat`);
});
