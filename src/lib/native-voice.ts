/**
 * NativeVoiceService V2 — Cross-platform voice with dual STT strategy:
 *
 *   Strategy A (Safari browser only): Web Speech API (SpeechRecognition)
 *   Strategy B (Everything else): MediaRecorder -> server-side Gemini STT
 *
 * TTS: Salesforce LLM Gateway (high-quality Gemini voices like Kore/Aoede)
 * with triple-fallback: <audio> element → AudioContext → browser speechSynthesis.
 *
 * KEY DESIGN (v3 — iOS-proof):
 *   - MediaRecorder pipeline is COMPLETELY INDEPENDENT of AudioContext.
 *   - Recording uses simple timer-based 4-second chunks. No silence detection.
 *   - After every TTS playback, a FRESH MediaStream is acquired via getUserMedia().
 *   - AudioContext is ONLY used for cosmetic volume bars in the UI.
 *   - Explicit state machine prevents stuck states: idle → recording → transcribing → speaking → idle
 */

import { apiUrl } from "./api-base";

function dbg(msg: string): void {
  console.log(`[native-voice] ${msg}`);
}

export interface NativeVoiceCallbacks {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: string) => void;
  onVolumeChange?: (volume: number) => void;
  onStatusChange?: (status: string) => void;
  onUserTranscription?: (text: string) => Promise<string>;
}

type SttMode = "speech-recognition" | "media-recorder";
type PipelineState = "idle" | "recording" | "transcribing" | "speaking";

function isStandalonePWA(): boolean {
  if ((navigator as any).standalone === true) return true;
  if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
  if (window.matchMedia?.("(display-mode: fullscreen)")?.matches) return true;
  return false;
}

export class NativeVoiceService {
  private callbacks: NativeVoiceCallbacks = {};
  private _isConnected = false;
  private shouldRestart = false;
  private greetingDone = false;
  private pipelineState: PipelineState = "idle";

  // Audio resources
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private volumeAnalyser: AnalyserNode | null = null;
  private volumeInterval: number | null = null;

  // Pre-unlocked resources (from tap gate)
  private preUnlockedStream: MediaStream | null = null;
  private preUnlockedContext: AudioContext | null = null;

  // Visibility listener
  private visibilityHandler: (() => void) | null = null;

  // STT mode
  private sttMode: SttMode = "speech-recognition";
  private recognition: any = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private chunkTimer: number | null = null;
  private supportedMimeType: string = "audio/mp4";
  private pipelineSafetyTimer: number | null = null;
  private peakVolumeDuringChunk = 0;

  // TTS voice preference (cached)
  private preferredVoice: SpeechSynthesisVoice | null = null;

  private micUnlockPromise: Promise<MediaStream | null> | null = null;

  get isConnected(): boolean {
    return this._isConnected;
  }

  // ===================================================================
  // PHASE 1: unlockAudio() — MUST be called synchronously from user tap
  // ===================================================================

  unlockAudio(): void {
    dbg("unlockAudio() called — tap gate");

    if (typeof window !== "undefined" && window.location.protocol !== "https:" && window.location.hostname !== "localhost") {
      dbg("⚠️ NOT HTTPS — getUserMedia will fail!");
    }

    // 1. Grab mic immediately
    this.micUnlockPromise = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }).then((stream) => {
      dbg(`unlockAudio: mic OK tracks=${stream.getAudioTracks().length}`);
      this.preUnlockedStream = stream;
      return stream;
    }).catch((err) => {
      dbg(`unlockAudio: mic FAILED ${err?.name}: ${err?.message}`);
      return null;
    });

    // 2. Create and unlock AudioContext in gesture context
    try {
      this.preUnlockedContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.preUnlockedContext.resume().catch((e) =>
        dbg(`unlockAudio: AudioCtx resume fail: ${e?.message}`)
      );
      const silentBuffer = this.preUnlockedContext.createBuffer(1, 1, 22050);
      const silentSource = this.preUnlockedContext.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(this.preUnlockedContext.destination);
      silentSource.start(0);
      dbg("unlockAudio: silent buffer played");
    } catch (err: any) {
      dbg(`unlockAudio: AudioCtx create fail: ${err?.message}`);
    }

    // 3. Pre-warm browser speechSynthesis in gesture context
    if ("speechSynthesis" in window) {
      try {
        const warmup = new SpeechSynthesisUtterance("");
        warmup.volume = 0;
        window.speechSynthesis.speak(warmup);
      } catch { /* ignore */ }

      // Pre-select the best voice
      this.selectBestVoice();
    }
  }

  /**
   * Select the best available voice for TTS.
   * Prefers high-quality English voices.
   */
  private selectBestVoice(): void {
    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;

      // Priority order for natural-sounding voices
      const preferredNames = [
        "Samantha",           // iOS high quality
        "Daniel",             // iOS/macOS
        "Karen",              // iOS/macOS Australian
        "Google US English",  // Chrome
        "Google UK English Male",
        "Microsoft David",    // Windows
        "Microsoft Mark",     // Windows
      ];

      for (const name of preferredNames) {
        const v = voices.find(v => v.name.includes(name));
        if (v) { this.preferredVoice = v; dbg(`Selected voice: ${v.name}`); return; }
      }

      // Fallback: any English voice
      const enVoice = voices.find(v => v.lang.startsWith("en"));
      if (enVoice) { this.preferredVoice = enVoice; dbg(`Fallback voice: ${enVoice.name}`); return; }

      // Last resort: first available voice
      if (voices.length > 0) { this.preferredVoice = voices[0]; dbg(`Default voice: ${voices[0].name}`); }
    };

    pickVoice();
    // Voices may load async (Chrome)
    if (!this.preferredVoice && window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = pickVoice;
    }
  }

  async connect(callbacks: NativeVoiceCallbacks): Promise<void> {
    this.callbacks = callbacks;
    callbacks.onStatusChange?.("Connecting...");
    dbg("connect() called");

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    const isPWA = isStandalonePWA();

    if (isPWA) {
      this.sttMode = "media-recorder";
    } else if (SpeechRecognition) {
      this.sttMode = "speech-recognition";
    } else {
      this.sttMode = "media-recorder";
    }
    dbg(`STT mode: ${this.sttMode} isPWA: ${isPWA}`);

    try {
      // Await mic unlock promise
      if (this.micUnlockPromise) {
        dbg("Awaiting micUnlockPromise...");
        const stream = await this.micUnlockPromise;
        this.micUnlockPromise = null;
        if (stream) {
          this.preUnlockedStream = stream;
          dbg(`micUnlockPromise resolved: tracks=${stream.getAudioTracks().length}`);
        } else {
          dbg("micUnlockPromise resolved with NULL");
        }
      }

      // Reuse pre-unlocked mic stream
      if (this.preUnlockedStream) {
        const tracks = this.preUnlockedStream.getAudioTracks();
        if (tracks.length > 0 && tracks[0].readyState === "live") {
          dbg("Reusing pre-unlocked mic stream ✓");
          this.mediaStream = this.preUnlockedStream;
          this.preUnlockedStream = null;
        } else {
          this.preUnlockedStream = null;
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        }
      } else {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }

      this.setupVolumeMonitor(this.mediaStream);

      // Clean up pre-unlocked context (not needed for V2 — TTS is browser-native)
      try { this.preUnlockedContext?.close(); } catch { /* ignore */ }
      this.preUnlockedContext = null;

      if (this.sttMode === "media-recorder") {
        this.supportedMimeType = this.getSupportedMimeType();
        dbg(`MediaRecorder MIME: ${this.supportedMimeType}`);
      }

      this.setupVisibilityListener();

      this.shouldRestart = true;
      if (this.sttMode === "speech-recognition") {
        this.setupRecognition();
        try { this.recognition.start(); } catch (e: any) {
          dbg(`recognition.start() failed: ${e?.message}`);
        }
      }

      this._isConnected = true;
      dbg("connect() done — calling onOpen");
      callbacks.onOpen?.();
      callbacks.onStatusChange?.("Connected");
    } catch (err: any) {
      dbg(`connect() FAILED: ${err?.name}: ${err?.message}`);
      callbacks.onError?.(err.message || "Connection failed");
      throw err;
    }
  }

  // ===================================================================
  // Visibility change listener
  // ===================================================================

  private setupVisibilityListener(): void {
    this.removeVisibilityListener();
    this.visibilityHandler = () => {
      if (document.visibilityState === "visible" && this._isConnected) {
        dbg("App resumed from background — checking audio health");
        if (this.audioContext && this.audioContext.state === "suspended") {
          this.audioContext.resume().catch(() => {});
        }
        const tracks = this.mediaStream?.getAudioTracks();
        if (!tracks || tracks.length === 0 || tracks[0].readyState !== "live") {
          dbg("Mic stream died during background — refreshing");
          this.refreshMicStream().then(() => {
            if (this.pipelineState === "idle" && this.shouldRestart && this.sttMode === "media-recorder") {
              this.startRecordingChunk();
            }
          }).catch(() => {
            this.callbacks.onStatusChange?.("Mic lost — tap Stop and retry");
          });
        } else {
          if (this.pipelineState === "idle" && this.shouldRestart && this.sttMode === "media-recorder") {
            this.startRecordingChunk();
          }
        }
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private removeVisibilityListener(): void {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  // ===================================================================
  // Strategy A: Web Speech API (SpeechRecognition)
  // ===================================================================

  private restartRecognition(): void {
    if (this.sttMode !== "speech-recognition") { this.startRecordingChunk(); return; }
    setTimeout(() => {
      if (!this.shouldRestart || !this._isConnected) return;
      try { if (this.recognition) { this.recognition.start(); return; } } catch { /* ignore */ }
      try { this.setupRecognition(); this.recognition?.start(); } catch {
        setTimeout(() => {
          if (!this.shouldRestart || !this._isConnected) return;
          try { this.setupRecognition(); this.recognition?.start(); } catch { /* ignore */ }
        }, 1000);
      }
    }, 300);
  }

  private setupRecognition(): void {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    try { this.recognition?.stop(); } catch { /* ignore */ }

    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = "en-US";
    this.recognition.maxAlternatives = 1;

    this.recognition.onstart = () => {
      if (this.shouldRestart) this.callbacks.onStatusChange?.("Listening...");
    };
    this.recognition.onresult = (event: any) => {
      const last = event.results[event.results.length - 1];
      if (last.isFinal) {
        const text = last[0].transcript.trim();
        if (text) { dbg(`User said: ${text}`); this.routeToAgent(text); }
      }
    };
    this.recognition.onerror = (event: any) => {
      if (event.error === "no-speech" || event.error === "aborted") {
        if (this.shouldRestart && this._isConnected) this.restartRecognition();
        return;
      }
      this.callbacks.onError?.(event.error);
    };
    this.recognition.onend = () => {
      if (this.shouldRestart && this._isConnected) this.restartRecognition();
    };
  }

  // ===================================================================
  // Strategy B: MediaRecorder -> Server-side STT
  // ===================================================================

  private static readonly CHUNK_DURATION_MS = 4000;
  private static readonly MIN_AUDIO_SIZE = 2000;

  private startRecordingChunk(): void {
    if (!this._isConnected || !this.shouldRestart) return;
    if (this.pipelineState !== "idle") return;

    if (!this.mediaStream) {
      this.refreshMicStream().then(() => {
        if (this.mediaStream && this._isConnected && this.shouldRestart && this.pipelineState === "idle") {
          this.startRecordingChunk();
        }
      }).catch(() => {});
      return;
    }
    const tracks = this.mediaStream.getAudioTracks();
    if (tracks.length === 0 || tracks[0].readyState !== "live") {
      this.refreshMicStream().then(() => {
        if (this.mediaStream && this._isConnected && this.shouldRestart && this.pipelineState === "idle") {
          this.startRecordingChunk();
        }
      }).catch(() => {});
      return;
    }

    this.pipelineState = "recording";
    this.callbacks.onStatusChange?.("Listening...");
    this.recordedChunks = [];

    try {
      const options: MediaRecorderOptions = this.supportedMimeType
        ? { mimeType: this.supportedMimeType, audioBitsPerSecond: 64000 }
        : { audioBitsPerSecond: 64000 };
      this.mediaRecorder = new MediaRecorder(this.mediaStream, options);
    } catch {
      try {
        this.mediaRecorder = new MediaRecorder(this.mediaStream);
        this.supportedMimeType = this.mediaRecorder.mimeType || "audio/mp4";
      } catch (err: any) {
        this.pipelineState = "idle";
        this.callbacks.onError?.("Cannot record audio on this device");
        return;
      }
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.recordedChunks.push(event.data);
    };

    this.mediaRecorder.onstop = () => {
      const chunkCount = this.recordedChunks.length;
      this.clearChunkTimer();
      if (chunkCount > 0 && this.pipelineState === "recording") {
        const actualMime = this.mediaRecorder?.mimeType || this.supportedMimeType;
        const blob = new Blob(this.recordedChunks, { type: actualMime });
        this.recordedChunks = [];
        if (blob.size > NativeVoiceService.MIN_AUDIO_SIZE) {
          this.pipelineState = "transcribing";
          this.transcribeAndRoute(blob, actualMime);
        } else {
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      } else {
        this.recordedChunks = [];
        if (this.pipelineState === "recording") {
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      }
    };

    this.mediaRecorder.onerror = () => {
      this.clearChunkTimer();
      this.pipelineState = "idle";
      this.scheduleNextChunk();
    };

    try {
      this.mediaRecorder.start(250);
    } catch {
      this.pipelineState = "idle";
      this.scheduleNextChunk();
      return;
    }

    this.chunkTimer = window.setTimeout(() => {
      this.chunkTimer = null;
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try { this.mediaRecorder.stop(); } catch {
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      }
    }, NativeVoiceService.CHUNK_DURATION_MS);
  }

  private clearChunkTimer(): void {
    if (this.chunkTimer !== null) { clearTimeout(this.chunkTimer); this.chunkTimer = null; }
  }

  private scheduleNextChunk(): void {
    if (!this.shouldRestart || !this._isConnected) return;
    setTimeout(() => {
      if (this.shouldRestart && this._isConnected && this.pipelineState === "idle") {
        this.startRecordingChunk();
      }
    }, 150);
  }

  private async transcribeAndRoute(blob: Blob, mimeType: string): Promise<void> {
    this.clearPipelineSafety();
    this.pipelineSafetyTimer = window.setTimeout(() => {
      dbg("⚠️ Pipeline stuck 45s — force reset");
      this.pipelineState = "idle";
      if (this._isConnected) {
        this.callbacks.onStatusChange?.("Listening...");
        this.scheduleNextChunk();
      }
    }, 45000);

    try {
      const base64 = await this.blobToBase64(blob);
      const res = await fetch(apiUrl("/api/stt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: base64, mimeType: mimeType.split(";")[0] }),
      });

      if (!res.ok) {
        this.pipelineState = "idle";
        this.scheduleNextChunk();
        return;
      }

      const data = await res.json();
      const text = data.text?.trim();
      if (text && text.length > 0) {
        this.callbacks.onStatusChange?.("Processing...");
        await this.routeToAgent(text);
      } else {
        this.pipelineState = "idle";
        this.scheduleNextChunk();
      }
    } catch {
      this.pipelineState = "idle";
      this.scheduleNextChunk();
    } finally {
      this.clearPipelineSafety();
    }
  }

  private clearPipelineSafety(): void {
    if (this.pipelineSafetyTimer !== null) {
      clearTimeout(this.pipelineSafetyTimer);
      this.pipelineSafetyTimer = null;
    }
  }

  private getSupportedMimeType(): string {
    const types = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    for (const type of types) {
      try { if (MediaRecorder.isTypeSupported(type)) return type; } catch { /* ignore */ }
    }
    return "";
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        resolve(dataUrl.split(",")[1] || "");
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ===================================================================
  // Greeting, Agent routing, TTS
  // ===================================================================

  async sendGreeting(greetingResponse: string): Promise<void> {
    dbg(`sendGreeting: text=${greetingResponse ? greetingResponse.substring(0, 40) + "..." : "(empty)"}`);

    if (!greetingResponse) {
      this.greetingDone = true;
      if (this.sttMode === "media-recorder") this.startRecordingChunk();
      return;
    }

    this.callbacks.onStatusChange?.("Speaking...");
    this.pipelineState = "speaking";
    if (this.sttMode === "speech-recognition") this.pauseListening();

    await this.speakText(greetingResponse);

    await new Promise(r => setTimeout(r, 150));
    this.greetingDone = true;
    this.pipelineState = "idle";

    if (this.sttMode === "speech-recognition") {
      await this.resumeListening();
    } else {
      await this.refreshMicStream();
      this.callbacks.onStatusChange?.("Listening...");
      if (this._isConnected && this.shouldRestart) this.startRecordingChunk();
    }
  }

  private pauseListening(): void {
    this.shouldRestart = false;
    if (this.sttMode === "speech-recognition") {
      try { this.recognition?.stop(); } catch { /* ignore */ }
    } else {
      this.clearChunkTimer();
      try {
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop();
      } catch { /* ignore */ }
    }
  }

  private async resumeListening(): Promise<void> {
    this.shouldRestart = true;
    if (!this._isConnected) return;
    this.callbacks.onStatusChange?.("Listening...");
    if (this.sttMode === "speech-recognition") {
      this.restartRecognition();
    } else {
      try { await this.refreshMicStream(); } catch { /* ignore */ }
      this.pipelineState = "idle";
      this.scheduleNextChunk();
    }
  }

  private async refreshMicStream(): Promise<void> {
    try {
      const newStream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      this.mediaStream?.getTracks().forEach(t => t.stop());
      this.mediaStream = newStream;
      this.setupVolumeMonitor(newStream);
    } catch {
      dbg("refreshMicStream failed, keeping old stream");
    }
  }

  private async routeToAgent(userText: string): Promise<void> {
    if (this.pipelineState === "speaking") return;
    this.pipelineState = "speaking";
    this.callbacks.onStatusChange?.("Processing...");

    try {
      if (this.callbacks.onUserTranscription) {
        if (!this._isConnected) return;
        const agentResponse = await this.callbacks.onUserTranscription(userText);
        if (!this._isConnected) return;

        if (agentResponse) {
          this.callbacks.onStatusChange?.("Speaking...");
          this.pauseListening();
          try { if (this._isConnected) await this.speakText(agentResponse); } catch { /* ignore */ }
          if (!this._isConnected) return;
          await new Promise(r => setTimeout(r, 150));
          this.shouldRestart = true;
          await this.resumeListening();
        } else {
          this.pipelineState = "idle";
          if (this._isConnected) { this.callbacks.onStatusChange?.("Listening..."); this.scheduleNextChunk(); }
        }
      }
    } catch {
      if (!this._isConnected) return;
      this.pauseListening();
      try { if (this._isConnected) await this.speakText("I'm sorry, I had trouble with that. Could you say it again?"); } catch { /* ignore */ }
      if (this._isConnected) {
        this.shouldRestart = true;
        await new Promise(r => setTimeout(r, 150));
        await this.resumeListening();
      }
    } finally {
      if (this.pipelineState === "speaking") this.pipelineState = "idle";
    }
  }

  // ===================================================================
  // TTS: Salesforce LLM Gateway TTS with triple-fallback playback
  // ===================================================================

  // Dedicated AudioContext for TTS playback (separate from volume monitoring)
  private playbackContext: AudioContext | null = null;

  private async speakText(text: string): Promise<void> {
    const MAX_CLIENT_RETRIES = 2;

    // Ensure playback AudioContext is alive and running before any TTS attempt.
    // iOS suspends AudioContext when app backgrounds or after prolonged inactivity.
    await this.ensurePlaybackContext();

    for (let attempt = 1; attempt <= MAX_CLIENT_RETRIES; attempt++) {
      if (!this._isConnected) return;

      try {
        dbg(`Fetching TTS (attempt ${attempt}/${MAX_CLIENT_RETRIES}): ${text.substring(0, 60)}`);
        const res = await fetch(apiUrl("/api/tts"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });

        if (res.ok) {
          const contentType = res.headers.get("content-type") || "audio/mpeg";
          const audioData = await res.arrayBuffer();
          dbg(`TTS response: ${audioData.byteLength} bytes, ${contentType}`);

          if (audioData.byteLength > 0) {
            // Try 1: AudioContext (stays unlocked after initial tap — most reliable)
            await this.ensurePlaybackContext();
            try {
              await this.playAudioBuffer(audioData);
              dbg("AudioContext playback succeeded");
              return;
            } catch (e: any) {
              dbg(`AudioContext failed, trying <audio> element: ${e?.message}`);
            }

            // Try 2: <audio> element fallback
            try {
              await this.playAudioViaElement(audioData, contentType);
              dbg("<audio> element playback succeeded");
              return;
            } catch (e: any) {
              dbg(`<audio> element also failed: ${e?.message}`);
            }

            // Both playback methods failed — skip speaking (no robotic fallback)
            dbg("All playback methods failed — skipping speech");
            return;
          }
        } else {
          dbg(`Server TTS HTTP ${res.status} (attempt ${attempt})`);
          if (attempt < MAX_CLIENT_RETRIES) {
            await new Promise(r => setTimeout(r, 150));
            continue;
          }
        }
      } catch (err: any) {
        dbg(`Server TTS error (attempt ${attempt}): ${err?.message}`);
        if (attempt < MAX_CLIENT_RETRIES) {
          await new Promise(r => setTimeout(r, 150));
          continue;
        }
      }
    }

    // No robotic fallback — if server TTS failed, skip speaking entirely
    if (!this._isConnected) return;
    dbg("Server TTS failed — skipping speech (no robotic fallback)");
  }

  /**
   * Ensure the playback AudioContext exists and is in "running" state.
   * iOS suspends AudioContext on background, page visibility changes, or after TTS.
   */
  private async ensurePlaybackContext(): Promise<void> {
    try {
      if (!this.playbackContext || this.playbackContext.state === "closed") {
        dbg("Creating fresh playback AudioContext");
        this.playbackContext = new AudioContext();
      }
      if (this.playbackContext.state === "suspended") {
        dbg("Resuming suspended playback AudioContext");
        await this.playbackContext.resume();
      }
    } catch (err: any) {
      dbg(`ensurePlaybackContext failed: ${err?.message}`);
      try {
        this.playbackContext = new AudioContext();
        await this.playbackContext.resume();
      } catch (e: any) {
        dbg(`Cannot create AudioContext at all: ${e?.message}`);
      }
    }
  }

  private speakWithBrowserTTS(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) { resolve(); return; }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(iosKeepAlive);
        resolve();
      };

      window.speechSynthesis.cancel();

      const timeout = setTimeout(() => {
        dbg("Browser TTS timed out after 5s");
        window.speechSynthesis.cancel();
        finish();
      }, 5000);

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.lang = "en-US";

      if (this.preferredVoice) {
        utterance.voice = this.preferredVoice;
      }

      utterance.onend = finish;
      utterance.onerror = () => finish();

      const iosKeepAlive = setInterval(() => {
        if (window.speechSynthesis.speaking) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 3000);

      window.speechSynthesis.speak(utterance);
    });
  }

  private playAudioViaElement(data: ArrayBuffer, mimeType: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        let settled = false;
        const finish = (success: boolean, reason?: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(safetyTimeout);
          URL.revokeObjectURL(url);
          if (success) resolve(); else reject(reason);
        };

        // Safety timeout: 15s max
        const safetyTimeout = setTimeout(() => {
          dbg("<audio> playback timed out after 15s");
          try { audio.pause(); } catch { /* ignore */ }
          finish(true);
        }, 15000);

        audio.onended = () => finish(true);
        audio.onerror = (e) => finish(false, e);

        const playPromise = audio.play();
        if (playPromise) {
          playPromise.catch((err) => finish(false, err));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  private async playAudioBuffer(data: ArrayBuffer): Promise<void> {
    if (!this.playbackContext || this.playbackContext.state === "closed") {
      this.playbackContext = new AudioContext();
    }
    if (this.playbackContext.state === "suspended") {
      await this.playbackContext.resume();
    }

    const audioBuffer = await this.playbackContext.decodeAudioData(data.slice(0));

    // Add a DynamicsCompressor to normalize volume
    const compressor = this.playbackContext.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-20, this.playbackContext.currentTime);
    compressor.knee.setValueAtTime(10, this.playbackContext.currentTime);
    compressor.ratio.setValueAtTime(8, this.playbackContext.currentTime);
    compressor.attack.setValueAtTime(0.003, this.playbackContext.currentTime);
    compressor.release.setValueAtTime(0.15, this.playbackContext.currentTime);

    // Add a GainNode for consistent output level
    const gainNode = this.playbackContext.createGain();
    gainNode.gain.setValueAtTime(1.3, this.playbackContext.currentTime);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimeout);
        resolve();
      };

      const timeoutMs = Math.max(10000, (audioBuffer.duration + 5) * 1000);
      const safetyTimeout = setTimeout(() => {
        dbg(`AudioContext playback timed out after ${timeoutMs}ms`);
        finish();
      }, timeoutMs);

      try {
        const source = this.playbackContext!.createBufferSource();
        source.buffer = audioBuffer;
        // Route: source → compressor → gain → speakers
        source.connect(compressor);
        compressor.connect(gainNode);
        gainNode.connect(this.playbackContext!.destination);
        source.onended = () => finish();
        source.start();
      } catch (err) {
        clearTimeout(safetyTimeout);
        reject(err);
      }
    });
  }

  // ===================================================================
  // Volume monitoring (cosmetic only)
  // ===================================================================

  private setupVolumeMonitor(stream: MediaStream): void {
    this.stopVolumeMonitor();
    try {
      if (this.audioContext && this.audioContext.state !== "closed") this.audioContext.close();
    } catch { /* ignore */ }

    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.volumeAnalyser = this.audioContext.createAnalyser();
      this.volumeAnalyser.fftSize = 256;
      source.connect(this.volumeAnalyser);

      const dataArray = new Uint8Array(this.volumeAnalyser.frequencyBinCount);
      this.volumeInterval = window.setInterval(() => {
        if (!this.volumeAnalyser) { this.stopVolumeMonitor(); return; }
        this.volumeAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const average = sum / dataArray.length / 255;
        this.callbacks.onVolumeChange?.(average);
        if (this.pipelineState === "recording" && average > this.peakVolumeDuringChunk) {
          this.peakVolumeDuringChunk = average;
        }
      }, 150);
    } catch {
      this.audioContext = null;
      this.volumeAnalyser = null;
    }
  }

  private stopVolumeMonitor(): void {
    if (this.volumeInterval !== null) { clearInterval(this.volumeInterval); this.volumeInterval = null; }
  }

  // ===================================================================
  // Disconnect
  // ===================================================================

  disconnect(): void {
    dbg("Disconnecting...");
    this.shouldRestart = false;
    this._isConnected = false;
    this.greetingDone = false;
    this.pipelineState = "idle";

    this.removeVisibilityListener();

    if (this.preUnlockedStream) {
      this.preUnlockedStream.getTracks().forEach(t => t.stop());
      this.preUnlockedStream = null;
    }
    try { this.preUnlockedContext?.close(); } catch { /* ignore */ }
    this.preUnlockedContext = null;

    this.stopVolumeMonitor();
    this.clearChunkTimer();
    this.clearPipelineSafety();

    try { this.recognition?.stop(); } catch { /* ignore */ }
    this.recognition = null;

    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop();
    } catch { /* ignore */ }
    this.mediaRecorder = null;
    this.recordedChunks = [];

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.volumeAnalyser = null;

    try { this.audioContext?.close(); } catch { /* ignore */ }
    this.audioContext = null;

    try { this.playbackContext?.close(); } catch { /* ignore */ }
    this.playbackContext = null;

    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    this.callbacks.onClose?.();
  }
}
