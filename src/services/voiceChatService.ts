import {
  addDoc,
  collection,
  deleteDoc,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { MultiplayerSlot, VoicePeerState, VoiceTransmissionMode } from '../types/game';
import { auth, db, updatePlayerVoiceStatusInRoom } from './firebase';

const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

export interface VoiceStateSnapshot {
  roomCode: string | null;
  mode: VoiceTransmissionMode; // 'muted' (default on join) | 'open_mic' | 'push_to_talk'
  isPushToTalkActive: boolean;
  micTransmitting: boolean;
  isSelfSpeaking: boolean;
  muteAll: boolean;
  volume: number; // 0.0 - 1.0
  micPermissionError: string | null;
  peers: Record<string, VoicePeerState>;
}

/**
 * Serviço de Comunicação por Voz em Tempo Real (WebRTC + Firestore Signaling).
 * - Inicia mutado por padrão ao entrar na sala.
 * - Suporta Microfone Aberto (Open Mic), Segurar para Falar (Push-to-Talk) e Silenciar Todos.
 * - Detecta atividade de voz em tempo real via Web Audio AnalyserNode.
 * - Encerra todas as conexões WebRTC e trilhas de microfone imediatamente ao sair da sala.
 */
class WebRTCVoiceChatManager {
  private roomCode: string | null = null;
  private mode: VoiceTransmissionMode = 'muted';
  private isPushToTalkActive = false;
  private muteAll = false;
  private volume = 0.9;
  private micPermissionError: string | null = null;
  private isSelfSpeaking = false;

  private localStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private peerAnalysers = new Map<string, AnalyserNode>();
  private peerConnections = new Map<string, RTCPeerConnection>();
  private remoteAudioElements = new Map<string, HTMLAudioElement>();
  private peersState = new Map<string, VoicePeerState>();

  private unsubSignals: (() => void) | null = null;
  private vadInterval: number | null = null;
  private listeners = new Set<(state: VoiceStateSnapshot) => void>();
  private lastPublishedMic = false;
  private lastPublishedSpeaking = false;

  public subscribe(cb: (state: VoiceStateSnapshot) => void): () => void {
    this.listeners.add(cb);
    cb(this.getSnapshot());
    return () => {
      this.listeners.delete(cb);
    };
  }

  public getSnapshot(): VoiceStateSnapshot {
    const peersObj: Record<string, VoicePeerState> = {};
    this.peersState.forEach((val, key) => {
      peersObj[key] = { ...val };
    });

    const micTransmitting =
      !this.muteAll &&
      (this.mode === 'open_mic' || (this.mode === 'push_to_talk' && this.isPushToTalkActive));

    return {
      roomCode: this.roomCode,
      mode: this.mode,
      isPushToTalkActive: this.isPushToTalkActive,
      micTransmitting,
      isSelfSpeaking: micTransmitting && this.isSelfSpeaking,
      muteAll: this.muteAll,
      volume: this.volume,
      micPermissionError: this.micPermissionError,
      peers: peersObj,
    };
  }

  private notify() {
    const snap = this.getSnapshot();
    this.listeners.forEach((cb) => cb(snap));
  }

  /**
   * Conecta ao canal de sinalização WebRTC da sala atual.
   * Comportamento padrão ao entrar: microfone mutado ('muted').
   */
  public joinRoomVoice(roomCode: string, slots: Record<string, MultiplayerSlot>) {
    const normalized = roomCode.trim().toUpperCase();
    if (this.roomCode === normalized) {
      this.syncRoomSlots(slots);
      return;
    }

    this.leaveRoomVoice();
    this.roomCode = normalized;
    this.mode = 'muted'; // Sempre mutado ao entrar na sala
    this.isPushToTalkActive = false;
    this.micPermissionError = null;
    this.isSelfSpeaking = false;

    this.syncRoomSlots(slots);
    this.listenToRoomSignals(normalized);
    this.startVoiceActivityLoop();
    this.notify();
  }

  /**
   * Atualiza os participantes humanos da sala e inicia/fecha conexões P2P WebRTC conforme necessário.
   */
  public syncRoomSlots(slots: Record<string, MultiplayerSlot>) {
    const myUid = auth.currentUser?.uid;
    if (!myUid || !this.roomCode) return;

    const activeHumanUids = new Set<string>();

    for (const slot of Object.values(slots || {})) {
      if (!slot.isBot && slot.uid && slot.uid !== myUid) {
        activeHumanUids.add(slot.uid);
        const existingPeer = this.peersState.get(slot.uid);
        this.peersState.set(slot.uid, {
          uid: slot.uid,
          displayName: slot.displayName,
          characterId: slot.characterId,
          team: slot.team,
          micEnabled: Boolean(slot.micEnabled),
          isSpeaking: Boolean(slot.isSpeaking),
          mutedByMe: existingPeer?.mutedByMe ?? false,
          connectionState: existingPeer?.connectionState ?? 'connecting',
        });

        // Determinismo para evitar glare: UID lexicograficamente menor inicia a oferta WebRTC
        if (!this.peerConnections.has(slot.uid) && myUid < slot.uid) {
          this.initiatePeerOffer(slot.uid).catch(() => {});
        }
      }
    }

    // Remove conexões de jogadores que saíram da sala
    for (const peerUid of Array.from(this.peersState.keys())) {
      if (!activeHumanUids.has(peerUid)) {
        this.closePeer(peerUid);
        this.peersState.delete(peerUid);
      }
    }

    this.notify();
  }

  /**
   * Alterna entre Microfone Mutado, Voz Aberta ou Push-to-Talk.
   */
  public async setTransmissionMode(newMode: VoiceTransmissionMode): Promise<void> {
    this.micPermissionError = null;

    if (newMode !== 'muted') {
      const ok = await this.ensureMicrophoneStream();
      if (!ok) {
        this.mode = 'muted';
        this.notify();
        return;
      }
    }

    this.mode = newMode;
    if (newMode !== 'push_to_talk') {
      this.isPushToTalkActive = false;
    }

    this.applyMicTrackState();
    this.notify();
  }

  public async setPushToTalkPressed(pressed: boolean): Promise<void> {
    if (pressed && this.mode !== 'push_to_talk') {
      await this.setTransmissionMode('push_to_talk');
    }
    this.isPushToTalkActive = pressed;
    this.applyMicTrackState();
    this.notify();
  }

  public setMuteAll(muteAll: boolean) {
    this.muteAll = muteAll;
    this.applyRemoteAudioVolumes();
    this.applyMicTrackState();
    this.notify();
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
    this.applyRemoteAudioVolumes();
    this.notify();
  }

  public toggleMutePeer(peerUid: string) {
    const peer = this.peersState.get(peerUid);
    if (!peer) return;
    peer.mutedByMe = !peer.mutedByMe;
    this.peersState.set(peerUid, peer);
    this.applyRemoteAudioVolumes();
    this.notify();
  }

  private async ensureMicrophoneStream(): Promise<boolean> {
    if (this.localStream) return true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.micPermissionError = 'Navegador sem suporte a captura de microfone.';
      return false;
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      this.setupLocalVoiceAnalyser(this.localStream);

      // Adiciona as tracks de áudio às conexões existentes e renegocia
      for (const [peerUid, pc] of this.peerConnections.entries()) {
        this.localStream.getAudioTracks().forEach((track) => {
          const alreadyAdded = pc.getSenders().some((s) => s.track === track);
          if (!alreadyAdded) {
            pc.addTrack(track, this.localStream!);
          }
        });
        this.initiatePeerOffer(peerUid).catch(() => {});
      }

      this.applyMicTrackState();
      return true;
    } catch {
      this.micPermissionError = 'Permissão de microfone negada ou dispositivo indisponível.';
      return false;
    }
  }

  private applyMicTrackState() {
    const shouldTransmit =
      !this.muteAll &&
      (this.mode === 'open_mic' || (this.mode === 'push_to_talk' && this.isPushToTalkActive));

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = shouldTransmit;
      });
    }

    if (!shouldTransmit) {
      this.isSelfSpeaking = false;
    }

    this.publishVoiceStatusIfNeeded(shouldTransmit, this.isSelfSpeaking);
  }

  private applyRemoteAudioVolumes() {
    this.remoteAudioElements.forEach((audioEl, peerUid) => {
      const peer = this.peersState.get(peerUid);
      const isMuted = this.muteAll || Boolean(peer?.mutedByMe);
      audioEl.muted = isMuted;
      audioEl.volume = isMuted ? 0 : this.volume;
    });
  }

  private setupLocalVoiceAnalyser(stream: MediaStream) {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioCtx) {
        this.audioCtx = new AudioCtx();
      }
      const source = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.localAnalyser = analyser;
    } catch {
      // Ignore AudioContext analyser issues
    }
  }

  private setupRemoteVoiceAnalyser(peerUid: string, stream: MediaStream) {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioCtx) {
        this.audioCtx = new AudioCtx();
      }
      const source = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.peerAnalysers.set(peerUid, analyser);
    } catch {
      // Ignore
    }
  }

  private startVoiceActivityLoop() {
    if (this.vadInterval !== null || typeof window === 'undefined') return;
    const dataArray = new Uint8Array(64);

    this.vadInterval = window.setInterval(() => {
      let changed = false;
      const shouldTransmit =
        !this.muteAll &&
        (this.mode === 'open_mic' || (this.mode === 'push_to_talk' && this.isPushToTalkActive));

      if (shouldTransmit && this.localAnalyser) {
        this.localAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const speakingNow = avg > 18;
        if (speakingNow !== this.isSelfSpeaking) {
          this.isSelfSpeaking = speakingNow;
          changed = true;
        }
      } else if (this.isSelfSpeaking) {
        this.isSelfSpeaking = false;
        changed = true;
      }

      // Analisa áudio recebido dos colegas na sala
      this.peerAnalysers.forEach((analyser, peerUid) => {
        const peer = this.peersState.get(peerUid);
        if (!peer) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const peerSpeaking = avg > 16 && !this.muteAll && !peer.mutedByMe;
        if (peer.isSpeaking !== peerSpeaking) {
          peer.isSpeaking = peerSpeaking;
          this.peersState.set(peerUid, peer);
          changed = true;
        }
      });

      if (changed) {
        this.notify();
      }
    }, 220);
  }

  private publishVoiceStatusIfNeeded(micEnabled: boolean, isSpeaking: boolean) {
    if (!this.roomCode) return;
    if (this.lastPublishedMic === micEnabled && this.lastPublishedSpeaking === isSpeaking) return;
    this.lastPublishedMic = micEnabled;
    this.lastPublishedSpeaking = isSpeaking;
    updatePlayerVoiceStatusInRoom(this.roomCode, micEnabled, isSpeaking).catch(() => {});
  }

  private getOrCreatePeerConnection(peerUid: string): RTCPeerConnection {
    const existing = this.peerConnections.get(peerUid);
    if (existing) return existing;

    const pc = new RTCPeerConnection(RTC_CONFIGURATION);
    this.peerConnections.set(peerUid, pc);

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.roomCode) {
        this.sendSignal(peerUid, 'ice', JSON.stringify(ev.candidate.toJSON())).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      const peer = this.peersState.get(peerUid);
      if (peer) {
        const st = pc.connectionState;
        peer.connectionState =
          st === 'connected'
            ? 'connected'
            : st === 'failed'
            ? 'failed'
            : st === 'disconnected' || st === 'closed'
            ? 'disconnected'
            : 'connecting';
        this.peersState.set(peerUid, peer);
        this.notify();
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream || typeof window === 'undefined') return;
      let audioEl = this.remoteAudioElements.get(peerUid);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        this.remoteAudioElements.set(peerUid, audioEl);
      }
      audioEl.srcObject = stream;
      this.applyRemoteAudioVolumes();
      audioEl.play().catch(() => {});
      this.setupRemoteVoiceAnalyser(peerUid, stream);
    };

    return pc;
  }

  private async initiatePeerOffer(peerUid: string): Promise<void> {
    if (!this.roomCode) return;
    const pc = this.getOrCreatePeerConnection(peerUid);
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    await pc.setLocalDescription(offer);
    await this.sendSignal(peerUid, 'offer', JSON.stringify(offer));
  }

  private async sendSignal(
    toUid: string,
    type: 'offer' | 'answer' | 'ice',
    payload: string
  ): Promise<void> {
    const myUid = auth.currentUser?.uid;
    if (!myUid || !this.roomCode) return;
    await addDoc(collection(db, 'rooms', this.roomCode, 'signals'), {
      fromUid: myUid,
      toUid,
      type,
      payload,
      createdAt: serverTimestamp(),
    });
  }

  private listenToRoomSignals(roomCode: string) {
    if (this.unsubSignals) {
      this.unsubSignals();
      this.unsubSignals = null;
    }

    const myUid = auth.currentUser?.uid;
    if (!myUid) return;

    const q = query(collection(db, 'rooms', roomCode, 'signals'), where('toUid', '==', myUid));
    this.unsubSignals = onSnapshot(
      q,
      (snap) => {
        snap.docChanges().forEach(async (change) => {
          if (change.type !== 'added') return;
          const data = change.doc.data();
          const fromUid = String(data.fromUid);
          const sigType = String(data.type) as 'offer' | 'answer' | 'ice';
          const payloadStr = String(data.payload || '');

          // Remove o sinal consumido
          deleteDoc(change.doc.ref).catch((err) => {
            console.warn('[STF-Voice] Aviso ao remover sinal WebRTC consumido:', err);
          });

          try {
            const pc = this.getOrCreatePeerConnection(fromUid);
            if (sigType === 'offer') {
              const desc = JSON.parse(payloadStr) as RTCSessionDescriptionInit;
              await pc.setRemoteDescription(new RTCSessionDescription(desc));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await this.sendSignal(fromUid, 'answer', JSON.stringify(answer));
            } else if (sigType === 'answer') {
              const desc = JSON.parse(payloadStr) as RTCSessionDescriptionInit;
              if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(desc));
              }
            } else if (sigType === 'ice') {
              const cand = JSON.parse(payloadStr) as RTCIceCandidateInit;
              if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              }
            }
          } catch (err) {
            console.warn('[STF-Voice] Aviso de negociação WebRTC transitória:', err);
          }
        });
      },
      (err) => {
        console.warn(`[STF-Voice] Erro no listener de sinais da sala ${roomCode}:`, err);
      }
    );
  }

  private closePeer(peerUid: string) {
    const pc = this.peerConnections.get(peerUid);
    if (pc) {
      try {
        pc.close();
      } catch {
        // Ignore
      }
      this.peerConnections.delete(peerUid);
    }
    const audioEl = this.remoteAudioElements.get(peerUid);
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      this.remoteAudioElements.delete(peerUid);
    }
    this.peerAnalysers.delete(peerUid);
  }

  /**
   * Desconecta imediatamente todas as conexões de voz WebRTC e desliga o microfone físico.
   */
  public leaveRoomVoice() {
    if (this.unsubSignals) {
      this.unsubSignals();
      this.unsubSignals = null;
    }
    if (this.vadInterval !== null && typeof window !== 'undefined') {
      window.clearInterval(this.vadInterval);
      this.vadInterval = null;
    }

    for (const peerUid of Array.from(this.peerConnections.keys())) {
      this.closePeer(peerUid);
    }
    this.peerConnections.clear();
    this.peersState.clear();
    this.peerAnalysers.clear();

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      });
      this.localStream = null;
    }

    this.localAnalyser = null;
    this.roomCode = null;
    this.mode = 'muted';
    this.isPushToTalkActive = false;
    this.isSelfSpeaking = false;
    this.micPermissionError = null;
    this.lastPublishedMic = false;
    this.lastPublishedSpeaking = false;
    this.notify();
  }
}

export const voiceChatService = new WebRTCVoiceChatManager();
