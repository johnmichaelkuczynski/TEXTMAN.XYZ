from objections_pipeline import run_objections_pipeline
import uuid

# Fake document_id
test_id = str(uuid.uuid4())

# Fake Stage 1 output - no DB needed
fake_skeleton = {
    "thesis": "Emergence is epistemic, not ontological",
    "outline": ["Definitions", "Physics", "Chemistry", "Biology", "Psychology", "Conclusion"],
    "key_terms": {"emergence": "knowledge limitation", "aggregative": "property of pluralities"},
    "commitment_ledger": ["consciousness not explained by emergence", "Searle analogy fails"]
}

fake_text = """
Emergence is an epistemic notion. Consciousness cannot be explained by calling it emergent.
Air pressure was explained by kinetic theory, not by calling it emergent.
The same pattern holds in physics, chemistry, biology.
Relativity showed mass non-additive. Chemical reactions became predictable with quantum mechanics.
""" * 300  # long enough for multiple chunks

# Bypass get_reconstruction - inject fake data directly

def mock_get(*args):
    return type('obj', (object,), {
        'global_skeleton': fake_skeleton,
        'final_output': fake_text
    })

get_reconstruction = mock_get   # <--- ONLY THIS LINE

print("Running objections pipeline on fake data...")
result = run_objections_pipeline(test_id)
print("\nFINAL OBJECTIONS:\n")
print(result)