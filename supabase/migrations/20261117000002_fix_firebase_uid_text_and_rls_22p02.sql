-- ============================================================================
-- SEM TERRA FC — CORREÇÃO DEFINITIVA DO ERRO POSTGRESQL 22P02 (FIREBASE UID TEXT vs UUID)
-- Projeto Supabase: https://etlvzqrfsvvpzltimxaj.supabase.co
-- Projeto Firebase Auth: gen-lang-client-0384619138
--
-- CAUSA RAIZ DO ERRO `22P02: invalid input syntax for type uuid: "v3xTyuRT7tTCAnFty1zlVYyM6Pl1"`:
-- 1. A função nativa `auth.uid()` do Supabase retorna o tipo `uuid`
--    (`CAST(current_setting('request.jwt.claims', true)::jsonb ->> 'sub' AS uuid)`).
--    Mesmo quando uma policy RLS ou função RPC escreve `auth.uid()::text`, o PostgreSQL
--    avalia `auth.uid()` PRIMEIRO, tentando converter o claim `sub` do Firebase Auth
--    (ex.: "v3xTyuRT7tTCAnFty1zlVYyM6Pl1", string de até 128 caracteres) para `uuid`
--    antes do cast para `text`, disparando imediatamente o erro 22P02.
-- 2. Variáveis locais ou parâmetros declarados como `uuid` em funções PL/pgSQL ou defaults
--    `DEFAULT auth.uid()` nas colunas de UID também disparam 22P02 ao receberem o UID Firebase.
--
-- O QUE ESTA MIGRATION FAZ (SEM APAGAR DADOS, SEM DROP TABLE E SEM REMOVER FKs DESNECESSARIAMENTE):
-- 1. Em `public.firebase_uid()`, valida obrigatoriamente:
--    - `iss = 'https://securetoken.google.com/gen-lang-client-0384619138'`
--    - `aud = 'gen-lang-client-0384619138'`
--    - `sub` não vazio (1 a 128 caracteres).
--    - Nunca utiliza `auth.uid()` nem converte Firebase UID para `UUID`.
-- 2. Verifica individualmente a existência de cada tabela, coluna e constraint antes de alterar:
--    - Garante que as 9 colunas de UID Firebase sejam `TEXT` (nunca `UUID`):
--      * public.users.uid (TEXT PK)
--      * public.friendships.user_id_1 e user_id_2 (TEXT FK -> users.uid)
--      * public.friend_requests.sender_id e receiver_id (TEXT FK -> users.uid)
--      * public.rooms.host_id (TEXT FK -> users.uid)
--      * public.room_participants.user_id (TEXT FK -> users.uid)
--      * public.presences.user_id (TEXT PK, FK -> users.uid)
--      * public.match_history.user_id (TEXT FK -> users.uid)
--    - Só remove/recria uma FK específica se aquela coluna específica não for `TEXT`.
-- 3. Preserva todos os UUIDs internos de registros:
--    - public.friendships.id (UUID)
--    - public.friend_requests.id (UUID)
--    - public.room_participants.id (UUID)
--    - public.matches.match_id (UUID)
--    - public.match_history.id e match_history.match_id (UUID)
-- 4. Aplica políticas RLS de privilégio mínimo (sem `USING (true)` irrestrito):
--    - Leitura direta de `users` e `presences` restrita ao próprio usuário autenticado;
--      demais leituras ocorrem de forma controlada pelas 14 RPCs `SECURITY DEFINER`.
--    - Respeita os status permitidos na constraint CHECK de `public.rooms`:
--      `'waiting'`, `'loading'`, `'playing'`, `'finished'` (sem usar `'starting'` na tabela `rooms`).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. FUNÇÕES DE IDENTIDADE FIREBASE JWT (100% TEXT — NUNCA CHAMA auth.uid())
-- ============================================================================
CREATE OR REPLACE FUNCTION public.firebase_jwt_claims()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw text;
BEGIN
  v_raw := nullif(btrim(current_setting('request.jwt.claims', true)), '');
  IF v_raw IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN v_raw::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN '{}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.firebase_uid()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claims jsonb;
  v_iss text;
  v_aud text;
  v_sub text;
BEGIN
  v_claims := public.firebase_jwt_claims();

  v_iss := btrim(COALESCE(v_claims ->> 'iss', ''));
  v_aud := btrim(COALESCE(v_claims ->> 'aud', ''));
  v_sub := nullif(btrim(COALESCE(v_claims ->> 'sub', v_claims ->> 'user_id', '')), '');

  -- 1. Validação obrigatória do emissor (iss) do projeto Firebase
  IF v_iss <> 'https://securetoken.google.com/gen-lang-client-0384619138' THEN
    RETURN NULL;
  END IF;

  -- 2. Validação obrigatória da audiência (aud) do projeto Firebase
  IF v_aud <> 'gen-lang-client-0384619138' THEN
    RETURN NULL;
  END IF;

  -- 3. Validação obrigatória de sub não vazio (UID Firebase TEXT de 1 a 128 caracteres)
  IF v_sub IS NULL OR char_length(v_sub) < 1 OR char_length(v_sub) > 128 THEN
    RETURN NULL;
  END IF;

  -- 4. Rejeita valores reservados de roles do Postgres/Supabase
  IF v_sub IN ('anon', 'service_role', 'authenticated') THEN
    RETURN NULL;
  END IF;

  RETURN v_sub;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_stf_tag_code(p_seed text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_clean text;
BEGIN
  v_clean := upper(regexp_replace(COALESCE(p_seed, ''), '[^a-zA-Z0-9]', '', 'g'));
  v_clean := rpad(substr(v_clean, 1, 4), 4, '9');
  RETURN '#STF' || v_clean;
END;
$$;

-- ============================================================================
-- 2. REMOÇÃO SEGURA DE POLICIES RLS LEGADAS (QUE PODEM CONTER auth.uid())
-- ============================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'users',
        'friendships',
        'friend_requests',
        'rooms',
        'room_participants',
        'presences',
        'matches',
        'match_history'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END;
$$;

-- ============================================================================
-- 3. VERIFICAÇÃO INDIVIDUAL E NÃO-DESTRUTIVA DE TABELAS, COLUNAS E FKs (TEXT)
--    - Não usa DROP TABLE nem apaga dados.
--    - Só remove/recria uma FK se a coluna específica precisar ser convertida para TEXT.
-- ============================================================================
DO $$
BEGIN
  -- 3.1. Remove DEFAULT (ex.: DEFAULT auth.uid()) apenas se a coluna existir e possuir default
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'uid' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.users ALTER COLUMN uid DROP DEFAULT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'friendships' AND column_name = 'user_id_1' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.friendships ALTER COLUMN user_id_1 DROP DEFAULT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'friendships' AND column_name = 'user_id_2' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.friendships ALTER COLUMN user_id_2 DROP DEFAULT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'friend_requests' AND column_name = 'sender_id' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.friend_requests ALTER COLUMN sender_id DROP DEFAULT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'friend_requests' AND column_name = 'receiver_id' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.friend_requests ALTER COLUMN receiver_id DROP DEFAULT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'host_id' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.rooms ALTER COLUMN host_id DROP DEFAULT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'room_participants' AND column_name = 'user_id' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.room_participants ALTER COLUMN user_id DROP DEFAULT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'presences' AND column_name = 'user_id' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.presences ALTER COLUMN user_id DROP DEFAULT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'match_history' AND column_name = 'user_id' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.match_history ALTER COLUMN user_id DROP DEFAULT;
  END IF;

  -- 3.2. Se public.users.uid não for TEXT, solta temporariamente apenas as FKs dependentes que existirem,
  --      converte public.users.uid para TEXT e converte as colunas filhas necessárias.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'uid' AND data_type <> 'text'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friendships' AND constraint_name = 'friendships_user_id_1_fkey') THEN
      ALTER TABLE public.friendships DROP CONSTRAINT friendships_user_id_1_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friendships' AND constraint_name = 'friendships_user_id_2_fkey') THEN
      ALTER TABLE public.friendships DROP CONSTRAINT friendships_user_id_2_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friend_requests' AND constraint_name = 'friend_requests_sender_id_fkey') THEN
      ALTER TABLE public.friend_requests DROP CONSTRAINT friend_requests_sender_id_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friend_requests' AND constraint_name = 'friend_requests_receiver_id_fkey') THEN
      ALTER TABLE public.friend_requests DROP CONSTRAINT friend_requests_receiver_id_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'rooms' AND constraint_name = 'rooms_host_id_fkey') THEN
      ALTER TABLE public.rooms DROP CONSTRAINT rooms_host_id_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'room_participants' AND constraint_name = 'room_participants_user_id_fkey') THEN
      ALTER TABLE public.room_participants DROP CONSTRAINT room_participants_user_id_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'presences' AND constraint_name = 'presences_user_id_fkey') THEN
      ALTER TABLE public.presences DROP CONSTRAINT presences_user_id_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'match_history' AND constraint_name = 'match_history_user_id_fkey') THEN
      ALTER TABLE public.match_history DROP CONSTRAINT match_history_user_id_fkey;
    END IF;

    ALTER TABLE public.users ALTER COLUMN uid TYPE text USING uid::text;
  END IF;

  -- 3.3. Verifica individualmente cada coluna filha de UID Firebase (só altera se data_type <> 'text')
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'friendships' AND column_name = 'user_id_1' AND data_type <> 'text'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friendships' AND constraint_name = 'friendships_user_id_1_fkey') THEN
      ALTER TABLE public.friendships DROP CONSTRAINT friendships_user_id_1_fkey;
    END IF;
    ALTER TABLE public.friendships ALTER COLUMN user_id_1 TYPE text USING user_id_1::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'friendships' AND column_name = 'user_id_2' AND data_type <> 'text'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friendships' AND constraint_name = 'friendships_user_id_2_fkey') THEN
      ALTER TABLE public.friendships DROP CONSTRAINT friendships_user_id_2_fkey;
    END IF;
    ALTER TABLE public.friendships ALTER COLUMN user_id_2 TYPE text USING user_id_2::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'friend_requests' AND column_name = 'sender_id' AND data_type <> 'text'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friend_requests' AND constraint_name = 'friend_requests_sender_id_fkey') THEN
      ALTER TABLE public.friend_requests DROP CONSTRAINT friend_requests_sender_id_fkey;
    END IF;
    ALTER TABLE public.friend_requests ALTER COLUMN sender_id TYPE text USING sender_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'friend_requests' AND column_name = 'receiver_id' AND data_type <> 'text'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friend_requests' AND constraint_name = 'friend_requests_receiver_id_fkey') THEN
      ALTER TABLE public.friend_requests DROP CONSTRAINT friend_requests_receiver_id_fkey;
    END IF;
    ALTER TABLE public.friend_requests ALTER COLUMN receiver_id TYPE text USING receiver_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'host_id' AND data_type <> 'text'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'rooms' AND constraint_name = 'rooms_host_id_fkey') THEN
      ALTER TABLE public.rooms DROP CONSTRAINT rooms_host_id_fkey;
    END IF;
    ALTER TABLE public.rooms ALTER COLUMN host_id TYPE text USING host_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'room_participants' AND column_name = 'user_id' AND data_type <> 'text'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'room_participants' AND constraint_name = 'room_participants_user_id_fkey') THEN
      ALTER TABLE public.room_participants DROP CONSTRAINT room_participants_user_id_fkey;
    END IF;
    ALTER TABLE public.room_participants ALTER COLUMN user_id TYPE text USING user_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'presences' AND column_name = 'user_id' AND data_type <> 'text'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'presences' AND constraint_name = 'presences_user_id_fkey') THEN
      ALTER TABLE public.presences DROP CONSTRAINT presences_user_id_fkey;
    END IF;
    ALTER TABLE public.presences ALTER COLUMN user_id TYPE text USING user_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'match_history' AND column_name = 'user_id' AND data_type <> 'text'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'match_history' AND constraint_name = 'match_history_user_id_fkey') THEN
      ALTER TABLE public.match_history DROP CONSTRAINT match_history_user_id_fkey;
    END IF;
    ALTER TABLE public.match_history ALTER COLUMN user_id TYPE text USING user_id::text;
  END IF;

  -- 3.4. Garante que as FKs para public.users(uid) existam caso tenham sido removidas durante conversão de tipo
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'friendships' AND column_name = 'user_id_1')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friendships' AND constraint_name = 'friendships_user_id_1_fkey') THEN
      ALTER TABLE public.friendships
        ADD CONSTRAINT friendships_user_id_1_fkey FOREIGN KEY (user_id_1) REFERENCES public.users(uid) ON DELETE CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'friendships' AND column_name = 'user_id_2')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friendships' AND constraint_name = 'friendships_user_id_2_fkey') THEN
      ALTER TABLE public.friendships
        ADD CONSTRAINT friendships_user_id_2_fkey FOREIGN KEY (user_id_2) REFERENCES public.users(uid) ON DELETE CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'friend_requests' AND column_name = 'sender_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friend_requests' AND constraint_name = 'friend_requests_sender_id_fkey') THEN
      ALTER TABLE public.friend_requests
        ADD CONSTRAINT friend_requests_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(uid) ON DELETE CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'friend_requests' AND column_name = 'receiver_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'friend_requests' AND constraint_name = 'friend_requests_receiver_id_fkey') THEN
      ALTER TABLE public.friend_requests
        ADD CONSTRAINT friend_requests_receiver_id_fkey FOREIGN KEY (receiver_id) REFERENCES public.users(uid) ON DELETE CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'host_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'rooms' AND constraint_name = 'rooms_host_id_fkey') THEN
      ALTER TABLE public.rooms
        ADD CONSTRAINT rooms_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.users(uid) ON DELETE CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'room_participants' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'room_participants' AND constraint_name = 'room_participants_user_id_fkey') THEN
      ALTER TABLE public.room_participants
        ADD CONSTRAINT room_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(uid) ON DELETE CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'presences' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'presences' AND constraint_name = 'presences_user_id_fkey') THEN
      ALTER TABLE public.presences
        ADD CONSTRAINT presences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(uid) ON DELETE CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'match_history' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND table_name = 'match_history' AND constraint_name = 'match_history_user_id_fkey') THEN
      ALTER TABLE public.match_history
        ADD CONSTRAINT match_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(uid) ON DELETE CASCADE;
    END IF;
  END IF;
END;
$$;

-- ============================================================================
-- 4. FUNÇÕES AUXILIARES DE AUTORIZAÇÃO RLS (SECURITY DEFINER — EVITAM RECURSÃO 42P17)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_room_member_or_host(p_room_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN public.firebase_uid() IS NULL OR p_room_code IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.room_participants rp
      WHERE rp.room_code = p_room_code
        AND rp.user_id = public.firebase_uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.rooms r
      WHERE r.room_code = p_room_code
        AND r.host_id = public.firebase_uid()
    )
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_public_active_room(p_room_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN public.firebase_uid() IS NULL OR p_room_code IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.rooms r
      WHERE r.room_code = p_room_code
        AND r.visibility = 'public'
        AND r.status IN ('waiting', 'loading', 'playing')
    )
  END;
$$;

-- ============================================================================
-- 5. POLÍTICAS RLS RESTRITAS (SEM LEITURA IRRESTRITA E SEM auth.uid())
-- ============================================================================

-- 5.1. public.users (uid TEXT) — Leitura e escrita direta apenas do próprio perfil
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

    CREATE POLICY users_select_own_policy ON public.users
      FOR SELECT TO anon, authenticated
      USING (public.firebase_uid() IS NOT NULL AND uid = public.firebase_uid());

    CREATE POLICY users_insert_own_policy ON public.users
      FOR INSERT TO anon, authenticated
      WITH CHECK (public.firebase_uid() IS NOT NULL AND uid = public.firebase_uid());

    CREATE POLICY users_update_own_policy ON public.users
      FOR UPDATE TO anon, authenticated
      USING (public.firebase_uid() IS NOT NULL AND uid = public.firebase_uid())
      WITH CHECK (public.firebase_uid() IS NOT NULL AND uid = public.firebase_uid());
  END IF;
END;
$$;

-- 5.2. public.presences (user_id TEXT) — Leitura e escrita direta apenas da própria presença
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'presences') THEN
    ALTER TABLE public.presences ENABLE ROW LEVEL SECURITY;

    CREATE POLICY presences_select_own_policy ON public.presences
      FOR SELECT TO anon, authenticated
      USING (public.firebase_uid() IS NOT NULL AND user_id = public.firebase_uid());

    CREATE POLICY presences_insert_own_policy ON public.presences
      FOR INSERT TO anon, authenticated
      WITH CHECK (public.firebase_uid() IS NOT NULL AND user_id = public.firebase_uid());

    CREATE POLICY presences_update_own_policy ON public.presences
      FOR UPDATE TO anon, authenticated
      USING (public.firebase_uid() IS NOT NULL AND user_id = public.firebase_uid())
      WITH CHECK (public.firebase_uid() IS NOT NULL AND user_id = public.firebase_uid());
  END IF;
END;
$$;

-- 5.3. public.friendships (id UUID, user_id_1 TEXT, user_id_2 TEXT)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'friendships') THEN
    ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

    CREATE POLICY friendships_select_participant_policy ON public.friendships
      FOR SELECT TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND (user_id_1 = public.firebase_uid() OR user_id_2 = public.firebase_uid())
      );

    CREATE POLICY friendships_insert_participant_policy ON public.friendships
      FOR INSERT TO anon, authenticated
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND (user_id_1 = public.firebase_uid() OR user_id_2 = public.firebase_uid())
      );

    CREATE POLICY friendships_delete_participant_policy ON public.friendships
      FOR DELETE TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND (user_id_1 = public.firebase_uid() OR user_id_2 = public.firebase_uid())
      );
  END IF;
END;
$$;

-- 5.4. public.friend_requests (id UUID, sender_id TEXT, receiver_id TEXT)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'friend_requests') THEN
    ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;

    CREATE POLICY friend_requests_select_involved_policy ON public.friend_requests
      FOR SELECT TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND (sender_id = public.firebase_uid() OR receiver_id = public.firebase_uid())
      );

    CREATE POLICY friend_requests_insert_sender_policy ON public.friend_requests
      FOR INSERT TO anon, authenticated
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND sender_id = public.firebase_uid()
      );

    CREATE POLICY friend_requests_update_involved_policy ON public.friend_requests
      FOR UPDATE TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND (receiver_id = public.firebase_uid() OR sender_id = public.firebase_uid())
      )
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND (receiver_id = public.firebase_uid() OR sender_id = public.firebase_uid())
      );

    CREATE POLICY friend_requests_delete_involved_policy ON public.friend_requests
      FOR DELETE TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND (receiver_id = public.firebase_uid() OR sender_id = public.firebase_uid())
      );
  END IF;
END;
$$;

-- 5.5. public.rooms (room_code TEXT, host_id TEXT, status IN ('waiting', 'loading', 'playing', 'finished'))
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'rooms') THEN
    ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

    CREATE POLICY rooms_select_authorized_policy ON public.rooms
      FOR SELECT TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND (
          (visibility = 'public' AND status IN ('waiting', 'loading', 'playing'))
          OR host_id = public.firebase_uid()
          OR public.is_room_member_or_host(room_code)
        )
      );

    CREATE POLICY rooms_insert_host_policy ON public.rooms
      FOR INSERT TO anon, authenticated
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND host_id = public.firebase_uid()
      );

    CREATE POLICY rooms_update_member_policy ON public.rooms
      FOR UPDATE TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND (
          host_id = public.firebase_uid()
          OR public.is_room_member_or_host(room_code)
        )
      )
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND (
          host_id = public.firebase_uid()
          OR public.is_room_member_or_host(room_code)
        )
      );

    CREATE POLICY rooms_delete_host_policy ON public.rooms
      FOR DELETE TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND host_id = public.firebase_uid()
      );
  END IF;
END;
$$;

-- 5.6. public.room_participants (id UUID, room_code TEXT, user_id TEXT)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'room_participants') THEN
    ALTER TABLE public.room_participants ENABLE ROW LEVEL SECURITY;

    CREATE POLICY room_participants_select_authorized_policy ON public.room_participants
      FOR SELECT TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND (
          user_id = public.firebase_uid()
          OR public.is_room_member_or_host(room_code)
          OR public.is_public_active_room(room_code)
        )
      );

    CREATE POLICY room_participants_insert_self_policy ON public.room_participants
      FOR INSERT TO anon, authenticated
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND user_id = public.firebase_uid()
      );

    CREATE POLICY room_participants_update_self_policy ON public.room_participants
      FOR UPDATE TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND user_id = public.firebase_uid()
      )
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND user_id = public.firebase_uid()
      );

    CREATE POLICY room_participants_delete_self_policy ON public.room_participants
      FOR DELETE TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND user_id = public.firebase_uid()
      );
  END IF;
END;
$$;

-- 5.7. public.matches (match_id UUID, room_code TEXT)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'matches') THEN
    ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;

    CREATE POLICY matches_select_room_member_policy ON public.matches
      FOR SELECT TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND public.is_room_member_or_host(room_code)
      );

    CREATE POLICY matches_insert_room_member_policy ON public.matches
      FOR INSERT TO anon, authenticated
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND public.is_room_member_or_host(room_code)
      );

    CREATE POLICY matches_update_room_member_policy ON public.matches
      FOR UPDATE TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND public.is_room_member_or_host(room_code)
      )
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND public.is_room_member_or_host(room_code)
      );
  END IF;
END;
$$;

-- 5.8. public.match_history (id UUID, match_id UUID, user_id TEXT)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'match_history') THEN
    ALTER TABLE public.match_history ENABLE ROW LEVEL SECURITY;

    CREATE POLICY match_history_select_own_policy ON public.match_history
      FOR SELECT TO anon, authenticated
      USING (
        public.firebase_uid() IS NOT NULL
        AND user_id = public.firebase_uid()
      );

    CREATE POLICY match_history_insert_own_policy ON public.match_history
      FOR INSERT TO anon, authenticated
      WITH CHECK (
        public.firebase_uid() IS NOT NULL
        AND user_id = public.firebase_uid()
      );
  END IF;
END;
$$;

-- ============================================================================
-- 6. RECRIAÇÃO DAS 14 RPCs SEM NENHUM CAST ::uuid PARA FIREBASE UID
--    E COMPATÍVEIS COM OS STATUS PERMITIDOS ('waiting', 'loading', 'playing', 'finished')
-- ============================================================================

DROP FUNCTION IF EXISTS public.rpc_ensure_user_profile_atomic(text);
DROP FUNCTION IF EXISTS public.rpc_create_room_atomic(text, text, text);
DROP FUNCTION IF EXISTS public.rpc_join_room_atomic(text, text);
DROP FUNCTION IF EXISTS public.rpc_leave_room_atomic(text);
DROP FUNCTION IF EXISTS public.rpc_select_character_atomic(text, text);
DROP FUNCTION IF EXISTS public.rpc_toggle_ready_atomic(text, boolean);
DROP FUNCTION IF EXISTS public.rpc_start_match_atomic(text);
DROP FUNCTION IF EXISTS public.rpc_send_friend_request(text);
DROP FUNCTION IF EXISTS public.rpc_respond_friend_request(uuid, boolean);
DROP FUNCTION IF EXISTS public.rpc_remove_friend(text);
DROP FUNCTION IF EXISTS public.rpc_get_public_lobby();
DROP FUNCTION IF EXISTS public.rpc_get_room_lobby(text);
DROP FUNCTION IF EXISTS public.rpc_get_my_friends();
DROP FUNCTION IF EXISTS public.rpc_get_friend_requests();

-- 6.1. rpc_ensure_user_profile_atomic(p_display_name text)
CREATE OR REPLACE FUNCTION public.rpc_ensure_user_profile_atomic(
  p_display_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_claims jsonb;
  v_clean_name text;
  v_avatar text;
  v_tag text;
  v_attempt int := 0;
  v_user public.users%ROWTYPE;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  v_claims := public.firebase_jwt_claims();
  v_avatar := nullif(btrim(COALESCE(v_claims ->> 'picture', '')), '');
  v_clean_name := left(COALESCE(nullif(btrim(p_display_name), ''), nullif(btrim(v_claims ->> 'name'), ''), 'Craque_' || upper(left(v_uid, 4))), 28);

  SELECT * INTO v_user
  FROM public.users
  WHERE uid = v_uid;

  IF NOT FOUND THEN
    v_tag := public.generate_stf_tag_code(v_uid);
    LOOP
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.users u WHERE u.tag_code = v_tag);
      v_attempt := v_attempt + 1;
      v_tag := '#STF' || upper(substr(md5(v_uid || '_' || v_attempt::text || '_' || clock_timestamp()::text), 1, 4));
      EXIT WHEN v_attempt > 10;
    END LOOP;

    INSERT INTO public.users (
      uid,
      display_name,
      tag_code,
      avatar_url,
      status,
      current_room_code,
      created_at,
      updated_at
    ) VALUES (
      v_uid,
      v_clean_name,
      v_tag,
      v_avatar,
      'online',
      NULL,
      now(),
      now()
    )
    RETURNING * INTO v_user;
  ELSE
    UPDATE public.users
    SET
      display_name = CASE
        WHEN nullif(btrim(p_display_name), '') IS NOT NULL THEN v_clean_name
        ELSE public.users.display_name
      END,
      avatar_url = COALESCE(v_avatar, public.users.avatar_url),
      status = CASE WHEN public.users.status = 'offline' THEN 'online' ELSE public.users.status END,
      updated_at = now()
    WHERE uid = v_uid
    RETURNING * INTO v_user;
  END IF;

  INSERT INTO public.presences (user_id, is_online, last_seen)
  VALUES (v_uid, true, now())
  ON CONFLICT (user_id) DO UPDATE
  SET is_online = true, last_seen = now();

  RETURN to_jsonb(v_user);
END;
$$;

-- 6.2. rpc_get_room_lobby(p_room_code text)
CREATE OR REPLACE FUNCTION public.rpc_get_room_lobby(
  p_room_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_code text;
  v_room public.rooms%ROWTYPE;
  v_host_name text;
  v_participants jsonb;
  v_match_id text;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  v_code := upper(btrim(COALESCE(p_room_code, '')));
  IF v_code = '' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = v_code;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT u.display_name INTO v_host_name
  FROM public.users u
  WHERE u.uid = v_room.host_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', rp.id,
        'room_code', rp.room_code,
        'user_id', rp.user_id,
        'uid', rp.user_id,
        'team', rp.team,
        'character_id', rp.character_id,
        'is_ready', rp.is_ready,
        'is_loading_ready', rp.is_loading_ready,
        'joined_at', rp.joined_at,
        'display_name', COALESCE(u.display_name, 'Craque_' || upper(left(rp.user_id, 4))),
        'tag_code', COALESCE(u.tag_code, public.generate_stf_tag_code(rp.user_id)),
        'avatar_url', u.avatar_url
      )
      ORDER BY rp.joined_at ASC
    ),
    '[]'::jsonb
  ) INTO v_participants
  FROM public.room_participants rp
  LEFT JOIN public.users u ON u.uid = rp.user_id
  WHERE rp.room_code = v_code;

  SELECT m.match_id::text INTO v_match_id
  FROM public.matches m
  WHERE m.room_code = v_code
  ORDER BY m.created_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'room_code', v_room.room_code,
    'host_id', v_room.host_id,
    'host_name', COALESCE(v_host_name, 'Anfitrião'),
    'room_name', v_room.room_name,
    'mode', v_room.mode,
    'visibility', v_room.visibility,
    'status', v_room.status,
    'max_players', v_room.max_players,
    'match_id', v_match_id,
    'created_at', v_room.created_at,
    'updated_at', v_room.updated_at,
    'participants', v_participants
  );
END;
$$;

-- 6.3. rpc_get_public_lobby()
CREATE OR REPLACE FUNCTION public.rpc_get_public_lobby()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_result jsonb;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(
    jsonb_agg(room_payload ORDER BY updated_at DESC),
    '[]'::jsonb
  ) INTO v_result
  FROM (
    SELECT
      r.updated_at,
      public.rpc_get_room_lobby(r.room_code) AS room_payload
    FROM public.rooms r
    WHERE r.visibility = 'public'
      AND r.status IN ('waiting', 'loading', 'playing')
      AND r.updated_at >= now() - interval '2 hours'
    ORDER BY r.updated_at DESC
    LIMIT 25
  ) sub
  WHERE room_payload IS NOT NULL;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- 6.4. rpc_create_room_atomic(p_room_name text, p_mode text, p_visibility text)
CREATE OR REPLACE FUNCTION public.rpc_create_room_atomic(
  p_room_name text,
  p_mode text,
  p_visibility text DEFAULT 'public'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_mode text;
  v_visibility text;
  v_max_players int;
  v_room_name text;
  v_code text;
  v_attempt int := 0;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_i int;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória para criar sala.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE uid = v_uid) THEN
    PERFORM public.rpc_ensure_user_profile_atomic(NULL);
  END IF;

  v_mode := CASE WHEN lower(btrim(COALESCE(p_mode, ''))) = '2v2' THEN '2v2' ELSE '4v4' END;
  v_visibility := CASE WHEN lower(btrim(COALESCE(p_visibility, ''))) = 'private' THEN 'private' ELSE 'public' END;
  v_max_players := CASE WHEN v_mode = '2v2' THEN 4 ELSE 8 END;
  v_room_name := left(COALESCE(nullif(btrim(p_room_name), ''), 'SEM TERRA FC — SALA'), 48);

  LOOP
    v_code := 'STF-';
    FOR v_i IN 1..4 LOOP
      v_code := v_code || substr(v_chars, floor(random() * length(v_chars) + 1)::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.rooms WHERE room_code = v_code);
    v_attempt := v_attempt + 1;
    IF v_attempt > 25 THEN
      RAISE EXCEPTION 'Não foi possível gerar um código único para a sala.';
    END IF;
  END LOOP;

  DELETE FROM public.room_participants WHERE user_id = v_uid;

  INSERT INTO public.rooms (
    room_code,
    host_id,
    room_name,
    mode,
    visibility,
    status,
    max_players,
    created_at,
    updated_at
  ) VALUES (
    v_code,
    v_uid,
    v_room_name,
    v_mode,
    v_visibility,
    'waiting',
    v_max_players,
    now(),
    now()
  );

  INSERT INTO public.room_participants (
    room_code,
    user_id,
    team,
    character_id,
    is_ready,
    is_loading_ready,
    joined_at
  ) VALUES (
    v_code,
    v_uid,
    'home',
    'home_1',
    true,
    false,
    now()
  );

  UPDATE public.users
  SET status = 'in_room', current_room_code = v_code, updated_at = now()
  WHERE uid = v_uid;

  RETURN public.rpc_get_room_lobby(v_code);
END;
$$;

-- 6.5. rpc_join_room_atomic(p_room_code text, p_team text DEFAULT NULL)
CREATE OR REPLACE FUNCTION public.rpc_join_room_atomic(
  p_room_code text,
  p_team text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_code text;
  v_room public.rooms%ROWTYPE;
  v_current_count int;
  v_home_count int;
  v_away_count int;
  v_team text;
  v_char_id text;
  v_candidate text;
  v_pool text[];
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória para entrar na sala.' USING ERRCODE = 'P0001';
  END IF;

  v_code := upper(btrim(COALESCE(p_room_code, '')));
  IF v_code = '' THEN
    RAISE EXCEPTION 'Código da sala inválido.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE uid = v_uid) THEN
    PERFORM public.rpc_ensure_user_profile_atomic(NULL);
  END IF;

  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = v_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sala % não encontrada ou já encerrada.', v_code;
  END IF;

  IF EXISTS (SELECT 1 FROM public.room_participants WHERE room_code = v_code AND user_id = v_uid) THEN
    UPDATE public.users
    SET status = 'in_room', current_room_code = v_code, updated_at = now()
    WHERE uid = v_uid;
    RETURN public.rpc_get_room_lobby(v_code);
  END IF;

  IF v_room.status <> 'waiting' THEN
    RAISE EXCEPTION 'A partida na sala % já foi iniciada ou encerrada.', v_code;
  END IF;

  SELECT count(*) INTO v_current_count
  FROM public.room_participants
  WHERE room_code = v_code;

  IF v_current_count >= COALESCE(v_room.max_players, 8) THEN
    RAISE EXCEPTION 'A sala % está lotada (%/%).', v_code, v_current_count, v_room.max_players;
  END IF;

  DELETE FROM public.room_participants WHERE user_id = v_uid AND room_code <> v_code;

  SELECT
    count(*) FILTER (WHERE team = 'home'),
    count(*) FILTER (WHERE team = 'away')
  INTO v_home_count, v_away_count
  FROM public.room_participants
  WHERE room_code = v_code;

  IF lower(COALESCE(p_team, '')) IN ('home', 'away') THEN
    v_team := lower(p_team);
  ELSIF v_home_count <= v_away_count THEN
    v_team := 'home';
  ELSE
    v_team := 'away';
  END IF;

  IF v_team = 'away' THEN
    v_pool := ARRAY['away_1', 'away_2', 'away_3', 'away_4', 'home_1', 'home_2', 'home_3', 'home_4'];
  ELSE
    v_pool := ARRAY['home_1', 'home_2', 'home_3', 'home_4', 'away_1', 'away_2', 'away_3', 'away_4'];
  END IF;

  v_char_id := NULL;
  FOREACH v_candidate IN ARRAY v_pool LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.room_participants
      WHERE room_code = v_code AND character_id = v_candidate
    ) THEN
      v_char_id := v_candidate;
      EXIT;
    END IF;
  END LOOP;

  IF v_char_id IS NULL THEN
    v_char_id := CASE WHEN v_team = 'away' THEN 'away_1' ELSE 'home_1' END;
  END IF;
  v_team := CASE WHEN v_char_id LIKE 'away%' THEN 'away' ELSE 'home' END;

  INSERT INTO public.room_participants (
    room_code,
    user_id,
    team,
    character_id,
    is_ready,
    is_loading_ready,
    joined_at
  ) VALUES (
    v_code,
    v_uid,
    v_team,
    v_char_id,
    false,
    false,
    now()
  );

  UPDATE public.rooms SET updated_at = now() WHERE room_code = v_code;
  UPDATE public.users SET status = 'in_room', current_room_code = v_code, updated_at = now() WHERE uid = v_uid;

  RETURN public.rpc_get_room_lobby(v_code);
END;
$$;

-- 6.6. rpc_leave_room_atomic(p_room_code text)
CREATE OR REPLACE FUNCTION public.rpc_leave_room_atomic(
  p_room_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_code text;
  v_room public.rooms%ROWTYPE;
  v_next_host text;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  v_code := upper(btrim(COALESCE(p_room_code, '')));
  IF v_code = '' THEN
    RETURN jsonb_build_object('ok', true);
  END IF;

  DELETE FROM public.room_participants
  WHERE room_code = v_code AND user_id = v_uid;

  UPDATE public.users
  SET status = 'online', current_room_code = NULL, updated_at = now()
  WHERE uid = v_uid AND current_room_code = v_code;

  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = v_code
  FOR UPDATE;

  IF FOUND THEN
    SELECT rp.user_id INTO v_next_host
    FROM public.room_participants rp
    WHERE rp.room_code = v_code
    ORDER BY rp.joined_at ASC
    LIMIT 1;

    IF v_next_host IS NULL THEN
      DELETE FROM public.rooms WHERE room_code = v_code;
    ELSIF v_room.host_id = v_uid THEN
      UPDATE public.rooms
      SET host_id = v_next_host, updated_at = now()
      WHERE room_code = v_code;
    ELSE
      UPDATE public.rooms
      SET updated_at = now()
      WHERE room_code = v_code;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'room_code', v_code);
END;
$$;

-- 6.7. rpc_select_character_atomic(p_room_code text, p_character_id text)
CREATE OR REPLACE FUNCTION public.rpc_select_character_atomic(
  p_room_code text,
  p_character_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_code text;
  v_char text;
  v_team text;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  v_code := upper(btrim(COALESCE(p_room_code, '')));
  v_char := lower(btrim(COALESCE(p_character_id, '')));

  IF v_code = '' OR v_char = '' THEN
    RAISE EXCEPTION 'Sala e personagem são obrigatórios.';
  END IF;

  v_char := CASE v_char
    WHEN 'yuri' THEN 'home_1'
    WHEN 'josue' THEN 'home_2'
    WHEN 'careca' THEN 'home_3'
    WHEN 'bode' THEN 'home_4'
    WHEN 'primo' THEN 'away_1'
    WHEN 'bicudo' THEN 'away_2'
    WHEN 'ismael' THEN 'away_3'
    WHEN 'felipe' THEN 'away_4'
    ELSE v_char
  END;

  IF EXISTS (
    SELECT 1 FROM public.room_participants
    WHERE room_code = v_code
      AND character_id = v_char
      AND user_id <> v_uid
  ) THEN
    RAISE EXCEPTION 'Este personagem já está ocupado por outro jogador na sala.';
  END IF;

  v_team := CASE WHEN v_char LIKE 'away%' THEN 'away' ELSE 'home' END;

  UPDATE public.room_participants
  SET character_id = v_char, team = v_team
  WHERE room_code = v_code AND user_id = v_uid;

  UPDATE public.rooms SET updated_at = now() WHERE room_code = v_code;

  RETURN public.rpc_get_room_lobby(v_code);
END;
$$;

-- 6.8. rpc_toggle_ready_atomic(p_room_code text, p_is_ready boolean)
CREATE OR REPLACE FUNCTION public.rpc_toggle_ready_atomic(
  p_room_code text,
  p_is_ready boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_code text;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  v_code := upper(btrim(COALESCE(p_room_code, '')));
  UPDATE public.room_participants
  SET is_ready = COALESCE(p_is_ready, true)
  WHERE room_code = v_code AND user_id = v_uid;

  UPDATE public.rooms SET updated_at = now() WHERE room_code = v_code;

  RETURN public.rpc_get_room_lobby(v_code);
END;
$$;

-- 6.9. rpc_start_match_atomic(p_room_code text)
-- Importante: Atualiza `public.rooms.status` para `'loading'` (compatível com o CHECK constraint
-- `'waiting', 'loading', 'playing', 'finished'`), nunca `'starting'`.
CREATE OR REPLACE FUNCTION public.rpc_start_match_atomic(
  p_room_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_code text;
  v_room public.rooms%ROWTYPE;
  v_match_id uuid;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  v_code := upper(btrim(COALESCE(p_room_code, '')));
  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = v_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sala % não encontrada.', v_code;
  END IF;

  IF v_room.host_id <> v_uid THEN
    RAISE EXCEPTION 'Apenas o anfitrião da sala pode iniciar a partida.';
  END IF;

  INSERT INTO public.matches (
    room_code,
    status,
    home_goals,
    away_goals,
    started_at,
    created_at
  ) VALUES (
    v_code,
    'playing',
    0,
    0,
    now(),
    now()
  )
  RETURNING match_id INTO v_match_id;

  UPDATE public.rooms
  SET status = 'loading', updated_at = now()
  WHERE room_code = v_code;

  UPDATE public.room_participants
  SET is_loading_ready = (user_id = v_uid)
  WHERE room_code = v_code;

  RETURN jsonb_build_object(
    'match_id', v_match_id::text,
    'room_code', v_code,
    'status', 'loading'
  );
END;
$$;

-- 6.10. rpc_send_friend_request(p_receiver_tag text)
CREATE OR REPLACE FUNCTION public.rpc_send_friend_request(
  p_receiver_tag text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_search text;
  v_target public.users%ROWTYPE;
  v_req_id uuid;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  v_search := upper(btrim(COALESCE(p_receiver_tag, '')));
  IF v_search = '' THEN
    RAISE EXCEPTION 'Informe a Tag (#STF...) do jogador.';
  END IF;
  IF left(v_search, 1) <> '#' THEN
    v_search := '#' || v_search;
  END IF;

  SELECT * INTO v_target
  FROM public.users
  WHERE upper(tag_code) = v_search
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nenhum jogador encontrado com a Tag %.', v_search;
  END IF;

  IF v_target.uid = v_uid THEN
    RAISE EXCEPTION 'Você não pode enviar solicitação de amizade para si mesmo.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.friendships
    WHERE (user_id_1 = v_uid AND user_id_2 = v_target.uid)
       OR (user_id_1 = v_target.uid AND user_id_2 = v_uid)
  ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'message', format('%s (%s) já está na sua lista de amigos!', v_target.display_name, v_target.tag_code)
    );
  END IF;

  SELECT id INTO v_req_id
  FROM public.friend_requests
  WHERE sender_id = v_uid
    AND receiver_id = v_target.uid
    AND status = 'pending'
  LIMIT 1;

  IF v_req_id IS NULL THEN
    INSERT INTO public.friend_requests (
      sender_id,
      receiver_id,
      status,
      created_at,
      updated_at
    ) VALUES (
      v_uid,
      v_target.uid,
      'pending',
      now(),
      now()
    )
    RETURNING id INTO v_req_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'request_id', v_req_id::text,
    'message', format('Solicitação de amizade enviada para %s (%s)!', v_target.display_name, v_target.tag_code)
  );
END;
$$;

-- 6.11. rpc_respond_friend_request(p_request_id uuid, p_accept boolean)
-- Nota: p_request_id é UUID (PK interna de public.friend_requests), enquanto sender_id e receiver_id são TEXT (UID Firebase).
CREATE OR REPLACE FUNCTION public.rpc_respond_friend_request(
  p_request_id uuid,
  p_accept boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_req public.friend_requests%ROWTYPE;
  v_u1 text;
  v_u2 text;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_req
  FROM public.friend_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitação de amizade não encontrada.';
  END IF;

  IF v_req.receiver_id <> v_uid THEN
    RAISE EXCEPTION 'Apenas o destinatário pode responder a esta solicitação.';
  END IF;

  IF COALESCE(p_accept, false) THEN
    UPDATE public.friend_requests
    SET status = 'accepted', updated_at = now()
    WHERE id = p_request_id;

    v_u1 := LEAST(v_req.sender_id, v_req.receiver_id);
    v_u2 := GREATEST(v_req.sender_id, v_req.receiver_id);

    IF NOT EXISTS (
      SELECT 1 FROM public.friendships
      WHERE (user_id_1 = v_u1 AND user_id_2 = v_u2)
         OR (user_id_1 = v_u2 AND user_id_2 = v_u1)
    ) THEN
      INSERT INTO public.friendships (user_id_1, user_id_2, created_at)
      VALUES (v_u1, v_u2, now());
    END IF;
  ELSE
    UPDATE public.friend_requests
    SET status = 'rejected', updated_at = now()
    WHERE id = p_request_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'request_id', p_request_id::text,
    'status', CASE WHEN COALESCE(p_accept, false) THEN 'accepted' ELSE 'rejected' END
  );
END;
$$;

-- 6.12. rpc_remove_friend(p_friend_tag text)
CREATE OR REPLACE FUNCTION public.rpc_remove_friend(
  p_friend_tag text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_tag text;
  v_friend_uid text;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação Firebase obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  v_tag := upper(btrim(COALESCE(p_friend_tag, '')));
  IF left(v_tag, 1) <> '#' THEN
    v_tag := '#' || v_tag;
  END IF;

  SELECT uid INTO v_friend_uid
  FROM public.users
  WHERE upper(tag_code) = v_tag
  LIMIT 1;

  IF v_friend_uid IS NOT NULL THEN
    DELETE FROM public.friendships
    WHERE (user_id_1 = v_uid AND user_id_2 = v_friend_uid)
       OR (user_id_1 = v_friend_uid AND user_id_2 = v_uid);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 6.13. rpc_get_my_friends()
CREATE OR REPLACE FUNCTION public.rpc_get_my_friends()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_result jsonb;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'uid', u.uid,
        'display_name', u.display_name,
        'tag_code', u.tag_code,
        'avatar_url', u.avatar_url,
        'status', COALESCE(u.status, 'online'),
        'current_room_code', u.current_room_code,
        'is_online', COALESCE(p.is_online, u.status <> 'offline'),
        'last_seen', COALESCE(p.last_seen, u.updated_at),
        'created_at', u.created_at,
        'updated_at', u.updated_at
      )
      ORDER BY u.display_name ASC
    ),
    '[]'::jsonb
  ) INTO v_result
  FROM public.friendships f
  JOIN public.users u
    ON u.uid = CASE WHEN f.user_id_1 = v_uid THEN f.user_id_2 ELSE f.user_id_1 END
  LEFT JOIN public.presences p
    ON p.user_id = u.uid
  WHERE f.user_id_1 = v_uid OR f.user_id_2 = v_uid;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- 6.14. rpc_get_friend_requests()
CREATE OR REPLACE FUNCTION public.rpc_get_friend_requests()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_result jsonb;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', fr.id::text,
        'sender_id', fr.sender_id,
        'receiver_id', fr.receiver_id,
        'sender_name', COALESCE(u.display_name, 'Craque_' || upper(left(fr.sender_id, 4))),
        'sender_tag', COALESCE(u.tag_code, public.generate_stf_tag_code(fr.sender_id)),
        'status', fr.status,
        'created_at', fr.created_at,
        'updated_at', fr.updated_at
      )
      ORDER BY fr.created_at DESC
    ),
    '[]'::jsonb
  ) INTO v_result
  FROM public.friend_requests fr
  LEFT JOIN public.users u ON u.uid = fr.sender_id
  WHERE fr.receiver_id = v_uid
    AND fr.status = 'pending';

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- ============================================================================
-- 7. PERMISSÕES DE EXECUÇÃO DAS FUNÇÕES E RPCs
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.firebase_jwt_claims() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.firebase_uid() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_stf_tag_code(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_member_or_host(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_public_active_room(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_ensure_user_profile_atomic(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_room_atomic(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_join_room_atomic(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_leave_room_atomic(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_select_character_atomic(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_toggle_ready_atomic(text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_start_match_atomic(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_send_friend_request(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_respond_friend_request(uuid, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_remove_friend(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_public_lobby() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_room_lobby(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_my_friends() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_friend_requests() TO anon, authenticated;

COMMIT;
