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
import firebaseConfig from '../../firebase-applet-config.json';
import {
  AuthUserInfo,
  MatchFormatMode,
  MultiplayerMatchSnapshot,
  MultiplayerRoomState,
  MultiplayerSlot,
  OnlineUserProfile,
} from '../types/game';
import { ALL_CHARACTERS } from './botService';
import { CreateRoomParams } from './roomService';
import { bindFirebaseAuthToSupabase } from './supabaseClient';
import {
  clearGameBackendError,
  createSupabaseOnlineRoom,
  ensureSupabaseUserProfile,
  getGameBackendState,
  getSupabaseDiagnostics,
  joinSupabaseOnlineRoom,
  leaveSupabaseOnlineRoom,
  markSupabasePlayerMatchLoadingReady,
  promoteSupabaseRoomToPlaying,
  recordSupabaseMatchFinished,
  removeSupabaseFriend,
  respondToSupabaseFriendRequest,
  selectSupabaseRoomCharacter,
  sendSupabaseFriendRequestByTag,
  sendSupabaseRoomInvite,
  startSupabaseOnlineMatch,
  subscribeToGameBackendState,
  subscribeToSupabaseFriendsProfiles,
  subscribeToSupabaseIncomingRequests,
  subscribeToSupabaseOnlinePlayers,
  subscribeToSupabasePublicRooms,
  subscribeToSupabaseRoom,
  subscribeToSupabaseUserProfile,
  toggleSupabasePlayerReady,
  updateSupabaseUserPresence,
} from './supabaseDataService';

// Singleton initialization: prevents multiple Firebase App / Auth instances across hot reloads or re-imports
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
bindFirebaseAuthToSupabase(auth);

export {
  ALL_CHARACTERS,
  clearGameBackendError,
  getGameBackendState,
  getSupabaseDiagnostics,
  subscribeToGameBackendState,
};

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

export function registerQuotaExhausted(context: string, error: unknown): void {
  const nextAttempt = Math.min(6, quotaState.attempt + 1);
  const baseDelayMs = Math.min(300_000, 15_000 * Math.pow(2, nextAttempt - 1));
  const jitterMs = Math.floor(Math.random() * 5000);
  const backoffMs = baseDelayMs + jitterMs;
  const untilMs = Date.now() + backoffMs;

  quotaState = {
    isExhausted: true,
    backoffUntilMs: untilMs,
    attempt: nextAttempt,
    friendlyMessage:
      'O serviço em nuvem atingiu temporariamente o limite de requisições. Aguarde alguns instantes e tente novamente.',
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
  clearGameBackendError();
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

// ============================================================================
// Authentication, Google Provider Verification & Account Linking
// ============================================================================

let authReadyPromise: Promise<User> | null = null;
let authObserverRegistered = false;
let isInteractiveAuthInProgress = false;
let lastNotifiedReadyUid: string | null = null;
const profileSyncInFlight = new Map<string, Promise<void>>();
const syncedProfileUids = new Set<string>();
const authReadyListeners = new Set<(user: User | null) => void>();
const authStatusListeners = new Set<(info: AuthUserInfo) => void>();

// ============================================================================
// Local In-Memory Cache & Throttling State
// ============================================================================
let cachedMyProfile: (OnlineUserProfile & { friends: string[] }) | null = null;
let cachedPublicRooms: MultiplayerRoomState[] = [];
let cachedOnlinePlayers: OnlineUserProfile[] = [];
let cachedIncomingRequests: FriendRequestDoc[] = [];
const cachedFriendsByKey = new Map<string, OnlineUserProfile[]>();

let lastPresenceWrite: {
  uid: string;
  status: 'online' | 'in_room' | 'in_match' | 'offline';
  roomCode: string;
  timestampMs: number;
} | null = null;

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

function ensureSingleAuthObserverRegistered(): void {
  if (authObserverRegistered) return;
  authObserverRegistered = true;

  onAuthStateChanged(
    auth,
    async (user) => {
      if (user) {
        notifyAuthStatusListeners(user);
        try {
          await user.getIdToken();
        } catch (tokenErr) {
          logAuthWarn(`Falha ao validar token de sessão para UID ${user.uid}`, tokenErr);
        }
        try {
          await ensureUserProfile(user);
        } catch (profileErr) {
          logAuthWarn(`Falha ao sincronizar perfil Supabase para UID ${user.uid}`, profileErr);
        }
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
        if (typeof auth.authStateReady === 'function') {
          await auth.authStateReady();
        }

        let activeUser = auth.currentUser;

        if (!activeUser && !isInteractiveAuthInProgress) {
          logAuthInfo('Nenhuma sessão prévia restaurada; iniciando autenticação anônima.');
          try {
            const cred = await signInAnonymously(auth);
            activeUser = cred.user;
          } catch (anonErr) {
            const fbErr = anonErr as FirebaseError | undefined;
            if (fbErr?.code === 'auth/admin-restricted-operation') {
              logAuthWarn(
                'Login anônimo restrito no projeto Firebase (auth/admin-restricted-operation). Utilize "Entrar com Google".',
                anonErr
              );
              throw new Error(
                'Faça login com sua Conta Google no topo do Lobby para acessar o modo online.'
              );
            }
            throw anonErr;
          }
        }

        if (!activeUser) {
          throw new Error('Sessão de autenticação indisponível. Faça login com sua Conta Google.');
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
 * Vincula a conta anônima atual a uma Conta Google usando linkWithPopup para preservar UID
 * ou autentica diretamente com Google sincronizando o perfil no Supabase via rpc_ensure_user_profile_atomic.
 */
export async function linkGoogleAccount(): Promise<GoogleLinkResult> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const currentUser = auth.currentUser;

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
    if (currentUser && currentUser.isAnonymous) {
      const anonUid = currentUser.uid;
      const anonDisplayName = cachedMyProfile?.displayName;

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
            `Conta Google já existente detectada (${code}). Autenticando na conta Google existente e sincronizando perfil no Supabase.`
          );
          const credential = GoogleAuthProvider.credentialFromError(err as FirebaseError);
          const signInResult = credential
            ? await signInWithCredential(auth, credential)
            : await signInWithPopup(auth, provider);
          const googleUser = signInResult.user;

          await googleUser.getIdToken();
          const preferredName =
            anonDisplayName && !anonDisplayName.startsWith('Craque_')
              ? anonDisplayName
              : googleUser.displayName || undefined;
          await ensureUserProfile(googleUser, preferredName);
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

export function generateTagCode(uid: string): string {
  const suffix = uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
  return `#STF${suffix.padEnd(4, '9')}`;
}

/**
 * Sincroniza o perfil do usuário exclusivamente no Supabase PostgreSQL via `rpc_ensure_user_profile_atomic`.
 */
export async function ensureUserProfile(user: User, preferredNickname?: string): Promise<void> {
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
    const googleName = user.providerData?.find((p) => p.providerId === 'google.com')?.displayName;
    const defaultName =
      preferredNickname?.trim() ||
      user.displayName?.trim() ||
      googleName?.trim() ||
      `Craque_${user.uid.slice(0, 4).toUpperCase()}`;

    try {
      const sbProfile = await ensureSupabaseUserProfile({
        uid: user.uid,
        defaultDisplayName: defaultName,
        preferredNickname,
      });
      if (!sbProfile) {
        const lastErr = getGameBackendState().lastError;
        throw new Error(lastErr || 'Falha ao sincronizar perfil do jogador no Supabase.');
      }
      cachedMyProfile = sbProfile;
      syncedProfileUids.add(user.uid);
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
  status: 'online' | 'in_room' | 'in_match' | 'offline' | 'playing',
  roomCode: string = ''
): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;

  const cleanRoom = roomCode.trim().toUpperCase().slice(0, 16);
  const safeStatus: 'online' | 'in_room' | 'in_match' | 'offline' =
    status === 'playing' || status === 'in_match'
      ? 'in_match'
      : status === 'in_room'
      ? 'in_room'
      : status === 'offline'
      ? 'offline'
      : 'online';
  const nowMs = Date.now();

  if (
    lastPresenceWrite &&
    lastPresenceWrite.uid === user.uid &&
    lastPresenceWrite.status === safeStatus &&
    lastPresenceWrite.roomCode === cleanRoom &&
    nowMs - lastPresenceWrite.timestampMs < 30_000
  ) {
    return;
  }

  lastPresenceWrite = {
    uid: user.uid,
    status: safeStatus,
    roomCode: cleanRoom,
    timestampMs: nowMs,
  };

  if (cachedMyProfile && cachedMyProfile.uid === user.uid) {
    cachedMyProfile = {
      ...cachedMyProfile,
      status: safeStatus === 'offline' ? 'online' : safeStatus,
      currentRoomCode: cleanRoom,
      updatedAt: nowMs,
    };
  }

  await updateSupabaseUserPresence(user.uid, safeStatus, cleanRoom);
}

// Multiplexador de subscribeToMyProfile (exclusivamente via Supabase)
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

      if (!user) {
        cachedMyProfile = null;
        myProfileSubscribers.forEach((sub) => sub(null));
        return;
      }

      const fallbackName =
        user.displayName ||
        user.providerData?.find((p) => p.providerId === 'google.com')?.displayName ||
        `Craque_${user.uid.slice(0, 4).toUpperCase()}`;

      sharedMyProfileUnsubDoc = subscribeToSupabaseUserProfile(
        user.uid,
        (sbProf) => {
          cachedMyProfile = sbProf;
          if (sbProf) {
            syncedProfileUids.add(user.uid);
          }
          myProfileSubscribers.forEach((sub) => sub(cachedMyProfile));
        },
        fallbackName
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

// Multiplexador de subscribeToOnlinePlayers (exclusivamente via Supabase)
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

      if (!user) {
        onlinePlayersSubscribers.forEach((sub) => sub(cachedOnlinePlayers));
        return;
      }

      sharedOnlinePlayersUnsubSnap = subscribeToSupabaseOnlinePlayers((list) => {
        cachedOnlinePlayers = list;
        onlinePlayersSubscribers.forEach((sub) => sub(list));
      });
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
// Friends & Room Invitations (Supabase RPCs)
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

/**
 * Envia solicitação de amizade exclusivamente via `rpc_send_friend_request`.
 */
export async function sendFriendRequestByTag(
  targetTagOrName: string
): Promise<{ ok: boolean; message: string }> {
  const user = await ensureAuthenticated();
  const search = targetTagOrName.trim();
  if (!search) {
    return { ok: false, message: 'Digite o código #STF do amigo.' };
  }

  const meName = cachedMyProfile?.displayName || user.displayName || 'Jogador';
  const meTag = cachedMyProfile?.tagCode || generateTagCode(user.uid);

  return await sendSupabaseFriendRequestByTag(user.uid, meName, meTag, search);
}

/**
 * Envia convite de sala via canal Realtime do Supabase.
 */
export async function sendRoomInviteToFriend(
  friendUid: string,
  friendName: string,
  roomCode: string
): Promise<void> {
  const user = await ensureAuthenticated();
  const meName = cachedMyProfile?.displayName || user.displayName || 'Craque';
  const meTag = cachedMyProfile?.tagCode || generateTagCode(user.uid);

  const ok = await sendSupabaseRoomInvite(
    user.uid,
    String(meName),
    String(meTag),
    friendUid,
    friendName,
    roomCode
  );
  if (!ok) {
    throw new Error('Não foi possível enviar o convite da sala pelo Supabase Realtime.');
  }
}

/**
 * Aceita ou recusa solicitação de amizade exclusivamente via `rpc_respond_friend_request`.
 */
export async function respondToFriendRequest(
  request: FriendRequestDoc,
  accept: boolean
): Promise<void> {
  const user = await ensureAuthenticated();
  await respondToSupabaseFriendRequest(user.uid, request, accept);
}

/**
 * Remove um amigo exclusivamente via `rpc_remove_friend`.
 */
export async function removeFriendByTag(
  friendTag: string
): Promise<{ ok: boolean; message: string }> {
  await ensureAuthenticated();
  try {
    await removeSupabaseFriend(friendTag);
    return { ok: true, message: `Amigo (${friendTag}) removido da sua lista.` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Não foi possível remover o amigo.',
    };
  }
}

// Multiplexador de subscribeToIncomingRequests (`rpc_get_friend_requests` + Realtime)
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

      if (!user) {
        cachedIncomingRequests = [];
        incomingRequestsSubscribers.forEach((sub) => sub(cachedIncomingRequests));
        return;
      }

      sharedIncomingUnsubSnap = subscribeToSupabaseIncomingRequests(user.uid, (list) => {
        cachedIncomingRequests = list;
        incomingRequestsSubscribers.forEach((sub) => sub(list));
      });
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

/**
 * Inscreve na lista de amigos do usuário autenticado via `rpc_get_my_friends` + Supabase Realtime.
 */
export function subscribeToFriendsProfiles(
  friendUids: string[],
  cb: (friends: OnlineUserProfile[]) => void
): () => void {
  const cacheKey = (friendUids || []).filter(Boolean).sort().join(',') || '__my_friends__';
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
    if (!user) {
      cb([]);
      return;
    }

    unsubSnap = subscribeToSupabaseFriendsProfiles(friendUids, (list) => {
      cachedFriendsByKey.set(cacheKey, list);
      cb(list);
    });
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
// Multiplayer Rooms (Supabase RPCs + Realtime)
// ============================================================================

export function generateMatchId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MTC-';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Cria uma sala online exclusivamente via `rpc_create_room_atomic` no Supabase.
 * Não simula sucesso quando o banco retornar erro.
 */
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

  const sbRoom = await createSupabaseOnlineRoom({
    hostUid: user.uid,
    hostName,
    homeTeamId,
    awayTeamId,
    halfDurationSeconds,
    options,
  });

  void updateUserPresence('in_room', sbRoom.roomCode);
  return sbRoom;
}

/**
 * Entra em uma sala existente exclusivamente via `rpc_join_room_atomic` no Supabase.
 * Propaga erros reais do banco sem simular sucesso.
 */
export async function joinOnlineRoom(
  roomCodeInput: string,
  passwordInput?: string,
  expectedMode?: MatchFormatMode
): Promise<MultiplayerRoomState | null> {
  const user = await ensureAuthenticated();
  const roomCode = roomCodeInput.trim().toUpperCase();
  const myNameForJoin = (
    cachedMyProfile?.displayName ||
    user.displayName ||
    'Jogador'
  ).slice(0, 28);

  const sbJoined = await joinSupabaseOnlineRoom({
    roomCode,
    uid: user.uid,
    displayName: myNameForJoin,
    passwordInput,
    expectedMode,
  });

  void updateUserPresence('in_room', sbJoined.roomCode);
  return sbJoined;
}

/**
 * Seleciona personagem na sala exclusivamente via `rpc_select_character_atomic`.
 */
export async function selectRoomCharacter(
  roomCode: string,
  targetCharacterId: string
): Promise<{ ok: boolean; message?: string }> {
  const user = await ensureAuthenticated();
  const normalizedCode = roomCode.trim().toUpperCase();
  const myNameForSelect = (
    cachedMyProfile?.displayName ||
    user.displayName ||
    'Jogador'
  ).slice(0, 28);

  return await selectSupabaseRoomCharacter(
    normalizedCode,
    user.uid,
    myNameForSelect,
    targetCharacterId
  );
}

/**
 * Alterna prontidão do jogador na sala exclusivamente via `rpc_toggle_ready_atomic`.
 */
export async function togglePlayerReadyInRoom(roomCode: string, ready?: boolean): Promise<void> {
  const user = await ensureAuthenticated();
  const normalizedCode = roomCode.trim().toUpperCase();

  let targetReady = ready;
  if (targetReady === undefined) {
    const subEntry = sharedRoomSubscriptions.get(normalizedCode);
    const currentSlot = subEntry?.latestState?.slots
      ? Object.values(subEntry.latestState.slots).find((s) => s.uid === user.uid)
      : undefined;
    targetReady = currentSlot ? !currentSlot.isReady : true;
  }

  await toggleSupabasePlayerReady(normalizedCode, user.uid, targetReady);
}

export async function updatePlayerVoiceStatusInRoom(
  _roomCode: string,
  _micEnabled: boolean,
  _isSpeaking: boolean
): Promise<void> {
  // Sinalização de voz e estado de microfone trafegam via Supabase Realtime Broadcast (voiceChatService.ts)
}

export async function sendRoomHeartbeat(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const normalizedCode = roomCode.trim().toUpperCase();
  await updateUserPresence('in_room', normalizedCode);
}

/**
 * Remove o jogador da sala exclusivamente via `rpc_leave_room_atomic`.
 */
export async function leaveOnlineRoom(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const normalizedCode = roomCode.trim().toUpperCase();

  await leaveSupabaseOnlineRoom(normalizedCode, user.uid);
  void updateUserPresence('online', '');
}

export async function cleanupAbandonedRoomsAndSlots(_force: boolean = false): Promise<void> {
  // A limpeza de participantes e salas sem jogadores humanos é gerenciada atomicamente no PostgreSQL via rpc_leave_room_atomic
}

/**
 * Inicia a partida exclusivamente via `rpc_start_match_atomic`.
 */
export async function startOnlineMatch(roomCode: string): Promise<string> {
  const user = await ensureAuthenticated();
  const normalizedCode = roomCode.trim().toUpperCase();

  const { matchId } = await startSupabaseOnlineMatch(normalizedCode, user.uid);
  void updateUserPresence('in_match', normalizedCode);
  return matchId;
}

export async function markPlayerMatchLoadingReady(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const normalizedCode = roomCode.trim().toUpperCase();
  await markSupabasePlayerMatchLoadingReady(normalizedCode, user.uid);
}

export async function promoteRoomToPlaying(roomCode: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !roomCode) return;
  const normalizedCode = roomCode.trim().toUpperCase();
  await promoteSupabaseRoomToPlaying(normalizedCode, user.uid);
}

/**
 * A física em 30Hz/60FPS (posições, rotações, animações, velocidades e bola) trafega
 * exclusivamente pelo servidor WebSocket autoritativo (realtimeMatchClient / server.ts).
 * Nunca grava snapshots de física frame a frame no banco de dados.
 */
export async function publishHostMatchSnapshot(
  _roomCode: string,
  _snapshot: MultiplayerMatchSnapshot
): Promise<void> {
  // No-op: evita gravações de física frame a frame no banco
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
  // No-op: comandos de input trafegam pelo WebSocket de baixa latência
}

// Multiplexador de subscribeToRoom por roomCode (`rpc_get_room_lobby` + Supabase Realtime)
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
      if (!user) {
        return;
      }

      currentEntry.unsubSnap = subscribeToSupabaseRoom(normalizedCode, (mapped) => {
        currentEntry.latestState = mapped;
        currentEntry.subscribers.forEach((sub) => sub(mapped));
      });
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

// Multiplexador de subscribeToPublicRooms (`rpc_get_public_lobby` + Supabase Realtime)
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
      if (!user) {
        publicRoomsSubscribers.forEach((sub) => sub(cachedPublicRooms));
        return;
      }

      sharedPublicRoomsUnsubSnap = subscribeToSupabasePublicRooms((list) => {
        cachedPublicRooms = list;
        publicRoomsSubscribers.forEach((sub) => sub(list));
      });
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
 * Registra partidas concluídas nas tabelas `matches` e `match_history` do Supabase.
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

  await recordSupabaseMatchFinished({
    uid: user.uid,
    roomCode,
    homeTeamName,
    awayTeamName,
    homeGoals,
    awayGoals,
    participantUids,
    myTeam,
  });
}

export function getCurrentAuthUser(): User | null {
  return auth.currentUser;
}
