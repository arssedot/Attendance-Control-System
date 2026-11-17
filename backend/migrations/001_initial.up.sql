CREATE TABLE groups (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE
);

CREATE TABLE buildings (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    radius_m integer NOT NULL CHECK (radius_m > 0),
    max_accuracy_m integer NOT NULL CHECK (max_accuracy_m BETWEEN 1 AND radius_m)
);

CREATE TABLE users (
    id uuid PRIMARY KEY,
    login text NOT NULL UNIQUE CHECK (login = lower(login)),
    display_name text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('ROLE_TEACHER', 'ROLE_STUDENT')),
    group_id uuid REFERENCES groups (id),
    CHECK ((role = 'ROLE_STUDENT') = (group_id IS NOT NULL))
);
CREATE INDEX users_group_idx ON users (group_id);

CREATE TABLE schedule (
    id uuid PRIMARY KEY,
    subject text NOT NULL,
    group_id uuid NOT NULL REFERENCES groups (id),
    teacher_id uuid NOT NULL REFERENCES users (id),
    building_id uuid NOT NULL REFERENCES buildings (id),
    room text NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    CHECK (ends_at > starts_at)
);
CREATE INDEX schedule_teacher_start_idx ON schedule (teacher_id, starts_at, id);
CREATE INDEX schedule_group_start_idx ON schedule (group_id, starts_at, id);
CREATE INDEX schedule_building_idx ON schedule (building_id);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    schedule_id uuid NOT NULL UNIQUE REFERENCES schedule (id),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    late_at timestamptz NOT NULL,
    closed_at timestamptz,
    qr_version uuid NOT NULL,
    CHECK (expires_at > issued_at)
);

CREATE TABLE attendance (
    session_id uuid NOT NULL REFERENCES sessions (id),
    student_id uuid NOT NULL REFERENCES users (id),
    created_at timestamptz NOT NULL,
    method text NOT NULL CHECK (method IN ('QR', 'GEO')),
    status text NOT NULL CHECK (status IN ('PRESENT', 'LATE')),
    PRIMARY KEY (session_id, student_id)
);
CREATE INDEX attendance_student_time_idx ON attendance (student_id, created_at DESC, session_id);
CREATE INDEX attendance_session_time_idx ON attendance (session_id, created_at, student_id);

CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id),
    refresh_id uuid NOT NULL UNIQUE,
    client text NOT NULL CHECK (client IN ('web', 'mobile')),
    expires_at timestamptz NOT NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);
