import { apiUrl } from "./api-base";

// A4: Session TTL — Agentforce sessions expire after ~30 minutes of inactivity
const SESSION_TTL_MS = 25 * 60 * 1000; // 25 min (conservative buffer before 30 min server-side expiry)

// A6: Session start retry config
const SESSION_START_MAX_RETRIES = 2;
const SESSION_START_RETRY_DELAY_MS = 1500;

export class AgentforceSession {
  private sessionId: string | null = null;
  private sequenceId: number = 0;
  private variablesSent: boolean = false;
  private personaPrefixSent: boolean = false;
  private personaVarsCache: Array<{ name: string; type: string; value: string }> = [];
  // A4: Track session creation time and last activity for TTL
  private createdAt: number = 0;
  private lastActivityAt: number = 0;

  get isActive(): boolean {
    return this.sessionId !== null && !this.isExpired;
  }

  // A4: Check if session has exceeded TTL
  private get isExpired(): boolean {
    if (!this.sessionId) return true;
    const elapsed = Date.now() - this.lastActivityAt;
    return elapsed > SESSION_TTL_MS;
  }

  async start(): Promise<void> {
    // A6: Retry logic — session creation can fail transiently
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= SESSION_START_MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(apiUrl("/api/agent/session"), { method: "POST" });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(err.error || `Failed to start session: ${res.status}`);
        }
        const data = await res.json();
        this.sessionId = data.sessionId;
        this.sequenceId = 0;
        this.variablesSent = false;
        this.personaPrefixSent = false;
        this.personaVarsCache = [];
        // A4: Record session timestamps
        this.createdAt = Date.now();
        this.lastActivityAt = Date.now();

        // Pre-fetch persona so it's ready for every message
        await this.loadPersona();
        return; // success
      } catch (err: any) {
        lastError = err;
        console.warn(`[agent] Session start attempt ${attempt}/${SESSION_START_MAX_RETRIES} failed: ${err.message}`);
        if (attempt < SESSION_START_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, SESSION_START_RETRY_DELAY_MS * attempt));
        }
      }
    }
    throw lastError || new Error("Failed to start session after retries");
  }

  /**
   * Loads persona data once and caches it as structured variables.
   * Context is passed via BOTH the Agentforce variables array AND a natural-language
   * prefix on the first message — the prefix ensures the planner auto-fills action
   * parameters (PNR, SkyMiles, etc.) without re-asking the customer.
   */
  private async loadPersona(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/demo-persona"));
      if (!res.ok) return;
      const persona = await res.json();

      if (persona.customerName) {
        this.personaVarsCache.push({ name: "CustomerName", type: "Text", value: persona.customerName });
      }
      if (persona.customerPhone) {
        this.personaVarsCache.push({ name: "CustomerPhone", type: "Text", value: persona.customerPhone });
      }
      if (persona.customerEmail) {
        this.personaVarsCache.push({ name: "CustomerEmail", type: "Text", value: persona.customerEmail });
      }
      if (persona.skymilesNumber) {
        this.personaVarsCache.push({ name: "SkyMilesNumber", type: "Text", value: persona.skymilesNumber });
      }
      if (persona.pnr) {
        this.personaVarsCache.push({ name: "PNR", type: "Text", value: persona.pnr });
      }
    } catch { /* ignore */ }
  }

  /**
   * Returns Agentforce-compatible context variables (only on first call).
   */
  private getPersonaVariables(): Array<{ name: string; type: string; value: string }> {
    if (this.variablesSent) return [];
    this.variablesSent = true;
    return this.personaVarsCache;
  }

  /**
   * Returns a natural-language customer context prefix (only on first call).
   * This is prepended to the first user message so the planner can directly
   * extract PNR, SkyMiles, etc. from the conversation text — eliminating the
   * need to ask the user for info that's already known.
   */
  private getPersonaPrefix(): string {
    if (this.personaPrefixSent || this.personaVarsCache.length === 0) return "";
    this.personaPrefixSent = true;
    const parts = this.personaVarsCache.map(v => `${v.name}=${v.value}`);
    return `[Customer context: ${parts.join(", ")}] `;
  }

  /**
   * A4: Ensure session is still valid before sending a message.
   * If expired, transparently restart the session.
   */
  private async ensureSession(): Promise<void> {
    if (!this.sessionId || this.isExpired) {
      console.log(`[agent] Session expired or missing — restarting (age=${this.sessionId ? Math.round((Date.now() - this.createdAt) / 1000) + 's' : 'none'})`);
      await this.end();
      await this.start();
    }
  }

  async sendMessage(text: string): Promise<string> {
    await this.ensureSession();
    this.sequenceId++;
    this.lastActivityAt = Date.now(); // A4: Update activity timestamp
    const variables = this.getPersonaVariables();
    const message = this.getPersonaPrefix() + text;
    const res = await fetch(apiUrl("/api/agent/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, message, sequenceId: this.sequenceId, variables }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Message failed: ${res.status}`);
    }
    const data = await res.json();
    return data.response || "I didn't catch that. Could you try again?";
  }

  /**
   * Combined agent message + TTS in one call (saves a round-trip).
   * Returns { response, audioData? } where audioData is an ArrayBuffer of WAV.
   */
  async sendMessageWithAudio(text: string): Promise<{ response: string; audioData?: ArrayBuffer }> {
    await this.ensureSession();
    this.sequenceId++;
    this.lastActivityAt = Date.now(); // A4
    const variables = this.getPersonaVariables();
    const message = this.getPersonaPrefix() + text;
    const res = await fetch(apiUrl("/api/agent/speak"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, message, sequenceId: this.sequenceId, variables }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Message failed: ${res.status}`);
    }
    const data = await res.json();
    const response = data.response || "I didn't catch that. Could you try again?";

    let audioData: ArrayBuffer | undefined;
    if (data.audio) {
      // Decode base64 WAV to ArrayBuffer
      const binaryStr = atob(data.audio);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      audioData = bytes.buffer;
    }

    return { response, audioData };
  }

  /**
   * Streaming agent message + TTS via SSE.
   * Calls onText when agent text arrives, onAudioChunk for each PCM chunk,
   * and onDone when complete. Audio starts playing before full synthesis.
   */
  async sendMessageStreaming(
    text: string,
    callbacks: {
      onText?: (response: string, raw?: any) => void;
      onAudioChunk?: (pcmBase64: string, index: number) => void;
      onAudioFull?: (wavBase64: string) => void;
      onDone?: () => void;
      onError?: (error: string) => void;
    }
  ): Promise<{ response: string }> {
    await this.ensureSession();
    this.sequenceId++;
    this.lastActivityAt = Date.now(); // A4
    const variables = this.getPersonaVariables();
    const message = this.getPersonaPrefix() + text;

    const res = await fetch(apiUrl("/api/agent/speak-stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.sessionId,
        message,
        sequenceId: this.sequenceId,
        variables,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Stream failed: ${res.status}`);
    }

    let responseText = "";
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);
          switch (event.type) {
            case "text":
              responseText = event.response || "";
              callbacks.onText?.(responseText, event.raw);
              break;
            case "audio":
              callbacks.onAudioChunk?.(event.chunk, event.index);
              break;
            case "audio-full":
              callbacks.onAudioFull?.(event.audio);
              break;
            case "done":
              callbacks.onDone?.();
              break;
            case "error":
              callbacks.onError?.(event.error);
              break;
          }
        } catch { /* skip malformed JSON */ }
      }
    }

    return { response: responseText || "I didn't catch that. Could you try again?" };
  }

  /**
   * V5: True streaming — agent text arrives word-by-word via /messages/stream,
   * sentences are detected and TTS'd individually, audio chunks stream to client.
   * Time-to-first-audio: ~1-2s instead of 5-7s.
   */
  async sendMessageFullStreaming(
    text: string,
    callbacks: {
      onTextChunk?: (chunk: string, fullText: string) => void;
      onTextComplete?: (fullText: string) => void;
      onAudioChunk?: (pcmBase64: string, index: number, sentenceIndex: number) => void;
      onDone?: (fullText: string) => void;
      onError?: (error: string) => void;
    },
    options?: { skipFiller?: boolean }
  ): Promise<{ response: string }> {
    await this.ensureSession();
    this.sequenceId++;
    this.lastActivityAt = Date.now(); // A4
    const variables = this.getPersonaVariables();
    const message = this.getPersonaPrefix() + text;

    const res = await fetch(apiUrl("/api/agent/message-stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.sessionId,
        message,
        sequenceId: this.sequenceId,
        variables,
        ...(options?.skipFiller ? { skipFiller: true } : {}),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Full stream failed: ${res.status}`);
    }

    let responseText = "";
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);
          switch (event.type) {
            case "text-chunk":
              callbacks.onTextChunk?.(event.text, event.fullText);
              break;
            case "text-complete":
              responseText = event.fullText || responseText;
              callbacks.onTextComplete?.(responseText);
              break;
            case "audio":
              callbacks.onAudioChunk?.(event.chunk, event.index, event.sentenceIndex);
              break;
            case "done":
              responseText = event.fullText || responseText;
              callbacks.onDone?.(responseText);
              break;
            case "error":
              callbacks.onError?.(event.error);
              break;
            case "fallback":
              // Server fell back to sync mode — still works, just slower
              console.log("[agent] Streaming fell back to sync:", event.reason);
              break;
          }
        } catch { /* skip malformed JSON */ }
      }
    }

    return { response: responseText || "I didn't catch that. Could you try again?" };
  }

  async end(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(apiUrl(`/api/agent/session/${this.sessionId}`), { method: "DELETE" });
    } catch { /* ignore */ }
    this.sessionId = null;
    this.sequenceId = 0;
    this.createdAt = 0;
    this.lastActivityAt = 0;
  }
}
