/**
 * ============================================================================
 * FIREBASE CLOUD FUNCTIONS — INTEGRAÇÃO SUPABASE THIRD-PARTY AUTH
 * Projeto Firebase: gen-lang-client-0384619138 (SEM TERRA FC)
 * Referência oficial: https://supabase.com/docs/guides/auth/third-party/firebase-auth
 *
 * IMPORTANTE:
 * Este arquivo roda EXCLUSIVAMENTE no ambiente serverless do Firebase Cloud Functions
 * (Node.js Admin). NUNCA importe firebase-admin no frontend React.
 * ============================================================================
 */

import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v1';
import { beforeUserCreated, beforeUserSignedIn, HttpsError, onCall } from 'firebase-functions/v2/identity';

if (admin.apps.length === 0) {
  admin.initializeApp();
}

/**
 * 1. BLOCKING FUNCTION (Recomendado quando Identity Platform está ativo no Firebase):
 * Injeta sincronamente a claim { role: 'authenticated' } antes mesmo do primeiro
 * token JWT ser emitido no login Google ou login Anônimo.
 */
export const injectSupabaseRoleBeforeCreate = beforeUserCreated(() => {
  return {
    customClaims: {
      role: 'authenticated',
    },
  };
});

export const injectSupabaseRoleBeforeSignIn = beforeUserSignedIn((event) => {
  const existingClaims = event.data?.customClaims || {};
  if (existingClaims.role === 'authenticated') {
    return {};
  }
  return {
    customClaims: {
      ...existingClaims,
      role: 'authenticated',
    },
  };
});

/**
 * 2. TRIGGER ON-CREATE (Compatível com o plano padrão do Firebase Authentication):
 * Atribui { role: 'authenticated' } assim que qualquer conta Google ou Anônima é criada.
 */
export const processSignUpSetSupabaseRole = functions.auth.user().onCreate(async (user) => {
  const currentClaims = user.customClaims || {};
  if (currentClaims.role === 'authenticated') {
    return;
  }

  await admin.auth().setCustomUserClaims(user.uid, {
    ...currentClaims,
    role: 'authenticated',
  });
});

/**
 * 3. FUNÇÃO CALLABLE PARA CONTAS EXISTENTES E VINCULAÇÃO ANÔNIMO -> GOOGLE:
 * Permite que um usuário já logado solicite a aplicação imediata da claim
 * { role: 'authenticated' } no seu próprio UID autenticado e em seguida chame
 * user.getIdToken(true) no navegador.
 */
export const ensureSupabaseAuthenticatedRole = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'O usuário precisa estar autenticado no Firebase.');
  }

  const userRecord = await admin.auth().getUser(uid);
  const existingClaims = userRecord.customClaims || {};

  if (existingClaims.role !== 'authenticated') {
    await admin.auth().setCustomUserClaims(uid, {
      ...existingClaims,
      role: 'authenticated',
    });
  }

  return {
    ok: true,
    uid,
    role: 'authenticated',
  };
});
