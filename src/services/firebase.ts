import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  updateProfile,
  User,
} from 'firebase/auth';
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  MatchFormatMode,
  MultiplayerMatchSnapshot,
  MultiplayerRoomState,
  MultiplayerSlot,
  OnlineUserProfile,
  RoomVisibility,
} from '../types/game';
import {
  ALL_CHARACTERS,
  buildInitialRoomSlots,
  convertSlotToBot,
  resolveActiveCharacterIdsForRoom,
} from './botService';
import { CreateRoomParams, hashRoomPassword } from './roomService';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: Array<{
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// ============================================================================
// Authentication & User Profile
// ============================================================================

let authReadyPromise: Promise<User> | null = null;
const authReadyListeners = new Set<(user: User | null) => void>();

onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      await ensureUserProfile(user);
    } catch (e) {
      console.warn('Could not initialize user profile yet:', e);
    }
    authReadyListeners.forEach((cb) => cb(user));
  } else {
    authReadyListeners.forEach((cb) => cb(null));
  }
});

export function subscribeToAuthReady(cb: (user: User | null) => void): () => void {
  authReadyListeners.add(cb);
  if (auth.currentUser) {
    cb(auth.currentUser);
  } else {
    ensureAuthenticated().catch(() => cb(null));
  }
  return () => {
    authReadyListeners.delete(cb);
  };
}

export function ensureAuthenticated(): Promise<User> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }
  if (!authReadyPromise) {
    authReadyPromise = new Promise<User>((resolve, reject) => {
      const unsubscribe = onAuthStateChanged(auth, async (user) => {
        if (user) {
          unsubscribe();
          try {
            await ensureUserProfile(user);
          } catch {
            // Ignore transient error
          }
          resolve(user);
        } else {
          try {
            const cred = await signInAnonymously(auth);
            unsubscribe();
            await ensureUserProfile(cred.user);
            resolve(cred.user);
          } catch (err) {
            unsubscribe();
            authReadyPromise = null;
            reject(err);
          }
        }
      });
    });
  }
  return authReadyPromise;
}

export async function linkGoogleAccount(): Promise<User> {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  await ensureUserProfile(result.user);
  return result.user;
}

function generateTagCode(uid: string): string {
  const suffix = uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
  return `#STF${suffix.padEnd(4, '9')}`;
}

export async function ensureUserProfile(user: User, preferredNickname?: string): Promise<void> {
  const userRef = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(userRef);
    const defaultName =
      preferredNickname?.trim() ||
      user.displayName?.trim() ||
      `Craque_${user.uid.slice(0, 4).toUpperCase()}`;

    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        displayName: defaultName.slice(0, 28),
        tagCode: generateTagCode(user.uid),
        status: 'online',
        currentRoomCode: '',
        friends: [],
        wins: 0,
        losses: 0,
        draws: 0,
        goalsScored: 0,
        goalsConceded: 0,
        matchesPlayed: 0,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      });
    } else {
      const existing = snap.data();
      await updateDoc(userRef, {
        uid: existing.uid,
        displayName: (preferredNickname?.trim() || existing.displayName || defaultName).slice(0, 28),
        tagCode: existing.tagCode,
        status: existing.status || 'online',
        currentRoomCode: existing.currentRoomCode || '',
        friends: Array.isArray(existing.friends) ? existing.friends : [],
        wins: typeof existing.wins === 'number' ? existing.wins : 0,
        losses: typeof existing.losses === 'number' ? existing.losses : 0,
        draws: typeof existing.draws === 'number' ? existing.draws : 0,
        goalsScored: typeof existing.goalsScored === 'number' ? existing.goalsScored : 0,
        goalsConceded: typeof existing.goalsConceded === 'number' ? existing.goalsConceded : 0,
        matchesPlayed: typeof existing.matchesPlayed === 'number' ? existing.matchesPlayed : 0,
        createdAt: existing.createdAt,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
  }
}

export async function updateNickname(newName: string): Promise<void> {
  const user = await ensureAuthenticated();
  const cleanName = newName.trim().slice(0, 28);
  if (!cleanName) return;

  try {
    await updateProfile(user, { displayName: cleanName });
  } catch {
    // Ignore Auth profile update issues on anonymous users
  }
  await ensureUserProfile(user, cleanName);
}

export async function updateUserPresence(
  status: 'online' | 'in_room' | 'playing' | 'offline',
  roomCode: string = ''
): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const userRef = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(userRef);
    if (!snap.exists()) return;
    const d = snap.data();
    await updateDoc(userRef, {
      uid: d.uid,
      displayName: d.displayName,
      tagCode: d.tagCode,
      status,
      currentRoomCode: roomCode.slice(0, 16),
      friends: d.friends || [],
      wins: d.wins || 0,
      losses: d.losses || 0,
      draws: d.draws || 0,
      goalsScored: d.goalsScored || 0,
      goalsConceded: d.goalsConceded || 0,
      matchesPlayed: d.matchesPlayed || 0,
      createdAt: d.createdAt,
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Non-fatal heartbeat update
  }
}

function mapDocToOnlineUserProfile(id: string, d: Record<string, unknown>): OnlineUserProfile & { friends: string[] } {
  const updatedTs = d.updatedAt instanceof Timestamp ? d.updatedAt.toMillis() : Date.now();
  const createdTs = d.createdAt instanceof Timestamp ? d.createdAt.toMillis() : Date.now();
  return {
    uid: String(d.uid || id),
    displayName: String(d.displayName || 'Jogador'),
    tagCode: String(d.tagCode || '#STF0000'),
    status: (d.status as 'online' | 'in_room' | 'playing') || 'online',
    currentRoomCode: String(d.currentRoomCode || ''),
    friends: Array.isArray(d.friends) ? (d.friends as string[]) : [],
    wins: typeof d.wins === 'number' ? d.wins : 0,
    losses: typeof d.losses === 'number' ? d.losses : 0,
    draws: typeof d.draws === 'number' ? d.draws : 0,
    goalsScored: typeof d.goalsScored === 'number' ? d.goalsScored : 0,
    goalsConceded: typeof d.goalsConceded === 'number' ? d.goalsConceded : 0,
    matchesPlayed: typeof d.matchesPlayed === 'number' ? d.matchesPlayed : 0,
    updatedAt: updatedTs,
    createdAt: createdTs,
  };
}

export function subscribeToMyProfile(
  cb: (profile: (OnlineUserProfile & { friends: string[] }) | null) => void
): () => void {
  let unsubDoc: (() => void) | null = null;
  const unsubAuth = subscribeToAuthReady((user) => {
    if (unsubDoc) {
      unsubDoc();
      unsubDoc = null;
    }
    if (!user) {
      cb(null);
      return;
    }
    const userRef = doc(db, 'users', user.uid);
    unsubDoc = onSnapshot(
      userRef,
      (snap) => {
        if (snap.exists()) {
          cb(mapDocToOnlineUserProfile(snap.id, snap.data()));
        } else {
          cb(null);
        }
      },
      (err) => {
        console.error('Error listening to profile:', err);
      }
    );
  });

  return () => {
    unsubAuth();
    if (unsubDoc) unsubDoc();
  };
}

export function subscribeToOnlinePlayers(cb: (players: OnlineUserProfile[]) => void): () => void {
  const q = query(collection(db, 'users'), limit(40));
  return onSnapshot(
    q,
    (snap) => {
      const list: OnlineUserProfile[] = [];
      snap.forEach((docSnap) => {
        list.push(mapDocToOnlineUserProfile(docSnap.id, docSnap.data()));
      });
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      cb(list);
    },
    (err) => {
      console.warn('Could not list online players:', err);
    }
  );
}

// ============================================================================
// Friends & Room Invitations
// ============================================================================

export interface FriendRequestDoc {
  id: string;
  fromUid: string;
  fromName: string;
  fromTag: string;
  toUid: string;
  toName: string;
  type: 'friend_request' | 'room_invite';
  roomCode: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
}

export async function sendFriendRequestByTag(targetTagOrName: string): Promise<{ ok: boolean; message: string }> {
  const user = await ensureAuthenticated();
  const mySnap = await getDoc(doc(db, 'users', user.uid));
  if (!mySnap.exists()) {
    return { ok: false, message: 'Perfil ainda não carregado.' };
  }
  const me = mySnap.data();

  const search = targetTagOrName.trim();
  if (!search) {
    return { ok: false, message: 'Digite o código #STF ou nome do amigo.' };
  }

  let q = query(collection(db, 'users'), where('tagCode', '==', search.toUpperCase()), limit(5));
  let snap = await getDocs(q);

  if (snap.empty) {
    q = query(collection(db, 'users'), where('displayName', '==', search), limit(5));
    snap = await getDocs(q);
  }

  if (snap.empty) {
    return { ok: false, message: 'Nenhum jogador encontrado com essa Tag ou Nome.' };
  }

  const targetDoc = snap.docs[0];
  const targetData = targetDoc.data();

  if (targetDoc.id === user.uid) {
    return { ok: false, message: 'Você não pode adicionar a si mesmo!' };
  }

  try {
    await addDoc(collection(db, 'friendRequests'), {
      fromUid: user.uid,
      fromName: String(me.displayName || 'Jogador').slice(0, 28),
      fromTag: String(me.tagCode || '#STF0000'),
      toUid: targetDoc.id,
      toName: String(targetData.displayName || 'Amigo').slice(0, 28),
      type: 'friend_request',
      roomCode: '',
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { ok: true, message: `Pedido enviado para ${targetData.displayName}!` };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, 'friendRequests');
  }
}

export async function sendRoomInviteToFriend(
  friendUid: string,
  friendName: string,
  roomCode: string
): Promise<void> {
  const user = await ensureAuthenticated();
  const mySnap = await getDoc(doc(db, 'users', user.uid));
  const me = mySnap.exists() ? mySnap.data() : { displayName: 'Craque', tagCode: '#STF0000' };

  try {
    await addDoc(collection(db, 'friendRequests'), {
      fromUid: user.uid,
      fromName: String(me.displayName || 'Craque').slice(0, 28),
      fromTag: String(me.tagCode || '#STF0000'),
      toUid: friendUid,
      toName: friendName.slice(0, 28),
      type: 'room_invite',
      roomCode: roomCode.slice(0, 16),
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, 'friendRequests');
  }
}

export async function respondToFriendRequest(
  request: FriendRequestDoc,
  accept: boolean
): Promise<void> {
  const user = await ensureAuthenticated();
  const reqRef = doc(db, 'friendRequests', request.id);
  const snap = await getDoc(reqRef);
  if (!snap.exists()) return;
  const d = snap.data();

  try {
    await updateDoc(reqRef, {
      fromUid: d.fromUid,
      fromName: d.fromName,
      fromTag: d.fromTag,
      toUid: d.toUid,
      toName: d.toName,
      type: d.type,
      roomCode: d.roomCode,
      status: accept ? 'accepted' : 'declined',
      createdAt: d.createdAt,
      updatedAt: serverTimestamp(),
    });

    if (accept && request.type === 'friend_request') {
      const myRef = doc(db, 'users', user.uid);
      const mySnap = await getDoc(myRef);
      if (mySnap.exists()) {
        await updateDoc(myRef, {
          friends: arrayUnion(request.fromUid),
          updatedAt: serverTimestamp(),
        });
      }

      const senderRef = doc(db, 'users', request.fromUid);
      const senderSnap = await getDoc(senderRef);
      if (senderSnap.exists()) {
        await updateDoc(senderRef, {
          friends: arrayUnion(user.uid),
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `friendRequests/${request.id}`);
  }
}

export function subscribeToIncomingRequests(
  cb: (requests: FriendRequestDoc[]) => void
): () => void {
  let unsubSnap: (() => void) | null = null;
  const unsubAuth = subscribeToAuthReady((user) => {
    if (unsubSnap) {
      unsubSnap();
      unsubSnap = null;
    }
    if (!user) {
      cb([]);
      return;
    }
    const q = query(
      collection(db, 'friendRequests'),
      where('toUid', '==', user.uid),
      where('status', '==', 'pending'),
      limit(25)
    );
    unsubSnap = onSnapshot(
      q,
      (snap) => {
        const list: FriendRequestDoc[] = [];
        snap.forEach((docSnap) => {
          const d = docSnap.data();
          list.push({
            id: docSnap.id,
            fromUid: String(d.fromUid),
            fromName: String(d.fromName),
            fromTag: String(d.fromTag || '#STF'),
            toUid: String(d.toUid),
            toName: String(d.toName),
            type: (d.type as 'friend_request' | 'room_invite') || 'friend_request',
            roomCode: String(d.roomCode || ''),
            status: (d.status as 'pending' | 'accepted' | 'declined') || 'pending',
            createdAt: d.createdAt instanceof Timestamp ? d.createdAt.toMillis() : Date.now(),
          });
        });
        cb(list);
      },
      (err) => {
        console.warn('Error listening to incoming friend requests:', err);
      }
    );
  });

  return () => {
    unsubAuth();
    if (unsubSnap) unsubSnap();
  };
}

export function subscribeToFriendsProfiles(
  friendUids: string[],
  cb: (friends: OnlineUserProfile[]) => void
): () => void {
  if (!friendUids || friendUids.length === 0) {
    cb([]);
    return () => {};
  }
  const slice = friendUids.slice(0, 20);
  const q = query(collection(db, 'users'), where('uid', 'in', slice));
  return onSnapshot(
    q,
    (snap) => {
      const list: OnlineUserProfile[] = [];
      snap.forEach((docSnap) => {
        list.push(mapDocToOnlineUserProfile(docSnap.id, docSnap.data()));
      });
      cb(list);
    },
    (err) => {
      console.warn('Error listening to friends profiles:', err);
    }
  );
}

// ============================================================================
// Multiplayer Rooms (2v2 & 4v4, Public & Private with Password Hash, Bots)
// ============================================================================

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'STF-';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function mapDocToRoomState(d: Record<string, unknown>): MultiplayerRoomState {
  const mode: MatchFormatMode = d.mode === '2v2' ? '2v2' : '4v4';
  const visibility: RoomVisibility = d.visibility === 'private' ? 'private' : 'public';
  const slots = (d.slots as Record<string, MultiplayerSlot>) || {};
  const activeCharacterIds = Array.isArray(d.activeCharacterIds)
    ? (d.activeCharacterIds as string[])
    : resolveActiveCharacterIdsForRoom(slots, mode);

  return {
    roomCode: String(d.roomCode),
    roomName: String(d.roomName || `SEM TERRA FC — ${String(d.roomCode)}`),
    mode,
    visibility,
    hasPassword: Boolean(d.hasPassword),
    passwordHash: d.passwordHash ? String(d.passwordHash) : null,
    maxHumans: typeof d.maxHumans === 'number' ? d.maxHumans : mode === '2v2' ? 4 : 8,
    autoFillBots: d.autoFillBots !== false,
    activeCharacterIds,
    loadingReadyUids: Array.isArray(d.loadingReadyUids) ? (d.loadingReadyUids as string[]) : [],
    lastActivityMs:
      typeof d.lastActivityMs === 'number'
        ? d.lastActivityMs
        : d.updatedAt instanceof Timestamp
        ? d.updatedAt.toMillis()
        : Date.now(),
    hostUid: String(d.hostUid),
    hostName: String(d.hostName),
    status: (d.status as 'waiting' | 'playing' | 'finished') || 'waiting',
    homeTeamId: String(d.homeTeamId || 'unidos_do_barro'),
    awayTeamId: String(d.awayTeamId || 'rubro_negro_beco'),
    homeScore: typeof d.homeGoals === 'number' ? d.homeGoals : 0,
    awayScore: typeof d.awayGoals === 'number' ? d.awayGoals : 0,
    half: (d.half as 1 | 2) || 1,
    remainingSeconds: typeof d.remainingSeconds === 'number' ? d.remainingSeconds : 150,
    slots,
    matchState: (d.matchSnapshot as MultiplayerMatchSnapshot) || null,
  };
}

export async function createOnlineRoom(
  homeTeamId: string = 'unidos_do_barro',
  awayTeamId: string = 'rubro_negro_beco',
  halfDurationSeconds: number = 150,
  options?: Partial<CreateRoomParams>
): Promise<MultiplayerRoomState> {
  const user = await ensureAuthenticated();
  const mySnap = await getDoc(doc(db, 'users', user.uid));
  const hostName = mySnap.exists()
    ? String(mySnap.data().displayName || 'Anfitrião').slice(0, 28)
    : (user.displayName || 'Anfitrião').slice(0, 28);

  const roomCode = generateRoomCode();
  const mode: MatchFormatMode = options?.mode === '2v2' ? '2v2' : '4v4';
  const visibility: RoomVisibility = options?.visibility === 'private' ? 'private' : 'public';
  const rawPassword = options?.password?.trim() || '';
  const hasPassword = visibility === 'private' && rawPassword.length > 0;
  const passwordHash = hasPassword ? await hashRoomPassword(roomCode, rawPassword) : null;
  const maxHumans = options?.maxHumans
    ? Math.max(1, Math.min(mode === '2v2' ? 4 : 8, options.maxHumans))
    : mode === '2v2'
    ? 4
    : 8;

  const roomNum = Math.floor(100 + Math.random() * 900);
  const roomName = (options?.roomName?.trim() || `SEM TERRA FC — SALA #${roomNum}`).slice(0, 60);

  const slots = buildInitialRoomSlots(user.uid, hostName, options?.preferredCharacterId || 'home_1');
  const activeCharacterIds = resolveActiveCharacterIdsForRoom(slots, mode);
  const nowMs = Date.now();

  const roomRef = doc(db, 'rooms', roomCode);
  try {
    await setDoc(roomRef, {
      roomCode,
      roomName,
      mode,
      visibility,
      hasPassword,
      passwordHash,
      maxHumans,
      autoFillBots: options?.autoFillBots !== false,
      activeCharacterIds,
      loadingReadyUids: [user.uid],
      lastActivityMs: nowMs,
      hostUid: user.uid,
      hostName,
      status: 'waiting',
      homeTeamId,
      awayTeamId,
      homeGoals: 0,
      awayGoals: 0,
      half: 1,
      remainingSeconds: halfDurationSeconds,
      slots,
      inputs: {},
      matchSnapshot: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await updateUserPresence('in_room', roomCode);

    return {
      roomCode,
      roomName,
      mode,
      visibility,
      hasPassword,
      passwordHash,
      maxHumans,
      autoFillBots: options?.autoFillBots !== false,
      activeCharacterIds,
      loadingReadyUids: [user.uid],
      lastActivityMs: nowMs,
      hostUid: user.uid,
      hostName,
      status: 'waiting',
      homeTeamId,
      awayTeamId,
      homeScore: 0,
      awayScore: 0,
      half: 1,
      remainingSeconds: halfDurationSeconds,
      slots,
      matchState: null,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `rooms/${roomCode}`);
  }
}

export async function joinOnlineRoom(
  roomCodeInput: string,
  passwordInput?: string,
  expectedMode?: MatchFormatMode
): Promise<MultiplayerRoomState | null> {
  const user = await ensureAuthenticated();
  const roomCode = roomCodeInput.trim().toUpperCase();
  const roomRef = doc(db, 'rooms', roomCode);

  const snap = await getDoc(roomRef);
  if (!snap.exists()) {
    throw new Error('Sala não encontrada. Verifique o código da sala.');
  }

  const d = snap.data();
  if (d.status === 'finished') {
    throw new Error('Esta partida já foi encerrada.');
  }

  const roomMode: MatchFormatMode = d.mode === '2v2' ? '2v2' : '4v4';
  if (expectedMode && roomMode !== expectedMode) {
    throw new Error(
      `Esta sala é da modalidade ${roomMode.toUpperCase()} e não aceita entrada pelo modo ${expectedMode.toUpperCase()}.`
    );
  }

  const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
  let existingSlotKey = Object.keys(slots).find((k) => slots[k].uid === user.uid);

  if (d.status === 'playing' && !existingSlotKey) {
    throw new Error('Não é possível entrar: a partida já está em andamento.');
  }

  // Validação de senha para salas privadas
  if (d.hasPassword && d.passwordHash && d.hostUid !== user.uid && !existingSlotKey) {
    if (!passwordInput || !passwordInput.trim()) {
      throw new Error('SENHA_OBRIGATORIA: Esta sala privada exige senha para entrar.');
    }
    const candidateHash = await hashRoomPassword(roomCode, passwordInput);
    if (candidateHash !== d.passwordHash) {
      throw new Error('Senha incorreta para esta sala privada.');
    }
  }

  const mySnap = await getDoc(doc(db, 'users', user.uid));
  const myName = mySnap.exists()
    ? String(mySnap.data().displayName || 'Jogador').slice(0, 28)
    : (user.displayName || 'Jogador').slice(0, 28);

  const maxAllowed = typeof d.maxHumans === 'number' ? d.maxHumans : roomMode === '2v2' ? 4 : 8;
  const currentHumanCount = Object.values(slots).filter((s) => !s.isBot && s.uid).length;

  if (!existingSlotKey) {
    if (currentHumanCount >= maxAllowed) {
      throw new Error(`Sala lotada (${currentHumanCount}/${maxAllowed} jogadores humanos).`);
    }

    // Balanceamento entre Time 1 (home) e Time 2 (away) respeitando limite por equipe (2 em 2v2, 4 em 4v4)
    const maxPerTeam = roomMode === '2v2' ? 2 : 4;
    const homeHumans = Object.values(slots).filter((s) => s.team === 'home' && !s.isBot && s.uid).length;
    const awayHumans = Object.values(slots).filter((s) => s.team === 'away' && !s.isBot && s.uid).length;

    const preferredTeam: 'home' | 'away' =
      homeHumans <= awayHumans && homeHumans < maxPerTeam
        ? 'home'
        : awayHumans < maxPerTeam
        ? 'away'
        : 'home';

    let botSlotKey = Object.keys(slots).find(
      (k) => slots[k].isBot && slots[k].team === preferredTeam
    );
    if (!botSlotKey) {
      botSlotKey = Object.keys(slots).find((k) => slots[k].isBot);
    }

    if (!botSlotKey) {
      throw new Error('Todas as vagas de personagens já estão ocupadas.');
    }

    existingSlotKey = botSlotKey;
    slots[existingSlotKey] = {
      ...slots[existingSlotKey],
      uid: user.uid,
      displayName: myName,
      isBot: false,
      isReady: true,
      pingMs: 24,
      micEnabled: false,
      isSpeaking: false,
      lastSeenMs: Date.now(),
    };
  } else {
    slots[existingSlotKey] = {
      ...slots[existingSlotKey],
      displayName: myName,
      isBot: false,
      lastSeenMs: Date.now(),
    };
  }

  const activeCharacterIds = resolveActiveCharacterIdsForRoom(
    slots,
    roomMode,
    Array.isArray(d.activeCharacterIds) ? d.activeCharacterIds : undefined
  );

  try {
    await updateDoc(roomRef, {
      ...d,
      slots,
      activeCharacterIds,
      lastActivityMs: Date.now(),
      updatedAt: serverTimestamp(),
    });
    await updateUserPresence('in_room', roomCode);
    return mapDocToRoomState({
      ...d,
      slots,
      activeCharacterIds,
      lastActivityMs: Date.now(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomCode}`);
  }
}

export async function selectRoomCharacter(
  roomCode: string,
  targetCharacterId: string
): Promise<{ ok: boolean; message?: string }> {
  const user = await ensureAuthenticated();
  const roomRef = doc(db, 'rooms', roomCode);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return { ok: false, message: 'Sala não existe mais.' };

  const d = snap.data();
  const roomMode: MatchFormatMode = d.mode === '2v2' ? '2v2' : '4v4';
  const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
  const targetSlot = slots[targetCharacterId];

  if (!targetSlot) return { ok: false, message: 'Personagem inválido.' };
  if (!targetSlot.isBot && targetSlot.uid !== user.uid) {
    return {
      ok: false,
      message: `${targetSlot.characterName} já foi escolhido por ${targetSlot.displayName}!`,
    };
  }

  // Em 2v2, garante no máximo 2 humanos na mesma equipe
  if (roomMode === '2v2') {
    const teamHumansExcludingMe = Object.values(slots).filter(
      (s) => s.team === targetSlot.team && !s.isBot && s.uid && s.uid !== user.uid
    ).length;
    if (teamHumansExcludingMe >= 2) {
      return {
        ok: false,
        message: 'Esta equipe já possui 2 jogadores humanos na modalidade 2 contra 2.',
      };
    }
  }

  const mySnap = await getDoc(doc(db, 'users', user.uid));
  const myName = mySnap.exists()
    ? String(mySnap.data().displayName || 'Jogador').slice(0, 28)
    : (user.displayName || 'Jogador').slice(0, 28);

  let myMicEnabled = false;
  let myReady = true;

  // Libera meu slot anterior de volta para Bot
  for (const key of Object.keys(slots)) {
    if (slots[key].uid === user.uid) {
      myMicEnabled = Boolean(slots[key].micEnabled);
      myReady = slots[key].isReady !== false;
      slots[key] = convertSlotToBot(slots[key]);
    }
  }

  // Assume o novo personagem
  slots[targetCharacterId] = {
    ...targetSlot,
    uid: user.uid,
    displayName: myName,
    isBot: false,
    isReady: myReady,
    pingMs: 20,
    micEnabled: myMicEnabled,
    isSpeaking: false,
    lastSeenMs: Date.now(),
  };

  const activeCharacterIds = resolveActiveCharacterIdsForRoom(slots, roomMode);

  try {
    await updateDoc(roomRef, {
      ...d,
      slots,
      activeCharacterIds,
      lastActivityMs: Date.now(),
      updatedAt: serverTimestamp(),
    });
    return { ok: true };
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomCode}`);
  }
}

export async function togglePlayerReadyInRoom(roomCode: string, ready?: boolean): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const roomRef = doc(db, 'rooms', roomCode);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return;

  const d = snap.data();
  const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
  let changed = false;

  for (const key of Object.keys(slots)) {
    if (slots[key].uid === user.uid) {
      const nextReady = ready !== undefined ? ready : !slots[key].isReady;
      slots[key] = {
        ...slots[key],
        isReady: nextReady,
        lastSeenMs: Date.now(),
      };
      changed = true;
    }
  }

  if (!changed) return;

  try {
    await updateDoc(roomRef, {
      ...d,
      slots,
      lastActivityMs: Date.now(),
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Non-fatal
  }
}

export async function updatePlayerVoiceStatusInRoom(
  roomCode: string,
  micEnabled: boolean,
  isSpeaking: boolean
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
    let changed = false;
    for (const key of Object.keys(slots)) {
      if (slots[key].uid === user.uid) {
        if (slots[key].micEnabled !== micEnabled || slots[key].isSpeaking !== isSpeaking) {
          slots[key] = {
            ...slots[key],
            micEnabled,
            isSpeaking,
            lastSeenMs: Date.now(),
          };
          changed = true;
        }
      }
    }
    if (changed) {
      await updateDoc(roomRef, {
        ...d,
        slots,
        lastActivityMs: Date.now(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch {
    // Ignore transient conflict
  }
}

export async function sendRoomHeartbeat(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.status === 'finished') return;

    const nowMs = Date.now();
    const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
    for (const key of Object.keys(slots)) {
      if (slots[key].uid === user.uid) {
        slots[key] = {
          ...slots[key],
          lastSeenMs: nowMs,
        };
      }
    }

    await updateDoc(roomRef, {
      ...d,
      slots,
      lastActivityMs: nowMs,
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Ignore heartbeat race
  }
}

/**
 * Remove o jogador da sala, libera seu personagem para um Bot, transfere a liderança
 * caso o criador saia e encerra/deleta imediatamente a sala caso não restem jogadores humanos.
 */
export async function leaveOnlineRoom(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const normalizedCode = roomCode.trim().toUpperCase();
  const roomRef = doc(db, 'rooms', normalizedCode);

  try {
    const snap = await getDoc(roomRef);
    if (snap.exists()) {
      const d = snap.data();
      const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };

      for (const key of Object.keys(slots)) {
        if (slots[key].uid === user.uid) {
          slots[key] = convertSlotToBot(slots[key]);
        }
      }

      const remainingHumans = Object.values(slots).filter((s) => !s.isBot && s.uid);

      if (remainingHumans.length === 0) {
        // Quando o último jogador sair, encerrar e deletar a sala para nunca ficar fantasma
        await deleteDoc(roomRef);
      } else {
        let nextHostUid = String(d.hostUid);
        let nextHostName = String(d.hostName);

        // Se o criador sair da sala, transfere a liderança para outro jogador conectado
        if (d.hostUid === user.uid) {
          nextHostUid = String(remainingHumans[0].uid);
          nextHostName = String(remainingHumans[0].displayName || 'Anfitrião').slice(0, 28);
        }

        const roomMode: MatchFormatMode = d.mode === '2v2' ? '2v2' : '4v4';
        const activeCharacterIds = resolveActiveCharacterIdsForRoom(
          slots,
          roomMode,
          Array.isArray(d.activeCharacterIds) ? d.activeCharacterIds : undefined
        );

        await updateDoc(roomRef, {
          ...d,
          hostUid: nextHostUid,
          hostName: nextHostName,
          slots,
          activeCharacterIds,
          lastActivityMs: Date.now(),
          updatedAt: serverTimestamp(),
        });
      }
    }
    await updateUserPresence('online', '');
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Varre salas públicas/privadas para limpar jogadores que fecharam a aba sem aviso
 * e remover salas abandonadas sem nenhum humano ativo.
 */
export async function cleanupAbandonedRoomsAndSlots(): Promise<void> {
  if (!auth.currentUser) return;
  try {
    const q = query(collection(db, 'rooms'), limit(25));
    const snap = await getDocs(q);
    const nowMs = Date.now();
    const ROOM_ABANDON_TIMEOUT_MS = 45000;
    const SLOT_STALE_TIMEOUT_MS = 35000;

    for (const docSnap of snap.docs) {
      const d = docSnap.data();
      if (d.status === 'finished') {
        await deleteDoc(docSnap.ref).catch(() => {});
        continue;
      }

      const updatedMs =
        typeof d.lastActivityMs === 'number'
          ? d.lastActivityMs
          : d.updatedAt instanceof Timestamp
          ? d.updatedAt.toMillis()
          : nowMs;

      // Sala inteira sem atividade há mais de 45s
      if (nowMs - updatedMs > ROOM_ABANDON_TIMEOUT_MS) {
        await deleteDoc(docSnap.ref).catch(() => {});
        continue;
      }

      const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
      let slotsChanged = false;

      for (const key of Object.keys(slots)) {
        const slot = slots[key];
        if (!slot.isBot && slot.uid && slot.lastSeenMs && nowMs - slot.lastSeenMs > SLOT_STALE_TIMEOUT_MS) {
          slots[key] = convertSlotToBot(slot);
          slotsChanged = true;
        }
      }

      const remainingHumans = Object.values(slots).filter((s) => !s.isBot && s.uid);
      if (remainingHumans.length === 0) {
        await deleteDoc(docSnap.ref).catch(() => {});
      } else if (slotsChanged) {
        let nextHostUid = String(d.hostUid);
        let nextHostName = String(d.hostName);
        if (!remainingHumans.some((h) => h.uid === nextHostUid)) {
          nextHostUid = String(remainingHumans[0].uid);
          nextHostName = String(remainingHumans[0].displayName || 'Anfitrião').slice(0, 28);
        }
        await updateDoc(docSnap.ref, {
          ...d,
          hostUid: nextHostUid,
          hostName: nextHostName,
          slots,
          lastActivityMs: nowMs,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
    }
  } catch {
    // Non-fatal background sweep
  }
}

export async function startOnlineMatch(roomCode: string): Promise<void> {
  const user = await ensureAuthenticated();
  const roomRef = doc(db, 'rooms', roomCode);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return;
  const d = snap.data();
  if (d.hostUid !== user.uid) return;

  const roomMode: MatchFormatMode = d.mode === '2v2' ? '2v2' : '4v4';
  const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
  const activeCharacterIds = resolveActiveCharacterIdsForRoom(
    slots,
    roomMode,
    Array.isArray(d.activeCharacterIds) ? d.activeCharacterIds : undefined
  );

  try {
    await updateDoc(roomRef, {
      ...d,
      status: 'playing',
      activeCharacterIds,
      loadingReadyUids: [user.uid],
      lastActivityMs: Date.now(),
      updatedAt: serverTimestamp(),
    });
    await updateUserPresence('playing', roomCode);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomCode}`);
  }
}

export async function markPlayerMatchLoadingReady(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    const readyList = Array.isArray(d.loadingReadyUids) ? [...d.loadingReadyUids] : [];
    if (!readyList.includes(user.uid)) {
      readyList.push(user.uid);
      await updateDoc(roomRef, {
        ...d,
        loadingReadyUids: readyList,
        lastActivityMs: Date.now(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch {
    // Ignore transient race
  }
}

export async function publishHostMatchSnapshot(
  roomCode: string,
  snapshot: MultiplayerMatchSnapshot
): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.hostUid !== user.uid || d.status === 'finished') return;

    await updateDoc(roomRef, {
      ...d,
      homeGoals: snapshot.homeGoals,
      awayGoals: snapshot.awayGoals,
      half: snapshot.half,
      remainingSeconds: Math.max(0, Math.floor(snapshot.remainingSeconds)),
      matchSnapshot: snapshot,
      lastActivityMs: Date.now(),
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Ignore high-frequency sync conflict
  }
}

export interface ClientInputState {
  moveX: number;
  moveZ: number;
  sprint: boolean;
  action: 'none' | 'pass' | 'shoot' | 'tackle';
  kickPower: number;
  timestamp: number;
}

export async function publishClientInput(
  roomCode: string,
  input: ClientInputState
): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.status === 'finished') return;
    const inputs = { ...(d.inputs || {}), [user.uid]: input };
    await updateDoc(roomRef, {
      ...d,
      inputs,
      lastActivityMs: Date.now(),
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Ignore transient network lag
  }
}

export function subscribeToRoom(
  roomCode: string,
  cb: (
    room: (MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null
  ) => void
): () => void {
  const roomRef = doc(db, 'rooms', roomCode);
  return onSnapshot(
    roomRef,
    (snap) => {
      if (!snap.exists()) {
        cb(null);
        return;
      }
      const d = snap.data();
      cb({
        ...mapDocToRoomState(d),
        inputs: (d.inputs as Record<string, ClientInputState>) || {},
      });
    },
    (err) => {
      console.warn('Error listening to room:', err);
      cb(null);
    }
  );
}

export function subscribeToPublicRooms(cb: (rooms: MultiplayerRoomState[]) => void): () => void {
  const q = query(collection(db, 'rooms'), limit(30));
  return onSnapshot(
    q,
    (snap) => {
      const list: MultiplayerRoomState[] = [];
      const nowMs = Date.now();
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        if (d.status === 'finished') return;
        const room = mapDocToRoomState(d);
        // Oculta salas sem atividade recente (> 50s)
        if (room.lastActivityMs && nowMs - room.lastActivityMs > 50000) return;
        list.push(room);
      });
      list.sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
      cb(list);
    },
    (err) => {
      console.warn('Error listing public rooms:', err);
    }
  );
}

/**
 * Registra apenas partidas devidamente concluídas (fulltime), atualizando
 * vitórias, derrotas, empates, gols marcados, gols sofridos e partidas jogadas.
 */
export async function recordMatchFinished(
  roomCode: string,
  homeTeamName: string,
  awayTeamName: string,
  homeGoals: number,
  awayGoals: number,
  participantUids: string[],
  myTeam: 'home' | 'away' = 'home',
  isLegitimateFulltime: boolean = true
): Promise<void> {
  if (!isLegitimateFulltime) return;
  const user = auth.currentUser;
  if (!user) return;

  const winner: 'home' | 'away' | 'draw' =
    homeGoals > awayGoals ? 'home' : awayGoals > homeGoals ? 'away' : 'draw';

  try {
    if (roomCode) {
      await addDoc(collection(db, 'matchHistory'), {
        roomCode: roomCode.slice(0, 16),
        hostUid: user.uid,
        homeTeamName: homeTeamName.slice(0, 60),
        awayTeamName: awayTeamName.slice(0, 60),
        homeGoals,
        awayGoals,
        winner,
        participantUids: participantUids.length > 0 ? participantUids.slice(0, 16) : [user.uid],
        createdAt: serverTimestamp(),
      });
    }

    // Atualiza estatísticas de carreira do jogador local
    const userRef = doc(db, 'users', user.uid);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      const d = userSnap.data();
      const didWin = winner === myTeam;
      const didLose = winner !== 'draw' && winner !== myTeam;
      const didDraw = winner === 'draw';
      const myTeamGoals = myTeam === 'home' ? homeGoals : awayGoals;
      const opponentGoals = myTeam === 'home' ? awayGoals : homeGoals;

      await updateDoc(userRef, {
        uid: d.uid,
        displayName: d.displayName,
        tagCode: d.tagCode,
        status: 'online',
        currentRoomCode: '',
        friends: d.friends || [],
        wins: (d.wins || 0) + (didWin ? 1 : 0),
        losses: (d.losses || 0) + (didLose ? 1 : 0),
        draws: (d.draws || 0) + (didDraw ? 1 : 0),
        goalsScored: (d.goalsScored || 0) + myTeamGoals,
        goalsConceded: (d.goalsConceded || 0) + opponentGoals,
        matchesPlayed: (d.matchesPlayed || 0) + 1,
        createdAt: d.createdAt,
        updatedAt: serverTimestamp(),
      });
    }
  } catch {
    // Non-fatal history log
  }
}

export function getCurrentAuthUser(): User | null {
  return auth.currentUser;
}

export { ALL_CHARACTERS, arrayRemove };
