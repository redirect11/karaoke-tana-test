import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type ApiEnvelope = {
  success: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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

function jsonResponse(req: Request, status: number, payload: ApiEnvelope): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

function toAction(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isTestEnvironment(): boolean {
  return (Deno.env.get("APP_ENV") ?? "production") === "test";
}

function toPositiveInt(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, "invalid_payload", `${fieldName} deve essere un intero positivo.`);
  }
  return parsed;
}

function normalizeBookingText(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_payload", `${fieldName} deve essere una stringa.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(400, "invalid_payload", `${fieldName} è obbligatorio.`);
  }
  if (trimmed.length > maxLength) {
    throw new ApiError(400, "invalid_payload", `${fieldName} supera la lunghezza massima consentita.`);
  }
  return trimmed;
}

function parseBookingUpdatePayload(body: Record<string, unknown>) {
  const updates: Record<string, string | boolean> = {};
  const hasOwn = (field: string) => Object.prototype.hasOwnProperty.call(body, field);

  if (hasOwn("nome")) {
    updates.nome = normalizeBookingText(body.nome, "nome", 80);
  }
  if (hasOwn("canzone")) {
    updates.canzone = normalizeBookingText(body.canzone, "canzone", 140);
  }
  if (hasOwn("artista")) {
    updates.artista = normalizeBookingText(body.artista, "artista", 140);
  }
  if (hasOwn("selfie_nascosta")) {
    if (typeof body.selfie_nascosta !== "boolean") {
      throw new ApiError(400, "invalid_payload", "selfie_nascosta deve essere true o false.");
    }
    updates.selfie_nascosta = body.selfie_nascosta;
  }

  if (Object.keys(updates).length === 0) {
    throw new ApiError(400, "invalid_payload", "Specifica almeno un campo da aggiornare: nome, canzone, artista o selfie_nascosta.");
  }

  return updates;
}

function normalizeDateOrToday(value: unknown): string {
  if (typeof value !== "string") return new Date().toISOString().slice(0, 10);
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new ApiError(400, "invalid_payload", "La data deve essere nel formato YYYY-MM-DD.");
  }
  return trimmed;
}

function normalizeOptionalDate(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_payload", `${fieldName} deve essere una data YYYY-MM-DD o null.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new ApiError(400, "invalid_payload", `${fieldName} deve essere nel formato YYYY-MM-DD.`);
  }
  return trimmed;
}

const DEFAULT_WINNER_REVEAL_COUNTDOWN_SECONDS = 5;
const DEFAULT_WINNER_REVEAL_AUTO_STEP_SECONDS = 3;
const MIN_WINNER_REVEAL_AUTO_STEP_SECONDS = 1;
const MAX_WINNER_REVEAL_AUTO_STEP_SECONDS = 30;
const WINNER_REVEAL_MODE_AUTOMATIC = "automatic";
const WINNER_REVEAL_MODE_MANUAL = "manual";
const TEST_AWARDS_SAMPLE_BOOKINGS: Array<{
  nome: string;
  canzone: string;
  artista: string;
  voti: number[];
}> = [
  { nome: "Alice", canzone: "La solitudine", artista: "Laura Pausini", voti: [5, 5, 5, 5, 4, 5] },
  { nome: "Marco", canzone: "Vita spericolata", artista: "Vasco Rossi", voti: [5, 5, 4, 5, 4, 4] },
  { nome: "Giulia", canzone: "A far l'amore comincia tu", artista: "Raffaella Carrà", voti: [4, 4, 5, 4, 4, 4] },
  { nome: "Luca", canzone: "Salirò", artista: "Daniele Silvestri", voti: [4, 4, 4, 4, 3, 4] },
  { nome: "Sara", canzone: "50 Special", artista: "Lùnapop", voti: [4, 3, 4, 4, 3, 3] },
  { nome: "Davide", canzone: "Marmellata #25", artista: "Cesare Cremonini", voti: [3, 3, 4, 3, 3, 3] },
];

function parseCountdownSeconds(value: unknown): number {
  if (value === null || value === undefined || value === "") return DEFAULT_WINNER_REVEAL_COUNTDOWN_SECONDS;
  const parsed = toPositiveInt(value, "countdownSeconds");
  if (parsed < 5 || parsed > 300) {
    throw new ApiError(400, "invalid_payload", "countdownSeconds deve essere compreso tra 5 e 300 secondi.");
  }
  return parsed;
}

function parseRevealAutoStepSeconds(value: unknown): number {
  if (value === null || value === undefined || value === "") return DEFAULT_WINNER_REVEAL_AUTO_STEP_SECONDS;
  const parsed = toPositiveInt(value, "winnerRevealAutoStepSeconds");
  if (parsed < MIN_WINNER_REVEAL_AUTO_STEP_SECONDS || parsed > MAX_WINNER_REVEAL_AUTO_STEP_SECONDS) {
    throw new ApiError(
      400,
      "invalid_payload",
      `winnerRevealAutoStepSeconds deve essere compreso tra ${MIN_WINNER_REVEAL_AUTO_STEP_SECONDS} e ${MAX_WINNER_REVEAL_AUTO_STEP_SECONDS} secondi.`,
    );
  }
  return parsed;
}

function normalizeWinnerRevealMode(value: unknown): "manual" | "automatic" {
  return value === WINNER_REVEAL_MODE_MANUAL ? WINNER_REVEAL_MODE_MANUAL : WINNER_REVEAL_MODE_AUTOMATIC;
}

function clearRevealProgressState() {
  return {
    winner_reveal_current_rank: null,
    winner_reveal_total_ranks: null,
    winner_reveal_step_started_at: null,
  };
}

function buildAwardsTestSerataPayload(date: string) {
  return {
    data: date,
    aperta: true,
    voto_aperto: false,
    mostra_voti_totali: false,
    vincitore_decretato: false,
    vincitore_prenotazione_id: null,
    winner_reveal_countdown_active: true,
    winner_reveal_countdown_started_at: null,
    winner_reveal_countdown_ends_at: null,
    winner_reveal_countdown_seconds: null,
    prenotazioni_abilitate: false,
    ...clearRevealProgressState(),
  };
}

function buildAwardsTestBookings(serataId: number, date: string) {
  const baseTime = new Date(`${date}T20:30:00.000Z`).getTime();
  return TEST_AWARDS_SAMPLE_BOOKINGS.map((booking, index) => ({
    nome: booking.nome,
    canzone: booking.canzone,
    artista: booking.artista,
    serata_id: serataId,
    approvata: true,
    cantata: true,
    in_preparazione: false,
    created_at: new Date(baseTime + (index * 60_000)).toISOString(),
  }));
}

function buildAwardsTestVotes(
  bookings: Array<{ id: number }>,
  date: string,
) {
  const baseTime = new Date(`${date}T20:45:00.000Z`).getTime();
  return bookings.flatMap((booking, bookingIndex) =>
    TEST_AWARDS_SAMPLE_BOOKINGS[bookingIndex].voti.map((vote, voteIndex) => ({
      prenotazione_id: booking.id,
      voto: vote,
      created_at: new Date(baseTime + (bookingIndex * 60_000) + (voteIndex * 1_000)).toISOString(),
    }))
  );
}

// ─── Dati test archivio ─────────────────────────────────────────────────────
const ARCHIVE_TEST_NIGHTS: Array<{
  daysAgo: number;
  songs: Array<{ nome: string; canzone: string; artista: string; voti: number[] }>;
}> = [
  {
    daysAgo: 7,
    songs: [
      { nome: "Sofia",     canzone: "La notte",                    artista: "Arisa",             voti: [5,5,5,5,5] },
      { nome: "Roberto",   canzone: "Azzurro",                     artista: "Adriano Celentano", voti: [5,5,4,5,4] },
      { nome: "Chiara",    canzone: "Almeno tu nell'universo",     artista: "Mia Martini",       voti: [4,5,4,4,5] },
      { nome: "Antonio",   canzone: "Come saprei",                 artista: "Giorgia",           voti: [4,4,4,4,4] },
      { nome: "Valentina", canzone: "Ogni volta",                  artista: "Laura Pausini",     voti: [3,4,4,3,4] },
    ],
  },
  {
    daysAgo: 14,
    songs: [
      { nome: "Francesco", canzone: "Hey Jude",          artista: "The Beatles",  voti: [5,5,5,5,5,4] },
      { nome: "Maria",     canzone: "Bohemian Rhapsody", artista: "Queen",        voti: [5,5,4,4,5,5] },
      { nome: "Giovanni",  canzone: "Hotel California",  artista: "Eagles",       voti: [4,4,5,4,4,4] },
      { nome: "Elena",     canzone: "Shallow",           artista: "Lady Gaga",    voti: [4,4,4,4,3,4] },
      { nome: "Paolo",     canzone: "Africa",            artista: "Toto",         voti: [3,4,3,3,4,3] },
      { nome: "Irene",     canzone: "Summertime",        artista: "Janis Joplin", voti: [3,3,4,3,3,3] },
    ],
  },
  {
    daysAgo: 21,
    songs: [
      { nome: "Carla",    canzone: "Tutta colpa mia",      artista: "Elisa",          voti: [5,5,5,4,5,5] },
      { nome: "Stefano",  canzone: "Generale",             artista: "Francesco De Gregori", voti: [5,4,5,5,4,5] },
      { nome: "Roberta",  canzone: "Volare",               artista: "Domenico Modugno",     voti: [5,4,5,4,4,4] },
      { nome: "Michele",  canzone: "Con te partirò",       artista: "Andrea Bocelli",       voti: [4,4,4,4,4,5] },
      { nome: "Laura",    canzone: "Ancora ancora ancora", artista: "Mina",                 voti: [4,4,4,3,5,4] },
      { nome: "Daniele",  canzone: "L'italiano",           artista: "Toto Cutugno",         voti: [3,4,3,4,4,3] },
      { nome: "Anna",     canzone: "Cuore matto",          artista: "Little Tony",          voti: [3,3,4,3,3,4] },
    ],
  },
  {
    daysAgo: 28,
    songs: [
      { nome: "Luca B.",   canzone: "Purple Rain",           artista: "Prince",      voti: [5,5,5,5,5,5] },
      { nome: "Marta",     canzone: "Nothing Compares 2 U",  artista: "Sinéad O'Connor", voti: [5,5,5,4,5,4] },
      { nome: "Giorgio",   canzone: "Don't Stop Me Now",     artista: "Queen",       voti: [4,5,4,5,4,4] },
      { nome: "Cristina",  canzone: "Sweet Child O' Mine",   artista: "Guns N' Roses", voti: [4,4,4,4,4,4] },
      { nome: "Simone",    canzone: "With or Without You",   artista: "U2",          voti: [4,3,4,4,3,4] },
    ],
  },
  {
    daysAgo: 35,
    songs: [
      { nome: "Beatrice",  canzone: "Nessun dorma",       artista: "Giacomo Puccini",   voti: [5,5,5,5,5,5,5] },
      { nome: "Fabrizio",  canzone: "Il pescatore",       artista: "Fabrizio De André", voti: [5,5,5,5,5,4,4] },
      { nome: "Miriam",    canzone: "Perdere l'amore",    artista: "Massimo Ranieri",   voti: [4,5,4,5,4,5,4] },
      { nome: "Riccardo",  canzone: "Luglio",             artista: "Riccardo Cocciante",voti: [4,4,5,4,4,4,4] },
      { nome: "Silvia",    canzone: "Il cielo in una stanza", artista: "Gino Paoli",   voti: [4,4,4,4,4,4,3] },
    ],
  },
];

function buildArchiveTestDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
// ─────────────────────────────────────────────────────────────────────────────

const POST_APPROVAL_MODE_DIRECT_LIVE = "direct_live";
const POST_APPROVAL_MODE_PREPARATION_THEN_LIVE = "preparation_then_live";

type PostApprovalMode =
  | typeof POST_APPROVAL_MODE_DIRECT_LIVE
  | typeof POST_APPROVAL_MODE_PREPARATION_THEN_LIVE;

function normalizePostApprovalMode(value: unknown): PostApprovalMode {
  if (value === POST_APPROVAL_MODE_PREPARATION_THEN_LIVE) {
    return POST_APPROVAL_MODE_PREPARATION_THEN_LIVE;
  }
  if (value === POST_APPROVAL_MODE_DIRECT_LIVE || value == null || value === "") {
    return POST_APPROVAL_MODE_DIRECT_LIVE;
  }
  throw new ApiError(
    400,
    "invalid_payload",
    "modalitaPostApprovazione deve essere 'direct_live' oppure 'preparation_then_live'.",
  );
}

function isPreparationModeEnabled(mode: unknown): boolean {
  return normalizePostApprovalMode(mode) === POST_APPROVAL_MODE_PREPARATION_THEN_LIVE;
}

function toIsoDateFromTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function getArchiveDate(serata: Record<string, unknown>): string | null {
  const fromCreatedAt = toIsoDateFromTimestamp(serata.created_at);
  if (fromCreatedAt) return fromCreatedAt;
  const fromData = typeof serata.data === "string" ? serata.data : null;
  if (fromData && /^\d{4}-\d{2}-\d{2}$/.test(fromData)) return fromData;
  return null;
}

function createAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new ApiError(500, "server_misconfigured", "Config server mancante.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function ensureAdminAuth(req: Request): Promise<void> {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new ApiError(401, "unauthorized", "Credenziali admin non valide.");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new ApiError(401, "unauthorized", "Credenziali admin non valide.");
  }

  const client = createAdminClient();

  // Verify the Supabase Auth JWT and retrieve the authenticated user.
  const { data: { user }, error: authError } = await client.auth.getUser(token);
  if (authError || !user) {
    throw new ApiError(401, "unauthorized", "Credenziali admin non valide.");
  }

  // Check the user is in the admin allowlist.
  const { data: adminRow, error: adminError } = await client
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminError) {
    throw new ApiError(500, "server_error", "Errore durante la verifica admin.");
  }

  if (!adminRow) {
    throw new ApiError(403, "forbidden", "Accesso riservato agli amministratori.");
  }
}

async function getRevealSettingsSnapshot(admin: ReturnType<typeof createClient>) {
  try {
    const { data } = await admin
      .from("impostazioni_pubbliche")
      .select("winner_reveal_animation_enabled, winner_reveal_animation_mode, winner_reveal_auto_step_seconds")
      .eq("id", 1)
      .maybeSingle();
    return {
      reveal_animation_enabled: data?.winner_reveal_animation_enabled !== false,
      reveal_animation_mode: data?.winner_reveal_animation_mode === "manual" ? "manual" : "automatic",
      reveal_auto_step_seconds: Number(data?.winner_reveal_auto_step_seconds) || DEFAULT_WINNER_REVEAL_AUTO_STEP_SECONDS,
    };
  } catch (_) {
    return {
      reveal_animation_enabled: true,
      reveal_animation_mode: "automatic" as const,
      reveal_auto_step_seconds: DEFAULT_WINNER_REVEAL_AUTO_STEP_SECONDS,
    };
  }
}

async function getOpenSerata(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin
    .from("serate")
    .select("*")
    .eq("aperta", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "query_failed", "Errore durante il caricamento della serata.");
  }

  return data;
}

async function getSerataById(admin: ReturnType<typeof createClient>, serataId: number) {
  const { data, error } = await admin
    .from("serate")
    .select("*")
    .eq("id", serataId)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "query_failed", "Errore durante il caricamento della serata.");
  }

  return data;
}

function computeScoreMap(votes: Array<{ prenotazione_id: number; voto: number }>) {
  const byBooking = new Map<number, { total: number; count: number }>();
  for (const vote of votes) {
    const bookingId = Number(vote.prenotazione_id);
    if (!Number.isInteger(bookingId) || bookingId <= 0) continue;
    const value = Number(vote.voto);
    if (!Number.isFinite(value)) continue;
    const current = byBooking.get(bookingId) ?? { total: 0, count: 0 };
    current.total += value;
    current.count += 1;
    byBooking.set(bookingId, current);
  }
  return byBooking;
}

function buildRanking(bookings: Array<Record<string, unknown>>, scoreMap: Map<number, { total: number; count: number }>) {
  return bookings
    .map((booking) => {
      const bookingId = Number(booking.id);
      const score = scoreMap.get(bookingId) ?? { total: 0, count: 0 };
      const scoreAverage = score.count > 0 ? score.total / score.count : 0;
      return {
        ...booking,
        score_total: score.total,
        score_count: score.count,
        score_average_raw: scoreAverage,
        score_average: Number(scoreAverage.toFixed(2)),
      };
    })
    .sort((a, b) => {
      if (b.score_total !== a.score_total) return b.score_total - a.score_total;
      if (b.score_average_raw !== a.score_average_raw) return b.score_average_raw - a.score_average_raw;
      if (b.score_count !== a.score_count) return b.score_count - a.score_count;
      return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    })
    .map((booking) => {
      const { score_average_raw: _scoreAverageRaw, ...publicBooking } = booking;
      return publicBooking;
    });
}

async function getBookingScores(
  admin: ReturnType<typeof createClient>,
  bookings: Array<Record<string, unknown>>,
) {
  const bookingIds = bookings
    .map((booking) => Number(booking.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (bookingIds.length === 0) {
    return new Map<number, { total: number; count: number }>();
  }

  const { data, error } = await admin
    .from("voti")
    .select("prenotazione_id, voto")
    .in("prenotazione_id", bookingIds);

  if (error) {
    throw new ApiError(500, "query_failed", "Errore durante il caricamento dei voti.");
  }

  return computeScoreMap((data ?? []) as Array<{ prenotazione_id: number; voto: number }>);
}

async function ensureSerataAllowsMutations(
  admin: ReturnType<typeof createClient>,
  serataId: number,
) {
  const serata = await getSerataById(admin, serataId);
  if (!serata) {
    throw new ApiError(404, "not_found", "Serata non trovata.");
  }
  if (serata.vincitore_decretato) {
    throw new ApiError(409, "winner_already_decreed", "Vincitore già decretato: puoi solo chiudere il karaoke.");
  }
  return serata;
}

async function getState(admin: ReturnType<typeof createClient>) {
  const serata = await getOpenSerata(admin);
  const settings = await getPublicSettings(admin);

  if (!serata) {
    return { serata: null, bookings: [], top5: [], settings };
  }

  const { data, error } = await admin
    .from("prenotazioni")
    .select("*")
    .eq("serata_id", serata.id)
    .order("created_at", { ascending: true });

  if (error) {
    throw new ApiError(500, "query_failed", "Errore durante il caricamento delle prenotazioni.");
  }

  const bookings = (data ?? []) as Array<Record<string, unknown>>;
  const scoreMap = await getBookingScores(admin, bookings);
  const bookingsWithScores = bookings.map((booking) => {
    const bookingId = Number(booking.id);
    const score = scoreMap.get(bookingId) ?? { total: 0, count: 0 };
    const scoreAverage = score.count > 0 ? score.total / score.count : 0;
    return {
      ...booking,
      score_total: score.total,
      score_count: score.count,
      score_average: Number(scoreAverage.toFixed(2)),
    };
  });
  const approved = bookingsWithScores.filter((booking) => Boolean(booking.approvata));
  const top5 = buildRanking(approved, scoreMap).slice(0, 5);

  return { serata, bookings: bookingsWithScores, top5, settings };
}

async function getCurrentActiveBooking(admin: ReturnType<typeof createClient>, serataId: number) {
  const { data, error } = await admin
    .from("prenotazioni")
    .select("id, in_preparazione")
    .eq("serata_id", serataId)
    .eq("approvata", true)
    .eq("cantata", false)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "query_failed", "Errore durante il caricamento della canzone corrente.");
  }

  return data;
}

async function clearPreparationFlags(admin: ReturnType<typeof createClient>, serataId: number) {
  const { error } = await admin
    .from("prenotazioni")
    .update({ in_preparazione: false })
    .eq("serata_id", serataId)
    .eq("in_preparazione", true);

  if (error) {
    throw new ApiError(500, "update_failed", "Non sono riuscito ad aggiornare lo stato di preparazione.");
  }
}

async function setPreparingBooking(
  admin: ReturnType<typeof createClient>,
  serataId: number,
  bookingId: number | null,
) {
  await clearPreparationFlags(admin, serataId);
  if (!bookingId) return;

  const { error } = await admin
    .from("prenotazioni")
    .update({ in_preparazione: true })
    .eq("id", bookingId)
    .eq("serata_id", serataId)
    .eq("approvata", true)
    .eq("cantata", false);

  if (error) {
    throw new ApiError(500, "update_failed", "Non sono riuscito ad attivare lo stato di preparazione.");
  }
}

async function getPublicSettings(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin
    .from("impostazioni_pubbliche")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "query_failed", "Errore durante il caricamento delle impostazioni pubbliche.");
  }

  if (data) {
    return data;
  }

  const { data: inserted, error: insertError } = await admin
    .from("impostazioni_pubbliche")
    .insert({
      id: 1,
      archivio_pubblico_abilitato: false,
      manutenzione_abilitata: false,
      modalita_post_approvazione: POST_APPROVAL_MODE_DIRECT_LIVE,
      home_subtitle_text: "Il karaoke, la votazione e la coda in un unico posto.",
        home_subtitle_enabled: true,
      home_follow_title: "Prima di tutto…",
      home_follow_message: "Segui la nostra pagina Instagram per poter prenotare una canzone.",
      home_form_title: "Prenota la tua canzone 🎤",
      home_form_message: "Compila il form e lo staff la aggiungerà alla lista appena possibile.",
      home_success_title: "Richiesta inviata!",
      home_success_message: "Lo staff la controllerà e apparirà in lista appena viene approvata.",
      home_waiting_title: "Stato della tua prenotazione",
      home_waiting_message: "Sto controllando lo stato della tua prenotazione…",
      home_bookings_disabled_title: "Prenotazioni non disponibili",
      home_bookings_disabled_message: "Le prenotazioni sono al momento chiuse.",
      home_closed_title: "Prenotazioni chiuse",
      home_closed_message: "Al momento non è attiva nessuna serata karaoke.\nTorna più tardi!",
      home_maintenance_title: "🚧 In manutenzione",
      home_maintenance_message: "Sito in manutenzione. Torneremo presto.\nIntanto segui la nostra pagina per scoprire le ultime novità e le prossime date del karaoke",
      prossima_serata_data: null,
      winner_reveal_countdown_default_seconds: DEFAULT_WINNER_REVEAL_COUNTDOWN_SECONDS,
      winner_reveal_animation_enabled: true,
      winner_reveal_animation_mode: WINNER_REVEAL_MODE_AUTOMATIC,
      winner_reveal_auto_step_seconds: DEFAULT_WINNER_REVEAL_AUTO_STEP_SECONDS,
    })
    .select("*")
    .maybeSingle();

  if (insertError || !inserted) {
    throw new ApiError(500, "insert_failed", "Non sono riuscito a inizializzare le impostazioni pubbliche.");
  }

  return inserted;
}

async function updatePublicSettings(
  admin: ReturnType<typeof createClient>,
  updates: {
    archivio_pubblico_abilitato?: boolean;
    manutenzione_abilitata?: boolean;
    modalita_post_approvazione?: PostApprovalMode;
    home_subtitle_enabled?: boolean;
    home_subtitle_text?: string;
    home_follow_title?: string;
    home_follow_message?: string;
    home_form_title?: string;
    home_form_message?: string;
    home_success_title?: string;
    home_success_message?: string;
    home_waiting_title?: string;
    home_waiting_message?: string;
    home_bookings_disabled_title?: string;
    home_bookings_disabled_message?: string;
    home_closed_title?: string;
    home_closed_message?: string;
    home_maintenance_title?: string;
    home_maintenance_message?: string;
    prossima_serata_data?: string | null;
    winner_reveal_countdown_default_seconds?: number;
    winner_reveal_animation_enabled?: boolean;
    winner_reveal_animation_mode?: "manual" | "automatic";
    winner_reveal_auto_step_seconds?: number;
    gadget_estrazione_abilitata?: boolean;
  },
) {
  await getPublicSettings(admin);

  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof updates.archivio_pubblico_abilitato === "boolean") {
    payload.archivio_pubblico_abilitato = updates.archivio_pubblico_abilitato;
  }
  if (typeof updates.manutenzione_abilitata === "boolean") {
    payload.manutenzione_abilitata = updates.manutenzione_abilitata;
  }
  if (typeof updates.modalita_post_approvazione === "string") {
    payload.modalita_post_approvazione = normalizePostApprovalMode(updates.modalita_post_approvazione);
  }
  if (typeof updates.home_subtitle_enabled === "boolean") payload.home_subtitle_enabled = updates.home_subtitle_enabled;
  if (typeof updates.home_subtitle_text === "string") payload.home_subtitle_text = updates.home_subtitle_text.trim();
  if (typeof updates.home_follow_title === "string") payload.home_follow_title = updates.home_follow_title.trim();
  if (typeof updates.home_follow_message === "string") payload.home_follow_message = updates.home_follow_message.trim();
  if (typeof updates.home_form_title === "string") payload.home_form_title = updates.home_form_title.trim();
  if (typeof updates.home_form_message === "string") payload.home_form_message = updates.home_form_message.trim();
  if (typeof updates.home_success_title === "string") payload.home_success_title = updates.home_success_title.trim();
  if (typeof updates.home_success_message === "string") payload.home_success_message = updates.home_success_message.trim();
  if (typeof updates.home_waiting_title === "string") payload.home_waiting_title = updates.home_waiting_title.trim();
  if (typeof updates.home_waiting_message === "string") payload.home_waiting_message = updates.home_waiting_message.trim();
  if (typeof updates.home_bookings_disabled_title === "string") payload.home_bookings_disabled_title = updates.home_bookings_disabled_title.trim();
  if (typeof updates.home_bookings_disabled_message === "string") payload.home_bookings_disabled_message = updates.home_bookings_disabled_message.trim();
  if (typeof updates.home_closed_title === "string") payload.home_closed_title = updates.home_closed_title.trim();
  if (typeof updates.home_closed_message === "string") payload.home_closed_message = updates.home_closed_message.trim();
  if (typeof updates.home_maintenance_title === "string") payload.home_maintenance_title = updates.home_maintenance_title.trim();
  if (typeof updates.home_maintenance_message === "string") payload.home_maintenance_message = updates.home_maintenance_message.trim();
  if (Object.prototype.hasOwnProperty.call(updates, "prossima_serata_data")) {
    payload.prossima_serata_data = updates.prossima_serata_data ?? null;
  }
  if (Number.isInteger(updates.winner_reveal_countdown_default_seconds)) {
    payload.winner_reveal_countdown_default_seconds = updates.winner_reveal_countdown_default_seconds;
  }
  if (typeof updates.winner_reveal_animation_enabled === "boolean") {
    payload.winner_reveal_animation_enabled = updates.winner_reveal_animation_enabled;
  }
  if (typeof updates.winner_reveal_animation_mode === "string") {
    payload.winner_reveal_animation_mode = normalizeWinnerRevealMode(updates.winner_reveal_animation_mode);
  }
  if (Number.isInteger(updates.winner_reveal_auto_step_seconds)) {
    payload.winner_reveal_auto_step_seconds = updates.winner_reveal_auto_step_seconds;
  }
  if (typeof updates.gadget_estrazione_abilitata === "boolean") {
    payload.gadget_estrazione_abilitata = updates.gadget_estrazione_abilitata;
  }
  const { data, error } = await admin
    .from("impostazioni_pubbliche")
    .update(payload)
    .eq("id", 1)
    .select("*")
    .maybeSingle();

  if (error || !data) {
    throw new ApiError(500, "update_failed", "Non sono riuscito ad aggiornare le impostazioni pubbliche.");
  }

  return data;
}

async function getArchive(admin: ReturnType<typeof createClient>, serataId?: number) {
  const { data: editions, error: editionsError } = await admin
    .from("serate")
    .select("id, data, created_at, voto_aperto, vincitore_decretato, vincitore_prenotazione_id, archiviato_nascosto, cover_prenotazione_id")
    .eq("aperta", false)
    .order("data", { ascending: false })
    .order("created_at", { ascending: false });

  if (editionsError) {
    throw new ApiError(500, "query_failed", "Errore durante il caricamento dell'archivio.");
  }

  const normalizedEditions = (editions ?? []).map((edition) => ({
    ...edition,
    archive_date: getArchiveDate(edition as Record<string, unknown>),
  }));

  const selectedSerataId = serataId ?? Number(normalizedEditions[0]?.id ?? 0);
  if (!Number.isInteger(selectedSerataId) || selectedSerataId <= 0) {
    return { editions: normalizedEditions, detail: null };
  }

  const detailSerata = await getSerataById(admin, selectedSerataId);
  if (!detailSerata || detailSerata.aperta) {
    throw new ApiError(404, "not_found", "Edizione archivio non trovata.");
  }

  const { data: serataBookings, error: bookingsError } = await admin
    .from("prenotazioni")
    .select("*")
    .eq("serata_id", selectedSerataId)
    .order("created_at", { ascending: true });

  if (bookingsError) {
    throw new ApiError(500, "query_failed", "Errore durante il caricamento delle prenotazioni archivio.");
  }

  const allBookings = (serataBookings ?? []) as Array<Record<string, unknown>>;
  const songsList: Array<Record<string, unknown>> = [];
  const approvedForRanking: Array<Record<string, unknown>> = [];
  const scoredBookings: Array<Record<string, unknown>> = [];
  for (const booking of allBookings) {
    const isPerformed = Boolean(booking.cantata);
    const isApproved = Boolean(booking.approvata);
    if (isPerformed) songsList.push(booking);
    if (isApproved) approvedForRanking.push(booking);
    if (isPerformed || isApproved) scoredBookings.push(booking);
  }
  const scoreMap = await getBookingScores(admin, scoredBookings);
  const songsWithScores = songsList.map((song) => {
    const bookingId = Number(song.id);
    const score = scoreMap.get(bookingId) ?? { total: 0, count: 0 };
    const scoreAverage = score.count > 0 ? score.total / score.count : 0;
    return {
      ...song,
      score_total: score.total,
      score_count: score.count,
      score_average: Number(scoreAverage.toFixed(2)),
    };
  });

  const ranked = buildRanking(approvedForRanking, scoreMap);
  const top5 = ranked.filter((song) => Number(song.score_count) > 0).slice(0, 5);
  const detail = {
    serata: {
      ...detailSerata,
      archive_date: getArchiveDate(detailSerata as Record<string, unknown>),
    },
    songs: songsWithScores,
    top5,
    hasVoting: top5.length > 0,
  };

  return { editions: normalizedEditions, detail };
}

async function setGadgetRevealPayload(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown> | null,
) {
  const { error } = await admin
    .from("impostazioni_pubbliche")
    .update({ gadget_reveal_payload: payload, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new ApiError(500, "update_failed", "Impossibile aggiornare il payload reveal.");
}

async function executeAction(admin: ReturnType<typeof createClient>, action: string, body: Record<string, unknown>) {
  switch (action) {
    case "ping": {
      return { status: 200, data: { ok: true } };
    }

    case "get_state":
    case "state": {
      return { status: 200, data: await getState(admin) };
    }

    case "get_public_settings": {
      return { status: 200, data: await getPublicSettings(admin) };
    }

    case "set_public_settings": {
      const updates: {
        archivio_pubblico_abilitato?: boolean;
        manutenzione_abilitata?: boolean;
        modalita_post_approvazione?: PostApprovalMode;
        home_subtitle_enabled?: boolean;
        home_subtitle_text?: string;
        home_follow_title?: string;
        home_follow_message?: string;
        home_form_title?: string;
        home_form_message?: string;
        home_success_title?: string;
        home_success_message?: string;
        home_waiting_title?: string;
        home_waiting_message?: string;
        home_bookings_disabled_title?: string;
        home_bookings_disabled_message?: string;
        home_closed_title?: string;
        home_closed_message?: string;
        home_maintenance_title?: string;
        home_maintenance_message?: string;
        prossima_serata_data?: string | null;
        winner_reveal_countdown_default_seconds?: number;
        winner_reveal_animation_enabled?: boolean;
        winner_reveal_animation_mode?: "manual" | "automatic";
        winner_reveal_auto_step_seconds?: number;
        gadget_estrazione_abilitata?: boolean;
      } = {};
      if (typeof body.archivioPubblicoAbilitato === "boolean") {
        updates.archivio_pubblico_abilitato = body.archivioPubblicoAbilitato;
      }
      if (typeof body.manutenzioneAbilitata === "boolean") {
        updates.manutenzione_abilitata = body.manutenzioneAbilitata;
      }
      if (Object.prototype.hasOwnProperty.call(body, "modalitaPostApprovazione")) {
        updates.modalita_post_approvazione = normalizePostApprovalMode(body.modalitaPostApprovazione);
      }
      if (typeof body.homeSubtitleEnabled === "boolean") {
        updates.home_subtitle_enabled = body.homeSubtitleEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeSubtitleText")) {
        updates.home_subtitle_text = typeof body.homeSubtitleText === "string" ? body.homeSubtitleText : String(body.homeSubtitleText ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeFollowTitle")) {
        updates.home_follow_title = typeof body.homeFollowTitle === "string" ? body.homeFollowTitle : String(body.homeFollowTitle ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeFollowMessage")) {
        updates.home_follow_message = typeof body.homeFollowMessage === "string" ? body.homeFollowMessage : String(body.homeFollowMessage ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeFormTitle")) {
        updates.home_form_title = typeof body.homeFormTitle === "string" ? body.homeFormTitle : String(body.homeFormTitle ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeFormMessage")) {
        updates.home_form_message = typeof body.homeFormMessage === "string" ? body.homeFormMessage : String(body.homeFormMessage ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeSuccessTitle")) {
        updates.home_success_title = typeof body.homeSuccessTitle === "string" ? body.homeSuccessTitle : String(body.homeSuccessTitle ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeSuccessMessage")) {
        updates.home_success_message = typeof body.homeSuccessMessage === "string" ? body.homeSuccessMessage : String(body.homeSuccessMessage ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeWaitingTitle")) {
        updates.home_waiting_title = typeof body.homeWaitingTitle === "string" ? body.homeWaitingTitle : String(body.homeWaitingTitle ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeWaitingMessage")) {
        updates.home_waiting_message = typeof body.homeWaitingMessage === "string" ? body.homeWaitingMessage : String(body.homeWaitingMessage ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeBookingsDisabledTitle")) {
        updates.home_bookings_disabled_title = typeof body.homeBookingsDisabledTitle === "string" ? body.homeBookingsDisabledTitle : String(body.homeBookingsDisabledTitle ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeBookingsDisabledMessage")) {
        updates.home_bookings_disabled_message = typeof body.homeBookingsDisabledMessage === "string" ? body.homeBookingsDisabledMessage : String(body.homeBookingsDisabledMessage ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeClosedTitle")) {
        updates.home_closed_title = typeof body.homeClosedTitle === "string" ? body.homeClosedTitle : String(body.homeClosedTitle ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeClosedMessage")) {
        updates.home_closed_message = typeof body.homeClosedMessage === "string" ? body.homeClosedMessage : String(body.homeClosedMessage ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeMaintenanceTitle")) {
        updates.home_maintenance_title = typeof body.homeMaintenanceTitle === "string" ? body.homeMaintenanceTitle : String(body.homeMaintenanceTitle ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "homeMaintenanceMessage")) {
        updates.home_maintenance_message = typeof body.homeMaintenanceMessage === "string" ? body.homeMaintenanceMessage : String(body.homeMaintenanceMessage ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "prossimaSerataData")) {
        updates.prossima_serata_data = normalizeOptionalDate(body.prossimaSerataData, "prossimaSerataData");
      }
      if (Object.prototype.hasOwnProperty.call(body, "winnerRevealCountdownDefaultSeconds")) {
        updates.winner_reveal_countdown_default_seconds = parseCountdownSeconds(body.winnerRevealCountdownDefaultSeconds);
      }
      if (typeof body.winnerRevealAnimationEnabled === "boolean") {
        updates.winner_reveal_animation_enabled = body.winnerRevealAnimationEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, "winnerRevealAnimationMode")) {
        updates.winner_reveal_animation_mode = normalizeWinnerRevealMode(body.winnerRevealAnimationMode);
      }
      if (Object.prototype.hasOwnProperty.call(body, "winnerRevealAutoStepSeconds")) {
        updates.winner_reveal_auto_step_seconds = parseRevealAutoStepSeconds(body.winnerRevealAutoStepSeconds);
      }
      if (typeof body.gadgetEstrazioneAbilitata === "boolean") {
        updates.gadget_estrazione_abilitata = body.gadgetEstrazioneAbilitata;
      }
      if (
        typeof updates.archivio_pubblico_abilitato !== "boolean"
        && typeof updates.manutenzione_abilitata !== "boolean"
        && typeof updates.modalita_post_approvazione !== "string"
        && typeof updates.home_subtitle_enabled !== "boolean"
        && typeof updates.home_subtitle_text !== "string"
        && typeof updates.home_follow_title !== "string"
        && typeof updates.home_follow_message !== "string"
        && typeof updates.home_form_title !== "string"
        && typeof updates.home_form_message !== "string"
        && typeof updates.home_success_title !== "string"
        && typeof updates.home_success_message !== "string"
        && typeof updates.home_waiting_title !== "string"
        && typeof updates.home_waiting_message !== "string"
        && typeof updates.home_bookings_disabled_title !== "string"
        && typeof updates.home_bookings_disabled_message !== "string"
        && typeof updates.home_closed_title !== "string"
        && typeof updates.home_closed_message !== "string"
        && typeof updates.home_maintenance_title !== "string"
        && typeof updates.home_maintenance_message !== "string"
        && !Object.prototype.hasOwnProperty.call(updates, "prossima_serata_data")
        && !Number.isInteger(updates.winner_reveal_countdown_default_seconds)
        && typeof updates.winner_reveal_animation_enabled !== "boolean"
        && typeof updates.winner_reveal_animation_mode !== "string"
        && !Number.isInteger(updates.winner_reveal_auto_step_seconds)
        && typeof updates.gadget_estrazione_abilitata !== "boolean"
      ) {
        throw new ApiError(
          400,
          "invalid_payload",
          "Specifica almeno archivioPubblicoAbilitato, modalitaPostApprovazione, homeSubtitleEnabled, homeSubtitleText, homeFollowTitle, homeFollowMessage, homeFormTitle, homeFormMessage, homeSuccessTitle, homeSuccessMessage, homeWaitingTitle, homeWaitingMessage, homeBookingsDisabledTitle, homeBookingsDisabledMessage, homeClosedTitle, homeClosedMessage, homeMaintenanceTitle, homeMaintenanceMessage, prossimaSerataData, winnerRevealCountdownDefaultSeconds, winnerRevealAnimationEnabled, winnerRevealAnimationMode, gadgetEstrazioneAbilitata o winnerRevealAutoStepSeconds.",
        );
      }
      const updatedSettings = await updatePublicSettings(admin, updates);
      if (updates.modalita_post_approvazione === POST_APPROVAL_MODE_DIRECT_LIVE) {
        const openSerata = await getOpenSerata(admin);
        const openSerataId = Number(openSerata?.id);
        if (Number.isInteger(openSerataId) && openSerataId > 0) {
          await clearPreparationFlags(admin, openSerataId);
        }
      }
      return { status: 200, data: updatedSettings };
    }

    case "get_archive": {
      const serataId = body.serataId != null
        ? toPositiveInt(body.serataId, "serataId")
        : undefined;
      return { status: 200, data: await getArchive(admin, serataId) };
    }

    case "set_archive_visibility": {
      const serataId = toPositiveInt(body.serataId, "serataId");
      if (typeof body.hidden !== "boolean") {
        throw new ApiError(400, "invalid_payload", "Il campo `hidden` deve essere booleano.");
      }
      const { data, error } = await admin
        .from("serate")
        .update({ archiviato_nascosto: body.hidden })
        .eq("id", serataId)
        .eq("aperta", false)
        .select("id, archiviato_nascosto, cover_prenotazione_id")
        .single();
      if (error) {
        throw new ApiError(500, "query_failed", "Errore durante l'aggiornamento della visibilità.");
      }
      return { status: 200, data };
    }

    case "set_archive_cover": {
      const serataId = toPositiveInt(body.serataId, "serataId");
      const useDefaultCover = body.useDefaultCover === true;
      let prenotazioneId: number | null = null;
      if (!useDefaultCover && body.prenotazioneId !== null && body.prenotazioneId !== undefined && body.prenotazioneId !== "") {
        prenotazioneId = toPositiveInt(body.prenotazioneId, "prenotazioneId");
        // Verifica che la prenotazione appartenga alla serata indicata
        const { data: booking, error: bookingErr } = await admin
          .from("prenotazioni")
          .select("id, serata_id")
          .eq("id", prenotazioneId)
          .maybeSingle();
        if (bookingErr) {
          throw new ApiError(500, "query_failed", "Errore durante la verifica della prenotazione di cover.");
        }
        if (!booking || Number(booking.serata_id) !== serataId) {
          throw new ApiError(400, "invalid_payload", "La prenotazione selezionata non appartiene a questa serata.");
        }
      }
      const { data, error } = await admin
        .from("serate")
        .update({ cover_prenotazione_id: prenotazioneId, cover_use_default: useDefaultCover })
        .eq("id", serataId)
        .eq("aperta", false)
        .select("id, archiviato_nascosto, cover_prenotazione_id, cover_use_default")
        .single();
      if (error) {
        throw new ApiError(500, "query_failed", "Errore durante l'aggiornamento della copertina.");
      }
      return { status: 200, data };
    }

    case "approve_booking":
    case "approve": {
      const bookingId = toPositiveInt(body.bookingId ?? body.id, "bookingId");
      const { data: bookingToApprove, error: bookingLoadError } = await admin
        .from("prenotazioni")
        .select("id, serata_id")
        .eq("id", bookingId)
        .maybeSingle();

      if (bookingLoadError) {
        throw new ApiError(500, "query_failed", "Errore durante il caricamento della prenotazione.");
      }
      if (!bookingToApprove) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }
      const approveSerataId = Number(bookingToApprove.serata_id);
      let activeBeforeApproval = null;
      let preparationModeEnabled = false;
      if (Number.isInteger(approveSerataId) && approveSerataId > 0) {
        await ensureSerataAllowsMutations(admin, approveSerataId);
        activeBeforeApproval = await getCurrentActiveBooking(admin, approveSerataId);
        preparationModeEnabled = isPreparationModeEnabled((await getPublicSettings(admin)).modalita_post_approvazione);
      }

      const { data, error } = await admin
        .from("prenotazioni")
        .update({ approvata: true, in_preparazione: false })
        .eq("id", bookingId)
        .select("id, approvata, cantata, in_preparazione")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad approvare la prenotazione.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }

      if (
        Number.isInteger(approveSerataId) &&
        approveSerataId > 0 &&
        !activeBeforeApproval &&
        preparationModeEnabled
      ) {
        await setPreparingBooking(admin, approveSerataId, bookingId);
        data.in_preparazione = true;
      }

      return { status: 200, data };
    }

    case "update_booking":
    case "update": {
      const bookingId = toPositiveInt(body.bookingId ?? body.id, "bookingId");
      const updates = parseBookingUpdatePayload(body);

      const { data: bookingToUpdate, error: bookingLoadError } = await admin
        .from("prenotazioni")
        .select("id, serata_id")
        .eq("id", bookingId)
        .maybeSingle();

      if (bookingLoadError) {
        throw new ApiError(500, "query_failed", "Errore durante il caricamento della prenotazione.");
      }
      if (!bookingToUpdate) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }
      const updateSerataId = Number(bookingToUpdate.serata_id);
      if (Number.isInteger(updateSerataId) && updateSerataId > 0) {
        await ensureSerataAllowsMutations(admin, updateSerataId);
      }

      const { data, error } = await admin
        .from("prenotazioni")
        .update(updates)
        .eq("id", bookingId)
        .select("id, nome, canzone, artista, approvata, cantata, selfie_nascosta")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito a modificare la prenotazione.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }

      return { status: 200, data };
    }

    case "delete_booking":
    case "delete": {
      const bookingId = toPositiveInt(body.bookingId ?? body.id, "bookingId");
      const { data: bookingToDelete, error: bookingLoadError } = await admin
        .from("prenotazioni")
        .select("id, serata_id")
        .eq("id", bookingId)
        .maybeSingle();

      if (bookingLoadError) {
        throw new ApiError(500, "query_failed", "Errore durante il caricamento della prenotazione.");
      }
      if (!bookingToDelete) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }
      const deleteSerataId = Number(bookingToDelete.serata_id);
      let currentBookingId = null;
      let preparationModeEnabled = false;
      if (Number.isInteger(deleteSerataId) && deleteSerataId > 0) {
        await ensureSerataAllowsMutations(admin, deleteSerataId);
        currentBookingId = Number((await getCurrentActiveBooking(admin, deleteSerataId))?.id) || null;
        preparationModeEnabled = isPreparationModeEnabled((await getPublicSettings(admin)).modalita_post_approvazione);
      }

      const { data, error } = await admin
        .from("prenotazioni")
        .delete()
        .eq("id", bookingId)
        .select("id")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "delete_failed", "Non sono riuscito a eliminare la prenotazione.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }

      if (
        preparationModeEnabled &&
        Number.isInteger(deleteSerataId) &&
        deleteSerataId > 0 &&
        Number(currentBookingId) === bookingId
      ) {
        const nextCurrentId = Number((await getCurrentActiveBooking(admin, deleteSerataId))?.id) || null;
        await setPreparingBooking(admin, deleteSerataId, nextCurrentId);
      }

      return { status: 200, data };
    }

    case "mark_done":
    case "done": {
      const bookingId = toPositiveInt(body.bookingId ?? body.id, "bookingId");
      const { data: bookingToComplete, error: bookingLoadError } = await admin
        .from("prenotazioni")
        .select("id, serata_id")
        .eq("id", bookingId)
        .maybeSingle();

      if (bookingLoadError) {
        throw new ApiError(500, "query_failed", "Errore durante il caricamento della prenotazione.");
      }
      if (!bookingToComplete) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }
      const completeSerataId = Number(bookingToComplete.serata_id);
      let currentBookingId = null;
      let preparationModeEnabled = false;
      if (Number.isInteger(completeSerataId) && completeSerataId > 0) {
        await ensureSerataAllowsMutations(admin, completeSerataId);
        currentBookingId = Number((await getCurrentActiveBooking(admin, completeSerataId))?.id) || null;
        preparationModeEnabled = isPreparationModeEnabled((await getPublicSettings(admin)).modalita_post_approvazione);
      }

      const { data, error } = await admin
        .from("prenotazioni")
        .update({ cantata: true, in_preparazione: false })
        .eq("id", bookingId)
        .select("id, cantata, in_preparazione")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito a segnare la prenotazione come completata.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }

      if (
        preparationModeEnabled &&
        Number.isInteger(completeSerataId) &&
        completeSerataId > 0 &&
        Number(currentBookingId) === bookingId
      ) {
        const nextCurrentId = Number((await getCurrentActiveBooking(admin, completeSerataId))?.id) || null;
        await setPreparingBooking(admin, completeSerataId, nextCurrentId);
      }

      return { status: 200, data };
    }

    case "start_current_booking":
    case "start_booking": {
      const bookingId = toPositiveInt(body.bookingId ?? body.id, "bookingId");
      const { data: bookingToStart, error: bookingLoadError } = await admin
        .from("prenotazioni")
        .select("id, serata_id, approvata, cantata, in_preparazione")
        .eq("id", bookingId)
        .maybeSingle();

      if (bookingLoadError) {
        throw new ApiError(500, "query_failed", "Errore durante il caricamento della prenotazione.");
      }
      if (!bookingToStart) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }

      const serataId = Number(bookingToStart.serata_id);
      if (!Number.isInteger(serataId) || serataId <= 0) {
        throw new ApiError(400, "invalid_state", "La prenotazione non appartiene a una serata valida.");
      }
      await ensureSerataAllowsMutations(admin, serataId);

      const currentBooking = await getCurrentActiveBooking(admin, serataId);
      if (Number(currentBooking?.id) !== bookingId) {
        throw new ApiError(409, "not_current_booking", "Puoi avviare solo la canzone corrente.");
      }
      if (!bookingToStart.approvata || bookingToStart.cantata) {
        throw new ApiError(409, "invalid_state", "La prenotazione non può essere avviata.");
      }
      if (!bookingToStart.in_preparazione) {
        throw new ApiError(409, "already_live", "La canzone è già live.");
      }

      const { data, error } = await admin
        .from("prenotazioni")
        .update({ in_preparazione: false })
        .eq("id", bookingId)
        .select("id, approvata, cantata, in_preparazione")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad avviare la canzone.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }

      return { status: 200, data };
    }

    case "set_current_preparing": {
      const bookingId = toPositiveInt(body.bookingId ?? body.id, "bookingId");
      const { data: bookingToPrepare, error: bookingLoadError } = await admin
        .from("prenotazioni")
        .select("id, serata_id, approvata, cantata, in_preparazione")
        .eq("id", bookingId)
        .maybeSingle();

      if (bookingLoadError) {
        throw new ApiError(500, "query_failed", "Errore durante il caricamento della prenotazione.");
      }
      if (!bookingToPrepare) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }

      const serataId = Number(bookingToPrepare.serata_id);
      if (!Number.isInteger(serataId) || serataId <= 0) {
        throw new ApiError(400, "invalid_state", "La prenotazione non appartiene a una serata valida.");
      }
      await ensureSerataAllowsMutations(admin, serataId);
      const preparationModeEnabled = isPreparationModeEnabled((await getPublicSettings(admin)).modalita_post_approvazione);
      if (!preparationModeEnabled) {
        throw new ApiError(409, "invalid_state", "La fase di preparazione è disabilitata nelle impostazioni.");
      }

      const currentBooking = await getCurrentActiveBooking(admin, serataId);
      if (Number(currentBooking?.id) !== bookingId) {
        throw new ApiError(409, "not_current_booking", "Puoi aggiornare solo la canzone corrente.");
      }
      if (!bookingToPrepare.approvata || bookingToPrepare.cantata) {
        throw new ApiError(409, "invalid_state", "La prenotazione non può tornare in preparazione.");
      }
      if (bookingToPrepare.in_preparazione) {
        throw new ApiError(409, "already_preparing", "La canzone è già in preparazione.");
      }

      const { data, error } = await admin
        .from("prenotazioni")
        .update({ in_preparazione: true })
        .eq("id", bookingId)
        .select("id, approvata, cantata, in_preparazione")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito a riportare la canzone in preparazione.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Prenotazione non trovata.");
      }

      return { status: 200, data };
    }

    case "open_serata":
    case "open_karaoke": {
      const openSerata = await getOpenSerata(admin);
      if (openSerata) {
        throw new ApiError(409, "already_open", "Esiste già una serata aperta.");
      }

      await updatePublicSettings(admin, { prossima_serata_data: null });

      const date = normalizeDateOrToday(body.date);
      const { data, error } = await admin
        .from("serate")
        .insert({
          data: date,
          aperta: true,
          voto_aperto: false,
          prenotazioni_abilitate: true,
          mostra_voti_totali: false,
          winner_reveal_countdown_active: false,
          winner_reveal_countdown_started_at: null,
          winner_reveal_countdown_ends_at: null,
          winner_reveal_countdown_seconds: null,
          ...clearRevealProgressState(),
          notifiche_telegram_abilitate: true,
          notifiche_browser_abilitate: true,
          vincitore_decretato: false,
          vincitore_prenotazione_id: null,
        })
        .select("*")
        .single();

      if (error) {
        throw new ApiError(500, "insert_failed", "Non sono riuscito ad aprire la serata.");
      }

      await updatePublicSettings(admin, { prossima_serata_data: null });

      return { status: 201, data };
    }

    case "close_serata":
    case "close_karaoke": {
      const serataId = body.serataId != null
        ? toPositiveInt(body.serataId, "serataId")
        : (await getOpenSerata(admin))?.id;

      if (!serataId) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }

      const { data, error } = await admin
        .from("serate")
        .update({
          aperta: false,
          voto_aperto: false,
          prenotazioni_abilitate: false,
          archiviato_nascosto: true,
          mostra_voti_totali: false,
          winner_reveal_countdown_active: false,
          winner_reveal_countdown_started_at: null,
          winner_reveal_countdown_ends_at: null,
          winner_reveal_countdown_seconds: null,
          ...clearRevealProgressState(),
        })
        .eq("id", serataId)
        .select("*")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito a chiudere la serata.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      await updatePublicSettings(admin, { prossima_serata_data: null });

      return { status: 200, data };
    }

    case "set_voting":
    case "toggle_voting": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      if (currentSerata.vincitore_decretato) {
        throw new ApiError(409, "winner_already_decreed", "Vincitore già decretato: non puoi riaprire le votazioni.");
      }

      const votoAperto = typeof body.votoAperto === "boolean"
        ? body.votoAperto
        : !currentSerata?.voto_aperto;
      if (votoAperto && currentSerata.winner_reveal_countdown_active) {
        throw new ApiError(409, "winner_reveal_countdown_active", "Countdown reveal attivo: non puoi riaprire le votazioni.");
      }

      const { data, error } = await admin
        .from("serate")
        .update({ voto_aperto: votoAperto })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad aggiornare lo stato votazioni.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return { status: 200, data };
    }

    case "set_show_vote_totals":
    case "toggle_show_vote_totals": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }

      const showVoteTotals = typeof body.mostraVotiTotali === "boolean"
        ? body.mostraVotiTotali
        : !Boolean(currentSerata.mostra_voti_totali);

      const { data, error } = await admin
        .from("serate")
        .update({ mostra_voti_totali: showVoteTotals })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad aggiornare la visibilità dei voti.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return { status: 200, data };
    }

    case "start_winner_reveal_countdown":
    case "start_winner_reveal": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      if (currentSerata.vincitore_decretato) {
        throw new ApiError(409, "winner_already_decreed", "Il vincitore è già stato decretato.");
      }
      if (currentSerata.voto_aperto) {
        throw new ApiError(409, "voting_still_open", "Chiudi prima le votazioni per avviare il countdown reveal.");
      }

      const countdownSeconds = parseCountdownSeconds(body.countdownSeconds);

      const { data: serataBookings, error: bookingsError } = await admin
        .from("prenotazioni")
        .select("*")
        .eq("serata_id", currentSerata.id)
        .order("created_at", { ascending: true });

      if (bookingsError) {
        throw new ApiError(500, "query_failed", "Errore durante il caricamento delle prenotazioni.");
      }

      const allBookings = (serataBookings ?? []) as Array<Record<string, unknown>>;
      const approvedBookings = allBookings.filter((booking) => Boolean(booking.approvata));
      if (approvedBookings.length === 0) {
        throw new ApiError(409, "no_approved_bookings", "Servono prenotazioni approvate per avviare il reveal.");
      }

      const scoreMap = await getBookingScores(admin, allBookings);
      const top5 = buildRanking(approvedBookings, scoreMap).slice(0, 5);
      if (top5.length === 0) {
        throw new ApiError(409, "no_ranking_available", "Impossibile calcolare la classifica finale.");
      }

      const startedAt = new Date();
      const endsAt = new Date(startedAt.getTime() + countdownSeconds * 1000);
      const revealSnapshot = await getRevealSettingsSnapshot(admin);
      const { data: updatedSerata, error: updateError } = await admin
        .from("serate")
        .update({
          voto_aperto: false,
          mostra_voti_totali: false,
          winner_reveal_countdown_active: true,
          winner_reveal_countdown_started_at: startedAt.toISOString(),
          winner_reveal_countdown_ends_at: endsAt.toISOString(),
          winner_reveal_countdown_seconds: countdownSeconds,
          ...revealSnapshot,
          ...clearRevealProgressState(),
        })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (updateError) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad avviare il countdown reveal.");
      }
      if (!updatedSerata) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return {
        status: 200,
        data: {
          serata: updatedSerata,
          top5_preview: top5,
        },
      };
    }

    case "start_winner_reveal_only": {
      // Avvia il revealing senza countdown: imposta ends_at = now (già scaduto)
      // così vota.html entra subito in fase reveal senza mostrare il timer.
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      if (currentSerata.vincitore_decretato) {
        throw new ApiError(409, "winner_already_decreed", "Il vincitore è già stato decretato.");
      }
      if (currentSerata.voto_aperto) {
        throw new ApiError(409, "voting_still_open", "Chiudi prima le votazioni per avviare il revealing.");
      }
      if (!currentSerata.winner_reveal_countdown_active) {
        throw new ApiError(409, "not_in_proclamazione_mode", "La serata non è in modalità proclamazione.");
      }
      if (Number.isFinite(Date.parse(String(currentSerata.winner_reveal_countdown_ends_at || "")))) {
        throw new ApiError(409, "countdown_already_started", "Il countdown è già stato avviato.");
      }

      const now = new Date();
      const revealSnapshot = await getRevealSettingsSnapshot(admin);
      const { data: updatedSerata, error: updateError } = await admin
        .from("serate")
        .update({
          winner_reveal_countdown_started_at: now.toISOString(),
          winner_reveal_countdown_ends_at: now.toISOString(),
          winner_reveal_countdown_seconds: null,
          ...revealSnapshot,
          ...clearRevealProgressState(),
        })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (updateError || !updatedSerata) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad avviare il revealing.");
      }

      return { status: 200, data: { serata: updatedSerata } };
    }

    case "set_browser_notifications":
    case "toggle_browser_notifications": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }

      const browserNotificationsEnabled = typeof body.notificheBrowserAbilitate === "boolean"
        ? body.notificheBrowserAbilitate
        : !Boolean(currentSerata.notifiche_browser_abilitate);

      const { data, error } = await admin
        .from("serate")
        .update({ notifiche_browser_abilitate: browserNotificationsEnabled })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad aggiornare le notifiche browser.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return { status: 200, data };
    }

    case "set_telegram_notifications":
    case "toggle_telegram_notifications": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }

      const telegramNotificationsEnabled = typeof body.notificheTelegramAbilitate === "boolean"
        ? body.notificheTelegramAbilitate
        : !Boolean(currentSerata.notifiche_telegram_abilitate);

      const { data, error } = await admin
        .from("serate")
        .update({ notifiche_telegram_abilitate: telegramNotificationsEnabled })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad aggiornare le notifiche Telegram.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return { status: 200, data };
    }

    case "enable_diretta": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      if (currentSerata.vincitore_decretato) {
        throw new ApiError(409, "winner_already_decreed", "Il vincitore è già stato decretato.");
      }
      if (currentSerata.voto_aperto) {
        throw new ApiError(409, "voting_still_open", "Chiudi prima le votazioni per abilitare la diretta.");
      }

      const { data, error } = await admin
        .from("serate")
        .update({
          prenotazioni_abilitate: false,
          winner_reveal_countdown_active: true,
          winner_reveal_countdown_started_at: null,
          winner_reveal_countdown_ends_at: null,
          winner_reveal_countdown_seconds: null,
          ...clearRevealProgressState(),
        })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad abilitare la diretta.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return { status: 200, data };
    }

    case "disable_diretta": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      if (currentSerata.vincitore_decretato) {
        throw new ApiError(409, "winner_already_decreed", "Il vincitore è già stato decretato.");
      }

      const { data, error } = await admin
        .from("serate")
        .update({
          winner_reveal_countdown_active: false,
          winner_reveal_countdown_started_at: null,
          winner_reveal_countdown_ends_at: null,
          winner_reveal_countdown_seconds: null,
          ...clearRevealProgressState(),
        })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito a disabilitare la diretta.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return { status: 200, data };
    }

    case "advance_winner_reveal": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      if (currentSerata.vincitore_decretato) {
        throw new ApiError(409, "winner_already_decreed", "Il vincitore è già stato decretato.");
      }
      if (!currentSerata.winner_reveal_countdown_active) {
        throw new ApiError(409, "reveal_not_active", "Reveal non attivo.");
      }

      const endsAt = Date.parse(String(currentSerata.winner_reveal_countdown_ends_at || ""));
      if (!Number.isFinite(endsAt)) {
        throw new ApiError(409, "countdown_not_started", "Avvia prima il countdown del reveal.");
      }
      if (endsAt > Date.now()) {
        throw new ApiError(409, "countdown_running", "Il countdown non è ancora terminato.");
      }

      const { data: serataBookings, error: bookingsError } = await admin
        .from("prenotazioni")
        .select("*")
        .eq("serata_id", currentSerata.id)
        .order("created_at", { ascending: true });

      if (bookingsError) {
        throw new ApiError(500, "query_failed", "Errore durante il caricamento delle prenotazioni.");
      }

      const allBookings = (serataBookings ?? []) as Array<Record<string, unknown>>;
      const approvedBookings = allBookings.filter((booking) => Boolean(booking.approvata));
      const scoreMap = await getBookingScores(admin, allBookings);
      const top5 = buildRanking(approvedBookings, scoreMap).slice(0, 5);
      if (top5.length === 0) {
        throw new ApiError(409, "no_ranking_available", "Impossibile calcolare la classifica finale.");
      }

      const maxRank = top5.length;
      const currentRank = Number(currentSerata.winner_reveal_current_rank);
      const hasCurrentRank = Number.isInteger(currentRank) && currentRank >= 1 && currentRank <= maxRank;
      let nextRank = maxRank;
      if (hasCurrentRank) {
        if (currentRank <= 2) {
          throw new ApiError(409, "winner_ready", "Posizione finale pronta: usa Svela vincitore.");
        }
        nextRank = currentRank - 1;
      }

      const { data: updatedSerata, error: updateError } = await admin
        .from("serate")
        .update({
          winner_reveal_current_rank: nextRank,
          winner_reveal_total_ranks: maxRank,
          winner_reveal_step_started_at: new Date().toISOString(),
        })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (updateError) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad avanzare il reveal.");
      }
      if (!updatedSerata) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return {
        status: 200,
        data: {
          serata: updatedSerata,
          reveal_rank: nextRank,
          top5,
        },
      };
    }

    case "decree_winner":
    case "decreta_vincitore": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      if (currentSerata.vincitore_decretato) {
        throw new ApiError(409, "winner_already_decreed", "Il vincitore è già stato decretato.");
      }

      const { data: serataBookings, error: bookingsError } = await admin
        .from("prenotazioni")
        .select("*")
        .eq("serata_id", currentSerata.id)
        .order("created_at", { ascending: true });

      if (bookingsError) {
        throw new ApiError(500, "query_failed", "Errore durante il caricamento delle prenotazioni.");
      }

      const allBookings = (serataBookings ?? []) as Array<Record<string, unknown>>;
      const approvedBookings = allBookings.filter((booking) => Boolean(booking.approvata));
      if (approvedBookings.length === 0) {
        throw new ApiError(409, "no_approved_bookings", "Servono prenotazioni approvate per decretare il vincitore.");
      }

      const scoreMap = await getBookingScores(admin, allBookings);
      const top5 = buildRanking(approvedBookings, scoreMap).slice(0, 5);
      if (top5.length === 0) {
        throw new ApiError(409, "no_ranking_available", "Impossibile calcolare la classifica finale.");
      }

      const skipCountdown = body.skipCountdown === true;

      // Se la diretta è abilitata e il countdown non è ancora partito → avvia countdown
      if (
        currentSerata.winner_reveal_countdown_active &&
        !currentSerata.winner_reveal_countdown_ends_at &&
        !skipCountdown
      ) {
        const countdownSeconds = parseCountdownSeconds(body.countdownSeconds ?? DEFAULT_WINNER_REVEAL_COUNTDOWN_SECONDS);
        const startedAt = new Date();
        const endsAt = new Date(startedAt.getTime() + countdownSeconds * 1000);
        const revealSnapshot = await getRevealSettingsSnapshot(admin);
        const { data: countdownSerata, error: countdownError } = await admin
          .from("serate")
          .update({
            winner_reveal_countdown_started_at: startedAt.toISOString(),
            winner_reveal_countdown_ends_at: endsAt.toISOString(),
            winner_reveal_countdown_seconds: countdownSeconds,
            ...revealSnapshot,
            ...clearRevealProgressState(),
          })
          .eq("id", currentSerata.id)
          .select("*")
          .maybeSingle();

        if (countdownError) {
          throw new ApiError(500, "update_failed", "Non sono riuscito ad avviare il countdown reveal.");
        }
        if (!countdownSerata) {
          throw new ApiError(404, "not_found", "Serata non trovata.");
        }

        return {
          status: 200,
          data: {
            serata: countdownSerata,
            countdown_started: true,
            top5_preview: top5,
          },
        };
      }

      const winnerBookingId = Number(top5[0].id);
      if (!Number.isInteger(winnerBookingId) || winnerBookingId <= 0) {
        throw new ApiError(500, "invalid_winner", "Impossibile identificare il vincitore.");
      }

      const { data: updatedSerata, error: updateError } = await admin
        .from("serate")
        .update({
          vincitore_decretato: true,
          vincitore_prenotazione_id: winnerBookingId,
          voto_aperto: false,
          mostra_voti_totali: true,
          winner_reveal_countdown_active: false,
          winner_reveal_countdown_started_at: null,
          winner_reveal_countdown_ends_at: null,
          winner_reveal_countdown_seconds: null,
          ...clearRevealProgressState(),
        })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (updateError) {
        throw new ApiError(500, "update_failed", "Non sono riuscito a decretare il vincitore.");
      }
      if (!updatedSerata) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return {
        status: 200,
        data: {
          serata: updatedSerata,
          winner_booking_id: winnerBookingId,
          top5,
        },
      };
    }

    case "set_bookings":
    case "toggle_bookings": {
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      if (currentSerata.vincitore_decretato) {
        throw new ApiError(409, "winner_already_decreed", "Vincitore già decretato: non puoi modificare le prenotazioni.");
      }
      if (currentSerata.winner_reveal_countdown_active) {
        throw new ApiError(409, "proclamazione_mode", "Modalità proclamazione attiva: non puoi modificare le prenotazioni.");
      }

      const prenotazioniAbilitate = typeof body.prenotazioniAbilitate === "boolean"
        ? body.prenotazioniAbilitate
        : !Boolean(currentSerata.prenotazioni_abilitate);

      const { data, error } = await admin
        .from("serate")
        .update({ prenotazioni_abilitate: prenotazioniAbilitate })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito ad aggiornare lo stato prenotazioni.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return { status: 200, data };
    }

    case "terminate_voting": {
      // Closes voting + bookings, enables proclamation mode (winner_reveal_countdown_active).
      // Equivalent to pressing "Termina votazioni" in the admin UI.
      const currentSerata = body.serataId != null
        ? await getSerataById(admin, toPositiveInt(body.serataId, "serataId"))
        : await getOpenSerata(admin);

      if (!currentSerata?.id) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      if (currentSerata.vincitore_decretato) {
        throw new ApiError(409, "winner_already_decreed", "Il vincitore è già stato decretato.");
      }
      if (!currentSerata.voto_aperto) {
        throw new ApiError(409, "voting_not_open", "Le votazioni non sono attualmente aperte.");
      }

      const { data: serataBookingsCheck, error: bookingsCheckError } = await admin
        .from("prenotazioni")
        .select("id")
        .eq("serata_id", currentSerata.id)
        .eq("approvata", true)
        .limit(1);

      if (bookingsCheckError) {
        throw new ApiError(500, "query_failed", "Errore durante la verifica delle prenotazioni approvate.");
      }
      if (!serataBookingsCheck || serataBookingsCheck.length === 0) {
        throw new ApiError(409, "no_approved_bookings", "Servono prenotazioni approvate per terminare le votazioni e avviare la proclamazione.");
      }

      const { data, error } = await admin
        .from("serate")
        .update({
          voto_aperto: false,
          prenotazioni_abilitate: false,
          winner_reveal_countdown_active: true,
          winner_reveal_countdown_started_at: null,
          winner_reveal_countdown_ends_at: null,
          winner_reveal_countdown_seconds: null,
          ...clearRevealProgressState(),
        })
        .eq("id", currentSerata.id)
        .select("*")
        .maybeSingle();

      if (error) {
        throw new ApiError(500, "update_failed", "Non sono riuscito a terminare le votazioni.");
      }
      if (!data) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }

      return { status: 200, data };
    }

    case "delete_serata": {
      const serataId = toPositiveInt(body.serataId, "serataId");

      // Only allow deleting closed (archived) serate.
      const serataToDelete = await getSerataById(admin, serataId);
      if (!serataToDelete) {
        throw new ApiError(404, "not_found", "Serata non trovata.");
      }
      if (serataToDelete.aperta) {
        throw new ApiError(409, "serata_open", "Non puoi eliminare una serata aperta. Chiudila prima.");
      }

      // Delete votes first (reference prenotazioni).
      const { data: bookingIds } = await admin
        .from("prenotazioni")
        .select("id")
        .eq("serata_id", serataId);

      const ids = (bookingIds ?? []).map((b: Record<string, unknown>) => Number(b.id)).filter((id: number) => id > 0);

      if (ids.length > 0) {
        const { error: votesDeleteError } = await admin
          .from("voti")
          .delete()
          .in("prenotazione_id", ids);

        if (votesDeleteError) {
          throw new ApiError(500, "delete_failed", "Non sono riuscito a eliminare i voti della serata.");
        }
      }

      // Delete prenotazioni.
      const { error: bookingsDeleteError } = await admin
        .from("prenotazioni")
        .delete()
        .eq("serata_id", serataId);

      if (bookingsDeleteError) {
        throw new ApiError(500, "delete_failed", "Non sono riuscito a eliminare le prenotazioni della serata.");
      }

      // Delete serata.
      const { error: serataDeleteError } = await admin
        .from("serate")
        .delete()
        .eq("id", serataId)
        .eq("aperta", false);

      if (serataDeleteError) {
        throw new ApiError(500, "delete_failed", "Non sono riuscito a eliminare la serata.");
      }

      return { status: 200, data: { deletedSerataId: serataId } };
    }

    case "cleanup_current_serata":
    case "cleanup_serata": {
      if (!isTestEnvironment()) {
        throw new ApiError(403, "forbidden", "Azione disponibile solo in ambiente di test.");
      }
      const serataId = body.serataId != null
        ? toPositiveInt(body.serataId, "serataId")
        : (await getOpenSerata(admin))?.id;

      if (!serataId) {
        throw new ApiError(404, "not_found", "Nessuna serata aperta trovata.");
      }
      await ensureSerataAllowsMutations(admin, serataId);

      const { data, error } = await admin
        .from("prenotazioni")
        .delete()
        .eq("serata_id", serataId)
        .select("id");

      if (error) {
        throw new ApiError(500, "delete_failed", "Non sono riuscito a pulire la serata corrente.");
      }

      return {
        status: 200,
        data: {
          serataId,
          deletedBookings: data?.length ?? 0,
        },
      };
    }

    case "cleanup_all_test_data":
    case "cleanup_all": {
      if (!isTestEnvironment()) {
        throw new ApiError(403, "forbidden", "Azione disponibile solo in ambiente di test.");
      }
      const bookingsResult = await admin
        .from("prenotazioni")
        .delete()
        .gt("id", 0)
        .select("id");

      if (bookingsResult.error) {
        throw new ApiError(500, "delete_failed", "Non sono riuscito a cancellare le prenotazioni.");
      }

      const serateResult = await admin
        .from("serate")
        .delete()
        .gt("id", 0)
        .select("id");

      if (serateResult.error) {
        throw new ApiError(500, "delete_failed", "Prenotazioni pulite, ma non sono riuscito a cancellare le serate.");
      }

      return {
        status: 200,
        data: {
          deletedBookings: bookingsResult.data?.length ?? 0,
          deletedSerate: serateResult.data?.length ?? 0,
        },
      };
    }

    case "populate_awards_test_data": {
      if (!isTestEnvironment()) {
        throw new ApiError(403, "forbidden", "Azione disponibile solo in ambiente di test.");
      }

      const date = normalizeDateOrToday(body.date);
      const currentSerata = await getOpenSerata(admin);
      let serataId = Number(currentSerata?.id);

      if (Number.isInteger(serataId) && serataId > 0) {
        const { error: deleteBookingsError } = await admin
          .from("prenotazioni")
          .delete()
          .eq("serata_id", serataId);

        if (deleteBookingsError) {
          throw new ApiError(500, "delete_failed", "Non sono riuscito a ripulire la serata corrente prima del popolamento.");
        }

        const { data: updatedSerata, error: updateSerataError } = await admin
          .from("serate")
          .update(buildAwardsTestSerataPayload(date))
          .eq("id", serataId)
          .select("*")
          .maybeSingle();

        if (updateSerataError) {
          throw new ApiError(500, "update_failed", "Non sono riuscito a preparare la serata corrente per i dati di test.");
        }
        if (!updatedSerata?.id) {
          throw new ApiError(404, "not_found", "Serata corrente non trovata.");
        }

        serataId = Number(updatedSerata.id);
      } else {
        const { data: createdSerata, error: createSerataError } = await admin
          .from("serate")
          .insert(buildAwardsTestSerataPayload(date))
          .select("*")
          .maybeSingle();

        if (createSerataError) {
          throw new ApiError(500, "insert_failed", "Non sono riuscito a creare la serata di test.");
        }
        if (!createdSerata?.id) {
          throw new ApiError(500, "insert_failed", "La serata di test non è stata creata correttamente.");
        }

        serataId = Number(createdSerata.id);
      }

      await updatePublicSettings(admin, { prossima_serata_data: null });

      const { error: insertBookingsError } = await admin
        .from("prenotazioni")
        .insert(buildAwardsTestBookings(serataId, date))
        .select("id");

      if (insertBookingsError) {
        throw new ApiError(500, "insert_failed", "Non sono riuscito a creare le canzoni di test.");
      }

      const { data: seededBookings, error: seededBookingsError } = await admin
        .from("prenotazioni")
        .select("id")
        .eq("serata_id", serataId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });

      if (seededBookingsError) {
        throw new ApiError(500, "query_failed", "Non sono riuscito a rileggere le canzoni di test create.");
      }

      const normalizedBookings = (seededBookings ?? [])
        .map((booking) => ({ id: Number(booking.id) }))
        .filter((booking) => Number.isInteger(booking.id) && booking.id > 0);

      if (normalizedBookings.length !== TEST_AWARDS_SAMPLE_BOOKINGS.length) {
        throw new ApiError(500, "insert_failed", "Le canzoni di test create non corrispondono al dataset atteso.");
      }

      const { data: insertedVotes, error: insertVotesError } = await admin
        .from("voti")
        .insert(buildAwardsTestVotes(normalizedBookings, date))
        .select("id");

      if (insertVotesError) {
        throw new ApiError(500, "insert_failed", "Non sono riuscito a creare i voti di test.");
      }

      const state = await getState(admin);
      return {
        status: 200,
        data: {
          serata: state.serata,
          top5: state.top5,
          bookingsCount: normalizedBookings.length,
          votesCount: insertedVotes?.length ?? 0,
        },
      };
    }

    case "populate_archive_test_data": {
      if (!isTestEnvironment()) {
        throw new ApiError(403, "forbidden", "Azione disponibile solo in ambiente di test.");
      }

      // Cancella serate di archivio già esistenti con le date test per evitare duplicati
      const testDates = ARCHIVE_TEST_NIGHTS.map((n) => buildArchiveTestDate(n.daysAgo));
      await admin.from("serate").delete().in("data", testDates).eq("aperta", false);

      let serateCreated = 0;
      let bookingsCreated = 0;
      let votesCreated = 0;

      for (const night of ARCHIVE_TEST_NIGHTS) {
        const date = buildArchiveTestDate(night.daysAgo);
        const baseTime = new Date(`${date}T20:30:00.000Z`).getTime();
        const voteBaseTime = new Date(`${date}T21:00:00.000Z`).getTime();

        // Crea la serata chiusa
        const { data: newSerata, error: serataErr } = await admin
          .from("serate")
          .insert({
            data: date,
            aperta: false,
            voto_aperto: false,
            mostra_voti_totali: true,
            vincitore_decretato: false, // aggiornato dopo
            vincitore_prenotazione_id: null,
            winner_reveal_countdown_active: false,
            prenotazioni_abilitate: false,
            archiviato_nascosto: false,
            ...clearRevealProgressState(),
          })
          .select("id")
          .maybeSingle();

        if (serataErr || !newSerata?.id) continue;
        const serataId = Number(newSerata.id);

        // Crea le prenotazioni
        const bookingPayloads = night.songs.map((s, i) => ({
          nome: s.nome,
          canzone: s.canzone,
          artista: s.artista,
          serata_id: serataId,
          approvata: true,
          cantata: true,
          in_preparazione: false,
          created_at: new Date(baseTime + i * 60_000).toISOString(),
        }));
        const { error: bookingsErr } = await admin.from("prenotazioni").insert(bookingPayloads);
        if (bookingsErr) continue;

        // Rilegge le prenotazioni per avere gli ID
        const { data: seededBookings } = await admin
          .from("prenotazioni")
          .select("id")
          .eq("serata_id", serataId)
          .order("created_at", { ascending: true });

        const bookingIds = (seededBookings ?? [])
          .map((b) => Number(b.id))
          .filter((id) => Number.isInteger(id) && id > 0);

        if (bookingIds.length !== night.songs.length) continue;

        // Crea i voti
        const votePayloads = bookingIds.flatMap((bookingId, bi) =>
          night.songs[bi].voti.map((voto, vi) => ({
            prenotazione_id: bookingId,
            voto,
            created_at: new Date(voteBaseTime + bi * 60_000 + vi * 1_000).toISOString(),
          }))
        );
        await admin.from("voti").insert(votePayloads);

        // Calcola il vincitore (chi ha il totale voti più alto)
        const totals = night.songs.map((s, i) =>
          s.voti.reduce((sum, v) => sum + v, 0)
        );
        const winnerIndex = totals.indexOf(Math.max(...totals));
        const winnerId = bookingIds[winnerIndex];

        // Aggiorna la serata con il vincitore
        await admin
          .from("serate")
          .update({ vincitore_decretato: true, vincitore_prenotazione_id: winnerId })
          .eq("id", serataId);

        serateCreated++;
        bookingsCreated += bookingIds.length;
        votesCreated += votePayloads.length;
      }

      return {
        status: 200,
        data: { serateCreated, bookingsCreated, votesCreated },
      };
    }

    case "get_gadget_premi": {
      const serataId = typeof body.serataId === "number" ? body.serataId : null;
      const { data: premi, error: premiError } = await admin
        .from("gadget_premi")
        .select("*")
        .order("ordine", { ascending: true })
        .order("creato_il", { ascending: true });
      if (premiError) throw new ApiError(500, "query_failed", "Errore nel caricamento dei premi.");

      let estrazioni: Record<string, unknown>[] = [];
      if (serataId && premi && premi.length > 0) {
        const premiIds = premi.map((p) => p.id);
        const { data: estratti } = await admin
          .from("gadget_estrazioni")
          .select("*, prenotazioni(id, nome, canzone, artista)")
          .in("premio_id", premiIds)
          .eq("serata_id", serataId);
        estrazioni = estratti || [];
      }
      const estrazioniMap: Record<number, unknown> = {};
      estrazioni.forEach((e) => { estrazioniMap[Number(e.premio_id)] = e; });
      const result = (premi || []).map((p) => ({ ...p, estrazione: estrazioniMap[Number(p.id)] || null }));
      return { status: 200, data: result };
    }

    case "add_gadget_premio": {
      const nome = typeof body.nome === "string" ? body.nome.trim() : "";
      const fotoUrl = typeof body.fotoUrl === "string" ? body.fotoUrl.trim() : null;
      if (!nome) throw new ApiError(400, "invalid_payload", "Il nome del premio è obbligatorio.");
      const { data: existing } = await admin.from("gadget_premi").select("ordine").order("ordine", { ascending: false }).limit(1).maybeSingle();
      const nextOrdine = (Number(existing?.ordine) || 0) + 1;
      const { data, error } = await admin
        .from("gadget_premi")
        .insert({ nome, foto_url: fotoUrl || null, ordine: nextOrdine })
        .select("*")
        .maybeSingle();
      if (error || !data) throw new ApiError(500, "insert_failed", "Impossibile aggiungere il premio.");
      return { status: 201, data };
    }

    case "delete_gadget_premio": {
      const premioId = typeof body.premioId === "number" ? body.premioId : null;
      if (!premioId) throw new ApiError(400, "invalid_payload", "premioId è obbligatorio.");
      const { error } = await admin.from("gadget_premi").delete().eq("id", premioId);
      if (error) throw new ApiError(500, "delete_failed", "Impossibile eliminare il premio.");
      return { status: 200, data: { ok: true } };
    }

    case "mostra_gadget_premio": {
      const premioId = typeof body.premioId === "number" ? body.premioId : null;
      if (!premioId) throw new ApiError(400, "invalid_payload", "premioId è obbligatorio.");
      const { data: premio, error: pError } = await admin
        .from("gadget_premi").select("*").eq("id", premioId).maybeSingle();
      if (pError || !premio) throw new ApiError(404, "not_found", "Premio non trovato.");
      await setGadgetRevealPayload(admin, {
        premio_id: premio.id,
        nome: premio.nome,
        foto_url: premio.foto_url || null,
        vincitore: null,
      });
      return { status: 200, data: { ok: true } };
    }

    case "estrai_gadget_premio": {
      const premioId = typeof body.premioId === "number" ? body.premioId : null;
      const serataId = typeof body.serataId === "number" ? body.serataId : null;
      if (!premioId) throw new ApiError(400, "invalid_payload", "premioId è obbligatorio.");
      if (!serataId) throw new ApiError(400, "invalid_payload", "serataId è obbligatorio.");

      // Check prize exists
      const { data: premio, error: pError } = await admin
        .from("gadget_premi").select("*").eq("id", premioId).maybeSingle();
      if (pError || !premio) throw new ApiError(404, "not_found", "Premio non trovato.");

      // Check not already extracted
      const { data: existing } = await admin
        .from("gadget_estrazioni").select("id").eq("premio_id", premioId).maybeSingle();
      if (existing) throw new ApiError(409, "already_extracted", "Questo premio ha già un vincitore estratto.");

      // Get already-extracted prenotazione IDs in this serata
      const { data: alreadyExtracted } = await admin
        .from("gadget_estrazioni").select("prenotazione_id").eq("serata_id", serataId);
      const excludedIds = (alreadyExtracted || []).map((e) => Number(e.prenotazione_id));

      // Get eligible: approvata=true, cantata=true, serata_id=serataId, not excluded
      const { data: eligible, error: eligibleError } = await admin
        .from("prenotazioni")
        .select("id, nome, canzone, artista")
        .eq("serata_id", serataId)
        .eq("approvata", true)
        .eq("cantata", true);
      if (eligibleError) throw new ApiError(500, "query_failed", "Errore nel caricamento delle prenotazioni.");

      const pool = (eligible || []).filter((p) => !excludedIds.includes(Number(p.id)));
      if (!pool.length) throw new ApiError(409, "no_eligible", "Nessun partecipante disponibile per l'estrazione.");

      const winner = pool[Math.floor(Math.random() * pool.length)];

      // Insert extraction
      const { error: insertError } = await admin
        .from("gadget_estrazioni")
        .insert({ premio_id: premioId, prenotazione_id: winner.id, serata_id: serataId });
      if (insertError) throw new ApiError(500, "insert_failed", "Impossibile salvare l'estrazione.");

      // Update reveal payload
      await setGadgetRevealPayload(admin, {
        premio_id: premio.id,
        nome: premio.nome,
        foto_url: premio.foto_url || null,
        vincitore: { id: winner.id, nome: winner.nome, canzone: winner.canzone, artista: winner.artista },
      });

      return { status: 200, data: { premio, vincitore: winner } };
    }

    case "reset_gadget_estrazione": {
      const premioId = typeof body.premioId === "number" ? body.premioId : null;
      if (!premioId) throw new ApiError(400, "invalid_payload", "premioId è obbligatorio.");
      const { error } = await admin.from("gadget_estrazioni").delete().eq("premio_id", premioId);
      if (error) throw new ApiError(500, "delete_failed", "Impossibile resettare l'estrazione.");
      return { status: 200, data: { ok: true } };
    }

    case "chiudi_gadget_reveal": {
      await setGadgetRevealPayload(admin, null);
      return { status: 200, data: { ok: true } };
    }

    default:
      throw new ApiError(400, "invalid_action", "Azione admin non supportata.");
  }
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

  try {
    await ensureAdminAuth(req);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, "invalid_json", "Body JSON non valido.");
    }

    if (!body || typeof body !== "object") {
      throw new ApiError(400, "invalid_payload", "Body JSON non valido.");
    }

    const payload = body as Record<string, unknown>;
    const action = toAction(payload.action);
    if (!action) {
      throw new ApiError(400, "invalid_payload", "Il campo action è obbligatorio.");
    }

    const admin = createAdminClient();
    const result = await executeAction(admin, action, payload);

    return jsonResponse(req, result.status, {
      success: true,
      data: result.data,
      error: null,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse(req, error.status, {
        success: false,
        data: null,
        error: { code: error.code, message: error.message },
      });
    }

    console.error(error);
    return jsonResponse(req, 500, {
      success: false,
      data: null,
      error: { code: "internal_error", message: "Errore interno del server." },
    });
  }
});
