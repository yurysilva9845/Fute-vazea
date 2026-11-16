import { OnlineUserProfile } from '../types/game';
import {
  ensureUserProfile,
  getCurrentAuthUser,
  linkGoogleAccount,
  subscribeToAuthReady,
  subscribeToMyProfile,
  updateNickname,
  updateUserPresence,
} from './firebase';

export {
  ensureUserProfile,
  getCurrentAuthUser,
  linkGoogleAccount,
  subscribeToAuthReady,
  subscribeToMyProfile,
  updateNickname,
  updateUserPresence,
};

export function formatPlayerCareerSummary(profile: OnlineUserProfile | null): {
  wins: number;
  losses: number;
  draws: number;
  goalsScored: number;
  goalsConceded: number;
  matchesPlayed: number;
  winRatePercent: number;
} {
  const wins = profile?.wins ?? 0;
  const losses = profile?.losses ?? 0;
  const draws = profile?.draws ?? 0;
  const goalsScored = profile?.goalsScored ?? 0;
  const goalsConceded = profile?.goalsConceded ?? 0;
  const matchesPlayed = profile?.matchesPlayed ?? wins + losses + draws;
  const winRatePercent = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 100) : 0;

  return {
    wins,
    losses,
    draws,
    goalsScored,
    goalsConceded,
    matchesPlayed,
    winRatePercent,
  };
}
