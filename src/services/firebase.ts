import { initializeApp } from 'firebase/app';
import {
  FirebaseError,
} from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCredential,
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
  AuthUserInfo,
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
// Authentication, Google Provider Verification & Account Linking
// ============================================================================

let authReadyPromise: Promise<User> | null = null;
const authReadyListeners = new Set<(user: User | null) => void>();
const authStatusListeners = new Set<(info: AuthUserInfo) => void>();

/**
 * Verifica se o usuário possui o provedor Google ('google.com') vinculado em user.providerData.
 */
export function isUserGoogleLinked(
  user: Pick<User, 'providerData' | 'isAnonymous'> | null | undefined
): boolean {
  if (!user || !Array.isArray(user.providerData)) return false;
  return user.providerData.some((provider) => provider?.providerId === 'google.com');
}

/**
 * Extrai informações completas de autenticação e provedores vinculados (Google vs Anônimo).
 */
export function extractAuthUserInfo(user: User | null = auth.currentUser): AuthUserInfo {
  if (!user) {
    return {
      uid: '',
      displayName: '',
      email: null,
      photoURL: null,
      isAnonymous: false,
      isGoogleLinked: false,
      providers: [],
      loginProviderLabel: 'unauthenticated',
    };
  }

  const providers = Array.isArray(user.providerData)
    ? user.providerData.map((p) => p.providerId).filter(Boolean)
    : [];
  const googleProvider = Array.isArray(user.providerData)
    ? user.providerData.find((p) => p.providerId === 'google.com')
    : undefined;
  const googleLinked = Boolean(googleProvider);

  return {
    uid: user.uid,
    displayName:
      user.displayName ||
      googleProvider?.displayName ||
      `Craque_${user.uid.slice(0, 4).toUpperCase()}`,
    email: user.email || googleProvider?.email || null,
    photoURL: user.photoURL || googleProvider?.photoURL || null,
    isAnonymous: Boolean(user.isAnonymous && !googleLinked),
    isGoogleLinked: googleLinked,
    providers,
    loginProviderLabel: googleLinked ? 'google.com' : 'anonymous',
  };
}

function notifyAuthListeners(user: User | null): void {
  const info = extractAuthUserInfo(user);
  authReadyListeners.forEach((cb) => cb(user));
  authStatusListeners.forEach((cb) => cb(info));
}

function withFirestoreTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function buildSanitizedRoomPayload(
  roomCode: string,
  d: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const merged = { ...d, ...overrides };
  const mode: MatchFormatMode = merged.mode === '2v2' ? '2v2' : '4v4';
  const visibility: RoomVisibility = merged.visibility === 'private' ? 'private' : 'public';
  const slots =
    merged.slots && typeof merged.slots === 'object'
      ? (merged.slots as Record<string, MultiplayerSlot>)
      : {};
  const activeCharacterIds = Array.isArray(merged.activeCharacterIds)
    ? (merged.activeCharacterIds as string[]).slice(0, 8)
    : resolveActiveCharacterIdsForRoom(slots, mode);

  return {
    roomCode: String(merged.roomCode || roomCode).slice(0, 16),
    matchId:
      typeof merged.matchId === 'string' && merged.matchId.trim().length > 0
        ? merged.matchId.slice(0, 32)
        : null,
    roomName: String(merged.roomName || `SEM TERRA FC — ${roomCode}`).slice(0, 60),
    mode,
    visibility,
    hasPassword: Boolean(merged.hasPassword),
    passwordHash:
      typeof merged.passwordHash === 'string' && merged.passwordHash.length > 0
        ? merged.passwordHash.slice(0, 128)
        : null,
    maxHumans:
      typeof merged.maxHumans === 'number'
        ? Math.max(1, Math.min(8, Math.floor(merged.maxHumans)))
        : mode === '2v2'
        ? 4
        : 8,
    autoFillBots: merged.autoFillBots !== false,
    activeCharacterIds,
    loadingReadyUids: Array.isArray(merged.loadingReadyUids)
      ? (merged.loadingReadyUids as string[]).slice(0, 16)
      : [],
    startAt:
      typeof merged.startAt === 'number' && merged.startAt >= 0
        ? Math.floor(merged.startAt)
        : null,
    lastActivityMs:
      typeof merged.lastActivityMs === 'number' && merged.lastActivityMs >= 0
        ? Math.floor(merged.lastActivityMs)
        : Date.now(),
    hostUid: String(merged.hostUid || '').slice(0, 128),
    hostName: String(merged.hostName || 'Anfitrião').slice(0, 28),
    status:
      merged.status === 'starting' ||
      merged.status === 'playing' ||
      merged.status === 'finished'
        ? merged.status
        : 'waiting',
    homeTeamId: String(merged.homeTeamId || 'unidos_do_barro').slice(0, 64),
    awayTeamId: String(merged.awayTeamId || 'rubro_negro_beco').slice(0, 64),
    homeGoals:
      typeof merged.homeGoals === 'number' && merged.homeGoals >= 0
        ? Math.min(99, Math.floor(merged.homeGoals))
        : 0,
    awayGoals:
      typeof merged.awayGoals === 'number' && merged.awayGoals >= 0
        ? Math.min(99, Math.floor(merged.awayGoals))
        : 0,
    half: merged.half === 2 ? 2 : 1,
    remainingSeconds:
      typeof merged.remainingSeconds === 'number' && merged.remainingSeconds >= 0
        ? Math.min(3600, Math.floor(merged.remainingSeconds))
        : 150,
    slots,
    inputs:
      merged.inputs && typeof merged.inputs === 'object'
        ? (merged.inputs as Record<string, unknown>)
        : {},
    matchSnapshot:
      merged.matchSnapshot && typeof merged.matchSnapshot === 'object'
        ? merged.matchSnapshot
        : null,
    createdAt: d.createdAt instanceof Timestamp ? d.createdAt : serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    notifyAuthListeners(user);
    try {
      await ensureUserProfile(user);
    } catch (e) {
      console.warn('Could not initialize user profile yet:', e);
    }
    notifyAuthListeners(user);
  } else {
    notifyAuthListeners(null);
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

export function subscribeToAuthStatus(cb: (info: AuthUserInfo) => void): () => void {
  authStatusListeners.add(cb);
  if (auth.currentUser) {
    cb(extractAuthUserInfo(auth.currentUser));
  } else {
    cb(extractAuthUserInfo(null));
    ensureAuthenticated()
      .then((u) => cb(extractAuthUserInfo(u)))
      .catch(() => cb(extractAuthUserInfo(null)));
  }
  return () => {
    authStatusListeners.delete(cb);
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
          resolve(user);
          ensureUserProfile(user).catch(() => {});
        } else {
          try {
            const cred = await signInAnonymously(auth);
            unsubscribe();
            resolve(cred.user);
            ensureUserProfile(cred.user).catch(() => {});
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

export interface GoogleLinkResult {
  user: User;
  mergedFromAnonymous: boolean;
  alreadyLinked: boolean;
}

/**
 * Vincula a conta anônima atual a uma Conta Google usando linkWithPopup para preservar UID,
 * estatísticas, histórico, amigos e vaga na sala.
 * Caso a conta Google já exista no Firebase (credential-already-in-use), mescla os dados
 * da conta anônima para a conta Google existente e migra a vaga na sala ativa.
 */
export async function linkGoogleAccount(): Promise<GoogleLinkResult> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const currentUser = auth.currentUser;

  // 1. Se o usuário já possui provedor Google vinculado, não abre novo fluxo duplicado
  if (currentUser && isUserGoogleLinked(currentUser)) {
    await ensureUserProfile(currentUser);
    notifyAuthListeners(currentUser);
    return {
      user: currentUser,
      mergedFromAnonymous: false,
      alreadyLinked: true,
    };
  }

  // 2. Se o usuário está autenticado anonimamente, usa linkWithPopup para preservar o UID
  if (currentUser && currentUser.isAnonymous) {
    const anonUid = currentUser.uid;
    let anonProfileData: Record<string, unknown> | null = null;
    try {
      const anonSnap = await getDoc(doc(db, 'users', anonUid));
      if (anonSnap.exists()) {
        anonProfileData = anonSnap.data();
      }
    } catch {
      // Ignore pre-read error
    }

    try {
      const linkedResult = await linkWithPopup(currentUser, provider);
      const googleName =
        linkedResult.user.displayName ||
        linkedResult.user.providerData.find((p) => p.providerId === 'google.com')?.displayName ||
        undefined;
      await ensureUserProfile(linkedResult.user, googleName);
      notifyAuthListeners(linkedResult.user);
      return {
        user: linkedResult.user,
        mergedFromAnonymous: false,
        alreadyLinked: false,
      };
    } catch (err: unknown) {
      const fbErr = err as FirebaseError | undefined;
      const code = fbErr?.code || '';

      if (
        code === 'auth/credential-already-in-use' ||
        code === 'auth/account-exists-with-different-credential' ||
        code === 'auth/email-already-in-use'
      ) {
        const credential = GoogleAuthProvider.credentialFromError(err as FirebaseError);
        const signInResult = credential
          ? await signInWithCredential(auth, credential)
          : await signInWithPopup(auth, provider);
        const googleUser = signInResult.user;

        await mergeAnonymousDataIntoGoogleUser(anonUid, anonProfileData, googleUser);
        notifyAuthListeners(googleUser);
        return {
          user: googleUser,
          mergedFromAnonymous: true,
          alreadyLinked: false,
        };
      }

      throw err;
    }
  }

  // 3. Caso não haja usuário logado, autentica com Google diretamente
  const result = await signInWithPopup(auth, provider);
  await ensureUserProfile(result.user);
  notifyAuthListeners(result.user);
  return {
    user: result.user,
    mergedFromAnonymous: false,
    alreadyLinked: false,
  };
}

async function mergeAnonymousDataIntoGoogleUser(
  anonUid: string,
  anonData: Record<string, unknown> | null,
  googleUser: User
): Promise<void> {
  if (!anonData || anonUid === googleUser.uid) {
    await ensureUserProfile(googleUser);
    return;
  }

  const googleUserRef = doc(db, 'users', googleUser.uid);
  const googleSnap = await getDoc(googleUserRef);

  const anonWins = typeof anonData.wins === 'number' ? anonData.wins : 0;
  const anonLosses = typeof anonData.losses === 'number' ? anonData.losses : 0;
  const anonDraws = typeof anonData.draws === 'number' ? anonData.draws : 0;
  const anonGoalsScored = typeof anonData.goalsScored === 'number' ? anonData.goalsScored : 0;
  const anonGoalsConceded = typeof anonData.goalsConceded === 'number' ? anonData.goalsConceded : 0;
  const anonMatches = typeof anonData.matchesPlayed === 'number' ? anonData.matchesPlayed : 0;
  const anonFriends = Array.isArray(anonData.friends) ? (anonData.friends as string[]) : [];
  const anonRoomCode = typeof anonData.currentRoomCode === 'string' ? anonData.currentRoomCode : '';
  const anonName = typeof anonData.displayName === 'string' ? anonData.displayName : '';
  const hasCustomAnonName = Boolean(anonName && !anonName.startsWith('Craque_'));

  const preferredName = (
    hasCustomAnonName
      ? anonName
      : googleUser.displayName || anonName || `Craque_${googleUser.uid.slice(0, 4).toUpperCase()}`
  ).slice(0, 28);

  if (!googleSnap.exists()) {
    await setDoc(googleUserRef, {
      uid: googleUser.uid,
      displayName: preferredName,
      tagCode: generateTagCode(googleUser.uid),
      status: anonData.status || 'online',
      currentRoomCode: anonRoomCode,
      friends: anonFriends.filter((id) => id !== googleUser.uid).slice(0, 200),
      wins: anonWins,
      losses: anonLosses,
      draws: anonDraws,
      goalsScored: anonGoalsScored,
      goalsConceded: anonGoalsConceded,
      matchesPlayed: anonMatches,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });
  } else {
    const existing = googleSnap.data();
    const existingFriends = Array.isArray(existing.friends) ? (existing.friends as string[]) : [];
    const mergedFriends = Array.from(new Set([...existingFriends, ...anonFriends])).filter(
      (id) => id !== googleUser.uid
    );

    await setDoc(googleUserRef, {
      uid: googleUser.uid,
      displayName: String(existing.displayName || preferredName).slice(0, 28),
      tagCode:
        typeof existing.tagCode === 'string' && existing.tagCode.length >= 2
          ? existing.tagCode.slice(0, 20)
          : generateTagCode(googleUser.uid),
      status: anonRoomCode ? 'in_room' : existing.status || 'online',
      currentRoomCode: String(anonRoomCode || existing.currentRoomCode || '').slice(0, 16),
      friends: mergedFriends.slice(0, 200),
      wins: Math.floor((typeof existing.wins === 'number' ? existing.wins : 0) + anonWins),
      losses: Math.floor((typeof existing.losses === 'number' ? existing.losses : 0) + anonLosses),
      draws: Math.floor((typeof existing.draws === 'number' ? existing.draws : 0) + anonDraws),
      goalsScored: Math.floor(
        (typeof existing.goalsScored === 'number' ? existing.goalsScored : 0) + anonGoalsScored
      ),
      goalsConceded: Math.floor(
        (typeof existing.goalsConceded === 'number' ? existing.goalsConceded : 0) +
          anonGoalsConceded
      ),
      matchesPlayed: Math.floor(
        (typeof existing.matchesPlayed === 'number' ? existing.matchesPlayed : 0) + anonMatches
      ),
      createdAt: existing.createdAt instanceof Timestamp ? existing.createdAt : serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Se o jogador anônimo estava em uma sala ativa, migra a vaga e liderança para o UID da conta Google
  if (anonRoomCode) {
    try {
      const roomRef = doc(db, 'rooms', anonRoomCode);
      const roomSnap = await getDoc(roomRef);
      if (roomSnap.exists()) {
        const rd = roomSnap.data();
        const slots: Record<string, MultiplayerSlot> = { ...(rd.slots || {}) };
        let changed = false;
        for (const key of Object.keys(slots)) {
          if (slots[key].uid === anonUid) {
            slots[key] = {
              ...slots[key],
              uid: googleUser.uid,
              displayName: preferredName,
              lastSeenMs: Date.now(),
            };
            changed = true;
          }
        }
        const nextHostUid = rd.hostUid === anonUid ? googleUser.uid : rd.hostUid;
        const nextHostName = rd.hostUid === anonUid ? preferredName : rd.hostName;
        if (changed || rd.hostUid === anonUid) {
          await setDoc(
            roomRef,
            buildSanitizedRoomPayload(anonRoomCode, rd, {
              hostUid: nextHostUid,
              hostName: nextHostName,
              slots,
              lastActivityMs: Date.now(),
            })
          );
        }
      }
    } catch {
      // Non-fatal room migration
    }
  }
}

function generateTagCode(uid: string): string {
  const suffix = uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
  return `#STF${suffix.padEnd(4, '9')}`;
}

export async function ensureUserProfile(user: User, preferredNickname?: string): Promise<void> {
  const userRef = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(userRef);
    const googleName = user.providerData?.find((p) => p.providerId === 'google.com')?.displayName;
    const defaultName =
      preferredNickname?.trim() ||
      user.displayName?.trim() ||
      googleName?.trim() ||
      `Craque_${user.uid.slice(0, 4).toUpperCase()}`;

    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        displayName: (defaultName || 'Jogador').slice(0, 28),
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
      const existingName = typeof existing.displayName === 'string' ? existing.displayName : '';
      const resolvedName =
        preferredNickname?.trim() ||
        (existingName && !existingName.startsWith('Craque_') ? existingName : defaultName);

      await setDoc(userRef, {
        uid: user.uid,
        displayName: (resolvedName || 'Jogador').slice(0, 28),
        tagCode:
          typeof existing.tagCode === 'string' && existing.tagCode.length >= 2
            ? existing.tagCode.slice(0, 20)
            : generateTagCode(user.uid),
        status:
          existing.status === 'in_room' ||
          existing.status === 'playing' ||
          existing.status === 'offline'
            ? existing.status
            : 'online',
        currentRoomCode:
          typeof existing.currentRoomCode === 'string' ? existing.currentRoomCode.slice(0, 16) : '',
        friends: Array.isArray(existing.friends)
          ? existing.friends.filter((f): f is string => typeof f === 'string').slice(0, 200)
          : [],
        wins: typeof existing.wins === 'number' && existing.wins >= 0 ? Math.floor(existing.wins) : 0,
        losses:
          typeof existing.losses === 'number' && existing.losses >= 0
            ? Math.floor(existing.losses)
            : 0,
        draws:
          typeof existing.draws === 'number' && existing.draws >= 0 ? Math.floor(existing.draws) : 0,
        goalsScored:
          typeof existing.goalsScored === 'number' && existing.goalsScored >= 0
            ? Math.floor(existing.goalsScored)
            : 0,
        goalsConceded:
          typeof existing.goalsConceded === 'number' && existing.goalsConceded >= 0
            ? Math.floor(existing.goalsConceded)
            : 0,
        matchesPlayed:
          typeof existing.matchesPlayed === 'number' && existing.matchesPlayed >= 0
            ? Math.floor(existing.matchesPlayed)
            : 0,
        createdAt: existing.createdAt instanceof Timestamp ? existing.createdAt : serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    console.warn(`Aviso ao sincronizar perfil users/${user.uid}:`, err);
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
  notifyAuthListeners(auth.currentUser);
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
    await setDoc(userRef, {
      uid: user.uid,
      displayName: String(d.displayName || user.displayName || 'Jogador').slice(0, 28),
      tagCode:
        typeof d.tagCode === 'string' && d.tagCode.length >= 2
          ? d.tagCode.slice(0, 20)
          : generateTagCode(user.uid),
      status,
      currentRoomCode: roomCode.slice(0, 16),
      friends: Array.isArray(d.friends)
        ? d.friends.filter((f): f is string => typeof f === 'string').slice(0, 200)
        : [],
      wins: typeof d.wins === 'number' && d.wins >= 0 ? Math.floor(d.wins) : 0,
      losses: typeof d.losses === 'number' && d.losses >= 0 ? Math.floor(d.losses) : 0,
      draws: typeof d.draws === 'number' && d.draws >= 0 ? Math.floor(d.draws) : 0,
      goalsScored:
        typeof d.goalsScored === 'number' && d.goalsScored >= 0 ? Math.floor(d.goalsScored) : 0,
      goalsConceded:
        typeof d.goalsConceded === 'number' && d.goalsConceded >= 0
          ? Math.floor(d.goalsConceded)
          : 0,
      matchesPlayed:
        typeof d.matchesPlayed === 'number' && d.matchesPlayed >= 0
          ? Math.floor(d.matchesPlayed)
          : 0,
      createdAt: d.createdAt instanceof Timestamp ? d.createdAt : serverTimestamp(),
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

  try {
    const snap = await getDoc(reqRef);
    if (snap.exists()) {
      const d = snap.data();
      await setDoc(reqRef, {
        fromUid: String(d.fromUid || request.fromUid),
        fromName: String(d.fromName || request.fromName || 'Jogador').slice(0, 28),
        fromTag: String(d.fromTag || request.fromTag || '#STF0000').slice(0, 16),
        toUid: String(d.toUid || request.toUid || user.uid),
        toName: String(d.toName || request.toName || 'Jogador').slice(0, 28),
        type:
          d.type === 'room_invite' || request.type === 'room_invite'
            ? 'room_invite'
            : 'friend_request',
        roomCode: String(d.roomCode ?? request.roomCode ?? '').slice(0, 16),
        status: accept ? 'accepted' : 'declined',
        createdAt: d.createdAt instanceof Timestamp ? d.createdAt : serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    console.warn(`Aviso ao atualizar friendRequests/${request.id}:`, err);
    if (request.type !== 'room_invite') {
      // Tenta remover caso o documento antigo estivesse com schema incompatível
      await deleteDoc(reqRef).catch(() => {});
    }
  }

  if (accept && request.type === 'friend_request') {
    try {
      const myRef = doc(db, 'users', user.uid);
      await updateDoc(myRef, {
        friends: arrayUnion(request.fromUid),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('Aviso ao adicionar amigo no perfil local:', err);
    }

    try {
      const senderRef = doc(db, 'users', request.fromUid);
      await updateDoc(senderRef, {
        friends: arrayUnion(user.uid),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('Aviso ao adicionar amigo no perfil remetente:', err);
    }
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

export function generateMatchId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MTC-';
  for (let i = 0; i < 6; i++) {
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
    matchId: d.matchId ? String(d.matchId) : undefined,
    roomName: String(d.roomName || `SEM TERRA FC — ${String(d.roomCode)}`),
    mode,
    visibility,
    hasPassword: Boolean(d.hasPassword),
    passwordHash: d.passwordHash ? String(d.passwordHash) : null,
    maxHumans: typeof d.maxHumans === 'number' ? d.maxHumans : mode === '2v2' ? 4 : 8,
    autoFillBots: d.autoFillBots !== false,
    activeCharacterIds,
    loadingReadyUids: Array.isArray(d.loadingReadyUids) ? (d.loadingReadyUids as string[]) : [],
    startAt: typeof d.startAt === 'number' ? d.startAt : undefined,
    lastActivityMs:
      typeof d.lastActivityMs === 'number'
        ? d.lastActivityMs
        : d.updatedAt instanceof Timestamp
        ? d.updatedAt.toMillis()
        : Date.now(),
    hostUid: String(d.hostUid),
    hostName: String(d.hostName),
    status: (d.status as 'waiting' | 'starting' | 'playing' | 'finished') || 'waiting',
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
  const mySnap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
  const hostName =
    mySnap && mySnap.exists()
      ? String(mySnap.data().displayName || user.displayName || 'Anfitrião').slice(0, 28)
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
    await withFirestoreTimeout(
      setDoc(roomRef, {
        roomCode,
        matchId: null,
        roomName,
        mode,
        visibility,
        hasPassword,
        passwordHash,
        maxHumans,
        autoFillBots: options?.autoFillBots !== false,
        activeCharacterIds,
        loadingReadyUids: [user.uid],
        startAt: null,
        lastActivityMs: nowMs,
        hostUid: user.uid,
        hostName,
        status: 'waiting',
        homeTeamId,
        awayTeamId,
        homeGoals: 0,
        awayGoals: 0,
        half: 1,
        remainingSeconds: Math.floor(halfDurationSeconds),
        slots,
        inputs: {},
        matchSnapshot: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
      8000,
      'Tempo limite excedido ao criar a sala. Verifique sua conexão e tente novamente.'
    );

    void updateUserPresence('in_room', roomCode);

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

  const [snap, mySnap] = await withFirestoreTimeout(
    Promise.all([
      getDoc(roomRef),
      getDoc(doc(db, 'users', user.uid)).catch(() => null),
    ]),
    8000,
    `Tempo limite ao buscar a sala ${roomCode}. Tente novamente.`
  );

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

  if ((d.status === 'playing' || d.status === 'starting') && !existingSlotKey) {
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

  const myName =
    mySnap && mySnap.exists()
      ? String(mySnap.data().displayName || user.displayName || 'Jogador').slice(0, 28)
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
  const nowMs = Date.now();

  try {
    const sanitizedPayload = buildSanitizedRoomPayload(roomCode, d, {
      slots,
      activeCharacterIds,
      lastActivityMs: nowMs,
    });

    await withFirestoreTimeout(
      setDoc(roomRef, sanitizedPayload),
      8000,
      `Tempo limite ao entrar na sala ${roomCode}. Tente novamente.`
    );

    void updateUserPresence('in_room', roomCode);

    return mapDocToRoomState({
      ...sanitizedPayload,
      lastActivityMs: nowMs,
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

  const mySnap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
  const myName =
    mySnap && mySnap.exists()
      ? String(mySnap.data().displayName || user.displayName || 'Jogador').slice(0, 28)
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
    await setDoc(
      roomRef,
      buildSanitizedRoomPayload(roomCode, d, {
        slots,
        activeCharacterIds,
        lastActivityMs: Date.now(),
      })
    );
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
    await setDoc(
      roomRef,
      buildSanitizedRoomPayload(roomCode, d, {
        slots,
        lastActivityMs: Date.now(),
      })
    );
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
      await setDoc(
        roomRef,
        buildSanitizedRoomPayload(roomCode, d, {
          slots,
          lastActivityMs: Date.now(),
        })
      );
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

    await setDoc(
      roomRef,
      buildSanitizedRoomPayload(roomCode, d, {
        slots,
        lastActivityMs: nowMs,
      })
    );
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
        // Quando o último jogador sair, encerrar e deletar a sala e o documento da partida
        if (d.matchId) {
          await deleteDoc(doc(db, 'matches', String(d.matchId))).catch(() => {});
        }
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

        await setDoc(
          roomRef,
          buildSanitizedRoomPayload(normalizedCode, d, {
            hostUid: nextHostUid,
            hostName: nextHostName,
            slots,
            activeCharacterIds,
            lastActivityMs: Date.now(),
          })
        );
      }
    }
    void updateUserPresence('online', '');
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
        if (d.matchId) {
          await deleteDoc(doc(db, 'matches', String(d.matchId))).catch(() => {});
        }
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
        if (d.matchId) {
          await deleteDoc(doc(db, 'matches', String(d.matchId))).catch(() => {});
        }
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
        if (d.matchId) {
          await deleteDoc(doc(db, 'matches', String(d.matchId))).catch(() => {});
        }
        await deleteDoc(docSnap.ref).catch(() => {});
      } else if (slotsChanged) {
        let nextHostUid = String(d.hostUid);
        let nextHostName = String(d.hostName);
        if (!remainingHumans.some((h) => h.uid === nextHostUid)) {
          nextHostUid = String(remainingHumans[0].uid);
          nextHostName = String(remainingHumans[0].displayName || 'Anfitrião').slice(0, 28);
        }
        await setDoc(
          docSnap.ref,
          buildSanitizedRoomPayload(docSnap.id, d, {
            hostUid: nextHostUid,
            hostName: nextHostName,
            slots,
            lastActivityMs: nowMs,
          })
        ).catch(() => {});
      }
    }
  } catch {
    // Non-fatal background sweep
  }
}

/**
 * Etapa 1 do Início Sincronizado: Host clica em "INICIAR PARTIDA".
 * Valida a sala, confirma jogadores humanos, preenche vagas restantes com bots,
 * cria o documento compartilhado /matches/{matchId} e atualiza status da sala para "starting".
 * Todos os clientes conectados na sala detectam status === "starting" e abrem a tela de carregamento.
 */
export async function startOnlineMatch(roomCode: string): Promise<string> {
  const user = await ensureAuthenticated();
  const roomRef = doc(db, 'rooms', roomCode);
  const snap = await withFirestoreTimeout(
    getDoc(roomRef),
    8000,
    'Tempo limite ao validar a sala para início da partida.'
  );
  if (!snap.exists()) {
    throw new Error('Sala não encontrada.');
  }
  const d = snap.data();
  if (d.hostUid !== user.uid) {
    throw new Error('Apenas o anfitrião da sala pode iniciar a partida.');
  }

  const roomMode: MatchFormatMode = d.mode === '2v2' ? '2v2' : '4v4';
  const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
  const activeCharacterIds = resolveActiveCharacterIdsForRoom(
    slots,
    roomMode,
    Array.isArray(d.activeCharacterIds) ? d.activeCharacterIds : undefined
  );

  const matchId =
    d.matchId && typeof d.matchId === 'string' && d.matchId.startsWith('MTC-')
      ? d.matchId
      : generateMatchId();
  const startAt = Date.now();

  const humanPlayers = Object.values(slots)
    .filter((s) => !s.isBot && s.uid && activeCharacterIds.includes(s.characterId))
    .map((s) => String(s.uid));
  const botCharacters = Object.values(slots)
    .filter((s) => s.isBot && activeCharacterIds.includes(s.characterId))
    .map((s) => s.characterId);

  try {
    // Cria documento compartilhado /matches/{matchId}
    const matchRef = doc(db, 'matches', matchId);
    await withFirestoreTimeout(
      setDoc(matchRef, {
        matchId,
        roomId: roomCode,
        hostId: user.uid,
        mode: roomMode,
        status: 'starting',
        players: humanPlayers.length > 0 ? humanPlayers : [user.uid],
        bots: botCharacters,
        score: {
          teamA: 0,
          teamB: 0,
        },
        ball: {
          x: 0,
          y: 0.22,
          z: 0,
        },
        startAt,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
      8000,
      'Tempo limite ao criar sessão de partida.'
    );

    // Atualiza sala para status: "starting" para disparar transição imediata em todos os convidados
    await withFirestoreTimeout(
      setDoc(
        roomRef,
        buildSanitizedRoomPayload(roomCode, d, {
          matchId,
          status: 'starting',
          startAt,
          activeCharacterIds,
          loadingReadyUids: [user.uid],
          lastActivityMs: startAt,
        })
      ),
      8000,
      'Tempo limite ao sincronizar início da partida.'
    );

    void updateUserPresence('playing', roomCode);
    return matchId;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomCode}`);
  }
}

/**
 * Etapa 2 do Início Sincronizado: Cada cliente conectado confirma que carregou o campo e personagens.
 * Quando todos os jogadores humanos da sala confirmarem (ou após o timeout de 5s via promoteRoomToPlaying),
 * a sala avança automaticamente de "starting" para "playing".
 */
export async function markPlayerMatchLoadingReady(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    const readyList = Array.isArray(d.loadingReadyUids)
      ? Array.from(new Set([...(d.loadingReadyUids as string[]), user.uid]))
      : [user.uid];

    const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
    const humanUids = Object.values(slots)
      .filter((s) => !s.isBot && s.uid)
      .map((s) => String(s.uid));
    const allHumansReady =
      humanUids.length > 0 && humanUids.every((uid) => readyList.includes(uid));

    const nextStatus =
      d.status === 'starting' && allHumansReady ? 'playing' : d.status;

    await setDoc(
      roomRef,
      buildSanitizedRoomPayload(roomCode, d, {
        status: nextStatus,
        loadingReadyUids: readyList,
        lastActivityMs: Date.now(),
      })
    );

    if (nextStatus === 'playing' && d.matchId) {
      const matchRef = doc(db, 'matches', String(d.matchId));
      const matchSnap = await getDoc(matchRef);
      if (matchSnap.exists()) {
        const md = matchSnap.data();
        await setDoc(matchRef, {
          matchId: String(md.matchId || d.matchId),
          roomId: String(md.roomId || roomCode),
          hostId: String(md.hostId || d.hostUid || user.uid),
          mode: md.mode === '2v2' ? '2v2' : '4v4',
          status: 'playing',
          players: Array.isArray(md.players) ? md.players.slice(0, 16) : [user.uid],
          bots: Array.isArray(md.bots) ? md.bots.slice(0, 16) : [],
          score: md.score && typeof md.score === 'object' ? md.score : { teamA: 0, teamB: 0 },
          ball: md.ball && typeof md.ball === 'object' ? md.ball : { x: 0, y: 0.22, z: 0 },
          startAt: typeof md.startAt === 'number' ? Math.floor(md.startAt) : Date.now(),
          createdAt: md.createdAt instanceof Timestamp ? md.createdAt : serverTimestamp(),
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
    }
  } catch {
    // Ignore transient race
  }
}

/**
 * Promove a sala de "starting" para "playing" (chamado quando todos os humanos estão prontos
 * ou quando o timeout de 5 segundos de carregamento se esgota).
 */
export async function promoteRoomToPlaying(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.status === 'finished' || d.status === 'playing') return;

    const readyList = Array.isArray(d.loadingReadyUids)
      ? Array.from(new Set([...(d.loadingReadyUids as string[]), user.uid]))
      : [user.uid];

    await setDoc(
      roomRef,
      buildSanitizedRoomPayload(roomCode, d, {
        status: 'playing',
        loadingReadyUids: readyList,
        lastActivityMs: Date.now(),
      })
    );

    if (d.matchId) {
      const matchRef = doc(db, 'matches', String(d.matchId));
      const matchSnap = await getDoc(matchRef);
      if (matchSnap.exists()) {
        const md = matchSnap.data();
        await setDoc(matchRef, {
          matchId: String(md.matchId || d.matchId),
          roomId: String(md.roomId || roomCode),
          hostId: String(md.hostId || d.hostUid || user.uid),
          mode: md.mode === '2v2' ? '2v2' : '4v4',
          status: 'playing',
          players: Array.isArray(md.players) ? md.players.slice(0, 16) : [user.uid],
          bots: Array.isArray(md.bots) ? md.bots.slice(0, 16) : [],
          score: md.score && typeof md.score === 'object' ? md.score : { teamA: 0, teamB: 0 },
          ball: md.ball && typeof md.ball === 'object' ? md.ball : { x: 0, y: 0.22, z: 0 },
          startAt: typeof md.startAt === 'number' ? Math.floor(md.startAt) : Date.now(),
          createdAt: md.createdAt instanceof Timestamp ? md.createdAt : serverTimestamp(),
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
    }
  } catch {
    // Ignore race condition if another client already promoted the room
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

    await setDoc(
      roomRef,
      buildSanitizedRoomPayload(roomCode, d, {
        homeGoals: snapshot.homeGoals,
        awayGoals: snapshot.awayGoals,
        half: snapshot.half,
        remainingSeconds: Math.max(0, Math.floor(snapshot.remainingSeconds)),
        matchSnapshot: snapshot,
        lastActivityMs: Date.now(),
      })
    );
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
    await setDoc(
      roomRef,
      buildSanitizedRoomPayload(roomCode, d, {
        inputs,
        lastActivityMs: Date.now(),
      })
    );
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
        homeGoals: Math.max(0, Math.min(99, Math.floor(homeGoals))),
        awayGoals: Math.max(0, Math.min(99, Math.floor(awayGoals))),
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

      await setDoc(userRef, {
        uid: user.uid,
        displayName: String(d.displayName || user.displayName || 'Jogador').slice(0, 28),
        tagCode:
          typeof d.tagCode === 'string' && d.tagCode.length >= 2
            ? d.tagCode.slice(0, 20)
            : generateTagCode(user.uid),
        status: 'online',
        currentRoomCode: '',
        friends: Array.isArray(d.friends)
          ? d.friends.filter((f): f is string => typeof f === 'string').slice(0, 200)
          : [],
        wins: Math.floor((typeof d.wins === 'number' ? d.wins : 0) + (didWin ? 1 : 0)),
        losses: Math.floor((typeof d.losses === 'number' ? d.losses : 0) + (didLose ? 1 : 0)),
        draws: Math.floor((typeof d.draws === 'number' ? d.draws : 0) + (didDraw ? 1 : 0)),
        goalsScored: Math.floor((typeof d.goalsScored === 'number' ? d.goalsScored : 0) + myTeamGoals),
        goalsConceded: Math.floor(
          (typeof d.goalsConceded === 'number' ? d.goalsConceded : 0) + opponentGoals
        ),
        matchesPlayed: Math.floor((typeof d.matchesPlayed === 'number' ? d.matchesPlayed : 0) + 1),
        createdAt: d.createdAt instanceof Timestamp ? d.createdAt : serverTimestamp(),
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
