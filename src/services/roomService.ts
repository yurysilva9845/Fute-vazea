import { MatchFormatMode, MultiplayerRoomState, RoomVisibility } from '../types/game';
import {
  createOnlineRoom,
  joinOnlineRoom,
  leaveOnlineRoom,
  selectRoomCharacter,
  startOnlineMatch,
  subscribeToRoom,
  togglePlayerReadyInRoom,
  updatePlayerVoiceStatusInRoom,
} from './firebase';

export interface CreateRoomParams {
  roomName?: string;
  mode: MatchFormatMode;
  visibility: RoomVisibility;
  password?: string;
  maxHumans?: number;
  autoFillBots?: boolean;
  homeTeamId?: string;
  awayTeamId?: string;
  halfDurationSeconds?: number;
  preferredCharacterId?: string;
}

/**
 * Gera um hash SHA-256 com salt do código da sala para nunca armazenar senhas em texto puro.
 */
export async function hashRoomPassword(roomCode: string, rawPassword: string): Promise<string> {
  const normalizedCode = roomCode.trim().toUpperCase();
  const normalizedPass = rawPassword.trim();
  const salted = `SEM_TERRA_FC::${normalizedCode}::${normalizedPass}`;

  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(salted);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    const bytes = Array.from(new Uint8Array(digest));
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback determinístico caso WebCrypto não esteja disponível em ambiente de teste
  let h1 = 0xdeadbeef ^ salted.length;
  let h2 = 0x41c6ce57 ^ salted.length;
  for (let i = 0; i < salted.length; i++) {
    const ch = salted.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export {
  createOnlineRoom,
  joinOnlineRoom,
  leaveOnlineRoom,
  selectRoomCharacter,
  startOnlineMatch,
  subscribeToRoom,
  togglePlayerReadyInRoom,
  updatePlayerVoiceStatusInRoom,
};

export function isRoomJoinable(room: MultiplayerRoomState): {
  joinable: boolean;
  reason?: string;
} {
  if (room.status === 'finished') {
    return { joinable: false, reason: 'Esta partida já foi encerrada.' };
  }
  if (room.status === 'playing' || room.status === 'starting') {
    return { joinable: false, reason: 'Partida já em andamento.' };
  }
  const mode: MatchFormatMode = room.mode === '2v2' ? '2v2' : '4v4';
  const maxAllowed = room.maxHumans ?? (mode === '2v2' ? 4 : 8);
  const currentHumans = Object.values(room.slots || {}).filter((s) => !s.isBot && s.uid).length;
  if (currentHumans >= maxAllowed) {
    return { joinable: false, reason: `Sala lotada (${currentHumans}/${maxAllowed} jogadores).` };
  }
  return { joinable: true };
}

