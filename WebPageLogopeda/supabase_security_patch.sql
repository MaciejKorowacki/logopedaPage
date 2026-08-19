-- ============================================================================
-- SECURITY PATCH – 2026-08-19
-- Applied to the production Supabase project dclbsucsccsegvpmmgdn.
-- Run only on a database that has the original schema; this file documents
-- the hardening migrations committed with the application.
-- ============================================================================

ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE public.appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('scheduled','confirmed','cancelled','reschedule_requested','reschedule_proposed'));

CREATE TABLE IF NOT EXISTS public.patient_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  dob DATE,
  public_notes TEXT DEFAULT '',
  private_notes TEXT DEFAULT '',
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS patient_invites_email_unique
  ON public.patient_invites (lower(email)) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS patient_invites_email_idx
  ON public.patient_invites (lower(email));
ALTER TABLE public.patient_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Therapist manages patient invites" ON public.patient_invites;
CREATE POLICY "Therapist manages patient invites" ON public.patient_invites
  FOR ALL USING (public.is_therapist()) WITH CHECK (public.is_therapist());

DROP FUNCTION IF EXISTS public.get_account_status(TEXT);
CREATE OR REPLACE FUNCTION public.get_account_status(p_email TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  normalized TEXT := lower(trim(p_email));
  auth_user RECORD;
BEGIN
  IF normalized = '' THEN RETURN 'invalid'; END IF;
  SELECT u.id, u.encrypted_password INTO auth_user
    FROM auth.users u WHERE lower(u.email) = normalized LIMIT 1;
  IF FOUND THEN
    IF coalesce(auth_user.encrypted_password, '') <> '' THEN RETURN 'registered'; END IF;
    RETURN 'setup';
  END IF;
  IF EXISTS (SELECT 1 FROM public.patient_invites i WHERE lower(i.email) = normalized AND i.used_at IS NULL) THEN
    RETURN 'invited';
  END IF;
  RETURN 'new';
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_account_status(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE invite RECORD; user_role TEXT;
BEGIN
  SELECT * INTO invite FROM public.patient_invites
   WHERE lower(email) = lower(NEW.email) AND used_at IS NULL
   ORDER BY created_at DESC LIMIT 1;
  user_role := CASE WHEN lower(NEW.email) IN ('kontakt@logopedaostroda.pl','ziomekzpolski@yahoo.com')
                    THEN 'therapist' ELSE 'patient' END;
  INSERT INTO public.profiles (id,email,role,first_name,last_name,phone,dob,public_notes,private_notes)
  VALUES (NEW.id, NEW.email, user_role,
          COALESCE(invite.first_name, NEW.raw_user_meta_data->>'first_name', ''),
          COALESCE(invite.last_name, NEW.raw_user_meta_data->>'last_name', ''),
          COALESCE(invite.phone, ''), invite.dob,
          COALESCE(invite.public_notes, ''), COALESCE(invite.private_notes, ''))
  ON CONFLICT (id) DO NOTHING;
  IF invite.id IS NOT NULL THEN
    UPDATE public.patient_invites SET used_at = now() WHERE id = invite.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_patient_profile_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() = OLD.id AND NOT public.is_therapist() THEN
    IF NEW.role IS DISTINCT FROM OLD.role OR NEW.profile_locked IS DISTINCT FROM OLD.profile_locked
       OR NEW.email IS DISTINCT FROM OLD.email OR NEW.private_notes IS DISTINCT FROM OLD.private_notes
       OR NEW.favorite_exercises IS DISTINCT FROM OLD.favorite_exercises THEN
      RAISE EXCEPTION 'Pacjent nie może zmieniać pól zabezpieczających profil';
    END IF;
    IF OLD.profile_locked AND (
      NEW.first_name IS DISTINCT FROM OLD.first_name OR NEW.last_name IS DISTINCT FROM OLD.last_name
      OR NEW.phone IS DISTINCT FROM OLD.phone OR NEW.dob IS DISTINCT FROM OLD.dob
      OR NEW.public_notes IS DISTINCT FROM OLD.public_notes) THEN
      RAISE EXCEPTION 'Profil jest zablokowany';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_patient_profile_update ON public.profiles;
CREATE TRIGGER protect_patient_profile_update BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.protect_patient_profile_update();

CREATE OR REPLACE FUNCTION public.protect_patient_appointment_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE proposed_text TEXT; proposed_date TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_therapist() AND OLD.patient_email = public.current_user_email() THEN
    IF NEW.patient_email IS DISTINCT FROM OLD.patient_email OR NEW.patient_name IS DISTINCT FROM OLD.patient_name
       OR NEW.patient_phone IS DISTINCT FROM OLD.patient_phone OR NEW.patient_dob IS DISTINCT FROM OLD.patient_dob
       OR NEW.recurring_parent IS DISTINCT FROM OLD.recurring_parent OR NEW.recurring_type IS DISTINCT FROM OLD.recurring_type THEN
      RAISE EXCEPTION 'Pacjent nie może zmieniać chronionych danych wizyty';
    END IF;
    IF NEW.status = 'cancelled' THEN
      IF NEW.appointment_date IS DISTINCT FROM OLD.appointment_date OR NEW.title IS DISTINCT FROM OLD.title THEN
        RAISE EXCEPTION 'Anulowanie nie może zmieniać terminu ani tytułu wizyty';
      END IF;
    ELSIF NEW.status = 'reschedule_requested' THEN
      IF NEW.appointment_date IS DISTINCT FROM OLD.appointment_date THEN
        RAISE EXCEPTION 'Prośba o przełożenie nie może zmieniać terminu wizyty';
      END IF;
    ELSIF OLD.status = 'reschedule_proposed' AND NEW.status = 'confirmed' THEN
      proposed_text := substring(OLD.title FROM '\[Propozycja logopedy: ([^]]+)\]$');
      IF proposed_text IS NULL THEN RAISE EXCEPTION 'Brak prawidłowej propozycji terminu'; END IF;
      proposed_date := replace(proposed_text, ' ', 'T')::timestamptz;
      IF NEW.appointment_date IS DISTINCT FROM proposed_date THEN
        RAISE EXCEPTION 'Można zaakceptować wyłącznie zaproponowany termin';
      END IF;
    ELSE
      RAISE EXCEPTION 'Pacjent nie może ustawić tego statusu wizyty';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_patient_appointment_update ON public.appointments;
CREATE TRIGGER protect_patient_appointment_update BEFORE UPDATE ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.protect_patient_appointment_update();

DROP POLICY IF EXISTS "Authenticated can insert notifications" ON public.notifications;
CREATE POLICY "Therapist can insert notifications" ON public.notifications
  FOR INSERT WITH CHECK (public.is_therapist());
CREATE POLICY "Patient can create own workflow notifications" ON public.notifications
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL AND NOT public.is_therapist()
    AND patient_email IN ('kontakt@logopedaostroda.pl','ziomekzpolski@yahoo.com')
    AND (type = 'cancel' OR type = 'accepted_therapist' OR type LIKE 'reschedule_therapist:%')
  );

CREATE OR REPLACE FUNCTION public.validate_patient_notification()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE apt_id UUID;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_therapist() THEN
    IF NEW.patient_email NOT IN ('kontakt@logopedaostroda.pl','ziomekzpolski@yahoo.com') THEN
      RAISE EXCEPTION 'Pacjent może kierować workflow notification tylko do gabinetu';
    END IF;
    IF NEW.type LIKE 'reschedule_therapist:%' THEN
      apt_id := split_part(NEW.type, ':', 2)::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.appointments a WHERE a.id = apt_id
        AND a.patient_email = public.current_user_email() AND a.status = 'reschedule_requested') THEN
        RAISE EXCEPTION 'Nieprawidłowa wizyta dla powiadomienia o przełożeniu';
      END IF;
    ELSIF NEW.type NOT IN ('accepted_therapist','cancel') THEN
      RAISE EXCEPTION 'Pacjent nie może tworzyć tego typu powiadomienia';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS validate_patient_notification ON public.notifications;
CREATE TRIGGER validate_patient_notification BEFORE INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.validate_patient_notification();

CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_unique_ci ON public.profiles (lower(email));
