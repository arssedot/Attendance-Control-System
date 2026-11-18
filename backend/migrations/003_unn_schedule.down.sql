DELETE FROM schedule sc
WHERE sc.unn_event_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sessions se WHERE se.schedule_id = sc.id);

ALTER TABLE schedule
    DROP COLUMN unn_event_id,
    DROP COLUMN unn_teacher_name,
    DROP COLUMN unn_building_name,
    DROP COLUMN unn_cancelled,
    ALTER COLUMN teacher_id SET NOT NULL,
    ALTER COLUMN building_id SET NOT NULL;

ALTER TABLE buildings DROP COLUMN unn_name;
ALTER TABLE users DROP COLUMN unn_id;
ALTER TABLE groups DROP COLUMN unn_id, DROP COLUMN unn_code;
