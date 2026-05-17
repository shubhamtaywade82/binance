import { useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';

export interface PnLMessage {
  type: 'trade' | 'position' | 'position_delete' | 'equity';
  data?: any;
  symbol?: string;
}

export function usePnLWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<PnLMessage | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);

  const connect = () => {
    // Determine WS URL based on API URL
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001';
    const wsUrl = apiUrl.replace('http', 'ws') + '/ws';

    console.log(`[ws] Connecting to ${wsUrl}...`);
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[ws] Connected to PnL streaming');
      setIsConnected(true);
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
        reconnectTimeout.current = null;
      }
    };

    socket.onmessage = (event) => {
      try {
        const msg: PnLMessage = JSON.parse(event.data);
        setLastMessage(msg);

        // Intelligently mutate SWR cache based on message type
        if (msg.type === 'trade') {
          mutate('/trades?limit=50');
          mutate('/trades/stats');
        } else if (msg.type === 'position' || msg.type === 'position_delete') {
          mutate('/positions');
          mutate('/wallet'); // Positions affect unrealized PnL in wallet
        } else if (msg.type === 'equity') {
          mutate('/equity/curve?limit=1000');
          mutate('/wallet');
        }
      } catch (err) {
        console.error('[ws] Error parsing message:', err);
      }
    };

    socket.onclose = () => {
      console.log('[ws] Disconnected from PnL streaming');
      setIsConnected(false);
      ws.current = null;
      // Reconnect after 3s
      if (!reconnectTimeout.current) {
        reconnectTimeout.current = setTimeout(connect, 3000);
      }
    };

    socket.onerror = (err) => {
      console.error('[ws] WebSocket error:', err);
      socket.close();
    };

    ws.current = socket;
  };

  useEffect(() => {
    connect();
    return () => {
      if (ws.current) {
        ws.current.close();
      }
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
    };
  }, []);

  return { isConnected, lastMessage };
}
