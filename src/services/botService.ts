import { INITIAL_AWAY_PLAYERS, INITIAL_HOME_PLAYERS } from '../game/rules';
import { MatchFormatMode, MultiplayerRoomState, MultiplayerSlot, PlayerCustomization } from '../types/game';

export const ALL_CHARACTERS: Array<{
  id: string;
  name: string;
  team: 'home' | 'away';
  config: PlayerCustomization;
}> = [
  ...INITIAL_HOME_PLAYERS.map((p) => ({
    id: p.id,
    name: p.name,
    team: 'home' as const,
    config: p,
  })),
  ...INITIAL_AWAY_PLAYERS.map((p) => ({
    id: p.id,
    name: p.name,
    team: 'away' as const,
    config: p,
  })),
];

/**
 * Cria o mapa inicial de slots da sala com bots automáticos preenchendo todas as vagas.
 */
export function buildInitialRoomSlots(
  hostUid: string,
  hostName: string,
  preferredCharacterId: string = 'home_1'
): Record<string, MultiplayerSlot> {
  const slots: Record<string, MultiplayerSlot> = {};
  const validHostChar = ALL_CHARACTERS.some((c) => c.id === preferredCharacterId)
    ? preferredCharacterId
    : 'home_1';

  for (const char of ALL_CHARACTERS) {
    const isHostSlot = char.id === validHostChar;
    slots[char.id] = {
      characterId: char.id,
      characterName: char.name,
      team: char.team,
      uid: isHostSlot ? hostUid : null,
      displayName: isHostSlot ? hostName : `Bot ${char.name}`,
      isBot: !isHostSlot,
      isReady: true,
      pingMs: isHostSlot ? 18 : 0,
      micEnabled: false,
      isSpeaking: false,
      lastSeenMs: Date.now(),
    };
  }
  return slots;
}

/**
 * Calcula quais personagens estarão ativos em campo para 2v2 (2 em cada time = 4 no total)
 * ou 4v4 (4 em cada time = 8 no total).
 * Na modalidade 2v2, prioriza os personagens escolhidos por jogadores humanos (livre escolha
 * de 2 entre os 4 personagens por time) e completa com bots até ter exatamente 2 por equipe.
 */
export function resolveActiveCharacterIdsForRoom(
  slots: Record<string, MultiplayerSlot>,
  mode: MatchFormatMode = '4v4',
  explicitSelection?: string[]
): string[] {
  if (mode === '4v4') {
    return ALL_CHARACTERS.map((c) => c.id);
  }

  const pickTeamTwo = (team: 'home' | 'away'): string[] => {
    const teamChars = ALL_CHARACTERS.filter((c) => c.team === team);
    const chosen: string[] = [];

    // 1. Prioriza vagas ocupadas por jogadores humanos reais
    for (const char of teamChars) {
      const slot = slots[char.id];
      if (slot && !slot.isBot && slot.uid && chosen.length < 2) {
        chosen.push(char.id);
      }
    }

    // 2. Se houver seleção explícita de 2v2, respeita os personagens escolhidos
    if (explicitSelection && explicitSelection.length > 0) {
      for (const char of teamChars) {
        if (explicitSelection.includes(char.id) && !chosen.includes(char.id) && chosen.length < 2) {
          chosen.push(char.id);
        }
      }
    }

    // 3. Completa com bots da equipe até totalizar 2 jogadores no time
    for (const char of teamChars) {
      if (!chosen.includes(char.id) && chosen.length < 2) {
        chosen.push(char.id);
      }
    }

    return chosen;
  };

  return [...pickTeamTwo('home'), ...pickTeamTwo('away')];
}

/**
 * Conta quantos jogadores humanos e quantos bots estarão ativos na modalidade da sala.
 */
export function getRoomParticipantCounts(room: MultiplayerRoomState): {
  mode: MatchFormatMode;
  maxHumans: number;
  totalActiveSlots: number;
  humanCount: number;
  botCount: number;
  homeHumans: number;
  awayHumans: number;
} {
  const mode: MatchFormatMode = room.mode === '2v2' ? '2v2' : '4v4';
  const totalActiveSlots = mode === '2v2' ? 4 : 8;
  const maxHumans = room.maxHumans ? Math.min(totalActiveSlots, room.maxHumans) : totalActiveSlots;

  const activeIds =
    room.activeCharacterIds && room.activeCharacterIds.length === totalActiveSlots
      ? room.activeCharacterIds
      : resolveActiveCharacterIdsForRoom(room.slots || {}, mode, room.activeCharacterIds);

  let humanCount = 0;
  let homeHumans = 0;
  let awayHumans = 0;

  for (const slot of Object.values(room.slots || {})) {
    if (!slot.isBot && slot.uid) {
      humanCount++;
      if (slot.team === 'home') homeHumans++;
      else awayHumans++;
    }
  }

  const botCount = Math.max(0, totalActiveSlots - humanCount);

  return {
    mode,
    maxHumans,
    totalActiveSlots,
    humanCount,
    botCount,
    homeHumans,
    awayHumans,
  };
}

/**
 * Converte imediatamente o slot de um jogador humano desconectado em um Bot ativo.
 */
export function convertSlotToBot(slot: MultiplayerSlot): MultiplayerSlot {
  const char = ALL_CHARACTERS.find((c) => c.id === slot.characterId);
  const charName = char ? char.name : slot.characterName;
  return {
    ...slot,
    uid: null,
    displayName: `Bot ${charName}`,
    isBot: true,
    isReady: true,
    pingMs: 0,
    micEnabled: false,
    isSpeaking: false,
    lastSeenMs: Date.now(),
  };
}
