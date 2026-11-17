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

  // O banco Supabase foi configurado para validar os tokens Firebase Third-Party Auth com o papel anon.
  // Portanto, não exigimos role="authenticated" no frontend (a menos que requireAuthenticatedRole=true seja solicitado em testes).
  const needsRefresh =
    expMs - nowMs <= refreshThresholdMs || (requireAuthenticatedRole && !hasAuthenticatedRole);
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

export const DEFAULT_SUPABASE_URL = 'https://etlvzqrfsvvpzltimxaj.supabase.co';

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

export function getSupabaseConfig(): {
  url: string;
  publishableKey: string;
  isConfigured: boolean;
  useServerProxy: boolean;
  configWarning: string | null;
} {
  const url =
    readEnvVar('VITE_SUPABASE_URL') ||
    readEnvVar('VITE_PUBLIC_SUPABASE_URL') ||
    DEFAULT_SUPABASE_URL;

  const candidateKeys = [
    readEnvVar('VITE_SUPABASE_PUBLISHABLE_KEY'),
    readEnvVar('VITE_SUPABASE_ANON_KEY'),
    readEnvVar('VITE_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    readEnvVar('VITE_PUBLIC_SUPABASE_ANON_KEY'),
  ].filter(Boolean);

  const safeKey = candidateKeys.find((candidate) => isSafePublishableKey(candidate));

  if (safeKey) {
    const isGatewayProxy = safeKey === 'sb_gateway_proxy';
    return {
      url: url.replace(/\/+$/, ''),
      publishableKey: safeKey,
      isConfigured: true,
      useServerProxy: isGatewayProxy,
      configWarning: null,
    };
  }

  // No ambiente full-stack (Express + Vite), caso a chave pública ainda não esteja no bundle do navegador,
  // roteia as chamadas REST pelo proxy seguro /api/supabase preservando o Authorization: Bearer <firebase_id_token>.
  if (typeof window !== 'undefined') {
    return {
      url: url.replace(/\/+$/, ''),
      publishableKey: 'sb_gateway_proxy',
      isConfigured: true,
      useServerProxy: true,
      configWarning: null,
    };
  }

  return {
    url: url.replace(/\/+$/, ''),
    publishableKey: '',
    isConfigured: false,
    useServerProxy: false,
    configWarning:
      'VITE_SUPABASE_PUBLISHABLE_KEY ainda não configurada no ambiente.',
  };
}

let authGetter: (() => User | null) | null = null;
let supabaseInstance: SupabaseClient | null = null;
let tokenObserverBound = false;

/**
 * Obtém sempre um token Firebase JWT válido e atualizado sob demanda,
 * forçando renovação se estiver próximo de expirar, sem exigir role="authenticated" no frontend.
 */
export async function getFreshFirebaseAccessToken(
  currentUser: User | null = authGetter ? authGetter() : null,
  forceRefresh: boolean = false
): Promise<string | null> {
  if (!currentUser) return null;
  try {
    let token = await currentUser.getIdToken(forceRefresh);
    let check = validateFirebaseJwtClaims(token, currentUser.uid);

    const nowMs = Date.now();
    if (!forceRefresh && (!check.valid || (check.expMs !== null && check.expMs - nowMs <= 60_000))) {
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

export function getCurrentFirebaseUid(): string | null {
  const user = authGetter ? authGetter() : null;
  const uid = user?.uid?.trim() || null;
  return uid && uid.length <= 128 ? uid : null;
}

export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseInstance) return supabaseInstance;

  const cfg = getSupabaseConfig();
  if (!cfg.isConfigured) return null;

  const customFetch: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

    const headers = new Headers(init?.headers || {});
    const token = await getFreshFirebaseAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const targetInput =
      cfg.useServerProxy && typeof window !== 'undefined' && rawUrl.startsWith(cfg.url)
        ? `${window.location.origin}/api/supabase${rawUrl.slice(cfg.url.length)}`
        : input;

    const res = await fetch(targetInput, {
      ...init,
      headers,
    });

    // Se uma tabela no banco ainda tiver uma policy RLS legada chamando `auth.uid()` (que tenta fazer cast
    // do UID TEXT do Firebase para UUID e gera erro PostgreSQL 22P02), repete a operação de tabela sem o sub no header.
    if (res.status === 400 && token && !rawUrl.includes('/rpc/')) {
      try {
        const bodyText = await res.clone().text();
        if (bodyText.includes('22P02')) {
          const fallbackHeaders = new Headers(init?.headers || {});
          if (cfg.publishableKey && cfg.publishableKey !== 'sb_gateway_proxy') {
            fallbackHeaders.set('Authorization', `Bearer ${cfg.publishableKey}`);
          } else {
            fallbackHeaders.delete('Authorization');
          }
          return await fetch(targetInput, {
            ...init,
            headers: fallbackHeaders,
          });
        }
      } catch {
        // Retorna resposta original se não for possível inspecionar
      }
    }

    return res;
  };

  supabaseInstance = createClient(cfg.url, cfg.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    accessToken: async () => {
      return await getFreshFirebaseAccessToken();
    },
    global: {
      fetch: customFetch,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });

  return supabaseInstance;
}

