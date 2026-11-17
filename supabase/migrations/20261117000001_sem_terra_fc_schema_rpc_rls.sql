-- ============================================================================
-- MIGRATION: 20261117000001_sem_terra_fc_schema_rpc_rls.sql
-- PROJETO: SEM TERRA FC — FUTEBOL DE VÁRZEA 4x4
-- ARQUITETURA:
--   - Autenticação: Firebase Authentication (Google & Anônimo) via Supabase Third-Party Auth
--   - Project ID Firebase: gen-lang-client-0384619138
--   - Autorização: Exclusivamente via JWT validado (role = 'authenticated', sub = UID)
--   - Zero confiança em UIDs, hashes de senha ou estatísticas enviados pelo cliente
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. AUTENTICAÇÃO E IDENTIDADE ESTRITA (ZERO FALLBACK PARA p_uid)
-- ============================================================================

/**
 * Extrai o objeto JSONB de claims do JWT validado pelo Supabase Third-Party Auth.
 * Nunca aceita parâmetros do cliente.
 */
CREATE OR REPLACE FUNCTION public.firebase_jwt_claims()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

/**
 * Retorna a role efetiva do token JWT validado pelo Supabase ('authenticated' exigido).
 */
CREATE OR REPLACE FUNCTION public.firebase_jwt_role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    public.firebase_jwt_claims() ->> 'role',
    auth.role()
  );
$$;

/**
 * Extrai e valida estritamente o UID ('sub') do Firebase Authentication a partir do JWT.
 * Requisitos obrigatórios:
 *   1. Claims presentes na sessão PostgREST.
 *   2. Claim role = 'authenticated'.
 *   3. Emissor (iss) = 'https://securetoken.google.com/gen-lang-client-0384619138'.
 *   4. Audiência (aud) = 'gen-lang-client-0384619138'.
 *   5. Identidade (sub) não vazia.
 * Se qualquer requisito falhar, retorna NULL. NUNCA utiliza p_uid como fallback.
 */
CREATE OR REPLACE FUNCTION public.firebase_uid()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_claims jsonb;
  v_role text;
  v_iss text;
  v_aud text;
  v_sub text;
BEGIN
  v_claims := public.firebase_jwt_claims();
  IF v_claims = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  v_role := COALESCE(public.firebase_jwt_role(), '');
  IF v_role <> 'authenticated' THEN
    RETURN NULL;
  END IF;

  v_iss := COALESCE(v_claims ->> 'iss', '');
  v_aud := COALESCE(v_claims ->> 'aud', '');
  v_sub := btrim(COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    v_claims ->> 'sub',
    ''
  ));

  IF v_iss <> 'https://securetoken.google.com/gen-lang-client-0384619138' THEN
    RETURN NULL;
  END IF;

  IF v_aud <> 'gen-lang-client-0384619138' THEN
    RETURN NULL;
  END IF;

  IF v_sub = '' THEN
    RETURN NULL;
  END IF;

  RETURN v_sub;
END;
$$;

/**
 * Retorna true somente quando a requisição possui um JWT Firebase válido
 * com role = 'authenticated' e UID identificado.
 */
CREATE OR REPLACE FUNCTION public.is_firebase_authenticated()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.firebase_uid() IS NOT NULL;
$$;

/**
 * Exige que o chamador esteja autenticado com token válido e, caso p_client_uid
 * seja informado para compatibilidade de assinatura, exige igualdade estrita com o JWT.
 */
CREATE OR REPLACE FUNCTION public.require_authenticated_uid(
  p_client_uid text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_uid text;
BEGIN
  v_uid := public.firebase_uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Token JWT ausente, expirado ou sem role authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_client_uid IS NOT NULL AND btrim(p_client_uid) <> '' AND btrim(p_client_uid) <> v_uid THEN
    RAISE EXCEPTION 'UID_SPOOFING_REJECTED: O UID enviado pelo cliente (%) não corresponde à identidade autenticada no JWT (%).',
      p_client_uid, v_uid
      USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;

-- ============================================================================
-- 2. TABELAS PRINCIPAIS E ÍNDICES
-- ============================================================================

-- 2.1. Perfis de Usuários e Estatísticas (UID preservado do Firebase Auth)
CREATE TABLE IF NOT EXISTS public.users (
  uid text PRIMARY KEY CHECK (char_length(btrim(uid)) BETWEEN 4 AND 128),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 28),
  display_name_lower text GENERATED ALWAYS AS (lower(display_name)) STORED,
  tag_code text NOT NULL CHECK (char_length(btrim(tag_code)) BETWEEN 2 AND 20),
  status text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'in_room', 'playing', 'offline')),
  current_room_code text NOT NULL DEFAULT '' CHECK (char_length(current_room_code) <= 16),
  friends text[] NOT NULL DEFAULT '{}',
  wins integer NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses integer NOT NULL DEFAULT 0 CHECK (losses >= 0),
  draws integer NOT NULL DEFAULT 0 CHECK (draws >= 0),
  goals_scored integer NOT NULL DEFAULT 0 CHECK (goals_scored >= 0),
  goals_conceded integer NOT NULL DEFAULT 0 CHECK (goals_conceded >= 0),
  matches_played integer NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  migrated_from_firestore boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_tag_code_upper ON public.users (upper(tag_code));
CREATE INDEX IF NOT EXISTS idx_users_display_name_lower ON public.users (display_name_lower text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_users_updated_at ON public.users (updated_at DESC);

-- 2.2. Tabela relacional de amizades confirmadas (bidirecional)
CREATE TABLE IF NOT EXISTS public.friendships (
  user_uid text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  friend_uid text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_uid, friend_uid),
  CONSTRAINT friendships_no_self CHECK (user_uid <> friend_uid)
);

CREATE INDEX IF NOT EXISTS idx_friendships_friend_uid ON public.friendships (friend_uid);

-- 2.3. Solicitações de amizade e convites de sala
CREATE TABLE IF NOT EXISTS public.friend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_uid text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  from_name text NOT NULL CHECK (char_length(btrim(from_name)) BETWEEN 1 AND 28),
  from_tag text NOT NULL DEFAULT '#STF0000' CHECK (char_length(from_tag) <= 20),
  to_uid text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  to_name text NOT NULL CHECK (char_length(btrim(to_name)) BETWEEN 1 AND 28),
  type text NOT NULL CHECK (type IN ('friend_request', 'room_invite')),
  room_code text NOT NULL DEFAULT '' CHECK (char_length(room_code) <= 16),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT friend_requests_no_self CHECK (from_uid <> to_uid)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_to_uid_pending
  ON public.friend_requests (to_uid, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_friend_requests_from_uid
  ON public.friend_requests (from_uid);

-- 2.4. Salas Multiplayer (2v2 e 4v4, Públicas e Privadas)
CREATE TABLE IF NOT EXISTS public.rooms (
  room_code text PRIMARY KEY CHECK (char_length(room_code) BETWEEN 4 AND 16),
  match_id text,
  room_name text NOT NULL CHECK (char_length(btrim(room_name)) BETWEEN 1 AND 60),
  mode text NOT NULL DEFAULT '4v4' CHECK (mode IN ('2v2', '4v4')),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  has_password boolean NOT NULL DEFAULT false,
  password_hash text, -- Protegido com bcrypt (crypt/bf) e ocultado de SELECT direto
  max_humans smallint NOT NULL DEFAULT 8 CHECK (max_humans BETWEEN 1 AND 8),
  auto_fill_bots boolean NOT NULL DEFAULT true,
  active_character_ids text[] NOT NULL DEFAULT '{}',
  loading_ready_uids text[] NOT NULL DEFAULT '{}',
  start_at bigint,
  last_activity_ms bigint NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::bigint,
  host_uid text NOT NULL REFERENCES public.users(uid),
  host_name text NOT NULL CHECK (char_length(btrim(host_name)) BETWEEN 1 AND 28),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'starting', 'playing', 'finished')),
  home_team_id text NOT NULL DEFAULT 'unidos_do_barro',
  away_team_id text NOT NULL DEFAULT 'rubro_negro_beco',
  home_goals smallint NOT NULL DEFAULT 0 CHECK (home_goals BETWEEN 0 AND 99),
  away_goals smallint NOT NULL DEFAULT 0 CHECK (away_goals BETWEEN 0 AND 99),
  half smallint NOT NULL DEFAULT 1 CHECK (half IN (1, 2)),
  remaining_seconds integer NOT NULL DEFAULT 150 CHECK (remaining_seconds BETWEEN 0 AND 3600),
  slots jsonb NOT NULL DEFAULT '{}'::jsonb,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  match_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rooms_lobby_active
  ON public.rooms (visibility, status, last_activity_ms DESC);

-- 2.5. Sessões de Partidas Ativas
CREATE TABLE IF NOT EXISTS public.matches (
  match_id text PRIMARY KEY CHECK (char_length(match_id) BETWEEN 4 AND 32),
  room_id text NOT NULL REFERENCES public.rooms(room_code) ON DELETE CASCADE,
  host_id text NOT NULL REFERENCES public.users(uid),
  mode text NOT NULL DEFAULT '4v4' CHECK (mode IN ('2v2', '4v4')),
  status text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'playing', 'finished')),
  players text[] NOT NULL DEFAULT '{}',
  bots text[] NOT NULL DEFAULT '{}',
  score jsonb NOT NULL DEFAULT '{"teamA": 0, "teamB": 0}'::jsonb,
  ball jsonb NOT NULL DEFAULT '{"x": 0, "y": 0.22, "z": 0}'::jsonb,
  start_at bigint NOT NULL,
  finished_at bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_matches_room_id ON public.matches (room_id);

-- 2.6. Histórico de Partidas Concluídas (1 registro imutável por match_id)
CREATE TABLE IF NOT EXISTS public.match_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id text UNIQUE,
  room_code text NOT NULL,
  host_uid text NOT NULL REFERENCES public.users(uid),
  home_team_name text NOT NULL,
  away_team_name text NOT NULL,
  home_goals smallint NOT NULL CHECK (home_goals BETWEEN 0 AND 99),
  away_goals smallint NOT NULL CHECK (away_goals BETWEEN 0 AND 99),
  winner text NOT NULL CHECK (winner IN ('home', 'away', 'draw')),
  participant_uids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_match_history_created_at
  ON public.match_history (created_at DESC);

-- ============================================================================
-- 3. PROTEÇÃO DE COLUNAS COMPETITIVAS E INFORMAÇÕES PRIVADAS
-- ============================================================================

/**
 * Trigger que impede qualquer cliente de alterar diretamente suas próprias estatísticas
 * competitivas (wins, losses, draws, goals_scored, goals_conceded, matches_played),
 * lista de amigos (friends) ou identidade (uid, tag_code) fora das funções RPC de servidor.
 */
CREATE OR REPLACE FUNCTION public.trg_enforce_users_security()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trusted_rpc boolean;
BEGIN
  v_trusted_rpc := COALESCE(current_setting('app.trusted_rpc', true), '') = 'true';

  IF TG_OP = 'INSERT' THEN
    IF NOT v_trusted_rpc THEN
      -- Na criação direta pelo cliente, estatísticas e amigos começam obrigatoriamente zerados
      NEW.wins := 0;
      NEW.losses := 0;
      NEW.draws := 0;
      NEW.goals_scored := 0;
      NEW.goals_conceded := 0;
      NEW.matches_played := 0;
      NEW.friends := '{}';
      NEW.migrated_from_firestore := false;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.uid <> OLD.uid THEN
      RAISE EXCEPTION 'FORBIDDEN: Não é permitido alterar o UID do perfil.'
        USING ERRCODE = '42501';
    END IF;

    IF NOT v_trusted_rpc THEN
      IF NEW.wins <> OLD.wins
         OR NEW.losses <> OLD.losses
         OR NEW.draws <> OLD.draws
         OR NEW.goals_scored <> OLD.goals_scored
         OR NEW.goals_conceded <> OLD.goals_conceded
         OR NEW.matches_played <> OLD.matches_played THEN
        RAISE EXCEPTION 'STATS_TAMPERING_BLOCKED: Estatísticas competitivas só podem ser atualizadas pelo servidor ao concluir uma partida válida.'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.friends <> OLD.friends THEN
        RAISE EXCEPTION 'FRIENDS_TAMPERING_BLOCKED: A lista de amigos só pode ser modificada pelas funções oficiais de amizade.'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.migrated_from_firestore <> OLD.migrated_from_firestore THEN
        RAISE EXCEPTION 'FORBIDDEN: Flag de migração controlada pelo servidor.'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_security ON public.users;
CREATE TRIGGER trg_users_security
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_users_security();

/**
 * Trigger que impede adulteração dos campos imutáveis de solicitações de amizade.
 * Somente o destinatário (to_uid) pode atualizar o status para accepted/declined.
 */
CREATE OR REPLACE FUNCTION public.trg_enforce_friend_requests_security()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_trusted_rpc boolean;
BEGIN
  v_trusted_rpc := COALESCE(current_setting('app.trusted_rpc', true), '') = 'true';
  v_uid := public.firebase_uid();

  IF TG_OP = 'UPDATE' THEN
    IF NEW.from_uid <> OLD.from_uid
       OR NEW.to_uid <> OLD.to_uid
       OR NEW.type <> OLD.type
       OR NEW.room_code <> OLD.room_code THEN
      RAISE EXCEPTION 'FORBIDDEN: Não é permitido alterar remetente, destinatário ou tipo da solicitação.'
        USING ERRCODE = '42501';
    END IF;

    IF NOT v_trusted_rpc AND (v_uid IS NULL OR v_uid <> OLD.to_uid) THEN
      RAISE EXCEPTION 'FORBIDDEN: Somente o destinatário pode aceitar ou recusar esta solicitação.'
        USING ERRCODE = '42501';
    END IF;

    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_friend_requests_security ON public.friend_requests;
CREATE TRIGGER trg_friend_requests_security
  BEFORE UPDATE ON public.friend_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_friend_requests_security();

/**
 * Verifica se um UID autenticado pertence aos slots humanos ou é anfitrião de uma sala.
 */
CREATE OR REPLACE FUNCTION public.is_room_participant(
  p_slots jsonb,
  p_host_uid text,
  p_uid text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_val jsonb;
BEGIN
  IF p_uid IS NULL OR btrim(p_uid) = '' THEN
    RETURN false;
  END IF;
  IF p_host_uid = p_uid THEN
    RETURN true;
  END IF;

  FOR v_key, v_val IN SELECT * FROM jsonb_each(COALESCE(p_slots, '{}'::jsonb))
  LOOP
    IF COALESCE(v_val ->> 'uid', '') = p_uid THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$$;

/**
 * Sanitiza um registro de public.rooms removendo password_hash, inputs e match_snapshot
 * antes de retorná-lo ao cliente.
 */
CREATE OR REPLACE FUNCTION public.sanitize_room_record(p_room public.rooms)
RETURNS public.rooms
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_room IS NULL THEN
    RETURN NULL;
  END IF;
  p_room.password_hash := NULL;
  p_room.inputs := '{}'::jsonb;
  p_room.match_snapshot := NULL;
  RETURN p_room;
END;
$$;

/**
 * View pública segura para listagem de salas no Lobby (NUNCA expõe password_hash, inputs ou match_snapshot).
 */
CREATE OR REPLACE VIEW public.public_rooms_lobby_view
WITH (security_invoker = true)
AS
  SELECT
    room_code,
    match_id,
    room_name,
    mode,
    visibility,
    has_password,
    NULL::text AS password_hash,
    max_humans,
    auto_fill_bots,
    active_character_ids,
    loading_ready_uids,
    start_at,
    last_activity_ms,
    host_uid,
    host_name,
    status,
    home_team_id,
    away_team_id,
    home_goals,
    away_goals,
    half,
    remaining_seconds,
    slots,
    created_at,
    updated_at
  FROM public.rooms
  WHERE visibility = 'public'
    AND status <> 'finished';

-- Permissões por coluna em public.rooms: revoga leitura de password_hash, inputs e match_snapshot
REVOKE ALL ON public.rooms FROM PUBLIC, anon;
REVOKE SELECT (password_hash, inputs, match_snapshot) ON public.rooms FROM authenticated;
GRANT SELECT (
  room_code,
  match_id,
  room_name,
  mode,
  visibility,
  has_password,
  max_humans,
  auto_fill_bots,
  active_character_ids,
  loading_ready_uids,
  start_at,
  last_activity_ms,
  host_uid,
  host_name,
  status,
  home_team_id,
  away_team_id,
  home_goals,
  away_goals,
  half,
  remaining_seconds,
  slots,
  created_at,
  updated_at
) ON public.rooms TO authenticated;

GRANT SELECT ON public.public_rooms_lobby_view TO authenticated;

-- ============================================================================
-- 4. FUNÇÕES RPC ATÔMICAS E SEGURAS (SECURITY DEFINER + FOR UPDATE)
-- ============================================================================

/**
 * 4.0. Sincronização de Perfil e Migração Controlada Única (rpc_ensure_user_profile_atomic)
 * Usa exclusivamente public.require_authenticated_uid().
 */
CREATE OR REPLACE FUNCTION public.rpc_ensure_user_profile_atomic(
  p_uid text DEFAULT NULL,
  p_display_name text DEFAULT 'Jogador',
  p_tag_code text DEFAULT '#STF0000',
  p_legacy_wins integer DEFAULT 0,
  p_legacy_losses integer DEFAULT 0,
  p_legacy_draws integer DEFAULT 0,
  p_legacy_goals_scored integer DEFAULT 0,
  p_legacy_goals_conceded integer DEFAULT 0,
  p_legacy_matches_played integer DEFAULT 0,
  p_legacy_friends text[] DEFAULT '{}'
)
RETURNS public.users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_existing public.users;
  v_clean_name text;
  v_clean_tag text;
  v_has_legacy boolean;
BEGIN
  v_uid := public.require_authenticated_uid(p_uid);
  PERFORM set_config('app.trusted_rpc', 'true', true);

  v_clean_name := left(btrim(COALESCE(NULLIF(btrim(p_display_name), ''), 'Jogador')), 28);
  v_clean_tag := left(btrim(COALESCE(NULLIF(btrim(p_tag_code), ''), '#STF0000')), 20);
  v_has_legacy := (
    COALESCE(p_legacy_matches_played, 0) > 0 OR
    COALESCE(array_length(p_legacy_friends, 1), 0) > 0
  );

  SELECT * INTO v_existing
  FROM public.users
  WHERE uid = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.users (
      uid,
      display_name,
      tag_code,
      status,
      current_room_code,
      friends,
      wins,
      losses,
      draws,
      goals_scored,
      goals_conceded,
      matches_played,
      migrated_from_firestore
    )
    VALUES (
      v_uid,
      v_clean_name,
      v_clean_tag,
      'online',
      '',
      COALESCE(p_legacy_friends, '{}'),
      GREATEST(0, LEAST(10000, COALESCE(p_legacy_wins, 0))),
      GREATEST(0, LEAST(10000, COALESCE(p_legacy_losses, 0))),
      GREATEST(0, LEAST(10000, COALESCE(p_legacy_draws, 0))),
      GREATEST(0, LEAST(50000, COALESCE(p_legacy_goals_scored, 0))),
      GREATEST(0, LEAST(50000, COALESCE(p_legacy_goals_conceded, 0))),
      GREATEST(0, LEAST(20000, COALESCE(p_legacy_matches_played, 0))),
      v_has_legacy
    )
    RETURNING * INTO v_existing;

    RETURN v_existing;
  END IF;

  -- Se já existe e ainda não migrou dados legados do Firestore (única vez), mescla com segurança
  IF v_has_legacy AND NOT v_existing.migrated_from_firestore THEN
    UPDATE public.users
    SET display_name = v_clean_name,
        friends = ARRAY(
          SELECT DISTINCT f
          FROM unnest(v_existing.friends || COALESCE(p_legacy_friends, '{}')) AS f
          WHERE f IS NOT NULL AND f <> v_uid
        ),
        wins = GREATEST(v_existing.wins, GREATEST(0, LEAST(10000, COALESCE(p_legacy_wins, 0)))),
        losses = GREATEST(v_existing.losses, GREATEST(0, LEAST(10000, COALESCE(p_legacy_losses, 0)))),
        draws = GREATEST(v_existing.draws, GREATEST(0, LEAST(10000, COALESCE(p_legacy_draws, 0)))),
        goals_scored = GREATEST(v_existing.goals_scored, GREATEST(0, LEAST(50000, COALESCE(p_legacy_goals_scored, 0)))),
        goals_conceded = GREATEST(v_existing.goals_conceded, GREATEST(0, LEAST(50000, COALESCE(p_legacy_goals_conceded, 0)))),
        matches_played = GREATEST(v_existing.matches_played, GREATEST(0, LEAST(20000, COALESCE(p_legacy_matches_played, 0)))),
        migrated_from_firestore = true,
        updated_at = now()
    WHERE uid = v_uid
    RETURNING * INTO v_existing;
  ELSIF v_clean_name <> v_existing.display_name THEN
    UPDATE public.users
    SET display_name = v_clean_name,
        updated_at = now()
    WHERE uid = v_uid
    RETURNING * INTO v_existing;
  END IF;

  RETURN v_existing;
END;
$$;

/**
 * 4.1. Criação Atômica de Sala com Hash Bcrypt de Senha no Servidor (rpc_create_room_atomic)
 * A senha é enviada em texto plano por HTTPS e o hash bcrypt (bf) é gerado no PostgreSQL.
 */
CREATE OR REPLACE FUNCTION public.rpc_create_room_atomic(
  p_room_code text,
  p_room_name text,
  p_mode text,
  p_visibility text,
  p_plain_password text DEFAULT NULL,
  p_max_humans integer DEFAULT 8,
  p_auto_fill_bots boolean DEFAULT true,
  p_active_character_ids text[] DEFAULT '{}',
  p_host_name text DEFAULT 'Anfitrião',
  p_home_team_id text DEFAULT 'unidos_do_barro',
  p_away_team_id text DEFAULT 'rubro_negro_beco',
  p_remaining_seconds integer DEFAULT 150,
  p_slots jsonb DEFAULT '{}'::jsonb
)
RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_code text;
  v_mode text;
  v_vis text;
  v_has_pwd boolean;
  v_pwd_hash text := NULL;
  v_now_ms bigint := (extract(epoch FROM now()) * 1000)::bigint;
  v_room public.rooms;
BEGIN
  v_uid := public.require_authenticated_uid();
  v_code := upper(btrim(COALESCE(p_room_code, '')));
  IF char_length(v_code) < 4 OR char_length(v_code) > 16 THEN
    RAISE EXCEPTION 'INVALID_ROOM_CODE: Código da sala inválido.';
  END IF;

  v_mode := CASE WHEN p_mode = '2v2' THEN '2v2' ELSE '4v4' END;
  v_vis := CASE WHEN p_visibility = 'private' THEN 'private' ELSE 'public' END;
  v_has_pwd := (v_vis = 'private' AND p_plain_password IS NOT NULL AND btrim(p_plain_password) <> '');

  IF v_has_pwd THEN
    v_pwd_hash := crypt(btrim(p_plain_password), gen_salt('bf', 10));
  END IF;

  INSERT INTO public.rooms (
    room_code,
    match_id,
    room_name,
    mode,
    visibility,
    has_password,
    password_hash,
    max_humans,
    auto_fill_bots,
    active_character_ids,
    loading_ready_uids,
    start_at,
    last_activity_ms,
    host_uid,
    host_name,
    status,
    home_team_id,
    away_team_id,
    home_goals,
    away_goals,
    half,
    remaining_seconds,
    slots,
    inputs,
    match_snapshot
  )
  VALUES (
    v_code,
    NULL,
    left(btrim(COALESCE(NULLIF(btrim(p_room_name), ''), 'SEM TERRA FC — ' || v_code)), 60),
    v_mode,
    v_vis,
    v_has_pwd,
    v_pwd_hash,
    GREATEST(1, LEAST(CASE WHEN v_mode = '2v2' THEN 4 ELSE 8 END, COALESCE(p_max_humans, 8))),
    COALESCE(p_auto_fill_bots, true),
    COALESCE(p_active_character_ids, '{}'),
    ARRAY[v_uid],
    NULL,
    v_now_ms,
    v_uid,
    left(btrim(COALESCE(NULLIF(btrim(p_host_name), ''), 'Anfitrião')), 28),
    'waiting',
    COALESCE(NULLIF(btrim(p_home_team_id), ''), 'unidos_do_barro'),
    COALESCE(NULLIF(btrim(p_away_team_id), ''), 'rubro_negro_beco'),
    0,
    0,
    1,
    GREATEST(30, LEAST(3600, COALESCE(p_remaining_seconds, 150))),
    COALESCE(p_slots, '{}'::jsonb),
    '{}'::jsonb,
    NULL
  )
  RETURNING * INTO v_room;

  RETURN public.sanitize_room_record(v_room);
END;
$$;

/**
 * 4.2. Entrada Atômica em Sala com Validação de Senha no Servidor (rpc_join_room_atomic)
 * - Identidade obtida exclusivamente do JWT (public.require_authenticated_uid).
 * - Valida a senha original usando crypt() contra o bcrypt salvo no banco.
 * - Nunca retorna password_hash.
 */
CREATE OR REPLACE FUNCTION public.rpc_join_room_atomic(
  p_room_code text,
  p_uid text DEFAULT NULL,
  p_display_name text DEFAULT 'Jogador',
  p_password_hash text DEFAULT NULL, -- Recebe a senha informada pelo usuário para validação server-side
  p_expected_mode text DEFAULT NULL
)
RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_room public.rooms;
  v_slots jsonb;
  v_slot_key text;
  v_slot_val jsonb;
  v_existing_key text := NULL;
  v_human_count int := 0;
  v_home_humans int := 0;
  v_away_humans int := 0;
  v_max_per_team int;
  v_preferred_team text;
  v_chosen_key text := NULL;
  v_clean_name text;
  v_now_ms bigint := (extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  -- 1. Valida identidade estritamente pelo JWT (rejeita se p_uid divergir do JWT)
  v_uid := public.require_authenticated_uid(p_uid);
  v_clean_name := left(btrim(COALESCE(NULLIF(btrim(p_display_name), ''), 'Jogador')), 28);

  -- 2. Lock pessimista na linha da sala para impedir duplicidade de vagas simultâneas
  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = upper(btrim(p_room_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sala não encontrada. Verifique o código da sala.';
  END IF;

  IF v_room.status = 'finished' THEN
    RAISE EXCEPTION 'Esta partida já foi encerrada.';
  END IF;

  IF p_expected_mode IS NOT NULL AND v_room.mode <> p_expected_mode THEN
    RAISE EXCEPTION 'Esta sala é da modalidade % e não aceita entrada pelo modo %.',
      upper(v_room.mode), upper(p_expected_mode);
  END IF;

  v_slots := COALESCE(v_room.slots, '{}'::jsonb);

  -- 3. Inspeciona slots atuais
  FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
  LOOP
    IF COALESCE((v_slot_val ->> 'uid'), '') = v_uid THEN
      v_existing_key := v_slot_key;
    END IF;
    IF COALESCE((v_slot_val ->> 'isBot')::boolean, true) = false
       AND COALESCE((v_slot_val ->> 'uid'), '') <> '' THEN
      v_human_count := v_human_count + 1;
      IF (v_slot_val ->> 'team') = 'home' THEN
        v_home_humans := v_home_humans + 1;
      ELSE
        v_away_humans := v_away_humans + 1;
      END IF;
    END IF;
  END LOOP;

  IF (v_room.status IN ('playing', 'starting')) AND v_existing_key IS NULL THEN
    RAISE EXCEPTION 'Não é possível entrar: a partida já está em andamento.';
  END IF;

  -- 4. Validação de senha no servidor usando bcrypt (crypt)
  IF v_room.has_password
     AND v_room.password_hash IS NOT NULL
     AND v_room.host_uid <> v_uid
     AND v_existing_key IS NULL THEN
    IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
      RAISE EXCEPTION 'SENHA_OBRIGATORIA: Esta sala privada exige senha para entrar.';
    END IF;

    -- Verifica via crypt() do pgcrypto (nunca aceita o próprio hash armazenado se for bcrypt)
    IF v_room.password_hash LIKE '$2%' THEN
      IF v_room.password_hash <> crypt(btrim(p_password_hash), v_room.password_hash) THEN
        RAISE EXCEPTION 'Senha incorreta para esta sala privada.';
      END IF;
    ELSE
      -- Compatibilidade caso uma sala legada tenha usado SHA-256 com salt do código da sala
      IF v_room.password_hash <> encode(digest('STF_ROOM_SALT_' || v_room.room_code || '::' || btrim(p_password_hash), 'sha256'), 'hex') THEN
        RAISE EXCEPTION 'Senha incorreta para esta sala privada.';
      END IF;
    END IF;
  END IF;

  -- 5. Alocação atômica de slot
  IF v_existing_key IS NOT NULL THEN
    v_slot_val := v_slots -> v_existing_key;
    v_slot_val := jsonb_set(v_slot_val, '{displayName}', to_jsonb(v_clean_name));
    v_slot_val := jsonb_set(v_slot_val, '{isBot}', 'false'::jsonb);
    v_slot_val := jsonb_set(v_slot_val, '{lastSeenMs}', to_jsonb(v_now_ms));
    v_slots := jsonb_set(v_slots, ARRAY[v_existing_key], v_slot_val);
  ELSE
    IF v_human_count >= v_room.max_humans THEN
      RAISE EXCEPTION 'Sala lotada (%/% jogadores humanos).', v_human_count, v_room.max_humans;
    END IF;

    v_max_per_team := CASE WHEN v_room.mode = '2v2' THEN 2 ELSE 4 END;
    IF v_home_humans <= v_away_humans AND v_home_humans < v_max_per_team THEN
      v_preferred_team := 'home';
    ELSIF v_away_humans < v_max_per_team THEN
      v_preferred_team := 'away';
    ELSE
      v_preferred_team := 'home';
    END IF;

    FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
    LOOP
      IF COALESCE((v_slot_val ->> 'isBot')::boolean, false) = true
         AND (v_slot_val ->> 'team') = v_preferred_team THEN
        v_chosen_key := v_slot_key;
        EXIT;
      END IF;
    END LOOP;

    IF v_chosen_key IS NULL THEN
      FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
      LOOP
        IF COALESCE((v_slot_val ->> 'isBot')::boolean, false) = true THEN
          v_chosen_key := v_slot_key;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF v_chosen_key IS NULL THEN
      RAISE EXCEPTION 'Todas as vagas de personagens já estão ocupadas.';
    END IF;

    v_slot_val := v_slots -> v_chosen_key;
    v_slot_val := v_slot_val || jsonb_build_object(
      'uid', v_uid,
      'displayName', v_clean_name,
      'isBot', false,
      'isReady', true,
      'pingMs', 24,
      'micEnabled', false,
      'isSpeaking', false,
      'lastSeenMs', v_now_ms
    );
    v_slots := jsonb_set(v_slots, ARRAY[v_chosen_key], v_slot_val);
  END IF;

  UPDATE public.rooms
  SET slots = v_slots,
      last_activity_ms = v_now_ms,
      updated_at = now()
  WHERE room_code = v_room.room_code
  RETURNING * INTO v_room;

  RETURN public.sanitize_room_record(v_room);
END;
$$;

/**
 * 4.3. Seleção Atômica de Personagem na Sala (rpc_select_character_atomic)
 * Valida que o jogador já pertence à sala e impede tomar personagem de outro humano.
 */
CREATE OR REPLACE FUNCTION public.rpc_select_character_atomic(
  p_room_code text,
  p_target_character_id text,
  p_display_name text DEFAULT 'Jogador'
)
RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_room public.rooms;
  v_slots jsonb;
  v_target_slot jsonb;
  v_slot_key text;
  v_slot_val jsonb;
  v_my_prev_key text := NULL;
  v_my_mic boolean := false;
  v_my_ready boolean := true;
  v_team_humans int := 0;
  v_char_name text;
  v_now_ms bigint := (extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  v_uid := public.require_authenticated_uid();

  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = upper(btrim(p_room_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sala não existe mais.';
  END IF;

  v_slots := COALESCE(v_room.slots, '{}'::jsonb);
  IF NOT public.is_room_participant(v_slots, v_room.host_uid, v_uid) THEN
    RAISE EXCEPTION 'NOT_IN_ROOM: Você não pertence a esta sala.'
      USING ERRCODE = '42501';
  END IF;

  v_target_slot := v_slots -> p_target_character_id;
  IF v_target_slot IS NULL THEN
    RAISE EXCEPTION 'Personagem inválido.';
  END IF;

  IF COALESCE((v_target_slot ->> 'isBot')::boolean, true) = false
     AND COALESCE(v_target_slot ->> 'uid', '') = v_uid THEN
    RETURN public.sanitize_room_record(v_room);
  END IF;

  IF COALESCE((v_target_slot ->> 'isBot')::boolean, true) = false
     AND COALESCE(v_target_slot ->> 'uid', '') <> v_uid THEN
    RAISE EXCEPTION '% já foi escolhido por %!',
      COALESCE(v_target_slot ->> 'characterName', 'Personagem'),
      COALESCE(v_target_slot ->> 'displayName', 'outro jogador');
  END IF;

  -- Verifica limite por equipe no modo 2v2
  IF v_room.mode = '2v2' THEN
    FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
    LOOP
      IF (v_slot_val ->> 'team') = (v_target_slot ->> 'team')
         AND COALESCE((v_slot_val ->> 'isBot')::boolean, true) = false
         AND COALESCE(v_slot_val ->> 'uid', '') NOT IN ('', v_uid) THEN
        v_team_humans := v_team_humans + 1;
      END IF;
    END LOOP;

    IF v_team_humans >= 2 THEN
      RAISE EXCEPTION 'Esta equipe já possui 2 jogadores humanos na modalidade 2 contra 2.';
    END IF;
  END IF;

  -- Converte o slot anterior do jogador de volta para Bot
  FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
  LOOP
    IF COALESCE(v_slot_val ->> 'uid', '') = v_uid THEN
      v_my_prev_key := v_slot_key;
      v_my_mic := COALESCE((v_slot_val ->> 'micEnabled')::boolean, false);
      v_my_ready := COALESCE((v_slot_val ->> 'isReady')::boolean, true);
      v_char_name := COALESCE(v_slot_val ->> 'characterName', 'Bot');
      v_slot_val := v_slot_val || jsonb_build_object(
        'uid', NULL,
        'displayName', v_char_name || ' (Bot)',
        'isBot', true,
        'isReady', true,
        'pingMs', 0,
        'micEnabled', false,
        'isSpeaking', false,
        'lastSeenMs', v_now_ms
      );
      v_slots := jsonb_set(v_slots, ARRAY[v_slot_key], v_slot_val);
    END IF;
  END LOOP;

  -- Ocupa o novo personagem
  v_target_slot := v_target_slot || jsonb_build_object(
    'uid', v_uid,
    'displayName', left(btrim(COALESCE(NULLIF(btrim(p_display_name), ''), 'Jogador')), 28),
    'isBot', false,
    'isReady', v_my_ready,
    'pingMs', 20,
    'micEnabled', v_my_mic,
    'isSpeaking', false,
    'lastSeenMs', v_now_ms
  );
  v_slots := jsonb_set(v_slots, ARRAY[p_target_character_id], v_target_slot);

  UPDATE public.rooms
  SET slots = v_slots,
      last_activity_ms = v_now_ms,
      updated_at = now()
  WHERE room_code = v_room.room_code
  RETURNING * INTO v_room;

  RETURN public.sanitize_room_record(v_room);
END;
$$;

/**
 * 4.4. Alternância Atômica de Prontidão (rpc_toggle_ready_atomic)
 * Somente um participante autenticado da sala pode alterar sua própria prontidão.
 */
CREATE OR REPLACE FUNCTION public.rpc_toggle_ready_atomic(
  p_room_code text,
  p_uid text DEFAULT NULL,
  p_ready boolean DEFAULT NULL
)
RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_room public.rooms;
  v_slots jsonb;
  v_slot_key text;
  v_slot_val jsonb;
  v_next_ready boolean;
  v_changed boolean := false;
  v_now_ms bigint := (extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  v_uid := public.require_authenticated_uid(p_uid);

  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = upper(btrim(p_room_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sala não encontrada.';
  END IF;

  v_slots := COALESCE(v_room.slots, '{}'::jsonb);

  FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
  LOOP
    IF COALESCE((v_slot_val ->> 'uid'), '') = v_uid THEN
      v_next_ready := COALESCE(p_ready, NOT COALESCE((v_slot_val ->> 'isReady')::boolean, false));
      v_slot_val := v_slot_val || jsonb_build_object(
        'isReady', v_next_ready,
        'lastSeenMs', v_now_ms
      );
      v_slots := jsonb_set(v_slots, ARRAY[v_slot_key], v_slot_val);
      v_changed := true;
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    RAISE EXCEPTION 'NOT_A_ROOM_PARTICIPANT: Você não ocupa uma vaga nesta sala.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.rooms
  SET slots = v_slots,
      last_activity_ms = v_now_ms,
      updated_at = now()
  WHERE room_code = v_room.room_code
  RETURNING * INTO v_room;

  RETURN public.sanitize_room_record(v_room);
END;
$$;

/**
 * 4.5. Saída Atômica de Sala (rpc_leave_room_atomic)
 * Valida que o jogador pertence à sala antes de liberar seu slot ou transferir o host.
 */
CREATE OR REPLACE FUNCTION public.rpc_leave_room_atomic(
  p_room_code text,
  p_uid text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_room public.rooms;
  v_slots jsonb;
  v_slot_key text;
  v_slot_val jsonb;
  v_was_in_room boolean := false;
  v_remaining_humans int := 0;
  v_first_human_uid text := NULL;
  v_first_human_name text := NULL;
  v_next_host_uid text;
  v_next_host_name text;
  v_char_name text;
  v_now_ms bigint := (extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  v_uid := public.require_authenticated_uid(p_uid);

  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = upper(btrim(p_room_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_slots := COALESCE(v_room.slots, '{}'::jsonb);

  FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
  LOOP
    IF COALESCE((v_slot_val ->> 'uid'), '') = v_uid THEN
      v_was_in_room := true;
      v_char_name := COALESCE(v_slot_val ->> 'characterName', 'Bot');
      v_slot_val := v_slot_val || jsonb_build_object(
        'uid', NULL,
        'displayName', v_char_name || ' (Bot)',
        'isBot', true,
        'isReady', true,
        'pingMs', 0,
        'micEnabled', false,
        'isSpeaking', false,
        'lastSeenMs', v_now_ms
      );
      v_slots := jsonb_set(v_slots, ARRAY[v_slot_key], v_slot_val);
    END IF;
  END LOOP;

  IF NOT v_was_in_room AND v_room.host_uid <> v_uid THEN
    RAISE EXCEPTION 'NOT_IN_ROOM: Jogador não pertence a esta sala.'
      USING ERRCODE = '42501';
  END IF;

  FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
  LOOP
    IF COALESCE((v_slot_val ->> 'isBot')::boolean, true) = false
       AND COALESCE((v_slot_val ->> 'uid'), '') <> '' THEN
      v_remaining_humans := v_remaining_humans + 1;
      IF v_first_human_uid IS NULL THEN
        v_first_human_uid := v_slot_val ->> 'uid';
        v_first_human_name := COALESCE(v_slot_val ->> 'displayName', 'Anfitrião');
      END IF;
    END IF;
  END LOOP;

  IF v_remaining_humans = 0 THEN
    DELETE FROM public.rooms WHERE room_code = v_room.room_code;
  ELSE
    v_next_host_uid := v_room.host_uid;
    v_next_host_name := v_room.host_name;
    IF v_room.host_uid = v_uid AND v_first_human_uid IS NOT NULL THEN
      v_next_host_uid := v_first_human_uid;
      v_next_host_name := left(v_first_human_name, 28);
    END IF;

    UPDATE public.rooms
    SET host_uid = v_next_host_uid,
        host_name = v_next_host_name,
        slots = v_slots,
        last_activity_ms = v_now_ms,
        updated_at = now()
    WHERE room_code = v_room.room_code;
  END IF;
END;
$$;

/**
 * 4.6. Início Sincronizado de Partida (rpc_start_match_atomic)
 * Somente o host autenticado da sala pode iniciar a partida.
 */
CREATE OR REPLACE FUNCTION public.rpc_start_match_atomic(
  p_room_code text,
  p_match_id text,
  p_active_character_ids text[] DEFAULT '{}'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_room public.rooms;
  v_slots jsonb;
  v_slot_key text;
  v_slot_val jsonb;
  v_humans text[] := '{}';
  v_bots text[] := '{}';
  v_match_id text;
  v_now_ms bigint := (extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  v_uid := public.require_authenticated_uid();

  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = upper(btrim(p_room_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sala não encontrada.';
  END IF;

  IF v_room.host_uid <> v_uid THEN
    RAISE EXCEPTION 'ONLY_HOST_CAN_START: Apenas o anfitrião da sala pode iniciar a partida.'
      USING ERRCODE = '42501';
  END IF;

  v_match_id := COALESCE(NULLIF(btrim(p_match_id), ''), v_room.match_id, 'MTC-' || v_room.room_code);
  v_slots := COALESCE(v_room.slots, '{}'::jsonb);

  FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
  LOOP
    IF COALESCE((v_slot_val ->> 'isBot')::boolean, true) = false
       AND COALESCE(v_slot_val ->> 'uid', '') <> '' THEN
      v_humans := array_append(v_humans, v_slot_val ->> 'uid');
    ELSE
      v_bots := array_append(v_bots, COALESCE(v_slot_val ->> 'characterId', v_slot_key));
    END IF;
  END LOOP;

  IF COALESCE(array_length(v_humans, 1), 0) = 0 THEN
    v_humans := ARRAY[v_uid];
  END IF;

  INSERT INTO public.matches (
    match_id,
    room_id,
    host_id,
    mode,
    status,
    players,
    bots,
    score,
    ball,
    start_at,
    updated_at
  )
  VALUES (
    v_match_id,
    v_room.room_code,
    v_uid,
    v_room.mode,
    'starting',
    v_humans,
    v_bots,
    '{"teamA": 0, "teamB": 0}'::jsonb,
    '{"x": 0, "y": 0.22, "z": 0}'::jsonb,
    v_now_ms,
    now()
  )
  ON CONFLICT (match_id) DO UPDATE
    SET status = 'starting',
        players = EXCLUDED.players,
        bots = EXCLUDED.bots,
        start_at = EXCLUDED.start_at,
        updated_at = now();

  UPDATE public.rooms
  SET match_id = v_match_id,
      status = 'starting',
      start_at = v_now_ms,
      active_character_ids = CASE
        WHEN COALESCE(array_length(p_active_character_ids, 1), 0) > 0 THEN p_active_character_ids
        ELSE active_character_ids
      END,
      loading_ready_uids = ARRAY[v_uid],
      last_activity_ms = v_now_ms,
      updated_at = now()
  WHERE room_code = v_room.room_code;

  RETURN v_match_id;
END;
$$;

/**
 * 4.7. Confirmação Atômica de Carregamento da Partida (rpc_mark_loading_ready_atomic)
 * Exige autenticação e participação real na sala.
 */
CREATE OR REPLACE FUNCTION public.rpc_mark_loading_ready_atomic(
  p_room_code text,
  p_uid text DEFAULT NULL,
  p_force_promote boolean DEFAULT false
)
RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_room public.rooms;
  v_ready_uids text[];
  v_slots jsonb;
  v_slot_key text;
  v_slot_val jsonb;
  v_all_humans_ready boolean := true;
  v_human_count int := 0;
  v_next_status text;
  v_now_ms bigint := (extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  v_uid := public.require_authenticated_uid(p_uid);

  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = upper(btrim(p_room_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sala não encontrada.';
  END IF;

  v_slots := COALESCE(v_room.slots, '{}'::jsonb);
  IF NOT public.is_room_participant(v_slots, v_room.host_uid, v_uid) THEN
    RAISE EXCEPTION 'NOT_IN_ROOM: Somente participantes da sala podem confirmar carregamento.'
      USING ERRCODE = '42501';
  END IF;

  IF v_room.status IN ('playing', 'finished') THEN
    RETURN public.sanitize_room_record(v_room);
  END IF;

  v_ready_uids := COALESCE(v_room.loading_ready_uids, '{}');
  IF NOT (v_uid = ANY(v_ready_uids)) THEN
    v_ready_uids := array_append(v_ready_uids, v_uid);
  END IF;

  FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
  LOOP
    IF COALESCE((v_slot_val ->> 'isBot')::boolean, true) = false
       AND COALESCE((v_slot_val ->> 'uid'), '') <> '' THEN
      v_human_count := v_human_count + 1;
      IF NOT ((v_slot_val ->> 'uid') = ANY(v_ready_uids)) THEN
        v_all_humans_ready := false;
      END IF;
    END IF;
  END LOOP;

  v_next_status := v_room.status;
  -- Promove para 'playing' quando todos os humanos confirmaram OU após timeout de 5s (p_force_promote)
  IF v_room.status = 'starting' AND (
    (v_human_count > 0 AND v_all_humans_ready)
    OR (p_force_promote AND v_room.start_at IS NOT NULL AND (v_now_ms - v_room.start_at) >= 4500)
    OR (p_force_promote AND v_room.host_uid = v_uid)
  ) THEN
    v_next_status := 'playing';
    IF v_room.match_id IS NOT NULL THEN
      UPDATE public.matches
      SET status = 'playing',
          updated_at = now()
      WHERE match_id = v_room.match_id;
    END IF;
  END IF;

  UPDATE public.rooms
  SET status = v_next_status,
      loading_ready_uids = v_ready_uids,
      last_activity_ms = v_now_ms,
      updated_at = now()
  WHERE room_code = v_room.room_code
  RETURNING * INTO v_room;

  RETURN public.sanitize_room_record(v_room);
END;
$$;

/**
 * 4.8. Resposta Atômica a Solicitação de Amizade (rpc_respond_friend_request_atomic)
 * SOMENTE o destinatário autenticado (to_uid = public.firebase_uid()) pode aceitar ou recusar.
 */
CREATE OR REPLACE FUNCTION public.rpc_respond_friend_request_atomic(
  p_request_id uuid,
  p_uid text DEFAULT NULL,
  p_accept boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_req public.friend_requests;
BEGIN
  v_uid := public.require_authenticated_uid(p_uid);
  PERFORM set_config('app.trusted_rpc', 'true', true);

  SELECT * INTO v_req
  FROM public.friend_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitação não encontrada.';
  END IF;

  -- Regra estrita: SOMENTE o destinatário (to_uid) pode aceitar ou recusar!
  IF v_req.to_uid <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_RECIPIENT_ONLY: Somente o destinatário da solicitação (%) pode aceitá-la ou recusá-la.',
      v_req.to_uid
      USING ERRCODE = '42501';
  END IF;

  IF v_req.status <> 'pending' THEN
    RETURN;
  END IF;

  UPDATE public.friend_requests
  SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
      updated_at = now()
  WHERE id = p_request_id;

  IF p_accept AND v_req.type = 'friend_request' THEN
    INSERT INTO public.friendships (user_uid, friend_uid)
    VALUES (v_req.to_uid, v_req.from_uid), (v_req.from_uid, v_req.to_uid)
    ON CONFLICT DO NOTHING;

    UPDATE public.users
    SET friends = CASE
          WHEN NOT (v_req.from_uid = ANY(friends)) THEN array_append(friends, v_req.from_uid)
          ELSE friends
        END,
        updated_at = now()
    WHERE uid = v_req.to_uid;

    UPDATE public.users
    SET friends = CASE
          WHEN NOT (v_req.to_uid = ANY(friends)) THEN array_append(friends, v_req.to_uid)
          ELSE friends
        END,
        updated_at = now()
    WHERE uid = v_req.from_uid;
  END IF;
END;
$$;

/**
 * 4.9. Remoção Atômica e Consistente de Amizade (rpc_remove_friend_atomic)
 */
CREATE OR REPLACE FUNCTION public.rpc_remove_friend_atomic(
  p_friend_uid text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
BEGIN
  v_uid := public.require_authenticated_uid();
  PERFORM set_config('app.trusted_rpc', 'true', true);

  DELETE FROM public.friendships
  WHERE (user_uid = v_uid AND friend_uid = p_friend_uid)
     OR (user_uid = p_friend_uid AND friend_uid = v_uid);

  UPDATE public.users
  SET friends = array_remove(friends, p_friend_uid),
      updated_at = now()
  WHERE uid = v_uid;

  UPDATE public.users
  SET friends = array_remove(friends, v_uid),
      updated_at = now()
  WHERE uid = p_friend_uid;
END;
$$;

/**
 * 4.10. Encerramento Autoritativo de Partida e Atualização de Estatísticas (rpc_record_match_finished_atomic)
 * Impede manipulação de resultados pelo cliente:
 *   - Exige que a sala e a partida ativa existam no banco.
 *   - Exige que o chamador seja participante verificado da partida (e caso o host esteja conectado, exige o host).
 *   - Garante idempotência (uma partida só pode ser contabilizada 1 única vez).
 *   - Atualiza as estatísticas de cada jogador humano participante de acordo com sua equipe real nos slots da sala.
 */
CREATE OR REPLACE FUNCTION public.rpc_record_match_finished_atomic(
  p_room_code text,
  p_home_team_name text,
  p_away_team_name text,
  p_home_goals integer,
  p_away_goals integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text;
  v_room public.rooms;
  v_match public.matches;
  v_slots jsonb;
  v_slot_key text;
  v_slot_val jsonb;
  v_player_uid text;
  v_player_team text;
  v_participants text[] := '{}';
  v_winner text;
  v_home_g smallint;
  v_away_g smallint;
  v_now_ms bigint := (extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  v_uid := public.require_authenticated_uid();
  PERFORM set_config('app.trusted_rpc', 'true', true);

  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = upper(btrim(p_room_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATCH_ROOM_NOT_FOUND: Sala da partida não existe.';
  END IF;

  v_slots := COALESCE(v_room.slots, '{}'::jsonb);
  IF NOT public.is_room_participant(v_slots, v_room.host_uid, v_uid) THEN
    RAISE EXCEPTION 'NOT_MATCH_PARTICIPANT: Somente participantes verificados da sala podem encerrar a partida.'
      USING ERRCODE = '42501';
  END IF;

  -- Se a sala já foi finalizada, retorna false (idempotente: impede inflar estatísticas repetindo a chamada)
  IF v_room.status = 'finished' THEN
    RETURN false;
  END IF;

  IF v_room.status NOT IN ('playing', 'starting') OR v_room.match_id IS NULL THEN
    RAISE EXCEPTION 'MATCH_NOT_ACTIVE: A sala não possui uma partida ativa em andamento.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_match
  FROM public.matches
  WHERE match_id = v_room.match_id
  FOR UPDATE;

  IF NOT FOUND OR v_match.status = 'finished' THEN
    RETURN false;
  END IF;

  -- Placar limitado a faixa realista de partida (0..35 gols)
  v_home_g := GREATEST(0, LEAST(35, COALESCE(p_home_goals, 0)))::smallint;
  v_away_g := GREATEST(0, LEAST(35, COALESCE(p_away_goals, 0)))::smallint;

  v_winner := CASE
    WHEN v_home_g > v_away_g THEN 'home'
    WHEN v_away_g > v_home_g THEN 'away'
    ELSE 'draw'
  END;

  -- Atualiza estatísticas de cada jogador humano participante segundo sua equipe real registrada nos slots
  FOR v_slot_key, v_slot_val IN SELECT * FROM jsonb_each(v_slots)
  LOOP
    v_player_uid := COALESCE(v_slot_val ->> 'uid', '');
    v_player_team := COALESCE(v_slot_val ->> 'team', 'home');

    IF COALESCE((v_slot_val ->> 'isBot')::boolean, true) = false
       AND v_player_uid <> ''
       AND NOT (v_player_uid = ANY(v_participants)) THEN
      v_participants := array_append(v_participants, v_player_uid);

      UPDATE public.users
      SET status = 'online',
          current_room_code = '',
          wins = wins + CASE WHEN v_winner = v_player_team THEN 1 ELSE 0 END,
          losses = losses + CASE WHEN v_winner <> 'draw' AND v_winner <> v_player_team THEN 1 ELSE 0 END,
          draws = draws + CASE WHEN v_winner = 'draw' THEN 1 ELSE 0 END,
          goals_scored = goals_scored + CASE WHEN v_player_team = 'home' THEN v_home_g ELSE v_away_g END,
          goals_conceded = goals_conceded + CASE WHEN v_player_team = 'home' THEN v_away_g ELSE v_home_g END,
          matches_played = matches_played + 1,
          updated_at = now()
      WHERE uid = v_player_uid;
    END IF;
  END LOOP;

  -- Marca partida e sala como finalizadas
  UPDATE public.matches
  SET status = 'finished',
      score = jsonb_build_object('teamA', v_home_g, 'teamB', v_away_g),
      finished_at = v_now_ms,
      updated_at = now()
  WHERE match_id = v_match.match_id;

  UPDATE public.rooms
  SET status = 'finished',
      home_goals = v_home_g,
      away_goals = v_away_g,
      last_activity_ms = v_now_ms,
      updated_at = now()
  WHERE room_code = v_room.room_code;

  INSERT INTO public.match_history (
    match_id,
    room_code,
    host_uid,
    home_team_name,
    away_team_name,
    home_goals,
    away_goals,
    winner,
    participant_uids
  )
  VALUES (
    v_match.match_id,
    v_room.room_code,
    v_room.host_uid,
    left(btrim(COALESCE(p_home_team_name, 'Sem Terra FC')), 60),
    left(btrim(COALESCE(p_away_team_name, 'Rubro-Negro do Beco')), 60),
    v_home_g,
    v_away_g,
    v_winner,
    v_participants
  )
  ON CONFLICT (match_id) DO NOTHING;

  RETURN true;
END;
$$;

-- ============================================================================
-- 5. CONTROLE DE EXECUÇÃO DAS FUNÇÕES (REVOKE PUBLIC / GRANT AUTHENTICATED)
-- ============================================================================

REVOKE ALL ON FUNCTION public.rpc_ensure_user_profile_atomic(text, text, text, integer, integer, integer, integer, integer, integer, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_create_room_atomic(text, text, text, text, text, integer, boolean, text[], text, text, text, integer, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_join_room_atomic(text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_select_character_atomic(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_toggle_ready_atomic(text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_leave_room_atomic(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_start_match_atomic(text, text, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mark_loading_ready_atomic(text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_respond_friend_request_atomic(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_remove_friend_atomic(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_record_match_finished_atomic(text, text, text, integer, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.rpc_ensure_user_profile_atomic(text, text, text, integer, integer, integer, integer, integer, integer, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_room_atomic(text, text, text, text, text, integer, boolean, text[], text, text, text, integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_join_room_atomic(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_select_character_atomic(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_toggle_ready_atomic(text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_leave_room_atomic(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_start_match_atomic(text, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mark_loading_ready_atomic(text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_respond_friend_request_atomic(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_remove_friend_atomic(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_match_finished_atomic(text, text, text, integer, integer) TO authenticated;

-- ============================================================================
-- 6. POLÍTICAS ROW-LEVEL SECURITY (RLS) ESTRITAS NAS 6 TABELAS
-- ============================================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_history ENABLE ROW LEVEL SECURITY;

-- 6.1. Políticas de public.users
DROP POLICY IF EXISTS users_select_authenticated ON public.users;
CREATE POLICY users_select_authenticated ON public.users
  FOR SELECT
  TO authenticated
  USING (public.is_firebase_authenticated());

DROP POLICY IF EXISTS users_insert_own ON public.users;
CREATE POLICY users_insert_own ON public.users
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.firebase_uid() IS NOT NULL
    AND uid = public.firebase_uid()
    AND wins = 0
    AND losses = 0
    AND draws = 0
    AND goals_scored = 0
    AND goals_conceded = 0
    AND matches_played = 0
  );

DROP POLICY IF EXISTS users_update_own ON public.users;
CREATE POLICY users_update_own ON public.users
  FOR UPDATE
  TO authenticated
  USING (public.firebase_uid() IS NOT NULL AND uid = public.firebase_uid())
  WITH CHECK (public.firebase_uid() IS NOT NULL AND uid = public.firebase_uid());

-- 6.2. Políticas de public.friendships
DROP POLICY IF EXISTS friendships_select_all ON public.friendships;
DROP POLICY IF EXISTS friendships_select_authenticated ON public.friendships;
CREATE POLICY friendships_select_authenticated ON public.friendships
  FOR SELECT
  TO authenticated
  USING (
    public.firebase_uid() IS NOT NULL
    AND public.firebase_uid() IN (user_uid, friend_uid)
  );

DROP POLICY IF EXISTS friendships_modify_participant ON public.friendships;
DROP POLICY IF EXISTS friendships_delete_own ON public.friendships;
CREATE POLICY friendships_delete_own ON public.friendships
  FOR DELETE
  TO authenticated
  USING (
    public.firebase_uid() IS NOT NULL
    AND public.firebase_uid() IN (user_uid, friend_uid)
  );
-- Nota: INSERT direto em public.friendships não é permitido ao cliente; deve usar rpc_respond_friend_request_atomic.

-- 6.3. Políticas de public.friend_requests
DROP POLICY IF EXISTS friend_requests_select_participant ON public.friend_requests;
CREATE POLICY friend_requests_select_participant ON public.friend_requests
  FOR SELECT
  TO authenticated
  USING (
    public.firebase_uid() IS NOT NULL
    AND public.firebase_uid() IN (from_uid, to_uid)
  );

DROP POLICY IF EXISTS friend_requests_insert_sender ON public.friend_requests;
CREATE POLICY friend_requests_insert_sender ON public.friend_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.firebase_uid() IS NOT NULL
    AND from_uid = public.firebase_uid()
    AND from_uid <> to_uid
    AND status = 'pending'
  );

DROP POLICY IF EXISTS friend_requests_update_participant ON public.friend_requests;
DROP POLICY IF EXISTS friend_requests_update_recipient_only ON public.friend_requests;
CREATE POLICY friend_requests_update_recipient_only ON public.friend_requests
  FOR UPDATE
  TO authenticated
  USING (
    public.firebase_uid() IS NOT NULL
    AND to_uid = public.firebase_uid()
    AND status = 'pending'
  )
  WITH CHECK (
    public.firebase_uid() IS NOT NULL
    AND to_uid = public.firebase_uid()
    AND status IN ('accepted', 'declined')
  );

DROP POLICY IF EXISTS friend_requests_delete_participant ON public.friend_requests;
CREATE POLICY friend_requests_delete_participant ON public.friend_requests
  FOR DELETE
  TO authenticated
  USING (
    public.firebase_uid() IS NOT NULL
    AND public.firebase_uid() IN (from_uid, to_uid)
  );

-- 6.4. Políticas de public.rooms
-- Leitura permitida somente a usuários autenticados para salas públicas OU salas privadas onde o jogador já participa.
-- Todas as escritas acontecem via funções RPC atômicas (rpc_create_room_atomic, rpc_join_room_atomic, etc.).
DROP POLICY IF EXISTS rooms_select_all ON public.rooms;
DROP POLICY IF EXISTS rooms_write_authenticated ON public.rooms;
DROP POLICY IF EXISTS rooms_select_authorized ON public.rooms;
CREATE POLICY rooms_select_authorized ON public.rooms
  FOR SELECT
  TO authenticated
  USING (
    public.firebase_uid() IS NOT NULL
    AND (
      visibility = 'public'
      OR public.is_room_participant(slots, host_uid, public.firebase_uid())
    )
  );

-- 6.5. Políticas de public.matches
-- Leitura restrita a usuários autenticados participantes da partida. Escritas apenas via RPCs de servidor.
DROP POLICY IF EXISTS matches_select_all ON public.matches;
DROP POLICY IF EXISTS matches_write_authenticated ON public.matches;
DROP POLICY IF EXISTS matches_select_participant ON public.matches;
CREATE POLICY matches_select_participant ON public.matches
  FOR SELECT
  TO authenticated
  USING (
    public.firebase_uid() IS NOT NULL
    AND (
      host_id = public.firebase_uid()
      OR public.firebase_uid() = ANY(players)
    )
  );

-- 6.6. Políticas de public.match_history
-- Leitura permitida a usuários autenticados; inserção/edição direta bloqueada (exclusiva via rpc_record_match_finished_atomic).
DROP POLICY IF EXISTS match_history_select_all ON public.match_history;
DROP POLICY IF EXISTS match_history_insert_authenticated ON public.match_history;
DROP POLICY IF EXISTS match_history_select_authenticated ON public.match_history;
CREATE POLICY match_history_select_authenticated ON public.match_history
  FOR SELECT
  TO authenticated
  USING (public.is_firebase_authenticated());

-- ============================================================================
-- 7. PUBLICAÇÃO SUPABASE REALTIME SEGURA (PROTEGIDA PELAS POLÍTICAS RLS ACIMA)
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.friend_requests;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;
