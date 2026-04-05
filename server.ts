import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    console.log(`[message] Agent responded in ${Date.now() - agentStart}ms:`, responseText.substring(0, 100) + "...");
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
        // Use Gemini streaming TTS — sends audio as it generates
        const model = "gemini-2.5-flash-preview-tts";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;

        const ttsRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: responseText }] }],
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
            // Parse SSE events from the buffer
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete last line

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6).trim();
              if (!jsonStr || jsonStr === "[DONE]") continue;

              try {
                const chunk = JSON.parse(jsonStr);
                const audioB64 = chunk?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                if (audioB64) {
                  chunkCount++;
                  // Send audio chunk to client as base64 PCM
                  res.write(`data: ${JSON.stringify({ type: "audio", chunk: audioB64, index: chunkCount })}\n\n`);
                }
              } catch { /* skip malformed JSON */ }
            }
          }

          console.log(`[speak-stream] TTS: ${Date.now() - ttsStart}ms, ${chunkCount} chunks`);
        } else {
          console.error("[speak-stream] Gemini streaming TTS failed:", ttsRes.status);
          // Fall back to non-streaming TTS
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

// ─── V5: True Streaming Agent + Sentence-by-Sentence TTS ─────────────────
// Uses /messages/stream (real SSE from Agentforce) instead of ?sync=true.
// Text chunks arrive word-by-word; we buffer into sentences and fire TTS
// for each sentence as soon as it's complete. Audio plays while agent is
// still generating the rest of the response.
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
    console.log(`[msg-stream] Starting streaming for session ${sessionId}`);

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
      // Fall back to sync mode
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
    let ttsChain: Promise<void> = Promise.resolve(); // Sequential TTS chain

    // Helper: queue streaming TTS for a sentence (sequential — each waits for previous)
    const fireTtsForSentence = (sentence: string, sIdx: number) => {
      if (!sentence.trim() || !process.env.GEMINI_API_KEY) return;
      ttsChain = ttsChain.then(async () => {
        try {
          const model = "gemini-2.5-flash-preview-tts";
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
          const ttsRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: sentence }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LLM_GW_VOICE } } },
              },
            }),
          });

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
                    res.write(`data: ${JSON.stringify({ type: "audio", chunk: audioB64, index: chunkIdx, sentenceIndex: sIdx })}\n\n`);
                  }
                } catch { /* skip */ }
              }
            }
            console.log(`[msg-stream] TTS sentence ${sIdx}: ${chunkIdx} audio chunks`);
          } else {
            console.warn(`[msg-stream] TTS failed for sentence ${sIdx}: ${ttsRes.status}`);
          }
        } catch (err: any) {
          console.warn(`[msg-stream] TTS error sentence ${sIdx}:`, err.message);
        }
      });
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

        // Handle "event: TEXT_CHUNK" — the event type line
        if (line.startsWith("event:")) continue; // We parse from the data line

        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const msgType = parsed.message?.type;

            if (msgType === "TextChunk") {
              const chunkText = parsed.message?.message || "";
              fullText += chunkText;
              sentenceBuffer += chunkText;

              // Forward text chunk to client for UI updates
              res.write(`data: ${JSON.stringify({ type: "text-chunk", text: chunkText, fullText })}\n\n`);

              // Check for complete sentence
              const sentenceMatch = sentenceBuffer.match(/^(.*?[.!?\n])\s*/s);
              if (sentenceMatch) {
                const completeSentence = sentenceMatch[1].trim();
                sentenceBuffer = sentenceBuffer.slice(sentenceMatch[0].length);
                if (completeSentence.length > 0) {
                  console.log(`[msg-stream] Sentence ${sentenceIndex}: "${completeSentence.substring(0, 60)}..."`);
                  // Fire TTS for this sentence — runs concurrently
                  fireTtsForSentence(completeSentence, sentenceIndex);
                  sentenceIndex++;
                }
              }
            } else if (msgType === "Inform") {
              // Full text confirmation — may contain the complete response
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

    // Wait for all sequential TTS to finish
    await ttsChain;

    const totalMs = Date.now() - totalStart;
    console.log(`[msg-stream] Complete: ${totalMs}ms, ${sentenceIndex} sentences, text="${fullText.substring(0, 80)}..."`);
    res.write(`data: ${JSON.stringify({ type: "done", fullText, totalMs, sentences: sentenceIndex })}\n\n`);
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

    // TTS the full response
    if (responseText && process.env.GEMINI_API_KEY) {
      const model = "gemini-2.5-flash-preview-tts";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
      const ttsRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: responseText }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LLM_GW_VOICE } } },
          },
        }),
      });

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
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done", fullText: responseText, totalMs: Date.now() - totalStart, sentences: 1 })}\n\n`);
    return res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    return res.end();
  }
}

// CRITICAL: Agent API DELETE must NOT have a body or Content-Type header
app.delete("/api/agent/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    const { accessToken } = await getAccessToken();
    const sfRes = await fetch(
      `${AGENT_API_BASE}/einstein/ai-agent/v1/sessions/${sessionId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[session] End failed:", sfRes.status, err);
      return res.status(sfRes.status).json({ error: "Failed to end session", detail: err });
    }

    console.log("[session] Ended:", sessionId);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[session] Error:", err.message);
    return res.status(500).json({ error: err.message });
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

// ─── STT: Gemini (server-side fallback for platforms without Web Speech API) ─

app.post("/api/stt", async (req, res) => {
  const { audio, mimeType } = req.body;
  if (!audio) return res.status(400).json({ error: "audio (base64) is required" });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(503).json({ error: "STT not configured" });

  try {
    const sttStart = Date.now();
    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
              { text: "Transcribe this audio exactly. Return ONLY the spoken text, nothing else. If no speech is detected, return an empty string." },
            ],
          }],
        }),
      }
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("[stt] Gemini API failed:", apiRes.status, errText);
      return res.status(502).json({ error: "STT failed", detail: errText.substring(0, 500) });
    }

    const data = await apiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    console.log(`[stt] Transcribed in ${Date.now() - sttStart}ms:`, text.substring(0, 100));
    return res.json({ text });
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
 * Direct Gemini TTS via public REST API (fallback when LLM Gateway is unreachable).
 * Returns a Buffer containing a complete WAV file.
 */
async function synthesizeViaGeminiAPI(text: string, voice: string): Promise<Buffer> {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) throw new Error("No GEMINI_API_KEY configured");

  const model = "gemini-2.5-flash-preview-tts";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const MAX_RETRIES = 2;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
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

    if (!res.ok) {
      const errText = await res.text();
      lastError = `Gemini TTS API ${res.status}: ${errText.substring(0, 300)}`;
      console.error(`[tts] Gemini attempt ${attempt}/${MAX_RETRIES} failed: ${lastError}`);
      // Retry on 429 (rate limit) or 500/503 (transient)
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const backoffMs = attempt * 1000;
        console.log(`[tts] Retrying Gemini in ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      throw new Error(lastError);
    }

    const data = await res.json();
    const part = data.candidates?.[0]?.content?.parts?.[0];
    const audioB64 = part?.inlineData?.data;
    if (!audioB64) {
      lastError = "No audio data in Gemini TTS response";
      console.error(`[tts] Gemini attempt ${attempt}: ${lastError}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw new Error(lastError);
    }

    const mimeType = part?.inlineData?.mimeType || "unknown";
    const pcmData = Buffer.from(audioB64, "base64");
    console.log(`[tts] Gemini OK: mimeType=${mimeType}, pcm=${pcmData.length}B (attempt ${attempt})`);

    const wavHeader = createWavHeader(pcmData.length);
    return Buffer.concat([wavHeader, pcmData]);
  }

  throw new Error(lastError || "Gemini TTS failed after retries");
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
  customerName: process.env.DEMO_CUSTOMER_NAME || "Scott",
  customerPhone: process.env.DEMO_CUSTOMER_PHONE || "555-0100",
  customerEmail: process.env.DEMO_CUSTOMER_EMAIL || "scott@freshkitchens.com",
};

app.get("/api/demo-persona", async (_req, res) => {
  res.json({
    id: "local",
    customerName: demoPersona.customerName,
    customerPhone: demoPersona.customerPhone,
    customerEmail: demoPersona.customerEmail,
    isConfigured: !!(demoPersona.customerName && demoPersona.customerPhone),
  });
});

app.put("/api/demo-persona", async (req, res) => {
  const { customerName, customerPhone, customerEmail } = req.body;
  if (customerName !== undefined) demoPersona.customerName = customerName || "";
  if (customerPhone !== undefined) demoPersona.customerPhone = customerPhone || "";
  if (customerEmail !== undefined) demoPersona.customerEmail = customerEmail || "";
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
  try {
    const wavBuffer = await synthesizeViaGeminiAPI("Welcome to Scott's Fresh Kitchens. How can I help you today?", "Kore");
    res.json({ ok: true, bytes: wavBuffer.length });
  } catch (err: any) {
    res.json({ ok: false, error: err.message });
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

// ─── Static menu fallback ────────────────────────────────────────

function getStaticMenu() {
  return [
    { id: "s-1", name: "Classic Fresh Burger", price: 12.99, description: "Our signature quarter-pound beef patty with fresh lettuce, tomato, pickles, and our house-made sauce on a toasted brioche bun.", category: "Burgers", calories: 650, isPopular: true, available: true },
    { id: "s-2", name: "Crispy Chicken Sandwich", price: 13.49, description: "Crispy buttermilk-fried chicken breast with coleslaw, pickles, and spicy mayo on a toasted bun.", category: "Burgers", calories: 720, isPopular: true, available: true },
    { id: "s-3", name: "Double Stack Burger", price: 15.99, description: "Two quarter-pound patties stacked high with double cheese, caramelized onions, and smoky BBQ sauce.", category: "Burgers", calories: 950, isPopular: true, available: true },
    { id: "s-4", name: "Veggie Garden Burger", price: 11.99, description: "House-made plant-based patty with roasted peppers, arugula, and herb aioli.", category: "Burgers", calories: 480, isPopular: false, available: true },
    { id: "s-5", name: "Grilled Filet Mignon", price: 24.99, description: "Premium 8oz filet mignon grilled to your liking, served with herb butter and fresh-cut fries.", category: "Steaks & Grills", calories: 680, isPopular: true, available: true },
    { id: "s-6", name: "Herb-Crusted Ribeye", price: 22.99, description: "12oz ribeye with a rosemary-garlic crust, served with roasted vegetables.", category: "Steaks & Grills", calories: 850, isPopular: false, available: true },
    { id: "s-7", name: "BBQ Grilled Chicken", price: 16.99, description: "Juicy half chicken basted in our house-made BBQ sauce, slow-grilled over open flame.", category: "Steaks & Grills", calories: 620, isPopular: true, available: true },
    { id: "s-8", name: "Carbonara", price: 14.99, description: "Classic spaghetti carbonara with crispy pancetta, parmesan, egg yolk, and cracked black pepper.", category: "Pasta & Bowls", calories: 780, isPopular: true, available: true },
    { id: "s-9", name: "Grilled Chicken Bowl", price: 14.49, description: "Herb-marinated grilled chicken over quinoa with roasted vegetables, avocado, and lemon tahini dressing.", category: "Pasta & Bowls", calories: 550, isPopular: true, available: true },
    { id: "s-10", name: "Penne Arrabbiata", price: 13.49, description: "Penne in a fiery tomato sauce with garlic, chili flakes, and fresh basil.", category: "Pasta & Bowls", calories: 620, isPopular: false, available: true },
    { id: "s-11", name: "Fresh-Cut Fries", price: 4.49, description: "Hand-cut fries, crispy on the outside, fluffy inside. Seasoned with sea salt.", category: "Sides", calories: 380, isPopular: true, available: true },
    { id: "s-12", name: "Sweet Potato Fries", price: 5.49, description: "Crispy sweet potato fries served with chipotle aioli dipping sauce.", category: "Sides", calories: 340, isPopular: false, available: true },
    { id: "s-13", name: "Onion Rings", price: 5.49, description: "Beer-battered onion rings, golden and crunchy, served with ranch dipping sauce.", category: "Sides", calories: 420, isPopular: false, available: true },
    { id: "s-14", name: "Garden Salad", price: 6.99, description: "Mixed greens, cherry tomatoes, cucumber, red onion, and croutons with your choice of dressing.", category: "Sides", calories: 180, isPopular: false, available: true },
    { id: "s-15", name: "Fresh Lemonade", price: 4.99, description: "Hand-squeezed lemon juice with just the right amount of sweetness. Served ice cold.", category: "Fresh Juices & Drinks", calories: 120, isPopular: true, available: true },
    { id: "s-16", name: "Tropical Mango Smoothie", price: 5.99, description: "Creamy mango, banana, and coconut milk blended to tropical perfection.", category: "Fresh Juices & Drinks", calories: 280, isPopular: true, available: true },
    { id: "s-17", name: "Berry Blast Smoothie", price: 5.49, description: "A vibrant mix of strawberries, blueberries, raspberries, and Greek yogurt.", category: "Fresh Juices & Drinks", calories: 220, isPopular: false, available: true },
    { id: "s-18", name: "Green Detox Juice", price: 6.99, description: "A revitalizing blend of kale, cucumber, celery, green apple, and fresh ginger.", category: "Fresh Juices & Drinks", calories: 90, isPopular: false, available: true },
    { id: "s-19", name: "Chocolate Brownie", price: 5.99, description: "Rich, fudgy chocolate brownie baked fresh daily. Served warm with a scoop of vanilla ice cream.", category: "Desserts", calories: 480, isPopular: true, available: true },
    { id: "s-20", name: "Fresh Fruit Cup", price: 4.99, description: "A colorful mix of seasonal fresh fruits — strawberries, blueberries, mango, and kiwi.", category: "Desserts", calories: 120, isPopular: false, available: true },
  ];
}

// ─── Serve built frontend ────────────────────────────────────────

app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// ─── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🍽️  Scott's Fresh Kitchens V2 — Voice Gateway`);
  console.log(`   Running on port ${PORT}`);
  console.log(`   Agent ID: ${SF_AGENT_ID || "NOT SET"}`);
  console.log(`   Instance: ${SF_LOGIN_URL}`);
  console.log(`   Auth: ${SF_CLIENT_ID && SF_CLIENT_SECRET ? "Configured ✓" : "⚠️  Missing credentials"}`);
  console.log(`   TTS Primary: ${process.env.GEMINI_API_KEY ? `Gemini API (${LLM_GW_VOICE} voice) ✓` : "⚠️  No GEMINI_API_KEY"}`);
  console.log(`   TTS Fallback: ${LLM_GW_API_KEY ? `LLM Gateway (${LLM_GW_VOICE} voice) ✓` : "⚠️  No LLM_GW_API_KEY — no fallback TTS"}`);
  console.log(`   TTS Tenant: ${LLM_GW_TENANT_ID ? `${LLM_GW_TENANT_ID} ✓` : "⚠️  No LLM_GW_TENANT_ID (gateway fallback disabled)"}`);
  console.log(`   STT: Web Speech API (primary) + Gemini (fallback) ${process.env.GEMINI_API_KEY ? "✓" : "⚠️  No GEMINI_API_KEY"}\n`);
});
