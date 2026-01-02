import os
import json
from openai import OpenAI

# LLM client - uses your OpenAI key from Replit Secrets
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def generate_master_objections_outline(text, skeleton):
    prompt = f"""
    You are an expert critic. Generate 15-30 strong objections to this reconstruction.
    Stay consistent with the skeleton.
    Skeleton: {json.dumps(skeleton)}
    Text (first part): {text[:8000]}

    Output ONLY valid JSON in this format:
    {{
      "objections": ["1. Severity: Devastating - Text: full objection here", "2. Severity: Forceful - ..."],
      "key_terms": {{}},
      "commitment_ledger": []
    }}
    """
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"}
    )
    return json.loads(response.choices[0].message.content)


def generate_chunk_objections(chunk, obj_skeleton, recon_skeleton):
    prompt = f"""
    Generate 3-8 objections that target ONLY this chunk.
    Strictly honor both skeletons - no contradictions, consistent terms.
    Chunk text: {chunk}
    Objections skeleton: {json.dumps(obj_skeleton)}
    Reconstruction skeleton: {json.dumps(recon_skeleton)}

    Output ONLY valid JSON:
    {{
      "objections": ["Objection text 1", "Objection text 2"],
      "delta": {{
        "new_objections": ["same as above"],
        "conflicts": []
      }}
    }}
    """
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"}
    )
    return json.loads(response.choices[0].message.content)


def stitch_objections(obj_skeleton, chunk_deltas):
    prompt = f"""
    Combine all chunk deltas into one final coherent list of objections.
    Remove duplicates, resolve any conflicts, rank from most devastating to minor.
    Use the objections skeleton for consistency.

    Skeleton: {json.dumps(obj_skeleton)}
    All deltas: {json.dumps(chunk_deltas)}

    Output ONLY a plain numbered list like:
    1. Severity: Devastating - ...
    2. Severity: Forceful - ...
    ...
    No JSON, no extra text.
    """
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content