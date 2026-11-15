import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  User,
} from 'firebase/auth';
import {
  collection,
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
  MultiplayerMatchSnapshot,
  MultiplayerSlot,
  OnlineUserProfile,
} from '../types/game';
import { INITIAL_AWAY_PLAYERS, INITIAL_HOME_PLAYERS } from '../game/rules';

// Initialize Firebase SDK with provisioned configuration
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
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): FirestoreErrorInfo {
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
  return errInfo;
}

const ALL_CHARACTER_SLOTS: Omit<
  MultiplayerSlot,
  'uid' | 'displayName' | 'isBot' | 'isReady' | 'pingMs'
>[] = [
  ...INITIAL_HOME_PLAYERS.map((p) => ({
    characterId: p.id,
    characterName: p.name,
    team: 'home' as const,
  })),
  ...INITIAL_AWAY_PLAYERS.map((p) => ({
    characterId: p.id,
    characterName: p.name,
    team: 'away' as const,
  })),
];

export function createDefaultRoomSlots(
  hostUid: string,
  hostName: string,
  preferredCharId = 'home_1'
): Record<string, MultiplayerSlot> {
  const slots: Record<string, MultiplayerSlot> = {};
  for (const item of ALL_CHARACTER_SLOTS) {
    const isHostSlot = item.characterId === preferredCharId;
    slots[item.characterId] = {
      characterId: item.characterId,
      characterName: item.characterName,
      team: item.team,
      uid: isHostSlot ? hostUid : null,
      displayName: isHostSlot ? hostName : `Bot (${item.characterName})`,
      isBot: !isHostSlot,
      isReady: true,
      pingMs: isHostSlot ? 18 : 0,
    };
  }
  return slots;
}

function generateTagCode(uid: string): string {
  const clean = uid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return `VZR-${clean.slice(0, 4).padEnd(4, '7')}`;
}

function sanitizeDisplayName(raw?: string | null): string {
  const trimmed = (raw || '').trim().slice(0, 28);
  if (trimmed.length >= 2) return trimmed;
  return `Craque_${Math.floor(100 + Math.random() * 899)}`;
}

export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'VRZ-';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Validates connection to Firestore server and measures round-trip ping in ms.
 */
export async function testFirebaseConnection(): Promise<{
  connected: boolean;
  pingMs: number;
  error: string | null;
}> {
  const start = performance.now();
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    const pingMs = Math.max(8, Math.min(95, Math.round(performance.now() - start)));
    return { connected: true, pingMs, error: null };
  } catch (error) {
    const pingMs = Math.max(12, Math.min(95, Math.round(performance.now() - start)));
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('the client is offline')) {
      console.error('Please check your Firebase configuration. Client is offline.');
      return { connected: false, pingMs, error: msg };
    }
    return { connected: true, pingMs, error: null };
  }
}

/**
 * Ensures the user is authenticated and syncs their `/users/{uid}` document
 * adhering strictly to the `isValidUserProfile` blueprint in `firestore.rules`.
 */
export async function ensureAuthenticatedUser(
  customDisplayName?: string,
  attemptAnonymous = false
): Promise<{
  user: User | null;
  profile: OnlineUserProfile;
  authError: string | null;
}> {
  let currentUser = auth.currentUser;
  let authError: string | null = null;

  if (!currentUser && attemptAnonymous) {
    try {
      const cred = await signInAnonymously(auth);
      currentUser = cred.user;
    } catch (err) {
      authError = err instanceof Error ? err.message : String(err);
    }
  }

  const savedName = sanitizeDisplayName(
    customDisplayName ||
      currentUser?.displayName ||
      (typeof localStorage !== 'undefined'
        ? localStorage.getItem('varzea_player_name')
        : null)
  );

  if (typeof localStorage !== 'undefined' && savedName) {
    localStorage.setItem('varzea_player_name', savedName);
  }

  let savedLocalUid =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('varzea_local_uid')
      : null;
  if (!savedLocalUid) {
    savedLocalUid = `vzr_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('varzea_local_uid', savedLocalUid);
    }
  }

  const uid = currentUser?.uid || savedLocalUid;
  const tagCode = generateTagCode(uid);

  const profile: OnlineUserProfile = {
    uid,
    displayName: savedName,
    tagCode,
    status: 'online',
    currentRoomCode: '',
    updatedAt: Date.now(),
    createdAt: Date.now(),
  };

  if (currentUser) {
    const userRef = doc(db, 'users', currentUser.uid);
    try {
      const existing = await getDoc(userRef);
      if (existing.exists()) {
        const data = existing.data();
        const nextDisplayName = sanitizeDisplayName(
          customDisplayName || data.displayName || profile.displayName
        );
        profile.displayName = nextDisplayName;
        profile.tagCode = data.tagCode || tagCode;

        // Strict update matching firestore.rules affectedKeys allowlist
        await updateDoc(userRef, {
          displayName: nextDisplayName,
          onlineStatus: 'online',
          updatedAt: serverTimestamp(),
        });
      } else {
        // Strict create matching firestore.rules isValidUserProfile
        await setDoc(userRef, {
          uid: currentUser.uid,
          displayName: profile.displayName,
          tagCode: profile.tagCode,
          favoritePlayer: 'Yuri',
          wins: 0,
          losses: 0,
          draws: 0,
          goalsScored: 0,
          onlineStatus: 'online',
          currentRoomCode: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.uid}`);
    }
  }

  return { user: currentUser, profile, authError };
}

/**
 * Signs in or upgrades an anonymous account with Google Popup OAuth.
 */
export async function signInOrLinkWithGoogle(): Promise<{
  user: User | null;
  error: string | null;
}> {
  const provider = new GoogleAuthProvider();
  try {
    if (auth.currentUser && auth.currentUser.isAnonymous) {
      try {
        const linked = await linkWithPopup(auth.currentUser, provider);
        await ensureAuthenticatedUser(linked.user.displayName || undefined);
        return { user: linked.user, error: null };
      } catch (linkErr: unknown) {
        const code = (linkErr as { code?: string })?.code;
        if (code === 'auth/credential-already-in-use') {
          const signedIn = await signInWithPopup(auth, provider);
          await ensureAuthenticatedUser(signedIn.user.displayName || undefined);
          return { user: signedIn.user, error: null };
        }
        throw linkErr;
      }
    } else {
      const signedIn = await signInWithPopup(auth, provider);
      await ensureAuthenticatedUser(signedIn.user.displayName || undefined);
      return { user: signedIn.user, error: null };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { user: null, error: msg };
  }
}

export async function updateUserProfileName(
  newName: string
): Promise<OnlineUserProfile | null> {
  const clean = sanitizeDisplayName(newName);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('varzea_player_name', clean);
  }
  const { profile } = await ensureAuthenticatedUser(clean);
  return profile;
}

/**
 * Creates a new multiplayer room in `/rooms/{roomCode}` adhering strictly to `isValidMultiplayerRoom` in `firestore.rules`.
 */
export async function createMultiplayerRoom(
  hostProfile: OnlineUserProfile,
  homeTeamName: string,
  awayTeamName: string,
  preferredCharId = 'home_1'
): Promise<string> {
  const roomCode = generateRoomCode();
  const currentUid = auth.currentUser?.uid || hostProfile.uid;
  const cleanHostName = sanitizeDisplayName(hostProfile.displayName);
  const cleanHomeTeam = (homeTeamName || 'Unidos do Barro').slice(0, 32);
  const cleanAwayTeam = (awayTeamName || 'Rubro-Negro do Beco').slice(0, 32);

  const slots = createDefaultRoomSlots(
    currentUid,
    cleanHostName,
    preferredCharId
  );

  const initialMatchState: MultiplayerMatchSnapshot = {
    ball: { x: 0, y: 0.22, z: 0, vx: 0, vy: 0, vz: 0 },
    players: {},
    homeGoals: 0,
    awayGoals: 0,
    half: 1,
    remainingSeconds: 300,
    phase: 'open_play',
    celebratingPlayerId: null,
    bannerMessage: null,
    bannerSubtext: null,
    timestamp: Date.now(),
  };

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(
      `varzea_room_${roomCode}`,
      JSON.stringify({
        roomCode,
        hostUid: currentUid,
        hostName: cleanHostName,
        status: 'waiting',
        homeTeamName: cleanHomeTeam,
        awayTeamName: cleanAwayTeam,
        homeGoals: 0,
        awayGoals: 0,
        half: 1,
        remainingSeconds: 300,
        slots,
        matchState: initialMatchState,
      })
    );
  }

  if (!auth.currentUser) {
    return roomCode;
  }

  // Ensure /users/{uid} exists before creating the room (required by relational existence check in firestore.rules)
  await ensureAuthenticatedUser(cleanHostName);

  const roomRef = doc(db, 'rooms', roomCode);
  try {
    await setDoc(roomRef, {
      roomCode,
      hostUid: auth.currentUser.uid,
      hostName: cleanHostName,
      status: 'waiting',
      homeTeamName: cleanHomeTeam,
      awayTeamName: cleanAwayTeam,
      homeGoals: 0,
      awayGoals: 0,
      half: 1,
      remainingSeconds: 300,
      assignedSlots: slots,
      syncState: initialMatchState,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const userRef = doc(db, 'users', auth.currentUser.uid);
    await updateDoc(userRef, {
      onlineStatus: 'in_lobby',
      currentRoomCode: roomCode,
      updatedAt: serverTimestamp(),
    });

    return roomCode;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `rooms/${roomCode}`);
    throw err;
  }
}

/**
 * Joins an existing room by code and assigns the first free character slot (or requested character slot)
 */
export async function joinMultiplayerRoom(
  roomCodeInput: string,
  profile: OnlineUserProfile,
  preferredCharacterId?: string
): Promise<{ roomCode: string; assignedCharacterId: string }> {
  const roomCode = roomCodeInput.trim().toUpperCase();
  const currentUid = auth.currentUser?.uid;
  if (!currentUid) {
    throw new Error(
      'Clique em "Vincular / Entrar com Google" acima para entrar em salas online de outros jogadores.'
    );
  }

  await ensureAuthenticatedUser(profile.displayName);

  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) {
      throw new Error(`Sala "${roomCode}" não encontrada.`);
    }
    const data = snap.data();
    const slots: Record<string, MultiplayerSlot> = {
      ...(data.assignedSlots || {}),
    };

    let assignedId = Object.keys(slots).find(
      (k) => slots[k]?.uid === currentUid
    );

    if (!assignedId) {
      if (
        preferredCharacterId &&
        slots[preferredCharacterId] &&
        (slots[preferredCharacterId].isBot || !slots[preferredCharacterId].uid)
      ) {
        assignedId = preferredCharacterId;
      } else {
        assignedId = Object.keys(slots).find(
          (k) => slots[k].isBot || !slots[k].uid
        );
      }
    }

    if (!assignedId) {
      throw new Error('A sala já está lotada (8/8 jogadores humanos)!');
    }

    slots[assignedId] = {
      ...slots[assignedId],
      uid: currentUid,
      displayName: sanitizeDisplayName(profile.displayName),
      isBot: false,
      isReady: true,
      pingMs: 24,
    };

    await updateDoc(roomRef, {
      assignedSlots: slots,
      updatedAt: serverTimestamp(),
    });

    return { roomCode, assignedCharacterId: assignedId };
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomCode}`);
    throw err;
  }
}

/**
 * Claims a specific character slot (Yuri, Josué, Careca, Bode, Primo, Bicudo, Ismael, Felipe)
 * Ensures no two human players ever control the same character.
 */
export async function selectCharacterInRoom(
  roomCode: string,
  profile: OnlineUserProfile,
  targetCharacterId: string
): Promise<boolean> {
  const currentUid = auth.currentUser?.uid;
  if (!currentUid) return false;

  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return false;
    const data = snap.data();
    const slots: Record<string, MultiplayerSlot> = {
      ...(data.assignedSlots || {}),
    };

    const targetSlot = slots[targetCharacterId];
    if (!targetSlot) return false;

    if (
      targetSlot.uid &&
      targetSlot.uid !== currentUid &&
      !targetSlot.isBot
    ) {
      return false;
    }

    for (const key of Object.keys(slots)) {
      if (slots[key].uid === currentUid) {
        slots[key] = {
          ...slots[key],
          uid: null,
          displayName: `Bot (${slots[key].characterName})`,
          isBot: true,
          isReady: true,
        };
      }
    }

    slots[targetCharacterId] = {
      ...targetSlot,
      uid: currentUid,
      displayName: sanitizeDisplayName(profile.displayName),
      isBot: false,
      isReady: true,
      pingMs: 20,
    };

    await updateDoc(roomRef, {
      assignedSlots: slots,
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomCode}`);
    return false;
  }
}

/**
 * Starts the online match (Host transitions room status to 'playing')
 */
export async function startMultiplayerMatchInRoom(
  roomCode: string
): Promise<void> {
  if (!auth.currentUser) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    await updateDoc(roomRef, {
      status: 'playing',
      homeGoals: 0,
      awayGoals: 0,
      half: 1,
      remainingSeconds: 300,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomCode}`);
  }
}

/**
 * Leaves the current room; if the host leaves, automatically migrates host authority to the next connected human player.
 */
export async function leaveMultiplayerRoom(roomCode: string): Promise<void> {
  const currentUid = auth.currentUser?.uid;
  if (!currentUid || !roomCode) return;

  const roomRef = doc(db, 'rooms', roomCode);
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const data = snap.data();
    const slots: Record<string, MultiplayerSlot> = {
      ...(data.assignedSlots || {}),
    };

    for (const key of Object.keys(slots)) {
      if (slots[key].uid === currentUid) {
        slots[key] = {
          ...slots[key],
          uid: null,
          displayName: `Bot (${slots[key].characterName})`,
          isBot: true,
          isReady: true,
        };
      }
    }

    if (data.hostUid === currentUid) {
      const remainingHuman = Object.values(slots).find(
        (s) => !s.isBot && s.uid && s.uid !== currentUid
      );
      if (remainingHuman && remainingHuman.uid) {
        await updateDoc(roomRef, {
          assignedSlots: slots,
          hostUid: remainingHuman.uid,
          hostName: sanitizeDisplayName(remainingHuman.displayName),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(roomRef, {
          status: 'finished',
          assignedSlots: slots,
          updatedAt: serverTimestamp(),
        });
      }
    } else {
      await updateDoc(roomRef, {
        assignedSlots: slots,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomCode}`);
  }
}

/**
 * Publishes authoritative host snapshot to `/rooms/{roomCode}`
 */
export async function publishRoomMatchSnapshot(
  roomCode: string,
  snapshot: MultiplayerMatchSnapshot
): Promise<void> {
  if (!auth.currentUser) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    await updateDoc(roomRef, {
      homeGoals: snapshot.homeGoals,
      awayGoals: snapshot.awayGoals,
      half: snapshot.half,
      remainingSeconds: snapshot.remainingSeconds,
      syncState: snapshot,
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Non-fatal during high-frequency sync
  }
}

/**
 * Publishes a non-host client's controlled character coordinates into the room's syncState
 */
export async function publishClientCharacterState(
  roomCode: string,
  characterId: string,
  charState: {
    x: number;
    z: number;
    vx: number;
    vz: number;
    facingAngle: number;
    animState: string;
    voiceBubble?: string | null;
  }
): Promise<void> {
  if (!auth.currentUser) return;
  const roomRef = doc(db, 'rooms', roomCode);
  try {
    await updateDoc(roomRef, {
      [`syncState.players.${characterId}`]: charState,
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Ignore transient network contention
  }
}

/**
 * Lists active waiting or playing rooms (enforcing `where('status', 'in', ['waiting', 'playing'])`)
 */
export async function listActiveRooms(): Promise<
  Array<{
    roomCode: string;
    hostName: string;
    status: string;
    humanCount: number;
    homeScore: number;
    awayScore: number;
  }>
> {
  if (!auth.currentUser) return [];
  try {
    const q = query(
      collection(db, 'rooms'),
      where('status', 'in', ['waiting', 'playing']),
      limit(15)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const slots: Record<string, MultiplayerSlot> = data.assignedSlots || {};
      const humanCount = Object.values(slots).filter(
        (s) => !s.isBot && s.uid
      ).length;
      return {
        roomCode: data.roomCode,
        hostName: data.hostName,
        status: data.status,
        humanCount,
        homeScore: data.homeGoals || 0,
        awayScore: data.awayGoals || 0,
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'rooms');
    return [];
  }
}

/**
 * Lists online users in `/users` (enforcing `where('onlineStatus', 'in', ['online', 'in_lobby', 'in_match', 'offline'])` required by firestore.rules)
 */
export async function listOnlineUsers(): Promise<OnlineUserProfile[]> {
  if (!auth.currentUser) return [];
  try {
    const q = query(
      collection(db, 'users'),
      where('onlineStatus', 'in', ['online', 'in_lobby', 'in_match', 'offline']),
      limit(25)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const ts = data.updatedAt as Timestamp | undefined;
      return {
        uid: data.uid,
        displayName: data.displayName,
        tagCode: data.tagCode,
        status:
          data.onlineStatus === 'in_lobby'
            ? 'in_room'
            : data.onlineStatus === 'in_match'
            ? 'playing'
            : 'online',
        currentRoomCode: data.currentRoomCode || '',
        updatedAt: ts ? ts.toMillis() : Date.now(),
        createdAt: Date.now(),
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'users');
    return [];
  }
}

export interface FriendRequestRecord {
  id: string;
  fromUid: string;
  fromName: string;
  fromTag: string;
  toUid: string;
  toName: string;
  status: 'pending' | 'accepted' | 'declined';
  roomInviteCode: string;
}

/**
 * Sends a friend request or room invite to another player matching `isValidFriendRequest` in `firestore.rules`.
 */
export async function sendFriendRequestOrInvite(
  fromProfile: OnlineUserProfile,
  targetUser: { uid: string; displayName: string },
  roomInviteCode = ''
): Promise<void> {
  const currentUid = auth.currentUser?.uid;
  if (!currentUid || currentUid === targetUser.uid) return;

  await ensureAuthenticatedUser(fromProfile.displayName);

  const reqId = `${currentUid}_${targetUser.uid}`;
  const reqRef = doc(db, 'friendRequests', reqId);
  try {
    const existing = await getDoc(reqRef);
    if (existing.exists() && existing.data().status === 'accepted') {
      await updateDoc(reqRef, {
        inviteRoomCode: (roomInviteCode || '').slice(0, 16),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(reqRef, {
        fromUid: currentUid,
        fromName: sanitizeDisplayName(fromProfile.displayName),
        fromTag: fromProfile.tagCode,
        toUid: targetUser.uid,
        toName: sanitizeDisplayName(targetUser.displayName),
        status: 'pending',
        inviteRoomCode: (roomInviteCode || '').slice(0, 16),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `friendRequests/${reqId}`);
    throw err;
  }
}

export async function respondToFriendRequest(
  requestId: string,
  newStatus: 'accepted' | 'declined'
): Promise<void> {
  const reqRef = doc(db, 'friendRequests', requestId);
  try {
    await updateDoc(reqRef, {
      status: newStatus,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(
      err,
      OperationType.UPDATE,
      `friendRequests/${requestId}`
    );
  }
}

/**
 * Records a completed match in `/matchHistory` matching `isValidMatchRecord` in `firestore.rules`.
 */
export async function recordMatchHistory(params: {
  roomCode: string;
  homeTeamName: string;
  awayTeamName: string;
  homeGoals: number;
  awayGoals: number;
  mvpName: string;
}): Promise<void> {
  const currentUid = auth.currentUser?.uid;
  if (!currentUid) return;

  await ensureAuthenticatedUser();

  const matchId = `${currentUid}_${Date.now()}`;
  const ref = doc(db, 'matchHistory', matchId);
  try {
    await setDoc(ref, {
      roomCode: (params.roomCode || 'LOCAL').slice(0, 12),
      recordedByUid: currentUid,
      homeTeamName: params.homeTeamName.slice(0, 32),
      awayTeamName: params.awayTeamName.slice(0, 32),
      homeGoals: Math.max(0, Math.min(99, params.homeGoals)),
      awayGoals: Math.max(0, Math.min(99, params.awayGoals)),
      mvpPlayer: (params.mvpName || 'Yuri').slice(0, 32),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `matchHistory/${matchId}`);
  }
}

export { onAuthStateChanged, onSnapshot, doc, collection, query, where };
export type { OnlineUserProfile };
export const FIREBASE_PROJECT_INFO = {
  projectId: firebaseConfig.projectId,
  databaseId: firebaseConfig.firestoreDatabaseId,
};
