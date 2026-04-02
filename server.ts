import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

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
  const { sessionId, message, sequenceId } = req.body;

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
          variables: [],
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

// ─── Menu Route ──────────────────────────────────────────────────

app.get("/api/menu", async (_req, res) => {
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
    return res.json({ items, source: "salesforce" });
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

// ─── Demo Persona Routes ────────────────────────────────────────

app.get("/api/demo-persona", async (_req, res) => {
  try {
    const query = encodeURIComponent(
      "SELECT Id, Customer_Name__c, Customer_Phone__c, Customer_Email__c FROM Demo_Persona__c"
    );
    const sfRes = await sfFetch(`/services/data/v62.0/query/?q=${query}`);
    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[demo-persona] Query failed:", sfRes.status, err);
      // Surface the actual SF error for debugging
      return res.status(sfRes.status).json({
        id: null, customerName: "", customerPhone: "", customerEmail: "", isConfigured: false,
        _debug: { sfStatus: sfRes.status, sfError: err.substring(0, 500) }
      });
    }
    const data = await sfRes.json();
    if (data.records?.length) {
      const r = data.records[0];
      return res.json({
        id: r.Id,
        customerName: r.Customer_Name__c || "",
        customerPhone: r.Customer_Phone__c || "",
        customerEmail: r.Customer_Email__c || "",
        isConfigured: !!(r.Customer_Name__c && r.Customer_Phone__c),
      });
    }
    return res.json({ id: null, customerName: "", customerPhone: "", customerEmail: "", isConfigured: false });
  } catch (err: any) {
    console.error("[demo-persona] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put("/api/demo-persona", async (req, res) => {
  const { customerName, customerPhone, customerEmail } = req.body;
  try {
    // Check if record already exists
    const query = encodeURIComponent("SELECT Id FROM Demo_Persona__c LIMIT 1");
    const checkRes = await sfFetch(`/services/data/v62.0/query/?q=${query}`);

    if (!checkRes.ok) {
      const err = await checkRes.text();
      console.error("[demo-persona] Check query failed:", checkRes.status, err);
      return res.status(checkRes.status).json({
        error: "Failed to query demo persona",
        _debug: { sfStatus: checkRes.status, sfError: err.substring(0, 500) }
      });
    }

    const checkData = await checkRes.json();

    if (checkData.records?.length) {
      // Update existing record
      const recordId = checkData.records[0].Id;
      const sfRes = await sfFetch(`/services/data/v62.0/sobjects/Demo_Persona__c/${recordId}`, {
        method: "PATCH",
        body: JSON.stringify({
          Customer_Name__c: customerName || null,
          Customer_Phone__c: customerPhone || null,
          Customer_Email__c: customerEmail || null,
        }),
      });
      if (!sfRes.ok && sfRes.status !== 204) {
        const err = await sfRes.text();
        console.error("[demo-persona] Update failed:", sfRes.status, err);
        return res.status(sfRes.status).json({
          error: "Failed to update demo persona",
          _debug: { sfStatus: sfRes.status, sfError: err.substring(0, 500) }
        });
      }
      console.log("[demo-persona] Updated record:", recordId);
      return res.json({ success: true, action: "updated", id: recordId });
    } else {
      // Create new org-level record — get org ID dynamically
      const orgQuery = encodeURIComponent("SELECT Id FROM Organization LIMIT 1");
      const orgRes = await sfFetch(`/services/data/v62.0/query/?q=${orgQuery}`);
      let orgId = "00DWt00000HCrmjMAD"; // fallback
      if (orgRes.ok) {
        const orgData = await orgRes.json();
        if (orgData.records?.length) orgId = orgData.records[0].Id;
      }

      const sfRes = await sfFetch(`/services/data/v62.0/sobjects/Demo_Persona__c`, {
        method: "POST",
        body: JSON.stringify({
          Customer_Name__c: customerName || null,
          Customer_Phone__c: customerPhone || null,
          Customer_Email__c: customerEmail || null,
          SetupOwnerId: orgId,
        }),
      });
      if (!sfRes.ok) {
        const err = await sfRes.text();
        console.error("[demo-persona] Create failed:", sfRes.status, err);
        return res.status(sfRes.status).json({
          error: "Failed to create demo persona",
          _debug: { sfStatus: sfRes.status, sfError: err.substring(0, 500) }
        });
      }
      const created = await sfRes.json();
      console.log("[demo-persona] Created record:", created.id);
      return res.json({ success: true, action: "created", id: created.id });
    }
  } catch (err: any) {
    console.error("[demo-persona] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Send Receipt Route ─────────────────────────────────────────

app.post("/api/send-receipt", async (req, res) => {
  const { orderNumber, customerEmail } = req.body;
  if (!orderNumber || !customerEmail) {
    return res.status(400).json({ error: "orderNumber and customerEmail are required" });
  }

  try {
    // Call the InvocableMethod via Apex REST-like composite approach
    // Use /services/data/vXX.0/actions/custom/apex/SendOrderReceiptService
    const sfRes = await sfFetch(`/services/data/v62.0/actions/custom/apex/SendOrderReceiptService`, {
      method: "POST",
      body: JSON.stringify({
        inputs: [{
          orderNumber: orderNumber,
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

// ─── Health Check ────────────────────────────────────────────────

app.get("/api/health", async (_req, res) => {
  const hasConfig = !!(SF_CLIENT_ID && SF_CLIENT_SECRET && SF_AGENT_ID);
  res.json({
    status: "ok",
    version: "v2",
    hasConfig,
    loginUrl: SF_LOGIN_URL || "not set",
    agentId: SF_AGENT_ID ? `${SF_AGENT_ID.substring(0, 8)}...` : "not set",
    tts: { provider: "browser-native", note: "Using browser speechSynthesis (free, zero-latency)" },
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
  console.log(`   TTS: Browser Native (speechSynthesis) — FREE ✓`);
  console.log(`   STT: Web Speech API (primary) + Gemini (fallback) ${process.env.GEMINI_API_KEY ? "✓" : "⚠️  No GEMINI_API_KEY"}`);
  console.log(`   V2 Changes: Removed ElevenLabs dependency, using browser-native TTS\n`);
});
