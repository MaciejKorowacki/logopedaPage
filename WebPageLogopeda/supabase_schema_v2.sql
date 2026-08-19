-- ============================================================
-- SCHEMAT BAZY DANYCH v2 – GABINET NEUROLOGOPEDYCZNY
-- „Logopeda Neurologopeda A. Korowacka"
-- ============================================================
-- Uruchom ten skrypt w SQL Editor w Supabase Dashboard
-- ============================================================

-- 0. CZYSZCZENIE (start od zera)
DROP TABLE IF EXISTS public.favorite_exercises CASCADE;
DROP TABLE IF EXISTS public.notifications CASCADE;
DROP TABLE IF EXISTS public.reschedule_requests CASCADE;
DROP TABLE IF EXISTS public.exercises CASCADE;
DROP TABLE IF EXISTS public.appointments CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS public.is_therapist() CASCADE;
DROP FUNCTION IF EXISTS public.current_user_email() CASCADE;

-- 1. ROZSZERZENIE UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. TABELA PROFILES
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'patient' CHECK (role IN ('therapist', 'patient')),
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    dob DATE,
    public_notes TEXT DEFAULT '',
    private_notes TEXT DEFAULT '',
    profile_locked BOOLEAN DEFAULT false,
    favorite_exercises JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. TABELA EXERCISES (globalne, bez patient_email)
CREATE TABLE public.exercises (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    link TEXT DEFAULT '',
    months INTEGER[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. TABELA FAVORITE_EXERCISES
CREATE TABLE public.favorite_exercises (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    exercise_id UUID NOT NULL REFERENCES public.exercises(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, exercise_id)
);

-- 5. TABELA APPOINTMENTS
CREATE TABLE public.appointments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_email TEXT NOT NULL,
    patient_name TEXT DEFAULT '',
    patient_phone TEXT DEFAULT '',
    patient_dob DATE,
    title TEXT NOT NULL,
    appointment_date TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'cancelled', 'reschedule_requested')),
    recurring_parent UUID,
    recurring_type TEXT DEFAULT 'weekly' CHECK (recurring_type IN ('weekly', 'biweekly', 'monthly')),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. TABELA RESCHEDULE_REQUESTS
CREATE TABLE public.reschedule_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id UUID NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
    original_date TIMESTAMPTZ NOT NULL,
    requested_date TIMESTAMPTZ NOT NULL,
    patient_email TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. TABELA NOTIFICATIONS
CREATE TABLE public.notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type TEXT NOT NULL CHECK (
      type IN ('cancel', 'reschedule', 'info', 'broadcast', 'accepted_patient', 'accepted_therapist')
      OR type ~ '^(reschedule_therapist|reschedule_patient):.+$'
    ),
    patient_email TEXT NOT NULL,
    patient_name TEXT DEFAULT '',
    appointment_date TIMESTAMPTZ,
    appointment_title TEXT DEFAULT '',
    new_date TIMESTAMPTZ,
    message TEXT DEFAULT '',
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 8. FUNKCJE POMOCNICZE (SECURITY DEFINER – MUSZĄ BYĆ PRZED RLS)
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_therapist()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'therapist'
  );
$$;

CREATE OR REPLACE FUNCTION public.current_user_email()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT email FROM public.profiles WHERE id = auth.uid();
$$;

-- ============================================================
-- 9. ROW LEVEL SECURITY (RLS) – po utworzeniu funkcji
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exercises ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorite_exercises ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reschedule_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- ---- PROFILES ----

CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Therapist can view all profiles" ON public.profiles
    FOR SELECT USING (public.is_therapist());

CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

CREATE POLICY "Therapist can update any profile" ON public.profiles
    FOR UPDATE USING (public.is_therapist())
    WITH CHECK (public.is_therapist());

-- ---- EXERCISES ----

CREATE POLICY "Authenticated can view exercises" ON public.exercises
    FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "Therapist can insert exercises" ON public.exercises
    FOR INSERT WITH CHECK (public.is_therapist());

CREATE POLICY "Therapist can update exercises" ON public.exercises
    FOR UPDATE USING (public.is_therapist());

CREATE POLICY "Therapist can delete exercises" ON public.exercises
    FOR DELETE USING (public.is_therapist());

-- ---- FAVORITE_EXERCISES ----

CREATE POLICY "Users manage own favorites" ON public.favorite_exercises
    FOR ALL USING (auth.uid() = user_id);

-- ---- APPOINTMENTS ----

CREATE POLICY "Therapist sees all appointments" ON public.appointments
    FOR SELECT USING (public.is_therapist());

CREATE POLICY "Patient sees own appointments" ON public.appointments
    FOR SELECT USING (patient_email = public.current_user_email());

CREATE POLICY "Therapist can insert appointments" ON public.appointments
    FOR INSERT WITH CHECK (public.is_therapist());

CREATE POLICY "Therapist can update appointments" ON public.appointments
    FOR UPDATE USING (public.is_therapist());

CREATE POLICY "Patient can update own appointment status" ON public.appointments
    FOR UPDATE USING (patient_email = public.current_user_email());

-- ---- RESCHEDULE_REQUESTS ----

CREATE POLICY "Therapist can view all reschedule_requests" ON public.reschedule_requests
    FOR SELECT USING (public.is_therapist());

CREATE POLICY "Patient can view own reschedule_requests" ON public.reschedule_requests
    FOR SELECT USING (patient_email = public.current_user_email());

CREATE POLICY "Patient can insert reschedule_requests" ON public.reschedule_requests
    FOR INSERT WITH CHECK (patient_email = public.current_user_email());

CREATE POLICY "Therapist can update reschedule_requests" ON public.reschedule_requests
    FOR UPDATE USING (public.is_therapist());

-- ---- NOTIFICATIONS ----

CREATE POLICY "Therapist sees all notifs" ON public.notifications
    FOR SELECT USING (public.is_therapist());

CREATE POLICY "Patient sees own notifs" ON public.notifications
    FOR SELECT USING (patient_email = public.current_user_email());

CREATE POLICY "Authenticated can insert notifications" ON public.notifications
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Therapist can update notifications" ON public.notifications
    FOR UPDATE USING (public.is_therapist());

CREATE POLICY "Patient can update own notifications" ON public.notifications
    FOR UPDATE USING (patient_email = public.current_user_email());

-- ============================================================
-- 10. TRIGGER: AUTOMATYCZNE TWORZENIE PROFILU
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    user_role TEXT;
BEGIN
    IF NEW.email IN ('kontakt@logopedaostroda.pl','ziomekzpolski@yahoo.com') THEN
        user_role := 'therapist';
    ELSE
        user_role := 'patient';
    END IF;

    INSERT INTO public.profiles (id, email, role, first_name, last_name)
    VALUES (
        NEW.id,
        NEW.email,
        user_role,
        COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
        COALESCE(NEW.raw_user_meta_data->>'last_name', '')
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 11. INDEKSY
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_appointments_patient_email ON public.appointments(patient_email);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON public.appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON public.appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_recurring ON public.appointments(recurring_parent);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON public.favorite_exercises(user_id);
CREATE INDEX IF NOT EXISTS idx_favorites_exercise ON public.favorite_exercises(exercise_id);
CREATE INDEX IF NOT EXISTS idx_reschedule_appointment ON public.reschedule_requests(appointment_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON public.notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON public.notifications(is_read);

-- ============================================================
-- KONIEC SCHEMATU v2
-- ============================================================