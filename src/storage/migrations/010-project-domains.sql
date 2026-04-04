-- 010-project-domains.sql
-- Custom domains per project

CREATE TABLE IF NOT EXISTS project_domains (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon        TEXT DEFAULT 'tag',
    sort_order  INT DEFAULT 0,
    is_default  BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_project_domains_project ON project_domains(project_id);

-- Migrate existing domains from projects.domains TEXT[] into project_domains
-- Uses DOMAIN_INFO mapping for names and icons
DO $$
DECLARE
    proj RECORD;
    d TEXT;
    idx INT;
    domain_name TEXT;
    domain_icon TEXT;
    domain_desc TEXT;
BEGIN
    FOR proj IN SELECT id, domains FROM projects LOOP
        idx := 0;
        IF proj.domains IS NOT NULL THEN
            FOREACH d IN ARRAY proj.domains LOOP
                -- Map known domain slugs to human-readable names, icons and descriptions
                CASE d
                    WHEN 'backend'        THEN domain_name := 'Backend';        domain_icon := 'server';     domain_desc := 'Серверная логика, API, бизнес-логика';
                    WHEN 'frontend'       THEN domain_name := 'Frontend';       domain_icon := 'monitor';    domain_desc := 'Клиентская часть, UI/UX';
                    WHEN 'infrastructure' THEN domain_name := 'Infrastructure'; domain_icon := 'network';    domain_desc := 'Инфраструктура, сети, серверы';
                    WHEN 'devops'         THEN domain_name := 'DevOps';         domain_icon := 'container';  domain_desc := 'CI/CD, деплой, мониторинг';
                    WHEN 'database'       THEN domain_name := 'Database';       domain_icon := 'database';   domain_desc := 'Базы данных, миграции, схемы';
                    WHEN 'testing'        THEN domain_name := 'Testing';        domain_icon := 'test-tubes'; domain_desc := 'Тестирование, QA';
                    ELSE domain_name := d; domain_icon := 'tag'; domain_desc := '';
                END CASE;

                INSERT INTO project_domains (project_id, slug, name, description, icon, sort_order, is_default)
                VALUES (proj.id, d, domain_name, domain_desc, domain_icon, idx, true)
                ON CONFLICT (project_id, slug) DO NOTHING;

                idx := idx + 1;
            END LOOP;
        END IF;
    END LOOP;
END $$;
