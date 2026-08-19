-- Final profile INSERT hardening applied to production.
CREATE OR REPLACE FUNCTION public.protect_profile_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF lower(COALESCE(NEW.email,'')) IN ('kontakt@logopedaostroda.pl','ziomekzpolski@yahoo.com') THEN
    NEW.role := 'therapist';
  ELSE
    NEW.role := 'patient';
    NEW.profile_locked := COALESCE(NEW.profile_locked, false);
    NEW.private_notes := '';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_profile_insert ON public.profiles;
CREATE TRIGGER protect_profile_insert BEFORE INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.protect_profile_insert();
ALTER FUNCTION public.protect_profile_insert() SET search_path = public;
