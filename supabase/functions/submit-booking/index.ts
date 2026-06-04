import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type BookingPayload = {
  nome: string;
  canzone: string;
  artista: string;
  email?: string | null;
  serata_id?: number | null;
  selfie_url?: string | null;
  recaptcha_token?: string | null;
};

function getPendingExpiryMinutes(): number {
  const raw = Deno.env.get("BOOKING_PENDING_EXPIRY_MIN") ?? "30";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return 30;
  return Math.min(parsed, 60);
}

function parseAllowedOrigins(): string[] {
  const raw = Deno.env.get("ALLOWED_ORIGINS") ?? "*";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getCorsHeaders(origin: string | null): HeadersInit {
  const allowedOrigins = parseAllowedOrigins();
  const allowAny = allowedOrigins.includes("*");
  const isAllowed = Boolean(origin) && allowedOrigins.includes(origin!);
  const allowOrigin = allowAny ? "*" : (isAllowed ? origin! : "null");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

function jsonResponse(
  req: Request,
  status: number,
  payload: { success: boolean; data: unknown; error: { code: string; message: string } | null },
): Response {
  const origin = req.headers.get("origin");
  return new Response(JSON.stringify(payload), {
    status,
    headers: getCorsHeaders(origin),
  });
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validatePayload(payload: unknown): { ok: true; data: BookingPayload } | { ok: false; message: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, message: "Body JSON non valido." };
  }

  const body = payload as Record<string, unknown>;
  const nome = normalizeText(body.nome);
  const canzone = normalizeText(body.canzone);
  const artista = normalizeText(body.artista);
  const serata_id = body.serata_id;
  let parsedSerataId: number | null = null;

  if (!nome || !canzone || !artista) {
    return { ok: false, message: "I campi nome, canzone e artista sono obbligatori." };
  }

  if (nome.length > 80 || canzone.length > 140 || artista.length > 140) {
    return { ok: false, message: "Uno o più campi superano la lunghezza massima consentita." };
  }

  if (serata_id !== undefined && serata_id !== null && serata_id !== "") {
    const normalizedSerataId = typeof serata_id === "number"
      ? serata_id
      : Number(String(serata_id).trim());

    if (!Number.isInteger(normalizedSerataId) || normalizedSerataId <= 0) {
      return { ok: false, message: "serata_id deve essere un intero positivo oppure null." };
    }

    parsedSerataId = normalizedSerataId;
  }

  // email è opzionale: se presente deve essere un indirizzo valido, max 254 caratteri
  const email_raw = typeof (body as Record<string, unknown>).email === "string"
    ? ((body as Record<string, unknown>).email as string).trim().toLowerCase()
    : null;
  let email: string | null = null;
  if (email_raw) {
    if (email_raw.length > 254) {
      return { ok: false, message: "L'indirizzo email supera la lunghezza massima consentita." };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email_raw)) {
      return { ok: false, message: "Indirizzo email non valido." };
    }
    email = email_raw;
  }

  // selfie_url è opzionale: deve essere una stringa HTTP/HTTPS o null
  const selfie_url_raw = typeof (body as Record<string, unknown>).selfie_url === 'string'
    ? ((body as Record<string, unknown>).selfie_url as string).trim()
    : null;
  const selfie_url = selfie_url_raw && /^https?:\/\/.{8,}/.test(selfie_url_raw)
    ? selfie_url_raw
    : null;

  return {
    ok: true,
    data: {
      nome,
      canzone,
      artista,
      email,
      serata_id: parsedSerataId,
      selfie_url,
    },
  };
}

async function validateUserToken(req: Request): Promise<{ ok: true } | { ok: false }> {
  const requireAuth = (Deno.env.get("REQUIRE_AUTH") ?? "false").toLowerCase() === "true";
  if (!requireAuth) return { ok: true };

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) return { ok: false };

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return { ok: false };

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return { ok: false };

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) return { ok: false };
  return { ok: true };
}

async function getOpenSerata(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin
    .from("serate")
    .select("id, vincitore_decretato, winner_reveal_countdown_active, notifiche_telegram_abilitate")
    .eq("aperta", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { ok: false as const, error };
  }

  return { ok: true as const, data };
}

async function cleanupExpiredPendingBookings(admin: ReturnType<typeof createClient>) {
  const expiryMinutes = getPendingExpiryMinutes();
  const cutoff = new Date(Date.now() - expiryMinutes * 60 * 1000).toISOString();
  const { error } = await admin
    .from("prenotazioni")
    .delete()
    .eq("approvata", false)
    .eq("cantata", false)
    .lt("created_at", cutoff);
  if (error) {
    return { ok: false as const, error };
  }
  return { ok: true as const };
}

async function computeBookingNumber(
  admin: ReturnType<typeof createClient>,
  serataId: number,
  bookingId: number,
): Promise<{ ok: true; value: number } | { ok: false; error: unknown }> {
  const { count, error } = await admin
    .from("prenotazioni")
    .select("id", { count: "exact", head: true })
    .eq("serata_id", serataId)
    .lte("id", bookingId);

  if (error) return { ok: false, error };
  return { ok: true, value: count ?? 0 };
}

const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;

async function sendTelegramNotification(nome: string, canzone: string, artista: string, createdAt: string): Promise<void> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!botToken || !chatId || !TELEGRAM_TOKEN_RE.test(botToken)) return;

  const dt = new Date(createdAt);
  const dateStr = dt.toLocaleDateString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" });
  const timeStr = dt.toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });

  const text =
    `🎤 Nuova prenotazione\n` +
    `👤 ${nome}\n` +
    `🎵 ${canzone} — ${artista}\n` +
    `📅 ${dateStr} alle ${timeStr}`;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // Notifica non critica: ignora errori di rete
  }
}

async function validateRecaptcha(token: string | null | undefined): Promise<{ ok: boolean }> {
  const secretKey = Deno.env.get("RECAPTCHA_SECRET_KEY");
  if (!secretKey) return { ok: true }; // non configurato: skip
  if (!token) return { ok: false };
  try {
    const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
    });
    const result = await resp.json() as { success: boolean; score?: number };
    return { ok: result.success === true && (result.score ?? 0) >= 0.5 };
  } catch {
    return { ok: false };
  }
}

function computePendingExpiryIso(createdAt: string | null): string | null {
  if (!createdAt) return null;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  return new Date(createdAtMs + getPendingExpiryMinutes() * 60 * 1000).toISOString();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(req.headers.get("origin")) });
  }

  if (req.method !== "POST") {
    return jsonResponse(req, 405, {
      success: false,
      data: null,
      error: { code: "method_not_allowed", message: "Metodo non supportato." },
    });
  }

  const authCheck = await validateUserToken(req);
  if (!authCheck.ok) {
    return jsonResponse(req, 401, {
      success: false,
      data: null,
      error: { code: "unauthorized", message: "Autenticazione non valida." },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, 400, {
      success: false,
      data: null,
      error: { code: "invalid_json", message: "Body JSON non valido." },
    });
  }

  const validated = validatePayload(body);
  if (!validated.ok) {
    return jsonResponse(req, 400, {
      success: false,
      data: null,
      error: { code: "invalid_payload", message: validated.message },
    });
  }

  const recaptchaToken = typeof (body as Record<string, unknown>).recaptcha_token === "string"
    ? (body as Record<string, unknown>).recaptcha_token as string
    : null;
  const recaptchaCheck = await validateRecaptcha(recaptchaToken);
  if (!recaptchaCheck.ok) {
    return jsonResponse(req, 403, {
      success: false,
      data: null,
      error: { code: "recaptcha_failed", message: "Verifica di sicurezza fallita. Ricarica la pagina e riprova." },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(req, 500, {
      success: false,
      data: null,
      error: { code: "server_misconfigured", message: "Config server mancante." },
    });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const cleanup = await cleanupExpiredPendingBookings(admin);
  if (!cleanup.ok) {
    return jsonResponse(req, 500, {
      success: false,
      data: null,
      error: { code: "cleanup_failed", message: "Errore durante la pulizia delle prenotazioni scadute." },
    });
  }

  const insertPayload: Record<string, unknown> = {
    nome: validated.data.nome,
    canzone: validated.data.canzone,
    artista: validated.data.artista,
    approvata: false,
    ...(validated.data.email ? { email: validated.data.email } : {}),
    ...(validated.data.selfie_url ? { selfie_url: validated.data.selfie_url } : {}),
  };

  const openSerata = await getOpenSerata(admin);
  if (!openSerata.ok) {
    return jsonResponse(req, 500, {
      success: false,
      data: null,
      error: { code: "query_failed", message: "Errore durante il caricamento della serata." },
    });
  }

  const currentOpenSerata = openSerata.data;
  if (!currentOpenSerata) {
    return jsonResponse(req, 409, {
      success: false,
      data: null,
      error: { code: "bookings_closed", message: "Le prenotazioni sono chiuse: nessuna serata aperta." },
    });
  }
  if (currentOpenSerata.vincitore_decretato) {
    return jsonResponse(req, 409, {
      success: false,
      data: null,
      error: { code: "bookings_closed", message: "Le prenotazioni sono chiuse: vincitore già decretato." },
    });
  }
  if (currentOpenSerata.winner_reveal_countdown_active) {
    return jsonResponse(req, 409, {
      success: false,
      data: null,
      error: { code: "bookings_closed", message: "Le prenotazioni sono chiuse: countdown reveal vincitore in corso." },
    });
  }

  const openSerataId = Number(currentOpenSerata.id);
  if (!Number.isInteger(openSerataId) || openSerataId <= 0) {
    return jsonResponse(req, 500, {
      success: false,
      data: null,
      error: { code: "query_failed", message: "Errore durante il caricamento della serata." },
    });
  }

  if (
    validated.data.serata_id !== null
    && validated.data.serata_id !== undefined
    && validated.data.serata_id !== openSerataId
  ) {
    return jsonResponse(req, 409, {
      success: false,
      data: null,
      error: { code: "invalid_serata_id", message: "La serata selezionata non è più aperta. Aggiorna la pagina e riprova." },
    });
  }

  insertPayload.serata_id = openSerataId;

  const { data, error } = await admin
    .from("prenotazioni")
    .insert(insertPayload)
    .select("id, created_at, serata_id")
    .single();

  if (error) {
    return jsonResponse(req, 500, {
      success: false,
      data: null,
      error: { code: "insert_failed", message: "Errore durante il salvataggio della prenotazione." },
    });
  }

  const insertedSerataId = Number(data.serata_id);
  const serataIdForBookingNumber = Number.isInteger(insertedSerataId) && insertedSerataId > 0
    ? insertedSerataId
    : openSerataId;
  const bookingNumberResult = await computeBookingNumber(admin, serataIdForBookingNumber, Number(data.id));
  if (!bookingNumberResult.ok) {
    return jsonResponse(req, 500, {
      success: false,
      data: null,
      error: { code: "query_failed", message: "Errore durante il calcolo del numero prenotazione." },
    });
  }

  // Notifica Telegram fire-and-forget (non blocca la risposta)
  if (currentOpenSerata.notifiche_telegram_abilitate !== false) {
    sendTelegramNotification(validated.data.nome, validated.data.canzone, validated.data.artista, data.created_at).catch(() => {});
  }

  return jsonResponse(req, 201, {
    success: true,
    data: {
      ...data,
      booking_number: bookingNumberResult.value,
      pending_expires_at: computePendingExpiryIso(data?.created_at ?? null),
    },
    error: null,
  });
});
