import React, { useState, useEffect, useRef } from "react";

interface LogEntry {
  id: number;
  time: string;
  msg: string;
  level: "log" | "warn" | "error";
}

let logId = 0;
const logBuffer: LogEntry[] = [];
const listeners: Set<() => void> = new Set();

function addLog(msg: string, level: "log" | "warn" | "error" = "log") {
  const now = new Date();
  const time = `${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}.${now.getMilliseconds().toString().padStart(3, "0")}`;
  logBuffer.push({ id: ++logId, time, msg, level });
  if (logBuffer.length > 500) logBuffer.shift();
  listeners.forEach((fn) => fn());
}

// Intercept console.log/warn/error for voice-related logs
let hooked = false;
function hookConsole() {
  if (hooked) return;
  hooked = true;

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: any[]) => {
    origLog.apply(console, args);
    const str = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    // Capture voice pipeline, agent, and STT logs
    if (str.includes("[native-voice]") || str.includes("[voice]") || str.includes("[agent]") || str.includes("[api-base]")) {
      addLog(str, "log");
    }
  };

  console.warn = (...args: any[]) => {
    origWarn.apply(console, args);
    const str = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    addLog(str, "warn");
  };

  console.error = (...args: any[]) => {
    origError.apply(console, args);
    const str = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    addLog(str, "error");
  };
}

export const DebugConsole: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hookConsole();
    const update = () => setLogs([...logBuffer]);
    listeners.add(update);
    return () => { listeners.delete(update); };
  }, []);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, open]);

  const levelColor = (level: string) => {
    if (level === "error") return "text-red-400";
    if (level === "warn") return "text-yellow-400";
    return "text-green-300";
  };

  return (
    <>
      {/* Debug toggle button — small, bottom-left */}
      <button
        onClick={() => setOpen(v => !v)}
        className="fixed bottom-24 left-3 z-[200] w-8 h-8 rounded-full bg-gray-900/80 backdrop-blur text-white flex items-center justify-center text-xs font-mono shadow-lg border border-white/20"
        style={{ fontSize: "10px" }}
      >
        {open ? "×" : "🐛"}
      </button>

      {/* Debug console overlay */}
      {open && (
        <div className="fixed inset-x-0 bottom-0 z-[199] bg-gray-950/95 backdrop-blur-md text-white font-mono text-[10px] leading-4 flex flex-col" style={{ height: "55vh", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 bg-gray-800/80 border-b border-white/10 flex-shrink-0">
            <span className="font-bold text-xs">🐛 Voice Debug Console</span>
            <div className="flex gap-2">
              <button
                onClick={() => { logBuffer.length = 0; setLogs([]); }}
                className="text-[10px] bg-white/10 px-2 py-0.5 rounded hover:bg-white/20"
              >
                Clear
              </button>
              <button
                onClick={() => {
                  const text = logBuffer.map(l => `${l.time} [${l.level}] ${l.msg}`).join("\n");
                  navigator.clipboard?.writeText(text).catch(() => {});
                }}
                className="text-[10px] bg-white/10 px-2 py-0.5 rounded hover:bg-white/20"
              >
                Copy All
              </button>
            </div>
          </div>

          {/* Log entries */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5">
            {logs.length === 0 && (
              <p className="text-gray-500 text-center mt-8">No voice logs yet. Start the assistant to see logs.</p>
            )}
            {logs.map((entry) => (
              <div key={entry.id} className={`flex gap-2 ${levelColor(entry.level)}`}>
                <span className="text-gray-500 flex-shrink-0">{entry.time}</span>
                <span className="break-all">{entry.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
};
