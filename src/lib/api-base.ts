declare const __API_BASE_URL__: string;

let _apiBase: string | null = null;

export function getApiBase(): string {
  if (_apiBase !== null) return _apiBase;

  try {
    if (typeof __API_BASE_URL__ === "string" && __API_BASE_URL__) {
      _apiBase = __API_BASE_URL__;
      console.log("[api-base] Using build-time API_BASE_URL:", _apiBase);
      return _apiBase;
    }
  } catch { /* Not defined */ }

  const isCapacitor =
    (window as any).Capacitor?.isNativePlatform?.() ||
    window.location.protocol === "capacitor:";

  if (isCapacitor) {
    _apiBase = "https://delta-voice-app-v1-29f00fe87641.herokuapp.com"; // #8: Fixed — was pointing to QSR app
    console.log("[api-base] Capacitor detected, using:", _apiBase);
    return _apiBase;
  }

  _apiBase = "";
  return _apiBase;
}

export function apiUrl(path: string): string {
  return `${getApiBase()}${path}`;
}
