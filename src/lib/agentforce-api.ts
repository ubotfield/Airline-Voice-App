import { apiUrl } from "./api-base";

export class AgentforceSession {
  private sessionId: string | null = null;
  private sequenceId: number = 0;
  private personaInjected: boolean = false;
  private personaContext: string = "";
  private personaVarsCache: Array<{ name: string; type: string; value: string }> = [];

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  async start(): Promise<void> {
    const res = await fetch(apiUrl("/api/agent/session"), { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Failed to start session: ${res.status}`);
    }
    const data = await res.json();
    this.sessionId = data.sessionId;
    this.sequenceId = 0;
    this.personaInjected = false;
    this.personaContext = "";
    this.personaVarsCache = [];

    // Pre-fetch persona so it's ready for every message
    await this.loadPersona();
  }

  /**
   * Loads persona data once and caches it for the session.
   * The context string is prepended to EVERY message so the agent never re-asks.
   */
  private async loadPersona(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/demo-persona"));
      if (!res.ok) return;
      const persona = await res.json();

      const parts: string[] = [];
      if (persona.customerName) {
        parts.push(`my name is ${persona.customerName}`);
        this.personaVarsCache.push({ name: "CustomerName", type: "Text", value: persona.customerName });
      }
      if (persona.customerPhone) {
        parts.push(`my phone number is ${persona.customerPhone}`);
        this.personaVarsCache.push({ name: "CustomerPhone", type: "Text", value: persona.customerPhone });
      }
      if (persona.customerEmail) {
        parts.push(`my email is ${persona.customerEmail}`);
        this.personaVarsCache.push({ name: "CustomerEmail", type: "Text", value: persona.customerEmail });
      }
      if (parts.length > 0) {
        this.personaContext = `[Customer info — do not ask again: ${parts.join(", ")}] `;
      }
    } catch { /* ignore */ }
  }

  /**
   * Returns Agentforce-compatible context variables (only on first call).
   */
  private getPersonaVariables(): Array<{ name: string; type: string; value: string }> {
    if (this.personaInjected) return [];
    this.personaInjected = true;
    return this.personaVarsCache;
  }

  /**
   * Prepends persona context to the message so the agent always knows
   * the customer's name/phone/email without needing to ask.
   */
  private enrichMessage(text: string): string {
    // Only prepend persona context on the first message — agent session memory retains it
    if (!this.personaContext || this.personaInjected) return text;
    return this.personaContext + text;
  }

  async sendMessage(text: string): Promise<string> {
    if (!this.sessionId) throw new Error("No active session. Call start() first.");
    this.sequenceId++;
    const variables = this.getPersonaVariables();
    const res = await fetch(apiUrl("/api/agent/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, message: this.enrichMessage(text), sequenceId: this.sequenceId, variables }),
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
    if (!this.sessionId) throw new Error("No active session. Call start() first.");
    this.sequenceId++;
    const variables = this.getPersonaVariables();
    const res = await fetch(apiUrl("/api/agent/speak"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, message: this.enrichMessage(text), sequenceId: this.sequenceId, variables }),
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
    if (!this.sessionId) throw new Error("No active session. Call start() first.");
    this.sequenceId++;
    const variables = this.getPersonaVariables();

    const res = await fetch(apiUrl("/api/agent/speak-stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.sessionId,
        message: this.enrichMessage(text),
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
    }
  ): Promise<{ response: string }> {
    if (!this.sessionId) throw new Error("No active session. Call start() first.");
    this.sequenceId++;
    const variables = this.getPersonaVariables();

    const res = await fetch(apiUrl("/api/agent/message-stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.sessionId,
        message: this.enrichMessage(text),
        sequenceId: this.sequenceId,
        variables,
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
  }
}
