import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Sparkles, Plane, Star, ArrowUpCircle, Luggage } from "lucide-react";
import { MicFilled } from "./icons/MicFilled";
import { NativeVoiceService } from "../lib/native-voice";
import { AgentforceSession } from "../lib/agentforce-api";
import { apiUrl } from "../lib/api-base";
import { cn } from "../lib/utils";
import { useNotifications, parseAgentResponse } from "../lib/notifications";

/**
 * VoiceAssistant V8 — Non-blocking listening + bottom sheet for results.
 *
 * UX model:
 *   - Compact floating bar while listening (no overlay, no blur)
 *   - Bottom sheet with backdrop blur ONLY when results are displayed
 *   - Transitions smoothly between the two states
 */

/* ── Result card type detection ─────────────────────────────── */
type CardType = "flight" | "miles" | "upgrade" | "baggage" | "generic";

interface ParsedCard {
  type: CardType;
  headline: string;
  flight?: { from: string; to: string; number: string; depTime: string; arrTime: string; duration: string; price: string };
  miles?: { balance: string; tier: string; progress?: string };
  upgrade?: { cabin: string; seat: string; cost: string };
  chips: string[];
}

function parseResponseToCard(text: string): ParsedCard {
  const lower = text.toLowerCase();

  // Common matchers used by multiple card types
  const priceMatch = text.match(/\$(\d[\d,]*)/);
  const milesMatch = text.match(/([\d,]+)\s*miles/i);

  // ─── Miles / loyalty detection (BEFORE flight — prevents "missing miles" being shown as flight) ───
  const tierMatch = text.match(/(gold|silver|platinum|diamond)\s*medallion/i);
  const isMilesContext = milesMatch || tierMatch ||
    lower.includes("skymiles") || lower.includes("loyalty") ||
    lower.includes("membership") || lower.includes("missing miles") ||
    lower.includes("miles credited") || lower.includes("mileage") ||
    (lower.includes("account") && lower.includes("miles"));
  if (isMilesContext) {
    return {
      type: "miles",
      headline: milesMatch ? "Your SkyMiles balance." : "Your loyalty status.",
      miles: {
        balance: milesMatch?.[1] || "---",
        tier: tierMatch?.[1] ? `${tierMatch[1]} Medallion` : "",
        progress: "",
      },
      chips: ["Earn more miles", "Redeem miles", "Recent activity"],
    };
  }

  // ─── Flight info detection ───
  const flightMatch = text.match(/DL\s*\d+/i);
  const routeMatch = text.match(/(\b[A-Z]{3})\b.*?(?:to|→|->)\s*(\b[A-Z]{3})\b/i);
  const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/gi);
  const durationMatch = text.match(/(\d+h\s*\d+m|\d+\s*hour)/i);
  const gateMatch = text.match(/gate\s*(\w+)/i);

  if ((lower.includes("flight") || flightMatch) && (routeMatch || lower.includes("on time") || lower.includes("delayed") || gateMatch || timeMatch)) {
    const headline = flightMatch
      ? lower.includes("on time") || lower.includes("delayed") || lower.includes("gate")
        ? `Flight ${flightMatch[0]} status updated.`
        : `I found a flight for you.`
      : "Here's your flight information.";

    const chips: string[] = [];
    if (lower.includes("status") || lower.includes("on time") || lower.includes("delayed")) {
      chips.push("Check gate info", "Notify me of changes", "Seat map");
    } else {
      chips.push("Later flights", "Cheapest first", "Direct only");
    }

    return {
      type: "flight",
      headline,
      flight: {
        from: routeMatch?.[1]?.toUpperCase() || "ATL",
        to: routeMatch?.[2]?.toUpperCase() || "---",
        number: flightMatch?.[0] || "DL ---",
        depTime: timeMatch?.[0] || "--:--",
        arrTime: timeMatch?.[1] || "--:--",
        duration: durationMatch?.[1] || "",
        price: priceMatch ? `$${priceMatch[1]}` : "",
      },
      chips,
    };
  }

  // Upgrade detection
  if (lower.includes("upgrade")) {
    const cabinMatch = text.match(/(first class|delta one|comfort\+|premium select)/i);
    const seatMatch = text.match(/seat\s*(\w+)/i);
    return {
      type: "upgrade",
      headline: lower.includes("confirmed") || lower.includes("complete")
        ? "Your upgrade is confirmed!"
        : "Upgrade options available.",
      upgrade: {
        cabin: cabinMatch?.[1] || "Premium cabin",
        seat: seatMatch?.[1] || "",
        cost: priceMatch ? `$${priceMatch[1]}` : milesMatch ? `${milesMatch[1]} miles` : "",
      },
      chips: ["View seat map", "Upgrade another flight", "Check status"],
    };
  }

  // Baggage detection
  if (lower.includes("bag") || lower.includes("luggage") || lower.includes("checked")) {
    return {
      type: "baggage",
      headline: "Here's your baggage info.",
      chips: ["Track my bag", "Add another bag", "File a claim"],
    };
  }

  // Generic — derive natural chips
  const chips: string[] = [];
  if (lower.includes("help") || lower.includes("can i")) chips.push("Tell me more");
  if (chips.length === 0) chips.push("Tell me more", "Another question");

  return {
    type: "generic",
    headline: "",
    chips,
  };
}

interface VoiceAssistantProps {
  isOpen?: boolean;
  onToggle?: () => void;
  onOrderPlaced?: (order: any) => void;
  onVoiceResult?: (result: { userText: string; agentText: string }) => void;
}

interface ConversationTurn {
  id: string;
  userText: string;
  agentText: string;
}

export const VoiceAssistant: React.FC<VoiceAssistantProps> = ({
  isOpen = false,
  onToggle,
  onOrderPlaced,
  onVoiceResult,
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

  // ─── Respond to external isOpen prop ────────────────────────
  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      if (!isActive && !isConnecting && !hasError) {
        toggleAssistant();
      }
    } else if (!isOpen && prevIsOpenRef.current) {
      if (isActive || isConnecting || hasError) {
        toggleAssistant();
      }
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  const toggleAssistant = async () => {
    if (isActive || hasError || isConnecting) {
      // ─── Stop — UI state FIRST for immediate visual feedback ────
      // Capture refs before clearing so cleanup runs in background
      const native = nativeRef.current;
      const agent = agentRef.current;
      nativeRef.current = null;
      agentRef.current = null;

      // Set UI state IMMEDIATELY — sheet disappears instantly
      setIsActive(false);
      setIsListening(false);
      setIsConnecting(false);
      setHasError(false);
      hasErrorRef.current = false;
      setVolume(0);
      setStatus("Listening...");
      setCurrentUserText("");

      // Fire-and-forget cleanup — don't block the UI
      setTimeout(() => {
        try { native?.disconnect(); } catch { /* ignore */ }
        try { agent?.end(); } catch { /* ignore */ }
      }, 0);

      onToggle?.();
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

                try {
                  let greetingText = "";
                  let streamingWorked = false;

                  await nativeRef.current?.startStreamingPlayback();

                  const { response } = await agentRef.current.sendMessageFullStreaming("Hello", {
                    onTextChunk: () => { setStatus("Speaking..."); },
                    onTextComplete: (fullText) => { greetingText = fullText; },
                    onAudioChunk: (pcmBase64) => {
                      nativeRef.current?.addStreamingChunk(pcmBase64);
                      streamingWorked = true;
                    },
                    onDone: (fullText) => { greetingText = fullText || greetingText; },
                    onError: (error) => { console.warn("[voice] Greeting stream error:", error); },
                  }, { skipFiller: true });

                  greetingText = response || greetingText;

                  if (streamingWorked) {
                    await nativeRef.current?.finishStreamingPlayback();
                  }

                  if (!agentRef.current?.isActive) return;
                  // Greeting audio already played via streaming above — just resume listening
                  await nativeRef.current?.sendGreeting("");
                } catch (streamErr) {
                  console.warn("[voice] Greeting streaming failed, trying sync:", streamErr);
                  const { response: greeting, audioData } = await agentRef.current.sendMessageWithAudio("Hello");
                  if (!agentRef.current?.isActive) return;
                  await nativeRef.current?.sendGreetingWithAudio(greeting, audioData);
                }
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

              // Emit voice result for home screen animation
              onVoiceResult?.({ userText, agentText: response });

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

  // ─── V8 Overlay logic ───────────────────────────────────────
  // Bottom sheet with blur ONLY when there's content to show
  const hasContent = turns.length > 0 || !!currentUserText || hasError;
  const showBottomSheet = isActive && hasContent;
  // Compact floating bar when listening with no content yet
  const showCompactBar = isActive && !hasContent && !isConnecting;

  return (
    <>
      {/* ══════════════════════════════════════════════════════════════
          Connecting indicator — shows during mic permission (no blur)
          ══════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {isConnecting && !isActive && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[99] bg-primary text-white px-5 py-3 rounded-full shadow-xl flex items-center gap-3"
          >
            <div className="flex gap-1">
              {[0, 1, 2].map(i => (
                <motion.div
                  key={i}
                  animate={{ y: [0, -5, 0] }}
                  transition={{ repeat: Infinity, duration: 0.5, delay: i * 0.12 }}
                  className="w-1.5 h-1.5 bg-white rounded-full"
                />
              ))}
            </div>
            <span className="text-sm font-medium">Connecting...</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ══════════════════════════════════════════════════════════════
          V8: Compact floating listening bar — NO overlay, NO blur
          Shows when active but no results yet
          ══════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {showCompactBar && (
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="fixed bottom-24 left-4 right-4 z-[100] bg-surface-container-lowest rounded-2xl shadow-2xl border border-outline-variant/10 px-4 py-3 flex items-center gap-3"
          >
            {/* Pulsing mic icon */}
            <div className="relative flex-shrink-0">
              <motion.div
                animate={{ scale: [1, 1.3, 1], opacity: [0.3, 0.6, 0.3] }}
                transition={{ repeat: Infinity, duration: 2 }}
                className="w-10 h-10 rounded-full bg-secondary/20 absolute inset-0"
              />
              <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center relative z-10">
                <MicFilled size={18} className="text-white" />
              </div>
            </div>

            {/* Status text */}
            <div className="flex-1 min-w-0">
              <p className="font-headline font-extrabold text-sm text-primary truncate">
                {status === "Listening..." || status === "Connected"
                  ? "Listening..."
                  : status === "Speaking..." || status === "Getting greeting..."
                    ? "Speaking..."
                    : status}
              </p>
              <p className="text-on-surface-variant text-xs truncate">Ask about flights, upgrades, miles, or baggage</p>
            </div>

            {/* Volume bars */}
            <div className="flex gap-0.5 items-end h-5 flex-shrink-0">
              {[...Array(4)].map((_, i) => (
                <motion.div
                  key={i}
                  animate={{ height: Math.max(4, volume * (6 + i * 6)) }}
                  transition={{ type: "spring", stiffness: 300, damping: 20 }}
                  className="w-1 bg-secondary rounded-full"
                />
              ))}
            </div>

            {/* Close button */}
            <button
              onClick={toggleAssistant}
              className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center flex-shrink-0 hover:bg-surface-container-highest transition-colors"
            >
              <X size={14} className="text-on-surface-variant" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ══════════════════════════════════════════════════════════════
          V8: Bottom Sheet with backdrop blur — ONLY when showing results
          ══════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {showBottomSheet && (
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

              {/* ── Conversation History with Structured Cards ── */}
              {turns.map((turn) => {
                const card = parseResponseToCard(turn.agentText);
                return (
                  <div key={turn.id} className="mb-6">
                    {/* User said */}
                    <div className="mb-2">
                      <p className="text-on-surface-variant text-[10px] font-bold uppercase tracking-widest">You said</p>
                      <p className="text-primary font-medium text-lg italic">"{turn.userText}"</p>
                    </div>

                    {/* Agent headline */}
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                        <Sparkles size={14} className="text-white" />
                      </div>
                      <h2 className="text-xl font-headline font-extrabold text-primary tracking-tight">
                        {card.headline || turn.agentText.split('.')[0] + '.'}
                      </h2>
                    </div>

                    {/* ─ Flight Card ─ */}
                    {card.type === "flight" && card.flight && (
                      <div className="bg-primary text-white rounded-2xl p-5 shadow-xl border-l-4 border-secondary relative overflow-hidden mb-4">
                        <div className="absolute top-0 right-0 p-4 opacity-10">
                          <Plane size={56} />
                        </div>
                        <div className="relative z-10">
                          <span className="text-[10px] font-black uppercase tracking-[0.2em] bg-secondary px-2 py-1 rounded-sm inline-block mb-3">
                            Top Match
                          </span>
                          <div className="flex items-center gap-4 mb-4">
                            <div>
                              <p className="text-2xl font-black">{card.flight.from}</p>
                              <p className="text-[10px] opacity-70">{card.flight.depTime}</p>
                            </div>
                            <div className="flex flex-col items-center flex-1 px-2">
                              <span className="text-[10px] opacity-60 font-bold mb-1">{card.flight.number}</span>
                              <div className="w-full h-px bg-white/30 relative">
                                <Plane size={12} className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 text-secondary" />
                              </div>
                              {card.flight.duration && (
                                <span className="text-[10px] opacity-60 mt-1">{card.flight.duration}</span>
                              )}
                            </div>
                            <div className="text-right">
                              <p className="text-2xl font-black">{card.flight.to}</p>
                              <p className="text-[10px] opacity-70">{card.flight.arrTime}</p>
                            </div>
                          </div>
                          {card.flight.price && (
                            <div className="flex items-center justify-between pt-4 border-t border-white/10">
                              <div>
                                <span className="text-[10px] opacity-60 uppercase font-bold tracking-wider">Starting at</span>
                                <p className="text-2xl font-black text-primary-fixed-dim">{card.flight.price}</p>
                              </div>
                              <button className="bg-white text-primary px-5 py-2 rounded-lg font-bold text-sm shadow-lg hover:bg-surface-variant transition-colors">
                                Select Flight
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* ─ Miles / Loyalty Card ─ */}
                    {card.type === "miles" && card.miles && (
                      <div className="bg-primary-container rounded-2xl p-5 mb-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Star size={16} className="text-primary-fixed-dim" />
                          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-on-primary-container opacity-80">SkyMiles Medallion</span>
                        </div>
                        {card.miles.balance !== "---" && (
                          <p className="text-3xl font-black text-white mb-1">{card.miles.balance} <span className="text-base font-bold opacity-80">Miles</span></p>
                        )}
                        {card.miles.tier && (
                          <p className="text-sm text-on-primary-container opacity-80 font-medium">{card.miles.tier}</p>
                        )}
                        {!card.miles.balance || card.miles.balance === "---" ? (
                          <p className="text-sm text-on-primary-container/80 font-medium leading-relaxed">{turn.agentText}</p>
                        ) : null}
                      </div>
                    )}

                    {/* ─ Upgrade Card ─ */}
                    {card.type === "upgrade" && card.upgrade && (
                      <div className="bg-surface-container-high rounded-2xl p-5 border-l-4 border-secondary mb-4">
                        <div className="flex items-center gap-2 mb-2">
                          <ArrowUpCircle size={18} className="text-secondary" />
                          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-on-surface-variant">Upgrade</span>
                        </div>
                        <p className="text-lg font-bold text-primary mb-1">{card.upgrade.cabin}</p>
                        {card.upgrade.seat && (
                          <p className="text-sm text-on-surface-variant">Seat {card.upgrade.seat}</p>
                        )}
                        {card.upgrade.cost && (
                          <p className="text-xl font-black text-primary mt-2">{card.upgrade.cost}</p>
                        )}
                      </div>
                    )}

                    {/* ─ Baggage Card ─ */}
                    {card.type === "baggage" && (
                      <div className="bg-surface-container-high rounded-2xl p-5 mb-4">
                        <div className="flex items-center gap-2 mb-2">
                          <Luggage size={18} className="text-primary" />
                          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-on-surface-variant">Baggage</span>
                        </div>
                        <p className="text-sm text-on-surface font-medium leading-relaxed">{turn.agentText}</p>
                      </div>
                    )}

                    {/* ─ Generic response (no special card) ─ */}
                    {card.type === "generic" && !card.headline && (
                      <div className="pl-11">
                        <p className="text-primary font-medium text-sm leading-relaxed">{turn.agentText}</p>
                      </div>
                    )}

                    {/* Quick-action chips */}
                    {card.chips.length > 0 && (
                      <div className="flex gap-2 overflow-x-auto pb-1 mt-3 scrollbar-hide">
                        {card.chips.map((chip) => (
                          <button
                            key={chip}
                            className="whitespace-nowrap px-4 py-2 rounded-full border border-primary/20 text-primary text-xs font-bold hover:bg-primary/5 transition-colors flex-shrink-0"
                          >
                            {chip}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* ── Current user text (while processing) ── */}
              {currentUserText && (
                <div className="mb-4">
                  <p className="text-on-surface-variant text-[10px] font-bold uppercase tracking-widest">You said</p>
                  <p className="text-primary font-medium text-lg italic">"{currentUserText}"</p>
                  <div className="flex items-center gap-2 mt-3">
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
                    <p className="text-on-surface-variant text-xs font-medium">{status}</p>
                  </div>
                </div>
              )}

              {/* ── Compact listening indicator inside bottom sheet (when results exist) ── */}
              {isListening && !currentUserText && turns.length > 0 && (
                <div className="flex items-center gap-3 py-3 mb-4">
                  <div className="relative">
                    <motion.div
                      animate={{ scale: [1, 1.25, 1] }}
                      transition={{ repeat: Infinity, duration: 1.8 }}
                      className="w-10 h-10 rounded-full bg-secondary/10 absolute inset-0"
                    />
                    <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center relative z-10">
                      <MicFilled size={18} className="text-white" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <p className="font-headline font-extrabold text-sm text-primary">
                      Listening for your next question...
                    </p>
                  </div>
                  <div className="flex gap-0.5 items-end h-5 mr-2">
                    {[...Array(4)].map((_, i) => (
                      <motion.div
                        key={i}
                        animate={{ height: Math.max(4, volume * (6 + i * 6)) }}
                        transition={{ type: "spring", stiffness: 300, damping: 20 }}
                        className="w-1 bg-secondary rounded-full"
                      />
                    ))}
                  </div>
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
