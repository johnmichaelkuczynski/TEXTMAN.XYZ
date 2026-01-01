import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  generateDocumentId,
  createInitialState,
  initializeCoherenceRun,
  readCoherenceState,
  updateCoherenceState,
  writeChunkEvaluation,
  readAllChunkEvaluations,
  applyStateUpdate,
  checkViolations
} from "./coherenceDatabase";
import type { 
  CoherenceState, 
  CoherenceModeType, 
  ChunkEvaluationResult 
} from "@shared/schema";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Chunk text into segments of ~1000 words
function chunkText(text: string, maxWords: number = 1000): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(" "));
  }
  
  return chunks;
}

// Build the evaluation prompt for a chunk
function buildEvaluationPrompt(
  mode: CoherenceModeType,
  currentState: CoherenceState,
  chunkText: string,
  chunkIndex: number,
  totalChunks: number
): string {
  return `COHERENCE MODE: ${mode}

CURRENT STATE (from database):
${JSON.stringify(currentState, null, 2)}

CHUNK ${chunkIndex + 1} OF ${totalChunks}:
${chunkText}

TASK:
1. Evaluate whether this chunk continues, refines, or breaks the coherence state
2. Identify any state violations with specific locations
3. Propose minimal repairs if violations found
4. Return updated state reflecting this chunk's contributions

EVALUATION CRITERIA FOR ${mode.toUpperCase()}:
${getEvaluationCriteria(mode)}

OUTPUT FORMAT (respond with ONLY valid JSON, no markdown):
{
  "status": "preserved" | "weakened" | "broken",
  "violations": [{"location": "...", "type": "...", "description": "..."}],
  "repairs": [{"location": "...", "suggestion": "..."}],
  "state_update": {[fields to update in STATE based on this chunk's content]}
}

IMPORTANT:
- Never return "error", "cannot evaluate", or null
- Always return status + violations + repairs + state_update
- If no violations, return empty arrays, not nulls
- Repairs must be minimal and local - do not rewrite chunks
- state_update should contain ONLY the changes/additions from this chunk`;
}

function getEvaluationCriteria(mode: CoherenceModeType): string {
  switch (mode) {
    case "logical-consistency":
      return `- PASS: no contradiction with prior assertions
- FAIL: asserts X when ¬X already asserted, or asserts both members of a disjoint pair`;
    
    case "logical-cohesiveness":
      return `- PASS: advances argument, discharges support obligations, maintains stage progression
- FAIL: restates without advancing, skips required bridges, regresses stage`;
    
    case "scientific-explanatory":
      return `- PASS: extends causal graph, maintains level or bridges explicitly, keeps feedback loops active
- FAIL: resets to slogan, drops mechanism, changes level without link`;
    
    case "thematic-psychological":
      return `- PASS: continues affect or signals transition
- FAIL: abrupt mood break, unexplained tempo shift`;
    
    case "instructional":
      return `- PASS: follows logical step order, respects prereqs
- FAIL: assumes unestablished prereqs, skips steps, leaves loops open`;
    
    case "motivational":
      return `- PASS: maintains direction or escalates/de-escalates smoothly
- FAIL: reverses direction, jumps >2 intensity levels`;
    
    case "mathematical":
      return `- PASS: uses only established lemmas, maintains proof method
- FAIL: uses unproved results, circular reasoning`;
    
    case "philosophical":
      return `- PASS: concepts stable, distinctions maintained, dialectic progressed
- FAIL: equivocation, collapsed distinction, unanswered objection`;
    
    default:
      return "";
  }
}

// Auto-detect coherence mode from first chunk
async function autoDetectMode(firstChunk: string): Promise<CoherenceModeType> {
  const prompt = `Analyze this text and determine its dominant coherence mode.

TEXT:
${firstChunk.substring(0, 2000)}

Choose ONE mode from:
- logical-consistency: Arguments with claims that could contradict
- logical-cohesiveness: Structured arguments with thesis and support
- scientific-explanatory: Causal explanations with mechanisms
- thematic-psychological: Emotional/tonal narrative
- instructional: Step-by-step instructions or procedures
- motivational: Encouragement, warnings, or persuasion
- mathematical: Mathematical proofs or formal derivations
- philosophical: Conceptual analysis with distinctions

Respond with ONLY the mode name (e.g., "logical-consistency"), no explanation.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 50
    });

    const mode = response.choices[0]?.message?.content?.trim().toLowerCase() as CoherenceModeType;
    const validModes: CoherenceModeType[] = [
      "logical-consistency", "logical-cohesiveness", "scientific-explanatory",
      "thematic-psychological", "instructional", "motivational",
      "mathematical", "philosophical"
    ];

    if (validModes.includes(mode)) {
      return mode;
    }
    return "logical-cohesiveness"; // Default fallback
  } catch (error) {
    console.error("Auto-detect mode error:", error);
    return "logical-cohesiveness";
  }
}

// Evaluate a single chunk using AI
async function evaluateChunk(
  mode: CoherenceModeType,
  currentState: CoherenceState,
  chunkText: string,
  chunkIndex: number,
  totalChunks: number,
  provider: "openai" | "anthropic" = "openai"
): Promise<ChunkEvaluationResult> {
  const prompt = buildEvaluationPrompt(mode, currentState, chunkText, chunkIndex, totalChunks);

  try {
    let responseText: string;

    if (provider === "anthropic") {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }]
      });
      responseText = response.content[0].type === "text" ? response.content[0].text : "";
    } else {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: "json_object" }
      });
      responseText = response.choices[0]?.message?.content || "";
    }

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const parsed = JSON.parse(jsonMatch[0]) as ChunkEvaluationResult;

    // Validate and normalize response
    return {
      status: parsed.status || "preserved",
      violations: parsed.violations || [],
      repairs: parsed.repairs || [],
      state_update: parsed.state_update || {}
    };
  } catch (error) {
    console.error(`Chunk ${chunkIndex} evaluation error:`, error);
    // Return safe default on error
    return {
      status: "preserved",
      violations: [],
      repairs: [],
      state_update: {}
    };
  }
}

// Extract initial state from first chunk
async function extractInitialState(
  mode: CoherenceModeType,
  firstChunk: string,
  provider: "openai" | "anthropic" = "openai"
): Promise<CoherenceState> {
  const baseState = createInitialState(mode);
  
  const prompt = `Analyze this text and extract the initial coherence state for ${mode} mode.

TEXT:
${firstChunk}

CURRENT STATE TEMPLATE:
${JSON.stringify(baseState, null, 2)}

Extract and populate the state fields based on what this chunk establishes.
Respond with ONLY valid JSON matching the state template structure.`;

  try {
    let responseText: string;

    if (provider === "anthropic") {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }]
      });
      responseText = response.content[0].type === "text" ? response.content[0].text : "";
    } else {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: "json_object" }
      });
      responseText = response.choices[0]?.message?.content || "";
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return baseState;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return { ...baseState, ...parsed, mode } as CoherenceState;
  } catch (error) {
    console.error("Extract initial state error:", error);
    return baseState;
  }
}

// Main sequential processing function
export async function processDocumentSequentially(
  text: string,
  mode?: CoherenceModeType,
  provider: "openai" | "anthropic" = "openai"
): Promise<{
  documentId: string;
  mode: CoherenceModeType;
  chunks: {
    index: number;
    status: "preserved" | "weakened" | "broken";
    violations: { location: string; type: string; description: string }[];
    repairs: { location: string; suggestion: string }[];
  }[];
  finalState: CoherenceState;
  overallStatus: "coherent" | "weakened" | "incoherent";
  summary: string;
}> {
  // Step 1: Generate document ID and chunk text
  const documentId = generateDocumentId();
  const chunks = chunkText(text, 1000);
  
  // Step 2: Auto-detect mode if not provided
  const coherenceMode = mode || await autoDetectMode(chunks[0]);
  
  // Step 3: Process chunk 0 - extract initial state
  const initialState = await extractInitialState(coherenceMode, chunks[0], provider);
  await initializeCoherenceRun(documentId, coherenceMode, initialState);
  
  // Evaluate first chunk
  const firstEval = await evaluateChunk(coherenceMode, initialState, chunks[0], 0, chunks.length, provider);
  const firstStateAfter = applyStateUpdate(initialState, firstEval.state_update);
  await updateCoherenceState(documentId, coherenceMode, firstStateAfter);
  await writeChunkEvaluation(documentId, coherenceMode, 0, chunks[0], firstEval, firstStateAfter);

  const chunkResults: {
    index: number;
    status: "preserved" | "weakened" | "broken";
    violations: { location: string; type: string; description: string }[];
    repairs: { location: string; suggestion: string }[];
  }[] = [{
    index: 0,
    status: firstEval.status,
    violations: firstEval.violations,
    repairs: firstEval.repairs
  }];

  // Step 4: Process chunks 1 to N sequentially
  for (let i = 1; i < chunks.length; i++) {
    // READ state from database
    const currentState = await readCoherenceState(documentId, coherenceMode);
    if (!currentState) {
      throw new Error(`Failed to read state for chunk ${i}`);
    }

    // Evaluate chunk against current state
    const evaluation = await evaluateChunk(coherenceMode, currentState, chunks[i], i, chunks.length, provider);
    
    // Check for violations
    const violations = checkViolations(currentState, evaluation.state_update);
    const allViolations = [...evaluation.violations, ...violations];
    
    // Update status based on violations
    let status = evaluation.status;
    if (allViolations.length > 0 && status === "preserved") {
      status = "weakened";
    }

    // Apply state update
    const newState = applyStateUpdate(currentState, evaluation.state_update);
    
    // WRITE updated state to database
    await updateCoherenceState(documentId, coherenceMode, newState);
    
    // Write chunk evaluation
    await writeChunkEvaluation(documentId, coherenceMode, i, chunks[i], {
      ...evaluation,
      violations: allViolations,
      status
    }, newState);

    chunkResults.push({
      index: i,
      status,
      violations: allViolations,
      repairs: evaluation.repairs
    });
  }

  // Step 5: Generate final output
  const finalState = await readCoherenceState(documentId, coherenceMode);
  if (!finalState) {
    throw new Error("Failed to read final state");
  }

  // Determine overall status
  const brokenCount = chunkResults.filter(c => c.status === "broken").length;
  const weakenedCount = chunkResults.filter(c => c.status === "weakened").length;
  
  let overallStatus: "coherent" | "weakened" | "incoherent";
  if (brokenCount > 0) {
    overallStatus = "incoherent";
  } else if (weakenedCount > chunks.length / 3) {
    overallStatus = "weakened";
  } else {
    overallStatus = "coherent";
  }

  // Generate summary
  const summary = generateSummary(coherenceMode, chunkResults, finalState, overallStatus);

  return {
    documentId,
    mode: coherenceMode,
    chunks: chunkResults,
    finalState,
    overallStatus,
    summary
  };
}

function generateSummary(
  mode: CoherenceModeType,
  chunkResults: { index: number; status: string; violations: any[] }[],
  finalState: CoherenceState,
  overallStatus: string
): string {
  const totalChunks = chunkResults.length;
  const preservedCount = chunkResults.filter(c => c.status === "preserved").length;
  const weakenedCount = chunkResults.filter(c => c.status === "weakened").length;
  const brokenCount = chunkResults.filter(c => c.status === "broken").length;
  const totalViolations = chunkResults.reduce((sum, c) => sum + c.violations.length, 0);

  let summary = `COHERENCE ANALYSIS SUMMARY (${mode})\n`;
  summary += `═══════════════════════════════════════\n\n`;
  summary += `Overall Status: ${overallStatus.toUpperCase()}\n\n`;
  summary += `Chunk Analysis:\n`;
  summary += `  • Total chunks: ${totalChunks}\n`;
  summary += `  • Preserved: ${preservedCount} (${Math.round(preservedCount/totalChunks*100)}%)\n`;
  summary += `  • Weakened: ${weakenedCount} (${Math.round(weakenedCount/totalChunks*100)}%)\n`;
  summary += `  • Broken: ${brokenCount} (${Math.round(brokenCount/totalChunks*100)}%)\n`;
  summary += `  • Total violations: ${totalViolations}\n\n`;

  if (totalViolations > 0) {
    summary += `Key Issues Found:\n`;
    for (const chunk of chunkResults) {
      for (const v of chunk.violations.slice(0, 3)) {
        summary += `  • [Chunk ${chunk.index + 1}] ${v.type}: ${v.description}\n`;
      }
    }
  }

  return summary;
}

// Get processing status for a document
export async function getDocumentStatus(
  documentId: string,
  mode: CoherenceModeType
): Promise<{
  state: CoherenceState | null;
  chunks: { chunkIndex: number; status: string; violationCount: number }[];
}> {
  const state = await readCoherenceState(documentId, mode);
  const chunkEvals = await readAllChunkEvaluations(documentId, mode);

  return {
    state,
    chunks: chunkEvals.map(c => ({
      chunkIndex: c.chunkIndex,
      status: c.evaluationResult.status,
      violationCount: c.evaluationResult.violations.length
    }))
  };
}
