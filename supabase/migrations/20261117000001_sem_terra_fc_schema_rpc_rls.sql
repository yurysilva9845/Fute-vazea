-- ============================================================================
-- SEM TERRA FC — SCHEMA BASE + RPCs ATÔMICAS + RLS (SUPABASE POSTGRESQL + FIREBASE AUTH)
-- Projeto Supabase: https://etlvzqrfsvvpzltimxaj.supabase.co
-- Projeto Firebase: gen-lang-client-0384619138
--
-- REGRAS DE TIPAGEM:
-- 1. Todos os UIDs do Firebase Authentication são SEMPRE `TEXT` (nunca `UUID`):
--    - public.users.uid (TEXT PK)
--    - public.friendships.user_id_1, user_id_2 (TEXT FK -> users.uid)
--    - public.friend_requests.sender_id, receiver_id (TEXT FK -> users.uid)
--    - public.rooms.host_id (TEXT FK -> users.uid)
--    - public.room_participants.user_id (TEXT FK -> users.uid)
--    - public.presences.user_id (TEXT PK, FK -> users.uid)
--    - public.match_history.user_id (TEXT FK -> users.uid)
-- 2. IDs internos de registros permanecem `UUID`:
--    - public.friendships.id (UUID)
--    - public.friend_requests.id (UUID)
--    - public.room_participants.id (UUID)
--    - public.matches.match_id (UUID)
--    - public.match_history.id, match_id (UUID)
-- 3. Nenhuma policy RLS ou função RPC utiliza `auth.uid()` (que força cast `::uuid`
--    e causa `22P02: invalid input syntax for type uuid`). Toda verificação de
--    identidade utiliza `public.firebase_uid()` (`RETURNS text`).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. TABELAS (CREATE TABLE IF NOT EXISTS — PRESERVA TABELAS E DADOS EXISTENTES)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.users (
  uid text PRIMARY KEY CHECK (char_length(btrim(uid)) >= 1 AND char_length(uid) <= 128),
  display_name text NOT NULL DEFAULT 'Jogador',
  tag_code text NOT NULL UNIQUE,
  avatar_url text,
  status text NOT NULL DEFAULT 'online',
  current_room_code text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.presences (
  user_id text PRIMARY KEY REFERENCES public.users(uid) ON DELETE CASCADE,
  is_online boolean DEFAULT false,
  last_seen timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id_1 text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  user_id_2 text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.friend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  receiver_id text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rooms (
  room_code text PRIMARY KEY,
  host_id text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  room_name text NOT NULL,
  mode text NOT NULL DEFAULT '4v4',
  visibility text NOT NULL DEFAULT 'public',
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'loading', 'playing', 'finished')),
  max_players integer NOT NULL DEFAULT 8,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.room_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code text NOT NULL REFERENCES public.rooms(room_code) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  team text,
  character_id text,
  is_ready boolean DEFAULT false,
  is_loading_ready boolean DEFAULT false,
  joined_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.matches (
  match_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code text NOT NULL REFERENCES public.rooms(room_code) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'playing',
  home_goals integer DEFAULT 0,
  away_goals integer DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.match_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.matches(match_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  team text NOT NULL,
  goals integer DEFAULT 0,
  result text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- ============================================================================
-- 2. IDENTIDADE FIREBASE JWT (100% TEXT — NUNCA CHAMA auth.uid())
-- ============================================================================

CREATE OR REPLACE FUNCTION public.firebase_jwt_claims()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
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
SET search_path = pg_catalog, public
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

  IF v_iss <> 'https://securetoken.google.com/gen-lang-client-0384619138' THEN
    RETURN NULL;
  END IF;

  IF v_aud <> 'gen-lang-client-0384619138' THEN
    RETURN NULL;
  END IF;

  IF v_sub IS NULL OR char_length(v_sub) < 1 OR char_length(v_sub) > 128 THEN
    RETURN NULL;
  END IF;

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
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_clean text;
BEGIN
  v_clean := upper(regexp_replace(COALESCE(p_seed, ''), '[^a-zA-Z0-9]', '', 'g'));
  v_clean := rpad(substr(v_clean, 1, 4), 4, '9');
  RETURN '#STF' || v_clean;
END;
$$;

COMMIT;
