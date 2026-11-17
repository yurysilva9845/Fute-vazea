import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { onIdTokenChanged, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const EXPECTED_FIREBASE_PROJECT_ID = firebaseConfig.projectId || 'gen-lang-client-0384619138';
const EXPECTED_FIREBASE_ISSUER = `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`;

export interface FirebaseJwtValidationResult {
  valid: boolean;
  uid: string | null;
  iss: string | null;
  aud: string | null;
  role: string | null;
  hasAuthenticatedRole: boolean;
  expMs: number | null;
  needsRefresh: boolean;
  reason?: string;
}

/**
 * Decodifica o payload base64url de um JWT sem armazenar o token permanentemente.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

    let jsonStr = '';
    if (typeof atob === 'function') {
      jsonStr = decodeURIComponent(
        Array.from(atob(padded))
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
    } else if (typeof Buffer !== 'undefined') {
      jsonStr = Buffer.from(padded, 'base64').toString('utf8');
    } else {
      return null;
    }

    const parsed = JSON.parse(jsonStr);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Valida emissor (iss), audiência (aud), identidade (sub === uid), role ('authenticated')
 * e expiração (exp) do JWT emitido pelo Firebase Authentication para o Supabase Third-Party Auth.
 */
export function validateFirebaseJwtClaims(
  token: string,
  expectedUid?: string,
  nowMs: number = Date.now(),
  requireAuthenticatedRole: boolean = false
): FirebaseJwtValidationResult {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return {
      valid: false,
      uid: null,
      iss: null,
      aud: null,
      role: null,
      hasAuthenticatedRole: false,
      expMs: null,
      needsRefresh: true,
      reason: 'Formato JWT inválido.',
    };
  }

  const iss = typeof payload.iss === 'string' ? payload.iss : null;
  const aud = typeof payload.aud === 'string' ? payload.aud : null;
  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : null;
  const role = typeof payload.role === 'string' ? payload.role.trim() : null;
  const hasAuthenticatedRole = role === 'authenticated';
  const expSec = typeof payload.exp === 'number' ? payload.exp : null;
  const expMs = expSec !== null ? expSec * 1000 : null;

  if (iss !== EXPECTED_FIREBASE_ISSUER) {
    return {
      valid: false,
      uid: sub,
      iss,
      aud,
      role,
      hasAuthenticatedRole,
      expMs,
      needsRefresh: false,
      reason: `Emissor JWT inválido: esperado "${EXPECTED_FIREBASE_ISSUER}", recebido "${iss}".`,
    };
  }

  if (aud !== EXPECTED_FIREBASE_PROJECT_ID) {
    return {
      valid: false,
      uid: sub,
      iss,
      aud,
      role,
      hasAuthenticatedRole,
      expMs,
      needsRefresh: false,
      reason: `Audiência JWT inválida: esperado "${EXPECTED_FIREBASE_PROJECT_ID}", recebido "${aud}".`,
    };
  }

  if (!sub) {
    return {
      valid: false,
      uid: null,
      iss,
      aud,
      role,
      hasAuthenticatedRole,
      expMs,
      needsRefresh: true,
      reason: 'Identidade (sub/UID) ausente no JWT.',
    };
  }

  if (expectedUid && sub !== expectedUid) {
    return {
      valid: false,
      uid: sub,
      iss,
      aud,
      role,
      hasAuthenticatedRole,
      expMs,
      needsRefresh: true,
      reason: `Identidade JWT (${sub}) difere do UID autenticado (${expectedUid}).`,
    };
  }

  if (requireAuthenticatedRole && !hasAuthenticatedRole) {
    return {
      valid: false,
      uid: sub,
      iss,
      aud,
      role,
      hasAuthenticatedRole: false,
      expMs,
      needsRefresh: true,
      reason: 'Claim customizada role="authenticated" ausente no JWT do Firebase.',
    };
  }

  // Margem de segurança de 60 segundos antes da expiração real para nunca enviar token expirado
  const refreshThresholdMs = 60_000;
  if (expMs === null || expMs <= nowMs) {
    return {
      valid: false,
      uid: sub,
      iss,
      aud,
      role,
      hasAuthenticatedRole,
      expMs,
      needsRefresh: true,
      reason: 'Token JWT expirado.',
    };
  }

  const needsRefresh = expMs - nowMs <= refreshThresholdMs || !hasAuthenticatedRole;
  return {
    valid: true,
    uid: sub,
    iss,
    aud,
    role,
    hasAuthenticatedRole,
    expMs,
    needsRefresh,
  };
}

function normalizeEnvValue(raw: string): string {
  return raw.trim().replace(/^['"]+|['"]+$/g, '').trim();
}

/**
 * Verifica se a chave fornecida é segura para uso no navegador (Publishable / Anon Key)
 * e bloqueia qualquer chave secreta (sb_secret_ ou service_role).
 */
export function isSafePublishableKey(key: string): boolean {
  const clean = normalizeEnvValue(key);
  if (!clean) return false;
  if (clean.startsWith('sb_secret_')) return false;

  if (clean.startsWith('eyJ')) {
    const payload = decodeJwtPayload(clean);
    if (payload && payload.role === 'service_role') {
      return false;
    }
  }
  return true;
}

function readEnvVar(name: string): string {
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env[name]) {
    return normalizeEnvValue(String(import.meta.env[name]));
  }
  if (typeof process !== 'undefined' && process.env && process.env[name]) {
    return normalizeEnvValue(String(process.env[name]));
  }
  return '';
}

let secretKeyWarningLogged = false;

export function getSupabaseConfig(): {
  url: string;
  publishableKey: string;
  isConfigured: boolean;
  configWarning: string | null;
} {
  const url = readEnvVar('VITE_SUPABASE_URL') || readEnvVar('VITE_PUBLIC_SUPABASE_URL');
  const candidateKeys = [
    readEnvVar('VITE_SUPABASE_PUBLISHABLE_KEY'),
    readEnvVar('VITE_SUPABASE_ANON_KEY'),
    readEnvVar('VITE_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    readEnvVar('VITE_PUBLIC_SUPABASE_ANON_KEY'),
  ].filter(Boolean);

  if (!url || candidateKeys.length === 0) {
    return {
      url: '',
      publishableKey: '',
      isConfigured: false,
      configWarning:
        'VITE_SUPABASE_URL e/ou VITE_SUPABASE_PUBLISHABLE_KEY ainda não configuradas no ambiente.',
    };
  }

  const safeKey = candidateKeys.find((candidate) => isSafePublishableKey(candidate));

  if (!safeKey) {
    if (!secretKeyWarningLogged) {
      secretKeyWarningLogged = true;
      console.warn(
        '[STF-Supabase] Aviso de segurança: a chave configurada em VITE_SUPABASE_PUBLISHABLE_KEY é do tipo secreta (sb_secret_ / service_role) e foi ignorada no navegador. Substitua pela Publishable Key (sb_publishable_... ou anon) nas configurações de ambiente para ativar o cliente Supabase.'
      );
    }
    return {
      url: url.replace(/\/+$/, ''),
      publishableKey: '',
      isConfigured: false,
      configWarning:
        'Chave ignorada por segurança: substitua a Secret Key (sb_secret_) pela Publishable Key (sb_publishable_) em VITE_SUPABASE_PUBLISHABLE_KEY.',
    };
  }

  return {
    url: url.replace(/\/+$/, ''),
    publishableKey: safeKey,
    isConfigured: true,
    configWarning: null,
  };
}

let authGetter: (() => User | null) | null = null;
let supabaseInstance: SupabaseClient | null = null;
let tokenObserverBound = false;
const roleClaimRefreshAttemptedByUid = new Map<string, number>();

/**
 * Obtém sempre um token Firebase JWT válido e atualizado sob demanda,
 * forçando renovação se estiver próximo de expirar ou se a claim role="authenticated"
 * acabou de ser atribuída pela Cloud Function no backend, sem armazenar tokens expirados.
 */
export async function getFreshFirebaseAccessToken(
  currentUser: User | null = authGetter ? authGetter() : null
): Promise<string | null> {
  if (!currentUser) return null;
  try {
    let token = await currentUser.getIdToken(false);
    let check = validateFirebaseJwtClaims(token, currentUser.uid);

    // Se o token expirou, está a menos de 60s de expirar, ou ainda não trouxe a claim role="authenticated"
    // (ex: recém-criado via trigger onCreate), força renovação com controle de frequência (30s por UID).
    const nowMs = Date.now();
    const lastRoleRefresh = roleClaimRefreshAttemptedByUid.get(currentUser.uid) || 0;
    const shouldForceRefreshForRole =
      !check.hasAuthenticatedRole && nowMs - lastRoleRefresh > 30_000;

    if (!check.valid || (check.expMs !== null && check.expMs - nowMs <= 60_000) || shouldForceRefreshForRole) {
      if (shouldForceRefreshForRole) {
        roleClaimRefreshAttemptedByUid.set(currentUser.uid, nowMs);
      }
      token = await currentUser.getIdToken(true);
      check = validateFirebaseJwtClaims(token, currentUser.uid);
    }

    if (!check.valid) {
      console.warn('[STF-Supabase] Token Firebase rejeitado na validação local:', check.reason);
      return null;
    }

    return token;
  } catch (err) {
    console.warn('[STF-Supabase] Falha transitória ao obter ID Token do Firebase:', err);
    return null;
  }
}

/**
 * Registra a instância do Firebase Auth para sincronizar a rotação automática de JWT
 * com o cliente Supabase PostgreSQL e Supabase Realtime.
 */
export function bindFirebaseAuthToSupabase(authObj: { currentUser: User | null }): void {
  authGetter = () => authObj.currentUser;

  const client = getSupabaseClient();
  if (!client || tokenObserverBound) return;

  try {
    tokenObserverBound = true;
    onIdTokenChanged(authObj as Parameters<typeof onIdTokenChanged>[0], async (user) => {
      if (!user) {
        client.realtime.setAuth('');
        return;
      }
      const freshToken = await getFreshFirebaseAccessToken(user);
      if (freshToken) {
        client.realtime.setAuth(freshToken);
      }
    });
  } catch {
    tokenObserverBound = false;
  }
}

export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseInstance) return supabaseInstance;

  const cfg = getSupabaseConfig();
  if (!cfg.isConfigured) return null;

  supabaseInstance = createClient(cfg.url, cfg.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    accessToken: async () => {
      return await getFreshFirebaseAccessToken();
    },
    realtime: {
      params: {
        eventsPerSecond: 20,
      },
    },
  });

  return supabaseInstance;
}
