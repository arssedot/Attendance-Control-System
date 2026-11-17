WITH clock AS (
    SELECT date_trunc('day', now(), 'Europe/Moscow') AS local_day, now() AS now_at
), lessons AS (
    SELECT *
    FROM clock
    CROSS JOIN LATERAL (VALUES
        ('oop', 'Объектно-ориентированное проектирование', '304',
            greatest(local_day, now_at - interval '2 minutes'), interval '90 minutes'),
        ('db', 'Базы данных', '212',
            now_at + interval '100 minutes', interval '90 minutes'),
        ('architecture', 'Архитектура программных систем', '411',
            local_day + interval '1 day 10 hours', interval '90 minutes')
    ) AS slots (key, subject, room, starts_at, duration)
)
INSERT INTO schedule (id, subject, group_id, teacher_id, building_id, room, starts_at, ends_at)
SELECT
    md5(key || to_char(local_day AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD'))::uuid,
    subject, '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', room, starts_at, starts_at + duration
FROM lessons
ON CONFLICT DO NOTHING;
