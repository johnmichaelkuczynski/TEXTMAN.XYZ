from pydantic import BaseModel
from typing import List, Dict, Optional
import uuid
from datetime import datetime

# Existing reconstruction models (add if not present elsewhere)
class GlobalSkeleton(BaseModel):
    thesis: str
    outline: List[str]
    key_terms: Dict[str, str]
    commitment_ledger: List[str]
    entities: Optional[List[str]] = None
    audience: Optional[str] = None
    rigor_level: Optional[str] = None

# New models for Objections stage
class ObjectionsSkeleton(BaseModel):
    master_outline: List[str]                  # e.g., ["1. Severity: Forceful - Text: ..."]
    key_terms: Dict[str, str]                  # inherited + new if any
    commitment_ledger: List[str]               # from Stage 1 + objections-specific

class ObjectionChunkDelta(BaseModel):
    new_objections: List[str]
    terms_used: List[str]
    conflicts: Optional[List[str]] = None

class FinalObjections(BaseModel):
    objections: List[str]                      # final numbered list
    severity_summary: Optional[Dict[str, int]] = None  # e.g., {"devastating": 4, "forceful": 15}
