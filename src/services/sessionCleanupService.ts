import { cleanupAbandonedRoomsAndSlots } from './firebase';

/**
 * Serviço de limpeza automática de sessões abandonadas e salas fantasmas.
 * Remove jogadores inativos (convertendo-os em bots), transfere a liderança
 * caso o criador tenha caído e encerra/remove salas sem jogadores humanos.
 */
class SessionCleanupManager {
  private sweepInterval: number | null = null;

  public startPeriodicCleanup() {
    if (this.sweepInterval !== null || typeof window === 'undefined') return;

    cleanupAbandonedRoomsAndSlots().catch(() => {});

    this.sweepInterval = window.setInterval(() => {
      cleanupAbandonedRoomsAndSlots().catch(() => {});
    }, 20000);
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
