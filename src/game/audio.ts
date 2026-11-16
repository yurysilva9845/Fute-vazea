// Procedural Web Audio API sound effects & campinho ambience for SEM TERRA FC — Várzea 4x4
// Note: Artificial/synthetic player voices (SpeechSynthesis / formant callouts) have been completely removed.
// Voice communication occurs exclusively through real human WebRTC voice chat in online rooms.

class VarzeaAudioEngine {
  private ctx: AudioContext | null = null;
  private enabled: boolean = true;
  private musicEnabled: boolean = true;
  private sfxVolume: number = 0.85;
  private ambientVolume: number = 0.65;
  private musicVolume: number = 0.5;
  private vibrationEnabled: boolean = true;
  private hasUserGesture: boolean = false;
  private ambienceInterval: number | null = null;
  private musicInterval: number | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      const markGesture = () => {
        this.hasUserGesture = true;
      };
      window.addEventListener('pointerdown', markGesture, { once: true, passive: true });
      window.addEventListener('touchstart', markGesture, { once: true, passive: true });
      window.addEventListener('keydown', markGesture, { once: true, passive: true });
    }
  }

  private ensureContext(): AudioContext | null {
    if (!this.enabled) return null;
    if (typeof window === 'undefined') return null;

    if (!this.ctx) {
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

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.stopAmbience();
      this.stopMenuMusic();
    }
  }

  public setVolumes(opts: {
    sfxVolume?: number;
    ambientVolume?: number;
    musicVolume?: number;
    musicEnabled?: boolean;
    vibrationEnabled?: boolean;
  }) {
    if (opts.sfxVolume !== undefined) this.sfxVolume = Math.max(0, Math.min(1, opts.sfxVolume));
    if (opts.ambientVolume !== undefined) this.ambientVolume = Math.max(0, Math.min(1, opts.ambientVolume));
    if (opts.musicVolume !== undefined) this.musicVolume = Math.max(0, Math.min(1, opts.musicVolume));
    if (opts.musicEnabled !== undefined) {
      this.musicEnabled = opts.musicEnabled;
      if (!this.musicEnabled) this.stopMenuMusic();
    }
    if (opts.vibrationEnabled !== undefined) this.vibrationEnabled = opts.vibrationEnabled;
  }

  public vibrate(pattern: number | number[]) {
    if (!this.vibrationEnabled) return;
    if (typeof document !== 'undefined' && document.body?.dataset?.state !== 'playing') {
      return;
    }
    const navActivation =
      typeof navigator !== 'undefined'
        ? (navigator as unknown as { userActivation?: { hasBeenActive?: boolean } }).userActivation
        : undefined;
    if (!this.hasUserGesture && !navActivation?.hasBeenActive) {
      return;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Ignore on unsupported browsers
      }
    }
  }

  public startMenuMusic() {
    if (!this.enabled || !this.musicEnabled || this.musicInterval !== null) return;
    if (typeof window === 'undefined') return;

    let step = 0;
    // Batucada / Samba de Várzea percussive groove in menu
    this.musicInterval = window.setInterval(() => {
      if (!this.enabled || !this.musicEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const vol = this.musicVolume * 0.25;
      if (vol <= 0.01) return;

      // Surdo bass beat on 0 and 4
      if (step % 4 === 0) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        const pitch = step % 8 === 0 ? 68 : 82;
        osc.frequency.setValueAtTime(pitch, now);
        osc.frequency.exponentialRampToValueAtTime(42, now + 0.22);

        gain.gain.setValueAtTime(vol * 0.9, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.25);
      }

      // Tamborim / Agogô syncopation
      if (step % 2 === 1 || step % 8 === 6) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(step % 4 === 1 ? 680 : 880, now);
        gain.gain.setValueAtTime(vol * 0.22, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.07);
      }

      step = (step + 1) % 8;
    }, 240);
  }

  public stopMenuMusic() {
    if (this.musicInterval !== null && typeof window !== 'undefined') {
      window.clearInterval(this.musicInterval);
      this.musicInterval = null;
    }
  }

  public startAmbience() {
    this.stopMenuMusic();
    if (!this.enabled || this.ambienceInterval !== null) return;
    if (typeof window === 'undefined') return;

    this.ambienceInterval = window.setInterval(() => {
      if (!this.enabled) return;
      const r = Math.random();
      if (r < 0.42) {
        this.playBirdChirp();
      } else if (r < 0.65) {
        this.playDistantDogBark();
      } else if (r < 0.85) {
        this.playWindGust();
      }
    }, 3200);
  }

  public stopAmbience() {
    if (this.ambienceInterval !== null && typeof window !== 'undefined') {
      window.clearInterval(this.ambienceInterval);
      this.ambienceInterval = null;
    }
  }

  private playWindGust() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const vol = this.ambientVolume * 0.035;
    if (vol <= 0.002) return;

    const bufferSize = Math.floor(ctx.sampleRate * 0.65);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.sin((i / bufferSize) * Math.PI);
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(340, now);
    filter.Q.value = 2.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  public playKick(power: number = 0.7, inPuddle: boolean = false) {
    this.vibrate(power > 0.75 ? [22, 15, 30] : 14);
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    const startFreq = 135 + power * 65;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(36, now + 0.13);

    const vol = Math.min(0.45, (0.16 + power * 0.24) * this.sfxVolume);
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.15);

    if (inPuddle) {
      this.playSplash(0.6);
    }
  }

  public playPass(inPuddle: boolean = false) {
    this.vibrate(10);
    this.playKick(0.35, inPuddle);
  }

  public playBounce(intensity: number = 0.5, inPuddle: boolean = false) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    if (inPuddle) {
      this.playSplash(intensity * 0.7);
      return;
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(92 + intensity * 30, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.08);

    const vol = Math.min(0.22, intensity * 0.18 * this.sfxVolume);
    gain.gain.setValueAtTime(Math.max(0.01, vol), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.09);
  }

  public playSplash(intensity: number = 0.5) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const bufferSize = Math.floor(ctx.sampleRate * 0.18);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.42));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(920 + Math.random() * 350, now);
    filter.Q.setValueAtTime(1.8, now);

    const gain = ctx.createGain();
    const vol = Math.min(0.25, (0.06 + intensity * 0.14) * this.sfxVolume);
    gain.gain.setValueAtTime(Math.max(0.005, vol), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    noise.start(now);
  }

  public playFootstep(inPuddle: boolean = false, inMud: boolean = false) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    if (inPuddle) {
      this.playSplash(0.28);
      return;
    }

    const now = ctx.currentTime;
    const bufferSize = Math.floor(ctx.sampleRate * 0.055);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.35));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(inMud ? 320 : 540, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.045 * this.sfxVolume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    noise.start(now);
  }

  public playSlideTackle(inPuddle: boolean = false) {
    this.vibrate([18, 20, 28]);
    const ctx = this.ensureContext();
    if (!ctx) return;

    if (inPuddle) {
      this.playSplash(0.85);
    }

    const now = ctx.currentTime;
    const bufferSize = Math.floor(ctx.sampleRate * 0.26);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.55));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(480, now);
    filter.Q.value = 1.2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16 * this.sfxVolume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  public playCollision() {
    this.vibrate(25);
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(115, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.11);

    gain.gain.setValueAtTime(0.22 * this.sfxVolume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  public playPostHit() {
    this.vibrate([35, 20, 35]);
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.exponentialRampToValueAtTime(145, now + 0.22);

    gain.gain.setValueAtTime(0.32 * this.sfxVolume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.25);
  }

  public playNetSwish() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const bufferSize = Math.floor(ctx.sampleRate * 0.22);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.sin((i / bufferSize) * Math.PI);
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(1100, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.14 * this.sfxVolume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  public playWhistle(type: 'short' | 'long' | 'double' | 'fulltime' = 'short') {
    this.vibrate(type === 'long' || type === 'fulltime' ? [40, 30, 80] : 25);
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const playTone = (startOffset: number, duration: number) => {
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(2750, now + startOffset);

      // Whistle pea trill effect
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(42, now + startOffset);
      lfoGain.gain.setValueAtTime(120, now + startOffset);

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      const vol = 0.16 * this.sfxVolume;
      gain.gain.setValueAtTime(0.001, now + startOffset);
      gain.gain.linearRampToValueAtTime(vol, now + startOffset + 0.02);
      gain.gain.setValueAtTime(vol, now + startOffset + duration - 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + startOffset);
      lfo.start(now + startOffset);
      osc.stop(now + startOffset + duration);
      lfo.stop(now + startOffset + duration);
    };

    if (type === 'short') {
      playTone(0, 0.28);
    } else if (type === 'double') {
      playTone(0, 0.18);
      playTone(0.24, 0.35);
    } else {
      playTone(0, 0.65);
    }
  }

  public playGoalCheer() {
    this.vibrate([60, 40, 90, 40, 120]);
    this.playNetSwish();
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    // Sideline crowd roar + celebratory brass/percussion chord (without synthetic player speech)
    const bufferSize = Math.floor(ctx.sampleRate * 1.4);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      const env = Math.sin((i / bufferSize) * Math.PI);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const crowd = ctx.createBufferSource();
    crowd.buffer = buffer;
    const crowdFilter = ctx.createBiquadFilter();
    crowdFilter.type = 'bandpass';
    crowdFilter.frequency.setValueAtTime(720, now);
    crowdFilter.Q.value = 1.4;

    const crowdGain = ctx.createGain();
    crowdGain.gain.setValueAtTime(0.18 * this.sfxVolume, now);
    crowdGain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);

    crowd.connect(crowdFilter);
    crowdFilter.connect(crowdGain);
    crowdGain.connect(ctx.destination);
    crowd.start(now);

    const freqs = [261.63, 329.63, 392.0, 523.25];
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, now + idx * 0.06);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1100, now);

      gain.gain.setValueAtTime(0.08 * this.sfxVolume, now + idx * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.15);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.06);
      osc.stop(now + 1.2);
    });
  }

  private playBirdChirp() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const vol = 0.03 * this.ambientVolume;
    if (vol <= 0.001) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    const baseFreq = 2600 + Math.random() * 900;
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.28, now + 0.07);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.92, now + 0.14);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.16);
  }

  private playDistantDogBark() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const vol = 0.025 * this.ambientVolume;
    if (vol <= 0.001) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(360, now);
    osc.frequency.exponentialRampToValueAtTime(190, now + 0.11);

    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.13);
  }

  // Compatibility aliases for MatchCanvas and UI components
  public startAmbientLoop() {
    this.startAmbience();
  }

  public stopAmbientLoop() {
    this.stopAmbience();
  }

  public playDirtBounce(intensity: number = 0.55) {
    this.playBounce(intensity, false);
  }

  public playGoalpostHit() {
    this.playPostHit();
  }

  public playGoalCelebration() {
    this.playGoalCheer();
  }

  public triggerVibration(pattern: number | number[]) {
    this.vibrate(pattern);
  }

  public setSoundEnabled(enabled: boolean) {
    this.setEnabled(enabled);
  }

  public setMusicEnabled(enabled: boolean) {
    this.setVolumes({ musicEnabled: enabled });
  }

  public updateVolumes(opts: {
    sfxVolume?: number;
    ambientVolume?: number;
    musicVolume?: number;
    vibrationEnabled?: boolean;
  }) {
    this.setVolumes(opts);
  }

  public stopMenuBatucada() {
    this.stopMenuMusic();
  }
}

export const soundEngine = new VarzeaAudioEngine();
export const audioEngine = soundEngine;

