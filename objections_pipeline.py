import os
from database import (
    save_objections_skeleton,
    save_objection_chunk,
    save_final_objections
)
from objections_service import (
    generate_master_objections_outline,
    generate_chunk_objections,
    stitch_objections
)
from utils import chunk_text

def run_objections_pipeline(document_id):
    # Fake data for test - skip DB completely
    recon = type('obj', (object,), {})
    recon.global_skeleton = {
        "thesis": "Emergence is epistemic, not ontological",
        "outline": ["Definitions", "Physics", "Chemistry", "Biology", "Psychology", "Conclusion"],
        "key_terms": {"emergence": "knowledge limitation", "aggregative": "property of pluralities"},
        "commitment_ledger": ["consciousness not explained by emergence", "Searle analogy fails"]
    }
    recon.final_output = """
    Emergence is an epistemic notion. Consciousness cannot be explained by calling it emergent.
    Air pressure was explained by kinetic theory, not by calling it emergent.
    The same pattern holds in physics, chemistry, biology.
    Relativity showed mass non-additive. Chemical reactions became predictable with quantum mechanics.
    """ * 300

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