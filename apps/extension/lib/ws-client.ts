import { browser } from "wxt/browser";
import type { ClientMessage, ServerMessage } from "@pv/schema";
import { PROTOCOL_VERSION } from "@pv/schema";

export type SocketStatus = "closed" | "connecting" | "open";

interface Pending {
  resolve: (m: ServerMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_SERVER_URL = "ws://localhost:8765/ws";
export const DEFAULT_AUTH_TOKEN = "";

export class AgentSocket {
  status: SocketStatus = "closed";
  onStatus: ((s: SocketStatus, detail?: string) => void) | null = null;
  onEvent: ((e: { kind: string; message: string }) => void) | null = null;
  /** Streaming thought deltas from the server (P4). Keyed by request seq. */
  onPlanDelta: ((seq: number, delta: string) => void) | null = null;

  private ws: WebSocket | null = null;
  private url = DEFAULT_SERVER_URL;
  private token = DEFAULT_AUTH_TOKEN;
  private session = `sess-${Math.random().toString(36).slice(2, 10)}`;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private welcomeWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private helloSent = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  async loadUrl(): Promise<void> {
    const stored = await browser.storage.local.get(["serverUrl", "authToken"]);
    if (typeof stored.serverUrl === "string" && stored.serverUrl) this.url = stored.serverUrl;
    if (typeof stored.authToken === "string") this.token = stored.authToken;
  }

  async setUrl(url: string): Promise<void> {
    this.url = url.trim().replace(/^http/i, "ws");
    await browser.storage.local.set({ serverUrl: this.url });
    this.disconnect();
  }

  async setToken(token: string): Promise<void> {
    this.token = token.trim();
    await browser.storage.local.set({ authToken: this.token });
    this.disconnect();
  }

  currentUrl(): string {
    return this.url;
  }

  hasToken(): boolean {
    return this.token.length > 0;
  }

  disconnect(): void {
    this.ws?.close(1000);
    this.ws = null;
  }

  async ensure(): Promise<void> {
    if (this.status === "open") return;
    if (this.status === "connecting") {
      await new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
          if (this.status === "open") {
            clearInterval(check);
            resolve();
          } else if (this.status === "closed") {
            clearInterval(check);
            reject(new Error("connection failed"));
          }
        }, 100);
        setTimeout(() => {
          clearInterval(check);
          reject(new Error("connection timeout"));
        }, 8000);
      });
      return;
    }
    this.connect();
    await new Promise<void>((resolve, reject) => {
      this.welcomeWaiter = { resolve, reject };
      setTimeout(() => reject(new Error("server handshake timeout")), 8000);
    });
  }

  private connect(): void {
    this.setStatus("connecting");
    try {
      const wsUrl = new URL(this.url);
      if (this.token) wsUrl.searchParams.set("token", this.token);
      this.ws = new WebSocket(wsUrl.toString());
    } catch (e) {
      this.setStatus("closed", String(e));
      return;
    }
    this.ws.onopen = () => {
      this.helloSent = false;
      this.sendHello();
    };
    this.ws.onmessage = (ev) => this.handleFrame(ev.data);
    this.ws.onerror = () => {
      this.onEvent?.({ kind: "socket", message: `cannot reach ${this.url}` });
    };
    this.ws.onclose = () => {
      this.failPending(new Error("connection closed"));
      this.setStatus("closed");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status === "closed" && this.pending.size === 0) {
        this.connect();
      }
    }, 5000);
  }

  private sendHello(): void {
    if (this.helloSent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.helloSent = true;
    this.rawSend({
      type: "hello",
      v: PROTOCOL_VERSION,
      session: this.session,
      caps: {
        webgpu: "gpu" in navigator,
        dpr: (typeof window !== "undefined" ? window.devicePixelRatio : globalThis.devicePixelRatio) || 1,
      },
    });
  }

  async request(frame: Record<string, unknown>, timeoutMs = 25000): Promise<ServerMessage> {
    await this.ensure();
    const seq = ++this.seq;
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`no response within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      if (!this.rawSend({ ...frame, seq })) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(new Error("socket not open"));
      }
    });
  }

  send(msg: ClientMessage): boolean {
    return this.rawSend(msg);
  }

  private rawSend(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  private handleFrame(data: unknown): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }

    if (msg.type === "welcome") {
      this.setStatus("open", `${msg.provider}:${msg.model}`);
      this.welcomeWaiter?.resolve();
      this.welcomeWaiter = null;
      return;
    }

    // Streaming thought deltas: forwarded to listeners, never resolve the request
    // (only the final plan frame does).
    if (msg.type === "plan_delta") {
      this.onPlanDelta?.(msg.seq, msg.delta);
      return;
    }

    const seq = "seq" in msg ? msg.seq : undefined;
    if (seq !== undefined) {
      const p = this.pending.get(seq);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(seq);
        p.resolve(msg);
        return;
      }
    }

    if (msg.type === "error") {
      this.onEvent?.({ kind: "server-error", message: `[${msg.code}] ${msg.message}` });
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`server error: ${msg.code} ${msg.message}`));
      }
      this.pending.clear();
    }
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.welcomeWaiter?.reject(err);
    this.welcomeWaiter = null;
  }

  private setStatus(s: SocketStatus, detail?: string): void {
    this.status = s;
    this.onStatus?.(s, detail);
  }
}
