import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Radio, Volume2, VolumeX } from 'lucide-react';
import { voiceChatService, VoiceStateSnapshot } from '../services/voiceChatService';

interface VoiceControlsBarProps {
  roomCode: string;
  compact?: boolean;
}

export const VoiceControlsBar: React.FC<VoiceControlsBarProps> = ({
  roomCode,
  compact = false,
}) => {
  const [voiceState, setVoiceState] = useState<VoiceStateSnapshot>(() =>
    voiceChatService.getSnapshot()
  );
  const pttButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    return voiceChatService.subscribe((snap) => {
      setVoiceState(snap);
    });
  }, [roomCode]);

  // Registra touchstart / touchend / touchcancel com { passive: false } para permitir preventDefault sem aviso no console
  useEffect(() => {
    const btn = pttButtonRef.current;
    if (!btn) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.cancelable) {
        e.preventDefault();
      }
      void voiceChatService.setPushToTalkPressed(true);
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.cancelable) {
        e.preventDefault();
      }
      void voiceChatService.setPushToTalkPressed(false);
    };

    btn.addEventListener('touchstart', onTouchStart, { passive: false });
    btn.addEventListener('touchend', onTouchEnd, { passive: false });
    btn.addEventListener('touchcancel', onTouchEnd, { passive: false });

    return () => {
      btn.removeEventListener('touchstart', onTouchStart);
      btn.removeEventListener('touchend', onTouchEnd);
      btn.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [compact]);

  const speakingPeers = Object.values(voiceState.peers).filter((p) => p.isSpeaking);
  const connectedPeersCount = Object.values(voiceState.peers).length;

  const handleToggleOpenMic = () => {
    if (voiceState.mode === 'open_mic') {
      void voiceChatService.setTransmissionMode('muted');
    } else {
      void voiceChatService.setTransmissionMode('open_mic');
    }
  };

  const handlePttMouseDown = (e: React.MouseEvent) => {
    if (e.cancelable) {
      e.preventDefault();
    }
    void voiceChatService.setPushToTalkPressed(true);
  };

  const handlePttMouseUp = (e: React.MouseEvent) => {
    if (e.cancelable) {
      e.preventDefault();
    }
    void voiceChatService.setPushToTalkPressed(false);
  };

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 bg-stone-950/90 border border-stone-700/80 px-2 py-1 rounded shadow-lg pointer-events-auto">
        <button
          type="button"
          onClick={handleToggleOpenMic}
          title={
            voiceState.mode === 'open_mic'
              ? 'Desligar Microfone (Voz Aberta ativa)'
              : 'Ligar Microfone (Voz Aberta)'
          }
          className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer ${
            voiceState.mode === 'open_mic'
              ? voiceState.isSelfSpeaking
                ? 'bg-emerald-500 text-stone-950 animate-pulse'
                : 'bg-emerald-600/90 text-white'
              : 'bg-stone-800 hover:bg-stone-700 text-stone-300'
          }`}
        >
          {voiceState.mode === 'open_mic' ? (
            <Mic className="w-3.5 h-3.5" />
          ) : (
            <MicOff className="w-3.5 h-3.5 text-red-400" />
          )}
          <span className="hidden sm:inline">
            {voiceState.mode === 'open_mic' ? 'Mic On' : 'Mutado'}
          </span>
        </button>

        <button
          ref={pttButtonRef}
          type="button"
          onMouseDown={handlePttMouseDown}
          onMouseUp={handlePttMouseUp}
          onMouseLeave={handlePttMouseUp}
          title="Segure para Falar (Push-to-Talk)"
          className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors select-none touch-none cursor-pointer ${
            voiceState.isPushToTalkActive
              ? 'bg-amber-500 text-stone-950 shadow-sm shadow-amber-500/40'
              : 'bg-stone-800 hover:bg-stone-700 text-amber-300 border border-amber-500/30'
          }`}
        >
          <Radio className="w-3.5 h-3.5" />
          <span>Segure p/ Falar</span>
        </button>

        <button
          type="button"
          onClick={() => voiceChatService.setMuteAll(!voiceState.muteAll)}
          title={voiceState.muteAll ? 'Reativar áudio da sala' : 'Silenciar todos na sala'}
          className={`p-1.5 rounded transition-colors cursor-pointer ${
            voiceState.muteAll
              ? 'bg-red-900/70 text-red-300 border border-red-500/40'
              : 'bg-stone-800 hover:bg-stone-700 text-stone-300'
          }`}
        >
          {voiceState.muteAll ? (
            <VolumeX className="w-3.5 h-3.5" />
          ) : (
            <Volume2 className="w-3.5 h-3.5" />
          )}
        </button>

        {speakingPeers.length > 0 && (
          <div className="hidden md:flex items-center gap-1 pl-1 border-l border-stone-700 text-[10px] font-bold text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            <span className="truncate max-w-[110px]">
              {speakingPeers.map((p) => p.displayName).join(', ')}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-stone-900/95 border border-stone-800 rounded p-3 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              voiceState.micTransmitting
                ? 'bg-emerald-400 shadow-sm shadow-emerald-400'
                : 'bg-stone-600'
            }`}
          />
          <span className="text-xs font-black uppercase tracking-wider text-stone-200">
            Chat de Voz da Sala ({roomCode})
          </span>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-stone-800 text-stone-400">
            {connectedPeersCount > 0
              ? `${connectedPeersCount} colega(s) na escuta`
              : 'Aguardando colegas humanos'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Volume2 className="w-3.5 h-3.5 text-stone-400" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={voiceState.muteAll ? 0 : voiceState.volume}
            onChange={(e) => voiceChatService.setVolume(parseFloat(e.target.value))}
            className="w-20 accent-amber-500 cursor-pointer"
            title="Volume das vozes da sala"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleToggleOpenMic}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-black uppercase tracking-wider transition-colors cursor-pointer ${
            voiceState.mode === 'open_mic'
              ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-950/50'
              : 'bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700'
          }`}
        >
          {voiceState.mode === 'open_mic' ? (
            <>
              <Mic className="w-4 h-4" />
              Desligar Microfone (Voz Aberta)
            </>
          ) : (
            <>
              <MicOff className="w-4 h-4 text-red-400" />
              Ligar Microfone
            </>
          )}
        </button>

        <button
          ref={pttButtonRef}
          type="button"
          onMouseDown={handlePttMouseDown}
          onMouseUp={handlePttMouseUp}
          onMouseLeave={handlePttMouseUp}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-black uppercase tracking-wider transition-colors select-none touch-none cursor-pointer ${
            voiceState.isPushToTalkActive
              ? 'bg-amber-500 text-stone-950 shadow-md shadow-amber-500/30'
              : 'bg-stone-800 hover:bg-stone-700 text-amber-300 border border-amber-500/40'
          }`}
        >
          <Radio className="w-4 h-4" />
          {voiceState.isPushToTalkActive ? 'Transmitindo Voz...' : 'Segurar para Falar (PTT)'}
        </button>

        <button
          type="button"
          onClick={() => voiceChatService.setMuteAll(!voiceState.muteAll)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer ${
            voiceState.muteAll
              ? 'bg-red-900/70 text-red-200 border border-red-500/50'
              : 'bg-stone-800 hover:bg-stone-700 text-stone-300 border border-stone-700'
          }`}
        >
          {voiceState.muteAll ? (
            <>
              <VolumeX className="w-4 h-4 text-red-400" />
              Silenciar Todos: Ativo
            </>
          ) : (
            <>
              <Volume2 className="w-4 h-4" />
              Silenciar Todos
            </>
          )}
        </button>
      </div>

      {voiceState.micPermissionError && (
        <div className="text-[11px] font-bold text-amber-300 bg-amber-950/60 border border-amber-700/50 px-2.5 py-1.5 rounded">
          {voiceState.micPermissionError}
        </div>
      )}

      {speakingPeers.length > 0 && (
        <div className="flex items-center gap-2 text-xs font-bold text-emerald-400 pt-1">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
          <span>Falando agora: {speakingPeers.map((p) => p.displayName).join(', ')}</span>
        </div>
      )}
    </div>
  );
};
