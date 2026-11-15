/**
 * Procedural Web Audio API Sound Engine for Várzea Raiz 4x4.
 * Zero external audio dependencies — synthesizes authentic dirt footsteps,
 * puddle splashes, ball kicks, goalpost clangs, net rustles, referee whistles,
 * crowd/player celebrations, and optional menu percussion.
 */
class VarzeaAudioEngine {
  private ctx: AudioContext | null = null;
  public soundEnabled = true;
  public musicEnabled = false;
  private musicInterval: number | null = null;
  private musicStep = 0;

  private ensureContext(): AudioContext | null {
    if (!this.soundEnabled && !this.musicEnabled) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public setSoundEnabled(enabled: boolean) {
    this.soundEnabled = enabled;
  }

  public setMusicEnabled(enabled: boolean) {
    this.musicEnabled = enabled;
    if (enabled) {
      this.startMenuBatucada();
    } else {
      this.stopMenuBatucada();
    }
  }

  /**
   * Kick sound: deep leather thud + dirt burst
   */
  public playKick(power = 0.7) {
    if (!this.soundEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const startFreq = 115 + power * 45 + (Math.random() - 0.5) * 14;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.14);

    gain.gain.setValueAtTime(Math.min(0.55, 0.25 + power * 0.3), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.16);

    // Add brief sand/dirt grit noise on strong kicks
    if (power > 0.55) {
      this.playNoiseBurst(0.09, 950, 0.16 * power);
    }
  }

  /**
   * Footstep on dry sand/dirt or wet mud/puddle
   */
  public playFootstep(inPuddle = false, inMud = false) {
    if (!this.soundEnabled) return;
    if (inPuddle) {
      this.playNoiseBurst(0.075, 1650 + (Math.random() - 0.5) * 280, 0.11);
    } else if (inMud) {
      this.playNoiseBurst(0.065, 620 + (Math.random() - 0.5) * 110, 0.09);
    } else {
      this.playNoiseBurst(0.045, 980 + (Math.random() - 0.5) * 160, 0.065);
    }
  }

  /**
   * Slide tackle ("carrinho") on dirt/mud
   */
  public playSlideTackle(inPuddle = false) {
    if (!this.soundEnabled) return;
    const freq = inPuddle ? 1400 : 750;
    this.playNoiseBurst(0.26, freq, 0.24);
  }

  /**
   * Ball hitting wooden/iron goalpost ("bola na trave")
   */
  public playGoalpostHit() {
    if (!this.soundEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.exponentialRampToValueAtTime(195, now + 0.24);

    gain.gain.setValueAtTime(0.32, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.27);
  }

  /**
   * Ball rustling in goal net
   */
  public playNetRustle() {
    if (!this.soundEnabled) return;
    this.playNoiseBurst(0.22, 1200, 0.18);
  }

  /**
   * Referee whistle ("apito do árbitro")
   * @param mode 'short' (restart/throw-in), 'goal' (long trill), 'fulltime' (double whistle)
   */
  public playWhistle(mode: 'short' | 'goal' | 'fulltime' = 'short') {
    if (!this.soundEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const triggerTone = (offset: number, duration: number) => {
      const now = ctx.currentTime + offset;
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(2820, now);

      // Pea-whistle trill modulation
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(42, now);
      lfoGain.gain.setValueAtTime(95, now);

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.22, now + 0.03);
      gain.gain.setValueAtTime(0.2, now + Math.max(0.04, duration - 0.05));
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      lfo.start(now);
      osc.stop(now + duration + 0.02);
      lfo.stop(now + duration + 0.02);
    };

    if (mode === 'short') {
      triggerTone(0, 0.28);
    } else if (mode === 'goal') {
      triggerTone(0, 0.65);
    } else {
      triggerTone(0, 0.25);
      triggerTone(0.34, 0.55);
    }
  }

  /**
   * Goal celebration fanfare + várzea shout/cheer
   */
  public playGoalCelebration() {
    if (!this.soundEnabled) return;
    this.playWhistle('goal');
    this.playNetRustle();

    const ctx = this.ensureContext();
    if (!ctx) return;

    const notes = [261.63, 329.63, 392.0, 523.25];
    notes.forEach((freq, idx) => {
      const now = ctx.currentTime + 0.1 + idx * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.46);
    });

    // Crowd cheer burst
    this.playNoiseBurst(0.8, 850, 0.14);
  }

  private playNoiseBurst(duration: number, centerFreq: number, volume: number) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const sampleCount = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / sampleCount);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = centerFreq;
    filter.Q.value = 1.4;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  }

  public startMenuBatucada() {
    this.stopMenuBatucada();
    if (!this.musicEnabled) return;

    this.musicInterval = window.setInterval(() => {
      if (!this.musicEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;

      const step = this.musicStep % 8;
      this.musicStep++;

      // Surdo beat on 0 and 4
      if (step === 0 || step === 4) {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(step === 0 ? 75 : 92, now);
        osc.frequency.exponentialRampToValueAtTime(42, now + 0.18);
        gain.gain.setValueAtTime(0.14, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.21);
      }

      // Shake/ganzá on offbeats
      if (step % 2 === 1) {
        this.playNoiseBurst(0.04, 3200, 0.035);
      }
    }, 220);
  }

  public stopMenuBatucada() {
    if (this.musicInterval !== null) {
      clearInterval(this.musicInterval);
      this.musicInterval = null;
    }
  }
}

export const audioEngine = new VarzeaAudioEngine();
