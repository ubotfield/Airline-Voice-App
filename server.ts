import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// #10: Connection pooling — Node 24's built-in fetch() uses undici internally
// which maintains a connection pool with keep-alive by default. No extra agent needed.

dotenv.config({ path: ".env.local" });
dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.raw({ type: "audio/*", limit: "10mb" }));

// ─── CORS ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3001;

// ─── Salesforce config ───────────────────────────────────────────
const SF_LOGIN_URL =
  process.env.SF_INSTANCE_URL || process.env.SALESFORCE_ORG_URL || "https://login.salesforce.com";
const SF_CLIENT_ID = (process.env.SF_CLIENT_ID || process.env.SALESFORCE_CLIENT_ID)!;
const SF_CLIENT_SECRET = (process.env.SF_CLIENT_SECRET || process.env.SALESFORCE_CLIENT_SECRET)!;
const SF_AGENT_ID = (process.env.SF_AGENT_ID || process.env.AGENT_ID)!;

// ╔════════════════════════════════════════════════════════════════════╗
// ║ CRITICAL: Agent API calls MUST go to https://api.salesforce.com   ║
// ║ NOT the org instance URL. The org URL returns "URL No Longer       ║
// ║ Exists" for /einstein/ai-agent/v1/* paths. DO NOT CHANGE THIS.    ║
// ╚════════════════════════════════════════════════════════════════════╝
const AGENT_API_BASE = "https://api.salesforce.com";

// ─── Token cache ─────────────────────────────────────────────────
let cachedToken: string | null = null;
let cachedInstanceUrl: string | null = null;
let cachedApiInstanceUrl: string | null = null;
let tokenExpiry = 0;

async function getAccessToken(): Promise<{
  accessToken: string;
  instanceUrl: string;
  apiInstanceUrl: string;
}> {
  if (cachedToken && cachedInstanceUrl && cachedApiInstanceUrl && Date.now() < tokenExpiry - 300_000) {
    return { accessToken: cachedToken, instanceUrl: cachedInstanceUrl, apiInstanceUrl: cachedApiInstanceUrl };
  }

  console.log("[auth] Fetching new access token via Client Credentials...");

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });

  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[auth] Token request failed:", res.status, err);
    throw new Error(`OAuth token request failed: ${res.status} — ${err}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedInstanceUrl = data.instance_url;
  cachedApiInstanceUrl = data.api_instance_url || "https://api.salesforce.com";
  tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000;

  console.log("[auth] Token acquired. Instance URL:", cachedInstanceUrl);
  return { accessToken: cachedToken!, instanceUrl: cachedInstanceUrl!, apiInstanceUrl: cachedApiInstanceUrl! };
}

function invalidateToken() {
  cachedToken = null;
  cachedInstanceUrl = null;
  cachedApiInstanceUrl = null;
  tokenExpiry = 0;
}

async function sfFetch(
  path: string,
  options: RequestInit & { instanceUrl?: string; useApiUrl?: boolean } = {},
  retry = true
): Promise<Response> {
  const { accessToken, instanceUrl } = await getAccessToken();
  const baseUrl = options.useApiUrl ? AGENT_API_BASE : (options.instanceUrl || instanceUrl);
  const url = `${baseUrl}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  });

  if (res.status === 401 && retry) {
    console.log("[auth] 401 received — refreshing token and retrying...");
    invalidateToken();
    return sfFetch(path, options, false);
  }

  return res;
}

// ─── Agent Session Routes ────────────────────────────────────────

app.post("/api/agent/session", async (_req, res) => {
  try {
    const sfRes = await sfFetch(
      `/einstein/ai-agent/v1/agents/${SF_AGENT_ID}/sessions`,
      {
        method: "POST",
        useApiUrl: true,
        body: JSON.stringify({
          externalSessionKey: `scotts-v2-${Date.now()}`,
          instanceConfig: { endpoint: SF_LOGIN_URL },
          streamingCapabilities: { chunkTypes: ["Text"] },
          bypassUser: true,
        }),
      }
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[session] Create failed:", sfRes.status, err);
      return res.status(sfRes.status).json({ error: "Failed to create agent session", detail: err });
    }

    const data = await sfRes.json();
    console.log("[session] Created:", data.sessionId);
    return res.json({ sessionId: data.sessionId });
  } catch (err: any) {
    console.error("[session] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/agent/message", async (req, res) => {
  const { sessionId, message, sequenceId, variables } = req.body;

  if (!sessionId || !message || !sequenceId) {
    return res.status(400).json({ error: "sessionId, message, and sequenceId are required" });
  }

  try {
    const agentStart = Date.now();
    const sfRes = await sfFetch(
      `/einstein/ai-agent/v1/sessions/${sessionId}/messages?sync=true`,
      {
        method: "POST",
        useApiUrl: true,
        body: JSON.stringify({
          message: { sequenceId, type: "Text", text: message },
          variables: variables || [],
        }),
      }
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[message] Send failed:", sfRes.status, err);
      return res.status(sfRes.status).json({ error: "Agent message failed", detail: err });
    }

    const data = await sfRes.json();
    let responseText = "";
    if (data.messages && Array.isArray(data.messages)) {
      responseText = data.messages
        .filter((m: any) => m.type === "Text" || m.type === "Inform")
        .map((m: any) => m.message || m.text || "")
        .join("\n")
        .trim();
    }
    if (!responseText && data.text) responseText = data.text;

    console.log(`[message] Agent responded in ${Date.now() - agentStart}ms:`, responseText.substring(0, 200));
    console.log(`[message] Raw messages:`, JSON.stringify(data.messages?.map((m: any) => ({ type: m.type, msg: (m.message || "").substring(0, 100) })) || "none"));
    return res.json({ response: responseText, raw: data });
  } catch (err: any) {
    console.error("[message] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Combined Agent + TTS endpoint (saves round-trip) ─────────
app.post("/api/agent/speak", async (req, res) => {
  const { sessionId, message, sequenceId, variables } = req.body;
  if (!sessionId || !message || !sequenceId) {
    return res.status(400).json({ error: "sessionId, message, and sequenceId are required" });
  }

  try {
    const totalStart = Date.now();

    // Step 1: Get agent response
    const sfRes = await sfFetch(
      `/einstein/ai-agent/v1/sessions/${sessionId}/messages?sync=true`,
      {
        method: "POST",
        useApiUrl: true,
        body: JSON.stringify({
          message: { sequenceId, type: "Text", text: message },
          variables: variables || [],
        }),
      }
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[speak] Agent failed:", sfRes.status, err);
      return res.status(sfRes.status).json({ error: "Agent message failed", detail: err });
    }

    const data = await sfRes.json();
    let responseText = "";
    if (data.messages && Array.isArray(data.messages)) {
      responseText = data.messages
        .filter((m: any) => m.type === "Text" || m.type === "Inform")
        .map((m: any) => m.message || m.text || "")
        .join("\n")
        .trim();
    }
    if (!responseText && data.text) responseText = data.text;

    const agentMs = Date.now() - totalStart;
    console.log(`[speak] Agent: ${agentMs}ms — "${responseText.substring(0, 80)}..."`);

    // Step 2: Generate TTS audio (in parallel with response)
    const selectedVoice = LLM_GW_VOICE;
    let audioBase64: string | null = null;

    if (responseText && process.env.GEMINI_API_KEY) {
      try {
        const ttsStart = Date.now();
        const wavBuffer = await synthesizeViaGeminiAPI(responseText, selectedVoice);
        console.log(`[speak] TTS: ${Date.now() - ttsStart}ms, ${wavBuffer.length}B`);
        audioBase64 = wavBuffer.toString("base64");
      } catch (ttsErr: any) {
        console.error("[speak] TTS failed (will send text-only):", ttsErr.message);
      }
    }

    console.log(`[speak] Total: ${Date.now() - totalStart}ms`);
    return res.json({
      response: responseText,
      audio: audioBase64,
      audioType: "audio/wav",
      raw: data,
    });
  } catch (err: any) {
    console.error("[speak] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Streaming Agent + TTS (SSE — audio chunks arrive as they generate) ─────
app.post("/api/agent/speak-stream", async (req, res) => {
  const { sessionId, message, sequenceId, variables } = req.body;
  if (!sessionId || !message || !sequenceId) {
    return res.status(400).json({ error: "sessionId, message, and sequenceId are required" });
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders();

  try {
    const totalStart = Date.now();

    // Step 1: Get agent response (same as before)
    const sfRes = await sfFetch(
      `/einstein/ai-agent/v1/sessions/${sessionId}/messages?sync=true`,
      {
        method: "POST",
        useApiUrl: true,
        body: JSON.stringify({
          message: { sequenceId, type: "Text", text: message },
          variables: variables || [],
        }),
      }
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[speak-stream] Agent failed:", sfRes.status, err);
      res.write(`data: ${JSON.stringify({ type: "error", error: "Agent message failed" })}\n\n`);
      return res.end();
    }

    const data = await sfRes.json();
    let responseText = "";
    if (data.messages && Array.isArray(data.messages)) {
      responseText = data.messages
        .filter((m: any) => m.type === "Text" || m.type === "Inform")
        .map((m: any) => m.message || m.text || "")
        .join("\n")
        .trim();
    }
    if (!responseText && data.text) responseText = data.text;

    const agentMs = Date.now() - totalStart;
    console.log(`[speak-stream] Agent: ${agentMs}ms — "${responseText.substring(0, 80)}..."`);

    // Send agent text immediately so client can show it
    res.write(`data: ${JSON.stringify({ type: "text", response: responseText, raw: data })}\n\n`);

    // Step 2: Stream TTS audio via Gemini API
    if (responseText && process.env.GEMINI_API_KEY) {
      const ttsStart = Date.now();
      const selectedVoice = LLM_GW_VOICE;

      try {
        // Try each TTS model in fallback chain
        let ttsSuccess = false;
        for (const model of TTS_MODELS) {
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
            const ttsRes = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: TTS_STYLE_PREFIX + responseText }] }],
                generationConfig: {
                  responseModalities: ["AUDIO"],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName: selectedVoice },
                    },
                  },
                },
              }),
            });

            if (ttsRes.ok && ttsRes.body) {
              const reader = ttsRes.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              let chunkCount = 0;

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  const jsonStr = line.slice(6).trim();
                  if (!jsonStr || jsonStr === "[DONE]") continue;

                  try {
                    const chunk = JSON.parse(jsonStr);
                    const audioB64 = chunk?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                    if (audioB64) {
                      chunkCount++;
                      res.write(`data: ${JSON.stringify({ type: "audio", chunk: audioB64, index: chunkCount })}\n\n`);
                    }
                  } catch { /* skip malformed JSON */ }
                }
              }

              console.log(`[speak-stream] TTS ${model}: ${Date.now() - ttsStart}ms, ${chunkCount} chunks`);
              ttsSuccess = true;
              break; // success — stop trying models
            } else {
              console.warn(`[speak-stream] TTS ${model} failed: HTTP ${ttsRes.status}`);
              continue; // try next model
            }
          } catch (modelErr: any) {
            console.warn(`[speak-stream] TTS ${model} error: ${modelErr.message}`);
            continue; // try next model
          }
        }

        if (!ttsSuccess) {
          console.error("[speak-stream] All streaming TTS models failed");
          // Fall back to non-streaming TTS (which also has model fallback)
          try {
            const wavBuffer = await synthesizeViaGeminiAPI(responseText, selectedVoice);
            const audioBase64 = wavBuffer.toString("base64");
            res.write(`data: ${JSON.stringify({ type: "audio-full", audio: audioBase64 })}\n\n`);
            console.log(`[speak-stream] Fallback TTS: ${Date.now() - ttsStart}ms, ${wavBuffer.length}B`);
          } catch (fallbackErr: any) {
            console.error("[speak-stream] Fallback TTS also failed:", fallbackErr.message);
          }
        }
      } catch (ttsErr: any) {
        console.error("[speak-stream] TTS error:", ttsErr.message);
        // Fall back to non-streaming
        try {
          const wavBuffer = await synthesizeViaGeminiAPI(responseText, selectedVoice);
          res.write(`data: ${JSON.stringify({ type: "audio-full", audio: wavBuffer.toString("base64") })}\n\n`);
        } catch { /* give up on audio */ }
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done", totalMs: Date.now() - totalStart })}\n\n`);
    console.log(`[speak-stream] Total: ${Date.now() - totalStart}ms`);
    return res.end();
  } catch (err: any) {
    console.error("[speak-stream] Error:", err.message);
    try {
      res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    } catch { /* ignore */ }
    return res.end();
  }
});

// ─── V6: Parallel TTS + Eager First-Fragment + Thinking Filler ─────────────
// Changes from V5:
//   #1: Parallel TTS — sentences TTS'd concurrently, tagged with sentenceIndex
//       for client-side ordered playback (saves ~1-3s per turn)
//   #2: Eager first-fragment — fires TTS on first comma/semicolon if >10 chars
//       or after 5+ words (saves ~500-1500ms to first audio)
//   #3: Thinking filler — pre-cached "One moment" audio sent immediately
//       (saves ~1-2s perceived latency)
//   #9: Timing instrumentation — logs firstTextChunkTime, firstAudioSentTime, total
app.post("/api/agent/message-stream", async (req, res) => {
  const { sessionId, message, sequenceId, variables } = req.body;
  if (!sessionId || !message || !sequenceId) {
    return res.status(400).json({ error: "sessionId, message, and sequenceId are required" });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const totalStart = Date.now();
    let firstTextChunkTime = 0;
    let firstAudioSentTime = 0;
    console.log(`[msg-stream] Starting streaming for session ${sessionId}`);

    // #3: Send thinking filler audio immediately (if cached)
    // Skip filler for greetings — the "One moment" audio shouldn't play as the first thing a user hears
    const skipFiller = req.body.skipFiller === true;
    console.log(`[msg-stream] skipFiller=${skipFiller}, fillerCached=${!!thinkingFillerAudio}, GEMINI_KEY=${!!process.env.GEMINI_API_KEY}`);
    console.log(`[msg-stream] Message: "${message}", Variables: ${JSON.stringify(variables || [])}`);

    if (thinkingFillerAudio && !skipFiller) {
      res.write(`data: ${JSON.stringify({ type: "audio", chunk: thinkingFillerAudio, index: 0, sentenceIndex: -1 })}\n\n`);
      firstAudioSentTime = Date.now() - totalStart;
      console.log(`[msg-stream] Thinking filler sent at +${firstAudioSentTime}ms`);
    }

    // POST to /messages/stream — the real Agentforce SSE endpoint
    const { accessToken } = await getAccessToken();
    const sfRes = await fetch(
      `${AGENT_API_BASE}/einstein/ai-agent/v1/sessions/${sessionId}/messages/stream`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          message: { sequenceId, type: "Text", text: message },
          variables: variables || [],
        }),
      }
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[msg-stream] Agent stream failed:", sfRes.status, err);
      res.write(`data: ${JSON.stringify({ type: "fallback", reason: `Agent stream ${sfRes.status}` })}\n\n`);
      return await handleSyncFallback(res, sessionId, message, sequenceId, variables, totalStart);
    }

    if (!sfRes.body) {
      console.warn("[msg-stream] No response body — falling back to sync");
      res.write(`data: ${JSON.stringify({ type: "fallback", reason: "No stream body" })}\n\n`);
      return await handleSyncFallback(res, sessionId, message, sequenceId, variables, totalStart);
    }

    // Read the SSE stream from Agentforce
    const reader = sfRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let sentenceBuffer = "";
    let fullText = "";
    let sentenceIndex = 0;
    let wordCount = 0;
    let firstFragmentFired = false;
    const ttsPromises: Promise<void>[] = []; // #1: Parallel — collect all promises

    // #1: Fire TTS in parallel (no sequential chain). Client buffers by sentenceIndex.
    const fireTtsForSentence = (sentence: string, sIdx: number) => {
      if (!sentence.trim() || !process.env.GEMINI_API_KEY) {
        console.log(`[msg-stream] fireTtsForSentence: SKIPPED (empty=${!sentence.trim()}, noKey=${!process.env.GEMINI_API_KEY})`);
        return;
      }
      const normalizedSentence = normalizeTtsText(sentence);
      console.log(`[msg-stream] fireTtsForSentence ${sIdx}: "${normalizedSentence.substring(0, 60)}..."`);
      const ttsPromise = (async () => {
        // Try each model in the fallback chain
        for (const model of TTS_MODELS) {
          try {
            const ttsStart = Date.now();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
            const ttsController = new AbortController();
            const ttsTimeout = setTimeout(() => ttsController.abort(), 15000);
            const ttsRes = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: ttsController.signal,
              body: JSON.stringify({
                contents: [{ parts: [{ text: TTS_STYLE_PREFIX + normalizedSentence }] }],
                generationConfig: {
                  responseModalities: ["AUDIO"],
                  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LLM_GW_VOICE } } },
                },
              }),
            });
            clearTimeout(ttsTimeout);

            console.log(`[msg-stream] TTS ${model} sentence ${sIdx}: HTTP ${ttsRes.status}`);
            if (ttsRes.ok && ttsRes.body) {
              const ttsReader = ttsRes.body.getReader();
              const ttsDecoder = new TextDecoder();
              let ttsBuf = "";
              let chunkIdx = 0;
              while (true) {
                const { done, value } = await ttsReader.read();
                if (done) break;
                ttsBuf += ttsDecoder.decode(value, { stream: true });
                const ttsLines = ttsBuf.split("\n");
                ttsBuf = ttsLines.pop() || "";
                for (const ttsLine of ttsLines) {
                  if (!ttsLine.startsWith("data: ")) continue;
                  const jsonStr = ttsLine.slice(6).trim();
                  if (!jsonStr || jsonStr === "[DONE]") continue;
                  try {
                    const chunk = JSON.parse(jsonStr);
                    const audioB64 = chunk?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                    if (audioB64) {
                      chunkIdx++;
                      if (!firstAudioSentTime) firstAudioSentTime = Date.now() - totalStart;
                      res.write(`data: ${JSON.stringify({ type: "audio", chunk: audioB64, index: chunkIdx, sentenceIndex: sIdx })}\n\n`);
                    }
                  } catch { /* skip */ }
                }
              }
              console.log(`[msg-stream] TTS sentence ${sIdx}: ${chunkIdx} chunks in ${Date.now() - ttsStart}ms (${model})`);
              return; // success — exit the model loop
            } else {
              const errBody = await ttsRes.text().catch(() => "");
              console.warn(`[msg-stream] TTS ${model} FAILED sentence ${sIdx}: HTTP ${ttsRes.status} — ${errBody.substring(0, 200)}`);
              continue; // try next model
            }
          } catch (err: any) {
            console.warn(`[msg-stream] TTS ${model} error sentence ${sIdx}: ${err.message}`);
            continue; // try next model
          }
        }
        console.warn(`[msg-stream] All TTS models failed for sentence ${sIdx}`);
      })();
      ttsPromises.push(ttsPromise);
    };

    // Parse Agentforce SSE events
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim() || line.startsWith(":")) continue;
        if (line.startsWith("event:")) continue;

        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const msgType = parsed.message?.type;
            // Log ALL agent SSE events so we can diagnose routing/planner issues
            console.log(`[msg-stream] Agent SSE: type=${msgType}, msg="${(parsed.message?.message || "").substring(0, 120)}"`);

            if (msgType === "TextChunk") {
              const chunkText = parsed.message?.message || "";
              if (!firstTextChunkTime) firstTextChunkTime = Date.now() - totalStart;
              fullText += chunkText;
              sentenceBuffer += chunkText;
              wordCount += (chunkText.match(/\s+/g) || []).length;

              // Forward text chunk to client for UI updates
              res.write(`data: ${JSON.stringify({ type: "text-chunk", text: chunkText, fullText })}\n\n`);

              // #2: Eager first-fragment — fire TTS on first comma/semicolon if >10 chars or 5+ words
              if (!firstFragmentFired) {
                const eagerMatch = sentenceBuffer.match(/^(.{10,}?[,;:])\s*/s);
                const hasEnoughWords = wordCount >= 5 && sentenceBuffer.length > 10;
                if (eagerMatch) {
                  const fragment = eagerMatch[1].trim();
                  sentenceBuffer = sentenceBuffer.slice(eagerMatch[0].length);
                  console.log(`[msg-stream] Eager fragment ${sentenceIndex}: "${fragment.substring(0, 60)}..."`);
                  fireTtsForSentence(fragment, sentenceIndex);
                  sentenceIndex++;
                  firstFragmentFired = true;
                  wordCount = 0;
                } else if (hasEnoughWords) {
                  // Fire on word boundary after 5+ words
                  const wordBoundary = sentenceBuffer.lastIndexOf(" ");
                  if (wordBoundary > 10) {
                    const fragment = sentenceBuffer.substring(0, wordBoundary).trim();
                    sentenceBuffer = sentenceBuffer.substring(wordBoundary);
                    console.log(`[msg-stream] Eager word-break ${sentenceIndex}: "${fragment.substring(0, 60)}..."`);
                    fireTtsForSentence(fragment, sentenceIndex);
                    sentenceIndex++;
                    firstFragmentFired = true;
                    wordCount = 0;
                  }
                }
              }

              // Check for complete sentence (standard detection)
              const sentenceMatch = sentenceBuffer.match(/^(.*?[.!?\n])\s*/s);
              if (sentenceMatch) {
                const completeSentence = sentenceMatch[1].trim();
                sentenceBuffer = sentenceBuffer.slice(sentenceMatch[0].length);
                if (completeSentence.length > 0) {
                  console.log(`[msg-stream] Sentence ${sentenceIndex}: "${completeSentence.substring(0, 60)}..."`);
                  fireTtsForSentence(completeSentence, sentenceIndex);
                  sentenceIndex++;
                  firstFragmentFired = true; // After first full sentence, no longer eager
                  wordCount = 0;
                }
              }
            } else if (msgType === "Inform") {
              const informText = parsed.message?.message || "";
              if (informText && !fullText) fullText = informText;
              res.write(`data: ${JSON.stringify({ type: "text-complete", fullText: fullText || informText })}\n\n`);
            } else if (msgType === "EndOfTurn") {
              // Flush remaining sentence buffer
              if (sentenceBuffer.trim().length > 0) {
                console.log(`[msg-stream] Final sentence ${sentenceIndex}: "${sentenceBuffer.trim().substring(0, 60)}..."`);
                fireTtsForSentence(sentenceBuffer.trim(), sentenceIndex);
                sentenceIndex++;
                sentenceBuffer = "";
              }
            }
          } catch { /* skip malformed JSON */ }
        }
      }
    }

    // #1: Wait for ALL parallel TTS calls to complete
    await Promise.all(ttsPromises);

    const totalMs = Date.now() - totalStart;
    // #9: Timing instrumentation
    console.log(`[msg-stream] ⏱ Complete: total=${totalMs}ms firstText=+${firstTextChunkTime}ms firstAudio=+${firstAudioSentTime}ms sentences=${sentenceIndex} text="${fullText.substring(0, 80)}..."`);
    res.write(`data: ${JSON.stringify({ type: "done", fullText, totalMs, sentences: sentenceIndex, timing: { firstTextChunkTime, firstAudioSentTime } })}\n\n`);
    return res.end();
  } catch (err: any) {
    console.error("[msg-stream] Error:", err.message);
    try {
      res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    } catch { /* ignore */ }
    return res.end();
  }
});

// Sync fallback for when streaming agent API fails
async function handleSyncFallback(
  res: any, sessionId: string, message: string, sequenceId: number,
  variables: any, totalStart: number
) {
  try {
    const sfRes = await sfFetch(
      `/einstein/ai-agent/v1/sessions/${sessionId}/messages?sync=true`,
      {
        method: "POST",
        useApiUrl: true,
        body: JSON.stringify({
          message: { sequenceId, type: "Text", text: message },
          variables: variables || [],
        }),
      }
    );

    if (!sfRes.ok) {
      res.write(`data: ${JSON.stringify({ type: "error", error: "Agent sync also failed" })}\n\n`);
      return res.end();
    }

    const data = await sfRes.json();
    let responseText = "";
    if (data.messages && Array.isArray(data.messages)) {
      responseText = data.messages
        .filter((m: any) => m.type === "Text" || m.type === "Inform")
        .map((m: any) => m.message || m.text || "")
        .join("\n")
        .trim();
    }
    if (!responseText && data.text) responseText = data.text;

    res.write(`data: ${JSON.stringify({ type: "text-complete", fullText: responseText })}\n\n`);

    // TTS the full response — with model fallback
    if (responseText && process.env.GEMINI_API_KEY) {
      let ttsSuccess = false;
      for (const model of TTS_MODELS) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
          const ttsRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: TTS_STYLE_PREFIX + responseText }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LLM_GW_VOICE } } },
              },
            }),
          });

          if (!ttsRes.ok) {
            console.warn(`[sync-fallback] TTS model ${model} returned ${ttsRes.status}, trying next...`);
            continue;
          }

          if (ttsRes.body) {
            const ttsReader = ttsRes.body.getReader();
            const ttsDecoder = new TextDecoder();
            let ttsBuf = "";
            let chunkIdx = 0;
            while (true) {
              const { done, value } = await ttsReader.read();
              if (done) break;
              ttsBuf += ttsDecoder.decode(value, { stream: true });
              const ttsLines = ttsBuf.split("\n");
              ttsBuf = ttsLines.pop() || "";
              for (const ttsLine of ttsLines) {
                if (!ttsLine.startsWith("data: ")) continue;
                try {
                  const chunk = JSON.parse(ttsLine.slice(6).trim());
                  const audioB64 = chunk?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                  if (audioB64) {
                    chunkIdx++;
                    res.write(`data: ${JSON.stringify({ type: "audio", chunk: audioB64, index: chunkIdx, sentenceIndex: 0 })}\n\n`);
                  }
                } catch { /* skip */ }
              }
            }
            ttsSuccess = true;
            break; // success — stop trying models
          }
        } catch (ttsErr: any) {
          console.warn(`[sync-fallback] TTS model ${model} error: ${ttsErr.message}, trying next...`);
          continue;
        }
      }
      if (!ttsSuccess) console.warn("[sync-fallback] All TTS models failed for full-response TTS");
    }

    res.write(`data: ${JSON.stringify({ type: "done", fullText: responseText, totalMs: Date.now() - totalStart, sentences: 1 })}\n\n`);
    return res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    return res.end();
  }
}

// ─── Demo Booking Reset ──────────────────────────────────────────
// After each session ends, revert the demo booking to Main Cabin / 28C
// so the upgrade scenario works fresh every time.
const DEMO_BOOKING_ID = process.env.DEMO_BOOKING_ID || "a2tHn000002qnDnIAI";
const DEMO_CABIN_DEFAULT = "Main Cabin";
const DEMO_SEAT_DEFAULT = "28C";

async function resetDemoBooking(): Promise<void> {
  try {
    // Step 1: Reset the booking record to Economy/Main Cabin
    const patchRes = await sfFetch(
      `/services/data/v62.0/sobjects/Booking__c/${DEMO_BOOKING_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          Cabin__c: DEMO_CABIN_DEFAULT,
          Seat__c: DEMO_SEAT_DEFAULT,
          Boarding_Group__c: "Group 5",
        }),
      }
    );
    if (!patchRes.ok && patchRes.status !== 204) {
      const err = await patchRes.text();
      console.error(`[demo-reset] Booking PATCH failed (${patchRes.status}):`, err);
      return;
    }
    console.log(`[demo-reset] ✅ Booking reset to ${DEMO_CABIN_DEFAULT} / ${DEMO_SEAT_DEFAULT}`);

    // Step 2: Try to reset seat map entries (best effort)
    // Find seat map records for the demo flight and reset them
    try {
      const seatQuery = encodeURIComponent(
        `SELECT Id, Seat_Number__c, Status__c, Cabin__c FROM Seat_Map__c WHERE Flight__c IN (SELECT Flight__c FROM Booking__c WHERE Id = '${DEMO_BOOKING_ID}') AND (Seat_Number__c = '${DEMO_SEAT_DEFAULT}' OR Seat_Number__c = '2A') LIMIT 10`
      );
      const seatRes = await sfFetch(`/services/data/v62.0/query/?q=${seatQuery}`);
      if (seatRes.ok) {
        const seatData = await seatRes.json();
        for (const seat of (seatData.records || [])) {
          // Mark the old economy seat (28C) as Occupied (it's the demo passenger's seat)
          // Mark any upgraded seat (like 2A) as Available
          const newStatus = seat.Seat_Number__c === DEMO_SEAT_DEFAULT ? "Occupied" : "Available";
          if (seat.Status__c !== newStatus) {
            await sfFetch(`/services/data/v62.0/sobjects/Seat_Map__c/${seat.Id}`, {
              method: "PATCH",
              body: JSON.stringify({ Status__c: newStatus }),
            });
            console.log(`[demo-reset] Seat ${seat.Seat_Number__c}: ${seat.Status__c} → ${newStatus}`);
          }
        }
      }
    } catch (seatErr: any) {
      console.log("[demo-reset] Seat map reset skipped:", seatErr.message);
    }
  } catch (err: any) {
    console.error("[demo-reset] Error:", err.message);
  }
}

// Also expose as an API endpoint for manual reset
app.post("/api/demo-reset", async (_req, res) => {
  try {
    await resetDemoBooking();
    res.json({ success: true, message: `Booking reset to ${DEMO_CABIN_DEFAULT} / ${DEMO_SEAT_DEFAULT}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// CRITICAL: Agent API DELETE must NOT have a body or Content-Type header
app.delete("/api/agent/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  // ── Demo Reset: ALWAYS revert booking to pre-upgrade state ──────────
  // Fire reset regardless of whether session DELETE succeeds, because
  // the Agent API often returns 400 "arg2 must not be null" on session end.
  resetDemoBooking().catch(err => console.error("[demo-reset] Background reset failed:", err.message));

  try {
    const { accessToken } = await getAccessToken();
    const sfRes = await fetch(
      `${AGENT_API_BASE}/einstein/ai-agent/v1/sessions/${sessionId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[session] End failed:", sfRes.status, err);
      // Still return success to the client — the session is effectively over
      // and the demo reset has already been triggered.
      return res.json({ success: true, warning: "Session cleanup had issues but demo was reset" });
    }

    console.log("[session] Ended:", sessionId);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[session] Error:", err.message);
    // Even on error, return success since demo reset was triggered
    return res.json({ success: true, warning: "Session end failed but demo was reset" });
  }
});

// ─── Menu Route (with 5-minute cache) ────────────────────────────

let menuCache: { data: any; expiry: number } | null = null;
const MENU_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get("/api/menu", async (_req, res) => {
  // Return cached data if still fresh
  if (menuCache && Date.now() < menuCache.expiry) {
    return res.json(menuCache.data);
  }

  try {
    const query = encodeURIComponent(
      "SELECT Id, Name, Price__c, Description__c, Calories__c, Is_Popular__c, Is_Available__c, Customizations__c, Menu_Category__r.Name FROM Menu_Item__c WHERE Is_Available__c = true ORDER BY Menu_Category__r.Sort_Order__c, Is_Popular__c DESC, Name ASC"
    );
    const sfRes = await sfFetch(`/services/data/v62.0/query/?q=${query}`);

    if (!sfRes.ok) {
      return res.json({ items: getStaticMenu(), source: "static" });
    }

    const data = await sfRes.json();
    const items = (data.records || []).map((r: any) => ({
      id: r.Id,
      name: r.Name,
      price: r.Price__c,
      description: r.Description__c,
      category: r.Menu_Category__r?.Name || "Other",
      calories: r.Calories__c,
      isPopular: r.Is_Popular__c || false,
      available: r.Is_Available__c,
      customizations: r.Customizations__c ? JSON.parse(r.Customizations__c) : null,
    }));
    const result = { items, source: "salesforce" };
    menuCache = { data: result, expiry: Date.now() + MENU_CACHE_TTL };
    return res.json(result);
  } catch (err: any) {
    console.error("[menu] Error:", err.message);
    return res.json({ items: getStaticMenu(), source: "static" });
  }
});

// ─── STT Post-Processing: Normalize phonetic letter patterns to alphanumeric codes ─

const PHONETIC_MAP: Record<string, string> = {
  you: "U", bee: "B", be: "B", see: "C", sea: "C", are: "R", ay: "A",
  dee: "D", ee: "E", ef: "F", jay: "J", kay: "K", em: "M", en: "N",
  oh: "O", pee: "P", que: "Q", es: "S", tea: "T", tee: "T",
  "double you": "W", "double-you": "W", ex: "X", why: "Y", zee: "Z", zed: "Z",
  // Common single-letter sounds that Gemini might output as words
  aye: "A", el: "L", eye: "I", aitch: "H", ach: "H",
};

/**
 * Post-process STT output to fix common phonetic→letter misinterpretations.
 * Examples:
 *   "you bee four one three" → "UB413"
 *   "you be 413" → "UB413"
 *   "delta 1234" → "DL1234" (airline code normalization)
 */
function normalizeSTTAlphanumeric(text: string): string {
  if (!text) return text;
  let result = text.trim();

  // Step 1: Replace multi-word phonetics first ("double you" → "W")
  for (const [phonetic, letter] of Object.entries(PHONETIC_MAP)) {
    if (phonetic.includes(" ") || phonetic.includes("-")) {
      const regex = new RegExp(`\\b${phonetic.replace("-", "[\\s-]")}\\b`, "gi");
      result = result.replace(regex, letter);
    }
  }

  // Step 2: Check if the text looks like a letter-by-letter spelling
  // Pattern: sequence of single letters/phonetics with spaces or dashes
  const words = result.split(/[\s-]+/);
  const isSpelling = words.length >= 2 && words.every(w => {
    const lower = w.toLowerCase();
    return (
      w.length === 1 || // single character
      /^\d+$/.test(w) || // digits
      PHONETIC_MAP[lower] !== undefined || // phonetic word
      /^[a-zA-Z]$/.test(w) // single letter
    );
  });

  if (isSpelling) {
    // Convert each word to its letter/digit equivalent
    result = words.map(w => {
      if (/^\d+$/.test(w)) return w; // keep digit sequences
      if (w.length === 1) return w.toUpperCase(); // single letter
      return PHONETIC_MAP[w.toLowerCase()] || w.toUpperCase();
    }).join("");
    console.log(`[stt-normalize] Detected spelling pattern: "${text}" → "${result}"`);
  } else {
    // Step 3: For non-spelling text, still replace isolated phonetic words
    // that are clearly letter references (e.g., "you bee 413" → "UB413")
    // Only if text is short (likely a code, not a sentence)
    if (words.length <= 5) {
      let hasPhonetic = false;
      const mapped = words.map(w => {
        const lower = w.toLowerCase();
        if (PHONETIC_MAP[lower] && w.length > 1) {
          hasPhonetic = true;
          return PHONETIC_MAP[lower];
        }
        return w;
      });
      if (hasPhonetic) {
        const combined = mapped.join("");
        // Only use combined form if it looks like a code (alphanumeric, no spaces needed)
        if (/^[A-Z0-9]+$/i.test(combined) && combined.length <= 10) {
          result = combined.toUpperCase();
          console.log(`[stt-normalize] Short code normalization: "${text}" → "${result}"`);
        }
      }
    }
  }

  return result;
}

// ─── STT: Gemini (server-side fallback for platforms without Web Speech API) ─

app.post("/api/stt", async (req, res) => {
  const { audio, mimeType, context } = req.body;
  if (!audio) return res.status(400).json({ error: "audio (base64) is required" });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(503).json({ error: "STT not configured" });

  // Normalize MIME type — strip codec params and map iOS types
  let normalizedMime = (mimeType || "audio/webm").split(";")[0].trim();
  // iOS Safari MediaRecorder produces audio/mp4 (AAC) — Gemini accepts this directly
  console.log(`[stt] Received ${Math.round(audio.length * 0.75 / 1024)}KB audio, mime=${mimeType} → ${normalizedMime}, context=${context || "none"}`);

  // Build context-aware hint for the system instruction
  let contextHint = "";
  if (context === "mileage-number") {
    contextHint = " CONTEXT: The agent just asked for a SkyMiles/mileage membership number. The user will say a SHORT code — typically 3 to 6 characters (digits like '12345' or alphanumeric like 'AB123'). CRITICAL: Transcribe ONLY the exact digits/letters spoken. Do NOT pad, extend, or add extra digits. If the user says five digits, output exactly five digits. Never output more characters than were actually spoken.";
  } else if (context === "confirmation-code") {
    contextHint = " CONTEXT: The agent just asked for a confirmation/booking code. The user is likely speaking a 6-character alphanumeric code. Prioritize interpreting the audio as a PNR code.";
  } else if (context === "flight-number") {
    contextHint = " CONTEXT: The agent just asked for a flight number. The user is likely saying something like 'DL1234' or 'Delta 1234'. Prioritize interpreting the audio as a flight number.";
  }

  try {
    const sttStart = Date.now();
    // Use gemini-2.5-flash with thinking disabled for STT
    const sttModel = "gemini-2.5-flash";
    const baseInstruction = "You are a speech-to-text transcription engine for a Delta Air Lines voice assistant. Transcribe the audio EXACTLY as spoken — output only the verbatim spoken words. Never add commentary, never refuse, never say you cannot transcribe. ABSOLUTE RULE: Never invent, pad, or hallucinate extra letters or digits beyond what was actually spoken. If the speaker says 5 digits, output exactly 5 digits — never 10. CRITICAL RULES: 1) Users may say flight numbers ('DL1234'), SkyMiles numbers (short codes, typically 3-6 characters like '12345'), or confirmation codes (6-character like 'WXMB33'). 2) If spelling out letters one-by-one ('A-B-1-2-3'), combine into a single code ('AB123'). 3) Transcribe numbers as digits ('12345' not 'twelve thousand'). 4) Phonetic alphabet: 'you'='U', 'bee'/'be'='B', 'see'/'sea'='C', 'are'='R', 'ay'='A', 'dee'='D', 'ee'='E', 'ef'='F', 'jay'='J', 'kay'='K', 'em'='M', 'en'='N', 'oh'='O', 'pee'='P', 'que'='Q', 'es'='S', 'tea'/'tee'='T', 'double-you'='W', 'ex'='X', 'why'='Y', 'zee'/'zed'='Z'. 5) If the speaker says just a short code, output ONLY that code — nothing more.";
    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${sttModel}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: baseInstruction + contextHint }],
          },
          contents: [{
            parts: [
              // Text instruction FIRST, then audio — order matters for multimodal
              { text: context
                ? "Listen to this audio. The speaker is saying a SHORT code or number (3-6 characters). Output ONLY the exact characters spoken — no extra digits, no padding to 10 digits. Transcribe:"
                : "Transcribe:" },
              { inlineData: { mimeType: normalizedMime, data: audio } },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: context ? 24 : 256,
            thinkingConfig: {
              thinkingBudget: 0,
            },
          },
        }),
      }
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("[stt] Gemini API failed:", apiRes.status, errText);
      return res.status(502).json({ error: "STT failed", detail: errText.substring(0, 500) });
    }

    const data = await apiRes.json();
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason || "unknown";
    const rawText = candidate?.content?.parts?.[0]?.text?.trim() || "";
    const elapsed = Date.now() - sttStart;

    // STT hallucination filter — Gemini sometimes transcribes TTS echo or ambient noise
    // as phantom annotations like "[Upbeat music]", "[Background noise]", etc.
    let filteredRaw = rawText.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
    const hallucinationPatterns = [
      /^(upbeat|background|ambient)\s*(music|noise|sounds?)\s*$/i,
      /^music$/i, /^applause$/i, /^silence$/i, /^inaudible$/i,
      /^thank you\.?\s*$/i, /^thanks\.?\s*$/i, /^you$/i, /^bye\.?\s*$/i,
      // Persistent Gemini phantom: TTS echo transcribed as flight-change requests
      /^i'?d?\s*like\s*to\s*(change|modify|cancel|rebook)\s*my\s*flight\.?\s*$/i,
      /^(change|modify|cancel|rebook)\s*my\s*flight\.?\s*$/i,
      /^i\s*want\s*to\s*(change|modify|cancel|rebook)\s*my\s*flight\.?\s*$/i,
    ];
    if (hallucinationPatterns.some(p => p.test(filteredRaw)) || filteredRaw.length < 2) {
      console.log(`[stt] ⚠️ Hallucination filter: "${rawText}" → discarding`);
      return res.json({ text: "", debug: { elapsed, finishReason, model: sttModel, mime: normalizedMime, filtered: true, rawText } });
    }
    if (filteredRaw !== rawText) {
      console.log(`[stt] Hallucination filter cleaned: "${rawText}" → "${filteredRaw}"`);
    }

    // Post-process: normalize phonetic letter patterns → alphanumeric codes
    let text = normalizeSTTAlphanumeric(filteredRaw);

    // Guard: if context expects a short code but STT returned a suspiciously long digit string,
    // the model likely hallucinated extra digits (e.g. "12345" → "1234567890").
    // Log warning for diagnostics. This commonly happens when Gemini interprets digits as a phone number.
    if ((context === "mileage-number" || context === "confirmation-code") && /^\d{7,}$/.test(text)) {
      console.log(`[stt] ⚠️ Possible digit hallucination: "${text}" (${text.length} digits for ${context})`);
    }

    if (text !== rawText) {
      console.log(`[stt] ${elapsed}ms, finish=${finishReason}, raw="${rawText}" → normalized="${text}"`);
    } else {
      console.log(`[stt] ${elapsed}ms, finish=${finishReason}, text="${text.substring(0, 100)}"`);
    }

    // Return debug info alongside the text so the client debug console can show it
    return res.json({ text, debug: { elapsed, finishReason, model: sttModel, mime: normalizedMime, rawText: rawText !== text ? rawText : undefined, context: context || undefined } });
  } catch (err: any) {
    console.error("[stt] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── TTS: LLM Gateway (high-quality Gemini voices via WebSocket) ──────────────

const LLM_GW_TTS_URL =
  process.env.LLM_GW_TTS_URL ||
  "wss://bot-svc-llm.sfproxy.einsteintest1.test1-uswest2.aws.sfdc.cl/ws/v1/realtime/tts/gemini";
const LLM_GW_TTS_URL_FALLBACK =
  process.env.LLM_GW_TTS_URL_FALLBACK ||
  "wss://bot-svc-llm.sfproxy.einstein.aws-dev4-uswest2.aws.sfdc.cl/ws/v1/realtime/tts/gemini";
const LLM_GW_API_KEY = process.env.LLM_GW_API_KEY;
const LLM_GW_TENANT_ID = process.env.LLM_GW_TENANT_ID; // e.g. core/falcontest1-core4sdb6/<orgId>
const LLM_GW_FEATURE_ID = process.env.LLM_GW_FEATURE_ID || "api-key-exploratory";
const LLM_GW_APP_CONTEXT = process.env.LLM_GW_APP_CONTEXT || "EinsteinGPT";
const LLM_GW_VOICE = process.env.LLM_GW_VOICE || "Kore";
const LLM_GW_MODEL = process.env.LLM_GW_MODEL || "gemini-2.5-flash-tts";

// TTS model fallback chain — if primary returns 500, try the next
const TTS_MODELS = [
  "gemini-2.5-flash-preview-tts",   // Primary: fast, cheap
  "gemini-2.5-pro-preview-tts",     // Fallback: higher quality
];

// System instruction for TTS — prevents Gemini from adding vocal fillers
// Style prefix prepended to text content (TTS models don't support systemInstruction)
const TTS_STYLE_PREFIX = "Say in a clear, professional, friendly tone as a Delta Air Lines customer service agent: ";

// ─── #3: Thinking filler audio — pre-generated at startup ────────
// A short "One moment please" clip sent immediately when the user speaks,
// filling the ~2-4s gap while Agentforce thinks. Cached as base64 PCM.
let thinkingFillerAudio: string | null = null;

async function preGenerateThinkingFiller(): Promise<void> {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.log("[filler] Skipping thinking filler — no GEMINI_API_KEY");
    return;
  }

  try {
    for (const model of TTS_MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "One moment." }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: LLM_GW_VOICE } },
              },
            },
          }),
        });

        if (!res.ok) {
          console.warn(`[filler] TTS model ${model} failed: ${res.status}, trying next...`);
          continue;
        }

        const data = await res.json();
        const audioB64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (audioB64) {
          thinkingFillerAudio = audioB64;
          console.log(`[filler] Generated thinking filler with model: ${model}`);
          return;
        }
      } catch (modelErr: any) {
        console.warn(`[filler] TTS model ${model} error: ${modelErr.message}, trying next...`);
        continue;
      }
    }
    console.warn("[filler] All TTS models failed for thinking filler");
  } catch (err: any) {
    console.warn("[filler] Pre-generation failed:", err.message);
  }
}

/** Create a 44-byte WAV header for Linear16 PCM data (24kHz, 16-bit, mono) */
function createWavHeader(pcmByteLength: number): Buffer {
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);                          // ChunkID
  header.writeUInt32LE(36 + pcmByteLength, 4);      // ChunkSize
  header.write("WAVE", 8);                          // Format
  header.write("fmt ", 12);                         // Subchunk1ID
  header.writeUInt32LE(16, 16);                     // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                      // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);            // NumChannels
  header.writeUInt32LE(sampleRate, 24);             // SampleRate
  header.writeUInt32LE(byteRate, 28);               // ByteRate
  header.writeUInt16LE(blockAlign, 32);             // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);          // BitsPerSample
  header.write("data", 36);                         // Subchunk2ID
  header.writeUInt32LE(pcmByteLength, 40);          // Subchunk2Size
  return header;
}

/**
 * Open a WebSocket to the LLM Gateway TTS endpoint, send text, collect PCM audio.
 * Returns a Buffer containing a complete WAV file.
 */
function synthesizeViaTTSGateway(text: string, voice: string, wsUrl: string): Promise<Buffer> {
  text = normalizeTtsText(text);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        "Authorization": `API_KEY ${LLM_GW_API_KEY}`,
        "x-sfdc-core-tenant-id": LLM_GW_TENANT_ID!,
        "x-client-feature-id": LLM_GW_FEATURE_ID,
        "x-sfdc-app-context": LLM_GW_APP_CONTEXT,
      },
    });

    const pcmChunks: Buffer[] = [];
    let completed = false;

    // 8s timeout — need headroom for Gemini API fallback within Heroku's 30s limit
    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("TTS gateway timed out after 8s"));
      }
    }, 8000);

    ws.on("open", () => {
      console.log("[tts] WebSocket connected to gateway");
    });

    ws.on("message", (data: WebSocket.Data, isBinary: boolean) => {
      if (completed) return;

      if (isBinary) {
        // Binary frame = raw PCM audio chunk
        pcmChunks.push(Buffer.from(data as Buffer));
      } else {
        // Text frame = JSON control message
        try {
          const msg = JSON.parse(data.toString());

          if (msg.status === "ready") {
            console.log(`[tts] Gateway ready — sending TTS request (voice: ${voice})`);
            // Send the TTS request
            ws.send(JSON.stringify({
              model: LLM_GW_MODEL,
              input: text,
              voice: voice,
            }));
          } else if (msg.status === "completed") {
            completed = true;
            clearTimeout(timeout);
            console.log(`[tts] Synthesis complete: ${msg.audioInfo || "no info"}`);

            // Combine all PCM chunks and wrap in WAV header
            const pcmData = Buffer.concat(pcmChunks);
            const wavHeader = createWavHeader(pcmData.length);
            const wavFile = Buffer.concat([wavHeader, pcmData]);

            ws.close();
            resolve(wavFile);
          } else if (msg.error) {
            completed = true;
            clearTimeout(timeout);
            console.error("[tts] Gateway error:", msg.message || msg.error);
            ws.close();
            reject(new Error(msg.message || msg.error));
          }
        } catch (parseErr) {
          console.warn("[tts] Non-JSON text message:", data.toString().substring(0, 200));
        }
      }
    });

    ws.on("error", (err) => {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        console.error("[tts] WebSocket error:", err.message);
        reject(err);
      }
    });

    ws.on("close", (code, reason) => {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        const reasonStr = reason?.toString() || "unknown";
        console.warn(`[tts] WebSocket closed unexpectedly: ${code} ${reasonStr}`);
        reject(new Error(`WebSocket closed: ${code} ${reasonStr}`));
      }
    });
  });
}

// ─── Circuit breaker: skip gateway for 5 min after failure ─────
let gatewayCircuitOpen = false;
let gatewayCircuitOpenUntil = 0;
const CIRCUIT_BREAKER_MS = 5 * 60 * 1000; // 5 minutes

function isGatewayCircuitOpen(): boolean {
  if (!gatewayCircuitOpen) return false;
  if (Date.now() > gatewayCircuitOpenUntil) {
    gatewayCircuitOpen = false;
    console.log("[tts] Circuit breaker reset — will try gateway again");
    return false;
  }
  return true;
}

function openGatewayCircuit(): void {
  gatewayCircuitOpen = true;
  gatewayCircuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS;
  console.log("[tts] Circuit breaker OPEN — skipping gateway for 5 minutes");
}

function closeGatewayCircuit(): void {
  gatewayCircuitOpen = false;
  gatewayCircuitOpenUntil = 0;
}

/**
 * Normalize text for natural TTS speech.
 * Converts dollar amounts, order numbers, and other patterns to spoken form.
 */
function normalizeTtsText(text: string): string {
  // Strip markdown-style formatting that causes weird TTS
  text = text.replace(/\*\*(.*?)\*\*/g, "$1"); // **bold** → bold
  text = text.replace(/\*(.*?)\*/g, "$1");      // *italic* → italic
  text = text.replace(/#{1,3}\s*/g, "");         // ### heading → heading

  // Strip emoji and special unicode characters that cause odd vocalizations
  text = text.replace(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "");

  // Convert dollar amounts: $12.02 → "12 dollars and 2 cents", $5.00 → "5 dollars"
  text = text.replace(/\$(\d+)\.(\d{2})/g, (_match, dollars, cents) => {
    const d = parseInt(dollars, 10);
    const c = parseInt(cents, 10);
    if (c === 0) return `${d} dollars`;
    return `${d} dollars and ${c} cents`;
  });
  // Convert whole dollar amounts: $5 → "5 dollars"
  text = text.replace(/\$(\d+)(?!\.\d)/g, (_match, dollars) => {
    return `${parseInt(dollars, 10)} dollars`;
  });
  // Convert order numbers with dashes for cleaner reading: Order-12345 → "Order 12345"
  text = text.replace(/Order-(\d+)/gi, "Order $1");
  return text;
}

/**
 * Direct Gemini TTS via public REST API (fallback when LLM Gateway is unreachable).
 * Returns a Buffer containing a complete WAV file.
 */
async function synthesizeViaGeminiAPI(text: string, voice: string): Promise<Buffer> {
  text = normalizeTtsText(text);
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) throw new Error("No GEMINI_API_KEY configured");

  const MAX_RETRIES = 2; // retries per model
  const REQUEST_TIMEOUT_MS = 15000;
  let lastError = "";

  // Try each model in the fallback chain
  for (const model of TTS_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    console.log(`[tts] Trying model: ${model}`);

    let modelFailed = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: TTS_STYLE_PREFIX + text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voice },
                },
              },
            },
          }),
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errText = await res.text();
          lastError = `${model} ${res.status}: ${errText.substring(0, 200)}`;
          console.error(`[tts] ${model} attempt ${attempt}/${MAX_RETRIES}: ${lastError}`);
          if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, attempt * 1500));
            continue;
          }
          modelFailed = true;
          break; // try next model
        }

        const data = await res.json();
        const part = data.candidates?.[0]?.content?.parts?.[0];
        const audioB64 = part?.inlineData?.data;
        if (!audioB64) {
          lastError = `${model}: No audio data in response`;
          console.error(`[tts] ${model} attempt ${attempt}: ${lastError}`);
          if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 500)); continue; }
          modelFailed = true;
          break;
        }

        const mimeType = part?.inlineData?.mimeType || "unknown";
        const pcmData = Buffer.from(audioB64, "base64");
        console.log(`[tts] ✓ ${model} OK: mimeType=${mimeType}, pcm=${pcmData.length}B (attempt ${attempt})`);

        const wavHeader = createWavHeader(pcmData.length);
        return Buffer.concat([wavHeader, pcmData]);
      } catch (fetchErr: any) {
        clearTimeout(timeoutId);
        lastError = fetchErr.name === "AbortError"
          ? `${model} timeout (${REQUEST_TIMEOUT_MS}ms) attempt ${attempt}`
          : `${model}: ${fetchErr.message}`;
        console.error(`[tts] ${lastError}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, attempt * 1500));
          continue;
        }
        modelFailed = true;
        break;
      }
    }

    if (modelFailed) {
      console.log(`[tts] Model ${model} failed, trying next model...`);
      continue;
    }
  }

  throw new Error(`All TTS models failed. Last: ${lastError}`);
}

app.post("/api/tts", async (req, res) => {
  const { text, voice } = req.body;
  if (!text) {
    return res.status(400).json({ error: "text is required" });
  }

  const selectedVoice = voice || LLM_GW_VOICE;

  let lastError = "";

  // Strategy 1: Gemini API (primary — fast ~2s, reliable, free)
  if (process.env.GEMINI_API_KEY) {
    try {
      const ttsStart = Date.now();
      console.log(`[tts] Gemini API TTS (primary): "${text.substring(0, 60)}..." (voice: ${selectedVoice})`);

      const wavBuffer = await synthesizeViaGeminiAPI(text, selectedVoice);
      const elapsed = Date.now() - ttsStart;
      console.log(`[tts] Gemini API WAV audio: ${wavBuffer.length} bytes (${elapsed}ms)`);

      res.set("Content-Type", "audio/wav");
      res.set("Content-Length", String(wavBuffer.length));
      return res.send(wavBuffer);
    } catch (geminiErr: any) {
      lastError = `Gemini: ${geminiErr.message}`;
      console.error("[tts] Gemini API (primary) failed:", geminiErr.message);
      console.log("[tts] Falling back to LLM Gateway...");
    }
  } else {
    lastError = "No GEMINI_API_KEY";
    console.log("[tts] No GEMINI_API_KEY — trying LLM Gateway directly...");
  }

  // Strategy 2: LLM Gateway (fallback — WebSocket, higher latency)
  if (LLM_GW_API_KEY && LLM_GW_TENANT_ID && !isGatewayCircuitOpen()) {
    const endpoints = [LLM_GW_TTS_URL, LLM_GW_TTS_URL_FALLBACK];

    for (let i = 0; i < endpoints.length; i++) {
      const wsUrl = endpoints[i];
      const label = i === 0 ? "primary" : "fallback";

      try {
        const ttsStart = Date.now();
        console.log(`[tts] Gateway TTS (${label}): "${text.substring(0, 60)}..." (voice: ${selectedVoice})`);

        const wavBuffer = await synthesizeViaTTSGateway(text, selectedVoice, wsUrl);
        const elapsed = Date.now() - ttsStart;
        console.log(`[tts] Got WAV audio: ${wavBuffer.length} bytes (${elapsed}ms, gateway ${label})`);

        closeGatewayCircuit(); // success — ensure circuit is closed
        res.set("Content-Type", "audio/wav");
        res.set("Content-Length", String(wavBuffer.length));
        return res.send(wavBuffer);
      } catch (err: any) {
        console.error(`[tts] Gateway ${label} endpoint failed:`, err.message);
        if (i < endpoints.length - 1) {
          console.log("[tts] Trying gateway fallback endpoint...");
          continue;
        }
        openGatewayCircuit(); // all gateway endpoints failed — open circuit
      }
    }
  } else if (!LLM_GW_API_KEY || !LLM_GW_TENANT_ID) {
    console.log("[tts] No LLM Gateway credentials — no fallback available");
  } else {
    console.log("[tts] Gateway circuit breaker open — skipping gateway fallback");
  }

  return res.status(502).json({ error: "TTS failed on all providers (Gemini API + gateway)", detail: lastError });
});

// ─── Demo Persona Routes ────────────────────────────────────────
// The Connected App's Client Credentials token has limited data API access
// (SOQL queries and sObject POST/PATCH return INVALID_SESSION_ID).
// This is a known limitation of External Client App migrated tokens.
// For the demo, we store persona data in-memory with env var defaults.

let demoPersona = {
  customerName: process.env.DEMO_CUSTOMER_NAME || "Marcus Johnson",
  customerPhone: process.env.DEMO_CUSTOMER_PHONE || "555-0100",
  customerEmail: process.env.DEMO_CUSTOMER_EMAIL || "marcus.johnson@example.com",
  skymilesNumber: process.env.DEMO_SKYMILES_NUMBER || "12345",
  pnr: process.env.DEMO_PNR || "WXMB33",
};

app.get("/api/demo-persona", async (_req, res) => {
  res.json({
    id: "local",
    customerName: demoPersona.customerName,
    customerPhone: demoPersona.customerPhone,
    customerEmail: demoPersona.customerEmail,
    skymilesNumber: demoPersona.skymilesNumber,
    pnr: demoPersona.pnr,
    isConfigured: !!(demoPersona.customerName && demoPersona.customerPhone),
  });
});

app.put("/api/demo-persona", async (req, res) => {
  const { customerName, customerPhone, customerEmail, skymilesNumber, pnr } = req.body;
  if (customerName !== undefined) demoPersona.customerName = customerName || "";
  if (customerPhone !== undefined) demoPersona.customerPhone = customerPhone || "";
  if (customerEmail !== undefined) demoPersona.customerEmail = customerEmail || "";
  if (skymilesNumber !== undefined) demoPersona.skymilesNumber = skymilesNumber || "";
  if (pnr !== undefined) demoPersona.pnr = pnr || "";
  console.log("[demo-persona] Updated:", demoPersona);
  res.json({ success: true, action: "updated", id: "local" });
});

// ─── Latest Order Lookup ────────────────────────────────────────

app.get("/api/latest-order", async (_req, res) => {
  try {
    const query = encodeURIComponent(
      "SELECT Name, CreatedDate FROM QSR_Order__c ORDER BY CreatedDate DESC LIMIT 1"
    );
    const sfRes = await sfFetch(`/services/data/v62.0/query/?q=${query}`);
    if (!sfRes.ok) {
      return res.status(404).json({ error: "Could not query orders" });
    }
    const data = await sfRes.json();
    if (data.records && data.records.length > 0) {
      const order = data.records[0];
      console.log(`[latest-order] Found: ${order.Name} (created ${order.CreatedDate})`);
      return res.json({ orderNumber: order.Name, createdDate: order.CreatedDate });
    }
    return res.status(404).json({ error: "No orders found" });
  } catch (err: any) {
    console.error("[latest-order] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Send Receipt Route ─────────────────────────────────────────

app.post("/api/send-receipt", async (req, res) => {
  const { orderNumber, customerEmail } = req.body;
  if (!orderNumber || !customerEmail) {
    return res.status(400).json({ error: "orderNumber and customerEmail are required" });
  }

  // Normalize order number to match QSR_Order__c.Name format: "Order-NNNN"
  let normalizedOrder = orderNumber.trim();
  // Handle formats like "Order 21", "Order-21", "Order#21", "#21", "21", "ORD-123456", "Order-0021"
  const numMatch = normalizedOrder.match(/(?:ORD|Order)[-\s#]*(\d+)$/i)
    || normalizedOrder.match(/#\s*(\d+)$/i)
    || normalizedOrder.match(/^(\d+)$/);
  if (numMatch) {
    const num = numMatch[1].padStart(4, "0");
    normalizedOrder = `Order-${num}`;
  } else if (!normalizedOrder.startsWith("Order-")) {
    // If no pattern matched and it doesn't look like a valid order, try to extract any number
    const anyNum = normalizedOrder.match(/(\d+)/);
    if (anyNum) {
      normalizedOrder = `Order-${anyNum[1].padStart(4, "0")}`;
    }
  }
  console.log(`[send-receipt] Normalized: "${orderNumber}" → "${normalizedOrder}"`);

  try {
    // Call the InvocableMethod via Apex REST-like composite approach
    // Use /services/data/vXX.0/actions/custom/apex/SendOrderReceiptService
    const sfRes = await sfFetch(`/services/data/v62.0/actions/custom/apex/SendOrderReceiptService`, {
      method: "POST",
      body: JSON.stringify({
        inputs: [{
          orderNumber: normalizedOrder,
          customerEmail: customerEmail,
        }],
      }),
    });

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[send-receipt] Failed:", sfRes.status, err);
      return res.status(sfRes.status).json({ error: "Failed to send receipt", detail: err });
    }

    const data = await sfRes.json();
    const result = data?.[0]?.outputValues?.result || "Receipt sent";
    console.log("[send-receipt] Result:", result);
    return res.json({ success: true, result });
  } catch (err: any) {
    console.error("[send-receipt] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── TTS Diagnostic (temporary) ─────────────────────────────────

app.get("/api/tts-test", async (_req, res) => {
  const startTime = Date.now();
  const testText = "Welcome to Fly Delta. How can I help you today?";
  try {
    const wavBuffer = await synthesizeViaGeminiAPI(testText, LLM_GW_VOICE);
    const elapsed = Date.now() - startTime;
    res.json({
      ok: true,
      bytes: wavBuffer.length,
      elapsedMs: elapsed,
      models: TTS_MODELS,
      voice: LLM_GW_VOICE,
      geminiKeySet: !!process.env.GEMINI_API_KEY,
      keyPrefix: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.substring(0, 6) + "..." : "none",
    });
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    res.json({
      ok: false,
      error: err.message,
      elapsedMs: elapsed,
      models: TTS_MODELS,
      voice: LLM_GW_VOICE,
      geminiKeySet: !!process.env.GEMINI_API_KEY,
      keyPrefix: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.substring(0, 6) + "..." : "none",
    });
  }
});

// ─── Health Check ────────────────────────────────────────────────

app.get("/api/health", async (_req, res) => {
  const hasConfig = !!(SF_CLIENT_ID && SF_CLIENT_SECRET && SF_AGENT_ID);
  res.json({
    status: "ok",
    version: "v2",
    hasConfig,
    loginUrl: SF_LOGIN_URL || "not set",
    agentId: SF_AGENT_ID ? `${SF_AGENT_ID.substring(0, 8)}...` : "not set",
    tts: {
      provider: process.env.GEMINI_API_KEY ? "gemini-api" : (LLM_GW_API_KEY ? "llm-gateway" : "none"),
      gatewayKeySet: !!LLM_GW_API_KEY,
      gatewayTenantIdSet: !!LLM_GW_TENANT_ID,
      geminiKeySet: !!process.env.GEMINI_API_KEY,
      voice: LLM_GW_VOICE,
      model: LLM_GW_MODEL,
    },
    stt: {
      primary: "web-speech-api",
      fallback: "gemini",
      geminiKeySet: !!process.env.GEMINI_API_KEY,
    },
  });
});

// ─── Static menu fallback (unused for airline, kept for compatibility) ────

function getStaticMenu() {
  return [];
}

// ─── Serve built frontend ────────────────────────────────────────

app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// ─── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✈️  Fly Delta — Voice Gateway`);
  console.log(`   Running on port ${PORT}`);
  console.log(`   Agent ID: ${SF_AGENT_ID || "NOT SET"}`);
  console.log(`   Instance: ${SF_LOGIN_URL}`);
  console.log(`   Auth: ${SF_CLIENT_ID && SF_CLIENT_SECRET ? "Configured ✓" : "⚠️  Missing credentials"}`);
  console.log(`   TTS Primary: ${process.env.GEMINI_API_KEY ? `Gemini API (${LLM_GW_VOICE} voice) ✓` : "⚠️  No GEMINI_API_KEY"}`);
  console.log(`   TTS Fallback: ${LLM_GW_API_KEY ? `LLM Gateway (${LLM_GW_VOICE} voice) ✓` : "⚠️  No LLM_GW_API_KEY — no fallback TTS"}`);
  console.log(`   TTS Tenant: ${LLM_GW_TENANT_ID ? `${LLM_GW_TENANT_ID} ✓` : "⚠️  No LLM_GW_TENANT_ID (gateway fallback disabled)"}`);
  console.log(`   STT: Web Speech API (primary) + Gemini (fallback) ${process.env.GEMINI_API_KEY ? "✓" : "⚠️  No GEMINI_API_KEY"}\n`);

  // #3: Pre-generate thinking filler audio in background (non-blocking)
  preGenerateThinkingFiller().catch(() => {});
});
