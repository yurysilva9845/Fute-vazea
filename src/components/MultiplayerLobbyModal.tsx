import React, { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  Globe,
  Lock,
  LogIn,
  LogOut,
  Mic,
  MicOff,
  Play,
  Plus,
  Send,
  Shield,
  Sparkles,
  Swords,
  UserCheck,
  UserPlus,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import {
  MatchFormatMode,
  MultiplayerRoomState,
  MultiplayerSlot,
  OnlineUserProfile,
  RoomVisibility,
} from '../types/game';
import { getRoomParticipantCounts } from '../services/botService';
import {
  ALL_CHARACTERS,
  createOnlineRoom,
  FriendRequestDoc,
  getCurrentAuthUser,
  joinOnlineRoom,
  leaveOnlineRoom,
  linkGoogleAccount,
  respondToFriendRequest,
  selectRoomCharacter,
  sendFriendRequestByTag,
  sendRoomInviteToFriend,
  startOnlineMatch,
  subscribeToFriendsProfiles,
  subscribeToIncomingRequests,
  subscribeToMyProfile,
  subscribeToOnlinePlayers,
  subscribeToPublicRooms,
  subscribeToRoom,
  togglePlayerReadyInRoom,
  updateNickname,
} from '../services/firebase';
import { filterRoomsByMode, quickMatchOrCreateWithBots } from '../services/matchmakingService';
import { formatPlayerCareerSummary } from '../services/playerService';
import { presenceService } from '../services/presenceService';
import { isRoomJoinable } from '../services/roomService';
import { sessionCleanupService } from '../services/sessionCleanupService';
import { voiceChatService } from '../services/voiceChatService';
import { MatchLoadingOverlay } from './MatchLoadingOverlay';
import { VoiceControlsBar } from './VoiceControlsBar';

interface MultiplayerLobbyModalProps {
  homeTeamId: string;
  awayTeamId: string;
  halfDurationSeconds: number;
  activeRoomCode: string | null;
  onRoomJoined: (room: MultiplayerRoomState) => void;
  onRoomLeft: () => void;
  onStartMultiplayerMatch: (room: MultiplayerRoomState) => void;
  onClose: () => void;
}

export const MultiplayerLobbyModal: React.FC<MultiplayerLobbyModalProps> = ({
  homeTeamId,
  awayTeamId,
  halfDurationSeconds,
  activeRoomCode,
  onRoomJoined,
  onRoomLeft,
  onStartMultiplayerMatch,
  onClose,
}) => {
  const [tab, setTab] = useState<'modes' | 'public_rooms' | 'private_room' | 'room' | 'friends'>(
    activeRoomCode ? 'room' : 'modes'
  );

  // Modalidade selecionada: 2 CONTRA 2 ou 4 CONTRA 4
  const [selectedMode, setSelectedMode] = useState<MatchFormatMode>('4v4');

  const [myProfile, setMyProfile] = useState<(OnlineUserProfile & { friends: string[] }) | null>(
    null
  );
  const [nicknameInput, setNicknameInput] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Salas públicas e privadas
  const [publicRooms, setPublicRooms] = useState<MultiplayerRoomState[]>([]);
  const [currentRoom, setCurrentRoom] = useState<MultiplayerRoomState | null>(null);

  // Criação de sala (pública ou privada)
  const [createRoomName, setCreateRoomName] = useState('');
  const [createVisibility, setCreateVisibility] = useState<RoomVisibility>('public');
  const [createPassword, setCreatePassword] = useState('');
  const [createMaxHumans, setCreateMaxHumans] = useState<number>(8);
  const [createAutoFillBots, setCreateAutoFillBots] = useState<boolean>(true);

  // Entrada por código / senha
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [joinPasswordInput, setJoinPasswordInput] = useState('');
  const [passwordModalRoom, setPasswordModalRoom] = useState<MultiplayerRoomState | null>(null);
  const [modalPasswordInput, setModalPasswordInput] = useState('');

  // Estados de carregamento e feedback
  const [loadingOverlayType, setLoadingOverlayType] = useState<
    'connecting_lobby' | 'joining_room' | null
  >(null);
  const [loadingOverlayMessage, setLoadingOverlayMessage] = useState('');
  const [feedbackMsg, setFeedbackMsg] = useState<{ text: string; isError?: boolean } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Amigos e convites
  const [onlinePlayers, setOnlinePlayers] = useState<OnlineUserProfile[]>([]);
  const [friendsList, setFriendsList] = useState<OnlineUserProfile[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<FriendRequestDoc[]>([]);
  const [friendSearchInput, setFriendSearchInput] = useState('');

  // Atualiza maxHumans padrão ao trocar entre 2v2 e 4v4
  useEffect(() => {
    setCreateMaxHumans(selectedMode === '2v2' ? 4 : 8);
  }, [selectedMode]);

  useEffect(() => {
    sessionCleanupService.startPeriodicCleanup();
    const unsubProfile = subscribeToMyProfile((prof) => {
      setMyProfile(prof);
      if (prof && !nicknameInput) {
        setNicknameInput(prof.displayName);
      }
    });
    const unsubRooms = subscribeToPublicRooms((rooms) => {
      setPublicRooms(rooms);
    });
    const unsubOnline = subscribeToOnlinePlayers((players) => {
      setOnlinePlayers(players);
    });
    const unsubReqs = subscribeToIncomingRequests((reqs) => {
      setIncomingRequests(reqs);
    });

    return () => {
      unsubProfile();
      unsubRooms();
      unsubOnline();
      unsubReqs();
    };
  }, []);

  useEffect(() => {
    if (!myProfile || !myProfile.friends || myProfile.friends.length === 0) {
      setFriendsList([]);
      return;
    }
    const unsubFriends = subscribeToFriendsProfiles(myProfile.friends, (friends) => {
      setFriendsList(friends);
    });
    return () => unsubFriends();
  }, [myProfile?.friends?.join(',')]);

  useEffect(() => {
    if (!activeRoomCode) {
      setCurrentRoom(null);
      return;
    }
    const unsub = subscribeToRoom(activeRoomCode, (room) => {
      if (!room) {
        setCurrentRoom(null);
        presenceService.stopRoomPresence();
        voiceChatService.leaveRoomVoice();
        onRoomLeft();
        setTab('modes');
        return;
      }
      setCurrentRoom(room);
      presenceService.startRoomPresence(
        room.roomCode,
        room.status === 'playing' ? 'playing' : 'in_room'
      );
      voiceChatService.joinRoomVoice(room.roomCode, room.slots || {});
      onRoomJoined(room);

      if (room.status === 'playing') {
        onStartMultiplayerMatch(room);
      }
    });
    return () => unsub();
  }, [activeRoomCode]);

  const showToast = (text: string, isError = false) => {
    setFeedbackMsg({ text, isError });
    window.setTimeout(() => {
      setFeedbackMsg((prev) => (prev?.text === text ? null : prev));
    }, 4000);
  };

  const handleSaveNickname = async () => {
    if (!nicknameInput.trim()) return;
    setSavingName(true);
    try {
      await updateNickname(nicknameInput);
      showToast('Apelido atualizado com sucesso!');
    } catch {
      showToast('Não foi possível atualizar o apelido.', true);
    } finally {
      setSavingName(false);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      await linkGoogleAccount();
      showToast('Conta Google conectada com sucesso!');
    } catch {
      showToast('Login Google cancelado ou indisponível.', true);
    }
  };

  const handleCreateRoom = async (
    overrideVisibility?: RoomVisibility,
    overrideMode?: MatchFormatMode
  ) => {
    const modeToUse = overrideMode || selectedMode;
    const visToUse = overrideVisibility || createVisibility;

    if (visToUse === 'private' && !createPassword.trim()) {
      showToast('Defina uma senha para proteger sua Sala Privada.', true);
      return;
    }

    setLoadingOverlayType('joining_room');
    setLoadingOverlayMessage(
      `Criando sala ${modeToUse === '2v2' ? '2 CONTRA 2' : '4 CONTRA 4'}...`
    );

    try {
      const room = await createOnlineRoom(homeTeamId, awayTeamId, halfDurationSeconds, {
        roomName:
          createRoomName.trim() ||
          `SEM TERRA FC — SALA #${Math.floor(100 + Math.random() * 900)}`,
        mode: modeToUse,
        visibility: visToUse,
        password: visToUse === 'private' ? createPassword.trim() : '',
        maxHumans: Math.min(modeToUse === '2v2' ? 4 : 8, createMaxHumans),
        autoFillBots: createAutoFillBots,
      });
      setCurrentRoom(room);
      onRoomJoined(room);
      setTab('room');
      showToast(
        `Sala ${room.roomCode} (${modeToUse.toUpperCase()}) criada! Bots prontos nas vagas livres.`
      );
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Erro ao criar sala.', true);
    } finally {
      setLoadingOverlayType(null);
    }
  };

  const handleQuickPlayMode = async (mode: MatchFormatMode) => {
    setSelectedMode(mode);
    setLoadingOverlayType('joining_room');
    setLoadingOverlayMessage(
      `Buscando sala ${mode === '2v2' ? '2 CONTRA 2' : '4 CONTRA 4'} disponível...`
    );
    try {
      const { room, createdNew } = await quickMatchOrCreateWithBots(
        publicRooms,
        mode,
        homeTeamId,
        awayTeamId,
        halfDurationSeconds
      );
      setCurrentRoom(room);
      onRoomJoined(room);
      setTab('room');
      showToast(
        createdNew
          ? `Nova sala ${mode.toUpperCase()} (${room.roomCode}) criada com bots automáticos!`
          : `Você entrou na sala ${room.roomCode} (${mode.toUpperCase()})!`
      );
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Erro na busca rápida.', true);
    } finally {
      setLoadingOverlayType(null);
    }
  };

  const handleJoinRoom = async (
    code: string,
    password?: string,
    expectedMode?: MatchFormatMode
  ) => {
    if (!code.trim()) {
      showToast('Digite o código da sala.', true);
      return;
    }

    setLoadingOverlayType('joining_room');
    setLoadingOverlayMessage(`Entrando na sala ${code.trim().toUpperCase()}...`);
    try {
      const room = await joinOnlineRoom(code, password, expectedMode);
      if (room) {
        setPasswordModalRoom(null);
        setModalPasswordInput('');
        setCurrentRoom(room);
        onRoomJoined(room);
        setTab('room');
        showToast(`Conectado à sala ${room.roomCode}!`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Não foi possível entrar na sala.';
      if (msg.includes('SENHA_OBRIGATORIA')) {
        const target = publicRooms.find((r) => r.roomCode === code.trim().toUpperCase());
        if (target) {
          setPasswordModalRoom(target);
        } else {
          showToast('Esta sala é privada. Informe a senha da sala para entrar.', true);
        }
      } else {
        showToast(msg, true);
      }
    } finally {
      setLoadingOverlayType(null);
    }
  };

  const handleLeaveCurrentRoom = async () => {
    if (!currentRoom) return;
    const code = currentRoom.roomCode;
    presenceService.stopRoomPresence();
    voiceChatService.leaveRoomVoice();
    await leaveOnlineRoom(code);
    setCurrentRoom(null);
    onRoomLeft();
    setTab('modes');
    showToast('Você saiu da sala. Microfone e sessão desconectados.');
  };

  const handlePickCharacter = async (characterId: string) => {
    if (!currentRoom) return;
    const res = await selectRoomCharacter(currentRoom.roomCode, characterId);
    if (!res.ok && res.message) {
      showToast(res.message, true);
    }
  };

  const handleToggleReady = async () => {
    if (!currentRoom) return;
    await togglePlayerReadyInRoom(currentRoom.roomCode);
  };

  const handleHostStartMatch = async () => {
    if (!currentRoom) return;
    setLoadingOverlayType('joining_room');
    setLoadingOverlayMessage('Preparando o campinho e sincronizando bots...');
    try {
      await startOnlineMatch(currentRoom.roomCode);
    } catch {
      showToast('Erro ao iniciar a partida.', true);
    } finally {
      setLoadingOverlayType(null);
    }
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleAddFriend = async () => {
    if (!friendSearchInput.trim()) return;
    const res = await sendFriendRequestByTag(friendSearchInput);
    showToast(res.message, !res.ok);
    if (res.ok) setFriendSearchInput('');
  };

  const handleInviteFriendToRoom = async (friend: OnlineUserProfile) => {
    if (!currentRoom) {
      showToast('Crie ou entre em uma sala primeiro para convidar amigos!', true);
      return;
    }
    await sendRoomInviteToFriend(friend.uid, friend.displayName, currentRoom.roomCode);
    showToast(`Convite da sala ${currentRoom.roomCode} enviado para ${friend.displayName}!`);
  };

  const handleRespondRequest = async (req: FriendRequestDoc, accept: boolean) => {
    await respondToFriendRequest(req, accept);
    if (accept && req.type === 'room_invite' && req.roomCode) {
      await handleJoinRoom(req.roomCode);
    } else {
      showToast(accept ? 'Solicitação aceita!' : 'Solicitação recusada.');
    }
  };

  const currentUid = getCurrentAuthUser()?.uid || myProfile?.uid || '';
  const isHost = Boolean(currentRoom && currentRoom.hostUid === currentUid);
  const mySlotInRoom: MultiplayerSlot | undefined = currentRoom
    ? Object.values(currentRoom.slots || {}).find((s) => s.uid === currentUid)
    : undefined;

  const filteredRooms = filterRoomsByMode(publicRooms, selectedMode);
  const career = formatPlayerCareerSummary(myProfile);
  const pendingRoomInvites = incomingRequests.filter((r) => r.type === 'room_invite');

  return (
    <div className="fixed inset-0 z-50 bg-stone-950/90 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      {loadingOverlayType && (
        <MatchLoadingOverlay
          type={loadingOverlayType}
          customMessage={loadingOverlayMessage}
          onRetryOrCancel={() => setLoadingOverlayType(null)}
        />
      )}

      {/* Modal de Senha para Sala Privada */}
      {passwordModalRoom && (
        <div className="fixed inset-0 z-[65] bg-stone-950/85 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-stone-900 border-2 border-amber-500 rounded p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-amber-400 font-black uppercase text-sm">
                <Lock className="w-4 h-4" />
                Sala Privada ({passwordModalRoom.roomCode})
              </div>
              <button
                type="button"
                onClick={() => {
                  setPasswordModalRoom(null);
                  setModalPasswordInput('');
                }}
                className="text-stone-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-stone-300">
              Digite a senha definida por <strong>{passwordModalRoom.hostName}</strong> para entrar em{' '}
              <strong>{passwordModalRoom.roomName}</strong>:
            </p>
            <input
              type="password"
              value={modalPasswordInput}
              onChange={(e) => setModalPasswordInput(e.target.value)}
              placeholder="Senha da sala..."
              className="w-full bg-stone-950 border border-stone-700 px-3 py-2 text-sm text-white rounded focus:outline-none focus:border-amber-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPasswordModalRoom(null);
                  setModalPasswordInput('');
                }}
                className="px-3 py-1.5 bg-stone-800 text-stone-300 text-xs font-bold uppercase rounded cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() =>
                  handleJoinRoom(
                    passwordModalRoom.roomCode,
                    modalPasswordInput,
                    passwordModalRoom.mode
                  )
                }
                className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs font-black uppercase rounded cursor-pointer"
              >
                Entrar na Sala
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="w-full max-w-5xl bg-stone-900 border-2 border-stone-700 shadow-2xl overflow-hidden flex flex-col max-h-[94vh]">
        {/* Top Bar */}
        <div className="bg-stone-950 px-4 py-3 border-b border-stone-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded bg-amber-500 text-stone-950 font-black text-xs flex items-center justify-center">
              STF
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-black uppercase tracking-tight text-white">
                SEM TERRA FC — MULTIPLAYER ONLINE
              </h2>
              <p className="text-[11px] text-stone-400">
                Salas Públicas e Privadas · 2 contra 2 e 4 contra 4 · Bots Automáticos & Voz WebRTC
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {myProfile && (
              <div className="hidden md:flex items-center gap-2 bg-stone-900 border border-stone-800 px-2.5 py-1 rounded text-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-bold text-white">{myProfile.displayName}</span>
                <span className="font-mono text-amber-400 font-bold">{myProfile.tagCode}</span>
                <span className="text-stone-500">|</span>
                <span className="text-emerald-400 font-bold">{career.wins}V</span>
                <span className="text-stone-400">{career.draws}E</span>
                <span className="text-red-400">{career.losses}D</span>
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 bg-stone-800 hover:bg-stone-700 text-stone-300 rounded cursor-pointer"
              title="Fechar Lobby"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Banner de Convite de Sala Recebido */}
        {pendingRoomInvites.length > 0 && (
          <div className="bg-amber-500/20 border-b border-amber-500/50 px-4 py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-200">
              <Sparkles className="w-4 h-4 text-amber-400 animate-bounce" />
              <span>
                <strong>{pendingRoomInvites[0].fromName}</strong> convidou você para jogar na sala{' '}
                <strong className="font-mono text-amber-300">
                  {pendingRoomInvites[0].roomCode}
                </strong>
                !
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleRespondRequest(pendingRoomInvites[0], true)}
                className="bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-black text-[11px] uppercase px-3 py-1 rounded cursor-pointer"
              >
                Aceitar e Entrar
              </button>
              <button
                type="button"
                onClick={() => handleRespondRequest(pendingRoomInvites[0], false)}
                className="bg-stone-800 hover:bg-stone-700 text-stone-300 font-bold text-[11px] uppercase px-2.5 py-1 rounded cursor-pointer"
              >
                Recusar
              </button>
            </div>
          </div>
        )}

        {/* Profile & Mode Selector Bar */}
        <div className="bg-stone-900/90 px-4 py-2.5 border-b border-stone-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-wider text-stone-400">
              Seu Nome:
            </span>
            <input
              type="text"
              value={nicknameInput}
              onChange={(e) => setNicknameInput(e.target.value)}
              maxLength={24}
              placeholder="Seu apelido na várzea"
              className="bg-stone-950 border border-stone-700 px-2.5 py-1 text-xs text-white font-bold rounded focus:outline-none focus:border-amber-500 w-36 sm:w-44"
            />
            <button
              type="button"
              onClick={handleSaveNickname}
              disabled={savingName}
              className="bg-stone-800 hover:bg-stone-700 text-amber-400 border border-amber-500/40 px-2.5 py-1 text-xs font-bold uppercase rounded cursor-pointer"
            >
              {savingName ? '...' : 'Salvar'}
            </button>
            {myProfile && (
              <span className="text-[11px] text-stone-400 font-mono">
                Tag: <strong className="text-amber-300">{myProfile.tagCode}</strong>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleGoogleLogin}
              className="flex items-center gap-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700 px-2.5 py-1 text-xs font-bold rounded cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5 text-amber-400" />
              Vincular Conta Google
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-stone-800 bg-stone-950/60 px-4 gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => setTab('modes')}
            className={`px-3.5 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
              tab === 'modes'
                ? 'border-amber-500 text-amber-400 bg-stone-900/60'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            1. Modalidades (2v2 / 4v4)
          </button>

          <button
            type="button"
            onClick={() => setTab('public_rooms')}
            className={`px-3.5 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
              tab === 'public_rooms'
                ? 'border-amber-500 text-amber-400 bg-stone-900/60'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            2. Salas Públicas ({filteredRooms.length})
          </button>

          <button
            type="button"
            onClick={() => setTab('private_room')}
            className={`px-3.5 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
              tab === 'private_room'
                ? 'border-amber-500 text-amber-400 bg-stone-900/60'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            3. Salas Privadas
          </button>

          <button
            type="button"
            onClick={() => setTab('room')}
            className={`px-3.5 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1.5 ${
              tab === 'room'
                ? 'border-amber-500 text-amber-400 bg-stone-900/60'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            4. Sala de Equipes
            {currentRoom && (
              <span className="bg-emerald-500 text-stone-950 text-[10px] font-black px-1.5 py-0.2 rounded">
                {currentRoom.roomCode}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setTab('friends')}
            className={`px-3.5 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1.5 ${
              tab === 'friends'
                ? 'border-amber-500 text-amber-400 bg-stone-900/60'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            5. Amigos & Convites
            {incomingRequests.length > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-black px-1.5 py-0.2 rounded-full">
                {incomingRequests.length}
              </span>
            )}
          </button>
        </div>

        {/* Toast Feedback */}
        {feedbackMsg && (
          <div
            className={`px-4 py-2 text-xs font-bold flex items-center justify-between ${
              feedbackMsg.isError
                ? 'bg-red-950/90 text-red-200 border-b border-red-800'
                : 'bg-emerald-950/90 text-emerald-200 border-b border-emerald-800'
            }`}
          >
            <span>{feedbackMsg.text}</span>
            <button
              type="button"
              onClick={() => setFeedbackMsg(null)}
              className="text-stone-400 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Main Content Area */}
        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          {/* TAB 1: ESCOLHA DE MODALIDADE (2 CONTRA 2 vs 4 CONTRA 4) */}
          {tab === 'modes' && (
            <div className="space-y-4">
              <div className="bg-stone-950/80 border border-stone-800 p-4 rounded">
                <h3 className="text-sm font-black uppercase tracking-wider text-amber-400">
                  Escolha o Formato da Partida Online
                </h3>
                <p className="text-xs text-stone-300 mt-1">
                  Cada modalidade possui salas independentes. Os bots completam automaticamente todas
                  as vagas sem jogadores humanos — você pode iniciar mesmo jogando sozinho!
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Card 2 CONTRA 2 */}
                <div
                  onClick={() => setSelectedMode('2v2')}
                  className={`p-5 rounded border-2 transition-all cursor-pointer flex flex-col justify-between ${
                    selectedMode === '2v2'
                      ? 'bg-amber-500/10 border-amber-500 shadow-xl'
                      : 'bg-stone-950/70 border-stone-800 hover:border-stone-700'
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-black uppercase tracking-widest px-2.5 py-0.5 rounded bg-amber-500 text-stone-950">
                        DUPLAS NA TERRA
                      </span>
                      <span className="text-xs font-mono font-bold text-stone-400">
                        Até 4 Humanos · 4 em Campo
                      </span>
                    </div>
                    <h4 className="text-2xl font-black uppercase text-white tracking-tight">
                      2 CONTRA 2
                    </h4>
                    <p className="text-xs text-stone-300 leading-relaxed">
                      Dois jogadores em cada equipe (livre escolha de 2 entre os 4 personagens por
                      time). Ritmo acelerado nas travinhas de mini campo, com bots completando as
                      vagas restantes.
                    </p>
                  </div>

                  <div className="pt-4 mt-4 border-t border-stone-800/80 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleQuickPlayMode('2v2');
                      }}
                      className="flex-1 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs uppercase py-2.5 px-3 rounded flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Play className="w-4 h-4 fill-stone-950" />
                      Jogar 2v2 Agora
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedMode('2v2');
                        setTab('public_rooms');
                      }}
                      className="bg-stone-800 hover:bg-stone-700 text-stone-200 font-bold text-xs uppercase py-2.5 px-3 rounded cursor-pointer"
                    >
                      Ver Salas 2v2
                    </button>
                  </div>
                </div>

                {/* Card 4 CONTRA 4 */}
                <div
                  onClick={() => setSelectedMode('4v4')}
                  className={`p-5 rounded border-2 transition-all cursor-pointer flex flex-col justify-between ${
                    selectedMode === '4v4'
                      ? 'bg-amber-500/10 border-amber-500 shadow-xl'
                      : 'bg-stone-950/70 border-stone-800 hover:border-stone-700'
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-black uppercase tracking-widest px-2.5 py-0.5 rounded bg-emerald-500 text-stone-950">
                        CLÁSSICO COMPLETO
                      </span>
                      <span className="text-xs font-mono font-bold text-stone-400">
                        Até 8 Humanos · 8 em Campo
                      </span>
                    </div>
                    <h4 className="text-2xl font-black uppercase text-white tracking-tight">
                      4 CONTRA 4
                    </h4>
                    <p className="text-xs text-stone-300 leading-relaxed">
                      Quatro jogadores em cada equipe: Time 1 (Yuri, Josué, Careca e Bode) contra
                      Time 2 (Primo, Bicudo, Ismael e Felipe). Bots assumem todas as vagas não
                      preenchidas por humanos.
                    </p>
                  </div>

                  <div className="pt-4 mt-4 border-t border-stone-800/80 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleQuickPlayMode('4v4');
                      }}
                      className="flex-1 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs uppercase py-2.5 px-3 rounded flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Play className="w-4 h-4 fill-stone-950" />
                      Jogar 4v4 Agora
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedMode('4v4');
                        setTab('public_rooms');
                      }}
                      className="bg-stone-800 hover:bg-stone-700 text-stone-200 font-bold text-xs uppercase py-2.5 px-3 rounded cursor-pointer"
                    >
                      Ver Salas 4v4
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: SALAS PÚBLICAS */}
          {tab === 'public_rooms' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-stone-950/80 border border-stone-800 p-3.5 rounded">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black uppercase text-stone-300">
                    Filtrar Modalidade:
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedMode('2v2')}
                    className={`px-3 py-1.5 rounded text-xs font-black uppercase cursor-pointer ${
                      selectedMode === '2v2'
                        ? 'bg-amber-500 text-stone-950'
                        : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
                    }`}
                  >
                    2 CONTRA 2
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedMode('4v4')}
                    className={`px-3 py-1.5 rounded text-xs font-black uppercase cursor-pointer ${
                      selectedMode === '4v4'
                        ? 'bg-amber-500 text-stone-950'
                        : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
                    }`}
                  >
                    4 CONTRA 4
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCreateRoom('public', selectedMode)}
                    className="bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-black text-xs uppercase px-3.5 py-2 rounded flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    Criar Sala Pública ({selectedMode.toUpperCase()})
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                {filteredRooms.length === 0 ? (
                  <div className="bg-stone-950/60 border border-stone-800/80 p-8 text-center rounded space-y-3">
                    <Globe className="w-8 h-8 text-stone-600 mx-auto" />
                    <div className="text-sm font-bold text-stone-300">
                      Nenhuma sala na modalidade {selectedMode.toUpperCase()} aberta no momento.
                    </div>
                    <p className="text-xs text-stone-500 max-w-md mx-auto">
                      Crie uma sala pública agora mesmo e jogue imediatamente com bots enquanto
                      outros jogadores entram!
                    </p>
                    <button
                      type="button"
                      onClick={() => handleCreateRoom('public', selectedMode)}
                      className="bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs uppercase px-4 py-2 rounded inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      Criar Sala {selectedMode.toUpperCase()} com Bots
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {filteredRooms.map((room) => {
                      const counts = getRoomParticipantCounts(room);
                      const joinStatus = isRoomJoinable(room);
                      const isPrivate = room.visibility === 'private' || room.hasPassword;

                      return (
                        <div
                          key={room.roomCode}
                          className="bg-stone-950 border border-stone-800 hover:border-amber-500/50 p-4 rounded flex flex-col justify-between gap-3 transition-colors"
                        >
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-black text-sm uppercase text-white truncate">
                                {room.roomName || `SEM TERRA FC — SALA #${room.roomCode}`}
                              </span>
                              <span className="font-mono font-black text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded">
                                {room.roomCode}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
                              <span className="px-2 py-0.5 rounded bg-stone-800 text-amber-300 uppercase">
                                MODO: {counts.mode === '2v2' ? '2 CONTRA 2' : '4 CONTRA 4'}
                              </span>
                              <span className="px-2 py-0.5 rounded bg-stone-800 text-stone-200">
                                {counts.humanCount}/{counts.maxHumans} JOGADORES
                              </span>
                              <span className="px-2 py-0.5 rounded bg-stone-900 text-stone-400 border border-stone-800">
                                +{counts.botCount} Bots
                              </span>
                              {isPrivate && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-700/50">
                                  <Lock className="w-3 h-3" /> Privada
                                </span>
                              )}
                            </div>

                            <div className="flex items-center justify-between text-[11px] text-stone-400 pt-1">
                              <span>Anfitrião: {room.hostName}</span>
                              <span
                                className={
                                  room.status === 'waiting'
                                    ? 'text-emerald-400 font-bold'
                                    : 'text-amber-400 font-bold'
                                }
                              >
                                Status:{' '}
                                {room.status === 'waiting'
                                  ? 'Aguardando jogadores'
                                  : 'Em andamento'}
                              </span>
                            </div>
                          </div>

                          <button
                            type="button"
                            disabled={!joinStatus.joinable}
                            onClick={() => {
                              if (isPrivate) {
                                setPasswordModalRoom(room);
                              } else {
                                handleJoinRoom(room.roomCode, undefined, counts.mode);
                              }
                            }}
                            className={`w-full py-2 rounded font-black text-xs uppercase tracking-wider transition-colors ${
                              joinStatus.joinable
                                ? 'bg-amber-500 hover:bg-amber-400 text-stone-950 cursor-pointer'
                                : 'bg-stone-800 text-stone-500 cursor-not-allowed'
                            }`}
                          >
                            {joinStatus.joinable
                              ? 'ENTRAR NA SALA'
                              : joinStatus.reason || 'Indisponível'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: SALAS PRIVADAS (CRIAR COM SENHA OU ENTRAR POR CÓDIGO) */}
          {tab === 'private_room' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Criar Sala Personalizada / Privada */}
              <div className="bg-stone-950/90 border border-stone-800 p-4 rounded space-y-3.5">
                <div className="flex items-center gap-2 text-amber-400 font-black uppercase text-sm">
                  <Lock className="w-4 h-4" />
                  Criar Sala Privada ou Personalizada
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold uppercase text-stone-400">
                    Nome da Sala
                  </label>
                  <input
                    type="text"
                    value={createRoomName}
                    onChange={(e) => setCreateRoomName(e.target.value)}
                    placeholder="Ex: SEM TERRA FC — Racha dos Amigos"
                    maxLength={48}
                    className="w-full bg-stone-900 border border-stone-700 px-3 py-2 text-xs text-white rounded focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase text-stone-400">
                      Modalidade
                    </label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSelectedMode('2v2')}
                        className={`py-1.5 text-xs font-black uppercase rounded cursor-pointer ${
                          selectedMode === '2v2'
                            ? 'bg-amber-500 text-stone-950'
                            : 'bg-stone-900 text-stone-400 border border-stone-800'
                        }`}
                      >
                        2v2
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedMode('4v4')}
                        className={`py-1.5 text-xs font-black uppercase rounded cursor-pointer ${
                          selectedMode === '4v4'
                            ? 'bg-amber-500 text-stone-950'
                            : 'bg-stone-900 text-stone-400 border border-stone-800'
                        }`}
                      >
                        4v4
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase text-stone-400">
                      Tipo de Sala
                    </label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setCreateVisibility('private')}
                        className={`py-1.5 text-xs font-black uppercase rounded cursor-pointer ${
                          createVisibility === 'private'
                            ? 'bg-amber-500 text-stone-950'
                            : 'bg-stone-900 text-stone-400 border border-stone-800'
                        }`}
                      >
                        Privada
                      </button>
                      <button
                        type="button"
                        onClick={() => setCreateVisibility('public')}
                        className={`py-1.5 text-xs font-black uppercase rounded cursor-pointer ${
                          createVisibility === 'public'
                            ? 'bg-emerald-500 text-stone-950'
                            : 'bg-stone-900 text-stone-400 border border-stone-800'
                        }`}
                      >
                        Pública
                      </button>
                    </div>
                  </div>
                </div>

                {createVisibility === 'private' && (
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase text-stone-400">
                      Senha da Sala Privada
                    </label>
                    <input
                      type="password"
                      value={createPassword}
                      onChange={(e) => setCreatePassword(e.target.value)}
                      placeholder="Digite uma senha para os convidados..."
                      maxLength={32}
                      className="w-full bg-stone-900 border border-stone-700 px-3 py-2 text-xs text-white rounded focus:outline-none focus:border-amber-500"
                    />
                  </div>
                )}

                <div className="flex items-center justify-between bg-stone-900 px-3 py-2 rounded border border-stone-800">
                  <div>
                    <div className="text-xs font-bold text-stone-200">
                      Preenchimento Automático com Bots
                    </div>
                    <div className="text-[10px] text-stone-400">
                      Bots completam as vagas livres para {selectedMode === '2v2' ? '4' : '8'} jogadores
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={createAutoFillBots}
                    onChange={(e) => setCreateAutoFillBots(e.target.checked)}
                    className="w-4 h-4 accent-amber-500 cursor-pointer"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => handleCreateRoom(createVisibility, selectedMode)}
                  className="w-full bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs uppercase py-2.5 rounded flex items-center justify-center gap-2 cursor-pointer shadow-lg"
                >
                  <Plus className="w-4 h-4" />
                  Criar Sala {createVisibility === 'private' ? 'Privada' : 'Pública'} (
                  {selectedMode.toUpperCase()})
                </button>
              </div>

              {/* Entrar em Sala Privada por Código + Senha */}
              <div className="bg-stone-950/90 border border-stone-800 p-4 rounded space-y-3.5 flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-emerald-400 font-black uppercase text-sm">
                    <Swords className="w-4 h-4" />
                    Entrar com Código da Sala
                  </div>
                  <p className="text-xs text-stone-400">
                    Recebeu o código exclusivo de um amigo? Digite o código e a senha (caso seja
                    uma sala privada) para entrar direto no lobby:
                  </p>

                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase text-stone-400">
                      Código da Sala (Ex: STF-8421)
                    </label>
                    <input
                      type="text"
                      value={joinCodeInput}
                      onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                      placeholder="STF-XXXX"
                      maxLength={12}
                      className="w-full bg-stone-900 border border-stone-700 px-3 py-2 text-xs font-mono uppercase text-white rounded focus:outline-none focus:border-amber-500"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase text-stone-400">
                      Senha da Sala (se for privada)
                    </label>
                    <input
                      type="password"
                      value={joinPasswordInput}
                      onChange={(e) => setJoinPasswordInput(e.target.value)}
                      placeholder="Deixe em branco se for pública"
                      maxLength={32}
                      className="w-full bg-stone-900 border border-stone-700 px-3 py-2 text-xs text-white rounded focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleJoinRoom(joinCodeInput, joinPasswordInput)}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-black text-xs uppercase py-2.5 rounded flex items-center justify-center gap-2 cursor-pointer"
                >
                  <LogIn className="w-4 h-4" />
                  Validar e Entrar na Sala
                </button>
              </div>
            </div>
          )}

          {/* TAB 4: SALA DE EQUIPES (LOBBY DA PARTIDA) */}
          {tab === 'room' && (
            <div>
              {!currentRoom ? (
                <div className="bg-stone-950/70 border border-stone-800 p-8 text-center rounded space-y-3">
                  <p className="text-sm text-stone-400 font-bold">
                    Você ainda não está em nenhuma sala.
                  </p>
                  <div className="flex justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleQuickPlayMode('2v2')}
                      className="bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs uppercase px-4 py-2 rounded cursor-pointer"
                    >
                      Criar / Entrar 2v2
                    </button>
                    <button
                      type="button"
                      onClick={() => handleQuickPlayMode('4v4')}
                      className="bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-black text-xs uppercase px-4 py-2 rounded cursor-pointer"
                    >
                      Criar / Entrar 4v4
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Cabeçalho da Sala */}
                  {(() => {
                    const counts = getRoomParticipantCounts(currentRoom);
                    const activeSet = new Set(currentRoom.activeCharacterIds || []);
                    return (
                      <>
                        <div className="bg-stone-950 border border-stone-800 p-3.5 rounded flex flex-wrap items-center justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-black uppercase px-2 py-0.5 rounded bg-amber-500 text-stone-950">
                                {counts.mode === '2v2' ? '2 CONTRA 2' : '4 CONTRA 4'}
                              </span>
                              <span className="font-black text-base uppercase text-white">
                                {currentRoom.roomName}
                              </span>
                              <span className="font-mono font-black text-sm text-amber-400">
                                ({currentRoom.roomCode})
                              </span>
                              <button
                                type="button"
                                onClick={() => handleCopyCode(currentRoom.roomCode)}
                                className="flex items-center gap-1 bg-stone-800 hover:bg-stone-700 text-stone-200 px-2 py-0.5 text-[11px] font-bold rounded cursor-pointer"
                              >
                                {copiedCode ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                {copiedCode ? 'Copiado!' : 'Copiar Código'}
                              </button>
                            </div>
                            <p className="text-[11px] text-stone-400">
                              Jogadores Humanos:{' '}
                              <strong className="text-white">
                                {counts.humanCount}/{counts.maxHumans}
                              </strong>{' '}
                              · Bots Automáticos Ativos:{' '}
                              <strong className="text-amber-400">{counts.botCount}</strong> · Clique
                              em qualquer personagem livre para escolhê-lo.
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            {mySlotInRoom && (
                              <button
                                type="button"
                                onClick={handleToggleReady}
                                className={`px-3.5 py-2 text-xs font-black uppercase rounded flex items-center gap-1.5 cursor-pointer transition-colors ${
                                  mySlotInRoom.isReady
                                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                                    : 'bg-stone-800 hover:bg-stone-700 text-amber-300 border border-amber-500/40'
                                }`}
                              >
                                <Check className="w-4 h-4" />
                                {mySlotInRoom.isReady ? 'PRONTO!' : 'MARCAR PRONTO'}
                              </button>
                            )}

                            {isHost ? (
                              <button
                                type="button"
                                onClick={handleHostStartMatch}
                                className="bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs uppercase px-4 py-2 rounded flex items-center gap-1.5 shadow-lg cursor-pointer"
                              >
                                <Play className="w-4 h-4 fill-stone-950" />
                                {counts.humanCount === 1
                                  ? 'Iniciar com Bots Agora'
                                  : 'Iniciar Partida'}
                              </button>
                            ) : (
                              <div className="bg-stone-900 border border-amber-500/30 text-amber-300 px-3 py-2 text-xs font-bold rounded flex items-center gap-1.5">
                                <Wifi className="w-3.5 h-3.5 animate-pulse" />
                                Aguardando {currentRoom.hostName} iniciar...
                              </div>
                            )}

                            <button
                              type="button"
                              onClick={handleLeaveCurrentRoom}
                              className="bg-red-950/80 hover:bg-red-900 text-red-200 border border-red-800 px-3 py-2 text-xs font-bold uppercase rounded flex items-center gap-1 cursor-pointer"
                            >
                              <LogOut className="w-3.5 h-3.5" />
                              Sair da Sala
                            </button>
                          </div>
                        </div>

                        {/* Controles de Voz WebRTC da Sala */}
                        <VoiceControlsBar roomCode={currentRoom.roomCode} />

                        {/* Distribuição de Equipes: TIME 1 vs TIME 2 */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* TIME 1 (Home) */}
                          <div className="bg-stone-950/80 border border-amber-500/30 p-3.5 rounded space-y-2.5">
                            <div className="flex items-center justify-between border-b border-stone-800 pb-2">
                              <span className="text-xs font-black uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                                <Shield className="w-4 h-4" />
                                TIME 1 — Yuri, Josué, Careca, Bode
                              </span>
                              <span className="text-[10px] text-stone-400 uppercase font-bold">
                                {counts.mode === '2v2' ? '2 Ativos em Campo' : '4 Ativos em Campo'}
                              </span>
                            </div>

                            <div className="space-y-2">
                              {ALL_CHARACTERS.filter((c) => c.team === 'home').map((char) => {
                                const slot = currentRoom.slots?.[char.id];
                                const isMine = slot?.uid === currentUid;
                                const isOccupiedByOther =
                                  slot && !slot.isBot && slot.uid !== currentUid;
                                const isActiveInMatch =
                                  counts.mode === '4v4' || activeSet.has(char.id);

                                return (
                                  <button
                                    key={char.id}
                                    type="button"
                                    disabled={Boolean(isOccupiedByOther)}
                                    onClick={() => handlePickCharacter(char.id)}
                                    className={`w-full p-2.5 rounded border text-left flex items-center justify-between transition-all ${
                                      isMine
                                        ? 'bg-amber-500/20 border-amber-400 text-white shadow-md'
                                        : isOccupiedByOther
                                        ? 'bg-stone-900/90 border-stone-700 text-stone-300 cursor-not-allowed'
                                        : 'bg-stone-900/50 hover:bg-stone-800 border-stone-800 text-stone-300 cursor-pointer'
                                    }`}
                                  >
                                    <div className="flex items-center gap-2.5">
                                      <div
                                        className="w-8 h-8 rounded-full flex items-center justify-center font-black text-xs border border-white/20"
                                        style={{
                                          backgroundColor: char.config.shirtPrimary,
                                          color: '#fff',
                                        }}
                                      >
                                        {char.config.number}
                                      </div>
                                      <div>
                                        <div className="font-black text-xs uppercase flex items-center gap-1.5">
                                          {char.name}
                                          <span className="text-[10px] font-normal text-stone-400 uppercase">
                                            ({char.config.role})
                                          </span>
                                          {!isActiveInMatch && (
                                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-stone-800 text-stone-500">
                                              Reserva 2v2
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-[11px] flex items-center gap-1.5 mt-0.5">
                                          {slot?.isBot ? (
                                            <span className="text-stone-400 flex items-center gap-1">
                                              <Bot className="w-3 h-3 text-amber-500" />
                                              {isActiveInMatch
                                                ? `Bot ${char.name} (Automático)`
                                                : 'Disponível p/ Escolha'}
                                            </span>
                                          ) : (
                                            <span className="text-emerald-400 font-bold flex items-center gap-1">
                                              <UserCheck className="w-3 h-3" />
                                              {slot?.displayName} {isMine ? '(Você)' : ''}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-1.5">
                                      {!slot?.isBot && (
                                        <>
                                          {slot?.isSpeaking ? (
                                            <span
                                              className="p-1 rounded bg-emerald-500/20 text-emerald-400 animate-pulse"
                                              title="Falando no microfone"
                                            >
                                              <Mic className="w-3.5 h-3.5" />
                                            </span>
                                          ) : slot?.micEnabled ? (
                                            <span
                                              className="p-1 rounded bg-stone-800 text-stone-300"
                                              title="Microfone ligado"
                                            >
                                              <Mic className="w-3.5 h-3.5" />
                                            </span>
                                          ) : (
                                            <span
                                              className="p-1 rounded bg-stone-900 text-stone-500"
                                              title="Microfone mutado"
                                            >
                                              <MicOff className="w-3.5 h-3.5" />
                                            </span>
                                          )}

                                          <span
                                            className={`text-[10px] font-black uppercase px-2 py-0.5 rounded ${
                                              slot?.isReady
                                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                                : 'bg-amber-500/20 text-amber-300'
                                            }`}
                                          >
                                            {slot?.isReady ? 'PRONTO' : 'ESCOLHENDO'}
                                          </span>
                                        </>
                                      )}

                                      {slot?.isBot && (
                                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 bg-stone-800 text-stone-400 rounded">
                                          Escolher
                                        </span>
                                      )}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {/* TIME 2 (Away) */}
                          <div className="bg-stone-950/80 border border-red-500/30 p-3.5 rounded space-y-2.5">
                            <div className="flex items-center justify-between border-b border-stone-800 pb-2">
                              <span className="text-xs font-black uppercase tracking-wider text-red-400 flex items-center gap-1.5">
                                <Shield className="w-4 h-4" />
                                TIME 2 — Primo, Bicudo, Ismael, Felipe
                              </span>
                              <span className="text-[10px] text-stone-400 uppercase font-bold">
                                {counts.mode === '2v2' ? '2 Ativos em Campo' : '4 Ativos em Campo'}
                              </span>
                            </div>

                            <div className="space-y-2">
                              {ALL_CHARACTERS.filter((c) => c.team === 'away').map((char) => {
                                const slot = currentRoom.slots?.[char.id];
                                const isMine = slot?.uid === currentUid;
                                const isOccupiedByOther =
                                  slot && !slot.isBot && slot.uid !== currentUid;
                                const isActiveInMatch =
                                  counts.mode === '4v4' || activeSet.has(char.id);

                                return (
                                  <button
                                    key={char.id}
                                    type="button"
                                    disabled={Boolean(isOccupiedByOther)}
                                    onClick={() => handlePickCharacter(char.id)}
                                    className={`w-full p-2.5 rounded border text-left flex items-center justify-between transition-all ${
                                      isMine
                                        ? 'bg-red-500/20 border-red-400 text-white shadow-md'
                                        : isOccupiedByOther
                                        ? 'bg-stone-900/90 border-stone-700 text-stone-300 cursor-not-allowed'
                                        : 'bg-stone-900/50 hover:bg-stone-800 border-stone-800 text-stone-300 cursor-pointer'
                                    }`}
                                  >
                                    <div className="flex items-center gap-2.5">
                                      <div
                                        className="w-8 h-8 rounded-full flex items-center justify-center font-black text-xs border border-white/20"
                                        style={{
                                          backgroundColor: char.config.shirtPrimary,
                                          color: '#fff',
                                        }}
                                      >
                                        {char.config.number}
                                      </div>
                                      <div>
                                        <div className="font-black text-xs uppercase flex items-center gap-1.5">
                                          {char.name}
                                          <span className="text-[10px] font-normal text-stone-400 uppercase">
                                            ({char.config.role})
                                          </span>
                                          {!isActiveInMatch && (
                                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-stone-800 text-stone-500">
                                              Reserva 2v2
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-[11px] flex items-center gap-1.5 mt-0.5">
                                          {slot?.isBot ? (
                                            <span className="text-stone-400 flex items-center gap-1">
                                              <Bot className="w-3 h-3 text-red-400" />
                                              {isActiveInMatch
                                                ? `Bot ${char.name} (Automático)`
                                                : 'Disponível p/ Escolha'}
                                            </span>
                                          ) : (
                                            <span className="text-emerald-400 font-bold flex items-center gap-1">
                                              <UserCheck className="w-3 h-3" />
                                              {slot?.displayName} {isMine ? '(Você)' : ''}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-1.5">
                                      {!slot?.isBot && (
                                        <>
                                          {slot?.isSpeaking ? (
                                            <span
                                              className="p-1 rounded bg-emerald-500/20 text-emerald-400 animate-pulse"
                                              title="Falando no microfone"
                                            >
                                              <Mic className="w-3.5 h-3.5" />
                                            </span>
                                          ) : slot?.micEnabled ? (
                                            <span
                                              className="p-1 rounded bg-stone-800 text-stone-300"
                                              title="Microfone ligado"
                                            >
                                              <Mic className="w-3.5 h-3.5" />
                                            </span>
                                          ) : (
                                            <span
                                              className="p-1 rounded bg-stone-900 text-stone-500"
                                              title="Microfone mutado"
                                            >
                                              <MicOff className="w-3.5 h-3.5" />
                                            </span>
                                          )}

                                          <span
                                            className={`text-[10px] font-black uppercase px-2 py-0.5 rounded ${
                                              slot?.isReady
                                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                                : 'bg-amber-500/20 text-amber-300'
                                            }`}
                                          >
                                            {slot?.isReady ? 'PRONTO' : 'ESCOLHENDO'}
                                          </span>
                                        </>
                                      )}

                                      {slot?.isBot && (
                                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 bg-stone-800 text-stone-400 rounded">
                                          Escolher
                                        </span>
                                      )}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* TAB 5: AMIGOS & CONVITES */}
          {tab === 'friends' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Coluna Esquerda: Adicionar Amigo + Solicitações */}
              <div className="space-y-4">
                <div className="bg-stone-950/80 border border-stone-800 p-3.5 rounded space-y-2.5">
                  <h4 className="text-xs font-black uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                    <UserPlus className="w-4 h-4" />
                    Adicionar Amigo por Tag (#STF) ou Nome
                  </h4>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={friendSearchInput}
                      onChange={(e) => setFriendSearchInput(e.target.value)}
                      placeholder="Ex: #STF1A2B ou nome"
                      className="flex-1 bg-stone-900 border border-stone-700 px-3 py-1.5 text-xs text-white rounded focus:outline-none focus:border-amber-500"
                    />
                    <button
                      type="button"
                      onClick={handleAddFriend}
                      className="bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs uppercase px-3 py-1.5 rounded flex items-center gap-1 cursor-pointer"
                    >
                      <Send className="w-3.5 h-3.5" />
                      Enviar
                    </button>
                  </div>
                </div>

                {/* Convites e Pedidos Pendentes */}
                <div className="bg-stone-950/80 border border-stone-800 p-3.5 rounded space-y-2.5">
                  <h4 className="text-xs font-black uppercase tracking-wider text-stone-300">
                    Convites e Solicitações Recebidas ({incomingRequests.length})
                  </h4>
                  {incomingRequests.length === 0 ? (
                    <p className="text-xs text-stone-500 py-2">
                      Nenhuma solicitação pendente no momento.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {incomingRequests.map((req) => (
                        <div
                          key={req.id}
                          className="bg-stone-900 border border-stone-800 p-2.5 rounded flex items-center justify-between gap-2"
                        >
                          <div>
                            <div className="text-xs font-bold text-white">
                              {req.fromName}{' '}
                              <span className="text-amber-400 font-mono text-[10px]">
                                {req.fromTag}
                              </span>
                            </div>
                            <div className="text-[11px] text-stone-400">
                              {req.type === 'room_invite'
                                ? `Convidou você para a sala ${req.roomCode}`
                                : 'Quer adicionar você como amigo'}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleRespondRequest(req, true)}
                              className="bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-black text-[11px] uppercase px-2.5 py-1 rounded cursor-pointer"
                            >
                              {req.type === 'room_invite' ? 'Entrar' : 'Aceitar'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRespondRequest(req, false)}
                              className="bg-stone-800 hover:bg-stone-700 text-stone-400 font-bold text-[11px] uppercase px-2 py-1 rounded cursor-pointer"
                            >
                              Recusar
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Coluna Direita: Lista de Amigos e Jogadores Online */}
              <div className="space-y-4">
                <div className="bg-stone-950/80 border border-stone-800 p-3.5 rounded space-y-2.5">
                  <h4 className="text-xs font-black uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                    <Users className="w-4 h-4" />
                    Meus Amigos ({friendsList.length})
                  </h4>
                  {friendsList.length === 0 ? (
                    <p className="text-xs text-stone-500 py-2">
                      Você ainda não adicionou amigos. Use o código #STF acima ou convide jogadores
                      online abaixo!
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {friendsList.map((f) => (
                        <div
                          key={f.uid}
                          className="bg-stone-900 border border-stone-800 p-2.5 rounded flex items-center justify-between"
                        >
                          <div>
                            <div className="text-xs font-bold text-white flex items-center gap-1.5">
                              <span
                                className={`w-2 h-2 rounded-full ${
                                  f.status === 'playing'
                                    ? 'bg-amber-400'
                                    : f.status === 'in_room'
                                    ? 'bg-emerald-400'
                                    : 'bg-emerald-500'
                                }`}
                              />
                              {f.displayName}
                              <span className="text-[10px] font-mono text-stone-400">
                                {f.tagCode}
                              </span>
                            </div>
                            <div className="text-[10px] text-stone-400">
                              {f.currentRoomCode ? `Na sala ${f.currentRoomCode}` : 'Online no menu'}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            {f.currentRoomCode && f.currentRoomCode !== currentRoom?.roomCode && (
                              <button
                                type="button"
                                onClick={() => handleJoinRoom(f.currentRoomCode)}
                                className="bg-stone-800 hover:bg-stone-700 text-amber-400 text-[10px] font-bold uppercase px-2 py-1 rounded cursor-pointer"
                              >
                                Juntar-se
                              </button>
                            )}
                            {currentRoom && (
                              <button
                                type="button"
                                onClick={() => handleInviteFriendToRoom(f)}
                                className="bg-amber-500 hover:bg-amber-400 text-stone-950 text-[10px] font-black uppercase px-2.5 py-1 rounded cursor-pointer"
                              >
                                Convidar p/ Sala
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Jogadores Online no Campinho */}
                <div className="bg-stone-950/80 border border-stone-800 p-3.5 rounded space-y-2.5">
                  <h4 className="text-xs font-black uppercase tracking-wider text-stone-300">
                    Jogadores Online Agora ({onlinePlayers.length})
                  </h4>
                  <div className="space-y-1.5 max-h-44 overflow-y-auto">
                    {onlinePlayers
                      .filter((p) => p.uid !== currentUid)
                      .map((p) => (
                        <div
                          key={p.uid}
                          className="bg-stone-900/70 border border-stone-800/80 px-2.5 py-1.5 rounded flex items-center justify-between"
                        >
                          <div className="text-xs text-stone-200 font-bold flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-emerald-400" />
                            {p.displayName}
                            <span className="text-[10px] font-mono text-amber-400">
                              {p.tagCode}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {currentRoom && (
                              <button
                                type="button"
                                onClick={() => handleInviteFriendToRoom(p)}
                                className="text-[10px] bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded font-bold uppercase cursor-pointer"
                              >
                                Convidar
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setFriendSearchInput(p.tagCode);
                              }}
                              className="text-[10px] bg-stone-800 hover:bg-stone-700 text-stone-300 px-2 py-0.5 rounded font-bold cursor-pointer"
                            >
                              + Amigo
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
