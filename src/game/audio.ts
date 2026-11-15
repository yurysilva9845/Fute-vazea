/**
 * Procedural Web Audio API & Speech Engine for Várzea Raiz 4x4.
 * Supports 4 independent volume channels:
 * - Efeitos Sonoros (sfxVolume): chute, passe, bola quicando na terra, trave, rede, passos na areia, carrinho na lama, colisão, apito, comemoração
 * - Vozes dos Jogadores (voiceVolume): "Toca a bola!", "Aqui!", "Vai, vai!", "Boa!", "Que golaço!", "Marca ele!", "Chuta!", "Foi gol!"
 * - Ambiente da Várzea (ambientVolume): som de fundo do campinho, murmúrio da torcida e reação da comunidade
 * - Música (musicVolume): batucada de samba/várzea no menu
 * Plus optional mobile haptic vibration via Vibration API.
 */
class VarzeaAudioEngine {
  private ctx: AudioContext | null = null;
  public soundEnabled = true;
  public musicEnabled = false;
  public sfxVolume = 0.85;
  public voiceVolume = 0.9;
  public ambientVolume = 0.65;
  public musicVolume = 0.5;
  public vibrationEnabled = true;

  private musicInterval: number | null = null;
  private ambientInterval: number | null = null;
  private musicStep = 0;
  private lastVoiceTimestamp = 0;

  private ensureContext(): AudioContext | null {
    if (!this.soundEnabled && !this.musicEnabled) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
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
    if (!enabled) {
      this.stopAmbientLoop();
    }
  }

  public setMusicEnabled(enabled: boolean) {
    this.musicEnabled = enabled;
    if (enabled) {
      this.startMenuBatucada();
    } else {
      this.stopMenuBatucada();
    }
  }

  public updateVolumes(opts: {
    sfxVolume?: number;
    voiceVolume?: number;
    ambientVolume?: number;
    musicVolume?: number;
    vibrationEnabled?: boolean;
  }) {
    if (opts.sfxVolume !== undefined) this.sfxVolume = opts.sfxVolume;
    if (opts.voiceVolume !== undefined) this.voiceVolume = opts.voiceVolume;
    if (opts.ambientVolume !== undefined) this.ambientVolume = opts.ambientVolume;
    if (opts.musicVolume !== undefined) this.musicVolume = opts.musicVolume;
    if (opts.vibrationEnabled !== undefined) {
      this.vibrationEnabled = opts.vibrationEnabled;
    }
  }

  /**
   * Optional haptic vibration on mobile devices (when kicking, tackling, or scoring)
   */
  public triggerVibration(pattern: number | number[] = 35) {
    if (!this.vibrationEnabled) return;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Ignore on unsupported browsers
      }
    }
  }

  /**
   * Kick / Pass sound: deep leather thud + dirt burst
   */
  public playKick(power = 0.7) {
    if (!this.soundEnabled || this.sfxVolume <= 0.01) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const vol = this.sfxVolume;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const startFreq = 115 + power * 45 + (Math.random() - 0.5) * 14;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.14);

    gain.gain.setValueAtTime(Math.min(0.65, (0.25 + power * 0.3) * vol), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.16);

    if (power > 0.55) {
      this.playNoiseBurst(0.09, 950, 0.16 * power * vol);
      this.triggerVibration(power > 0.75 ? 45 : 22);
    } else {
      this.triggerVibration(15);
    }
  }

  /**
   * Ball bouncing on packed dirt / sand ("bola quicando na terra")
   */
  public playDirtBounce(intensity = 0.5) {
    if (!this.soundEnabled || this.sfxVolume <= 0.01) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const vol = Math.min(0.35, intensity * 0.25 * this.sfxVolume);
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(92 + intensity * 25, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.09);

    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.095);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);

    this.playNoiseBurst(0.04, 820, vol * 0.45);
  }

  /**
   * Player body collision / shoulder charge ("colisão entre jogadores")
   */
  public playCollision() {
    if (!this.soundEnabled || this.sfxVolume <= 0.01) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const vol = 0.22 * this.sfxVolume;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(84, now);
    osc.frequency.exponentialRampToValueAtTime(29, now + 0.12);

    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  /**
   * Footstep on dry sand/dirt or wet mud/puddle
   */
  public playFootstep(inPuddle = false, inMud = false) {
    if (!this.soundEnabled || this.sfxVolume <= 0.01) return;
    const vol = this.sfxVolume;
    if (inPuddle) {
      this.playNoiseBurst(
        0.075,
        1650 + (Math.random() - 0.5) * 280,
        0.11 * vol
      );
    } else if (inMud) {
      this.playNoiseBurst(0.065, 620 + (Math.random() - 0.5) * 110, 0.09 * vol);
    } else {
      this.playNoiseBurst(
        0.045,
        980 + (Math.random() - 0.5) * 160,
        0.065 * vol
      );
    }
  }

  /**
   * Slide tackle ("carrinho na lama") on dirt/mud
   */
  public playSlideTackle(inPuddle = false) {
    if (!this.soundEnabled || this.sfxVolume <= 0.01) return;
    const freq = inPuddle ? 1400 : 750;
    this.playNoiseBurst(0.26, freq, 0.24 * this.sfxVolume);
    this.triggerVibration(35);
  }

  /**
   * Ball hitting wooden/iron goalpost ("bola batendo na trave")
   */
  public playGoalpostHit() {
    if (!this.soundEnabled || this.sfxVolume <= 0.01) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.exponentialRampToValueAtTime(195, now + 0.24);

    gain.gain.setValueAtTime(0.32 * this.sfxVolume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.27);
    this.triggerVibration([30, 40, 30]);
  }

  /**
   * Ball rustling in goal net ("bola na rede")
   */
  public playNetRustle() {
    if (!this.soundEnabled || this.sfxVolume <= 0.01) return;
    this.playNoiseBurst(0.22, 1200, 0.18 * this.sfxVolume);
  }

  /**
   * Referee whistle ("apito de início e fim")
   */
  public playWhistle(mode: 'short' | 'goal' | 'fulltime' = 'short') {
    if (!this.soundEnabled || this.sfxVolume <= 0.01) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const vol = this.sfxVolume;
    const triggerTone = (offset: number, duration: number) => {
      const now = ctx.currentTime + offset;
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(2820, now);

      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(42, now);
      lfoGain.gain.setValueAtTime(95, now);

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.22 * vol, now + 0.03);
      gain.gain.setValueAtTime(
        0.2 * vol,
        now + Math.max(0.04, duration - 0.05)
      );
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
   * Goal celebration fanfare + várzea shout/cheer ("comemoração de gol")
   */
  public playGoalCelebration() {
    if (!this.soundEnabled) return;
    this.playWhistle('goal');
    this.playNetRustle();
    this.triggerVibration([70, 50, 110]);

    const ctx = this.ensureContext();
    if (!ctx || this.sfxVolume <= 0.01) return;

    const vol = this.sfxVolume;
    const notes = [261.63, 329.63, 392.0, 523.25];
    notes.forEach((freq, idx) => {
      const now = ctx.currentTime + 0.1 + idx * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);

      gain.gain.setValueAtTime(0.18 * vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.46);
    });

    // Crowd & sideline reaction burst
    this.playNoiseBurst(0.85, 850, 0.16 * Math.max(vol, this.ambientVolume));
  }

  /**
   * Short contextual player voice callout ("Toca a bola!", "Aqui!", "Que golaço!", etc.)
   * Uses Web Speech API in pt-BR when available plus a subtle vocal callout chime,
   * respecting a cooldown so voices never become repetitive.
   */
  public speakPhrase(
    phrase: string,
    pitchHint = 1.0,
    forceImmediate = false
  ): boolean {
    if (!this.soundEnabled || this.voiceVolume <= 0.02) return false;
    const nowMs = performance.now();
    if (!forceImmediate && nowMs - this.lastVoiceTimestamp < 3800) {
      return false;
    }
    this.lastVoiceTimestamp = nowMs;

    // Synthesize a short expressive human-formant callout tone so audio feedback works even in headless/no-TTS browsers
    const ctx = this.ensureContext();
    if (ctx) {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const formant = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      const baseF = 145 * pitchHint;
      osc.frequency.setValueAtTime(baseF, now);
      osc.frequency.linearRampToValueAtTime(baseF * 1.24, now + 0.09);
      osc.frequency.exponentialRampToValueAtTime(baseF * 0.92, now + 0.22);

      formant.type = 'bandpass';
      formant.frequency.setValueAtTime(720, now);
      formant.Q.setValueAtTime(3.2, now);

      gain.gain.setValueAtTime(0.12 * this.voiceVolume, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

      osc.connect(formant);
      formant.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    }

    // Also speak in Brazilian Portuguese via SpeechSynthesis if supported by browser
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(phrase);
        utter.lang = 'pt-BR';
        utter.volume = Math.min(1, Math.max(0, this.voiceVolume));
        utter.rate = 1.18;
        utter.pitch = pitchHint;
        window.speechSynthesis.speak(utter);
      } catch {
        // Ignore if SpeechSynthesis is blocked
      }
    }

    return true;
  }

  /**
   * Continuous rural Várzea sideline ambience (breeze, distant birds, sideline murmur)
   */
  public startAmbientLoop() {
    this.stopAmbientLoop();
    if (!this.soundEnabled) return;

    this.ambientInterval = window.setInterval(() => {
      if (!this.soundEnabled || this.ambientVolume <= 0.02) return;
      // Soft rural breeze / distant crowd murmur burst
      this.playNoiseBurst(
        0.55,
        460 + (Math.random() - 0.5) * 140,
        0.028 * this.ambientVolume
      );
    }, 1400);
  }

  public stopAmbientLoop() {
    if (this.ambientInterval !== null) {
      clearInterval(this.ambientInterval);
      this.ambientInterval = null;
    }
  }

  private playNoiseBurst(duration: number, centerFreq: number, volume: number) {
    const ctx = this.ensureContext();
    if (!ctx || volume <= 0.001) return;

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
      if (!this.musicEnabled || this.musicVolume <= 0.01) return;
      const ctx = this.ensureContext();
      if (!ctx) return;

      const vol = this.musicVolume;
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
        gain.gain.setValueAtTime(0.22 * vol, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.21);
      }

      // Shake/ganzá on offbeats
      if (step % 2 === 1) {
        this.playNoiseBurst(0.04, 3200, 0.055 * vol);
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
