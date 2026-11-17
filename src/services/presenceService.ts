import { leaveOnlineRoom, sendRoomHeartbeat, updateUserPresence } from './firebase';

/**
 * Gerencia presença em tempo real, heartbeats de sala e desconexão automática
 * ao fechar aba, navegador ou perder conexão com a internet.
 * Inclui proteção contra loops de onSnapshot (deduplicação de startRoomPresence).
 */
class PresenceManager {
  private activeRoomCode: string | null = null;
  private activeStatus: 'in_room' | 'in_match' | null = null;
  private heartbeatTimer: number | null = null;
  private listenersBound = false;

  public startRoomPresence(
    roomCode: string,
    rawStatus: 'in_room' | 'in_match' | 'playing' = 'in_room'
  ) {
    const normalized = roomCode.trim().toUpperCase();
    if (!normalized) return;

    const status: 'in_room' | 'in_match' =
      rawStatus === 'playing' || rawStatus === 'in_match' ? 'in_match' : 'in_room';

    this.bindUnloadListeners();

    // Evita loop infinito: se já estamos monitorando a mesma sala com o mesmo status, não reescreve no banco!
    if (
      this.activeRoomCode === normalized &&
      this.activeStatus === status &&
      this.heartbeatTimer !== null
    ) {
      return;
    }

    const roomChanged = this.activeRoomCode !== normalized;
    const statusChanged = this.activeStatus !== status;

    this.activeRoomCode = normalized;
    this.activeStatus = status;

    if (roomChanged || statusChanged) {
      updateUserPresence(status, this.activeRoomCode).catch(() => {});
    }

    if (roomChanged && status === 'in_room') {
      sendRoomHeartbeat(this.activeRoomCode).catch(() => {});
    }

    if (this.heartbeatTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (typeof window !== 'undefined') {
      this.heartbeatTimer = window.setInterval(() => {
        if (!this.activeRoomCode || this.activeStatus !== 'in_room') return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        sendRoomHeartbeat(this.activeRoomCode).catch(() => {});
      }, 45000);
    }
  }

  public stopRoomPresence() {
    const hadRoom = this.activeRoomCode !== null || this.activeStatus !== null;
    this.activeRoomCode = null;
    this.activeStatus = null;
    if (this.heartbeatTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (hadRoom) {
      updateUserPresence('online', '').catch(() => {});
    }
  }

  private bindUnloadListeners() {
    if (this.listenersBound || typeof window === 'undefined') return;
    this.listenersBound = true;

    const handleDisconnect = () => {
      const code = this.activeRoomCode;
      if (code) {
        this.activeRoomCode = null;
        this.activeStatus = null;
        leaveOnlineRoom(code).catch(() => {});
      }
      updateUserPresence('offline', '').catch(() => {});
    };

    window.addEventListener('pagehide', handleDisconnect);
    window.addEventListener('beforeunload', handleDisconnect);
    window.addEventListener('offline', handleDisconnect);
  }
}

export const presenceService = new PresenceManager();

