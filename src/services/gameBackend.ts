import { RealtimeChannel } from '@supabase/supabase-js';
import {
  MatchFormatMode,
  MultiplayerRoomState,
  MultiplayerSlot,
  OnlineUserProfile,
  RoomVisibility,
} from '../types/game';
import {
  ALL_CHARACTERS,
  buildInitialRoomSlots,
  resolveActiveCharacterIdsForRoom,
} from './botService';
import type { ClientInputState, FriendRequestDoc } from './firebase';
import { CreateRoomParams } from './roomService';
import {
  getCurrentFirebaseUid,
  getFreshFirebaseAccessToken,
  getSupabaseClient,
  getSupabaseConfig,
} from './supabaseClient';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Valida se uma string possui formato UUID canônico (usado apenas para IDs internos:
 * `friend_requests.id`, `friendships.id`, `room_participants.id`, `matches.match_id`, `match_history.id`).
 * UIDs do Firebase NUNCA são UUID (devem permanecer TEXT).
 */
export function isValidUuid(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return UUID_REGEX.test(value.trim());
}

/**
 * Valida se um identificador é um UID Firebase válido em formato TEXT (1 a 128 caracteres).
 */
export function isValidFirebaseUid(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const clean = value.trim();
  return clean.length >= 1 && clean.length <= 128;
}

/**
 * Detecta se um erro retornado pelo PostgreSQL/PostgREST é o erro `22P02`
 * (`invalid input syntax for type uuid`) causado por uma função RPC ou policy legada
 * no banco que ainda invoca `auth.uid()` sobre o UID TEXT do Firebase.
 */
export function isUuidSyntaxError22P02(err: unknown): boolean {
  if (!err) return false;
  const code =
    err instanceof GameBackendError
      ? err.code
      : typeof (err as Record<string, unknown>).code === 'string'
      ? String((err as Record<string, unknown>).code)
      : '';
  const msg =
    err instanceof Error
      ? err.message
      : typeof (err as Record<string, unknown>).message === 'string'
      ? String((err as Record<string, unknown>).message)
      : String(err);
  return (
    code === '22P02' ||
    msg.includes('22P02') ||
    msg.toLowerCase().includes('invalid input syntax for type uuid')
  );
}

// ============================================================================
// 1. TIPOS DAS RPCs E TABELAS REAIS DO SUPABASE (https://etlvzqrfsvvpzltimxaj.supabase.co)
// ============================================================================

export type AvailableSupabaseRpcName =
  | 'rpc_ensure_user_profile_atomic'
  | 'rpc_create_room_atomic'
  | 'rpc_join_room_atomic'
  | 'rpc_leave_room_atomic'
  | 'rpc_select_character_atomic'
  | 'rpc_toggle_ready_atomic'
  | 'rpc_start_match_atomic'
  | 'rpc_send_friend_request'
  | 'rpc_respond_friend_request'
  | 'rpc_remove_friend'
  | 'rpc_get_public_lobby'
  | 'rpc_get_room_lobby'
  | 'rpc_get_my_friends'
  | 'rpc_get_friend_requests';

export interface SupabaseUserRow {
  uid: string;
  display_name: string;
  tag_code: string;
  avatar_url?: string | null;
  status: string;
  current_room_code?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface SupabaseRoomRow {
  room_code: string;
  host_id: string;
  room_name: string;
  mode: string;
  visibility: string;
  status: string;
  max_players: number;
  created_at?: string;
  updated_at?: string;
}

export interface SupabaseRoomParticipantRow {
  id?: string;
  room_code: string;
  user_id: string;
  team?: string | null;
  character_id?: string | null;
  is_ready?: boolean;
  is_loading_ready?: boolean;
  joined_at?: string;
  display_name?: string;
  tag_code?: string;
  avatar_url?: string | null;
  users?: {
    uid?: string;
    display_name?: string;
    tag_code?: string;
    avatar_url?: string | null;
  } | null;
}

export interface SupabaseFriendRequestRow {
  id: string;
  sender_id: string;
  receiver_id: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  sender_name?: string;
  sender_tag?: string;
  display_name?: string;
  tag_code?: string;
}

export interface GameBackendState {
  loading: boolean;
  pendingCount: number;
  activeRpc: AvailableSupabaseRpcName | null;
  lastError: string | null;
  lastUpdatedMs: number;
}

export class GameBackendError extends Error {
  public readonly rpcName: AvailableSupabaseRpcName | string;
  public readonly code: string;

  constructor(message: string, rpcName: AvailableSupabaseRpcName | string, code = 'RPC_ERROR') {
    super(message);
    this.name = 'GameBackendError';
    this.rpcName = rpcName;
    this.code = code;
  }
}

// ============================================================================
// 2. ESTADO CENTRALIZADO DE CARREGAMENTO E ERROS
// ============================================================================

let backendState: GameBackendState = {
  loading: false,
  pendingCount: 0,
  activeRpc: null,
  lastError: null,
  lastUpdatedMs: Date.now(),
};

const backendStateListeners = new Set<(state: GameBackendState) => void>();

function emitBackendState(): void {
  const snapshot = { ...backendState };
  backendStateListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      // Ignora erro em listener de UI
    }
  });
}

function beginBackendOperation(rpcName: AvailableSupabaseRpcName): void {
  backendState = {
    ...backendState,
    pendingCount: backendState.pendingCount + 1,
    loading: true,
    activeRpc: rpcName,
    lastUpdatedMs: Date.now(),
  };
  emitBackendState();
}

function endBackendOperation(errorMessage: string | null = null): void {
  const nextCount = Math.max(0, backendState.pendingCount - 1);
  backendState = {
    ...backendState,
    pendingCount: nextCount,
    loading: nextCount > 0,
    activeRpc: nextCount === 0 ? null : backendState.activeRpc,
    lastError: errorMessage !== null ? errorMessage : backendState.lastError,
    lastUpdatedMs: Date.now(),
  };
  emitBackendState();
}

export function getGameBackendState(): GameBackendState {
  return { ...backendState };
}

export function clearGameBackendError(): void {
  backendState = {
    ...backendState,
    lastError: null,
    lastUpdatedMs: Date.now(),
  };
  emitBackendState();
}

export function subscribeToGameBackendState(
  cb: (state: GameBackendState) => void
): () => void {
  backendStateListeners.add(cb);
  cb({ ...backendState });
  return () => {
    backendStateListeners.delete(cb);
  };
}

// ============================================================================
// 3. MAPEAMENTO DE PERSONAGENS, PERFIS, SALAS E PARTICIPANTES
// ============================================================================

const SKIN_TO_SLOT_ID: Record<string, string> = {
  yuri: 'home_1',
  josue: 'home_2',
  careca: 'home_3',
  bode: 'home_4',
  primo: 'away_1',
  bicudo: 'away_2',
  ismael: 'away_3',
  felipe: 'away_4',
};

const SLOT_ID_TO_SKIN: Record<string, string> = {
  home_1: 'yuri',
  home_2: 'josue',
  home_3: 'careca',
  home_4: 'bode',
  away_1: 'primo',
  away_2: 'bicudo',
  away_3: 'ismael',
  away_4: 'felipe',
};

export function normalizeSlotIdFromCharacterId(
  rawCharId: string | null | undefined,
  teamHint?: 'home' | 'away'
): string | null {
  if (!rawCharId) return null;
  const clean = rawCharId.trim().toLowerCase();
  if (!clean) return null;
  if (SLOT_ID_TO_SKIN[clean]) return clean;
  if (SKIN_TO_SLOT_ID[clean]) return SKIN_TO_SLOT_ID[clean];

  if (teamHint === 'home' && ['1', '2', '3', '4'].includes(clean)) {
    return `home_${clean}`;
  }
  if (teamHint === 'away' && ['1', '2', '3', '4'].includes(clean)) {
    return `away_${clean}`;
  }
  return null;
}

export function getTeamFromCharacterOrSlot(characterOrSlotId: string): 'home' | 'away' {
  const slotId = normalizeSlotIdFromCharacterId(characterOrSlotId) || characterOrSlotId;
  return slotId.startsWith('away') ? 'away' : 'home';
}

export function generateFallbackTagCode(uid: string): string {
  const suffix = uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
  return `#STF${suffix.padEnd(4, '9')}`;
}

export function unwrapRpcPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return raw.length > 0 && raw[0] && typeof raw[0] === 'object'
      ? (raw[0] as Record<string, unknown>)
      : null;
  }
  if (typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  return null;
}

export function unwrapRpcArray(raw: unknown, nestedKeys: string[] = []): Record<string, unknown>[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['data', 'items', 'rooms', 'friends', 'requests', 'participants', 'players', ...nestedKeys]) {
      if (Array.isArray(obj[key])) {
        return (obj[key] as unknown[]).filter(
          (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')
        );
      }
    }
    return [obj];
  }
  return [];
}

export function mapRawToUserProfile(
  raw: Record<string, unknown>,
  fallbackUid = ''
): OnlineUserProfile & { friends: string[] } {
  const nestedUser =
    raw.user && typeof raw.user === 'object' ? (raw.user as Record<string, unknown>) : raw;

  // Nunca utiliza `nestedUser.id` se ele for um UUID de registro interno (ex.: friendships.id ou room_participants.id)
  const candidateId =
    typeof nestedUser.id === 'string' && !isValidUuid(nestedUser.id) ? nestedUser.id : '';

  const uid = String(
    nestedUser.uid ||
      nestedUser.user_id ||
      nestedUser.friend_id ||
      nestedUser.friend_uid ||
      candidateId ||
      fallbackUid ||
      ''
  ).trim();
  const displayName = String(
    nestedUser.display_name ||
      nestedUser.displayName ||
      nestedUser.friend_name ||
      nestedUser.name ||
      'Jogador'
  ).trim();
  const tagCode = String(
    nestedUser.tag_code ||
      nestedUser.tagCode ||
      nestedUser.friend_tag ||
      (uid ? generateFallbackTagCode(uid) : '#STF0000')
  ).trim();

  const rawStatus = String(nestedUser.status || '').toLowerCase();
  const isOnlineBool =
    typeof nestedUser.is_online === 'boolean' ? nestedUser.is_online : rawStatus !== 'offline';
  const currentRoomCode = String(
    nestedUser.current_room_code || nestedUser.currentRoomCode || nestedUser.room_code || ''
  ).trim();

  let status: 'online' | 'in_room' | 'playing' = 'online';
  if (rawStatus === 'playing' || rawStatus === 'in_match') {
    status = 'playing';
  } else if (rawStatus === 'in_room' || currentRoomCode) {
    status = 'in_room';
  } else if (isOnlineBool) {
    status = 'online';
  }

  const createdMs =
    typeof nestedUser.created_at === 'string'
      ? Date.parse(nestedUser.created_at) || Date.now()
      : typeof nestedUser.createdAt === 'number'
      ? nestedUser.createdAt
      : Date.now();
  const updatedMs =
    typeof nestedUser.updated_at === 'string'
      ? Date.parse(nestedUser.updated_at) || Date.now()
      : typeof nestedUser.last_seen === 'string'
      ? Date.parse(nestedUser.last_seen) || Date.now()
      : typeof nestedUser.updatedAt === 'number'
      ? nestedUser.updatedAt
      : Date.now();

  return {
    uid,
    displayName: displayName || 'Jogador',
    tagCode,
    status,
    currentRoomCode,
    friends: Array.isArray(nestedUser.friends) ? (nestedUser.friends as string[]) : [],
    wins: typeof nestedUser.wins === 'number' ? nestedUser.wins : 0,
    losses: typeof nestedUser.losses === 'number' ? nestedUser.losses : 0,
    draws: typeof nestedUser.draws === 'number' ? nestedUser.draws : 0,
    goalsScored:
      typeof nestedUser.goals_scored === 'number'
        ? nestedUser.goals_scored
        : typeof nestedUser.goalsScored === 'number'
        ? nestedUser.goalsScored
        : 0,
    goalsConceded:
      typeof nestedUser.goals_conceded === 'number'
        ? nestedUser.goals_conceded
        : typeof nestedUser.goalsConceded === 'number'
        ? nestedUser.goalsConceded
        : 0,
    matchesPlayed:
      typeof nestedUser.matches_played === 'number'
        ? nestedUser.matches_played
        : typeof nestedUser.matchesPlayed === 'number'
        ? nestedUser.matchesPlayed
        : 0,
    createdAt: createdMs,
    updatedAt: updatedMs,
  };
}

/**
 * Reconstrói os 8 slots canônicos (home_1..home_4, away_1..away_4) a partir das linhas
 * de `room_participants` e metadados da sala, preenchendo as vagas livres com Bots.
 */
export function buildSlotsFromParticipants(
  hostUid: string,
  hostName: string,
  participants: Record<string, unknown>[],
  existingSlotsObj?: Record<string, unknown> | null
): {
  slots: Record<string, MultiplayerSlot>;
  loadingReadyUids: string[];
  resolvedHostName: string;
} {
  // Se o payload já vier com um mapa completo de slots (home_1..away_4), normaliza e retorna
  if (
    existingSlotsObj &&
    typeof existingSlotsObj === 'object' &&
    !Array.isArray(existingSlotsObj) &&
    ('home_1' in existingSlotsObj || 'away_1' in existingSlotsObj)
  ) {
    const slots = existingSlotsObj as Record<string, MultiplayerSlot>;
    const loadingReadyUids: string[] = [];
    let resolvedHostName = hostName || 'Anfitrião';
    for (const s of Object.values(slots)) {
      if (s && !s.isBot && s.uid) {
        if (s.uid === hostUid && s.displayName) {
          resolvedHostName = s.displayName;
        }
        if (s.isReady) {
          loadingReadyUids.push(s.uid);
        }
      }
    }
    return { slots, loadingReadyUids, resolvedHostName };
  }

  // Inicializa todos os 8 slots como Bots por padrão
  const slots: Record<string, MultiplayerSlot> = {};
  for (const char of ALL_CHARACTERS) {
    slots[char.id] = {
      characterId: char.id,
      characterName: char.name,
      team: char.team,
      uid: null,
      displayName: `Bot ${char.name}`,
      isBot: true,
      isReady: true,
      pingMs: 0,
      micEnabled: false,
      isSpeaking: false,
      lastSeenMs: Date.now(),
    };
  }

  const loadingReadyUids: string[] = [];
  let resolvedHostName = hostName || '';

  // Se não houver array de participantes ainda, aloca ao menos o host em home_1 se hostUid existir
  if (!participants || participants.length === 0) {
    if (hostUid) {
      return {
        slots: buildInitialRoomSlots(hostUid, hostName || 'Anfitrião', 'home_1'),
        loadingReadyUids: [hostUid],
        resolvedHostName: hostName || 'Anfitrião',
      };
    }
    return { slots, loadingReadyUids, resolvedHostName: resolvedHostName || 'Anfitrião' };
  }

  const homeOrder = ['home_1', 'home_2', 'home_3', 'home_4'];
  const awayOrder = ['away_1', 'away_2', 'away_3', 'away_4'];
  const pendingAssignment: Array<{
    uid: string;
    displayName: string;
    team: 'home' | 'away';
    isReady: boolean;
    isLoadingReady: boolean;
  }> = [];

  for (const rawP of participants) {
    const nestedUser =
      rawP.users && typeof rawP.users === 'object'
        ? (rawP.users as Record<string, unknown>)
        : rawP.user && typeof rawP.user === 'object'
        ? (rawP.user as Record<string, unknown>)
        : null;

    // Importante: nunca usar `rawP.id` como fallback se for UUID da linha `room_participants.id`
    const uid = String(
      rawP.user_id || rawP.uid || nestedUser?.uid || ''
    ).trim();
    if (!uid) continue;

    const displayName = String(
      rawP.display_name ||
        rawP.displayName ||
        nestedUser?.display_name ||
        nestedUser?.displayName ||
        (uid === hostUid && hostName ? hostName : `Craque_${uid.slice(0, 4).toUpperCase()}`)
    ).trim();

    if (uid === hostUid && displayName) {
      resolvedHostName = displayName;
    }

    const rawTeam = String(rawP.team || '').toLowerCase();
    const explicitChar = String(rawP.character_id || rawP.characterId || '').trim();
    const mappedSlotId = normalizeSlotIdFromCharacterId(
      explicitChar,
      rawTeam === 'away' ? 'away' : 'home'
    );
    const team: 'home' | 'away' = mappedSlotId
      ? getTeamFromCharacterOrSlot(mappedSlotId)
      : rawTeam === 'away'
      ? 'away'
      : 'home';

    const isReady =
      typeof rawP.is_ready === 'boolean'
        ? rawP.is_ready
        : typeof rawP.isReady === 'boolean'
        ? rawP.isReady
        : uid === hostUid;
    const isLoadingReady =
      typeof rawP.is_loading_ready === 'boolean'
        ? rawP.is_loading_ready
        : typeof rawP.isLoadingReady === 'boolean'
        ? rawP.isLoadingReady
        : false;

    if (isLoadingReady) {
      loadingReadyUids.push(uid);
    }

    if (mappedSlotId && slots[mappedSlotId] && slots[mappedSlotId].isBot) {
      slots[mappedSlotId] = {
        ...slots[mappedSlotId],
        uid,
        displayName,
        isBot: false,
        isReady,
        pingMs: 18,
        lastSeenMs: Date.now(),
      };
    } else {
      pendingAssignment.push({
        uid,
        displayName,
        team,
        isReady,
        isLoadingReady,
      });
    }
  }

  // Aloca participantes sem character_id explícito (ou cujo character_id colidiu) no primeiro slot livre do seu time
  for (const p of pendingAssignment) {
    const preferredPool = p.team === 'away' ? [...awayOrder, ...homeOrder] : [...homeOrder, ...awayOrder];
    const freeSlotId = preferredPool.find((slotKey) => slots[slotKey]?.isBot);
    if (freeSlotId && slots[freeSlotId]) {
      slots[freeSlotId] = {
        ...slots[freeSlotId],
        uid: p.uid,
        displayName: p.displayName,
        isBot: false,
        isReady: p.isReady,
        pingMs: 18,
        lastSeenMs: Date.now(),
      };
    }
  }

  return {
    slots,
    loadingReadyUids,
    resolvedHostName: resolvedHostName || 'Anfitrião',
  };
}

/**
 * Converte a resposta de `rpc_get_room_lobby`, `rpc_create_room_atomic`, `rpc_join_room_atomic`
 * ou `rpc_get_public_lobby` para `MultiplayerRoomState`.
 */
export function mapRpcRoomToRoomState(
  raw: Record<string, unknown>,
  fallbackRoomCode = ''
): MultiplayerRoomState {
  const roomObj =
    raw.room && typeof raw.room === 'object'
      ? (raw.room as Record<string, unknown>)
      : raw;

  const roomCode = String(
    roomObj.room_code || roomObj.roomCode || raw.room_code || fallbackRoomCode || ''
  )
    .trim()
    .toUpperCase();

  const mode: MatchFormatMode =
    roomObj.mode === '2v2' || raw.mode === '2v2' ? '2v2' : '4v4';
  const visibility: RoomVisibility =
    roomObj.visibility === 'private' || raw.visibility === 'private' ? 'private' : 'public';

  const hostUid = String(
    roomObj.host_id || roomObj.host_uid || roomObj.hostUid || raw.host_id || ''
  ).trim();
  const rawHostName = String(
    roomObj.host_name ||
      roomObj.hostName ||
      raw.host_name ||
      (roomObj.host && typeof roomObj.host === 'object'
        ? (roomObj.host as Record<string, unknown>).display_name || ''
        : '')
  ).trim();

  const participantsList: Record<string, unknown>[] = Array.isArray(raw.participants)
    ? (raw.participants as Record<string, unknown>[])
    : Array.isArray(roomObj.participants)
    ? (roomObj.participants as Record<string, unknown>[])
    : Array.isArray(raw.players)
    ? (raw.players as Record<string, unknown>[])
    : Array.isArray(roomObj.room_participants)
    ? (roomObj.room_participants as Record<string, unknown>[])
    : [];

  const existingSlots =
    (roomObj.slots && typeof roomObj.slots === 'object'
      ? (roomObj.slots as Record<string, unknown>)
      : raw.slots && typeof raw.slots === 'object'
      ? (raw.slots as Record<string, unknown>)
      : null);

  const { slots, loadingReadyUids, resolvedHostName } = buildSlotsFromParticipants(
    hostUid,
    rawHostName,
    participantsList,
    existingSlots
  );

  // Caso seja uma linha resumida de rpc_get_public_lobby com player_count / current_players / participant_count
  // mas sem o array completo de participantes, reflete a contagem real de humanos nos slots para exibição fiel no card
  const explicitPlayerCount =
    typeof roomObj.player_count === 'number'
      ? roomObj.player_count
      : typeof roomObj.current_players === 'number'
      ? roomObj.current_players
      : typeof roomObj.participants_count === 'number'
      ? roomObj.participants_count
      : null;

  if (explicitPlayerCount !== null && participantsList.length === 0 && !existingSlots) {
    const slotKeys = ['home_1', 'away_1', 'home_2', 'away_2', 'home_3', 'away_3', 'home_4', 'away_4'];
    const targetHumans = Math.max(1, Math.min(8, Math.floor(explicitPlayerCount)));
    for (let i = 0; i < slotKeys.length; i++) {
      const k = slotKeys[i];
      if (i < targetHumans) {
        slots[k] = {
          ...slots[k],
          uid: i === 0 ? hostUid || `host_${roomCode}` : `player_${roomCode}_${i}`,
          displayName: i === 0 ? resolvedHostName : `Jogador ${i + 1}`,
          isBot: false,
          isReady: true,
        };
      }
    }
  }

  const maxHumans =
    typeof roomObj.max_players === 'number'
      ? roomObj.max_players
      : typeof roomObj.max_humans === 'number'
      ? roomObj.max_humans
      : mode === '2v2'
      ? 4
      : 8;

  const rawStatus = String(roomObj.status || raw.status || 'waiting').toLowerCase();
  const status: 'waiting' | 'starting' | 'playing' | 'finished' =
    rawStatus === 'starting' || rawStatus === 'loading'
      ? 'starting'
      : rawStatus === 'playing' || rawStatus === 'in_progress'
      ? 'playing'
      : rawStatus === 'finished' || rawStatus === 'closed'
      ? 'finished'
      : 'waiting';

  const activeCharacterIds = Array.isArray(roomObj.active_character_ids)
    ? (roomObj.active_character_ids as string[])
    : resolveActiveCharacterIdsForRoom(slots, mode);

  const matchObj =
    raw.match && typeof raw.match === 'object' ? (raw.match as Record<string, unknown>) : null;
  const matchId = String(
    roomObj.match_id ||
      roomObj.matchId ||
      raw.match_id ||
      matchObj?.match_id ||
      (status === 'starting' || status === 'playing' ? `MTC-${roomCode}` : '')
  ).trim();

  const updatedAtMs =
    typeof roomObj.updated_at === 'string'
      ? Date.parse(roomObj.updated_at) || Date.now()
      : typeof roomObj.last_activity_ms === 'number'
      ? roomObj.last_activity_ms
      : Date.now();

  return {
    roomCode,
    matchId: matchId || undefined,
    roomName: String(
      roomObj.room_name || roomObj.roomName || `SEM TERRA FC — ${roomCode}`
    ).trim(),
    mode,
    visibility,
    hasPassword: Boolean(roomObj.has_password),
    passwordHash: null,
    maxHumans,
    autoFillBots: roomObj.auto_fill_bots !== false,
    activeCharacterIds,
    loadingReadyUids:
      Array.isArray(roomObj.loading_ready_uids) && roomObj.loading_ready_uids.length > 0
        ? (roomObj.loading_ready_uids as string[])
        : loadingReadyUids,
    startAt:
      typeof roomObj.start_at === 'number'
        ? roomObj.start_at
        : typeof roomObj.started_at === 'string'
        ? Date.parse(roomObj.started_at) || Date.now()
        : undefined,
    lastActivityMs: updatedAtMs,
    hostUid,
    hostName: resolvedHostName,
    status,
    homeTeamId: String(roomObj.home_team_id || 'unidos_do_barro'),
    awayTeamId: String(roomObj.away_team_id || 'rubro_negro_beco'),
    homeScore:
      typeof roomObj.home_goals === 'number'
        ? roomObj.home_goals
        : typeof matchObj?.home_goals === 'number'
        ? (matchObj.home_goals as number)
        : 0,
    awayScore:
      typeof roomObj.away_goals === 'number'
        ? roomObj.away_goals
        : typeof matchObj?.away_goals === 'number'
        ? (matchObj.away_goals as number)
        : 0,
    half: (roomObj.half as 1 | 2) || 1,
    remainingSeconds:
      typeof roomObj.remaining_seconds === 'number' ? roomObj.remaining_seconds : 180,
    slots,
    matchState: null,
  };
}

export function mapRpcFriendRequestToDoc(raw: Record<string, unknown>): FriendRequestDoc {
  const senderObj =
    raw.sender && typeof raw.sender === 'object'
      ? (raw.sender as Record<string, unknown>)
      : raw.from_user && typeof raw.from_user === 'object'
      ? (raw.from_user as Record<string, unknown>)
      : null;

  const fromUid = String(
    raw.sender_id || raw.from_uid || raw.fromUid || senderObj?.uid || ''
  ).trim();
  const fromName = String(
    raw.sender_name ||
      raw.from_name ||
      raw.fromName ||
      raw.display_name ||
      senderObj?.display_name ||
      (fromUid ? `Craque_${fromUid.slice(0, 4).toUpperCase()}` : 'Jogador')
  ).trim();
  const fromTag = String(
    raw.sender_tag ||
      raw.from_tag ||
      raw.fromTag ||
      raw.tag_code ||
      senderObj?.tag_code ||
      (fromUid ? generateFallbackTagCode(fromUid) : '#STF0000')
  ).trim();

  const toUid = String(raw.receiver_id || raw.to_uid || raw.toUid || '').trim();
  const toName = String(raw.receiver_name || raw.to_name || raw.toName || 'Você').trim();

  const rawStatus = String(raw.status || 'pending').toLowerCase();
  const status: 'pending' | 'accepted' | 'declined' =
    rawStatus === 'accepted'
      ? 'accepted'
      : rawStatus === 'rejected' || rawStatus === 'declined'
      ? 'declined'
      : 'pending';

  return {
    id: String(raw.id || raw.request_id || '').trim(),
    fromUid,
    fromName,
    fromTag,
    toUid,
    toName,
    type: raw.type === 'room_invite' ? 'room_invite' : 'friend_request',
    roomCode: String(raw.room_code || raw.roomCode || ''),
    status,
    createdAt:
      typeof raw.created_at === 'string'
        ? Date.parse(raw.created_at) || Date.now()
        : typeof raw.createdAt === 'number'
        ? raw.createdAt
        : Date.now(),
  };
}

// ============================================================================
// 4. EXECUTOR CENTRALIZADO DE RPCs SUPABASE (COM TOKEN FIREBASE ATUALIZADO)
// ============================================================================

async function invokeSupabaseRpc<T = unknown>(
  rpcName: AvailableSupabaseRpcName,
  args: Record<string, unknown> = {}
): Promise<T> {
  const client = getSupabaseClient();
  if (!client) {
    const cfg = getSupabaseConfig();
    const msg = cfg.configWarning || 'Cliente Supabase não inicializado.';
    throw new GameBackendError(msg, rpcName, 'SUPABASE_NOT_CONFIGURED');
  }

  beginBackendOperation(rpcName);
  try {
    // Garante que o ID token Firebase está atualizado antes da chamada
    await getFreshFirebaseAccessToken();

    const { data, error } = await client.rpc(rpcName, args);
    if (error) {
      const cleanMessage = error.message || `Falha na execução de ${rpcName}`;
      // Se for erro 22P02 de função legada com auth.uid(), não polui lastError global pois o fallback de tabela tratará
      const is22P02 =
        error.code === '22P02' ||
        cleanMessage.includes('22P02') ||
        cleanMessage.toLowerCase().includes('invalid input syntax for type uuid');
      endBackendOperation(is22P02 ? null : cleanMessage);
      throw new GameBackendError(cleanMessage, rpcName, error.code || 'PGRST_ERROR');
    }

    endBackendOperation(null);
    return data as T;
  } catch (err) {
    if (err instanceof GameBackendError) {
      throw err;
    }
    const fallbackMsg =
      err instanceof Error ? err.message : `Erro inesperado ao executar ${rpcName}`;
    endBackendOperation(fallbackMsg);
    throw new GameBackendError(fallbackMsg, rpcName, 'NETWORK_OR_RUNTIME_ERROR');
  }
}

// ============================================================================
// 5. CHAMADAS TIPADAS PARA TODAS AS 14 RPCs DISPONÍVEIS
//    (COM FALLBACK ATÔMICO NAS TABELAS REAIS DO POSTGRESQL EM CASO DE 22P02)
// ============================================================================

/**
 * 5.1. Perfil: `rpc_ensure_user_profile_atomic({ p_display_name })`
 * Cria ou atualiza o perfil do jogador autenticado no Supabase usando o token Firebase (UID TEXT).
 */
export async function rpcEnsureUserProfileAtomic(params: {
  uid: string;
  displayName: string;
}): Promise<OnlineUserProfile & { friends: string[] }> {
  const cleanUid = String(params.uid || getCurrentFirebaseUid() || '').trim();
  const cleanName = (params.displayName || '').trim().slice(0, 28) || 'Jogador da Várzea';

  try {
    const data = await invokeSupabaseRpc<unknown>('rpc_ensure_user_profile_atomic', {
      p_display_name: cleanName,
    });

    const unwrapped = unwrapRpcPayload(data);
    if (unwrapped) {
      return mapRawToUserProfile(unwrapped, cleanUid);
    }
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
  }

  // Lê ou grava diretamente na tabela real `public.users` (uid TEXT) + `public.presences` (user_id TEXT)
  const client = getSupabaseClient();
  if (client && cleanUid) {
    const { data: existingRow } = await client
      .from('users')
      .select('*')
      .eq('uid', cleanUid)
      .maybeSingle();

    if (existingRow) {
      const existingObj = existingRow as Record<string, unknown>;
      const updatedName =
        params.displayName?.trim() ? cleanName : String(existingObj.display_name || cleanName);
      const { data: updatedRow } = await client
        .from('users')
        .update({
          display_name: updatedName,
          status: existingObj.status === 'offline' ? 'online' : existingObj.status || 'online',
          updated_at: new Date().toISOString(),
        })
        .eq('uid', cleanUid)
        .select('*')
        .maybeSingle();

      await client.from('presences').upsert(
        {
          user_id: cleanUid,
          is_online: true,
          last_seen: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );

      return mapRawToUserProfile(
        (updatedRow || existingObj) as Record<string, unknown>,
        cleanUid
      );
    }

    const fallbackTag = generateFallbackTagCode(cleanUid);
    const { data: insertedRow, error: insertError } = await client
      .from('users')
      .upsert(
        {
          uid: cleanUid,
          display_name: cleanName,
          tag_code: fallbackTag,
          status: 'online',
          current_room_code: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'uid' }
      )
      .select('*')
      .maybeSingle();

    if (insertError) {
      throw new GameBackendError(
        insertError.message,
        'rpc_ensure_user_profile_atomic',
        insertError.code || 'UPSERT_USER_ERROR'
      );
    }

    await client.from('presences').upsert(
      {
        user_id: cleanUid,
        is_online: true,
        last_seen: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );

    if (insertedRow) {
      return mapRawToUserProfile(insertedRow as Record<string, unknown>, cleanUid);
    }
  }

  return {
    uid: cleanUid,
    displayName: cleanName,
    tagCode: generateFallbackTagCode(cleanUid),
    status: 'online',
    currentRoomCode: '',
    friends: [],
    wins: 0,
    losses: 0,
    draws: 0,
    goalsScored: 0,
    goalsConceded: 0,
    matchesPlayed: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Busca diretamente nas tabelas `public.rooms` + `public.room_participants` + `public.users` + `public.matches`
 * usando `room_code` (TEXT), `host_id` (TEXT) e `user_id` (TEXT).
 */
async function queryRoomLobbyFromTables(
  normalizedCode: string
): Promise<(MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null> {
  const client = getSupabaseClient();
  if (!client || !normalizedCode) return null;

  const { data: roomRow, error: roomErr } = await client
    .from('rooms')
    .select('*')
    .eq('room_code', normalizedCode)
    .maybeSingle();

  if (roomErr || !roomRow) return null;

  const { data: partRows } = await client
    .from('room_participants')
    .select('*, users(uid, display_name, tag_code, avatar_url)')
    .eq('room_code', normalizedCode);

  const { data: matchRow } = await client
    .from('matches')
    .select('match_id, status, home_goals, away_goals')
    .eq('room_code', normalizedCode)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const rawRoom = roomRow as Record<string, unknown>;
  const mapped = mapRpcRoomToRoomState(
    {
      ...rawRoom,
      match_id: (matchRow as Record<string, unknown> | null)?.match_id || rawRoom.match_id,
      participants: (partRows as Record<string, unknown>[] | null) || [],
    },
    normalizedCode
  );

  if (!mapped.roomCode) return null;
  return {
    ...mapped,
    inputs: {},
  };
}

/**
 * 5.2. Consulta de Sala Individual: `rpc_get_room_lobby({ p_room_code })`
 * Retorna o estado completo da sala e seus participantes convertidos para os slots do jogo.
 */
export async function rpcGetRoomLobby(
  roomCode: string
): Promise<(MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null> {
  const normalizedCode = roomCode.trim().toUpperCase();
  if (!normalizedCode) return null;

  let data: unknown = null;
  try {
    data = await invokeSupabaseRpc<unknown>('rpc_get_room_lobby', {
      p_room_code: normalizedCode,
    });
  } catch (err) {
    if (isUuidSyntaxError22P02(err)) {
      clearGameBackendError();
      return await queryRoomLobbyFromTables(normalizedCode);
    }
    throw err;
  }

  if (!data) return null;

  if (Array.isArray(data) && data.length === 0) {
    return null;
  }

  let roomState: MultiplayerRoomState | null = null;

  if (Array.isArray(data)) {
    const first = data[0] as Record<string, unknown>;
    if ('user_id' in first && !('participants' in first)) {
      roomState = mapRpcRoomToRoomState(
        {
          ...first,
          room_code: first.room_code || normalizedCode,
          participants: data as Record<string, unknown>[],
        },
        normalizedCode
      );
    } else {
      roomState = mapRpcRoomToRoomState(first, normalizedCode);
    }
  } else if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return null;
    roomState = mapRpcRoomToRoomState(obj, normalizedCode);
  }

  if (!roomState || !roomState.roomCode) {
    return null;
  }

  const client = getSupabaseClient();
  const hasHumanInSlots = Object.values(roomState.slots || {}).some(
    (s) => !s.isBot && Boolean(s.uid)
  );
  if (
    client &&
    (!hasHumanInSlots ||
      Object.values(roomState.slots || {}).filter((s) => !s.isBot).length <= 1)
  ) {
    try {
      const { data: partRows } = await client
        .from('room_participants')
        .select('*, users(uid, display_name, tag_code, avatar_url)')
        .eq('room_code', normalizedCode);

      if (partRows && partRows.length > 0) {
        const rebuilt = buildSlotsFromParticipants(
          roomState.hostUid,
          roomState.hostName,
          partRows as unknown as Record<string, unknown>[]
        );
        roomState = {
          ...roomState,
          hostName: rebuilt.resolvedHostName,
          slots: rebuilt.slots,
          loadingReadyUids:
            rebuilt.loadingReadyUids.length > 0
              ? rebuilt.loadingReadyUids
              : roomState.loadingReadyUids,
          activeCharacterIds: resolveActiveCharacterIdsForRoom(rebuilt.slots, roomState.mode),
        };
      }
    } catch {
      // Mantém roomState retornado pela RPC
    }
  }

  return {
    ...roomState,
    inputs: {},
  };
}

/**
 * 5.3. Consulta de Salas Públicas: `rpc_get_public_lobby({})`
 */
export async function rpcGetPublicLobby(): Promise<MultiplayerRoomState[]> {
  try {
    const data = await invokeSupabaseRpc<unknown>('rpc_get_public_lobby', {});
    const items = unwrapRpcArray(data, ['rooms', 'lobby']);
    return items
      .map((item) => mapRpcRoomToRoomState(item))
      .filter((r) => Boolean(r.roomCode) && r.status !== 'finished');
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    if (!client) return [];
    const { data: roomRows } = await client
      .from('rooms')
      .select('*, room_participants(*, users(uid, display_name, tag_code, avatar_url))')
      .eq('visibility', 'public')
      .neq('status', 'finished')
      .order('updated_at', { ascending: false })
      .limit(25);

    if (!roomRows || !Array.isArray(roomRows)) return [];
    return roomRows
      .map((r) => mapRpcRoomToRoomState(r as Record<string, unknown>))
      .filter((r) => Boolean(r.roomCode) && r.status !== 'finished');
  }
}

/**
 * 5.4. Criar Sala: `rpc_create_room_atomic({ p_room_name, p_mode, p_visibility })`
 */
export async function rpcCreateRoomAtomic(params: {
  hostUid: string;
  hostName: string;
  homeTeamId: string;
  awayTeamId: string;
  halfDurationSeconds: number;
  options?: Partial<CreateRoomParams>;
}): Promise<MultiplayerRoomState> {
  const cleanHostUid = String(params.hostUid || getCurrentFirebaseUid() || '').trim();
  const mode: MatchFormatMode = params.options?.mode === '2v2' ? '2v2' : '4v4';
  const visibility: RoomVisibility =
    params.options?.visibility === 'private' ? 'private' : 'public';
  const roomNum = Math.floor(100 + Math.random() * 900);
  const roomName = (
    params.options?.roomName?.trim() || `SEM TERRA FC — SALA #${roomNum}`
  ).slice(0, 48);

  let data: unknown = null;
  let roomCode = '';

  try {
    data = await invokeSupabaseRpc<unknown>('rpc_create_room_atomic', {
      p_room_name: roomName,
      p_mode: mode,
      p_visibility: visibility,
    });

    if (typeof data === 'string') {
      roomCode = data.trim().toUpperCase();
    } else {
      const unwrapped = unwrapRpcPayload(data);
      if (unwrapped) {
        const nestedRoom =
          unwrapped.room && typeof unwrapped.room === 'object'
            ? (unwrapped.room as Record<string, unknown>)
            : unwrapped;
        roomCode = String(
          nestedRoom.room_code || nestedRoom.roomCode || unwrapped.room_code || ''
        )
          .trim()
          .toUpperCase();
      }
    }
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    if (!client || !cleanHostUid) {
      throw err;
    }

    await rpcEnsureUserProfileAtomic({
      uid: cleanHostUid,
      displayName: params.hostName || 'Anfitrião',
    });

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let generatedCode = 'STF-';
    for (let i = 0; i < 4; i++) {
      generatedCode += chars[Math.floor(Math.random() * chars.length)];
    }
    roomCode = generatedCode;
    const maxPlayers = mode === '2v2' ? 4 : 8;
    const preferredChar = normalizeSlotIdFromCharacterId(
      params.options?.preferredCharacterId || 'home_1',
      'home'
    ) || 'home_1';

    await client.from('room_participants').delete().eq('user_id', cleanHostUid);

    const { error: createErr } = await client.from('rooms').insert({
      room_code: roomCode,
      host_id: cleanHostUid,
      room_name: roomName,
      mode,
      visibility,
      status: 'waiting',
      max_players: maxPlayers,
    });
    if (createErr) {
      throw new GameBackendError(createErr.message, 'rpc_create_room_atomic', createErr.code);
    }

    await client.from('room_participants').insert({
      room_code: roomCode,
      user_id: cleanHostUid,
      team: getTeamFromCharacterOrSlot(preferredChar),
      character_id: preferredChar,
      is_ready: true,
      is_loading_ready: false,
    });
  }

  if (roomCode) {
    if (params.options?.preferredCharacterId) {
      try {
        await rpcSelectCharacterAtomic(roomCode, params.options.preferredCharacterId);
      } catch {
        // Mantém personagem padrão da criação caso não aplicável
      }
    }

    const fullLobby = await rpcGetRoomLobby(roomCode);
    if (fullLobby) {
      return {
        ...fullLobby,
        homeTeamId: params.homeTeamId || fullLobby.homeTeamId,
        awayTeamId: params.awayTeamId || fullLobby.awayTeamId,
        remainingSeconds: Math.floor(params.halfDurationSeconds) || fullLobby.remainingSeconds,
      };
    }
  }

  const unwrapped = unwrapRpcPayload(data);
  if (unwrapped) {
    const mapped = mapRpcRoomToRoomState(unwrapped, roomCode);
    if (mapped.roomCode) {
      return {
        ...mapped,
        homeTeamId: params.homeTeamId || mapped.homeTeamId,
        awayTeamId: params.awayTeamId || mapped.awayTeamId,
        remainingSeconds: Math.floor(params.halfDurationSeconds) || mapped.remainingSeconds,
      };
    }
  }

  throw new GameBackendError(
    'O servidor não retornou o código da sala criada.',
    'rpc_create_room_atomic',
    'EMPTY_ROOM_CODE'
  );
}

/**
 * 5.5. Entrar na Sala: `rpc_join_room_atomic({ p_room_code, p_team })`
 */
export async function rpcJoinRoomAtomic(params: {
  roomCode: string;
  team?: 'home' | 'away';
  expectedMode?: MatchFormatMode;
}): Promise<MultiplayerRoomState> {
  const normalizedCode = params.roomCode.trim().toUpperCase();
  if (!normalizedCode) {
    throw new GameBackendError(
      'Informe um código de sala válido.',
      'rpc_join_room_atomic',
      'INVALID_ROOM_CODE'
    );
  }

  const rpcArgs: Record<string, unknown> = {
    p_room_code: normalizedCode,
  };
  if (params.team) {
    rpcArgs.p_team = params.team;
  }

  let data: unknown = null;
  try {
    data = await invokeSupabaseRpc<unknown>('rpc_join_room_atomic', rpcArgs);
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    const currentUid = getCurrentFirebaseUid();
    if (!client || !currentUid) {
      throw err;
    }

    const existingLobby = await queryRoomLobbyFromTables(normalizedCode);
    if (!existingLobby) {
      throw new GameBackendError(
        `Sala ${normalizedCode} não encontrada ou já encerrada.`,
        'rpc_join_room_atomic',
        'ROOM_NOT_FOUND'
      );
    }

    const alreadyIn = Object.values(existingLobby.slots || {}).some(
      (s) => !s.isBot && s.uid === currentUid
    );
    if (!alreadyIn) {
      const freeSlot = Object.values(existingLobby.slots || {}).find((s) => s.isBot);
      if (!freeSlot) {
        throw new GameBackendError(
          `A sala ${normalizedCode} está lotada.`,
          'rpc_join_room_atomic',
          'ROOM_FULL'
        );
      }
      await client.from('room_participants').insert({
        room_code: normalizedCode,
        user_id: currentUid,
        team: freeSlot.team,
        character_id: freeSlot.characterId,
        is_ready: false,
        is_loading_ready: false,
      });
    }
  }

  const fullLobby = await rpcGetRoomLobby(normalizedCode);
  if (fullLobby) {
    return fullLobby;
  }

  const unwrapped = unwrapRpcPayload(data);
  if (unwrapped) {
    const mapped = mapRpcRoomToRoomState(unwrapped, normalizedCode);
    if (mapped.roomCode) {
      return mapped;
    }
  }

  throw new GameBackendError(
    `Não foi possível carregar os dados da sala ${normalizedCode} após entrar.`,
    'rpc_join_room_atomic',
    'ROOM_LOAD_FAILED'
  );
}

/**
 * 5.6. Sair da Sala: `rpc_leave_room_atomic({ p_room_code })`
 */
export async function rpcLeaveRoomAtomic(roomCode: string): Promise<void> {
  const normalizedCode = roomCode.trim().toUpperCase();
  if (!normalizedCode) return;

  try {
    await invokeSupabaseRpc<unknown>('rpc_leave_room_atomic', {
      p_room_code: normalizedCode,
    });
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    const currentUid = getCurrentFirebaseUid();
    if (client && currentUid) {
      await client
        .from('room_participants')
        .delete()
        .eq('room_code', normalizedCode)
        .eq('user_id', currentUid);
    }
  }
}

/**
 * 5.7. Escolher Personagem: `rpc_select_character_atomic({ p_room_code, p_character_id })`
 */
export async function rpcSelectCharacterAtomic(
  roomCode: string,
  characterId: string
): Promise<MultiplayerRoomState | null> {
  const normalizedCode = roomCode.trim().toUpperCase();
  const cleanCharId = characterId.trim();
  if (!normalizedCode || !cleanCharId) {
    throw new GameBackendError(
      'Sala e personagem são obrigatórios.',
      'rpc_select_character_atomic',
      'INVALID_ARGS'
    );
  }

  try {
    await invokeSupabaseRpc<unknown>('rpc_select_character_atomic', {
      p_room_code: normalizedCode,
      p_character_id: cleanCharId,
    });
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    const currentUid = getCurrentFirebaseUid();
    const slotId = normalizeSlotIdFromCharacterId(cleanCharId) || cleanCharId;
    if (client && currentUid) {
      await client
        .from('room_participants')
        .update({
          character_id: slotId,
          team: getTeamFromCharacterOrSlot(slotId),
        })
        .eq('room_code', normalizedCode)
        .eq('user_id', currentUid);
    }
  }

  return await rpcGetRoomLobby(normalizedCode);
}

/**
 * 5.8. Alternar Botão Pronto: `rpc_toggle_ready_atomic({ p_room_code, p_is_ready })`
 */
export async function rpcToggleReadyAtomic(
  roomCode: string,
  isReady: boolean
): Promise<MultiplayerRoomState | null> {
  const normalizedCode = roomCode.trim().toUpperCase();
  if (!normalizedCode) {
    throw new GameBackendError(
      'Código da sala inválido.',
      'rpc_toggle_ready_atomic',
      'INVALID_ROOM_CODE'
    );
  }

  try {
    await invokeSupabaseRpc<unknown>('rpc_toggle_ready_atomic', {
      p_room_code: normalizedCode,
      p_is_ready: Boolean(isReady),
    });
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    const currentUid = getCurrentFirebaseUid();
    if (client && currentUid) {
      await client
        .from('room_participants')
        .update({ is_ready: Boolean(isReady) })
        .eq('room_code', normalizedCode)
        .eq('user_id', currentUid);
    }
  }

  return await rpcGetRoomLobby(normalizedCode);
}

/**
 * 5.9. Iniciar Partida: `rpc_start_match_atomic({ p_room_code })`
 */
export async function rpcStartMatchAtomic(roomCode: string): Promise<{
  matchId: string;
  room: MultiplayerRoomState | null;
}> {
  const normalizedCode = roomCode.trim().toUpperCase();
  if (!normalizedCode) {
    throw new GameBackendError(
      'Código da sala inválido para iniciar partida.',
      'rpc_start_match_atomic',
      'INVALID_ROOM_CODE'
    );
  }

  let matchId = '';
  try {
    const data = await invokeSupabaseRpc<unknown>('rpc_start_match_atomic', {
      p_room_code: normalizedCode,
    });

    if (typeof data === 'string' && data.trim()) {
      matchId = data.trim();
    } else {
      const unwrapped = unwrapRpcPayload(data);
      if (unwrapped) {
        matchId = String(
          unwrapped.match_id ||
            unwrapped.matchId ||
            unwrapped.id ||
            (unwrapped.match && typeof unwrapped.match === 'object'
              ? (unwrapped.match as Record<string, unknown>).match_id || ''
              : '')
        ).trim();
      }
    }
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    if (client) {
      const { data: matchRow } = await client
        .from('matches')
        .insert({
          room_code: normalizedCode,
          status: 'starting',
          home_goals: 0,
          away_goals: 0,
          started_at: new Date().toISOString(),
        })
        .select('match_id')
        .maybeSingle();

      if (matchRow && typeof (matchRow as Record<string, unknown>).match_id === 'string') {
        matchId = String((matchRow as Record<string, unknown>).match_id);
      }

      await client
        .from('rooms')
        .update({ status: 'starting', updated_at: new Date().toISOString() })
        .eq('room_code', normalizedCode);
    }
  }

  const room = await rpcGetRoomLobby(normalizedCode);
  const resolvedMatchId = matchId || room?.matchId || `MTC-${normalizedCode}`;

  return {
    matchId: resolvedMatchId,
    room: room
      ? {
          ...room,
          matchId: resolvedMatchId,
          status: room.status === 'waiting' ? 'starting' : room.status,
        }
      : null,
  };
}

/**
 * 5.10. Enviar Solicitação de Amizade: `rpc_send_friend_request({ p_receiver_tag })`
 */
export async function rpcSendFriendRequest(
  receiverTag: string
): Promise<{ ok: boolean; message: string }> {
  const raw = receiverTag.trim();
  if (!raw) {
    return { ok: false, message: 'Digite a Tag (#STF...) do jogador.' };
  }

  const formattedTag = raw.startsWith('#') ? raw.toUpperCase() : `#${raw.toUpperCase()}`;

  try {
    const data = await invokeSupabaseRpc<unknown>('rpc_send_friend_request', {
      p_receiver_tag: formattedTag,
    });
    const unwrapped = unwrapRpcPayload(data);
    const serverMsg =
      unwrapped && typeof unwrapped.message === 'string'
        ? unwrapped.message
        : `Solicitação de amizade enviada para ${formattedTag}!`;
    return { ok: true, message: serverMsg };
  } catch (err) {
    if (isUuidSyntaxError22P02(err)) {
      clearGameBackendError();
      const client = getSupabaseClient();
      const senderUid = getCurrentFirebaseUid();
      if (client && senderUid) {
        const { data: targetUser } = await client
          .from('users')
          .select('uid, display_name, tag_code')
          .ilike('tag_code', formattedTag)
          .maybeSingle();

        const targetObj = targetUser as Record<string, unknown> | null;
        if (!targetObj || !targetObj.uid) {
          return { ok: false, message: `Nenhum jogador encontrado com a Tag ${formattedTag}.` };
        }
        const receiverUid = String(targetObj.uid);
        if (receiverUid === senderUid) {
          return { ok: false, message: 'Você não pode adicionar a si mesmo.' };
        }

        const { error: reqErr } = await client.from('friend_requests').insert({
          sender_id: senderUid,
          receiver_id: receiverUid,
          status: 'pending',
        });
        if (!reqErr) {
          return {
            ok: true,
            message: `Solicitação de amizade enviada para ${targetObj.display_name || formattedTag}!`,
          };
        }
      }
    }
    const msg =
      err instanceof Error ? err.message : 'Não foi possível enviar a solicitação de amizade.';
    return { ok: false, message: msg };
  }
}

/**
 * 5.11. Responder Solicitação de Amizade: `rpc_respond_friend_request({ p_request_id, p_accept })`
 * Nota: `p_request_id` exige UUID (`friend_requests.id`), enquanto `sender_id` e `receiver_id` são TEXT (UID Firebase).
 */
export async function rpcRespondFriendRequest(
  requestId: string,
  accept: boolean
): Promise<void> {
  let cleanId = requestId.trim();
  if (!cleanId) {
    throw new GameBackendError(
      'ID da solicitação de amizade inválido.',
      'rpc_respond_friend_request',
      'INVALID_REQUEST_ID'
    );
  }

  // Se `cleanId` não for um UUID válido (por exemplo, se recebeu um UID Firebase `sender_id` TEXT),
  // resolve o UUID real `friend_requests.id` antes de invocar a RPC para jamais causar 22P02.
  if (!isValidUuid(cleanId)) {
    const client = getSupabaseClient();
    const currentUid = getCurrentFirebaseUid();
    if (client && currentUid) {
      const { data: foundReq } = await client
        .from('friend_requests')
        .select('id')
        .eq('receiver_id', currentUid)
        .eq('sender_id', cleanId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const resolvedUuid = (foundReq as Record<string, unknown> | null)?.id;
      if (typeof resolvedUuid === 'string' && isValidUuid(resolvedUuid)) {
        cleanId = resolvedUuid.trim();
      } else {
        throw new GameBackendError(
          'Solicitação de amizade pendente não localizada ou ID não é um UUID válido.',
          'rpc_respond_friend_request',
          'INVALID_REQUEST_UUID'
        );
      }
    }
  }

  try {
    await invokeSupabaseRpc<unknown>('rpc_respond_friend_request', {
      p_request_id: cleanId,
      p_accept: Boolean(accept),
    });
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    if (!client) throw err;

    const { data: reqRow } = await client
      .from('friend_requests')
      .select('id, sender_id, receiver_id')
      .eq('id', cleanId)
      .maybeSingle();

    const reqObj = reqRow as Record<string, unknown> | null;
    if (!reqObj) return;

    await client
      .from('friend_requests')
      .update({
        status: accept ? 'accepted' : 'rejected',
        updated_at: new Date().toISOString(),
      })
      .eq('id', cleanId);

    if (accept && reqObj.sender_id && reqObj.receiver_id) {
      const sUid = String(reqObj.sender_id);
      const rUid = String(reqObj.receiver_id);
      const [u1, u2] = sUid < rUid ? [sUid, rUid] : [rUid, sUid];
      await client.from('friendships').insert({
        user_id_1: u1,
        user_id_2: u2,
      });
    }
  }
}

/**
 * 5.12. Remover Amigo: `rpc_remove_friend({ p_friend_tag })`
 */
export async function rpcRemoveFriend(friendTag: string): Promise<void> {
  const cleanTag = friendTag.trim();
  if (!cleanTag) {
    throw new GameBackendError(
      'Informe a Tag do amigo para remover.',
      'rpc_remove_friend',
      'INVALID_FRIEND_TAG'
    );
  }

  const formattedTag = cleanTag.startsWith('#')
    ? cleanTag.toUpperCase()
    : `#${cleanTag.toUpperCase()}`;

  try {
    await invokeSupabaseRpc<unknown>('rpc_remove_friend', {
      p_friend_tag: formattedTag,
    });
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    const currentUid = getCurrentFirebaseUid();
    if (client && currentUid) {
      const { data: friendRow } = await client
        .from('users')
        .select('uid')
        .ilike('tag_code', formattedTag)
        .maybeSingle();
      const friendUid = (friendRow as Record<string, unknown> | null)?.uid;
      if (typeof friendUid === 'string' && friendUid) {
        await client
          .from('friendships')
          .delete()
          .or(
            `and(user_id_1.eq.${currentUid},user_id_2.eq.${friendUid}),and(user_id_1.eq.${friendUid},user_id_2.eq.${currentUid})`
          );
      }
    }
  }
}

/**
 * 5.13. Consultar Meus Amigos: `rpc_get_my_friends({})`
 */
export async function rpcGetMyFriends(): Promise<OnlineUserProfile[]> {
  try {
    const data = await invokeSupabaseRpc<unknown>('rpc_get_my_friends', {});
    const items = unwrapRpcArray(data, ['friends', 'users']);
    return items
      .map((item) => mapRawToUserProfile(item))
      .filter((f) => Boolean(f.uid || f.tagCode));
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    const currentUid = getCurrentFirebaseUid();
    if (!client || !currentUid) return [];

    const { data: fRows } = await client
      .from('friendships')
      .select('user_id_1, user_id_2')
      .or(`user_id_1.eq.${currentUid},user_id_2.eq.${currentUid}`);

    if (!fRows || !Array.isArray(fRows) || fRows.length === 0) return [];
    const friendUids = Array.from(
      new Set(
        fRows
          .map((r) => {
            const row = r as Record<string, unknown>;
            return row.user_id_1 === currentUid
              ? String(row.user_id_2 || '')
              : String(row.user_id_1 || '');
          })
          .filter(Boolean)
      )
    );
    if (friendUids.length === 0) return [];

    const { data: userRows } = await client
      .from('users')
      .select('*')
      .in('uid', friendUids);

    if (!userRows || !Array.isArray(userRows)) return [];
    return userRows.map((u) => mapRawToUserProfile(u as Record<string, unknown>));
  }
}

/**
 * 5.14. Consultar Solicitações de Amizade: `rpc_get_friend_requests({})`
 */
export async function rpcGetFriendRequests(): Promise<FriendRequestDoc[]> {
  try {
    const data = await invokeSupabaseRpc<unknown>('rpc_get_friend_requests', {});
    const items = unwrapRpcArray(data, ['requests', 'friend_requests']);
    return items
      .map((item) => mapRpcFriendRequestToDoc(item))
      .filter((req) => Boolean(req.id) && req.status === 'pending');
  } catch (err) {
    if (!isUuidSyntaxError22P02(err)) {
      throw err;
    }
    clearGameBackendError();
    const client = getSupabaseClient();
    const currentUid = getCurrentFirebaseUid();
    if (!client || !currentUid) return [];

    const { data: reqRows } = await client
      .from('friend_requests')
      .select('*, sender:users!friend_requests_sender_id_fkey(uid, display_name, tag_code)')
      .eq('receiver_id', currentUid)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (!reqRows || !Array.isArray(reqRows)) return [];
    return reqRows
      .map((item) => mapRpcFriendRequestToDoc(item as Record<string, unknown>))
      .filter((req) => Boolean(req.id) && req.status === 'pending');
  }
}

// ============================================================================
// 6. ASSINATURAS SUPABASE REALTIME COM MULTIPLEXAÇÃO E LIMPEZA AUTOMÁTICA
// ============================================================================

/**
 * Acompanha a lista de salas públicas em tempo real usando `rpc_get_public_lobby`
 * combinado com Supabase Realtime na tabela `public.rooms` e `public.room_participants`.
 */
export function subscribeToPublicLobbyRealtime(
  cb: (rooms: MultiplayerRoomState[]) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) {
    cb([]);
    return () => {};
  }

  let active = true;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const refreshPublicLobby = async () => {
    if (!active) return;
    try {
      const rooms = await rpcGetPublicLobby();
      if (active) {
        cb(rooms);
      }
    } catch {
      // Silencia erro transitório de rede durante reconexão ou login inicial
    }
  };

  const scheduleRefresh = () => {
    if (!active) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void refreshPublicLobby();
    }, 250);
  };

  void refreshPublicLobby();

  const channelName = `stf_public_lobby_${Math.random().toString(36).slice(2, 8)}`;
  let channel: RealtimeChannel | null = null;
  try {
    channel = client
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms' },
        scheduleRefresh
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'room_participants' },
        scheduleRefresh
      )
      .subscribe();
  } catch {
    channel = null;
  }

  // Sincronização periódica leve (10s) para garantir atualização mesmo quando WebSocket Realtime estiver reconectando
  const pollTimer = setInterval(() => {
    if (!active) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refreshPublicLobby();
  }, 10_000);

  return () => {
    active = false;
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(pollTimer);
    if (channel) {
      void client.removeChannel(channel);
    }
  };
}

/**
 * Acompanha o estado de uma sala específica e seus participantes em tempo real usando
 * `rpc_get_room_lobby` + Supabase Realtime em `rooms`, `room_participants` e `matches`.
 */
export function subscribeToRoomLobbyRealtime(
  roomCode: string,
  cb: (room: (MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null) => void
): () => void {
  const client = getSupabaseClient();
  const normalizedCode = roomCode.trim().toUpperCase();
  if (!client || !normalizedCode) {
    cb(null);
    return () => {};
  }

  let active = true;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const refreshRoom = async () => {
    if (!active) return;
    try {
      const room = await rpcGetRoomLobby(normalizedCode);
      if (active) {
        cb(room);
      }
    } catch {
      // Evita derrubar a sala ativa em caso de oscilação momentânea de rede
    }
  };

  const scheduleRefresh = () => {
    if (!active) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void refreshRoom();
    }, 180);
  };

  void refreshRoom();

  const channelName = `stf_room_${normalizedCode}_${Math.random().toString(36).slice(2, 8)}`;
  let channel: RealtimeChannel | null = null;
  try {
    channel = client
      .channel(channelName)
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
          scheduleRefresh();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_participants',
          filter: `room_code=eq.${normalizedCode}`,
        },
        scheduleRefresh
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'matches',
          filter: `room_code=eq.${normalizedCode}`,
        },
        scheduleRefresh
      )
      .subscribe();
  } catch {
    channel = null;
  }

  // Sincronização de segurança (3.5s) para propagar prontidão, escolha de personagem e início da partida
  const pollTimer = setInterval(() => {
    if (!active) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refreshRoom();
  }, 3500);

  return () => {
    active = false;
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(pollTimer);
    if (channel) {
      void client.removeChannel(channel);
    }
  };
}

/**
 * Acompanha a lista de amigos (`rpc_get_my_friends`) em tempo real via Supabase Realtime.
 */
export function subscribeToMyFriendsRealtime(
  cb: (friends: OnlineUserProfile[]) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) {
    cb([]);
    return () => {};
  }

  let active = true;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const refreshFriends = async () => {
    if (!active) return;
    try {
      const friends = await rpcGetMyFriends();
      if (active) {
        cb(friends);
      }
    } catch {
      // Ignora erro transitório antes do login completar
    }
  };

  const scheduleRefresh = () => {
    if (!active) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void refreshFriends();
    }, 300);
  };

  void refreshFriends();

  const channelName = `stf_my_friends_${Math.random().toString(36).slice(2, 8)}`;
  let channel: RealtimeChannel | null = null;
  try {
    channel = client
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friendships' },
        scheduleRefresh
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'presences' },
        scheduleRefresh
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'users' },
        scheduleRefresh
      )
      .subscribe();
  } catch {
    channel = null;
  }

  const pollTimer = setInterval(() => {
    if (!active) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refreshFriends();
  }, 12_000);

  return () => {
    active = false;
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(pollTimer);
    if (channel) {
      void client.removeChannel(channel);
    }
  };
}

/**
 * Acompanha as solicitações de amizade pendentes (`rpc_get_friend_requests`) em tempo real.
 */
export function subscribeToFriendRequestsRealtime(
  uid: string,
  cb: (requests: FriendRequestDoc[]) => void
): () => void {
  const client = getSupabaseClient();
  if (!client || !uid) {
    cb([]);
    return () => {};
  }

  let active = true;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const refreshRequests = async () => {
    if (!active) return;
    try {
      const requests = await rpcGetFriendRequests();
      if (active) {
        cb(requests);
      }
    } catch {
      // Ignora erro transitório antes do login completar
    }
  };

  const scheduleRefresh = () => {
    if (!active) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void refreshRequests();
    }, 250);
  };

  void refreshRequests();

  const channelName = `stf_friend_reqs_${uid}_${Math.random().toString(36).slice(2, 8)}`;
  let channel: RealtimeChannel | null = null;
  try {
    channel = client
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'friend_requests',
          filter: `receiver_id=eq.${uid}`,
        },
        scheduleRefresh
      )
      .subscribe();
  } catch {
    channel = null;
  }

  const pollTimer = setInterval(() => {
    if (!active) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refreshRequests();
  }, 10_000);

  return () => {
    active = false;
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(pollTimer);
    if (channel) {
      void client.removeChannel(channel);
    }
  };
}

/**
 * Acompanha o próprio perfil do jogador autenticado em `public.users` + `rpc_get_my_friends`.
 */
export function subscribeToMyProfileRealtime(
  uid: string,
  fallbackDisplayName: string,
  cb: (profile: (OnlineUserProfile & { friends: string[] }) | null) => void
): () => void {
  const client = getSupabaseClient();
  if (!client || !uid) {
    cb(null);
    return () => {};
  }

  let active = true;
  let latestProfile: (OnlineUserProfile & { friends: string[] }) | null = null;

  const fetchProfileAndFriends = async () => {
    if (!active) return;
    try {
      const { data: userRow } = await client
        .from('users')
        .select('*')
        .eq('uid', uid)
        .maybeSingle();

      let baseProfile: OnlineUserProfile & { friends: string[] };
      if (userRow) {
        baseProfile = mapRawToUserProfile(userRow as Record<string, unknown>, uid);
      } else {
        baseProfile = await rpcEnsureUserProfileAtomic({
          uid,
          displayName: fallbackDisplayName || 'Jogador',
        });
      }

      try {
        const myFriends = await rpcGetMyFriends();
        baseProfile.friends = myFriends.map((f) => f.uid).filter(Boolean);
      } catch {
        // Mantém lista de amigos anterior caso rpc_get_my_friends falhe momentaneamente
        if (latestProfile) {
          baseProfile.friends = latestProfile.friends;
        }
      }

      latestProfile = baseProfile;
      if (active) {
        cb(baseProfile);
      }
    } catch {
      // Silencia erro transitório
    }
  };

  void fetchProfileAndFriends();

  const channelName = `stf_my_profile_${uid}_${Math.random().toString(36).slice(2, 8)}`;
  let channel: RealtimeChannel | null = null;
  try {
    channel = client
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'users',
          filter: `uid=eq.${uid}`,
        },
        () => {
          if (active) void fetchProfileAndFriends();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'friendships',
        },
        () => {
          if (active) void fetchProfileAndFriends();
        }
      )
      .subscribe();
  } catch {
    channel = null;
  }

  return () => {
    active = false;
    if (channel) {
      void client.removeChannel(channel);
    }
  };
}

/**
 * Acompanha jogadores online em `public.users` + `public.presences`.
 */
export function subscribeToOnlinePlayersRealtime(
  cb: (players: OnlineUserProfile[]) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) {
    cb([]);
    return () => {};
  }

  let active = true;
  const fetchOnlinePlayers = async () => {
    if (!active) return;
    try {
      const { data } = await client
        .from('users')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(20);
      if (!active || !data) return;
      cb(data.map((r) => mapRawToUserProfile(r as Record<string, unknown>)));
    } catch {
      // Ignora erro transitório se RLS restringir listagem geral de users
    }
  };

  void fetchOnlinePlayers();

  const channelName = `stf_online_players_${Math.random().toString(36).slice(2, 8)}`;
  let channel: RealtimeChannel | null = null;
  try {
    channel = client
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'users' },
        () => {
          if (active) void fetchOnlinePlayers();
        }
      )
      .subscribe();
  } catch {
    channel = null;
  }

  return () => {
    active = false;
    if (channel) {
      void client.removeChannel(channel);
    }
  };
}
