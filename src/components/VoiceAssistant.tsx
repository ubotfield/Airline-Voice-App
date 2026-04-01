import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic } from "lucide-react";
import { NativeVoiceService } from "../lib/native-voice";
import { AgentforceSession } from "../lib/agentforce-api";
import { cn } from "../lib/utils";

/**
 * VoiceAssistant V2 — inline popup bar.
 *
 * V2 simplification: ALWAYS uses NativeVoiceService (Web Speech API + browser TTS).
 * No Gemini Live WebSocket. No ElevenLabs. Zero external voice API costs.
 */

interface VoiceAssistantProps {
  onOrderPlaced?: (order: any) => void;
}

export const VoiceAssistant: React.FC<VoiceAssistantProps> = ({
  onOrderPlaced,
}) => {
  const [isActive, setIsActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [volume, setVolume] = useState(0);
  const [status, setStatus] = useState("Listening...");
  const [hasError, setHasError] = useState(false);

  const hasErrorRef = useRef(false);
  const nativeRef = useRef<NativeVoiceService | null>(null);
  const agentRef = useRef<AgentforceSession | null>(null);

  const toggleAssistant = async () => {
    if (isActive || hasError) {
      // ─── Stop ─────────────────────────────────────────────
      const native = nativeRef.current;
      const agent = agentRef.current;
      nativeRef.current = null;
      agentRef.current = null;

      setIsActive(false);
      setIsListening(false);
      setIsConnecting(false);
      setHasError(false);
      hasErrorRef.current = false;
      setVolume(0);
      setStatus("Listening...");

      try { native?.disconnect(); } catch { /* ignore */ }
      try { agent?.end(); } catch { /* ignore */ }
    } else {
      // ─── Start ────────────────────────────────────────────
      setIsConnecting(true);
      setHasError(false);
      hasErrorRef.current = false;
      setStatus("Connecting...");

      if (nativeRef.current) { nativeRef.current.disconnect(); nativeRef.current = null; }
      if (agentRef.current) { agentRef.current.end(); agentRef.current = null; }

      // iOS PWA FIX: unlockAudio() SYNCHRONOUSLY in tap context
      const native = new NativeVoiceService();
      native.unlockAudio();
      nativeRef.current = native;

      try {
        // 1. Start Agentforce session
        const agent = new AgentforceSession();
        await agent.start();
        agentRef.current = agent;

        // 2. Connect voice service
        await native.connect({
          onOpen: async () => {
            setIsActive(true);
            setIsConnecting(false);
            setIsListening(true);
            setHasError(false);
            hasErrorRef.current = false;

            // Send greeting
            try {
              if (agentRef.current?.isActive) {
                setStatus("Getting greeting...");
                const greeting = await agentRef.current.sendMessage("Hello");
                if (!agentRef.current?.isActive) return;
                await nativeRef.current?.sendGreeting(greeting);
                setStatus("Listening...");
              }
            } catch (err) {
              console.warn("[voice] Greeting failed (non-fatal):", err);
              setStatus("Listening...");
              if (nativeRef.current) await nativeRef.current.sendGreeting("");
            }
          },
          onClose: () => {
            if (!hasErrorRef.current) {
              setIsActive(false);
              setIsListening(false);
              setIsConnecting(false);
              setVolume(0);
            }
          },
          onError: (err: string) => {
            console.error("[voice] Error:", err);
            setHasError(true);
            hasErrorRef.current = true;
            setIsConnecting(false);
            setIsListening(false);
          },
          onVolumeChange: (v: number) => setVolume(v * 2),
          onStatusChange: (s: string) => setStatus(s),
          onUserTranscription: async (userText: string) => {
            if (!agentRef.current?.isActive) {
              return "I'm sorry, the connection was lost. Please try again.";
            }
            setStatus("Processing...");
            const response = await agentRef.current.sendMessage(userText);
            return response;
          },
        });
      } catch (err: any) {
        const errMsg = err?.message || "Unknown error";
        console.error("[voice] Failed to start:", errMsg);
        setHasError(true);
        hasErrorRef.current = true;
        setIsConnecting(false);
        setIsActive(false);
        setVolume(0);
        setStatus(errMsg.substring(0, 120));
      }
    }
  };

  useEffect(() => {
    return () => {
      nativeRef.current?.disconnect();
      agentRef.current?.end();
    };
  }, []);

  return (
    <>
      {/* Floating Mic Button */}
      <AnimatePresence>
        {!(isActive || isConnecting || hasError) && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="fixed bottom-32 right-6 z-50"
          >
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={toggleAssistant}
              disabled={isConnecting}
              className="relative w-20 h-20 rounded-full flex items-center justify-center shadow-2xl bg-primary text-on-primary"
            >
              <Mic size={32} />
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Voice Status Bar */}
      <AnimatePresence>
        {(isActive || isConnecting || hasError) && (
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            className={cn(
              "fixed bottom-28 left-4 right-4 z-50 px-5 py-4 rounded-2xl shadow-2xl flex items-center gap-3 border",
              hasError ? "border-red-500/50 bg-red-50" : "border-primary/10 bg-surface"
            )}
          >
            <div className="flex gap-1 items-end h-7 flex-shrink-0">
              {[...Array(4)].map((_, i) => (
                <motion.div
                  key={i}
                  animate={{ height: isListening ? Math.max(6, volume * (12 + i * 8)) : 6 }}
                  transition={{ type: "spring", stiffness: 300, damping: 20 }}
                  className={cn("w-1 rounded-full", hasError ? "bg-red-500" : "bg-primary")}
                />
              ))}
            </div>

            <div className="flex-1 min-w-0">
              <p className={cn(
                "font-headline font-black text-xs uppercase tracking-wider leading-tight",
                hasError ? "text-red-600" : "text-primary"
              )}>
                {status}
              </p>
              <p className="text-[10px] text-on-surface/50 font-bold uppercase tracking-tight leading-tight mt-0.5">
                {hasError ? "Tap to reset" : "Say your order"}
              </p>
            </div>

            <button
              onClick={toggleAssistant}
              className={cn(
                "px-4 py-2 rounded-full text-xs font-black uppercase tracking-wider transition-all flex-shrink-0 whitespace-nowrap",
                hasError ? "bg-red-500 text-white" : "bg-primary text-on-primary"
              )}
            >
              {hasError ? "Close" : "Stop"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
