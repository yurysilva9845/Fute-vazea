import { MatchFormatMode, MultiplayerRoomState } from '../types/game';
import { getRoomParticipantCounts } from './botService';
import { createOnlineRoom, joinOnlineRoom, subscribeToPublicRooms } from './firebase';
import { isRoomJoinable } from './roomService';

export { subscribeToPublicRooms };

/**
 * Filtra salas públicas disponíveis respeitando isolamento estrito entre 2v2 e 4v4.
 */
export function filterRoomsByMode(
  rooms: MultiplayerRoomState[],
  modeFilter: MatchFormatMode | 'all' = 'all'
): MultiplayerRoomState[] {
  return rooms.filter((room) => {
    if (room.status === 'finished') return false;
    const roomMode: MatchFormatMode = room.mode === '2v2' ? '2v2' : '4v4';
    if (modeFilter !== 'all' && roomMode !== modeFilter) {
      return false;
    }
    return true;
  });
}

/**
 * Encontra rapidamente uma sala pública disponível da modalidade escolhida (2v2 ou 4v4),
 * ou cria uma nova sala com bots automáticos caso não haja nenhuma vaga aberta.
 */
export async function quickMatchOrCreateWithBots(
  availableRooms: MultiplayerRoomState[],
  mode: MatchFormatMode,
  homeTeamId: string = 'unidos_do_barro',
  awayTeamId: string = 'rubro_negro_beco',
  halfDurationSeconds: number = 150
): Promise<{ room: MultiplayerRoomState; createdNew: boolean }> {
  const matchingOpenRooms = availableRooms.filter((r) => {
    const rMode: MatchFormatMode = r.mode === '2v2' ? '2v2' : '4v4';
    if (rMode !== mode) return false;
    if (r.visibility === 'private' || r.hasPassword) return false;
    return isRoomJoinable(r).joinable;
  });

  if (matchingOpenRooms.length > 0) {
    // Prioriza salas com mais humanos aguardando
    matchingOpenRooms.sort((a, b) => {
      const countsA = getRoomParticipantCounts(a);
      const countsB = getRoomParticipantCounts(b);
      return countsB.humanCount - countsA.humanCount;
    });

    const target = matchingOpenRooms[0];
    const joined = await joinOnlineRoom(target.roomCode);
    if (joined) {
      return { room: joined, createdNew: false };
    }
  }

  const randomNum = Math.floor(100 + Math.random() * 900);
  const newRoom = await createOnlineRoom(homeTeamId, awayTeamId, halfDurationSeconds, {
    roomName: `SEM TERRA FC — SALA #${randomNum}`,
    mode,
    visibility: 'public',
    maxHumans: mode === '2v2' ? 4 : 8,
    autoFillBots: true,
  });

  return { room: newRoom, createdNew: true };
}
