// Hand-rolled Discord Gateway client (v10, JSON encoding) so the package keeps zero
// runtime dependencies. Protocol per discord.com/developers/docs/events/gateway:
//   HELLO(10) -> heartbeat_interval; Heartbeat(1) every interval, ACK(11) expected;
//   Identify(2) once per fresh session; RESUME(6) with {session_id, seq} after a drop;
//   DISPATCH(0) carries {t, d, s}; RECONNECT(7); INVALID_SESSION(9).
// Outgoing frames must stay under 4096 bytes, which they always do here.

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

export const Intents = {
  Guilds: 1 << 0,
  GuildMessages: 1 << 9,
  MessageContent: 1 << 15,
  DirectMessages: 1 << 12,
} as const;

export type GatewayState = "idle" | "connecting" | "handshake" | "ready" | "retrying" | "closed";

export type Gateway = {
  state(): GatewayState;
  detail(): string;
  ready(): Promise<void>;
  close(): void;
};

export function connectGateway(opts: {
  token: string;
  intents: number;
  onEvent: (type: string, data: unknown) => void;
  onState?: (state: GatewayState, detail: string) => void;
}): Gateway {
  let state: GatewayState = "idle";
  let detail = "";
  let ws: WebSocket | null = null;
  let hbInterval = 45_000;
  let hbTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let seq: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let awaitingAck = false;
  let attempt = 0;
  let closed = false;
  let resolveReady: () => void = () => {};
  let ready = new Promise<void>((res) => (resolveReady = res));

  const set = (next: GatewayState, why = "") => {
    state = next;
    detail = why;
    opts.onState?.(next, why);
  };

  const stopHeartbeat = () => {
    if (hbTimer) clearTimeout(hbTimer);
    hbTimer = null;
  };

  const send = (op: number, d: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ op, d }));
      } catch {}
    }
  };

  const heartbeat = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (awaitingAck) {
      // No ACK since the last beat: the session is a zombie. Drop it and resume.
      set("retrying", "heartbeat ack timeout");
      try {
        ws.close(4000);
      } catch {}
      return;
    }
    awaitingAck = true;
    send(1, seq);
    hbTimer = setTimeout(heartbeat, hbInterval);
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    awaitingAck = false;
    // First beat after a jittered delay, per the docs' recommendation.
    hbTimer = setTimeout(heartbeat, Math.random() * hbInterval);
  };

  const identify = () =>
    send(2, {
      token: opts.token,
      intents: opts.intents,
      properties: { os: process.platform, browser: "pi-discord-comms", device: "pi-discord-comms" },
    });

  const resume = () => send(6, { token: opts.token, session_id: sessionId, seq });

  const reconnect = (why: string) => {
    if (closed) return;
    stopHeartbeat();
    const backoff = Math.min(30_000, 1_000 * 2 ** attempt++) + Math.random() * 500;
    set("retrying", `${why} · retry in ${Math.round(backoff / 1000)}s`);
    retryTimer = setTimeout(() => open(!!sessionId && seq !== null), backoff);
  };

  const open = (tryResume: boolean) => {
    if (closed || typeof WebSocket === "undefined") return;
    set("connecting", tryResume ? "resuming" : "connecting");
    ws = new WebSocket(tryResume && resumeUrl ? `${resumeUrl}?v=10&encoding=json` : GATEWAY);

    ws.onopen = () => set("handshake", "awaiting hello");

    ws.onmessage = (ev) => {
      let p: { op: number; t?: string; d?: any; s?: number | null };
      try {
        p = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof p.s === "number") seq = p.s;

      switch (p.op) {
        case 10:
          hbInterval = p.d?.heartbeat_interval ?? 45_000;
          startHeartbeat();
          if (sessionId && seq !== null) {
            set("handshake", "resuming");
            resume();
          } else {
            set("handshake", "identifying");
            identify();
          }
          return;
        case 11:
          awaitingAck = false;
          return;
        case 1:
          heartbeat();
          return;
        case 7:
          set("retrying", "server requested reconnect");
          try {
            ws?.close(4000);
          } catch {}
          return;
        case 9:
          if (p.d === true) {
            set("handshake", "invalid session, resuming");
            resume();
          } else {
            sessionId = null;
            seq = null;
            try {
              ws?.close(4000);
            } catch {}
          }
          return;
        case 0: {
          const type = p.t ?? "";
          if (type === "READY") {
            sessionId = p.d?.session_id ?? null;
            resumeUrl = p.d?.resume_gateway_url ?? null;
            attempt = 0;
            set("ready", "");
            resolveReady();
            ready = Promise.resolve();
          } else if (type === "RESUMED") {
            attempt = 0;
            set("ready", "resumed");
          }
          opts.onEvent(type, p.d);
          return;
        }
      }
    };

    ws.onclose = (ev) => {
      stopHeartbeat();
      if (closed) return;
      // 4004 auth fail / 4013-4014 bad intents are not fixed by retrying.
      if ([4004, 4013, 4014, 4015].includes(ev.code)) {
        set("closed", `discord rejected the connection (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
        return;
      }
      reconnect(`closed ${ev.code || "(no code)"}`);
    };

    ws.onerror = () => set("retrying", "websocket error");
  };

  open(false);

  return {
    state: () => state,
    detail: () => detail,
    ready: () => ready,
    close: () => {
      closed = true;
      stopHeartbeat();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      // 1000 is a normal client shutdown: it also tells Discord to end the session, so
      // the next Pi process can identify without waiting out a stale one.
      sessionId = null;
      try {
        ws?.close(1000);
      } catch {}
      ws = null;
      set("closed", "");
    },
  };
}
