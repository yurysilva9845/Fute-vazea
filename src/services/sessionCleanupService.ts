import { cleanupAbandonedRoomsAndSlots } from './firebase';

/**
 * Serviço de limpeza automática de sessões abandonadas e salas fantasmas.
 * Otimizado para evitar consumo excessivo de leituras do Firestore (executa no máximo a cada 5 minutos).
 */
class SessionCleanupManager {
  private sweepInterval: number | null = null;

  public startPeriodicCleanup() {
    if (this.sweepInterval !== null || typeof window === 'undefined') return;

    this.sweepInterval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      cleanupAbandonedRoomsAndSlots().catch(() => {});
    }, 300_000);
  }

  public stopPeriodicCleanup() {
    if (this.sweepInterval !== null && typeof window !== 'undefined') {
      window.clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  public async forceCleanupNow() {
    await cleanupAbandonedRoomsAndSlots();
  }
}

export const sessionCleanupService = new SessionCleanupManager();

