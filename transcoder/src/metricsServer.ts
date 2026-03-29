import { WebSocketServer, WebSocket } from 'ws';
import { WsMessage } from './types';

const MAX_RECENT_EVENTS = 50;

export class MetricsServer {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private recentEvents: WsMessage[] = [];

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;
      console.log(`[metrics] Client connected from ${ip}`);
      this.clients.add(ws);

      // Replay recent operational events so new clients catch up
      for (const event of this.recentEvents) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      }

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
    // Cache non-metrics events so new clients can catch up on operational history
    if (message.type === 'failover' || message.type === 'scte35' || message.type === 'qc') {
      this.recentEvents.push(message);
      if (this.recentEvents.length > MAX_RECENT_EVENTS) {
        this.recentEvents.shift();
      }
    }

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
