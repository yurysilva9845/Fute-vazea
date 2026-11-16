import { leaveOnlineRoom, sendRoomHeartbeat, updateUserPresence } from './firebase';

/**
 * Gerencia presença em tempo real, heartbeats de sala e desconexão automática
 * ao fechar aba, navegador ou perder conexão com a internet.
 */
class PresenceManager {
  private activeRoomCode: string | null = null;
  private heartbeatTimer: number | null = null;
  private listenersBound = false;

  public startRoomPresence(roomCode: string, status: 'in_room' | 'playing' = 'in_room') {
    this.activeRoomCode = roomCode.trim().toUpperCase();
    this.bindUnloadListeners();

    updateUserPresence(status, this.activeRoomCode).catch(() => {});
    sendRoomHeartbeat(this.activeRoomCode).catch(() => {});

    if (this.heartbeatTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.heartbeatTimer);
    }

    if (typeof window !== 'undefined') {
      this.heartbeatTimer = window.setInterval(() => {
        if (!this.activeRoomCode) return;
        sendRoomHeartbeat(this.activeRoomCode).catch(() => {});
      }, 8000);
    }
  }

  public stopRoomPresence() {
    this.activeRoomCode = null;
    if (this.heartbeatTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    updateUserPresence('online', '').catch(() => {});
  }

  private bindUnloadListeners() {
    if (this.listenersBound || typeof window === 'undefined') return;
    this.listenersBound = true;

    const handleDisconnect = () => {
      const code = this.activeRoomCode;
      if (code) {
        this.activeRoomCode = null;
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
