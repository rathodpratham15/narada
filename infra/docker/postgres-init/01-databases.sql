-- Runs once, when the data volume is first created.
-- The test database is separate so integration tests never touch development data.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DATABASE narada_test OWNER narada;
