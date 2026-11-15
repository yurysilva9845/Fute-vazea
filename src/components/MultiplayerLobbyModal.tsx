import React, { useEffect, useState } from 'react';
import {
  auth,
  collection,
  createMultiplayerRoom,
  db,
  doc,
  ensureAuthenticatedUser,
  FIREBASE_PROJECT_INFO,
  FriendRequestRecord,
  joinMultiplayerRoom,
  leaveMultiplayerRoom,
  listActiveRooms,
  listOnlineUsers,
  onAuthStateChanged,
  onSnapshot,
  OnlineUserProfile,
  query,
  respondToFriendRequest,
  selectCharacterInRoom,
  sendFriendRequestOrInvite,
  signInOrLinkWithGoogle,
  startMultiplayerMatchInRoom,
  testFirebaseConnection,
  updateUserProfileName,
  where,
} from '../services/firebase';
import {
  MultiplayerRoomState,
  MultiplayerSlot,
  TeamConfig,
} from '../types/game';
import { INITIAL_AWAY_PLAYERS, INITIAL_HOME_PLAYERS } from '../game/rules';

interface MultiplayerLobbyModalProps {
  initialTab: 'lobby' | 'friends' | 'diagnostic';
  homeTeam: TeamConfig;
  awayTeam: TeamConfig;
  activeRoom: MultiplayerRoomState | null;
  controlledCharacterId: string;
  onRoomUpdated: (
    room: MultiplayerRoomState | null,
    myCharId: string
  ) => void;
  onStartMultiplayerGame: () => void;
  onClose: () => void;
}

export const MultiplayerLobbyModal: React.FC<MultiplayerLobbyModalProps> = ({
  initialTab,
  homeTeam,
  awayTeam,
  activeRoom,
  controlledCharacterId,
  onRoomUpdated,
  onStartMultiplayerGame,
  onClose,
}) => {
  const [tab, setTab] = useState<'lobby' | 'friends' | 'diagnostic'>(
    initialTab
  );
  const [profile, setProfile] = useState<OnlineUserProfile | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Diagnostic state
  const [connected, setConnected] = useState(false);
  const [pingMs, setPingMs] = useState(22);
  const [authError, setAuthError] = useState<string | null>(null);

  // Lists
  const [openRooms, setOpenRooms] = useState<
    Array<{
      roomCode: string;
      hostName: string;
      status: string;
      humanCount: number;
      homeScore: number;
      awayScore: number;
    }>
  >([]);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUserProfile[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequestRecord[]>(
    []
  );

  // Initialize Auth & Connection test on mount and whenever Auth state changes
  useEffect(() => {
    let mounted = true;
    const syncLobbyData = async () => {
      const conn = await testFirebaseConnection();
      if (!mounted) return;
      setConnected(conn.connected);
      setPingMs(conn.pingMs);

      const { profile: userProf, authError: aErr } =
        await ensureAuthenticatedUser();
      if (!mounted) return;
      setProfile(userProf);
      setNameInput(userProf.displayName);
      if (aErr) setAuthError(aErr);

      const [rooms, users] = await Promise.all([
        listActiveRooms(),
        listOnlineUsers(),
      ]);
      if (!mounted) return;
      setOpenRooms(rooms);
      setOnlineUsers(users);
    };

    syncLobbyData();

    const unsubAuth = onAuthStateChanged(auth, () => {
      if (mounted) {
        syncLobbyData();
      }
    });

    return () => {
      mounted = false;
      unsubAuth();
    };
  }, []);

  // Subscribe to active room updates via Firestore onSnapshot when authenticated
  useEffect(() => {
    if (!activeRoom?.roomCode || !auth.currentUser) return;
    const roomRef = doc(db, 'rooms', activeRoom.roomCode);
    const unsub = onSnapshot(
      roomRef,
      (snap) => {
        if (!snap.exists()) {
          onRoomUpdated(null, 'home_1');
          return;
        }
        const d = snap.data();
        const slots: Record<string, MultiplayerSlot> =
          d.assignedSlots || d.slots || {};
        const myUid = auth.currentUser?.uid;
        const mySlot = Object.values(slots).find((s) => s.uid === myUid);
        const myChar = mySlot?.characterId || controlledCharacterId;

        const roomState: MultiplayerRoomState = {
          roomCode: d.roomCode,
          hostUid: d.hostUid,
          hostName: d.hostName,
          status: d.status,
          homeTeamId: d.homeTeamId || homeTeam.id,
          awayTeamId: d.awayTeamId || awayTeam.id,
          homeScore: d.homeGoals ?? d.homeScore ?? 0,
          awayScore: d.awayGoals ?? d.awayScore ?? 0,
          half: d.half || 1,
          remainingSeconds: d.remainingSeconds ?? 300,
          slots,
          matchState: d.syncState || d.matchState || null,
        };

        onRoomUpdated(roomState, myChar);

        if (d.status === 'playing') {
          onStartMultiplayerGame();
        }
      },
      (err) => {
        setErrorMessage(`Erro de sincronização da sala: ${err.message}`);
      }
    );
    return () => unsub();
  }, [activeRoom?.roomCode]);

  // Subscribe to incoming/outgoing friend requests & room invites
  useEffect(() => {
    const myUid = auth.currentUser?.uid;
    if (!myUid) return;

    const qIncoming = query(
      collection(db, 'friendRequests'),
      where('toUid', '==', myUid)
    );
    const qOutgoing = query(
      collection(db, 'friendRequests'),
      where('fromUid', '==', myUid)
    );

    let inList: FriendRequestRecord[] = [];
    let outList: FriendRequestRecord[] = [];

    const merge = () => {
      const map = new Map<string, FriendRequestRecord>();
      [...inList, ...outList].forEach((r) => map.set(r.id, r));
      setFriendRequests(Array.from(map.values()));
    };

    const unsubIn = onSnapshot(
      qIncoming,
      (snap) => {
        inList = snap.docs.map((d) => {
          const raw = d.data();
          return {
            id: d.id,
            fromUid: raw.fromUid,
            fromName: raw.fromName,
            fromTag: raw.fromTag,
            toUid: raw.toUid,
            toName: raw.toName,
            status: raw.status,
            roomInviteCode: raw.inviteRoomCode || raw.roomInviteCode || '',
          };
        });
        merge();
      },
      () => {}
    );

    const unsubOut = onSnapshot(
      qOutgoing,
      (snap) => {
        outList = snap.docs.map((d) => {
          const raw = d.data();
          return {
            id: d.id,
            fromUid: raw.fromUid,
            fromName: raw.fromName,
            fromTag: raw.fromTag,
            toUid: raw.toUid,
            toName: raw.toName,
            status: raw.status,
            roomInviteCode: raw.inviteRoomCode || raw.roomInviteCode || '',
          };
        });
        merge();
      },
      () => {}
    );

    return () => {
      unsubIn();
      unsubOut();
    };
  }, [profile?.uid]);

  const handleSaveName = async () => {
    if (!nameInput.trim()) return;
    const updated = await updateUserProfileName(nameInput);
    if (updated) {
      setProfile(updated);
      setStatusMessage('Nome de jogador atualizado com sucesso!');
      setTimeout(() => setStatusMessage(null), 2500);
    }
  };

  const handleGoogleLogin = async () => {
    setErrorMessage(null);
    setIsLoading(true);
    const { user, error } = await signInOrLinkWithGoogle();
    setIsLoading(false);
    if (error) {
      setErrorMessage(`Não foi possível autenticar com Google: ${error}`);
    } else if (user) {
      const { profile: updatedProf } = await ensureAuthenticatedUser(
        user.displayName || undefined
      );
      setProfile(updatedProf);
      setNameInput(updatedProf.displayName);
      setAuthError(null);
      const [rooms, users] = await Promise.all([
        listActiveRooms(),
        listOnlineUsers(),
      ]);
      setOpenRooms(rooms);
      setOnlineUsers(users);
      setStatusMessage('Conta Google conectada ao Firebase com sucesso!');
    }
  };

  const handleCreateRoom = async () => {
    if (!profile) return;
    setErrorMessage(null);
    setIsLoading(true);
    try {
      const code = await createMultiplayerRoom(
        profile,
        homeTeam.name,
        awayTeam.name,
        'home_1'
      );
      setRoomCodeInput(code);
      const savedLocal =
        typeof localStorage !== 'undefined'
          ? localStorage.getItem(`varzea_room_${code}`)
          : null;
      const parsedSlots = savedLocal ? JSON.parse(savedLocal).slots : {};
      onRoomUpdated(
        {
          roomCode: code,
          hostUid: auth.currentUser?.uid || profile.uid,
          hostName: profile.displayName,
          status: 'waiting',
          homeTeamId: homeTeam.id,
          awayTeamId: awayTeam.id,
          homeScore: 0,
          awayScore: 0,
          half: 1,
          remainingSeconds: 300,
          slots: parsedSlots,
          matchState: null,
        },
        'home_1'
      );
      setStatusMessage(
        `Sala ${code} criada! Compartilhe o código com seus amigos.`
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao criar sala.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoinRoom = async (codeToJoin?: string) => {
    const targetCode = (codeToJoin || roomCodeInput).trim().toUpperCase();
    if (!targetCode || !profile) return;
    setErrorMessage(null);
    setIsLoading(true);
    try {
      const { roomCode, assignedCharacterId } = await joinMultiplayerRoom(
        targetCode,
        profile
      );
      onRoomUpdated(
        {
          roomCode,
          hostUid: '',
          hostName: '',
          status: 'waiting',
          homeTeamId: homeTeam.id,
          awayTeamId: awayTeam.id,
          homeScore: 0,
          awayScore: 0,
          half: 1,
          remainingSeconds: 300,
          slots: {},
          matchState: null,
        },
        assignedCharacterId
      );
      setStatusMessage(`Conectado à sala ${roomCode}!`);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao entrar na sala.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyRoomCode = (code: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).catch(() => {});
      setStatusMessage(`Código ${code} copiado para a área de transferência!`);
      setTimeout(() => setStatusMessage(null), 2500);
    }
  };

  const handleSelectCharacter = async (charId: string) => {
    if (!activeRoom || !profile) return;
    const slotsCopy = { ...(activeRoom.slots || {}) };
    const targetSlot = slotsCopy[charId];
    const myUid = auth.currentUser?.uid || profile.uid;
    if (targetSlot && !targetSlot.isBot && targetSlot.uid && targetSlot.uid !== myUid) {
      setErrorMessage('Este jogador já está sendo controlado por outro humano!');
      setTimeout(() => setErrorMessage(null), 2500);
      return;
    }

    for (const k of Object.keys(slotsCopy)) {
      if (slotsCopy[k].uid === myUid) {
        slotsCopy[k] = {
          ...slotsCopy[k],
          uid: null,
          displayName: `Bot (${slotsCopy[k].characterName})`,
          isBot: true,
        };
      }
    }
    if (slotsCopy[charId]) {
      slotsCopy[charId] = {
        ...slotsCopy[charId],
        uid: myUid,
        displayName: profile.displayName,
        isBot: false,
      };
    }

    onRoomUpdated({ ...activeRoom, slots: slotsCopy }, charId);
    if (auth.currentUser) {
      await selectCharacterInRoom(activeRoom.roomCode, profile, charId);
    }
  };

  const handleRefreshLists = async () => {
    setIsLoading(true);
    const [conn, rooms, users] = await Promise.all([
      testFirebaseConnection(),
      listActiveRooms(),
      listOnlineUsers(),
    ]);
    setConnected(conn.connected);
    setPingMs(conn.pingMs);
    setOpenRooms(rooms);
    setOnlineUsers(users);
    setIsLoading(false);
  };

  const filteredUsers = onlineUsers.filter((u) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      u.displayName.toLowerCase().includes(q) ||
      u.tagCode.toLowerCase().includes(q)
    );
  });

  const allSlotsList = [
    ...INITIAL_HOME_PLAYERS.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      team: 'home' as const,
    })),
    ...INITIAL_AWAY_PLAYERS.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      team: 'away' as const,
    })),
  ];

  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-stone-950/85 p-3 sm:p-6 overflow-y-auto">
      <div className="w-full max-w-4xl bg-stone-950 border-2 border-amber-500/80 rounded-2xl p-4 sm:p-6 shadow-2xl text-stone-100 my-auto max-h-[92vh] flex flex-col">
        {/* Top Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 mb-4 border-b border-stone-800 shrink-0">
          <div className="flex items-center gap-3">
            <span className="px-2.5 py-1 rounded-md bg-amber-500 text-stone-950 font-extrabold text-xs uppercase tracking-wider">
              ONLINE 4x4
            </span>
            <h2 className="text-lg sm:text-2xl font-extrabold text-amber-400 tracking-wide uppercase">
              Central Multiplayer &amp; Amigos
            </h2>
          </div>

          <div className="flex items-center gap-2">
            {/* Connection & Ping Badge */}
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-stone-900 border border-stone-800 text-xs font-mono">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  connected ? 'bg-emerald-400' : 'bg-red-500'
                }`}
              />
              <span className="text-stone-300">
                {connected ? 'Firebase Online' : 'Offline'}
              </span>
              <span className="text-amber-400 font-bold">{pingMs} ms</span>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 rounded-lg text-xs font-bold cursor-pointer"
            >
              Fechar
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="grid grid-cols-3 gap-2 mb-4 bg-stone-900 p-1.5 rounded-xl shrink-0">
          <button
            type="button"
            onClick={() => setTab('lobby')}
            className={`py-2 px-3 rounded-lg text-xs sm:text-sm font-extrabold uppercase tracking-wider transition-colors cursor-pointer ${
              tab === 'lobby'
                ? 'bg-amber-500 text-stone-950'
                : 'text-stone-300 hover:text-white'
            }`}
          >
            Lobby Multiplayer
          </button>
          <button
            type="button"
            onClick={() => setTab('friends')}
            className={`py-2 px-3 rounded-lg text-xs sm:text-sm font-extrabold uppercase tracking-wider transition-colors cursor-pointer ${
              tab === 'friends'
                ? 'bg-amber-500 text-stone-950'
                : 'text-stone-300 hover:text-white'
            }`}
          >
            Amigos &amp; Jogadores Online
          </button>
          <button
            type="button"
            onClick={() => setTab('diagnostic')}
            className={`py-2 px-3 rounded-lg text-xs sm:text-sm font-extrabold uppercase tracking-wider transition-colors cursor-pointer ${
              tab === 'diagnostic'
                ? 'bg-amber-500 text-stone-950'
                : 'text-stone-300 hover:text-white'
            }`}
          >
            Diagnóstico Firebase
          </button>
        </div>

        {/* Status / Error Alerts */}
        {statusMessage && (
          <div className="mb-3 px-4 py-2 rounded-xl bg-emerald-950/90 border border-emerald-500/60 text-emerald-200 text-xs font-semibold shrink-0">
            {statusMessage}
          </div>
        )}
        {errorMessage && (
          <div className="mb-3 px-4 py-2 rounded-xl bg-red-950/90 border border-red-500/60 text-red-200 text-xs font-semibold shrink-0">
            {errorMessage}
          </div>
        )}

        {/* Player Identity Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-stone-900/90 border border-stone-800 rounded-xl p-3 mb-4 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-stone-400 font-semibold">
              Seu Craque:
            </span>
            <input
              type="text"
              maxLength={24}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              aria-label="Seu nome de jogador online"
              className="px-2.5 py-1 bg-stone-950 border border-stone-700 rounded-lg text-xs font-bold text-white w-36 sm:w-44"
            />
            <button
              type="button"
              onClick={handleSaveName}
              className="px-2.5 py-1 bg-stone-800 hover:bg-stone-700 text-amber-300 rounded-lg text-xs font-bold cursor-pointer"
            >
              Salvar Nome
            </button>
            {profile?.tagCode && (
              <span className="px-2 py-0.5 rounded bg-stone-950 border border-stone-700 font-mono text-xs text-amber-400">
                Código: {profile.tagCode}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!auth.currentUser || auth.currentUser.isAnonymous ? (
              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={isLoading}
                className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-bold transition-colors cursor-pointer"
              >
                Vincular / Entrar com Google
              </button>
            ) : (
              <span className="text-xs text-emerald-400 font-semibold">
                ✓ Conta Google Verificada
              </span>
            )}
          </div>
        </div>

        {/* Scrollable Content Area */}
        <div className="overflow-y-auto flex-1 pr-1 space-y-4">
          {/* TAB 1: LOBBY MULTIPLAYER */}
          {tab === 'lobby' && (
            <div className="space-y-4">
              {!activeRoom ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Create or Join Room Box */}
                  <div className="bg-stone-900/70 border border-stone-800 rounded-xl p-4 space-y-4">
                    <h3 className="text-sm font-extrabold text-amber-400 uppercase tracking-wider">
                      Criar ou Entrar em uma Sala 4x4
                    </h3>
                    <p className="text-xs text-stone-300 leading-relaxed">
                      Crie uma sala de várzea para gerar um código único ou
                      digite o código enviado pelo seu amigo. Posições sem
                      humanos são preenchidas por Inteligência Artificial (1x1,
                      2x2, 3x3 ou 4x4).
                    </p>

                    <button
                      type="button"
                      onClick={handleCreateRoom}
                      disabled={isLoading}
                      className="w-full py-3 px-4 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold text-sm rounded-xl shadow-lg transition-colors cursor-pointer"
                    >
                      CRIAR SALA ONLINE
                    </button>

                    <div className="pt-3 border-t border-stone-800">
                      <label
                        htmlFor="join-room-code-input"
                        className="block text-xs text-stone-400 mb-1.5 font-semibold"
                      >
                        Entrar com Código da Sala:
                      </label>
                      <div className="flex gap-2">
                        <input
                          id="join-room-code-input"
                          type="text"
                          placeholder="Ex: VRZ-4821"
                          value={roomCodeInput}
                          onChange={(e) =>
                            setRoomCodeInput(e.target.value.toUpperCase())
                          }
                          className="flex-1 px-3 py-2 bg-stone-950 border border-stone-700 rounded-xl text-sm font-mono font-bold text-amber-400 uppercase"
                        />
                        <button
                          type="button"
                          onClick={() => handleJoinRoom()}
                          disabled={isLoading || !roomCodeInput.trim()}
                          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-extrabold text-xs rounded-xl cursor-pointer"
                        >
                          ENTRAR NA SALA
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Open Rooms List */}
                  <div className="bg-stone-900/70 border border-stone-800 rounded-xl p-4 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-extrabold text-amber-400 uppercase tracking-wider">
                          Salas Abertas no Terreirão
                        </h3>
                        <button
                          type="button"
                          onClick={handleRefreshLists}
                          className="text-xs text-stone-400 hover:text-white underline cursor-pointer"
                        >
                          Atualizar
                        </button>
                      </div>

                      {openRooms.length === 0 ? (
                        <div className="py-8 text-center text-xs text-stone-400">
                          Nenhuma sala aberta no momento. Clique em{' '}
                          <strong className="text-amber-400">
                            CRIAR SALA ONLINE
                          </strong>{' '}
                          para puxar a pelada!
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-56 overflow-y-auto">
                          {openRooms.map((r) => (
                            <div
                              key={r.roomCode}
                              className="flex items-center justify-between p-2.5 rounded-lg bg-stone-950 border border-stone-800"
                            >
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-mono font-extrabold text-xs text-amber-400">
                                    {r.roomCode}
                                  </span>
                                  <span className="text-xs font-bold text-stone-200">
                                    Host: {r.hostName}
                                  </span>
                                </div>
                                <div className="text-[11px] text-stone-400">
                                  Jogadores Humanos: {r.humanCount}/8 · Status:{' '}
                                  {r.status === 'waiting'
                                    ? 'Aguardando'
                                    : `Jogando (${r.homeScore}x${r.awayScore})`}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleJoinRoom(r.roomCode)}
                                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold text-xs rounded-lg cursor-pointer"
                              >
                                Entrar
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                /* ACTIVE ROOM LOBBY: Select Team & Character (Yuri, Josué, Careca, Bode vs Primo, Bicudo, Ismael, Felipe) */
                <div className="bg-stone-900/80 border border-amber-500/50 rounded-xl p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-stone-800">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs uppercase font-bold text-stone-400">
                          Código da Sala:
                        </span>
                        <span className="font-mono font-extrabold text-lg text-amber-400">
                          {activeRoom.roomCode}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopyRoomCode(activeRoom.roomCode)
                          }
                          className="px-2.5 py-1 bg-stone-800 hover:bg-stone-700 text-amber-300 rounded text-xs font-bold cursor-pointer"
                        >
                          Copiar Código
                        </button>
                      </div>
                      <p className="text-xs text-stone-400 mt-0.5">
                        Escolha seu jogador abaixo. Dois humanos não podem
                        controlar o mesmo personagem (os demais jogam com IA).
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          await leaveMultiplayerRoom(activeRoom.roomCode);
                          onRoomUpdated(null, 'home_1');
                        }}
                        className="px-3 py-2 bg-stone-800 hover:bg-red-950 text-stone-300 hover:text-red-300 rounded-xl text-xs font-bold cursor-pointer"
                      >
                        Sair da Sala
                      </button>

                      <button
                        type="button"
                        onClick={async () => {
                          await startMultiplayerMatchInRoom(
                            activeRoom.roomCode
                          );
                          onStartMultiplayerGame();
                        }}
                        className="px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold text-sm rounded-xl shadow-lg cursor-pointer"
                      >
                        INICIAR PARTIDA ONLINE
                      </button>
                    </div>
                  </div>

                  {/* 4v4 Character Slot Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Team 1: Yuri, Josué, Careca, Bode */}
                    <div className="bg-stone-950/90 border border-stone-800 rounded-xl p-3">
                      <div className="text-xs font-extrabold text-amber-400 uppercase tracking-wider mb-2.5">
                        Time 1 ({homeTeam.name}) — Yuri, Josué, Careca, Bode
                      </div>
                      <div className="space-y-2">
                        {allSlotsList
                          .filter((s) => s.team === 'home')
                          .map((char) => {
                            const slot = activeRoom.slots?.[char.id];
                            const isMe = char.id === controlledCharacterId;
                            const isOtherHuman =
                              slot && !slot.isBot && slot.uid && !isMe;
                            return (
                              <div
                                key={char.id}
                                className={`flex items-center justify-between p-2.5 rounded-lg border ${
                                  isMe
                                    ? 'bg-amber-500/15 border-amber-400'
                                    : 'bg-stone-900 border-stone-800'
                                }`}
                              >
                                <div>
                                  <div className="font-bold text-sm text-stone-100">
                                    {char.name}{' '}
                                    <span className="text-[10px] font-mono text-stone-400 uppercase">
                                      ({char.role})
                                    </span>
                                  </div>
                                  <div className="text-xs text-stone-400">
                                    {isMe
                                      ? `Você (${profile?.displayName})`
                                      : isOtherHuman
                                      ? `Humano: ${slot.displayName}`
                                      : 'Controlado por Bot (IA)'}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  disabled={Boolean(isOtherHuman)}
                                  onClick={() => handleSelectCharacter(char.id)}
                                  className={`px-3 py-1 rounded-lg text-xs font-bold cursor-pointer ${
                                    isMe
                                      ? 'bg-amber-500 text-stone-950'
                                      : isOtherHuman
                                      ? 'bg-stone-800 text-stone-500 cursor-not-allowed'
                                      : 'bg-stone-800 hover:bg-stone-700 text-stone-200'
                                  }`}
                                >
                                  {isMe
                                    ? 'Selecionado'
                                    : isOtherHuman
                                    ? 'Ocupado'
                                    : 'Assumir'}
                                </button>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    {/* Team 2: Primo, Bicudo, Ismael, Felipe */}
                    <div className="bg-stone-950/90 border border-stone-800 rounded-xl p-3">
                      <div className="text-xs font-extrabold text-red-400 uppercase tracking-wider mb-2.5">
                        Time 2 ({awayTeam.name}) — Primo, Bicudo, Ismael, Felipe
                      </div>
                      <div className="space-y-2">
                        {allSlotsList
                          .filter((s) => s.team === 'away')
                          .map((char) => {
                            const slot = activeRoom.slots?.[char.id];
                            const isMe = char.id === controlledCharacterId;
                            const isOtherHuman =
                              slot && !slot.isBot && slot.uid && !isMe;
                            return (
                              <div
                                key={char.id}
                                className={`flex items-center justify-between p-2.5 rounded-lg border ${
                                  isMe
                                    ? 'bg-amber-500/15 border-amber-400'
                                    : 'bg-stone-900 border-stone-800'
                                }`}
                              >
                                <div>
                                  <div className="font-bold text-sm text-stone-100">
                                    {char.name}{' '}
                                    <span className="text-[10px] font-mono text-stone-400 uppercase">
                                      ({char.role})
                                    </span>
                                  </div>
                                  <div className="text-xs text-stone-400">
                                    {isMe
                                      ? `Você (${profile?.displayName})`
                                      : isOtherHuman
                                      ? `Humano: ${slot.displayName}`
                                      : 'Controlado por Bot (IA)'}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  disabled={Boolean(isOtherHuman)}
                                  onClick={() => handleSelectCharacter(char.id)}
                                  className={`px-3 py-1 rounded-lg text-xs font-bold cursor-pointer ${
                                    isMe
                                      ? 'bg-amber-500 text-stone-950'
                                      : isOtherHuman
                                      ? 'bg-stone-800 text-stone-500 cursor-not-allowed'
                                      : 'bg-stone-800 hover:bg-stone-700 text-stone-200'
                                  }`}
                                >
                                  {isMe
                                    ? 'Selecionado'
                                    : isOtherHuman
                                    ? 'Ocupado'
                                    : 'Assumir'}
                                </button>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: AMIGOS & JOGADORES ONLINE */}
          {tab === 'friends' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Search & Online Players */}
              <div className="bg-stone-900/70 border border-stone-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-extrabold text-amber-400 uppercase tracking-wider">
                    Buscar Jogadores por Nome ou Código
                  </h3>
                  <button
                    type="button"
                    onClick={handleRefreshLists}
                    className="text-xs text-stone-400 hover:text-white underline cursor-pointer"
                  >
                    Atualizar
                  </button>
                </div>

                <input
                  type="text"
                  placeholder="Buscar por nome ou código (ex: VZR-7A2B)..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full px-3 py-2 bg-stone-950 border border-stone-700 rounded-xl text-xs text-white"
                />

                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {filteredUsers.length === 0 ? (
                    <div className="py-6 text-center text-xs text-stone-400">
                      Nenhum jogador encontrado com esse filtro.
                    </div>
                  ) : (
                    filteredUsers.map((u) => {
                      const isSelf = u.uid === profile?.uid;
                      return (
                        <div
                          key={u.uid}
                          className="flex items-center justify-between p-2.5 rounded-lg bg-stone-950 border border-stone-800"
                        >
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-emerald-400" />
                              <span className="font-bold text-xs text-stone-100">
                                {u.displayName} {isSelf && '(Você)'}
                              </span>
                              <span className="font-mono text-[10px] text-amber-400">
                                {u.tagCode}
                              </span>
                            </div>
                            <div className="text-[11px] text-stone-400">
                              {u.currentRoomCode
                                ? `Na sala ${u.currentRoomCode}`
                                : 'Disponível no Lobby'}
                            </div>
                          </div>

                          {!isSelf && profile && (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={async () => {
                                  await sendFriendRequestOrInvite(
                                    profile,
                                    u,
                                    activeRoom?.roomCode || ''
                                  );
                                  setStatusMessage(
                                    activeRoom?.roomCode
                                      ? `Convite para sala ${activeRoom.roomCode} enviado a ${u.displayName}!`
                                      : `Pedido de amizade enviado para ${u.displayName}!`
                                  );
                                }}
                                className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-stone-950 font-bold text-xs rounded-lg cursor-pointer"
                              >
                                {activeRoom?.roomCode
                                  ? 'Convidar p/ Sala'
                                  : '+ Amigo'}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Friend Requests & Room Invites */}
              <div className="bg-stone-900/70 border border-stone-800 rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-extrabold text-amber-400 uppercase tracking-wider">
                  Lista de Amigos &amp; Convites de Partida
                </h3>

                {friendRequests.length === 0 ? (
                  <div className="py-8 text-center text-xs text-stone-400">
                    Você ainda não tem pedidos de amizade ou convites pendentes.
                    Adicione jogadores ao lado para jogar junto!
                  </div>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {friendRequests.map((req) => {
                      const isIncoming = req.toUid === auth.currentUser?.uid;
                      const friendName = isIncoming
                        ? req.fromName
                        : req.toName;
                      return (
                        <div
                          key={req.id}
                          className="p-2.5 rounded-lg bg-stone-950 border border-stone-800 flex items-center justify-between gap-2"
                        >
                          <div>
                            <div className="font-bold text-xs text-stone-100">
                              {friendName}
                            </div>
                            <div className="text-[11px] text-stone-400">
                              Status:{' '}
                              {req.status === 'accepted'
                                ? 'Amigo Confirmado'
                                : req.status === 'pending'
                                ? 'Pedido Pendente'
                                : 'Recusado'}
                              {req.roomInviteCode &&
                                ` · Sala: ${req.roomInviteCode}`}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            {isIncoming && req.status === 'pending' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    respondToFriendRequest(req.id, 'accepted')
                                  }
                                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded cursor-pointer"
                                >
                                  Aceitar
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    respondToFriendRequest(req.id, 'declined')
                                  }
                                  className="px-2 py-1 bg-stone-800 hover:bg-stone-700 text-stone-300 text-xs rounded cursor-pointer"
                                >
                                  Recusar
                                </button>
                              </>
                            )}

                            {req.roomInviteCode && (
                              <button
                                type="button"
                                onClick={() => {
                                  setTab('lobby');
                                  handleJoinRoom(req.roomInviteCode);
                                }}
                                className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs font-extrabold rounded cursor-pointer"
                              >
                                Entrar na Sala
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: DIAGNÓSTICO FIREBASE */}
          {tab === 'diagnostic' && (
            <div className="bg-stone-900/70 border border-stone-800 rounded-xl p-4 space-y-4 text-xs">
              <h3 className="text-sm font-extrabold text-amber-400 uppercase tracking-wider">
                Status de Conexão e Diagnóstico Firebase
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-stone-950 border border-stone-800">
                  <div className="text-stone-400">Conexão Firestore</div>
                  <div
                    className={`font-extrabold text-sm mt-1 ${
                      connected ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {connected ? 'CONECTADO (ONLINE)' : 'OFFLINE'}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-stone-950 border border-stone-800">
                  <div className="text-stone-400">Latência / Ping</div>
                  <div className="font-mono font-extrabold text-sm text-amber-400 mt-1">
                    {pingMs} ms
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-stone-950 border border-stone-800">
                  <div className="text-stone-400">Autenticação Atual</div>
                  <div className="font-extrabold text-sm text-stone-100 mt-1">
                    {auth.currentUser
                      ? auth.currentUser.isAnonymous
                        ? 'Anônima Ativa'
                        : 'Google OAuth Ativo'
                      : 'Modo Convidado Local'}
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-stone-950 border border-stone-800 space-y-1.5 font-mono text-[11px] text-stone-300">
                <div>
                  <span className="text-stone-500">Projeto Firebase:</span>{' '}
                  {FIREBASE_PROJECT_INFO.projectId}
                </div>
                <div>
                  <span className="text-stone-500">Banco Firestore:</span>{' '}
                  {FIREBASE_PROJECT_INFO.databaseId}
                </div>
                <div>
                  <span className="text-stone-500">UID do Jogador:</span>{' '}
                  {auth.currentUser?.uid || profile?.uid || 'N/A'}
                </div>
              </div>

              {authError && (
                <div className="p-3 rounded-lg bg-amber-950/60 border border-amber-500/50 text-amber-200 space-y-1">
                  <div className="font-bold">
                    Aviso de Configuração de Login Anônimo:
                  </div>
                  <p>
                    O provedor Anônimo retornou: <code>{authError}</code>. Você
                    pode clicar em <strong>Vincular / Entrar com Google</strong>{' '}
                    acima para autenticar imediatamente, ou ativar o provedor{' '}
                    <em>Anonymous</em> em Firebase Console &rarr; Authentication
                    &rarr; Sign-in method.
                  </p>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleRefreshLists}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-stone-950 font-extrabold rounded-lg cursor-pointer"
                >
                  Testar Conexão Novamente
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
