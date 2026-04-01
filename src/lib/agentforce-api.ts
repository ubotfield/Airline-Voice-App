import { apiUrl } from "./api-base";

export class AgentforceSession {
  private sessionId: string | null = null;
  private sequenceId: number = 0;

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
  }

  async sendMessage(text: string): Promise<string> {
    if (!this.sessionId) throw new Error("No active session. Call start() first.");
    this.sequenceId++;
    const res = await fetch(apiUrl("/api/agent/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, message: text, sequenceId: this.sequenceId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Message failed: ${res.status}`);
    }
    const data = await res.json();
    return data.response || "I didn't catch that. Could you try again?";
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
