import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic } from "lucide-react";
import { NativeVoiceService } from "../lib/native-voice";
import { AgentforceSession } from "../lib/agentforce-api";
import { apiUrl } from "../lib/api-base";
import { cn } from "../lib/utils";

/**
 * VoiceAssistant V4 — inline popup bar with streaming TTS + speed optimizations.
 *
 * V3 optimizations:
 * - Streaming TTS: audio chunks play as they arrive (~500ms to first audio)
 * - Silence detection: recording stops when user stops speaking
 * - Web Speech API tried first even in PWA mode
 *
 * V4 optimizations:
 * - Pre-warm agent session on mount (saves ~500-1500ms on first tap)
 * - Silence threshold tightened to 500ms
 * - Persona context sent only on first message
 * - Barge-in: user can interrupt playback to speak
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
  const prewarmedAgentRef = useRef<AgentforceSession | null>(null);

  // ─── Pre-warm agent session on mount ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    const prewarm = async () => {
      try {
        const agent = new AgentforceSession();
        await agent.start();
        if (!cancelled) {
          prewarmedAgentRef.current = agent;
          console.log("[voice] Pre-warmed agent session ready");
        } else {
          agent.end();
        }
      } catch (err) {
        console.warn("[voice] Pre-warm failed (will create on tap):", err);
      }
    };
    prewarm();
    return () => { cancelled = true; };
  }, []);

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
        // 1. Use pre-warmed session if available, otherwise create new one
        let agent: AgentforceSession;
        if (prewarmedAgentRef.current?.isActive) {
          agent = prewarmedAgentRef.current;
          prewarmedAgentRef.current = null;
          console.log("[voice] Using pre-warmed agent session");
        } else {
          agent = new AgentforceSession();
          await agent.start();
          console.log("[voice] Created fresh agent session (pre-warm unavailable)");
        }
        agentRef.current = agent;

        // 2. Connect voice service
        await native.connect({
          onOpen: async () => {
            setIsActive(true);
            setIsConnecting(false);
            setIsListening(true);
            setHasError(false);
            hasErrorRef.current = false;

            // Send greeting (persona context is auto-prepended by AgentforceSession)
            try {
              if (agentRef.current?.isActive) {
                setStatus("Getting greeting...");
                const { response: greeting, audioData } = await agentRef.current.sendMessageWithAudio("Hello");
                if (!agentRef.current?.isActive) return;
                await nativeRef.current?.sendGreetingWithAudio(greeting, audioData);
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

            try {
              // Try streaming endpoint first (audio starts playing ~500ms faster)
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), 30000)
              );

              let streamingWorked = false;
              let streamResponse = "";
              let gotFullAudio = false;
              let fullAudioData: ArrayBuffer | undefined;

              try {
                // Start streaming playback on the voice service
                await nativeRef.current?.startStreamingPlayback();

                const { response } = await Promise.race([
                  agentRef.current!.sendMessageStreaming(userText, {
                    onText: (text) => {
                      streamResponse = text;
                      setStatus("Speaking...");
                    },
                    onAudioChunk: (pcmBase64, _index) => {
                      nativeRef.current?.addStreamingChunk(pcmBase64);
                      streamingWorked = true;
                    },
                    onAudioFull: (wavBase64) => {
                      // Fallback: full audio arrived instead of chunks
                      gotFullAudio = true;
                      const binaryStr = atob(wavBase64);
                      const bytes = new Uint8Array(binaryStr.length);
                      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                      fullAudioData = bytes.buffer;
                    },
                  }),
                  timeoutPromise,
                ]);

                streamResponse = response || streamResponse;

                // Wait for streaming audio to finish playing
                if (streamingWorked) {
                  await nativeRef.current?.finishStreamingPlayback();
                } else if (gotFullAudio && fullAudioData) {
                  // Play full audio fallback
                  return { text: streamResponse, audioData: fullAudioData } as any;
                }
              } catch (streamErr: any) {
                console.warn("[voice] Streaming failed, falling back:", streamErr?.message);
                // Fall back to non-streaming endpoint
                const { response, audioData } = await Promise.race([
                  agentRef.current!.sendMessageWithAudio(userText),
                  timeoutPromise,
                ]);
                streamResponse = response;
                fullAudioData = audioData;
                return { text: streamResponse, audioData: fullAudioData } as any;
              }

              const response = streamResponse;

              // Auto-detect order confirmation — ONLY truly final confirmations
              const orderMatch = response.match(/Order[-\s]?#?\s*([\w]+-?\d+)/i)
                || response.match(/(Order-\d{3,5})/i)
                || response.match(/#\s*([\w]+-\d+)/i);

              const isConfirmation = /order\s+(?:has been|is)\s+(?:placed|confirmed)|(?:placed|confirmed|submitted)\s+successfully|order\s+confirmed/i.test(response);

              if (isConfirmation) {
                let finalOrderNumber = orderMatch ? orderMatch[1] : null;

                // If no order number in confirmation, try two fallbacks:
                // 1. Ask the agent for it
                if (!finalOrderNumber && agentRef.current?.isActive) {
                  try {
                    const followUp = await agentRef.current.sendMessage("What is my order number?");
                    const followUpMatch = followUp.match(/Order[-\s]?#?\s*([\w]+-?\d+)/i)
                      || followUp.match(/(Order-\d{3,5})/i)
                      || followUp.match(/#\s*([\w]+-\d+)/i);
                    if (followUpMatch) {
                      finalOrderNumber = followUpMatch[1];
                    }
                  } catch (err) {
                    console.warn("[voice] Order number follow-up failed:", err);
                  }
                }

                // 2. If still no order number, fetch the latest order from Salesforce
                if (!finalOrderNumber) {
                  try {
                    const latestRes = await fetch(apiUrl("/api/latest-order"));
                    if (latestRes.ok) {
                      const latestData = await latestRes.json();
                      if (latestData.orderNumber) {
                        finalOrderNumber = latestData.orderNumber;
                        console.log("[voice] Got latest order from SF:", finalOrderNumber);
                      }
                    }
                  } catch (err) {
                    console.warn("[voice] Latest order lookup failed:", err);
                  }
                }

                onOrderPlaced?.({
                  orderNumber: finalOrderNumber || `Order-0000`,
                  timestamp: new Date(),
                });
              }

              // If streaming worked, audio already played — return text only
              if (streamingWorked) {
                return { text: response, audioData: undefined } as any;
              }
              // Otherwise return with full audio for native-voice to play
              return { text: response, audioData: fullAudioData } as any;
            } catch (err: any) {
              console.warn("[voice] Agent call failed:", err?.message);
              return "I'm sorry, that took too long. Could you try again?";
            }
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
      prewarmedAgentRef.current?.end();
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
