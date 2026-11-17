import { RealtimeChannel } from '@supabase/supabase-js';
import {
  MatchFormatMode,
  MultiplayerRoomState,
  MultiplayerSlot,
  OnlineUserProfile,
  RoomVisibility,
} from '../types/game';
import {
  buildInitialRoomSlots,
  resolveActiveCharacterIdsForRoom,
} from './botService';
import type { ClientInputState, FriendRequestDoc } from './firebase';
import { CreateRoomParams } from './roomService';
import { getSupabaseClient, getSupabaseConfig } from './supabaseClient';

export interface SupabaseBackendDiagnostics {
  configured: boolean;
  schemaReady: boolean;
  activeBackend: 'supabase' | 'firestore_fallback';
  urlHost: string | null;
  lastError: string | null;
}

let schemaVerified = false;
let schemaAvailable = false;
let schemaCheckPromise: Promise<boolean> | null = null;
let lastSupabaseError: string | null = null;

function generateTagCode(uid: string): string {
  const suffix = uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
  return `#STF${suffix.padEnd(4, '9')}`;
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'STF-';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateMatchId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MTC-';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function mapSupabaseRowToUserProfile(
  row: Record<string, unknown>
): OnlineUserProfile & { friends: string[] } {
  const createdMs =
    typeof row.created_at === 'string' ? Date.parse(row.created_at) || Date.now() : Date.now();
  const updatedMs =
    typeof row.updated_at === 'string' ? Date.parse(row.updated_at) || Date.now() : Date.now();

  return {
    uid: String(row.uid || ''),
    displayName: String(row.display_name || 'Jogador'),
    tagCode: String(row.tag_code || '#STF0000'),
    status: (row.status as 'online' | 'in_room' | 'playing') || 'online',
    currentRoomCode: String(row.current_room_code || ''),
    friends: Array.isArray(row.friends) ? (row.friends as string[]) : [],
    wins: typeof row.wins === 'number' ? row.wins : 0,
    losses: typeof row.losses === 'number' ? row.losses : 0,
    draws: typeof row.draws === 'number' ? row.draws : 0,
    goalsScored: typeof row.goals_scored === 'number' ? row.goals_scored : 0,
    goalsConceded: typeof row.goals_conceded === 'number' ? row.goals_conceded : 0,
    matchesPlayed: typeof row.matches_played === 'number' ? row.matches_played : 0,
    createdAt: createdMs,
    updatedAt: updatedMs,
  };
}

/**
 * Converte uma linha da tabela/view de salas do Supabase para MultiplayerRoomState.
 * Garante que passwordHash seja sempre null no estado exposto ao cliente (proteção contra vazamento de hash).
 */
export function mapSupabaseRowToRoomState(row: Record<string, unknown>): MultiplayerRoomState {
  const mode: MatchFormatMode = row.mode === '2v2' ? '2v2' : '4v4';
  const visibility: RoomVisibility = row.visibility === 'private' ? 'private' : 'public';
  const slots =
    row.slots && typeof row.slots === 'object'
      ? (row.slots as Record<string, MultiplayerSlot>)
      : {};
  const activeCharacterIds = Array.isArray(row.active_character_ids)
    ? (row.active_character_ids as string[])
    : resolveActiveCharacterIdsForRoom(slots, mode);

  return {
    roomCode: String(row.room_code || ''),
    matchId: row.match_id ? String(row.match_id) : undefined,
    roomName: String(row.room_name || `SEM TERRA FC — ${String(row.room_code || '')}`),
    mode,
    visibility,
    hasPassword: Boolean(row.has_password),
    passwordHash: null, // Nunca expõe hashes de senha nas consultas ou estado do cliente
    maxHumans: typeof row.max_humans === 'number' ? row.max_humans : mode === '2v2' ? 4 : 8,
    autoFillBots: row.auto_fill_bots !== false,
    activeCharacterIds,
    loadingReadyUids: Array.isArray(row.loading_ready_uids)
      ? (row.loading_ready_uids as string[])
      : [],
    startAt: typeof row.start_at === 'number' ? row.start_at : undefined,
    lastActivityMs:
      typeof row.last_activity_ms === 'number' ? row.last_activity_ms : Date.now(),
    hostUid: String(row.host_uid || ''),
    hostName: String(row.host_name || 'Anfitrião'),
    status: (row.status as 'waiting' | 'starting' | 'playing' | 'finished') || 'waiting',
    homeTeamId: String(row.home_team_id || 'unidos_do_barro'),
    awayTeamId: String(row.away_team_id || 'rubro_negro_beco'),
    homeScore: typeof row.home_goals === 'number' ? row.home_goals : 0,
    awayScore: typeof row.away_goals === 'number' ? row.away_goals : 0,
    half: (row.half as 1 | 2) || 1,
    remainingSeconds: typeof row.remaining_seconds === 'number' ? row.remaining_seconds : 150,
    slots,
    matchState: null,
  };
}

/**
 * Colunas públicas seguras de public.rooms (exclui password_hash, inputs e match_snapshot).
 */
export const SAFE_ROOM_SELECT_COLUMNS =
  'room_code, match_id, room_name, mode, visibility, has_password, max_humans, auto_fill_bots, active_character_ids, loading_ready_uids, start_at, last_activity_ms, host_uid, host_name, status, home_team_id, away_team_id, home_goals, away_goals, half, remaining_seconds, slots, created_at, updated_at';

/**
 * Verifica se o projeto Supabase está configurado e se a migration SQL já foi aplicada.
 * Caso contrário, mantém o fallback seguro no Firestore sem quebrar nenhuma funcionalidade.
 */
export async function isSupabaseReady(): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;
  if (schemaVerified) return schemaAvailable;

  if (!schemaCheckPromise) {
    schemaCheckPromise = (async () => {
      try {
        const { error } = await client.from('users').select('uid').limit(1);
        if (error) {
          lastSupabaseError = `${error.code || 'ERR'}: ${error.message}`;
          schemaAvailable = false;
          schemaVerified = true;
          console.warn(
            '[STF-Supabase] Schema PostgreSQL ainda indisponível ou aguardando execução da migration SQL. Fallback Firestore preservado:',
            lastSupabaseError
          );
          return false;
        }
        schemaAvailable = true;
        schemaVerified = true;
        lastSupabaseError = null;
        console.info('[STF-Supabase] Conexão PostgreSQL + RLS validada com sucesso.');
        return true;
      } catch (err) {
        lastSupabaseError = err instanceof Error ? err.message : String(err);
        schemaAvailable = false;
        schemaVerified = true;
        return false;
      } finally {
        schemaCheckPromise = null;
      }
    })();
  }

  return schemaCheckPromise;
}

export function getSupabaseDiagnostics(): SupabaseBackendDiagnostics {
  const cfg = getSupabaseConfig();
  let urlHost: string | null = null;
  if (cfg.url) {
    try {
      urlHost = new URL(cfg.url).host;
    } catch {
      urlHost = cfg.url;
    }
  }
  return {
    configured: cfg.isConfigured,
    schemaReady: schemaAvailable,
    activeBackend: cfg.isConfigured && schemaAvailable ? 'supabase' : 'firestore_fallback',
    urlHost,
    lastError: cfg.configWarning || lastSupabaseError,
  };
}

/**
 * Sincroniza ou cria o perfil do usuário via RPC atômica `rpc_ensure_user_profile_atomic`,
 * onde a identidade vem exclusivamente do JWT (`public.require_authenticated_uid`) e
 * as estatísticas competitivas são protegidas por trigger contra escrita direta do cliente.
 */
export async function ensureSupabaseUserProfile(params: {
  uid: string;
  defaultDisplayName: string;
  preferredNickname?: string;
  firestoreLegacyData?: Record<string, unknown> | null;
}): Promise<(OnlineUserProfile & { friends: string[] }) | null> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return null;

  const { uid, defaultDisplayName, preferredNickname, firestoreLegacyData } = params;
  const legacy = firestoreLegacyData || {};
  const legacyFriends = Array.isArray(legacy.friends)
    ? (legacy.friends as string[]).filter((f) => typeof f === 'string' && f !== uid).slice(0, 200)
    : [];
  const legacyWins = typeof legacy.wins === 'number' ? Math.max(0, Math.floor(legacy.wins)) : 0;
  const legacyLosses =
    typeof legacy.losses === 'number' ? Math.max(0, Math.floor(legacy.losses)) : 0;
  const legacyDraws = typeof legacy.draws === 'number' ? Math.max(0, Math.floor(legacy.draws)) : 0;
  const legacyGoalsScored =
    typeof legacy.goalsScored === 'number' ? Math.max(0, Math.floor(legacy.goalsScored)) : 0;
  const legacyGoalsConceded =
    typeof legacy.goalsConceded === 'number' ? Math.max(0, Math.floor(legacy.goalsConceded)) : 0;
  const legacyMatchesPlayed =
    typeof legacy.matchesPlayed === 'number' ? Math.max(0, Math.floor(legacy.matchesPlayed)) : 0;
  const legacyName = typeof legacy.displayName === 'string' ? legacy.displayName.trim() : '';
  const legacyTag =
    typeof legacy.tagCode === 'string' && legacy.tagCode.length >= 2
      ? legacy.tagCode.slice(0, 20)
      : generateTagCode(uid);

  const displayName = (
    preferredNickname?.trim() ||
    (legacyName && !legacyName.startsWith('Craque_') ? legacyName : defaultDisplayName) ||
    'Jogador'
  ).slice(0, 28);

  const { data, error } = await client.rpc('rpc_ensure_user_profile_atomic', {
    p_uid: uid,
    p_display_name: displayName,
    p_tag_code: legacyTag,
    p_legacy_wins: legacyWins,
    p_legacy_losses: legacyLosses,
    p_legacy_draws: legacyDraws,
    p_legacy_goals_scored: legacyGoalsScored,
    p_legacy_goals_conceded: legacyGoalsConceded,
    p_legacy_matches_played: legacyMatchesPlayed,
    p_legacy_friends: legacyFriends,
  });

  if (error || !data) {
    lastSupabaseError = error?.message || 'Erro em rpc_ensure_user_profile_atomic';
    return null;
  }

  return mapSupabaseRowToUserProfile(data as Record<string, unknown>);
}

export async function updateSupabaseUserPresence(
  uid: string,
  status: 'online' | 'in_room' | 'playing' | 'offline',
  roomCode: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return false;

  const { error } = await client
    .from('users')
    .update({
      status,
      current_room_code: roomCode,
      updated_at: new Date().toISOString(),
    })
    .eq('uid', uid);

  return !error;
}

export function subscribeToSupabaseUserProfile(
  uid: string,
  cb: (profile: (OnlineUserProfile & { friends: string[] }) | null) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) return () => {};

  let active = true;
  let channel: RealtimeChannel | null = null;

  void client
    .from('users')
    .select('*')
    .eq('uid', uid)
    .maybeSingle()
    .then(({ data }) => {
      if (!active) return;
      cb(data ? mapSupabaseRowToUserProfile(data as Record<string, unknown>) : null);
    });

  channel = client
    .channel(`user_profile_${uid}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'users',
        filter: `uid=eq.${uid}`,
      },
      (payload) => {
        if (!active) return;
        if (payload.eventType === 'DELETE') {
          cb(null);
          return;
        }
        if (payload.new && typeof payload.new === 'object') {
          cb(mapSupabaseRowToUserProfile(payload.new as Record<string, unknown>));
        }
      }
    )
    .subscribe();

  return () => {
    active = false;
    if (channel) {
      void client.removeChannel(channel);
    }
  };
}

export function subscribeToSupabaseOnlinePlayers(
  cb: (players: OnlineUserProfile[]) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) return () => {};

  let active = true;
  const fetchLatest = async () => {
    const { data } = await client
      .from('users')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(20);
    if (!active || !data) return;
    cb(data.map((r) => mapSupabaseRowToUserProfile(r as Record<string, unknown>)));
  };

  void fetchLatest();

  const channel = client
    .channel('online_players_lobby')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'users',
      },
      () => {
        if (active) void fetchLatest();
      }
    )
    .subscribe();

  return () => {
    active = false;
    void client.removeChannel(channel);
  };
}

export async function sendSupabaseFriendRequestByTag(
  fromUid: string,
  fromName: string,
  fromTag: string,
  targetTagOrName: string
): Promise<{ ok: boolean; message: string } | null> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return null;

  const search = targetTagOrName.trim();
  if (!search) {
    return { ok: false, message: 'Digite o código #STF ou nome do amigo.' };
  }

  let { data: targets } = await client
    .from('users')
    .select('uid, display_name, tag_code')
    .ilike('tag_code', search)
    .limit(3);

  if (!targets || targets.length === 0) {
    const resByName = await client
      .from('users')
      .select('uid, display_name, tag_code')
      .ilike('display_name', search)
      .limit(3);
    targets = resByName.data;
  }

  if (!targets || targets.length === 0) {
    return { ok: false, message: 'Nenhum jogador encontrado com essa Tag ou Nome.' };
  }

  const target = targets[0];
  if (target.uid === fromUid) {
    return { ok: false, message: 'Você não pode adicionar a si mesmo!' };
  }

  const { error } = await client.from('friend_requests').insert({
    from_uid: fromUid,
    from_name: fromName.slice(0, 28),
    from_tag: fromTag.slice(0, 16),
    to_uid: target.uid,
    to_name: String(target.display_name || 'Amigo').slice(0, 28),
    type: 'friend_request',
    room_code: '',
    status: 'pending',
  });

  if (error) {
    return { ok: false, message: `Não foi possível enviar pedido: ${error.message}` };
  }

  return { ok: true, message: `Pedido enviado para ${target.display_name}!` };
}

export async function sendSupabaseRoomInvite(
  fromUid: string,
  fromName: string,
  fromTag: string,
  friendUid: string,
  friendName: string,
  roomCode: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return false;

  const { error } = await client.from('friend_requests').insert({
    from_uid: fromUid,
    from_name: fromName.slice(0, 28),
    from_tag: fromTag.slice(0, 16),
    to_uid: friendUid,
    to_name: friendName.slice(0, 28),
    type: 'room_invite',
    room_code: roomCode.slice(0, 16),
    status: 'pending',
  });

  return !error;
}

export async function respondToSupabaseFriendRequest(
  uid: string,
  request: FriendRequestDoc,
  accept: boolean
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return false;

  const { error } = await client.rpc('rpc_respond_friend_request_atomic', {
    p_request_id: request.id,
    p_uid: uid,
    p_accept: accept,
  });

  return !error;
}

export function subscribeToSupabaseIncomingRequests(
  uid: string,
  cb: (requests: FriendRequestDoc[]) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) return () => {};

  let active = true;
  const fetchPending = async () => {
    const { data } = await client
      .from('friend_requests')
      .select('*')
      .eq('to_uid', uid)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(20);

    if (!active || !data) return;
    const mapped: FriendRequestDoc[] = data.map((d) => ({
      id: String(d.id),
      fromUid: String(d.from_uid),
      fromName: String(d.from_name),
      fromTag: String(d.from_tag || '#STF'),
      toUid: String(d.to_uid),
      toName: String(d.to_name),
      type: (d.type as 'friend_request' | 'room_invite') || 'friend_request',
      roomCode: String(d.room_code || ''),
      status: (d.status as 'pending' | 'accepted' | 'declined') || 'pending',
      createdAt: typeof d.created_at === 'string' ? Date.parse(d.created_at) : Date.now(),
    }));
    cb(mapped);
  };

  void fetchPending();

  const channel = client
    .channel(`incoming_requests_${uid}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'friend_requests',
        filter: `to_uid=eq.${uid}`,
      },
      () => {
        if (active) void fetchPending();
      }
    )
    .subscribe();

  return () => {
    active = false;
    void client.removeChannel(channel);
  };
}

export function subscribeToSupabaseFriendsProfiles(
  friendUids: string[],
  cb: (friends: OnlineUserProfile[]) => void
): () => void {
  const client = getSupabaseClient();
  const slice = Array.from(new Set((friendUids || []).filter(Boolean))).sort().slice(0, 20);
  if (!client || slice.length === 0) {
    cb([]);
    return () => {};
  }

  let active = true;
  const fetchFriends = async () => {
    const { data } = await client.from('users').select('*').in('uid', slice);
    if (!active || !data) return;
    cb(data.map((r) => mapSupabaseRowToUserProfile(r as Record<string, unknown>)));
  };

  void fetchFriends();

  const channel = client
    .channel(`friends_profiles_${slice.join('_').slice(0, 48)}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'users',
      },
      () => {
        if (active) void fetchFriends();
      }
    )
    .subscribe();

  return () => {
    active = false;
    void client.removeChannel(channel);
  };
}

// ============================================================================
// Salas Multiplayer com Funções RPC Atômicas (Validação Server-Side)
// ============================================================================

export async function createSupabaseOnlineRoom(params: {
  hostUid: string;
  hostName: string;
  homeTeamId: string;
  awayTeamId: string;
  halfDurationSeconds: number;
  options?: Partial<CreateRoomParams>;
}): Promise<MultiplayerRoomState | null> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return null;

  const { hostUid, hostName, homeTeamId, awayTeamId, halfDurationSeconds, options } = params;
  const roomCode = generateRoomCode();
  const mode: MatchFormatMode = options?.mode === '2v2' ? '2v2' : '4v4';
  const visibility: RoomVisibility = options?.visibility === 'private' ? 'private' : 'public';
  const rawPassword = options?.password?.trim() || null;
  const maxHumans = options?.maxHumans
    ? Math.max(1, Math.min(mode === '2v2' ? 4 : 8, options.maxHumans))
    : mode === '2v2'
    ? 4
    : 8;

  const roomNum = Math.floor(100 + Math.random() * 900);
  const roomName = (options?.roomName?.trim() || `SEM TERRA FC — SALA #${roomNum}`).slice(0, 60);
  const slots = buildInitialRoomSlots(
    hostUid,
    hostName,
    options?.preferredCharacterId || 'home_1'
  );
  const activeCharacterIds = resolveActiveCharacterIdsForRoom(slots, mode);

  // A senha original é enviada por HTTPS para rpc_create_room_atomic, que aplica bcrypt (crypt/bf) no servidor.
  const { data, error } = await client.rpc('rpc_create_room_atomic', {
    p_room_code: roomCode,
    p_room_name: roomName,
    p_mode: mode,
    p_visibility: visibility,
    p_plain_password: visibility === 'private' ? rawPassword : null,
    p_max_humans: maxHumans,
    p_auto_fill_bots: options?.autoFillBots !== false,
    p_active_character_ids: activeCharacterIds,
    p_host_name: hostName.slice(0, 28),
    p_home_team_id: homeTeamId,
    p_away_team_id: awayTeamId,
    p_remaining_seconds: Math.floor(halfDurationSeconds),
    p_slots: slots,
  });

  if (error || !data) {
    lastSupabaseError = error?.message || 'Erro ao criar sala no Supabase';
    return null;
  }

  return mapSupabaseRowToRoomState(data as Record<string, unknown>);
}

export async function joinSupabaseOnlineRoom(params: {
  roomCode: string;
  uid: string;
  displayName: string;
  passwordInput?: string;
  expectedMode?: MatchFormatMode;
}): Promise<MultiplayerRoomState | null> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return null;

  const normalizedCode = params.roomCode.trim().toUpperCase();
  const plainPassword =
    params.passwordInput && params.passwordInput.trim().length > 0
      ? params.passwordInput.trim()
      : null;

  // Envia a senha digitada para validação bcrypt no servidor dentro de rpc_join_room_atomic
  const { data, error } = await client.rpc('rpc_join_room_atomic', {
    p_room_code: normalizedCode,
    p_uid: params.uid,
    p_display_name: params.displayName.slice(0, 28),
    p_password_hash: plainPassword,
    p_expected_mode: params.expectedMode ?? null,
  });

  if (error) {
    throw new Error(error.message);
  }
  if (!data) return null;

  return mapSupabaseRowToRoomState(data as Record<string, unknown>);
}

export async function toggleSupabasePlayerReady(
  roomCode: string,
  uid: string,
  ready?: boolean
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return false;

  const { error } = await client.rpc('rpc_toggle_ready_atomic', {
    p_room_code: roomCode.trim().toUpperCase(),
    p_uid: uid,
    p_ready: ready ?? null,
  });

  return !error;
}

export async function leaveSupabaseOnlineRoom(roomCode: string, uid: string): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return false;

  const { error } = await client.rpc('rpc_leave_room_atomic', {
    p_room_code: roomCode.trim().toUpperCase(),
    p_uid: uid,
  });

  return !error;
}

export async function selectSupabaseRoomCharacter(
  roomCode: string,
  _uid: string,
  displayName: string,
  targetCharacterId: string
): Promise<{ ok: boolean; message?: string } | null> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return null;

  const normalizedCode = roomCode.trim().toUpperCase();
  const { error } = await client.rpc('rpc_select_character_atomic', {
    p_room_code: normalizedCode,
    p_target_character_id: targetCharacterId,
    p_display_name: displayName.slice(0, 28),
  });

  if (error) {
    return { ok: false, message: error.message };
  }
  return { ok: true };
}

export async function startSupabaseOnlineMatch(
  roomCode: string,
  _uid: string
): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return null;

  const normalizedCode = roomCode.trim().toUpperCase();
  const candidateMatchId = generateMatchId();

  const { data, error } = await client.rpc('rpc_start_match_atomic', {
    p_room_code: normalizedCode,
    p_match_id: candidateMatchId,
    p_active_character_ids: [],
  });

  if (error) {
    throw new Error(error.message);
  }
  return typeof data === 'string' ? data : candidateMatchId;
}

export async function markSupabasePlayerMatchLoadingReady(
  roomCode: string,
  uid: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return false;

  const { error } = await client.rpc('rpc_mark_loading_ready_atomic', {
    p_room_code: roomCode.trim().toUpperCase(),
    p_uid: uid,
    p_force_promote: false,
  });

  return !error;
}

export async function promoteSupabaseRoomToPlaying(
  roomCode: string,
  uid: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return false;

  const { error } = await client.rpc('rpc_mark_loading_ready_atomic', {
    p_room_code: roomCode.trim().toUpperCase(),
    p_uid: uid,
    p_force_promote: true,
  });

  return !error;
}

export function subscribeToSupabaseRoom(
  roomCode: string,
  cb: (room: (MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) return () => {};

  const normalizedCode = roomCode.trim().toUpperCase();
  let active = true;

  void client
    .from('rooms')
    .select(SAFE_ROOM_SELECT_COLUMNS)
    .eq('room_code', normalizedCode)
    .maybeSingle()
    .then(({ data }) => {
      if (!active) return;
      if (!data) {
        cb(null);
        return;
      }
      const mapped = mapSupabaseRowToRoomState(data as unknown as Record<string, unknown>);
      cb({
        ...mapped,
        inputs: {},
      });
    });

  const channel = client
    .channel(`room_state_${normalizedCode}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'rooms',
        filter: `room_code=eq.${normalizedCode}`,
      },
      (payload) => {
        if (!active) return;
        if (payload.eventType === 'DELETE') {
          cb(null);
          return;
        }
        if (payload.new && typeof payload.new === 'object') {
          const row = payload.new as Record<string, unknown>;
          const mapped = mapSupabaseRowToRoomState(row);
          cb({
            ...mapped,
            inputs: {},
          });
        }
      }
    )
    .subscribe();

  return () => {
    active = false;
    void client.removeChannel(channel);
  };
}

export function subscribeToSupabasePublicRooms(
  cb: (rooms: MultiplayerRoomState[]) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) return () => {};

  let active = true;
  const fetchRooms = async () => {
    const cutoffMs = Date.now() - 120_000;
    // Consulta a View pública segura (public_rooms_lobby_view) que nunca expõe password_hash
    const { data } = await client
      .from('public_rooms_lobby_view')
      .select('*')
      .gte('last_activity_ms', cutoffMs)
      .order('last_activity_ms', { ascending: false })
      .limit(15);

    if (!active || !data) return;
    cb(data.map((r) => mapSupabaseRowToRoomState(r as Record<string, unknown>)));
  };

  void fetchRooms();

  const channel = client
    .channel('public_rooms_lobby')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'rooms',
      },
      () => {
        if (active) void fetchRooms();
      }
    )
    .subscribe();

  return () => {
    active = false;
    void client.removeChannel(channel);
  };
}

export async function recordSupabaseMatchFinished(params: {
  uid: string;
  roomCode: string;
  homeTeamName: string;
  awayTeamName: string;
  homeGoals: number;
  awayGoals: number;
  participantUids: string[];
  myTeam: 'home' | 'away';
}): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !(await isSupabaseReady())) return false;

  const { roomCode, homeTeamName, awayTeamName, homeGoals, awayGoals } = params;
  if (!roomCode) return false;

  // Toda a validação de partida ativa, idempotência e cálculo de vitórias/derrotas/gols
  // acontece no servidor dentro de rpc_record_match_finished_atomic.
  const { data, error } = await client.rpc('rpc_record_match_finished_atomic', {
    p_room_code: roomCode.trim().toUpperCase(),
    p_home_team_name: homeTeamName.slice(0, 60),
    p_away_team_name: awayTeamName.slice(0, 60),
    p_home_goals: Math.max(0, Math.min(35, Math.floor(homeGoals))),
    p_away_goals: Math.max(0, Math.min(35, Math.floor(awayGoals))),
  });

  if (error) {
    return false;
  }
  return Boolean(data);
}
