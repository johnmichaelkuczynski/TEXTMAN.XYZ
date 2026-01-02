import os
import uuid
from datetime import datetime
import psycopg2
from psycopg2.extras import Json

# Replit-friendly connection using DATABASE_URL secret
DB_CONN = psycopg2.connect(os.getenv("DATABASE_URL"))

# ========= MIGRATION =========
MIGRATION_SQL = """
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS reconstruction_objections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL,
    objections_skeleton JSONB,
    final_objections TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS objection_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT,
    objections_text TEXT,
    delta JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_objection_chunks_doc ON objection_chunks(document_id);
"""

def run_migration():
    with DB_CONN.cursor() as cur:
        cur.execute(MIGRATION_SQL)
    DB_CONN.commit()
    print("Objections tables created successfully!")

# ========= SAVE FUNCTIONS =========
def save_objections_skeleton(document_id: str, skeleton: dict):
    with DB_CONN.cursor() as cur:
        cur.execute("""
            INSERT INTO reconstruction_objections (document_id, objections_skeleton)
            VALUES (%s, %s)
            ON CONFLICT (document_id) DO UPDATE 
            SET objections_skeleton = EXCLUDED.objections_skeleton
        """, (document_id, Json(skeleton)))
    DB_CONN.commit()

def save_objection_chunk(document_id: str, index: int, chunk_text: str, objections_text: str, delta: dict):
    with DB_CONN.cursor() as cur:
        cur.execute("""
            INSERT INTO objection_chunks 
            (document_id, chunk_index, chunk_text, objections_text, delta)
            VALUES (%s, %s, %s, %s, %s)
        """, (document_id, index, chunk_text, objections_text, Json(delta)))
    DB_CONN.commit()

def save_final_objections(document_id: str, final_text: str):
    with DB_CONN.cursor() as cur:
        cur.execute("""
            UPDATE reconstruction_objections
            SET final_objections = %s, updated_at = CURRENT_TIMESTAMP
            WHERE document_id = %s
        """, (final_text, document_id))
    DB_CONN.commit()

# Optional fetch
def get_reconstruction(document_id: str):
    with DB_CONN.cursor() as cur:
        cur.execute("""
            SELECT global_skeleton, final_output 
            FROM reconstruction_documents 
            WHERE id = %s
        """, (document_id,))
        row = cur.fetchone()
        if row:
            return type('obj', (object,), {
                'global_skeleton': row[0],
                'final_output': row[1]
            })
        return None