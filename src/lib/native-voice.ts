/**
 * NativeVoiceService V3 — Cross-platform voice with smart STT strategy:
 *
 *   Strategy A (PWA + browser): Web Speech API first, MediaRecorder fallback
 *   Strategy B (no Web Speech API): MediaRecorder -> server-side Gemini STT
 *
 * V3 OPTIMIZATIONS:
 *   - Web Speech API tried first EVEN in PWA mode (faster, zero server cost)
 *   - Silence detection: recording stops ~800ms after user stops speaking (saves ~2-3s)
 *   - Streaming TTS: audio chunks play as they arrive (time-to-first-audio ~500ms)
 *   - MediaRecorder pipeline is COMPLETELY INDEPENDENT of AudioContext.
 *   - After every TTS playback, a FRESH MediaStream is acquired via getUserMedia().
 *   - AudioContext used for volume bars AND silence detection.
 *   - Explicit state machine: idle → recording → transcribing → speaking → idle
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
  onUserTranscription?: (text: string) => Promise<string | any>;
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

  // Listening watchdog — detects when recognition silently stalls
  private listeningWatchdog: number | null = null;
  private lastRecognitionActivity = 0;

  // Recognition health check — detects silent hangs where start() succeeds but no events fire
  private recognitionHealthTimer: number | null = null;

  // Silence detection
  private silenceDetectionInterval: number | null = null;
  private silenceStartTime: number | null = null;
  private speechDetected = false;
  private static readonly SILENCE_THRESHOLD = 0.02; // Volume below this = silence
  private static readonly SILENCE_DURATION_MS = 800; // Increased from 250ms — 250 was too aggressive, cutting chunks before speech captured
  private static readonly MAX_RECORD_DURATION_MS = 8000; // Hard cap at 8s
  private static readonly MIN_SPEECH_DURATION_MS = 300; // Minimum speech before stopping

  // Barge-in: user can interrupt playback by speaking
  private bargeInDetectionInterval: number | null = null;
  private bargeInSpeechStart: number | null = null;
  private bargeInTriggered = false;
  private currentAudioElement: HTMLAudioElement | null = null;
  private currentAudioSource: AudioBufferSourceNode | null = null;
  private static readonly BARGE_IN_THRESHOLD = 0.08; // Must be well above speaker feedback level
  private static readonly BARGE_IN_CONFIRM_MS = 400; // Confirm speech for 400ms before interrupting

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

    // PWA standalone mode: webkitSpeechRecognition exists but is unreliable
    // (silently fails, hangs, or throws not-allowed). Use MediaRecorder directly.
    // Regular browser: Web Speech API is instant and reliable — use it first.
    if (isPWA) {
      this.sttMode = "media-recorder";
      dbg("PWA mode detected — using MediaRecorder STT (Speech API unreliable in standalone)");
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

      // KEEP the pre-unlocked AudioContext for TTS playback — it was created
      // during the user tap gesture, so it has full audio output permission.
      if (this.preUnlockedContext && this.preUnlockedContext.state !== "closed") {
        dbg("Promoting pre-unlocked AudioContext to playbackContext");
        this.playbackContext = this.preUnlockedContext;
        this.preUnlockedContext = null;
      }

      if (this.sttMode === "media-recorder") {
        this.supportedMimeType = this.getSupportedMimeType();
        dbg(`MediaRecorder MIME: ${this.supportedMimeType}`);
      }

      this.setupVisibilityListener();

      this.shouldRestart = true;
      // Fix 1: Do NOT start recognition here — it will be started by resumeListening()
      // after the greeting finishes. Starting it early causes conflicts when
      // resumeListening() → restartRecognition() tries to start an already-active instance,
      // leading to silent hangs on mobile Chrome/Safari.
      if (this.sttMode === "speech-recognition") {
        this.setupRecognition(); // Wire up handlers only — don't .start()
      }

      this._isConnected = true;
      this.lastRecognitionActivity = Date.now();
      this.startListeningWatchdog();
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
  // Listening watchdog — detects when STT silently stalls
  // ===================================================================

  private startListeningWatchdog(): void {
    this.stopListeningWatchdog();
    this.listeningWatchdog = window.setInterval(() => {
      if (!this._isConnected || !this.greetingDone) return;

      // 2B: Detect stale "speaking" state — if stuck speaking for >15s with no
      // active audio sources, force-reset to idle and resume listening.
      if (this.pipelineState === "speaking") {
        const staleDuration = Date.now() - this.lastRecognitionActivity;
        if (staleDuration > 15000) {
          const hasActiveAudio = this.streamingDraining || this.currentAudioElement || this.currentAudioSource;
          if (!hasActiveAudio) {
            dbg(`⚠️ Watchdog: stuck in "speaking" for ${Math.round(staleDuration / 1000)}s with no audio — force-resetting`);
            this.lastRecognitionActivity = Date.now();
            this.pipelineState = "idle";
            this.cancelAllPlayback();
            this.shouldRestart = true;
            this.callbacks.onStatusChange?.("Listening...");
            this.resumeListening();
          }
        }
        return;
      }

      // PWA fix: Detect stuck "recording" state (>12s — well past the 8s chunk cap)
      if (this.pipelineState === "recording") {
        const staleDuration = Date.now() - this.lastRecognitionActivity;
        if (staleDuration > 12000) {
          dbg(`⚠️ Watchdog: stuck in "recording" for ${Math.round(staleDuration / 1000)}s — force-resetting`);
          this.lastRecognitionActivity = Date.now();
          this.stopSilenceDetection();
          this.clearChunkTimer();
          if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
            try { this.mediaRecorder.stop(); } catch { /* ignore */ }
          }
          this.pipelineState = "idle";
          this.shouldRestart = true;
          this.callbacks.onStatusChange?.("Listening...");
          this.scheduleNextChunk();
        }
        return;
      }

      // PWA fix: Detect stuck "transcribing" state (>20s — server STT shouldn't take this long)
      if (this.pipelineState === "transcribing") {
        const staleDuration = Date.now() - this.lastRecognitionActivity;
        if (staleDuration > 20000) {
          dbg(`⚠️ Watchdog: stuck in "transcribing" for ${Math.round(staleDuration / 1000)}s — force-resetting`);
          this.lastRecognitionActivity = Date.now();
          this.pipelineState = "idle";
          this.shouldRestart = true;
          this.callbacks.onStatusChange?.("Listening...");
          this.scheduleNextChunk();
        }
        return;
      }

      if (!this.shouldRestart) return;
      if (this.pipelineState !== "idle") return;

      // Fix 4: Reduced from 8s to 5s for faster recovery from silent hangs
      const staleDuration = Date.now() - this.lastRecognitionActivity;
      if (staleDuration > 5000) {
        dbg(`⚠️ Listening watchdog: no activity for ${Math.round(staleDuration / 1000)}s — forcing restart`);
        this.lastRecognitionActivity = Date.now(); // prevent rapid re-triggers

        if (this.sttMode === "speech-recognition") {
          // Try stopping and restarting recognition
          try { this.recognition?.stop(); } catch { /* ignore */ }
          setTimeout(() => {
            if (this._isConnected && this.shouldRestart) {
              this.restartRecognition(); // Use restartRecognition for health check + fallback
            }
          }, 200);
        } else {
          // MediaRecorder mode — just kick off a new chunk
          this.startRecordingChunk();
        }

        this.callbacks.onStatusChange?.("Listening...");
      }
    }, 4000);
  }

  private stopListeningWatchdog(): void {
    if (this.listeningWatchdog) {
      clearInterval(this.listeningWatchdog);
      this.listeningWatchdog = null;
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

  private restartRecognition(attempt: number = 1): void {
    if (this.sttMode !== "speech-recognition") { this.startRecordingChunk(); return; }
    const MAX_ATTEMPTS = 5;
    const delay = attempt === 1 ? 100 : attempt <= 3 ? 300 : 800; // #5: Reduced restart delays

    // Clear any existing health check timer
    if (this.recognitionHealthTimer) { clearTimeout(this.recognitionHealthTimer); this.recognitionHealthTimer = null; }

    setTimeout(() => {
      if (!this.shouldRestart || !this._isConnected) return;

      let started = false;

      // First try: reuse existing recognition instance
      try {
        if (this.recognition) {
          this.recognition.start();
          dbg(`restartRecognition: started existing (attempt ${attempt})`);
          started = true;
        }
      } catch { /* ignore */ }

      // Second try: create fresh recognition instance
      if (!started) {
        try {
          this.setupRecognition();
          this.recognition?.start();
          dbg(`restartRecognition: started fresh (attempt ${attempt})`);
          started = true;
        } catch { /* ignore */ }
      }

      if (started) {
        // Fix 2: Health check — if onstart doesn't fire within 3s, recognition
        // silently hung (common on mobile Chrome/Safari). Fall back immediately.
        const activityBefore = this.lastRecognitionActivity;
        this.recognitionHealthTimer = window.setTimeout(() => {
          this.recognitionHealthTimer = null;
          if (this.lastRecognitionActivity === activityBefore && this._isConnected && this.shouldRestart) {
            dbg(`⚠️ Recognition health check FAILED — no onstart in 3s (attempt ${attempt}). Falling back to MediaRecorder.`);
            try { this.recognition?.stop(); } catch { /* ignore */ }
            this.sttMode = "media-recorder";
            this.supportedMimeType = this.getSupportedMimeType();
            this.callbacks.onStatusChange?.("Listening...");
            this.pipelineState = "idle";
            this.startRecordingChunk();
          }
        }, 3000);
        return;
      }

      // Retry if we haven't exceeded max attempts
      if (attempt < MAX_ATTEMPTS) {
        dbg(`restartRecognition: attempt ${attempt} failed, retrying...`);
        this.restartRecognition(attempt + 1);
      } else {
        dbg(`restartRecognition: all ${MAX_ATTEMPTS} attempts failed — falling back to MediaRecorder`);
        // Last resort: fall back to MediaRecorder STT (works everywhere)
        this.sttMode = "media-recorder";
        this.supportedMimeType = this.getSupportedMimeType();
        this.callbacks.onStatusChange?.("Listening...");
        this.pipelineState = "idle";
        this.startRecordingChunk();
      }
    }, delay);
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
      this.lastRecognitionActivity = Date.now();
      dbg(`recognition.onstart — shouldRestart=${this.shouldRestart} pipeline=${this.pipelineState}`);
      if (this.shouldRestart) this.callbacks.onStatusChange?.("Listening...");
    };
    this.recognition.onresult = (event: any) => {
      this.lastRecognitionActivity = Date.now();
      const last = event.results[event.results.length - 1];
      if (last.isFinal) {
        const text = last[0].transcript.trim();
        if (text) {
          dbg(`User said: "${text}" pipeline=${this.pipelineState}`);
          // Don't route if we're already speaking (prevents echo-triggered double responses)
          if (this.pipelineState === "speaking") {
            dbg("Ignoring transcription — pipeline is speaking (likely echo)");
            return;
          }
          this.routeToAgent(text);
        }
      }
    };
    this.recognition.onerror = (event: any) => {
      dbg(`recognition.onerror: ${event.error} shouldRestart=${this.shouldRestart} pipeline=${this.pipelineState}`);
      if (event.error === "no-speech" || event.error === "aborted") {
        if (this.shouldRestart && this._isConnected) this.restartRecognition();
        return;
      }
      // audio-capture and not-allowed errors are transient — retry
      if (event.error === "audio-capture" || event.error === "not-allowed") {
        dbg(`${event.error} error — will retry recognition in 500ms`);
        if (this.shouldRestart && this._isConnected) {
          setTimeout(() => {
            if (this.shouldRestart && this._isConnected) this.restartRecognition();
          }, 500);
        }
        return;
      }
      this.callbacks.onError?.(event.error);
    };
    this.recognition.onend = () => {
      dbg(`recognition.onend — shouldRestart=${this.shouldRestart} pipeline=${this.pipelineState}`);
      if (this.shouldRestart && this._isConnected) this.restartRecognition();
    };
  }

  // ===================================================================
  // Strategy B: MediaRecorder -> Server-side STT
  // ===================================================================

  private static readonly CHUNK_DURATION_MS = 8000; // Hard cap (silence detection stops early)
  private static readonly MIN_AUDIO_SIZE = 500; // Reduced from 2000 — mobile codecs (audio/mp4) produce smaller blobs

  private startRecordingChunk(): void {
    if (!this._isConnected || !this.shouldRestart) return;
    if (this.pipelineState !== "idle") {
      dbg(`startRecordingChunk: skipped (state=${this.pipelineState})`);
      return;
    }
    this.lastRecognitionActivity = Date.now();
    dbg(`startRecordingChunk: starting new recording chunk`);

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
    this.peakVolumeDuringChunk = 0; // Reset peak volume tracker for this chunk

    // PWA fix: Resume monitoring AudioContext before recording — if suspended,
    // silence detection won't work and recording will always run the full 8s.
    if (this.audioContext && this.audioContext.state === "suspended") {
      dbg("startRecordingChunk: resuming suspended monitoring AudioContext");
      this.audioContext.resume().catch(() => {});
    }

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
        dbg(`Recording stopped: ${chunkCount} chunks, blob=${blob.size}B, mime=${actualMime}, peak=${this.peakVolumeDuringChunk.toFixed(3)}`);
        if (blob.size > NativeVoiceService.MIN_AUDIO_SIZE) {
          this.pipelineState = "transcribing";
          this.transcribeAndRoute(blob, actualMime);
        } else {
          dbg(`⚠️ Blob too small (${blob.size}B < ${NativeVoiceService.MIN_AUDIO_SIZE}B) — discarding, scheduling next chunk`);
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      } else {
        dbg(`Recording stopped: no data (chunks=${chunkCount}, state=${this.pipelineState}) — recycling`);
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
    } catch (startErr: any) {
      dbg(`MediaRecorder.start() failed: ${startErr?.message} — refreshing mic and retrying`);
      this.pipelineState = "idle";
      // PWA fix: Refresh mic before retry — the track may have ended after TTS
      this.refreshMicStream().then(() => {
        if (this._isConnected && this.shouldRestart && this.pipelineState === "idle") {
          // Delay slightly to avoid tight retry loop
          setTimeout(() => this.scheduleNextChunk(), 300);
        }
      }).catch(() => {
        if (this._isConnected && this.shouldRestart) {
          setTimeout(() => this.scheduleNextChunk(), 500);
        }
      });
      return;
    }

    // Start silence detection — stop recording early when user stops speaking
    this.speechDetected = false;
    this.silenceStartTime = null;
    this.startSilenceDetection();

    // Hard cap timer (silence detection stops it earlier)
    this.chunkTimer = window.setTimeout(() => {
      this.chunkTimer = null;
      this.stopSilenceDetection();
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try { this.mediaRecorder.stop(); } catch {
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      }
    }, NativeVoiceService.MAX_RECORD_DURATION_MS);
  }

  private clearChunkTimer(): void {
    if (this.chunkTimer !== null) { clearTimeout(this.chunkTimer); this.chunkTimer = null; }
  }

  /**
   * Monitor audio volume during recording. When speech is detected followed by
   * silence for SILENCE_DURATION_MS, stop recording immediately.
   * This saves ~2-3 seconds per turn compared to the fixed 4-second timer.
   */
  private startSilenceDetection(): void {
    this.stopSilenceDetection();
    if (!this.volumeAnalyser) return;

    // 2C: iOS suspends the monitoring AudioContext after TTS playback —
    // resume it before starting silence detection so analyser data is live.
    if (this.audioContext && this.audioContext.state === "suspended") {
      dbg("startSilenceDetection: resuming suspended monitoring AudioContext");
      this.audioContext.resume().catch(() => {});
    }

    const dataArray = new Uint8Array(this.volumeAnalyser.frequencyBinCount);
    const recordingStartTime = Date.now();

    this.silenceDetectionInterval = window.setInterval(() => {
      if (!this.volumeAnalyser || this.pipelineState !== "recording") {
        this.stopSilenceDetection();
        return;
      }

      this.volumeAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const volume = sum / dataArray.length / 255;

      const elapsed = Date.now() - recordingStartTime;

      if (volume > NativeVoiceService.SILENCE_THRESHOLD) {
        // Voice detected
        this.speechDetected = true;
        this.silenceStartTime = null;
      } else if (this.speechDetected && elapsed > NativeVoiceService.MIN_SPEECH_DURATION_MS) {
        // Silence after speech — start counting
        if (this.silenceStartTime === null) {
          this.silenceStartTime = Date.now();
        } else if (Date.now() - this.silenceStartTime >= NativeVoiceService.SILENCE_DURATION_MS) {
          // Enough silence — stop recording NOW
          dbg(`Silence detected after ${elapsed}ms — stopping recording early`);
          this.stopSilenceDetection();
          this.clearChunkTimer();
          if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
            try { this.mediaRecorder.stop(); } catch { /* ignore */ }
          }
        }
      }
    }, 50); // Check every 50ms for responsive silence detection
  }

  private stopSilenceDetection(): void {
    if (this.silenceDetectionInterval !== null) {
      clearInterval(this.silenceDetectionInterval);
      this.silenceDetectionInterval = null;
    }
    this.silenceStartTime = null;
  }

  // ─── Barge-in detection (during playback) ────────────────────────

  private startBargeInDetection(): void {
    this.stopBargeInDetection();
    if (!this.volumeAnalyser) return;
    this.bargeInTriggered = false;
    this.bargeInSpeechStart = null;

    const dataArray = new Uint8Array(this.volumeAnalyser.frequencyBinCount);

    this.bargeInDetectionInterval = window.setInterval(() => {
      if (!this.volumeAnalyser || this.pipelineState !== "speaking") {
        this.stopBargeInDetection();
        return;
      }

      this.volumeAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const volume = sum / dataArray.length / 255;

      if (volume > NativeVoiceService.BARGE_IN_THRESHOLD) {
        if (this.bargeInSpeechStart === null) {
          this.bargeInSpeechStart = Date.now();
        } else if (Date.now() - this.bargeInSpeechStart >= NativeVoiceService.BARGE_IN_CONFIRM_MS) {
          dbg("Barge-in detected — interrupting playback");
          this.bargeInTriggered = true;
          this.stopBargeInDetection();
          this.cancelAllPlayback();
        }
      } else {
        this.bargeInSpeechStart = null;
      }
    }, 50);
  }

  private stopBargeInDetection(): void {
    if (this.bargeInDetectionInterval !== null) {
      clearInterval(this.bargeInDetectionInterval);
      this.bargeInDetectionInterval = null;
    }
    this.bargeInSpeechStart = null;
  }

  private cancelAllPlayback(): void {
    // Stop Audio element playback
    if (this.currentAudioElement) {
      try {
        this.currentAudioElement.pause();
        this.currentAudioElement.removeAttribute("src");
        this.currentAudioElement.load();
      } catch { /* ignore */ }
      this.currentAudioElement = null;
    }

    // Stop AudioBufferSource playback
    if (this.currentAudioSource) {
      try { this.currentAudioSource.stop(); } catch { /* ignore */ }
      this.currentAudioSource = null;
    }

    // Stop streaming playback
    this.streamingPlaybackActive = false;
    this.streamingDraining = false;
    this.streamingAudioQueue = [];
    if (this.streamingResolve) {
      this.streamingResolve();
      this.streamingResolve = null;
    }
  }

  private scheduleNextChunk(): void {
    if (!this.shouldRestart || !this._isConnected) return;
    // #5: Removed 150ms delay — start next chunk immediately
    if (this.pipelineState === "idle") {
      dbg(`scheduleNextChunk: cycling → startRecordingChunk`);
      this.startRecordingChunk();
    } else {
      dbg(`scheduleNextChunk: skipped (state=${this.pipelineState})`);
    }
  }

  private async transcribeAndRoute(blob: Blob, mimeType: string): Promise<void> {
    dbg(`transcribeAndRoute: sending ${blob.size}B audio (${mimeType.split(";")[0]}) to server STT`);
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
        const errBody = await res.text().catch(() => "");
        dbg("⚠️ STT server error: HTTP " + res.status + " — " + errBody.substring(0, 200));
        this.pipelineState = "idle";
        this.scheduleNextChunk();
        return;
      }

      const data = await res.json();
      const text = data.text?.trim();
      const sttDebug = data.debug;
      const sttInfo = [
        (sttDebug?.elapsed || "?") + "ms",
        "finish=" + (sttDebug?.finishReason || "?"),
        "model=" + (sttDebug?.model || "?"),
        "mime=" + (sttDebug?.mime || "?"),
      ].join(", ");
      dbg("STT response: \"" + (text || "(empty)") + "\" (" + sttInfo + ")");
      if (text && text.length > 0) {
        this.callbacks.onStatusChange?.("Processing...");
        await this.routeToAgent(text);
      } else {
        dbg(`⚠️ STT returned empty text — discarding and recycling`);
        this.pipelineState = "idle";
        this.scheduleNextChunk();
      }
    } catch (sttErr: any) {
      dbg("⚠️ STT fetch failed: " + (sttErr?.message || String(sttErr)));
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

  /**
   * Send greeting with pre-fetched audio (from combined endpoint).
   * Falls back to speakText if no audio provided.
   */
  async sendGreetingWithAudio(greetingResponse: string, audioData?: ArrayBuffer): Promise<void> {
    dbg(`sendGreetingWithAudio: text=${greetingResponse ? greetingResponse.substring(0, 40) + "..." : "(empty)"} audio=${audioData ? audioData.byteLength + "B" : "none"}`);

    if (!greetingResponse) {
      this.greetingDone = true;
      this.pipelineState = "idle";
      this.shouldRestart = true;
      await this.resumeListening();
      return;
    }

    this.callbacks.onStatusChange?.("Speaking...");
    this.pipelineState = "speaking";
    this.pauseListening(); // Always pause, regardless of STT mode
    // No barge-in during greetings — speaker feedback would falsely trigger it

    if (audioData && audioData.byteLength > 0) {
      await this.playPreFetchedAudio(audioData);
    } else {
      await this.speakText(greetingResponse);
    }

    // #5: Removed 200ms post-greeting delay
    this.greetingDone = true;
    this.pipelineState = "idle";

    // Resume listening with full retry logic (handles Chrome/PWA recognition restart issues)
    this.shouldRestart = true;
    await this.resumeListening();
  }

  async sendGreeting(greetingResponse: string): Promise<void> {
    dbg(`sendGreeting: text=${greetingResponse ? greetingResponse.substring(0, 40) + "..." : "(empty)"}`);

    if (!greetingResponse) {
      this.greetingDone = true;
      this.pipelineState = "idle";
      this.shouldRestart = true;
      await this.resumeListening();
      return;
    }

    this.callbacks.onStatusChange?.("Speaking...");
    this.pipelineState = "speaking";
    this.pauseListening(); // Always pause, regardless of STT mode
    // No barge-in during greetings — speaker feedback would falsely trigger it

    await this.speakText(greetingResponse);

    // #5: Removed 200ms post-greeting delay
    this.greetingDone = true;
    this.pipelineState = "idle";

    // Resume listening with full retry logic
    this.shouldRestart = true;
    await this.resumeListening();
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

    // Ensure pipelineState is idle before trying to listen
    this.pipelineState = "idle";
    this.lastRecognitionActivity = Date.now(); // reset watchdog
    this.callbacks.onStatusChange?.("Listening...");

    if (this.sttMode === "speech-recognition") {
      // Fix 3: Stop any existing recognition before restarting — prevents
      // InvalidStateError or silent hangs when start() is called on an
      // already-active instance (common on mobile Chrome/Safari).
      try { this.recognition?.stop(); } catch { /* ignore */ }
      // Refresh mic stream before restarting recognition — Chrome/Safari
      // can lose the mic connection after audio playback, especially in PWA mode
      try { await this.refreshMicStream(); } catch { /* ignore */ }
      this.restartRecognition();
    } else {
      try { await this.refreshMicStream(); } catch { /* ignore */ }
      this.scheduleNextChunk();
    }
  }

  private async refreshMicStream(): Promise<void> {
    // #7: Skip getUserMedia if existing track is still live — saves ~50-200ms per turn
    const existingTrack = this.mediaStream?.getAudioTracks()?.[0];
    if (existingTrack && existingTrack.readyState === "live" && existingTrack.enabled) {
      dbg("refreshMicStream: existing track still live, skipping getUserMedia");
      return;
    }

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
      // 3C: Log new track state for debugging mic issues
      const track = newStream.getAudioTracks()[0];
      dbg(`refreshMicStream: new track state=${track?.readyState} enabled=${track?.enabled} label=${track?.label}`);
    } catch (err: any) {
      // 3C: Log failure details
      const oldTrack = this.mediaStream?.getAudioTracks()?.[0];
      dbg(`refreshMicStream failed: ${err?.message} — old track state=${oldTrack?.readyState ?? "none"}`);
    }
  }

  private async routeToAgent(userText: string): Promise<void> {
    if (this.pipelineState === "speaking") return;
    this.pipelineState = "speaking";
    this.callbacks.onStatusChange?.("Processing...");

    // CRITICAL: Pause recognition IMMEDIATELY when entering speaking state.
    // This prevents SpeechRecognition from picking up the agent's own audio
    // output and transcribing it as a new user message (causing double voice).
    // Must happen BEFORE the callback which may play audio during streaming.
    this.pauseListening();

    try {
      if (this.callbacks.onUserTranscription) {
        if (!this._isConnected) return;
        const result = await this.callbacks.onUserTranscription(userText);
        if (!this._isConnected) return;

        // Support string, { text, audioData }, and { text, audioPlayed } responses
        let responseText: string;
        let preAudio: ArrayBuffer | undefined;
        let audioAlreadyPlayed = false;
        if (result && typeof result === "object" && "text" in result) {
          responseText = (result as any).text;
          preAudio = (result as any).audioData;
          audioAlreadyPlayed = !!(result as any).audioPlayed;
        } else {
          responseText = result as string;
        }

        if (responseText) {
          if (audioAlreadyPlayed) {
            // V5 streaming: audio was already played during the callback — just resume listening
            dbg("Audio already played via streaming — skipping playback, resuming listening");
            this.pipelineState = "idle";
          } else {
            this.callbacks.onStatusChange?.("Speaking...");
            // pauseListening() already called above — no need to call again

            // Start barge-in detection so user can interrupt playback
            this.bargeInTriggered = false;
            this.startBargeInDetection();

            try {
              if (this._isConnected) {
                if (preAudio && preAudio.byteLength > 0) {
                  dbg(`Playing pre-fetched audio: ${preAudio.byteLength} bytes`);
                  await this.playPreFetchedAudio(preAudio);
                } else {
                  await this.speakText(responseText);
                }
              }
            } catch { /* ignore */ }

            this.stopBargeInDetection();
          }

          if (!this._isConnected) return;
          if (!audioAlreadyPlayed && this.bargeInTriggered) {
            dbg("Barge-in: skipping post-playback delay, resuming immediately");
          }
          // #5: Removed 150ms post-playback delay — resume listening immediately
          this.shouldRestart = true;
          await this.resumeListening();
        } else {
          this.pipelineState = "idle";
          this.shouldRestart = true;
          if (this._isConnected) { this.callbacks.onStatusChange?.("Listening..."); await this.resumeListening(); }
        }
      }
    } catch {
      if (!this._isConnected) return;
      // pauseListening() already called at top — no need to call again
      try { if (this._isConnected) await this.speakText("I'm sorry, I had trouble with that. Could you say it again?"); } catch { /* ignore */ }
      if (this._isConnected) {
        this.shouldRestart = true;
        // #5: Removed 150ms error-recovery delay
        await this.resumeListening();
      }
    } finally {
      // 2A: Always reset to idle — prevents stuck "speaking" state if an exception
      // occurs in a path that already changed pipelineState to something unexpected
      this.pipelineState = "idle";
    }
  }

  /**
   * Play streaming PCM audio chunks using AudioContext worklet-style scheduling.
   * Each chunk is 24kHz 16-bit mono PCM (raw, no WAV header).
   * Chunks are decoded and queued for gapless playback as they arrive.
   */
  private streamingAudioQueue: ArrayBuffer[] = [];
  private streamingPlaybackActive = false;
  private streamingResolve: (() => void) | null = null;
  private streamingDraining = false; // True while drainStreamingQueue is actively playing audio

  async startStreamingPlayback(): Promise<void> {
    this.streamingAudioQueue = [];
    this.streamingPlaybackActive = true;
    this.streamingDraining = false;
    this.bargeInTriggered = false;
    // CRITICAL: Do NOT start barge-in detection during streaming playback.
    // The mic volume analyser picks up the speaker output (echo) and
    // false-triggers barge-in within ~400ms, killing audio before the user hears it.
    // Barge-in is only useful for non-streaming TTS (speakText/playPreFetchedAudio).
    await this.ensurePlaybackContext();
  }

  addStreamingChunk(pcmBase64: string): void {
    // 3A: Faster base64 decode — single-expression instead of char-by-char loop
    const bytes = Uint8Array.from(atob(pcmBase64), c => c.charCodeAt(0));
    this.streamingAudioQueue.push(bytes.buffer);

    // Start playback if not already playing
    if (this.streamingPlaybackActive && !this.streamingDraining) {
      this.drainStreamingQueue();
    }
  }

  private async drainStreamingQueue(): Promise<void> {
    if (this.streamingDraining) return; // Already draining — new chunks will be picked up by the while loop
    this.streamingDraining = true;

    if (!this.playbackContext || this.playbackContext.state === "closed") {
      this.streamingDraining = false;
      // 1B: Always check streamingResolve on early exit
      if (this.streamingResolve && this.streamingAudioQueue.length === 0) {
        this.streamingResolve();
        this.streamingResolve = null;
      }
      return;
    }
    if (this.playbackContext.state === "suspended") {
      await this.playbackContext.resume();
    }

    while (this.streamingAudioQueue.length > 0 && (this.streamingPlaybackActive || this.streamingResolve)) {
      const pcmData = this.streamingAudioQueue.shift()!;
      try {
        // Convert raw PCM to AudioBuffer (24kHz, 16-bit, mono)
        const samples = new Int16Array(pcmData);
        const audioBuffer = this.playbackContext!.createBuffer(1, samples.length, 24000);
        const channelData = audioBuffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) {
          channelData[i] = samples[i] / 32768; // Int16 to Float32
        }

        await new Promise<void>((resolve) => {
          const source = this.playbackContext!.createBufferSource();
          source.buffer = audioBuffer;
          const gainNode = this.playbackContext!.createGain();
          gainNode.gain.setValueAtTime(1.5, this.playbackContext!.currentTime);
          source.connect(gainNode);
          gainNode.connect(this.playbackContext!.destination);
          source.onended = () => resolve();
          source.start();
        });
      } catch (e: any) {
        dbg(`Streaming chunk playback error: ${e?.message}`);
      }
    }

    this.streamingDraining = false;

    // 1B: Always resolve if streamingResolve exists and queue is drained
    // (removed the !streamingPlaybackActive guard — finishStreamingPlayback sets it false
    //  but the race window between drain exit and resolve assignment caused deadlocks)
    if (this.streamingAudioQueue.length === 0 && this.streamingResolve) {
      this.streamingResolve();
      this.streamingResolve = null;
    }
  }

  finishStreamingPlayback(): Promise<void> {
    this.streamingPlaybackActive = false;
    this.stopBargeInDetection();

    // If nothing is playing and queue is empty, we're done
    if (!this.streamingDraining && this.streamingAudioQueue.length === 0) {
      // Also clear any orphaned resolve from a previous cycle
      if (this.streamingResolve) { this.streamingResolve(); this.streamingResolve = null; }
      return new Promise(r => setTimeout(r, 80));
    }

    // 1A: Wait for drain with a safety timeout to prevent permanent hangs
    return new Promise<void>((resolve) => {
      const safetyTimer = setTimeout(() => {
        dbg("⚠️ finishStreamingPlayback: 5s safety timeout — force-resolving");
        this.streamingResolve = null;
        this.streamingDraining = false;
        this.streamingAudioQueue = [];
        resolve();
      }, 5000);

      this.streamingResolve = () => {
        clearTimeout(safetyTimer);
        setTimeout(resolve, 80);
      };
      // If drain loop isn't running but there are queued chunks, kick it off
      if (!this.streamingDraining && this.streamingAudioQueue.length > 0) {
        this.drainStreamingQueue();
      }
    });
  }

  /** Returns true if playback was interrupted by user speech */
  get wasBargeIn(): boolean {
    return this.bargeInTriggered;
  }

  /**
   * Play pre-fetched audio data (from combined agent+TTS endpoint).
   * Tries <audio> element first, then AudioContext fallback.
   */
  private async playPreFetchedAudio(data: ArrayBuffer): Promise<void> {
    // Try <audio> element first (most reliable)
    try {
      dbg("Playing pre-fetched audio via <audio> element...");
      await this.playAudioViaElement(data, "audio/wav");
      dbg("Pre-fetched audio playback succeeded ✓");
      return;
    } catch (e: any) {
      dbg(`<audio> element failed: ${e?.message}, trying AudioContext...`);
    }

    // Fallback to AudioContext
    await this.ensurePlaybackContext();
    try {
      await this.playAudioBuffer(data);
      dbg("Pre-fetched AudioContext playback succeeded ✓");
    } catch (e: any) {
      dbg(`AudioContext also failed: ${e?.message}`);
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
            // Try 1: <audio> element FIRST — most reliable cross-platform
            // AudioContext has gesture-unlock issues that cause silent playback
            try {
              dbg("Trying <audio> element playback (primary)...");
              await this.playAudioViaElement(audioData, contentType);
              dbg("<audio> element playback succeeded ✓");
              return;
            } catch (e: any) {
              dbg(`<audio> element failed: ${e?.message}, trying AudioContext...`);
            }

            // Try 2: AudioContext fallback
            await this.ensurePlaybackContext();
            try {
              await this.playAudioBuffer(audioData);
              dbg("AudioContext playback succeeded ✓");
              return;
            } catch (e: any) {
              dbg(`AudioContext also failed: ${e?.message}`);
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
      // 3B: Skip resume() if already running — saves an async hop per chunk
      if (this.playbackContext.state === "running") return;
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
        // Use audio/wav for proper browser decoding
        const blobType = mimeType.includes("wav") ? "audio/wav" : mimeType;
        const blob = new Blob([data], { type: blobType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio();
        audio.volume = 1.0;
        audio.preload = "auto";
        this.currentAudioElement = audio; // Track for barge-in cancellation

        let settled = false;
        const finish = (success: boolean, reason?: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(safetyTimeout);
          if (this.currentAudioElement === audio) this.currentAudioElement = null;
          try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { /* ignore */ }
          URL.revokeObjectURL(url);
          if (success) resolve(); else reject(reason);
        };

        // Safety timeout based on audio size (rough: 48kB/s for 24kHz 16-bit mono)
        const estimatedDurationMs = Math.max(15000, (data.byteLength / 48000) * 1000 + 5000);
        const safetyTimeout = setTimeout(() => {
          dbg(`<audio> playback timed out after ${(estimatedDurationMs / 1000).toFixed(0)}s`);
          finish(true);
        }, estimatedDurationMs);

        audio.onended = () => {
          dbg("<audio> onended fired");
          finish(true);
        };
        audio.onerror = (e) => {
          dbg(`<audio> onerror: ${audio.error?.code} ${audio.error?.message}`);
          finish(false, e);
        };
        audio.oncanplaythrough = () => {
          dbg(`<audio> canplaythrough — duration=${audio.duration.toFixed(2)}s`);
        };

        audio.src = url;
        audio.load();

        const playPromise = audio.play();
        if (playPromise) {
          playPromise.then(() => {
            dbg(`<audio> play() resolved — playing audio`);
          }).catch((err) => {
            dbg(`<audio> play() rejected: ${err?.message}`);
            finish(false, err);
          });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  private async playAudioBuffer(data: ArrayBuffer): Promise<void> {
    dbg(`playAudioBuffer: input ${data.byteLength} bytes`);

    // Always use the existing playbackContext (gesture-unlocked).
    // Only create new one as absolute last resort.
    if (!this.playbackContext || this.playbackContext.state === "closed") {
      dbg("playAudioBuffer: WARNING — no gesture-unlocked context, creating new one (may be silent)");
      this.playbackContext = new AudioContext();
    }

    dbg(`playAudioBuffer: context state=${this.playbackContext.state} sampleRate=${this.playbackContext.sampleRate}`);

    if (this.playbackContext.state === "suspended") {
      dbg("playAudioBuffer: resuming suspended context");
      await this.playbackContext.resume();
      dbg(`playAudioBuffer: after resume state=${this.playbackContext.state}`);
    }

    dbg("playAudioBuffer: decoding audio data...");
    const audioBuffer = await this.playbackContext.decodeAudioData(data.slice(0));
    dbg(`playAudioBuffer: decoded OK — duration=${audioBuffer.duration.toFixed(2)}s channels=${audioBuffer.numberOfChannels} sampleRate=${audioBuffer.sampleRate}`);

    // Simplified audio chain: source → gain → speakers
    // Removed DynamicsCompressor which could suppress low-level audio to near-silence
    const gainNode = this.playbackContext.createGain();
    gainNode.gain.setValueAtTime(1.5, this.playbackContext.currentTime);

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
        this.currentAudioSource = source; // Track for barge-in cancellation
        // Simplified: source → gain → speakers (no compressor)
        source.connect(gainNode);
        gainNode.connect(this.playbackContext!.destination);
        source.onended = () => {
          dbg("playAudioBuffer: source.onended fired");
          if (this.currentAudioSource === source) this.currentAudioSource = null;
          finish();
        };
        dbg("playAudioBuffer: starting playback...");
        source.start();
        dbg(`playAudioBuffer: started — context state=${this.playbackContext!.state}`);
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

    this.stopListeningWatchdog();
    if (this.recognitionHealthTimer) { clearTimeout(this.recognitionHealthTimer); this.recognitionHealthTimer = null; }
    this.stopBargeInDetection();
    this.stopSilenceDetection();
    this.cancelAllPlayback();
    this.removeVisibilityListener();

    if (this.preUnlockedStream) {
      this.preUnlockedStream.getTracks().forEach(t => t.stop());
      this.preUnlockedStream = null;
    }
    try { this.preUnlockedContext?.close(); } catch { /* ignore */ }
    this.preUnlockedContext = null;

    this.stopVolumeMonitor();
    this.stopSilenceDetection();
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
