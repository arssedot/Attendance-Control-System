CREATE TABLE attendance_geolocations (
    session_id uuid NOT NULL,
    student_id uuid NOT NULL,
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    horizontal_accuracy double precision NOT NULL CHECK (horizontal_accuracy > 0 AND horizontal_accuracy <= 100000),
    PRIMARY KEY (session_id, student_id),
    FOREIGN KEY (session_id, student_id) REFERENCES attendance (session_id, student_id) ON DELETE CASCADE
);
