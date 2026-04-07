import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, X, Sparkles } from "lucide-react";
import { NativeVoiceService } from "../lib/native-voice";
import { AgentforceSession } from "../lib/agentforce-api";
import { apiUrl } from "../lib/api-base";
import { cn } from "../lib/utils";
import { useNotifications, parseAgentResponse } from "../lib/notifications";

/**
 * VoiceAssistant V6 — Bottom sheet design matching Screen 4 reference.
 *
 * Features:
 * - Full-screen overlay with blurred background
 * - Bottom sheet with user transcript + agent response cards
 * - Cascading notification integration
 * - All V5 streaming/TTS optimizations preserved
 */

interface VoiceAssistantProps {
  onOrderPlaced?: (order: any) => void;
}

interface ConversationTurn {
  id: string;
  userText: string;
  agentText: string;
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
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [currentUserText, setCurrentUserText] = useState("");

  const { addNotification } = useNotifications();
  const hasErrorRef = useRef(false);
  const nativeRef = useRef<NativeVoiceService | null>(null);
  const agentRef = useRef<AgentforceSession | null>(null);
  const prewarmedAgentRef = useRef<AgentforceSession | null>(null);
  const turnCounter = useRef(0);

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
    if (isActive || hasError || isConnecting) {
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
      setCurrentUserText("");

      try { native?.disconnect(); } catch { /* ignore */ }
      try { agent?.end(); } catch { /* ignore */ }
    } else {
      // ─── Start ────────────────────────────────────────────
      setIsConnecting(true);
      setHasError(false);
      hasErrorRef.current = false;
      setStatus("Connecting...");
      setTurns([]);
      setCurrentUserText("");

      if (nativeRef.current) { nativeRef.current.disconnect(); nativeRef.current = null; }
      if (agentRef.current) { agentRef.current.end(); agentRef.current = null; }

      // iOS PWA FIX: unlockAudio() SYNCHRONOUSLY in tap context
      const native = new NativeVoiceService();
      native.unlockAudio();
      nativeRef.current = native;

      try {
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

        await native.connect({
          onOpen: async () => {
            setIsActive(true);
            setIsConnecting(false);
            setIsListening(true);
            setHasError(false);
            hasErrorRef.current = false;

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
            setCurrentUserText(userText);

            try {
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), 35000)
              );

              let streamingWorked = false;
              let streamResponse = "";
              let fullAudioData: ArrayBuffer | undefined;

              try {
                await nativeRef.current?.startStreamingPlayback();

                const { response } = await Promise.race([
                  agentRef.current!.sendMessageFullStreaming(userText, {
                    onTextChunk: (_chunk, _fullText) => {
                      setStatus("Speaking...");
                    },
                    onTextComplete: (fullText) => {
                      streamResponse = fullText;
                    },
                    onAudioChunk: (pcmBase64, _index, _sentenceIndex) => {
                      nativeRef.current?.addStreamingChunk(pcmBase64);
                      streamingWorked = true;
                    },
                    onDone: (fullText) => {
                      streamResponse = fullText || streamResponse;
                    },
                    onError: (error) => {
                      console.warn("[voice] V5 stream error:", error);
                    },
                  }),
                  timeoutPromise,
                ]);

                streamResponse = response || streamResponse;

                if (streamingWorked) {
                  await nativeRef.current?.finishStreamingPlayback();
                }
              } catch (v5Err: any) {
                console.warn("[voice] V5 streaming failed, trying V3:", v5Err?.message);
                try {
                  await nativeRef.current?.startStreamingPlayback();
                  const { response } = await Promise.race([
                    agentRef.current!.sendMessageStreaming(userText, {
                      onText: (text) => { streamResponse = text; setStatus("Speaking..."); },
                      onAudioChunk: (pcmBase64) => {
                        nativeRef.current?.addStreamingChunk(pcmBase64);
                        streamingWorked = true;
                      },
                      onAudioFull: (wavBase64) => {
                        const binaryStr = atob(wavBase64);
                        const bytes = new Uint8Array(binaryStr.length);
                        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                        fullAudioData = bytes.buffer;
                      },
                    }),
                    timeoutPromise,
                  ]);
                  streamResponse = response || streamResponse;
                  if (streamingWorked) {
                    await nativeRef.current?.finishStreamingPlayback();
                  } else if (fullAudioData) {
                    return { text: streamResponse, audioData: fullAudioData } as any;
                  }
                } catch (v3Err: any) {
                  console.warn("[voice] V3 also failed, trying sync:", v3Err?.message);
                  const { response, audioData } = await Promise.race([
                    agentRef.current!.sendMessageWithAudio(userText),
                    timeoutPromise,
                  ]);
                  streamResponse = response;
                  fullAudioData = audioData;
                  return { text: streamResponse, audioData: fullAudioData } as any;
                }
              }

              const response = streamResponse;

              // Add conversation turn
              const turnId = `turn-${++turnCounter.current}`;
              setTurns(prev => [...prev, { id: turnId, userText, agentText: response }]);
              setCurrentUserText("");

              // Push cascading notification
              const notif = parseAgentResponse(response);
              if (notif) {
                addNotification(notif);
              }

              // Auto-detect order confirmation
              const orderMatch = response.match(/Order[-\s]?#?\s*([\w]+-?\d+)/i)
                || response.match(/(Order-\d{3,5})/i)
                || response.match(/#\s*([\w]+-\d+)/i);

              const isConfirmation = /order\s+(?:has been|is)\s+(?:placed|confirmed)|(?:placed|confirmed|submitted)\s+successfully|order\s+confirmed/i.test(response);

              if (isConfirmation) {
                let finalOrderNumber = orderMatch ? orderMatch[1] : null;

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

                if (!finalOrderNumber) {
                  try {
                    const latestRes = await fetch(apiUrl("/api/latest-order"));
                    if (latestRes.ok) {
                      const latestData = await latestRes.json();
                      if (latestData.orderNumber) {
                        finalOrderNumber = latestData.orderNumber;
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

              if (streamingWorked) {
                return { text: response, audioPlayed: true } as any;
              }
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

  const showOverlay = isActive || isConnecting || hasError;

  return (
    <>
      {/* Floating Mic Button */}
      <AnimatePresence>
        {!showOverlay && (
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

      {/* Full-Screen Bottom Sheet Overlay */}
      <AnimatePresence>
        {showOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex flex-col justify-end"
          >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-primary/40 backdrop-blur-sm" onClick={toggleAssistant} />

            {/* Bottom Sheet Panel */}
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="relative w-full bg-surface-container-lowest rounded-t-[32px] shadow-2xl p-6 pb-36 max-h-[80vh] overflow-y-auto"
            >
              {/* Drag Handle */}
              <div className="w-12 h-1.5 bg-outline-variant/30 rounded-full mx-auto mb-6" />

              {/* Error State */}
              {hasError && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
                  <p className="text-red-700 font-bold text-sm">{status}</p>
                  <button
                    onClick={toggleAssistant}
                    className="mt-2 text-red-600 text-xs font-bold underline"
                  >
                    Tap to close and retry
                  </button>
                </div>
              )}

              {/* Connecting State */}
              {isConnecting && (
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex gap-1">
                    {[0, 1, 2].map(i => (
                      <motion.div
                        key={i}
                        animate={{ y: [0, -8, 0] }}
                        transition={{ repeat: Infinity, duration: 0.6, delay: i * 0.15 }}
                        className="w-2 h-2 bg-secondary rounded-full"
                      />
                    ))}
                  </div>
                  <p className="text-on-surface-variant text-sm font-medium">Connecting to Delta Sky Assistant...</p>
                </div>
              )}

              {/* Conversation History */}
              {turns.map((turn) => (
                <div key={turn.id} className="mb-6">
                  {/* User said */}
                  <div className="mb-2">
                    <p className="text-on-surface-variant text-[10px] font-bold uppercase tracking-widest">You said</p>
                    <p className="text-primary font-medium text-base italic">"{turn.userText}"</p>
                  </div>
                  {/* Agent response */}
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Sparkles size={14} className="text-white" />
                    </div>
                    <div className="flex-1">
                      <p className="text-primary font-medium text-sm leading-relaxed">{turn.agentText}</p>
                    </div>
                  </div>
                </div>
              ))}

              {/* Current user text (while processing) */}
              {currentUserText && (
                <div className="mb-4">
                  <p className="text-on-surface-variant text-[10px] font-bold uppercase tracking-widest">You said</p>
                  <p className="text-primary font-medium text-base italic">"{currentUserText}"</p>
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex gap-1">
                      {[0, 1, 2].map(i => (
                        <motion.div
                          key={i}
                          animate={{ y: [0, -6, 0] }}
                          transition={{ repeat: Infinity, duration: 0.6, delay: i * 0.15 }}
                          className="w-1.5 h-1.5 bg-secondary rounded-full"
                        />
                      ))}
                    </div>
                    <p className="text-on-surface-variant text-xs">{status}</p>
                  </div>
                </div>
              )}

              {/* Listening Indicator */}
              {isListening && !currentUserText && turns.length === 0 && !isConnecting && (
                <div className="flex flex-col items-center py-12 gap-6">
                  <div className="relative">
                    <motion.div
                      animate={{ scale: [1, 1.3, 1] }}
                      transition={{ repeat: Infinity, duration: 2 }}
                      className="w-24 h-24 rounded-full bg-secondary/10 absolute inset-0"
                    />
                    <div className="w-24 h-24 rounded-full bg-primary flex items-center justify-center relative z-10">
                      <Mic size={36} className="text-white" />
                    </div>
                    {/* Volume bars */}
                    <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex gap-0.5 items-end h-4">
                      {[...Array(5)].map((_, i) => (
                        <motion.div
                          key={i}
                          animate={{ height: Math.max(3, volume * (4 + i * 5)) }}
                          transition={{ type: "spring", stiffness: 300, damping: 20 }}
                          className="w-1 bg-secondary rounded-full"
                        />
                      ))}
                    </div>
                  </div>
                  <div className="text-center">
                    <p className="font-headline font-extrabold text-lg text-primary">Listening...</p>
                    <p className="text-on-surface-variant text-xs mt-1">Ask about flights, upgrades, miles, or baggage</p>
                  </div>
                </div>
              )}

              {/* Listening after initial conversation */}
              {isListening && !currentUserText && turns.length > 0 && (
                <div className="flex items-center gap-3 py-4 border-t border-outline-variant/20 mt-4">
                  <div className="flex gap-0.5 items-end h-5">
                    {[...Array(4)].map((_, i) => (
                      <motion.div
                        key={i}
                        animate={{ height: Math.max(4, volume * (6 + i * 6)) }}
                        transition={{ type: "spring", stiffness: 300, damping: 20 }}
                        className="w-1 bg-primary rounded-full"
                      />
                    ))}
                  </div>
                  <p className="text-on-surface-variant text-sm font-medium">Listening for your next question...</p>
                </div>
              )}

              {/* Close Button — always visible */}
              <div className="absolute top-6 right-6">
                <button
                  onClick={toggleAssistant}
                  className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center hover:bg-surface-container-highest transition-colors"
                >
                  <X size={16} className="text-on-surface-variant" />
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
