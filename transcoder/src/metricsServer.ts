import { WebSocketServer, WebSocket } from 'ws';
import { WsMessage } from './types';

export class MetricsServer {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;
      console.log(`[metrics] Client connected from ${ip}`);
      this.clients.add(ws);

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[metrics] Client disconnected`);
      });

      ws.on('error', (err) => {
        console.error(`[metrics] WebSocket error: ${err.message}`);
        this.clients.delete(ws);
      });
    });

    this.wss.on('error', (err) => {
      console.error(`[metrics] Server error: ${err.message}`);
    });

    console.log(`[metrics] WebSocket server listening on ws://0.0.0.0:${port}`);
  }

  broadcast(message: WsMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
