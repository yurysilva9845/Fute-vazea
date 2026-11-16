import { FirebaseError, getApp, getApps, initializeApp } from 'firebase/app';
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
  getDocFromServer,
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

// Singleton initialization: prevents multiple Firebase App / Auth instances across hot reloads or re-imports
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
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

export interface FirestoreQuotaStatus {
  isExhausted: boolean;
  backoffUntilMs: number;
  attempt: number;
  friendlyMessage: string | null;
}

let quotaState: FirestoreQuotaStatus = {
  isExhausted: false,
  backoffUntilMs: 0,
  attempt: 0,
  friendlyMessage: null,
};
let quotaRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
const quotaStatusListeners = new Set<(status: FirestoreQuotaStatus) => void>();

export function isQuotaExceededError(error: unknown): boolean {
  if (!error) return false;
  const fbErr = error as FirebaseError | undefined;
  const code = String(fbErr?.code || '').toLowerCase();
  const msg = error instanceof Error ? error.message : String(error);
  return (
    code.includes('resource-exhausted') ||
    msg.includes('resource-exhausted') ||
    msg.includes('Quota exceeded')
  );
}

function notifyQuotaStatusListeners(): void {
  const snapshot = { ...quotaState };
  quotaStatusListeners.forEach((cb) => {
    try {
      cb(snapshot);
    } catch {
      // Ignore listener error
    }
  });
}

function registerQuotaExhausted(context: string, error: unknown): void {
  const nextAttempt = Math.min(6, quotaState.attempt + 1);
  // Backoff exponencial com jitter aleatório (15s, 30s, 60s, 120s, até 300s + 0..5s jitter)
  const baseDelayMs = Math.min(300_000, 15_000 * Math.pow(2, nextAttempt - 1));
  const jitterMs = Math.floor(Math.random() * 5000);
  const backoffMs = baseDelayMs + jitterMs;
  const untilMs = Date.now() + backoffMs;

  quotaState = {
    isExhausted: true,
    backoffUntilMs: untilMs,
    attempt: nextAttempt,
    friendlyMessage:
      'O serviço de salas em nuvem atingiu temporariamente o limite gratuito de requisições (Quota Exceeded). O jogo segue funcionando com cache local e servidor WebSocket de baixa latência.',
  };

  console.warn(
    `[STF-Firestore] Cota excedida (resource-exhausted) em "${context}". Backoff exponencial ativado por ${Math.round(
      backoffMs / 1000
    )}s (tentativa ${nextAttempt}).`,
    error
  );
  notifyQuotaStatusListeners();

  if (quotaRecoveryTimer) {
    clearTimeout(quotaRecoveryTimer);
  }
  quotaRecoveryTimer = setTimeout(() => {
    quotaState = {
      ...quotaState,
      isExhausted: false,
      friendlyMessage: null,
    };
    notifyQuotaStatusListeners();
  }, backoffMs);
}

export function isInQuotaBackoff(): boolean {
  if (!quotaState.isExhausted) return false;
  if (Date.now() >= quotaState.backoffUntilMs) {
    quotaState = {
      ...quotaState,
      isExhausted: false,
      friendlyMessage: null,
    };
    notifyQuotaStatusListeners();
    return false;
  }
  return true;
}

export function getQuotaStatus(): FirestoreQuotaStatus {
  isInQuotaBackoff();
  return { ...quotaState };
}

export function clearQuotaBackoffForManualRetry(): void {
  if (quotaRecoveryTimer) {
    clearTimeout(quotaRecoveryTimer);
    quotaRecoveryTimer = null;
  }
  quotaState = {
    isExhausted: false,
    backoffUntilMs: 0,
    attempt: 0,
    friendlyMessage: null,
  };
  notifyQuotaStatusListeners();
}

export function subscribeToQuotaStatus(
  cb: (status: FirestoreQuotaStatus) => void
): () => void {
  quotaStatusListeners.add(cb);
  cb(getQuotaStatus());
  return () => {
    quotaStatusListeners.delete(cb);
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  // Não confunde erro de cota (resource-exhausted) com falta de permissão
  if (isQuotaExceededError(error)) {
    registerQuotaExhausted(path || operationType, error);
    throw new Error(
      'Serviço de nuvem temporariamente ocupado (limite de requisições atingido). Aguarde alguns segundos e tente novamente.'
    );
  }

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
let authObserverRegistered = false;
let isInteractiveAuthInProgress = false;
let lastNotifiedReadyUid: string | null = null;
let connectionValidatedOnce = false;
const profileSyncInFlight = new Map<string, Promise<void>>();
const syncedProfileUids = new Set<string>();
const authReadyListeners = new Set<(user: User | null) => void>();
const authStatusListeners = new Set<(info: AuthUserInfo) => void>();

// ============================================================================
// Local In-Memory Cache & Throttling State (Prevents Redundant Reads/Writes)
// ============================================================================
let cachedMyProfile: (OnlineUserProfile & { friends: string[] }) | null = null;
const cachedRoomDocsByCode = new Map<string, Record<string, unknown>>();
let cachedPublicRooms: MultiplayerRoomState[] = [];
let cachedOnlinePlayers: OnlineUserProfile[] = [];
let cachedIncomingRequests: FriendRequestDoc[] = [];
const cachedFriendsByKey = new Map<string, OnlineUserProfile[]>();

let lastPresenceWrite: {
  uid: string;
  status: string;
  roomCode: string;
  timestampMs: number;
} | null = null;
const lastRoomHeartbeatMsByCode = new Map<string, number>();
const lastVoiceMicWriteByCode = new Map<string, { micEnabled: boolean; timestampMs: number }>();
let lastAbandonedSweepMs = 0;

function logAuthInfo(message: string, details?: unknown): void {
  if (details !== undefined) {
    console.info(`[STF-Auth] ${message}`, details);
  } else {
    console.info(`[STF-Auth] ${message}`);
  }
}

function logAuthWarn(message: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.warn(`[STF-Auth] ${message} -> ${detail}`, error);
}

function logFirestoreWarn(context: string, error: unknown): void {
  if (isQuotaExceededError(error)) {
    registerQuotaExhausted(context, error);
    return;
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.warn(`[STF-Firestore] ${context} -> ${detail}`, error);
}

async function validateFirestoreConnectionOnce(): Promise<void> {
  if (connectionValidatedOnce || isInQuotaBackoff()) return;
  connectionValidatedOnce = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (isQuotaExceededError(error)) {
      registerQuotaExhausted('test/connection', error);
      return;
    }
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('[STF-Firestore] Please check your Firebase configuration (client is offline).');
    }
  }
}

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

function notifyAuthStatusListeners(user: User | null): void {
  const info = extractAuthUserInfo(user);
  authStatusListeners.forEach((cb) => {
    try {
      cb(info);
    } catch (err) {
      logAuthWarn('Erro em listener de status de autenticação', err);
    }
  });
}

function notifyAuthReadyListeners(user: User | null, force: boolean = false): void {
  const nextUid = user?.uid ?? null;
  if (!force && nextUid !== null && nextUid === lastNotifiedReadyUid) {
    // Mesmo UID já notificado como pronto: apenas atualiza os listeners de UI (status/nome/provedor)
    notifyAuthStatusListeners(user);
    return;
  }
  lastNotifiedReadyUid = nextUid;
  notifyAuthStatusListeners(user);
  authReadyListeners.forEach((cb) => {
    try {
      cb(user);
    } catch (err) {
      logAuthWarn('Erro em listener authReady', err);
    }
  });
}

function notifyAuthListeners(user: User | null): void {
  notifyAuthReadyListeners(user, false);
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

function ensureSingleAuthObserverRegistered(): void {
  if (authObserverRegistered) return;
  authObserverRegistered = true;

  onAuthStateChanged(
    auth,
    async (user) => {
      if (user) {
        // Atualiza imediatamente a UI de status (Google vs Anônimo), mas aguarda token + perfil antes de liberar queries Firestore
        notifyAuthStatusListeners(user);
        try {
          await user.getIdToken();
        } catch (tokenErr) {
          logAuthWarn(`Falha ao validar token de sessão para UID ${user.uid}`, tokenErr);
        }
        try {
          await ensureUserProfile(user);
        } catch (profileErr) {
          logAuthWarn(`Falha ao inicializar perfil Firestore para UID ${user.uid}`, profileErr);
        }
        void validateFirestoreConnectionOnce();
        notifyAuthReadyListeners(user);
      } else {
        lastNotifiedReadyUid = null;
        notifyAuthStatusListeners(null);
        if (!isInteractiveAuthInProgress) {
          authReadyListeners.forEach((cb) => {
            try {
              cb(null);
            } catch (err) {
              logAuthWarn('Erro ao notificar desconexão em authReady', err);
            }
          });
        }
      }
    },
    (authObserverErr) => {
      logAuthWarn('Erro reportado pelo observador global onAuthStateChanged', authObserverErr);
    }
  );
}

ensureSingleAuthObserverRegistered();

export function subscribeToAuthReady(cb: (user: User | null) => void): () => void {
  ensureSingleAuthObserverRegistered();
  authReadyListeners.add(cb);

  if (auth.currentUser && lastNotifiedReadyUid === auth.currentUser.uid) {
    cb(auth.currentUser);
  } else {
    ensureAuthenticated()
      .then((u) => {
        if (authReadyListeners.has(cb)) {
          cb(u);
        }
      })
      .catch((err) => {
        logAuthWarn('Não foi possível confirmar sessão em subscribeToAuthReady', err);
        if (authReadyListeners.has(cb)) {
          cb(null);
        }
      });
  }

  return () => {
    authReadyListeners.delete(cb);
  };
}

export function subscribeToAuthStatus(cb: (info: AuthUserInfo) => void): () => void {
  ensureSingleAuthObserverRegistered();
  authStatusListeners.add(cb);
  if (auth.currentUser) {
    cb(extractAuthUserInfo(auth.currentUser));
  } else {
    cb(extractAuthUserInfo(null));
    ensureAuthenticated()
      .then((u) => {
        if (authStatusListeners.has(cb)) {
          cb(extractAuthUserInfo(u));
        }
      })
      .catch((err) => {
        logAuthWarn('Não foi possível obter status inicial em subscribeToAuthStatus', err);
        if (authStatusListeners.has(cb)) {
          cb(extractAuthUserInfo(null));
        }
      });
  }
  return () => {
    authStatusListeners.delete(cb);
  };
}

export function ensureAuthenticated(): Promise<User> {
  ensureSingleAuthObserverRegistered();

  if (auth.currentUser && lastNotifiedReadyUid === auth.currentUser.uid) {
    return Promise.resolve(auth.currentUser);
  }

  if (!authReadyPromise) {
    authReadyPromise = (async () => {
      try {
        // 1. Aguarda a restauração nativa da sessão persistida no IndexedDB/LocalStorage sem registrar novo onAuthStateChanged
        if (typeof auth.authStateReady === 'function') {
          await auth.authStateReady();
        }

        let activeUser = auth.currentUser;

        // 2. Se não houver sessão persistida e nenhum login Google interativo estiver em andamento, cria sessão anônima
        if (!activeUser && !isInteractiveAuthInProgress) {
          logAuthInfo('Nenhuma sessão prévia restaurada; iniciando autenticação anônima.');
          const cred = await signInAnonymously(auth);
          activeUser = cred.user;
        }

        if (!activeUser) {
          throw new Error('Sessão de autenticação indisponível no momento.');
        }

        await activeUser.getIdToken();
        await ensureUserProfile(activeUser);
        notifyAuthReadyListeners(activeUser);
        return activeUser;
      } catch (err) {
        logAuthWarn('Erro durante ensureAuthenticated()', err);
        throw err;
      } finally {
        authReadyPromise = null;
      }
    })();
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
    notifyAuthStatusListeners(currentUser);
    return {
      user: currentUser,
      mergedFromAnonymous: false,
      alreadyLinked: true,
    };
  }

  isInteractiveAuthInProgress = true;
  try {
    // 2. Se o usuário está autenticado anonimamente, usa linkWithPopup para preservar o UID
    if (currentUser && currentUser.isAnonymous) {
      const anonUid = currentUser.uid;
      let anonProfileData: Record<string, unknown> | null = null;
      try {
        const anonSnap = await getDoc(doc(db, 'users', anonUid));
        if (anonSnap.exists()) {
          anonProfileData = anonSnap.data();
        }
      } catch (readErr) {
        logFirestoreWarn(`Leitura pré-vinculação de users/${anonUid} ignorada`, readErr);
      }

      try {
        const linkedResult = await linkWithPopup(currentUser, provider);
        const googleName =
          linkedResult.user.displayName ||
          linkedResult.user.providerData.find((p) => p.providerId === 'google.com')?.displayName ||
          undefined;
        await ensureUserProfile(linkedResult.user, googleName);
        notifyAuthStatusListeners(linkedResult.user);
        logAuthInfo(`Conta anônima ${anonUid} vinculada ao Google preservando o mesmo UID.`);
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
          logAuthInfo(
            `Conta Google já existente detectada (${code}). Mesclando progresso anônimo (${anonUid}) para a conta Google existente.`
          );
          const credential = GoogleAuthProvider.credentialFromError(err as FirebaseError);
          const signInResult = credential
            ? await signInWithCredential(auth, credential)
            : await signInWithPopup(auth, provider);
          const googleUser = signInResult.user;

          await googleUser.getIdToken();
          await mergeAnonymousDataIntoGoogleUser(anonUid, anonProfileData, googleUser);
          notifyAuthReadyListeners(googleUser);
          return {
            user: googleUser,
            mergedFromAnonymous: true,
            alreadyLinked: false,
          };
        }

        logAuthWarn('Erro ao vincular conta Google via linkWithPopup', err);
        throw err;
      }
    }

    // 3. Caso não haja usuário logado, autentica com Google diretamente
    const result = await signInWithPopup(auth, provider);
    await result.user.getIdToken();
    await ensureUserProfile(result.user);
    notifyAuthReadyListeners(result.user);
    return {
      user: result.user,
      mergedFromAnonymous: false,
      alreadyLinked: false,
    };
  } finally {
    isInteractiveAuthInProgress = false;
  }
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
  if (isInQuotaBackoff()) return;

  // Se o perfil deste UID já foi sincronizado nesta sessão e não há troca de apelido, usa o cache local sem consultar o Firestore
  if (
    !preferredNickname?.trim() &&
    syncedProfileUids.has(user.uid) &&
    cachedMyProfile &&
    cachedMyProfile.uid === user.uid
  ) {
    return;
  }

  const syncKey = `${user.uid}:${preferredNickname?.trim() || ''}`;
  const existingSync = profileSyncInFlight.get(syncKey);
  if (existingSync) {
    return existingSync;
  }

  const syncTask = (async () => {
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
        const newProfileDoc = {
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
        };
        await setDoc(userRef, newProfileDoc);
        cachedMyProfile = mapDocToOnlineUserProfile(user.uid, newProfileDoc);
        syncedProfileUids.add(user.uid);
      } else {
        const existing = snap.data();
        const existingName = typeof existing.displayName === 'string' ? existing.displayName : '';
        const resolvedName =
          preferredNickname?.trim() ||
          (existingName && !existingName.startsWith('Craque_') ? existingName : defaultName);

        // Só regrava o documento no boot se o nickname mudou ou se algum campo obrigatório do schema precisar de normalização
        const needsNormalization =
          Boolean(preferredNickname?.trim() && preferredNickname.trim() !== existingName) ||
          existing.uid !== user.uid ||
          typeof existing.tagCode !== 'string' ||
          existing.tagCode.length < 2 ||
          typeof existing.currentRoomCode !== 'string' ||
          !Array.isArray(existing.friends) ||
          typeof existing.wins !== 'number' ||
          typeof existing.losses !== 'number' ||
          typeof existing.draws !== 'number' ||
          typeof existing.goalsScored !== 'number' ||
          !(existing.createdAt instanceof Timestamp) ||
          !(existing.updatedAt instanceof Timestamp);

        if (needsNormalization) {
          const normalizedDoc = {
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
              typeof existing.currentRoomCode === 'string'
                ? existing.currentRoomCode.slice(0, 16)
                : '',
            friends: Array.isArray(existing.friends)
              ? existing.friends.filter((f): f is string => typeof f === 'string').slice(0, 200)
              : [],
            wins:
              typeof existing.wins === 'number' && existing.wins >= 0
                ? Math.floor(existing.wins)
                : 0,
            losses:
              typeof existing.losses === 'number' && existing.losses >= 0
                ? Math.floor(existing.losses)
                : 0,
            draws:
              typeof existing.draws === 'number' && existing.draws >= 0
                ? Math.floor(existing.draws)
                : 0,
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
            createdAt:
              existing.createdAt instanceof Timestamp ? existing.createdAt : serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          await setDoc(userRef, normalizedDoc);
          cachedMyProfile = mapDocToOnlineUserProfile(user.uid, normalizedDoc);
        } else {
          cachedMyProfile = mapDocToOnlineUserProfile(user.uid, existing);
        }
        syncedProfileUids.add(user.uid);
      }
    } catch (err) {
      logFirestoreWarn(`Falha ao sincronizar perfil users/${user.uid}`, err);
    } finally {
      profileSyncInFlight.delete(syncKey);
    }
  })();

  profileSyncInFlight.set(syncKey, syncTask);
  return syncTask;
}

export async function updateNickname(newName: string): Promise<void> {
  const user = await ensureAuthenticated();
  const cleanName = newName.trim().slice(0, 28);
  if (!cleanName) return;
  if (cachedMyProfile && cachedMyProfile.uid === user.uid && cachedMyProfile.displayName === cleanName) {
    return;
  }

  try {
    await updateProfile(user, { displayName: cleanName });
  } catch (err) {
    logAuthWarn('Aviso ao atualizar displayName no Firebase Auth', err);
  }
  await ensureUserProfile(user, cleanName);
  notifyAuthStatusListeners(auth.currentUser);
}

export async function updateUserPresence(
  status: 'online' | 'in_room' | 'playing' | 'offline',
  roomCode: string = ''
): Promise<void> {
  const user = auth.currentUser;
  if (!user || isInQuotaBackoff()) return;

  const cleanRoom = roomCode.trim().toUpperCase().slice(0, 16);
  const nowMs = Date.now();

  // Evita gravar no Firestore quando o status e o roomCode não mudaram!
  if (
    lastPresenceWrite &&
    lastPresenceWrite.uid === user.uid &&
    lastPresenceWrite.status === status &&
    lastPresenceWrite.roomCode === cleanRoom
  ) {
    return;
  }

  if (
    cachedMyProfile &&
    cachedMyProfile.uid === user.uid &&
    cachedMyProfile.status === status &&
    cachedMyProfile.currentRoomCode === cleanRoom &&
    lastPresenceWrite &&
    nowMs - lastPresenceWrite.timestampMs < 30_000
  ) {
    return;
  }

  lastPresenceWrite = {
    uid: user.uid,
    status,
    roomCode: cleanRoom,
    timestampMs: nowMs,
  };

  if (cachedMyProfile && cachedMyProfile.uid === user.uid) {
    cachedMyProfile = {
      ...cachedMyProfile,
      status: status === 'offline' ? 'online' : status,
      currentRoomCode: cleanRoom,
      updatedAt: nowMs,
    };
  }

  const userRef = doc(db, 'users', user.uid);
  try {
    // Usa o perfil em cache local para evitar getDoc antes do setDoc
    if (cachedMyProfile && cachedMyProfile.uid === user.uid) {
      await setDoc(userRef, {
        uid: user.uid,
        displayName: String(cachedMyProfile.displayName || user.displayName || 'Jogador').slice(0, 28),
        tagCode:
          typeof cachedMyProfile.tagCode === 'string' && cachedMyProfile.tagCode.length >= 2
            ? cachedMyProfile.tagCode.slice(0, 20)
            : generateTagCode(user.uid),
        status,
        currentRoomCode: cleanRoom,
        friends: Array.isArray(cachedMyProfile.friends)
          ? cachedMyProfile.friends.filter((f): f is string => typeof f === 'string').slice(0, 200)
          : [],
        wins: Math.max(0, Math.floor(cachedMyProfile.wins || 0)),
        losses: Math.max(0, Math.floor(cachedMyProfile.losses || 0)),
        draws: Math.max(0, Math.floor(cachedMyProfile.draws || 0)),
        goalsScored: Math.max(0, Math.floor(cachedMyProfile.goalsScored || 0)),
        goalsConceded: Math.max(0, Math.floor(cachedMyProfile.goalsConceded || 0)),
        matchesPlayed: Math.max(0, Math.floor(cachedMyProfile.matchesPlayed || 0)),
        createdAt: Timestamp.fromMillis(cachedMyProfile.createdAt || nowMs),
        updatedAt: serverTimestamp(),
      });
      return;
    }

    const snap = await getDoc(userRef);
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.status === status && String(d.currentRoomCode || '') === cleanRoom) {
      return;
    }
    await setDoc(userRef, {
      uid: user.uid,
      displayName: String(d.displayName || user.displayName || 'Jogador').slice(0, 28),
      tagCode:
        typeof d.tagCode === 'string' && d.tagCode.length >= 2
          ? d.tagCode.slice(0, 20)
          : generateTagCode(user.uid),
      status,
      currentRoomCode: cleanRoom,
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
  } catch (err) {
    logFirestoreWarn('Aviso em updateUserPresence', err);
  }
}

function mapDocToOnlineUserProfile(
  id: string,
  d: Record<string, unknown>
): OnlineUserProfile & { friends: string[] } {
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

// Multiplexador de subscribeToMyProfile (garante apenas 1 onSnapshot em users/{uid} em todo o app)
const myProfileSubscribers = new Set<
  (profile: (OnlineUserProfile & { friends: string[] }) | null) => void
>();
let sharedMyProfileUnsubDoc: (() => void) | null = null;
let sharedMyProfileUnsubAuth: (() => void) | null = null;
let sharedMyProfileActiveUid: string | null = null;

function teardownSharedMyProfileListener(): void {
  if (sharedMyProfileUnsubDoc) {
    sharedMyProfileUnsubDoc();
    sharedMyProfileUnsubDoc = null;
  }
  if (sharedMyProfileUnsubAuth) {
    sharedMyProfileUnsubAuth();
    sharedMyProfileUnsubAuth = null;
  }
  sharedMyProfileActiveUid = null;
}

export function subscribeToMyProfile(
  cb: (profile: (OnlineUserProfile & { friends: string[] }) | null) => void
): () => void {
  myProfileSubscribers.add(cb);
  if (cachedMyProfile) {
    cb(cachedMyProfile);
  }

  if (!sharedMyProfileUnsubAuth) {
    sharedMyProfileUnsubAuth = subscribeToAuthReady((user) => {
      const nextUid = user?.uid ?? null;
      if (nextUid === sharedMyProfileActiveUid && sharedMyProfileUnsubDoc) {
        return;
      }

      if (sharedMyProfileUnsubDoc) {
        sharedMyProfileUnsubDoc();
        sharedMyProfileUnsubDoc = null;
      }
      sharedMyProfileActiveUid = nextUid;

      if (!user || isInQuotaBackoff()) {
        if (!user) {
          cachedMyProfile = null;
        }
        myProfileSubscribers.forEach((sub) => sub(cachedMyProfile));
        return;
      }

      const userRef = doc(db, 'users', user.uid);
      sharedMyProfileUnsubDoc = onSnapshot(
        userRef,
        (snap) => {
          if (snap.exists()) {
            cachedMyProfile = mapDocToOnlineUserProfile(snap.id, snap.data());
            syncedProfileUids.add(user.uid);
          } else {
            cachedMyProfile = null;
          }
          myProfileSubscribers.forEach((sub) => sub(cachedMyProfile));
        },
        (err) => {
          logFirestoreWarn(`Erro no listener subscribeToMyProfile (users/${user.uid})`, err);
        }
      );
    });
  }

  return () => {
    myProfileSubscribers.delete(cb);
    if (myProfileSubscribers.size === 0) {
      teardownSharedMyProfileListener();
    }
  };
}

// Multiplexador de subscribeToOnlinePlayers (máximo 1 listener compartilhado na aba Amigos)
const onlinePlayersSubscribers = new Set<(players: OnlineUserProfile[]) => void>();
let sharedOnlinePlayersUnsubSnap: (() => void) | null = null;
let sharedOnlinePlayersUnsubAuth: (() => void) | null = null;
let sharedOnlinePlayersActiveUid: string | null = null;

export function subscribeToOnlinePlayers(cb: (players: OnlineUserProfile[]) => void): () => void {
  onlinePlayersSubscribers.add(cb);
  if (cachedOnlinePlayers.length > 0) {
    cb(cachedOnlinePlayers);
  }

  if (!sharedOnlinePlayersUnsubAuth) {
    sharedOnlinePlayersUnsubAuth = subscribeToAuthReady((user) => {
      const nextUid = user?.uid ?? null;
      if (nextUid === sharedOnlinePlayersActiveUid && sharedOnlinePlayersUnsubSnap) {
        return;
      }

      if (sharedOnlinePlayersUnsubSnap) {
        sharedOnlinePlayersUnsubSnap();
        sharedOnlinePlayersUnsubSnap = null;
      }
      sharedOnlinePlayersActiveUid = nextUid;

      if (!user || isInQuotaBackoff()) {
        onlinePlayersSubscribers.forEach((sub) => sub(cachedOnlinePlayers));
        return;
      }

      const q = query(collection(db, 'users'), limit(20));
      sharedOnlinePlayersUnsubSnap = onSnapshot(
        q,
        (snap) => {
          const list: OnlineUserProfile[] = [];
          snap.forEach((docSnap) => {
            list.push(mapDocToOnlineUserProfile(docSnap.id, docSnap.data()));
          });
          list.sort((a, b) => b.updatedAt - a.updatedAt);
          cachedOnlinePlayers = list;
          onlinePlayersSubscribers.forEach((sub) => sub(list));
        },
        (err) => {
          logFirestoreWarn('Erro no listener subscribeToOnlinePlayers (users)', err);
        }
      );
    });
  }

  return () => {
    onlinePlayersSubscribers.delete(cb);
    if (onlinePlayersSubscribers.size === 0) {
      if (sharedOnlinePlayersUnsubSnap) {
        sharedOnlinePlayersUnsubSnap();
        sharedOnlinePlayersUnsubSnap = null;
      }
      if (sharedOnlinePlayersUnsubAuth) {
        sharedOnlinePlayersUnsubAuth();
        sharedOnlinePlayersUnsubAuth = null;
      }
      sharedOnlinePlayersActiveUid = null;
    }
  };
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

export async function sendFriendRequestByTag(
  targetTagOrName: string
): Promise<{ ok: boolean; message: string }> {
  if (isInQuotaBackoff()) {
    return {
      ok: false,
      message: 'Serviço temporariamente ocupado. Aguarde alguns segundos e tente novamente.',
    };
  }
  const user = await ensureAuthenticated();
  const search = targetTagOrName.trim();
  if (!search) {
    return { ok: false, message: 'Digite o código #STF ou nome do amigo.' };
  }

  let meName = cachedMyProfile?.displayName || user.displayName || 'Jogador';
  let meTag = cachedMyProfile?.tagCode || generateTagCode(user.uid);

  if (!cachedMyProfile || cachedMyProfile.uid !== user.uid) {
    const mySnap = await getDoc(doc(db, 'users', user.uid));
    if (!mySnap.exists()) {
      return { ok: false, message: 'Perfil ainda não carregado.' };
    }
    const me = mySnap.data();
    meName = String(me.displayName || meName);
    meTag = String(me.tagCode || meTag);
  }

  // Primeiro verifica no cache local de jogadores online para economizar leituras getDocs
  let targetUid: string | null = null;
  let targetDisplayName: string | null = null;
  const cachedMatch = cachedOnlinePlayers.find(
    (p) =>
      p.tagCode.toUpperCase() === search.toUpperCase() ||
      p.displayName.toLowerCase() === search.toLowerCase()
  );

  if (cachedMatch) {
    targetUid = cachedMatch.uid;
    targetDisplayName = cachedMatch.displayName;
  } else {
    let q = query(collection(db, 'users'), where('tagCode', '==', search.toUpperCase()), limit(3));
    let snap = await getDocs(q);

    if (snap.empty) {
      q = query(collection(db, 'users'), where('displayName', '==', search), limit(3));
      snap = await getDocs(q);
    }

    if (snap.empty) {
      return { ok: false, message: 'Nenhum jogador encontrado com essa Tag ou Nome.' };
    }
    targetUid = snap.docs[0].id;
    targetDisplayName = String(snap.docs[0].data().displayName || 'Amigo');
  }

  if (targetUid === user.uid) {
    return { ok: false, message: 'Você não pode adicionar a si mesmo!' };
  }

  try {
    await addDoc(collection(db, 'friendRequests'), {
      fromUid: user.uid,
      fromName: meName.slice(0, 28),
      fromTag: meTag.slice(0, 16),
      toUid: targetUid,
      toName: (targetDisplayName || 'Amigo').slice(0, 28),
      type: 'friend_request',
      roomCode: '',
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { ok: true, message: `Pedido enviado para ${targetDisplayName}!` };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, 'friendRequests');
  }
}

export async function sendRoomInviteToFriend(
  friendUid: string,
  friendName: string,
  roomCode: string
): Promise<void> {
  if (isInQuotaBackoff()) return;
  const user = await ensureAuthenticated();
  const meName = cachedMyProfile?.displayName || user.displayName || 'Craque';
  const meTag = cachedMyProfile?.tagCode || generateTagCode(user.uid);

  try {
    await addDoc(collection(db, 'friendRequests'), {
      fromUid: user.uid,
      fromName: String(meName).slice(0, 28),
      fromTag: String(meTag).slice(0, 16),
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
  if (isInQuotaBackoff()) return;
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
    logFirestoreWarn(`Aviso ao atualizar friendRequests/${request.id}`, err);
    if (request.type !== 'room_invite') {
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
      logFirestoreWarn('Aviso ao adicionar amigo no perfil local', err);
    }

    try {
      const senderRef = doc(db, 'users', request.fromUid);
      await updateDoc(senderRef, {
        friends: arrayUnion(user.uid),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      logFirestoreWarn('Aviso ao adicionar amigo no perfil remetente', err);
    }
  }
}

// Multiplexador de subscribeToIncomingRequests
const incomingRequestsSubscribers = new Set<(requests: FriendRequestDoc[]) => void>();
let sharedIncomingUnsubSnap: (() => void) | null = null;
let sharedIncomingUnsubAuth: (() => void) | null = null;
let sharedIncomingActiveUid: string | null = null;

export function subscribeToIncomingRequests(
  cb: (requests: FriendRequestDoc[]) => void
): () => void {
  incomingRequestsSubscribers.add(cb);
  if (cachedIncomingRequests.length > 0) {
    cb(cachedIncomingRequests);
  }

  if (!sharedIncomingUnsubAuth) {
    sharedIncomingUnsubAuth = subscribeToAuthReady((user) => {
      const nextUid = user?.uid ?? null;
      if (nextUid === sharedIncomingActiveUid && sharedIncomingUnsubSnap) {
        return;
      }

      if (sharedIncomingUnsubSnap) {
        sharedIncomingUnsubSnap();
        sharedIncomingUnsubSnap = null;
      }
      sharedIncomingActiveUid = nextUid;

      if (!user || isInQuotaBackoff()) {
        if (!user) cachedIncomingRequests = [];
        incomingRequestsSubscribers.forEach((sub) => sub(cachedIncomingRequests));
        return;
      }

      const q = query(
        collection(db, 'friendRequests'),
        where('toUid', '==', user.uid),
        limit(20)
      );
      sharedIncomingUnsubSnap = onSnapshot(
        q,
        (snap) => {
          const list: FriendRequestDoc[] = [];
          snap.forEach((docSnap) => {
            const d = docSnap.data();
            const status = (d.status as 'pending' | 'accepted' | 'declined') || 'pending';
            if (status !== 'pending') return;
            list.push({
              id: docSnap.id,
              fromUid: String(d.fromUid),
              fromName: String(d.fromName),
              fromTag: String(d.fromTag || '#STF'),
              toUid: String(d.toUid),
              toName: String(d.toName),
              type: (d.type as 'friend_request' | 'room_invite') || 'friend_request',
              roomCode: String(d.roomCode || ''),
              status,
              createdAt: d.createdAt instanceof Timestamp ? d.createdAt.toMillis() : Date.now(),
            });
          });
          list.sort((a, b) => b.createdAt - a.createdAt);
          cachedIncomingRequests = list;
          incomingRequestsSubscribers.forEach((sub) => sub(list));
        },
        (err) => {
          logFirestoreWarn(`Erro no listener subscribeToIncomingRequests (toUid=${user.uid})`, err);
        }
      );
    });
  }

  return () => {
    incomingRequestsSubscribers.delete(cb);
    if (incomingRequestsSubscribers.size === 0) {
      if (sharedIncomingUnsubSnap) {
        sharedIncomingUnsubSnap();
        sharedIncomingUnsubSnap = null;
      }
      if (sharedIncomingUnsubAuth) {
        sharedIncomingUnsubAuth();
        sharedIncomingUnsubAuth = null;
      }
      sharedIncomingActiveUid = null;
    }
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
  const slice = Array.from(new Set(friendUids.filter(Boolean))).sort().slice(0, 20);
  if (slice.length === 0) {
    cb([]);
    return () => {};
  }

  const cacheKey = slice.join(',');
  const cached = cachedFriendsByKey.get(cacheKey);
  if (cached) {
    cb(cached);
  }

  let unsubSnap: (() => void) | null = null;
  let activeUid: string | null = null;

  const unsubAuth = subscribeToAuthReady((user) => {
    const nextUid = user?.uid ?? null;
    if (nextUid === activeUid && unsubSnap) {
      return;
    }
    if (unsubSnap) {
      unsubSnap();
      unsubSnap = null;
    }
    activeUid = nextUid;
    if (!user || isInQuotaBackoff()) {
      cb(cachedFriendsByKey.get(cacheKey) || []);
      return;
    }
    const q = query(collection(db, 'users'), where('uid', 'in', slice));
    unsubSnap = onSnapshot(
      q,
      (snap) => {
        const list: OnlineUserProfile[] = [];
        snap.forEach((docSnap) => {
          list.push(mapDocToOnlineUserProfile(docSnap.id, docSnap.data()));
        });
        cachedFriendsByKey.set(cacheKey, list);
        cb(list);
      },
      (err) => {
        logFirestoreWarn('Erro no listener subscribeToFriendsProfiles', err);
      }
    );
  });

  return () => {
    unsubAuth();
    activeUid = null;
    if (unsubSnap) {
      unsubSnap();
      unsubSnap = null;
    }
  };
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
  const hostName = (
    cachedMyProfile?.displayName ||
    user.displayName ||
    'Anfitrião'
  ).slice(0, 28);

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

  const roomDocPayload = {
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
  };

  const roomRef = doc(db, 'rooms', roomCode);
  try {
    await withFirestoreTimeout(
      setDoc(roomRef, roomDocPayload),
      8000,
      'Tempo limite excedido ao criar a sala. Verifique sua conexão e tente novamente.'
    );

    cachedRoomDocsByCode.set(roomCode, {
      ...roomDocPayload,
      createdAt: Timestamp.fromMillis(nowMs),
      updatedAt: Timestamp.fromMillis(nowMs),
    });
    lastRoomHeartbeatMsByCode.set(roomCode, nowMs);
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

  const snap = await withFirestoreTimeout(
    getDoc(roomRef),
    8000,
    `Tempo limite ao buscar a sala ${roomCode}. Tente novamente.`
  );

  if (!snap.exists()) {
    throw new Error('Sala não encontrada. Verifique o código da sala.');
  }

  const d = snap.data();
  cachedRoomDocsByCode.set(roomCode, d);

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

  const myName = (
    cachedMyProfile?.displayName ||
    user.displayName ||
    'Jogador'
  ).slice(0, 28);

  const maxAllowed = typeof d.maxHumans === 'number' ? d.maxHumans : roomMode === '2v2' ? 4 : 8;
  const currentHumanCount = Object.values(slots).filter((s) => !s.isBot && s.uid).length;

  // Se o jogador já está ocupando seu slot na sala com o mesmo nome, retorna o estado em cache sem regravar!
  if (
    existingSlotKey &&
    !slots[existingSlotKey].isBot &&
    slots[existingSlotKey].displayName === myName
  ) {
    void updateUserPresence('in_room', roomCode);
    return mapDocToRoomState(d);
  }

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

    cachedRoomDocsByCode.set(roomCode, {
      ...d,
      ...sanitizedPayload,
      updatedAt: Timestamp.fromMillis(nowMs),
    });
    lastRoomHeartbeatMsByCode.set(roomCode, nowMs);
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
  if (isInQuotaBackoff()) {
    return {
      ok: false,
      message: 'Serviço temporariamente ocupado. Aguarde alguns segundos.',
    };
  }
  const user = await ensureAuthenticated();
  const normalizedCode = roomCode.trim().toUpperCase();
  const roomRef = doc(db, 'rooms', normalizedCode);

  let d = cachedRoomDocsByCode.get(normalizedCode);
  if (!d) {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return { ok: false, message: 'Sala não existe mais.' };
    d = snap.data();
  }

  const roomMode: MatchFormatMode = d.mode === '2v2' ? '2v2' : '4v4';
  const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
  const targetSlot = slots[targetCharacterId];

  if (!targetSlot) return { ok: false, message: 'Personagem inválido.' };
  if (!targetSlot.isBot && targetSlot.uid === user.uid) {
    // Já está neste personagem — evita gravação desnecessária
    return { ok: true };
  }
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

  const myName = (
    cachedMyProfile?.displayName ||
    user.displayName ||
    'Jogador'
  ).slice(0, 28);

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
  const nowMs = Date.now();

  try {
    const nextPayload = buildSanitizedRoomPayload(normalizedCode, d, {
      slots,
      activeCharacterIds,
      lastActivityMs: nowMs,
    });
    await setDoc(roomRef, nextPayload);
    cachedRoomDocsByCode.set(normalizedCode, {
      ...d,
      ...nextPayload,
      updatedAt: Timestamp.fromMillis(nowMs),
    });
    return { ok: true };
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${normalizedCode}`);
  }
}

export async function togglePlayerReadyInRoom(roomCode: string, ready?: boolean): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode || isInQuotaBackoff()) return;
  const normalizedCode = roomCode.trim().toUpperCase();
  const roomRef = doc(db, 'rooms', normalizedCode);

  let d = cachedRoomDocsByCode.get(normalizedCode);
  if (!d) {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    d = snap.data();
  }

  const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
  let changed = false;

  for (const key of Object.keys(slots)) {
    if (slots[key].uid === user.uid) {
      const nextReady = ready !== undefined ? ready : !slots[key].isReady;
      if (Boolean(slots[key].isReady) !== Boolean(nextReady)) {
        slots[key] = {
          ...slots[key],
          isReady: nextReady,
          lastSeenMs: Date.now(),
        };
        changed = true;
      }
    }
  }

  if (!changed) return;

  try {
    const nowMs = Date.now();
    const nextPayload = buildSanitizedRoomPayload(normalizedCode, d, {
      slots,
      lastActivityMs: nowMs,
    });
    await setDoc(roomRef, nextPayload);
    cachedRoomDocsByCode.set(normalizedCode, {
      ...d,
      ...nextPayload,
      updatedAt: Timestamp.fromMillis(nowMs),
    });
  } catch (err) {
    logFirestoreWarn(`Aviso em togglePlayerReadyInRoom (${normalizedCode})`, err);
  }
}

export async function updatePlayerVoiceStatusInRoom(
  roomCode: string,
  micEnabled: boolean,
  _isSpeaking: boolean
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode || isInQuotaBackoff()) return;
  const normalizedCode = roomCode.trim().toUpperCase();
  const nowMs = Date.now();

  // Nunca grava flutuações de voz (isSpeaking a cada 220ms) no Firestore!
  // Apenas sincroniza mudança real do estado de mute/unmute (micEnabled) com throttle mínimo de 3s.
  const prevWrite = lastVoiceMicWriteByCode.get(normalizedCode);
  if (
    prevWrite &&
    prevWrite.micEnabled === micEnabled &&
    nowMs - prevWrite.timestampMs < 30_000
  ) {
    return;
  }
  if (prevWrite && nowMs - prevWrite.timestampMs < 3000) {
    return;
  }

  const d = cachedRoomDocsByCode.get(normalizedCode);
  if (!d) return;

  const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
  let changed = false;
  for (const key of Object.keys(slots)) {
    if (slots[key].uid === user.uid) {
      if (Boolean(slots[key].micEnabled) !== Boolean(micEnabled)) {
        slots[key] = {
          ...slots[key],
          micEnabled,
          isSpeaking: false,
          lastSeenMs: nowMs,
        };
        changed = true;
      }
    }
  }

  if (!changed) {
    lastVoiceMicWriteByCode.set(normalizedCode, { micEnabled, timestampMs: nowMs });
    return;
  }

  lastVoiceMicWriteByCode.set(normalizedCode, { micEnabled, timestampMs: nowMs });
  const roomRef = doc(db, 'rooms', normalizedCode);
  try {
    const nextPayload = buildSanitizedRoomPayload(normalizedCode, d, {
      slots,
      lastActivityMs: nowMs,
    });
    await setDoc(roomRef, nextPayload);
    cachedRoomDocsByCode.set(normalizedCode, {
      ...d,
      ...nextPayload,
      updatedAt: Timestamp.fromMillis(nowMs),
    });
  } catch (err) {
    logFirestoreWarn(`Aviso em updatePlayerVoiceStatusInRoom (${normalizedCode})`, err);
  }
}

export async function sendRoomHeartbeat(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode || isInQuotaBackoff()) return;
  const normalizedCode = roomCode.trim().toUpperCase();
  const nowMs = Date.now();

  // Rate-limit estrito: máximo 1 heartbeat a cada 40 segundos por sala
  const lastHb = lastRoomHeartbeatMsByCode.get(normalizedCode) || 0;
  if (nowMs - lastHb < 40_000) {
    return;
  }

  const cachedDoc = cachedRoomDocsByCode.get(normalizedCode);
  // Durante 'playing' ou 'starting', o servidor WebSocket 30Hz mantém a sessão viva — não grava heartbeat no Firestore!
  if (cachedDoc && (cachedDoc.status === 'playing' || cachedDoc.status === 'starting' || cachedDoc.status === 'finished')) {
    lastRoomHeartbeatMsByCode.set(normalizedCode, nowMs);
    return;
  }

  lastRoomHeartbeatMsByCode.set(normalizedCode, nowMs);
  const roomRef = doc(db, 'rooms', normalizedCode);

  try {
    let d = cachedDoc;
    if (!d) {
      const snap = await getDoc(roomRef);
      if (!snap.exists()) return;
      d = snap.data();
    }
    if (d.status === 'finished' || d.status === 'playing') return;

    const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
    let foundMySlot = false;
    for (const key of Object.keys(slots)) {
      if (slots[key].uid === user.uid) {
        slots[key] = {
          ...slots[key],
          lastSeenMs: nowMs,
        };
        foundMySlot = true;
      }
    }
    if (!foundMySlot) return;

    const nextPayload = buildSanitizedRoomPayload(normalizedCode, d, {
      slots,
      lastActivityMs: nowMs,
    });
    await setDoc(roomRef, nextPayload);
    cachedRoomDocsByCode.set(normalizedCode, {
      ...d,
      ...nextPayload,
      updatedAt: Timestamp.fromMillis(nowMs),
    });
  } catch (err) {
    logFirestoreWarn(`Aviso em sendRoomHeartbeat (${normalizedCode})`, err);
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

  lastRoomHeartbeatMsByCode.delete(normalizedCode);
  lastVoiceMicWriteByCode.delete(normalizedCode);

  if (isInQuotaBackoff()) {
    cachedRoomDocsByCode.delete(normalizedCode);
    return;
  }

  try {
    let d = cachedRoomDocsByCode.get(normalizedCode);
    if (!d) {
      const snap = await getDoc(roomRef);
      if (snap.exists()) {
        d = snap.data();
      }
    }
    cachedRoomDocsByCode.delete(normalizedCode);

    if (d) {
      const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
      let wasInRoom = false;

      for (const key of Object.keys(slots)) {
        if (slots[key].uid === user.uid) {
          slots[key] = convertSlotToBot(slots[key]);
          wasInRoom = true;
        }
      }

      if (!wasInRoom && d.hostUid !== user.uid) {
        void updateUserPresence('online', '');
        return;
      }

      const remainingHumans = Object.values(slots).filter((s) => !s.isBot && s.uid);

      if (remainingHumans.length === 0) {
        if (d.matchId) {
          await deleteDoc(doc(db, 'matches', String(d.matchId))).catch(() => {});
        }
        await deleteDoc(roomRef);
      } else {
        let nextHostUid = String(d.hostUid);
        let nextHostName = String(d.hostName);

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
  } catch (err) {
    logFirestoreWarn(`Aviso ao sair da sala ${normalizedCode}`, err);
  }
}

/**
 * Varre salas públicas/privadas para limpar jogadores que fecharam a aba sem aviso
 * e remover salas abandonadas sem nenhum humano ativo.
 * Executado sob controle de frequência (máximo 1 vez a cada 5 minutos) para evitar leituras desnecessárias.
 */
export async function cleanupAbandonedRoomsAndSlots(force: boolean = false): Promise<void> {
  if (!auth.currentUser || isInQuotaBackoff()) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastAbandonedSweepMs < 300_000) {
    return;
  }
  lastAbandonedSweepMs = nowMs;

  try {
    const q = query(collection(db, 'rooms'), limit(10));
    const snap = await getDocs(q);
    const ROOM_ABANDON_TIMEOUT_MS = 120_000;
    const SLOT_STALE_TIMEOUT_MS = 95_000;

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
        if (
          !slot.isBot &&
          slot.uid &&
          slot.lastSeenMs &&
          nowMs - slot.lastSeenMs > SLOT_STALE_TIMEOUT_MS
        ) {
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
  } catch (err) {
    logFirestoreWarn('Aviso na limpeza periódica de salas abandonadas', err);
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
  const normalizedCode = roomCode.trim().toUpperCase();
  const roomRef = doc(db, 'rooms', normalizedCode);

  let d = cachedRoomDocsByCode.get(normalizedCode);
  if (!d) {
    const snap = await withFirestoreTimeout(
      getDoc(roomRef),
      8000,
      'Tempo limite ao validar a sala para início da partida.'
    );
    if (!snap.exists()) {
      throw new Error('Sala não encontrada.');
    }
    d = snap.data();
  }

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
    const matchRef = doc(db, 'matches', matchId);
    await withFirestoreTimeout(
      setDoc(matchRef, {
        matchId,
        roomId: normalizedCode,
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

    const nextPayload = buildSanitizedRoomPayload(normalizedCode, d, {
      matchId,
      status: 'starting',
      startAt,
      activeCharacterIds,
      loadingReadyUids: [user.uid],
      lastActivityMs: startAt,
    });

    await withFirestoreTimeout(
      setDoc(roomRef, nextPayload),
      8000,
      'Tempo limite ao sincronizar início da partida.'
    );

    cachedRoomDocsByCode.set(normalizedCode, {
      ...d,
      ...nextPayload,
      updatedAt: Timestamp.fromMillis(startAt),
    });

    void updateUserPresence('playing', normalizedCode);
    return matchId;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${normalizedCode}`);
  }
}

/**
 * Etapa 2 do Início Sincronizado: Cada cliente conectado confirma que carregou o campo e personagens.
 * Quando todos os jogadores humanos da sala confirmarem (ou após o timeout de 5s via promoteRoomToPlaying),
 * a sala avança automaticamente de "starting" para "playing".
 */
export async function markPlayerMatchLoadingReady(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode || isInQuotaBackoff()) return;
  const normalizedCode = roomCode.trim().toUpperCase();
  const roomRef = doc(db, 'rooms', normalizedCode);

  try {
    let d = cachedRoomDocsByCode.get(normalizedCode);
    if (!d) {
      const snap = await getDoc(roomRef);
      if (!snap.exists()) return;
      d = snap.data();
    }

    if (d.status === 'playing' || d.status === 'finished') {
      return;
    }

    const existingReady = Array.isArray(d.loadingReadyUids)
      ? (d.loadingReadyUids as string[])
      : [];
    const readyList = Array.from(new Set([...existingReady, user.uid]));

    const slots: Record<string, MultiplayerSlot> = { ...(d.slots || {}) };
    const humanUids = Object.values(slots)
      .filter((s) => !s.isBot && s.uid)
      .map((s) => String(s.uid));
    const allHumansReady =
      humanUids.length > 0 && humanUids.every((uid) => readyList.includes(uid));

    const nextStatus =
      d.status === 'starting' && allHumansReady ? 'playing' : d.status;

    // Se o UID já estava na lista e o status não mudou, evita gravação redundante!
    if (existingReady.includes(user.uid) && nextStatus === d.status) {
      return;
    }

    const nowMs = Date.now();
    const nextPayload = buildSanitizedRoomPayload(normalizedCode, d, {
      status: nextStatus,
      loadingReadyUids: readyList,
      lastActivityMs: nowMs,
    });

    await setDoc(roomRef, nextPayload);
    cachedRoomDocsByCode.set(normalizedCode, {
      ...d,
      ...nextPayload,
      updatedAt: Timestamp.fromMillis(nowMs),
    });
  } catch (err) {
    logFirestoreWarn(`Aviso em markPlayerMatchLoadingReady (${normalizedCode})`, err);
  }
}

/**
 * Promove a sala de "starting" para "playing" (chamado quando todos os humanos estão prontos
 * ou quando o timeout de 5 segundos de carregamento se esgota).
 */
export async function promoteRoomToPlaying(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode || isInQuotaBackoff()) return;
  const normalizedCode = roomCode.trim().toUpperCase();
  const roomRef = doc(db, 'rooms', normalizedCode);

  try {
    let d = cachedRoomDocsByCode.get(normalizedCode);
    if (!d) {
      const snap = await getDoc(roomRef);
      if (!snap.exists()) return;
      d = snap.data();
    }
    if (d.status === 'finished' || d.status === 'playing') return;

    const readyList = Array.isArray(d.loadingReadyUids)
      ? Array.from(new Set([...(d.loadingReadyUids as string[]), user.uid]))
      : [user.uid];
    const nowMs = Date.now();
    const nextPayload = buildSanitizedRoomPayload(normalizedCode, d, {
      status: 'playing',
      loadingReadyUids: readyList,
      lastActivityMs: nowMs,
    });

    await setDoc(roomRef, nextPayload);
    cachedRoomDocsByCode.set(normalizedCode, {
      ...d,
      ...nextPayload,
      updatedAt: Timestamp.fromMillis(nowMs),
    });
  } catch (err) {
    logFirestoreWarn(`Aviso em promoteRoomToPlaying (${normalizedCode})`, err);
  }
}

/**
 * A física em 30Hz/60FPS (posições, rotações, animações, velocidades e bola) trafega
 * exclusivamente pelo servidor WebSocket autoritativo (realtimeMatchClient / server.ts).
 * Nunca grava snapshots de física frame a frame no Firestore.
 */
export async function publishHostMatchSnapshot(
  _roomCode: string,
  _snapshot: MultiplayerMatchSnapshot
): Promise<void> {
  // No-op no Firestore: evita consumo de cota em 60 FPS
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
  _roomCode: string,
  _input: ClientInputState
): Promise<void> {
  // No-op no Firestore: comandos de input trafegam pelo WebSocket de baixa latência
}

// Multiplexador de subscribeToRoom por roomCode (garante apenas 1 onSnapshot por sala mesmo com App + Modal abertos)
interface SharedRoomSubscription {
  subscribers: Set<
    (room: (MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null) => void
  >;
  unsubSnap: (() => void) | null;
  unsubAuth: (() => void) | null;
  activeUid: string | null;
  latestState: (MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null;
}
const sharedRoomSubscriptions = new Map<string, SharedRoomSubscription>();

export function subscribeToRoom(
  roomCode: string,
  cb: (
    room: (MultiplayerRoomState & { inputs?: Record<string, ClientInputState> }) | null
  ) => void
): () => void {
  const normalizedCode = roomCode.trim().toUpperCase();
  let entry = sharedRoomSubscriptions.get(normalizedCode);

  if (!entry) {
    entry = {
      subscribers: new Set(),
      unsubSnap: null,
      unsubAuth: null,
      activeUid: null,
      latestState: null,
    };
    sharedRoomSubscriptions.set(normalizedCode, entry);
  }

  entry.subscribers.add(cb);

  if (entry.latestState) {
    cb(entry.latestState);
  } else {
    const cachedDoc = cachedRoomDocsByCode.get(normalizedCode);
    if (cachedDoc) {
      cb({
        ...mapDocToRoomState(cachedDoc),
        inputs: (cachedDoc.inputs as Record<string, ClientInputState>) || {},
      });
    }
  }

  if (!entry.unsubAuth) {
    const currentEntry = entry;
    currentEntry.unsubAuth = subscribeToAuthReady((user) => {
      const nextUid = user?.uid ?? null;
      if (nextUid === currentEntry.activeUid && currentEntry.unsubSnap) {
        return;
      }
      if (currentEntry.unsubSnap) {
        currentEntry.unsubSnap();
        currentEntry.unsubSnap = null;
      }
      currentEntry.activeUid = nextUid;
      if (!user || isInQuotaBackoff()) {
        return;
      }

      const roomRef = doc(db, 'rooms', normalizedCode);
      currentEntry.unsubSnap = onSnapshot(
        roomRef,
        (snap) => {
          if (!snap.exists()) {
            cachedRoomDocsByCode.delete(normalizedCode);
            currentEntry.latestState = null;
            currentEntry.subscribers.forEach((sub) => sub(null));
            return;
          }
          const d = snap.data();
          cachedRoomDocsByCode.set(normalizedCode, d);
          const mapped = {
            ...mapDocToRoomState(d),
            inputs: (d.inputs as Record<string, ClientInputState>) || {},
          };
          currentEntry.latestState = mapped;
          currentEntry.subscribers.forEach((sub) => sub(mapped));
        },
        (err) => {
          logFirestoreWarn(`Erro no listener subscribeToRoom (rooms/${normalizedCode})`, err);
        }
      );
    });
  }

  return () => {
    const subEntry = sharedRoomSubscriptions.get(normalizedCode);
    if (!subEntry) return;
    subEntry.subscribers.delete(cb);
    if (subEntry.subscribers.size === 0) {
      if (subEntry.unsubSnap) {
        subEntry.unsubSnap();
        subEntry.unsubSnap = null;
      }
      if (subEntry.unsubAuth) {
        subEntry.unsubAuth();
        subEntry.unsubAuth = null;
      }
      subEntry.activeUid = null;
      sharedRoomSubscriptions.delete(normalizedCode);
    }
  };
}

// Multiplexador de subscribeToPublicRooms (apenas 1 listener ativo enquanto o lobby estiver aberto)
const publicRoomsSubscribers = new Set<(rooms: MultiplayerRoomState[]) => void>();
let sharedPublicRoomsUnsubSnap: (() => void) | null = null;
let sharedPublicRoomsUnsubAuth: (() => void) | null = null;
let sharedPublicRoomsActiveUid: string | null = null;

export function subscribeToPublicRooms(cb: (rooms: MultiplayerRoomState[]) => void): () => void {
  publicRoomsSubscribers.add(cb);
  if (cachedPublicRooms.length > 0) {
    cb(cachedPublicRooms);
  }

  if (!sharedPublicRoomsUnsubAuth) {
    sharedPublicRoomsUnsubAuth = subscribeToAuthReady((user) => {
      const nextUid = user?.uid ?? null;
      if (nextUid === sharedPublicRoomsActiveUid && sharedPublicRoomsUnsubSnap) {
        return;
      }
      if (sharedPublicRoomsUnsubSnap) {
        sharedPublicRoomsUnsubSnap();
        sharedPublicRoomsUnsubSnap = null;
      }
      sharedPublicRoomsActiveUid = nextUid;
      if (!user || isInQuotaBackoff()) {
        publicRoomsSubscribers.forEach((sub) => sub(cachedPublicRooms));
        return;
      }

      const q = query(collection(db, 'rooms'), limit(15));
      sharedPublicRoomsUnsubSnap = onSnapshot(
        q,
        (snap) => {
          const list: MultiplayerRoomState[] = [];
          const nowMs = Date.now();
          snap.forEach((docSnap) => {
            const d = docSnap.data();
            if (d.status === 'finished') return;
            cachedRoomDocsByCode.set(docSnap.id, d);
            const room = mapDocToRoomState(d);
            // Oculta salas sem atividade recente (> 120s)
            if (room.lastActivityMs && nowMs - room.lastActivityMs > 120_000) return;
            list.push(room);
          });
          list.sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
          cachedPublicRooms = list;
          publicRoomsSubscribers.forEach((sub) => sub(list));
        },
        (err) => {
          logFirestoreWarn('Erro no listener subscribeToPublicRooms (rooms)', err);
        }
      );
    });
  }

  return () => {
    publicRoomsSubscribers.delete(cb);
    if (publicRoomsSubscribers.size === 0) {
      if (sharedPublicRoomsUnsubSnap) {
        sharedPublicRoomsUnsubSnap();
        sharedPublicRoomsUnsubSnap = null;
      }
      if (sharedPublicRoomsUnsubAuth) {
        sharedPublicRoomsUnsubAuth();
        sharedPublicRoomsUnsubAuth = null;
      }
      sharedPublicRoomsActiveUid = null;
    }
  };
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
  if (!isLegitimateFulltime || isInQuotaBackoff()) return;
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

    const userRef = doc(db, 'users', user.uid);
    const didWin = winner === myTeam;
    const didLose = winner !== 'draw' && winner !== myTeam;
    const didDraw = winner === 'draw';
    const myTeamGoals = myTeam === 'home' ? homeGoals : awayGoals;
    const opponentGoals = myTeam === 'home' ? awayGoals : homeGoals;

    if (cachedMyProfile && cachedMyProfile.uid === user.uid) {
      const nextWins = Math.floor((cachedMyProfile.wins || 0) + (didWin ? 1 : 0));
      const nextLosses = Math.floor((cachedMyProfile.losses || 0) + (didLose ? 1 : 0));
      const nextDraws = Math.floor((cachedMyProfile.draws || 0) + (didDraw ? 1 : 0));
      const nextGoalsScored = Math.floor((cachedMyProfile.goalsScored || 0) + myTeamGoals);
      const nextGoalsConceded = Math.floor((cachedMyProfile.goalsConceded || 0) + opponentGoals);
      const nextMatches = Math.floor((cachedMyProfile.matchesPlayed || 0) + 1);

      await setDoc(userRef, {
        uid: user.uid,
        displayName: String(cachedMyProfile.displayName || user.displayName || 'Jogador').slice(0, 28),
        tagCode:
          typeof cachedMyProfile.tagCode === 'string' && cachedMyProfile.tagCode.length >= 2
            ? cachedMyProfile.tagCode.slice(0, 20)
            : generateTagCode(user.uid),
        status: 'online',
        currentRoomCode: '',
        friends: Array.isArray(cachedMyProfile.friends)
          ? cachedMyProfile.friends.filter((f): f is string => typeof f === 'string').slice(0, 200)
          : [],
        wins: nextWins,
        losses: nextLosses,
        draws: nextDraws,
        goalsScored: nextGoalsScored,
        goalsConceded: nextGoalsConceded,
        matchesPlayed: nextMatches,
        createdAt: Timestamp.fromMillis(cachedMyProfile.createdAt || Date.now()),
        updatedAt: serverTimestamp(),
      });
      return;
    }

    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      const d = userSnap.data();
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
  } catch (err) {
    logFirestoreWarn('Aviso em recordMatchFinished', err);
  }
}

export function getCurrentAuthUser(): User | null {
  return auth.currentUser;
}

export { ALL_CHARACTERS, arrayRemove };
