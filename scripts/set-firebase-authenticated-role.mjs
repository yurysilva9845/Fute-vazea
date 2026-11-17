#!/usr/bin/env node
/**
 * ============================================================================
 * SCRIPT ADMINISTRATIVO DE MIGRAÇÃO — FIREBASE AUTH -> SUPABASE ROLE
 * Projeto Firebase: gen-lang-client-0384619138 (SEM TERRA FC)
 *
 * Objetivo:
 * Atribuir a custom claim { role: "authenticated" } para TODOS os usuários
 * existentes (contas Google e contas Anônimas) no Firebase Authentication,
 * preservando 100% dos UIDs e claims existentes.
 *
 * Como executar com segurança (APENAS em ambiente local seguro ou CI/CD):
 *   GOOGLE_APPLICATION_CREDENTIALS="./service-account.json" \
 *   node scripts/set-firebase-authenticated-role.mjs
 *
 * NUNCA comite o arquivo service-account.json no repositório ou no frontend.
 * ============================================================================
 */

import process from 'node:process';

async function main() {
  let admin;
  try {
    const mod = await import('firebase-admin');
    admin = mod.default || mod;
  } catch {
    console.error(
      'Erro: pacote "firebase-admin" não encontrado. Execute: npm install --no-save firebase-admin'
    );
    process.exit(1);
  }

  if (!admin.apps || admin.apps.length === 0) {
    admin.initializeApp({
      projectId: 'gen-lang-client-0384619138',
    });
  }

  const auth = admin.auth();
  let nextPageToken = undefined;
  let totalProcessed = 0;
  let totalUpdated = 0;

  console.log('[STF-Admin] Iniciando verificação de usuários no projeto gen-lang-client-0384619138...');

  do {
    const listResult = await auth.listUsers(1000, nextPageToken);
    for (const userRecord of listResult.users) {
      totalProcessed += 1;
      const currentClaims = userRecord.customClaims || {};

      if (currentClaims.role !== 'authenticated') {
        await auth.setCustomUserClaims(userRecord.uid, {
          ...currentClaims,
          role: 'authenticated',
        });
        totalUpdated += 1;
        console.log(
          `[STF-Admin] Claim { role: "authenticated" } aplicada ao UID: ${userRecord.uid}`
        );
      }
    }
    nextPageToken = listResult.pageToken;
  } while (nextPageToken);

  console.log(
    `[STF-Admin] Concluído! Usuários verificados: ${totalProcessed} | Atualizados: ${totalUpdated}`
  );
}

main().catch((err) => {
  console.error('[STF-Admin] Falha ao atualizar custom claims:', err);
  process.exit(1);
});
