-- Kerry coaching dashboard: single-row credential store (bcrypt hash only).
-- Default password matches legacy NEXT_PUBLIC_DASHBOARD_PASSWORD fallback: Athleat2025
-- Change via Settings in the dashboard (authenticated) or UPDATE this row manually.

CREATE TABLE IF NOT EXISTS public.dashboard_credentials (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.dashboard_credentials (id, password_hash)
VALUES (
  1,
  '$2b$12$HPDvY.hcBOUh8GLxDnLmZOE5wvOQz/S2dgh3FIgvs0qJtFWNrXfka'
)
ON CONFLICT (id) DO NOTHING;
