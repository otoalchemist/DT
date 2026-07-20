import { useEffect, useRef, useState } from "react";
import type { BotStatus, ActivityEntry } from "@dat-bot/shared";

interface LiveState {
  status: BotStatus | null;
  activity: ActivityEntry[];
  connected: boolean;
  pushStatus: (s: BotStatus) => void;
}

// Subscribes to the backend WebSocket for live status + activity.
export function useSocket(enabled = true): LiveState {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const ref = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      setStatus(null);
      setActivity([]);
      return;
    }
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ref.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
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
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      ref.current?.close();
    };
  }, [enabled]);

  return { status, activity, connected, pushStatus: setStatus };
}
