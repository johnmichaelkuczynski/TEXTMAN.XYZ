import os
from database import (
    get_reconstruction,  # You need this function - add later if missing
    save_objections_skeleton,
    save_objection_chunk,
    save_final_objections
)
from objections_service import (
    generate_master_objections_outline,
    generate_chunk_objections,
    stitch_objections
)
from utils import chunk_text  # Create utils.py next if missing

def run_objections_pipeline(document_id):
    # Get Stage 1 output
    recon = get_reconstruction(document_id)  # Returns object with .global_skeleton and .final_output
    skeleton = recon.global_skeleton
    text = recon.final_output

    # Pass 1: Master outline
    obj_skeleton = generate_master_objections_outline(text, skeleton)
    save_objections_skeleton(document_id, obj_skeleton)

    # Chunk the reconstruction text
    chunks = chunk_text(text, max_words=800)

    # Pass 2: Per-chunk objections
    chunk_deltas = []
    for i, chunk in enumerate(chunks):
        result = generate_chunk_objections(chunk, obj_skeleton, skeleton)
        output = "\n".join(result["objections"])
        delta = result["delta"]
        save_objection_chunk(document_id, i, chunk, output, delta)
        chunk_deltas.append(delta)

    # Pass 3: Stitch
    final_objections = stitch_objections(obj_skeleton, chunk_deltas)
    save_final_objections(document_id, final_objections)

    return final_objections