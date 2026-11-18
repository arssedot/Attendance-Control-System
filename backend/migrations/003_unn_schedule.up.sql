ALTER TABLE groups
    ADD COLUMN unn_id bigint UNIQUE CHECK (unn_id > 0),
    ADD COLUMN unn_code text,
    ADD CHECK ((unn_id IS NULL) = (unn_code IS NULL));

ALTER TABLE users
    ADD COLUMN unn_id bigint UNIQUE CHECK (unn_id IS NULL OR (unn_id > 0 AND role = 'ROLE_TEACHER'));

ALTER TABLE buildings ADD COLUMN unn_name text UNIQUE;

ALTER TABLE schedule
    ALTER COLUMN teacher_id DROP NOT NULL,
    ALTER COLUMN building_id DROP NOT NULL,
    ADD COLUMN unn_event_id bigint CHECK (unn_event_id > 0),
    ADD COLUMN unn_teacher_name text,
    ADD COLUMN unn_building_name text,
    ADD COLUMN unn_cancelled boolean NOT NULL DEFAULT false,
    ADD UNIQUE (group_id, unn_event_id),
    ADD CHECK (unn_event_id IS NOT NULL OR (teacher_id IS NOT NULL AND building_id IS NOT NULL));
