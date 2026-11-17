import {
  MatchFormatMode,
  MultiplayerRoomState,
  OnlineUserProfile,
  UserPresenceStatus,
} from '../types/game';
import type { ClientInputState, FriendRequestDoc } from './firebase';
import {
  broadcastRoomSyncEvent,
  clearGameBackendError,
  getGameBackendState,
  mapRawToUserProfile,
  mapRpcRoomToRoomState,
  normalizeUserStatus,
  rpcCreateRoomAtomic,
  rpcEnsureUserProfileAtomic,
  rpcGetFriendRequests,
  rpcGetMyFriends,
  rpcGetPublicLobby,
  rpcGetRoomLobby,
  rpcJoinRoomAtomic,
  rpcLeaveRoomAtomic,
  rpcRemoveFriend,
  rpcRespondFriendRequest,
  rpcSelectCharacterAtomic,
  rpcSendFriendRequest,
  rpcStartMatchAtomic,
  rpcToggleReadyAtomic,
  subscribeToFriendRequestsRealtime,
  subscribeToGameBackendState,
  subscribeToMyFriendsRealtime,
  subscribeToMyProfileRealtime,
  subscribeToOnlinePlayersRealtime,
  subscribeToPublicLobbyRealtime,
  subscribeToRoomLobbyRealtime,
} from './gameBackend';
import { CreateRoomParams } from './roomService';
import { getSupabaseClient, getSupabaseConfig } from './supabaseClient';

export {
  clearGameBackendError,
  getGameBackendState,
  rpcCreateRoomAtomic,
  rpcEnsureUserProfileAtomic,
  rpcGetFriendRequests,
  rpcGetMyFriends,
  rpcGetPublicLobby,
  rpcGetRoomLobby,
  rpcJoinRoomAtomic,
  rpcLeaveRoomAtomic,
  rpcRemoveFriend,
  rpcRespondFriendRequest,
  rpcSelectCharacterAtomic,
  rpcSendFriendRequest,
  rpcStartMatchAtomic,
  rpcToggleReadyAtomic,
  subscribeToGameBackendState,
};

export interface SupabaseBackendDiagnostics {
  configured: boolean;
  schemaReady: boolean;
  activeBackend: 'supabase' | 'firestore_fallback';
  urlHost: string | null;
  lastError: string | null;
}

export const SAFE_ROOM_SELECT_COLUMNS =
  'room_code, host_id, room_name, mode, visibility, status, max_players, created_at, updated_at';

export function mapSupabaseRowToUserProfile(
  row: Record<string, unknown>
): OnlineUserProfile & { friends: string[] } {
  return mapRawToUserProfile(row);
}

export function mapSupabaseRowToRoomState(row: Record<string, unknown>): MultiplayerRoomState {
  return mapRpcRoomToRoomState(row);
}

export async function isSupabaseReady(): Promise<boolean> {
  const client = getSupabaseClient();
  const cfg = getSupabaseConfig();
  return Boolean(client && cfg.isConfigured);
}

export function getSupabaseDiagnostics(): SupabaseBackendDiagnostics {
  const cfg = getSupabaseConfig();
  const state = getGameBackendState();
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
    schemaReady: cfg.isConfigured,
    activeBackend: cfg.isConfigured ? 'supabase' : 'firestore_fallback',
    urlHost,
    lastError: state.lastError || cfg.configWarning,
  };
}

export async function ensureSupabaseUserProfile(params: {
  uid: string;
  defaultDisplayName: string;
  preferredNickname?: string;
  firestoreLegacyData?: Record<string, unknown> | null;
}): Promise<(OnlineUserProfile & { friends: string[] }) | null> {
  const { uid, defaultDisplayName, preferredNickname } = params;
  const displayName = (preferredNickname?.trim() || defaultDisplayName || 'Jogador').slice(0, 28);
  return await rpcEnsureUserProfileAtomic({
    uid,
    displayName,
  });
}

export async function updateSupabaseUserPresence(
  uid: string,
  status: UserPresenceStatus | 'playing',
  roomCode: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !uid) return false;

  const cleanRoomCode = roomCode ? roomCode.trim().toUpperCase() : '';
  const safeStatus: UserPresenceStatus = normalizeUserStatus(status, Boolean(cleanRoomCode));

  try {
    await client
      .from('presences')
      .upsert(
        {
          user_id: uid,
          is_online: safeStatus !== 'offline',
          last_seen: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );

    await client
      .from('users')
      .update({
        status: safeStatus,
        current_room_code: safeStatus === 'online' || safeStatus === 'offline' ? null : cleanRoomCode || null,
        updated_at: new Date().toISOString(),
      })
      .eq('uid', uid);

    return true;
  } catch {
    return false;
  }
}

export function subscribeToSupabaseUserProfile(
  uid: string,
  cb: (profile: (OnlineUserProfile & { friends: string[] }) | null) => void,
  fallbackDisplayName = 'Jogador'
): () => void {
  return subscribeToMyProfileRealtime(uid, fallbackDisplayName, cb);
}

export function subscribeToSupabaseOnlinePlayers(
  cb: (players: OnlineUserProfile[]) => void
): () => void {
  return subscribeToOnlinePlayersRealtime(cb);
}

export async function sendSupabaseFriendRequestByTag(
  _fromUid: string,
  _fromName: string,
  _fromTag: string,
  targetTagOrName: string
): Promise<{ ok: boolean; message: string }> {
  return await rpcSendFriendRequest(targetTagOrName);
}

export async function sendSupabaseRoomInvite(
  _fromUid: string,
  _fromName: string,
  _fromTag: string,
  _friendUid: string,
  friendName: string,
  roomCode: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;
  try {
    const channel = client.channel(`stf_room_invites_${roomCode.trim().toUpperCase()}`);
    await channel.send({
      type: 'broadcast',
      event: 'room_invite',
      payload: {
        friendName,
        roomCode: roomCode.trim().toUpperCase(),
        sentAt: Date.now(),
      },
    });
    void client.removeChannel(channel);
    return true;
  } catch {
    return false;
  }
}

export async function respondToSupabaseFriendRequest(
  _uid: string,
  request: FriendRequestDoc,
  accept: boolean
): Promise<boolean> {
  await rpcRespondFriendRequest(request.id, accept);
  return true;
}

export async function removeSupabaseFriend(friendTag: string): Promise<boolean> {
  await rpcRemoveFriend(friendTag);
  return true;
}

export function subscribeToSupabaseIncomingRequests(
  uid: string,
  cb: (requests: FriendRequestDoc[]) => void
): () => void {
  return subscribeToFriendRequestsRealtime(uid, cb);
}

export function subscribeToSupabaseFriendsProfiles(
  _friendUids: string[],
  cb: (friends: OnlineUserProfile[]) => void
): () => void {
  return subscribeToMyFriendsRealtime(cb);
}

export async function createSupabaseOnlineRoom(params: {
  hostUid: string;
  hostName: string;
  homeTeamId: string;
  awayTeamId: string;
  halfDurationSeconds: number;
  options?: Partial<CreateRoomParams>;
}): Promise<MultiplayerRoomState> {
  return await rpcCreateRoomAtomic(params);
}

export async function joinSupabaseOnlineRoom(params: {
  roomCode: string;
  uid: string;
  displayName: string;
  passwordInput?: string;
  expectedMode?: MatchFormatMode;
  team?: 'home' | 'away';
}): Promise<MultiplayerRoomState> {
  return await rpcJoinRoomAtomic({
    roomCode: params.roomCode,
    team: params.team,
    expectedMode: params.expectedMode,
  });
}

export async function toggleSupabasePlayerReady(
  roomCode: string,
  _uid: string,
  ready: boolean
): Promise<MultiplayerRoomState | null> {
  return await rpcToggleReadyAtomic(roomCode, ready);
}

export async function leaveSupabaseOnlineRoom(
  roomCode: string,
  _uid: string
): Promise<boolean> {
  await rpcLeaveRoomAtomic(roomCode);
  return true;
}

export async function selectSupabaseRoomCharacter(
  roomCode: string,
  _uid: string,
  _displayName: string,
  targetCharacterId: string
): Promise<{ ok: boolean; message?: string; room?: MultiplayerRoomState | null }> {
  try {
    const room = await rpcSelectCharacterAtomic(roomCode, targetCharacterId);
    return { ok: true, room };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Não foi possível selecionar o personagem.',
    };
  }
}

export async function startSupabaseOnlineMatch(
  roomCode: string,
  _uid: string
): Promise<{ matchId: string; room: MultiplayerRoomState | null }> {
  return await rpcStartMatchAtomic(roomCode);
}

export async function markSupabasePlayerMatchLoadingReady(
  roomCode: string,
  uid: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !roomCode || !uid) return false;
  try {
    const normalizedCode = roomCode.trim().toUpperCase();
    const { error } = await client
      .from('room_participants')
      .update({ is_loading_ready: true })
      .eq('room_code', normalizedCode)
      .eq('user_id', uid);
    return !error;
  } catch {
    return false;
  }
}

export async function promoteSupabaseRoomToPlaying(
  roomCode: string,
  _uid: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !roomCode) return false;
  try {
    const normalizedCode = roomCode.trim().toUpperCase();
    const { error } = await client
      .from('rooms')
      .update({ status: 'playing', updated_at: new Date().toISOString() })
      .eq('room_code', normalizedCode);
    return !error;
  } catch {
    return false;
  }
}

export function subscribeToSupabaseRoom(
  roomCode: string,
  cb: (room: (MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null) => void
): () => void {
  return subscribeToRoomLobbyRealtime(roomCode, cb);
}

export function subscribeToSupabasePublicRooms(
  cb: (rooms: MultiplayerRoomState[]) => void
): () => void {
  return subscribeToPublicLobbyRealtime(cb);
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
  const cleanUid = String(params.uid || '').trim();
  if (!client || !params.roomCode || !cleanUid) return false;

  try {
    const normalizedCode = params.roomCode.trim().toUpperCase();
    const { data: matchRow } = await client
      .from('matches')
      .select('match_id')
      .eq('room_code', normalizedCode)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const rawMatchId = (matchRow as Record<string, unknown> | null)?.match_id;
    const matchUuid = typeof rawMatchId === 'string' ? rawMatchId.trim() : '';

    // `matches.match_id` e `match_history.match_id` são UUID no banco, enquanto `match_history.user_id` é TEXT (UID Firebase)
    if (matchUuid && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(matchUuid)) {
      await client
        .from('matches')
        .update({
          status: 'finished',
          home_goals: Math.max(0, Math.floor(params.homeGoals)),
          away_goals: Math.max(0, Math.floor(params.awayGoals)),
          finished_at: new Date().toISOString(),
        })
        .eq('match_id', matchUuid);

      const myGoals = params.myTeam === 'home' ? params.homeGoals : params.awayGoals;
      const oppGoals = params.myTeam === 'home' ? params.awayGoals : params.homeGoals;
      const result = myGoals > oppGoals ? 'win' : myGoals < oppGoals ? 'loss' : 'draw';

      await client.from('match_history').insert({
        match_id: matchUuid,
        user_id: cleanUid,
        team: params.myTeam,
        goals: Math.max(0, Math.floor(myGoals)),
        result,
      });
    }
    return true;
  } catch {
    return false;
  }
}
