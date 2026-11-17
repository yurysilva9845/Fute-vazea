import { MultiplayerSlot } from '../types/game';
import { buildInitialRoomSlots } from './botService';
import { mapSupabaseRowToRoomState, SAFE_ROOM_SELECT_COLUMNS } from './supabaseDataService';
import { validateFirebaseJwtClaims } from './supabaseClient';

export interface SimulatedJwtSession {
  token: string | null;
  claims: Record<string, unknown> | null;
}

/**
 * Simulador fiel da camada de autorização PostgreSQL (RLS + Triggers + Funções RPC Atômicas)
 * definida em `supabase/migrations/20261117000001_sem_terra_fc_schema_rpc_rls.sql`.
 * Permite validar os 12 cenários obrigatórios de segurança e concorrência em testes automatizados.
 */
export class SupabaseSecurityTestHarness {
  private users = new Map<string, Record<string, any>>();
  private friendships = new Set<string>();
  private friendRequests = new Map<string, Record<string, any>>();
  private rooms = new Map<string, Record<string, any>>();
  private matches = new Map<string, Record<string, any>>();
  private matchHistory = new Map<string, Record<string, any>>();
  private roomLocks = new Map<string, Promise<void>>();

  /**
   * Equivalente exato a `public.firebase_uid()` no PostgreSQL.
   * Nunca aceita p_uid como fallback; exige token válido, iss/aud do projeto e role = 'authenticated'.
   */
  public resolveAuthenticatedUid(token: string | null): string | null {
    if (!token) return null;
    const check = validateFirebaseJwtClaims(token, undefined, Date.now(), true);
    if (!check.valid || !check.hasAuthenticatedRole || !check.uid) {
      return null;
    }
    return check.uid;
  }

  /**
   * Equivalente exato a `public.require_authenticated_uid(p_client_uid)` no PostgreSQL.
   */
  public requireAuthenticatedUid(token: string | null, clientUid?: string | null): string {
    const jwtUid = this.resolveAuthenticatedUid(token);
    if (!jwtUid) {
      throw new Error('AUTH_REQUIRED: Token JWT ausente, expirado ou sem role authenticated.');
    }
    if (clientUid && clientUid.trim() !== '' && clientUid.trim() !== jwtUid) {
      throw new Error(
        `UID_SPOOFING_REJECTED: O UID enviado pelo cliente (${clientUid}) não corresponde à identidade autenticada no JWT (${jwtUid}).`
      );
    }
    return jwtUid;
  }

  /**
   * 1 & 2. INSERT/UPDATE em public.users com RLS (`uid = public.firebase_uid()`)
   * e Trigger `trg_enforce_users_security` (bloqueia adulteração de estatísticas e amigos).
   */
  public clientUpsertProfile(
    token: string | null,
    targetUid: string,
    patch: Record<string, any>
  ): Record<string, any> {
    const authUid = this.requireAuthenticatedUid(token);
    if (authUid !== targetUid) {
      throw new Error('RLS_VIOLATION: Jogador não pode criar ou alterar o perfil de outro jogador.');
    }

    const existing = this.users.get(targetUid);
    if (!existing) {
      if (
        (patch.wins ?? 0) !== 0 ||
        (patch.losses ?? 0) !== 0 ||
        (patch.draws ?? 0) !== 0 ||
        (patch.goals_scored ?? 0) !== 0 ||
        (patch.goals_conceded ?? 0) !== 0 ||
        (patch.matches_played ?? 0) !== 0
      ) {
        throw new Error(
          'RLS_VIOLATION: Não é permitido inserir perfil com estatísticas manipuladas.'
        );
      }
      const created = {
        uid: targetUid,
        display_name: String(patch.display_name || 'Jogador').slice(0, 28),
        tag_code: String(patch.tag_code || '#STF0000').slice(0, 20),
        status: 'online',
        current_room_code: '',
        friends: [] as string[],
        wins: 0,
        losses: 0,
        draws: 0,
        goals_scored: 0,
        goals_conceded: 0,
        matches_played: 0,
      };
      this.users.set(targetUid, created);
      return { ...created };
    }

    // Trigger trg_enforce_users_security: bloqueia tentativa direta de alterar estatísticas ou amigos
    const statKeys = [
      'wins',
      'losses',
      'draws',
      'goals_scored',
      'goals_conceded',
      'matches_played',
    ];
    for (const k of statKeys) {
      if (patch[k] !== undefined && patch[k] !== existing[k]) {
        throw new Error(
          'STATS_TAMPERING_BLOCKED: Estatísticas competitivas só podem ser atualizadas pelo servidor ao concluir uma partida válida.'
        );
      }
    }
    if (patch.friends !== undefined) {
      throw new Error(
        'FRIENDS_TAMPERING_BLOCKED: A lista de amigos só pode ser modificada pelas funções oficiais de amizade.'
      );
    }

    const updated = {
      ...existing,
      display_name:
        patch.display_name !== undefined
          ? String(patch.display_name).slice(0, 28)
          : existing.display_name,
      status: patch.status !== undefined ? patch.status : existing.status,
      current_room_code:
        patch.current_room_code !== undefined
          ? patch.current_room_code
          : existing.current_room_code,
    };
    this.users.set(targetUid, updated);
    return { ...updated };
  }

  public clientSelectUsers(token: string | null): Array<Record<string, any>> {
    this.requireAuthenticatedUid(token);
    return Array.from(this.users.values()).map((u) => ({ ...u }));
  }

  /**
   * 3. Solicitações de Amizade: envio e resposta restrita exclusivamente ao destinatário (to_uid).
   */
  public clientSendFriendRequest(
    token: string | null,
    fromUidInput: string,
    toUid: string
  ): string {
    const authUid = this.requireAuthenticatedUid(token, fromUidInput);
    if (authUid === toUid) {
      throw new Error('RLS_VIOLATION: Não é permitido enviar solicitação para si mesmo.');
    }
    const id = `req_${this.friendRequests.size + 1}`;
    this.friendRequests.set(id, {
      id,
      from_uid: authUid,
      to_uid: toUid,
      type: 'friend_request',
      status: 'pending',
    });
    return id;
  }

  public rpcRespondFriendRequestAtomic(
    token: string | null,
    requestId: string,
    clientUid: string | null,
    accept: boolean
  ): void {
    const authUid = this.requireAuthenticatedUid(token, clientUid);
    const req = this.friendRequests.get(requestId);
    if (!req) {
      throw new Error('Solicitação não encontrada.');
    }
    if (req.to_uid !== authUid) {
      throw new Error(
        `FORBIDDEN_RECIPIENT_ONLY: Somente o destinatário da solicitação (${req.to_uid}) pode aceitá-la ou recusá-la.`
      );
    }
    req.status = accept ? 'accepted' : 'declined';
    if (accept && req.type === 'friend_request') {
      this.friendships.add(`${req.to_uid}:${req.from_uid}`);
      this.friendships.add(`${req.from_uid}:${req.to_uid}`);
      const uTo = this.users.get(req.to_uid);
      const uFrom = this.users.get(req.from_uid);
      if (uTo && !uTo.friends.includes(req.from_uid)) uTo.friends.push(req.from_uid);
      if (uFrom && !uFrom.friends.includes(req.to_uid)) uFrom.friends.push(req.to_uid);
    }
  }

  /**
   * 6, 7, 8, 9, 10, 12. Criação, listagem segura (sem password_hash), entrada atômica (FOR UPDATE),
   * prontidão restrita a participantes e saída atômica.
   */
  public rpcCreateRoomAtomic(
    token: string | null,
    params: {
      roomCode: string;
      roomName: string;
      mode: '2v2' | '4v4';
      visibility: 'public' | 'private';
      plainPassword?: string | null;
      maxHumans?: number;
    }
  ): Record<string, any> {
    const authUid = this.requireAuthenticatedUid(token);
    const hostUser = this.users.get(authUid);
    const hostName = hostUser?.display_name || 'Anfitrião';
    const slots = buildInitialRoomSlots(authUid, hostName, 'home_1');
    const hasPassword =
      params.visibility === 'private' && Boolean(params.plainPassword && params.plainPassword.trim());

    const row = {
      room_code: params.roomCode.toUpperCase(),
      match_id: null as string | null,
      room_name: params.roomName,
      mode: params.mode,
      visibility: params.visibility,
      has_password: hasPassword,
      // Simula hash bcrypt $2a$10$ no servidor
      password_hash: hasPassword ? `$2a$10$BCRYPT_SERVER_ONLY::${params.plainPassword!.trim()}` : null,
      max_humans: params.maxHumans ?? (params.mode === '2v2' ? 4 : 8),
      auto_fill_bots: true,
      active_character_ids: Object.keys(slots),
      loading_ready_uids: [authUid],
      host_uid: authUid,
      host_name: hostName,
      status: 'waiting',
      home_team_id: 'unidos_do_barro',
      away_team_id: 'rubro_negro_beco',
      home_goals: 0,
      away_goals: 0,
      half: 1,
      remaining_seconds: 150,
      slots,
      last_activity_ms: Date.now(),
    };
    this.rooms.set(row.room_code, row);
    return this.sanitizeRoomRow(row);
  }

  public queryPublicRoomsLobbyView(token: string | null): Array<Record<string, any>> {
    this.requireAuthenticatedUid(token);
    const result: Array<Record<string, any>> = [];
    for (const r of this.rooms.values()) {
      if (r.visibility === 'public' && r.status !== 'finished') {
        const sanitized = this.sanitizeRoomRow(r);
        result.push(sanitized);
      }
    }
    return result;
  }

  public async rpcJoinRoomAtomic(
    token: string | null,
    params: {
      roomCode: string;
      clientUid?: string | null;
      displayName: string;
      plainPassword?: string | null;
    }
  ): Promise<Record<string, any>> {
    const authUid = this.requireAuthenticatedUid(token, params.clientUid);
    const code = params.roomCode.toUpperCase();

    // Lock serializado FOR UPDATE por room_code
    const prevLock = this.roomLocks.get(code) || Promise.resolve();
    let releaseLock!: () => void;
    const nextLock = new Promise<void>((res) => {
      releaseLock = res;
    });
    this.roomLocks.set(code, prevLock.then(() => nextLock));
    await prevLock;

    try {
      const room = this.rooms.get(code);
      if (!room) throw new Error('Sala não encontrada.');

      const slots: Record<string, MultiplayerSlot> = JSON.parse(JSON.stringify(room.slots));
      const existingKey = Object.keys(slots).find((k) => slots[k].uid === authUid);

      if (room.has_password && room.password_hash && room.host_uid !== authUid && !existingKey) {
        if (!params.plainPassword || !params.plainPassword.trim()) {
          throw new Error('SENHA_OBRIGATORIA: Esta sala privada exige senha para entrar.');
        }
        // Rejeita tentativa de pass-the-hash (enviar o próprio hash bcrypt) e exige a senha original
        const expectedBcrypt = `$2a$10$BCRYPT_SERVER_ONLY::${params.plainPassword.trim()}`;
        if (room.password_hash !== expectedBcrypt) {
          throw new Error('Senha incorreta para esta sala privada.');
        }
      }

      const humans = Object.values(slots).filter((s) => !s.isBot && s.uid);
      if (!existingKey) {
        if (humans.length >= room.max_humans) {
          throw new Error(`Sala lotada (${humans.length}/${room.max_humans} jogadores humanos).`);
        }
        const botKey = Object.keys(slots).find((k) => slots[k].isBot);
        if (!botKey) {
          throw new Error('Todas as vagas de personagens já estão ocupadas.');
        }
        slots[botKey] = {
          ...slots[botKey],
          uid: authUid,
          displayName: params.displayName,
          isBot: false,
          isReady: true,
        };
      }

      room.slots = slots;
      return this.sanitizeRoomRow(room);
    } finally {
      releaseLock();
    }
  }

  public rpcToggleReadyAtomic(
    token: string | null,
    roomCode: string,
    clientUid?: string | null,
    ready?: boolean
  ): Record<string, any> {
    const authUid = this.requireAuthenticatedUid(token, clientUid);
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) throw new Error('Sala não encontrada.');

    const slots: Record<string, MultiplayerSlot> = JSON.parse(JSON.stringify(room.slots));
    let found = false;
    for (const key of Object.keys(slots)) {
      if (slots[key].uid === authUid) {
        slots[key].isReady = ready !== undefined ? ready : !slots[key].isReady;
        found = true;
      }
    }
    if (!found) {
      throw new Error('NOT_A_ROOM_PARTICIPANT: Você não ocupa uma vaga nesta sala.');
    }
    room.slots = slots;
    return this.sanitizeRoomRow(room);
  }

  public rpcLeaveRoomAtomic(
    token: string | null,
    roomCode: string,
    clientUid?: string | null
  ): void {
    const authUid = this.requireAuthenticatedUid(token, clientUid);
    const code = roomCode.toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return;

    const slots: Record<string, MultiplayerSlot> = JSON.parse(JSON.stringify(room.slots));
    let wasInRoom = false;
    for (const key of Object.keys(slots)) {
      if (slots[key].uid === authUid) {
        wasInRoom = true;
        slots[key] = {
          ...slots[key],
          uid: null,
          displayName: `${slots[key].characterName} (Bot)`,
          isBot: true,
          isReady: true,
        };
      }
    }

    if (!wasInRoom && room.host_uid !== authUid) {
      throw new Error('NOT_IN_ROOM: Jogador não pertence a esta sala.');
    }

    const remainingHumans = Object.values(slots).filter((s) => !s.isBot && s.uid);
    if (remainingHumans.length === 0) {
      this.rooms.delete(code);
    } else {
      if (room.host_uid === authUid) {
        room.host_uid = String(remainingHumans[0].uid);
        room.host_name = remainingHumans[0].displayName;
      }
      room.slots = slots;
    }
  }

  public rpcStartMatchAtomic(token: string | null, roomCode: string): string {
    const authUid = this.requireAuthenticatedUid(token);
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) throw new Error('Sala não encontrada.');
    if (room.host_uid !== authUid) {
      throw new Error('ONLY_HOST_CAN_START: Apenas o anfitrião da sala pode iniciar a partida.');
    }
    const matchId = `MTC-${room.room_code}`;
    room.match_id = matchId;
    room.status = 'playing';
    this.matches.set(matchId, {
      match_id: matchId,
      room_id: room.room_code,
      host_id: authUid,
      status: 'playing',
    });
    return matchId;
  }

  public rpcRecordMatchFinishedAtomic(
    token: string | null,
    roomCode: string,
    homeGoals: number,
    awayGoals: number
  ): boolean {
    const authUid = this.requireAuthenticatedUid(token);
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) throw new Error('MATCH_ROOM_NOT_FOUND');

    const slots: Record<string, MultiplayerSlot> = room.slots;
    const isParticipant =
      room.host_uid === authUid || Object.values(slots).some((s) => !s.isBot && s.uid === authUid);
    if (!isParticipant) {
      throw new Error(
        'NOT_MATCH_PARTICIPANT: Somente participantes verificados da sala podem encerrar a partida.'
      );
    }

    if (room.status === 'finished') return false;
    if (room.status !== 'playing' || !room.match_id) {
      throw new Error('MATCH_NOT_ACTIVE: A sala não possui uma partida ativa em andamento.');
    }

    const match = this.matches.get(room.match_id);
    if (!match || match.status === 'finished') return false;

    const winner = homeGoals > awayGoals ? 'home' : awayGoals > homeGoals ? 'away' : 'draw';
    for (const slot of Object.values(slots)) {
      if (!slot.isBot && slot.uid) {
        const u = this.users.get(slot.uid);
        if (u) {
          u.matches_played += 1;
          if (winner === slot.team) u.wins += 1;
          else if (winner !== 'draw') u.losses += 1;
          else u.draws += 1;
          u.goals_scored += slot.team === 'home' ? homeGoals : awayGoals;
          u.goals_conceded += slot.team === 'home' ? awayGoals : homeGoals;
        }
      }
    }

    match.status = 'finished';
    room.status = 'finished';
    this.matchHistory.set(match.match_id, {
      match_id: match.match_id,
      room_code: room.room_code,
      home_goals: homeGoals,
      away_goals: awayGoals,
      winner,
    });
    return true;
  }

  public getRoomInternal(roomCode: string): Record<string, any> | undefined {
    return this.rooms.get(roomCode.toUpperCase());
  }

  public getUserInternal(uid: string): Record<string, any> | undefined {
    return this.users.get(uid);
  }

  private sanitizeRoomRow(row: Record<string, any>): Record<string, any> {
    const clone = JSON.parse(JSON.stringify(row));
    clone.password_hash = null;
    delete clone.inputs;
    delete clone.match_snapshot;
    return mapSupabaseRowToRoomState(clone);
  }
}

export { SAFE_ROOM_SELECT_COLUMNS };
