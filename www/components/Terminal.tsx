/* eslint-disable @typescript-eslint/no-unused-vars */
"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

const XtermTerminal = () => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    initTerminal();
    return () => {
      wsRef.current?.close();
      xtermRef.current?.dispose();
    };
  }, []);

  const initTerminal = async () => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, monospace',
      theme: {
        background: '#1a1a1a',
        foreground: '#00ff00',
        cursor: '#00ff00'
      },
      cols: 80,
      rows: 24
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    xtermRef.current = term;

    try {
      const response = await fetch('http://localhost:3001/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: term.cols, rows: term.rows })
      });

      if (!response.ok) throw new Error('Session creation failed');
      const { sessionId } = await response.json();
      connectWebSocket(sessionId, term, fitAddon);
    } catch (err) {
      setError('Failed to create session');
    }
  };

  const connectWebSocket = (sessionId: string, term: Terminal, fitAddon: FitAddon) => {
    const ws = new WebSocket(`ws://localhost:3001/ws?sessionId=${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      term.write('\r\nConnected to terminal\r\n');
      
      term.onData(data => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      const handleResize = () => {
        fitAddon.fit();
        fetch(`http://localhost:3001/api/sessions/${sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: term.cols, rows: term.rows })
        });
      };

      window.addEventListener('resize', handleResize);
    };

    ws.onmessage = (event) => {
      if (event.data instanceof Blob) {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            term.write(reader.result);
          }
        };
        reader.readAsText(event.data);
      } else {
        term.write(event.data);
      }
    };

    ws.onerror = () => setError('WebSocket error');
    ws.onclose = () => term.write('\r\nDisconnected\r\n');
  };

  return (
    <div className="h-[600px] bg-black rounded-lg overflow-hidden">
      <div ref={terminalRef} className="h-full" />
      {error && (
        <div className="absolute bottom-4 right-4 bg-red-500 text-white px-4 py-2 rounded">
          {error}
        </div>
      )}
    </div>
  );
};

export default XtermTerminal;