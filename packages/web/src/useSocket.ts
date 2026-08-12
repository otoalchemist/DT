import { useEffect, useRef, useState } from "react";
import type { BotStatus, ActivityEntry } from "@dat-bot/shared";
import { getSessionToken, invalidateSessionToken } from "./api.js";

interface LiveState {
  status: BotStatus | null;
  activity: ActivityEntry[];
  connected: boolean;
  pushStatus: (s: BotStatus) => void;
}

// Subscribes to the backend WebSocket for live status + activity.
export function useSocket(): LiveState {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const ref = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = async () => {
      try {
        const token = await getSessionToken();
        if (closed) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(token)}`);
        ref.current = ws;
        ws.onopen = () => setConnected(true);
        ws.onclose = () => {
          invalidateSessionToken();
          setConnected(false);
          if (!closed) retry = setTimeout(() => void connect(), 2000);
        };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === "status") setStatus(msg.data);
          else if (msg.type === "activity-batch") setActivity(msg.data);
          else if (msg.type === "activity")
            setActivity((prev) => {
              // Upsert by id: a receipt-tracking update re-emits the same entry id.
              const idx = prev.findIndex((e) => e.id === msg.data.id);
              if (idx >= 0) {
                const next = prev.slice();
                next[idx] = msg.data;
                return next;
              }
              return [...prev, msg.data].slice(-300);
            });
        };
      } catch {
        setConnected(false);
        invalidateSessionToken();
        if (!closed) retry = setTimeout(() => void connect(), 2000);
      }
    };
    void connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      ref.current?.close();
    };
  }, []);

  return { status, activity, connected, pushStatus: setStatus };
}
