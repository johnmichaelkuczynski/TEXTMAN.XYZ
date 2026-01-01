import OpenAI from "openai";
import { db } from "../db";
import { coherentSessions, coherentChunks, stitchResults } from "../../shared/schema";
import { eq, asc, and } from "drizzle-orm";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "default_key",
});

const CHUNK_PAUSE_MS = 15000;
const MAX_WORDS_PER_CHUNK = 1400;
const LLM_TIMEOUT_MS = 180000;
const MAX_CHUNK_RETRIES = 3;
const MAX_REPAIR_ITERATIONS = 4;

// =============================================================================
// TYPES
// =============================================================================
interface SourceClaim {
  id: string;
  claim: string;
  category: string;
  dependencies: string[];
}

interface StructuralRequirement {
  id: string;
  requirement: string;
  appliesTo: "all" | "first" | "middle" | "final";
  verifiable: string;
}

interface GlobalSkeleton {
  sourceClaims: SourceClaim[];
  allowedTopics: string[];
  forbiddenTopics: string[];
  keyTerms: Record<string, string>;
  outputFormat: string;
  structuralRequirements: StructuralRequirement[];
  mustReferenceEarlier: boolean;
  referenceInstructions: string;
  requiresBalance: boolean;
  balanceDescription: string;
  totalTargetWords: number;
  wordsPerChunk: number;
  logicalSections: string[];
  speakerNames?: string[];
}

interface ChunkPlan {
  chunkIndex: number;
  position: "first" | "middle" | "final";
  claimsToAddress: string[];
  structuralRequirementsForThisChunk: string[];
  mustReference: string[];
  targetWords: number;
  section: string;
}

interface ChunkDelta {
  claimsAddressed: string[];
  quotableContent: string[];
  topicsIntroduced: string[];
  wordCount: number;
  speakerBalance?: { speaker1: number; speaker2: number };
  violations: string[];
}

interface StitchValidation {
  claimsCovered: Record<string, boolean>;
  claimsMissing: string[];
  topicViolations: string[];
  structuralViolations: string[];
  balanceIssue: string | null;
  backReferenceCheck: { required: boolean; satisfied: boolean; details: string };
  repairPlan: { chunkIndex: number; issue: string; action: string }[];
  coherenceScore: "pass" | "needs_repair" | "critical_failure";
}

interface StreamEvent {
  type: "skeleton" | "plan" | "chunk" | "pause" | "stitch" | "repair" | "complete" | "error" | "status";
  data?: any;
}

// =============================================================================
// UTILITIES
// =============================================================================
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  expectJson: boolean = false
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await openai.chat.completions.create(
      {
        model: "gpt-5.2",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 4096,
        response_format: expectJson ? { type: "json_object" } : undefined,
      },
      { signal: controller.signal }
    );
    return response.choices[0].message.content || "";
  } finally {
    clearTimeout(timeoutId);
  }
}

async function safeParseJson(result: string): Promise<any> {
  try {
    return JSON.parse(result);
  } catch {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {}
    }
    return null;
  }
}

function computeOptimalWordCount(
  totalTarget: number,
  currentChunk: number,
  totalChunks: number,
  priorWordCounts: number[]
): number {
  const wordsSoFar = priorWordCounts.reduce((sum, wc) => sum + wc, 0);
  const remainingWords = totalTarget - wordsSoFar;
  const remainingChunks = totalChunks - currentChunk;
  return Math.floor(remainingWords / Math.max(1, remainingChunks));
}

async function compareAndModifyChunk(
  chunkOutput: string,
  instructions: string,
  previousChunk: string | null,
  optimalWords: number
): Promise<string> {
  const systemPrompt = `You are a coherence enforcer.
INSTRUCTIONS (first 2000 chars): ${instructions.substring(0, 2000)}
PREVIOUS CHUNK (if any): ${previousChunk ? previousChunk.substring(0, 2000) : "None - this is the first chunk"}
CURRENT CHUNK: ${chunkOutput.substring(0, 4000)}
TASK:
- Ensure perfect flow from previous chunk
- Enforce all user instructions exactly
- Target ~${optimalWords} words (±10%)
- Remove any drift, repetition, or format violation
- Modify only what's necessary; preserve content
- Return the full modified chunk text only
Output the modified chunk. Nothing else.`;
  return await callLLM(systemPrompt, "Modify the chunk.", false);
}

// =============================================================================
// PASS 1: BUILD SKELETON
// =============================================================================
async function buildGlobalSkeleton(
  userPrompt: string,
  inputText: string,
  targetChunks: number
): Promise<GlobalSkeleton> {
  const systemPrompt = `You are analyzing a task to extract BOTH content requirements AND structural requirements.
CONTENT REQUIREMENTS come from the INPUT TEXT - what claims/positions/facts must be addressed.
STRUCTURAL REQUIREMENTS come from the USER PROMPT - how the output must be organized.
Return JSON with this EXACT structure:
{
  "sourceClaims": [
    {"id": "c1", "claim": "Exact claim from input that must be addressed", "category": "topic area", "dependencies": []},
    {"id": "c2", "claim": "Another claim", "category": "topic area", "dependencies": []}
  ],
  "allowedTopics": ["topic1", "topic2"],
  "forbiddenTopics": ["AI ethics", "climate policy", "sustainability", "education reform", "business strategy"],
  "keyTerms": {"term": "definition"},
  "outputFormat": "dialogue" or "essay" or "report" or "analysis",
  "structuralRequirements": [
    {
      "id": "sr1",
      "requirement": "Exact structural requirement from user prompt",
      "appliesTo": "all" or "first" or "middle" or "final",
      "verifiable": "How to check this was satisfied"
    }
  ],
  "mustReferenceEarlier": true or false,
  "referenceInstructions": "How back-references should work",
  "requiresBalance": true or false,
  "balanceDescription": "What balance means for this task",
  "totalTargetWords": <number from prompt or 0>,
  "wordsPerChunk": <totalTargetWords / targetChunks or 800>
}
CRITICAL RULES:
1. sourceClaims must include EVERY distinct position/claim from the input - be exhaustive
2. allowedTopics is a WHITELIST - derive from source claims only
3. forbiddenTopics: ALWAYS include common drift targets not in input (AI ethics, sustainability, modern policy, education, business, etc.)
4. structuralRequirements: capture EVERY formatting/organization requirement from prompt
5. If prompt says "refer to earlier", "reference the beginning", "towards the end refer back", etc. → mustReferenceEarlier=true
6. If prompt says "equally matched", "balanced", "fair debate" → requiresBalance=true
7. If prompt specifies word count → totalTargetWords=that number`;
  const userMessage = `=== USER'S TASK (extract STRUCTURAL requirements) ===
${userPrompt}
=== INPUT TEXT (extract CONTENT requirements - be exhaustive) ===
${inputText}
Extract complete skeleton as JSON.`;
  const result = await callLLM(systemPrompt, userMessage, true);
  const parsed = await safeParseJson(result);
  if (!parsed || !parsed.sourceClaims || parsed.sourceClaims.length === 0) {
    console.error("[Coherence] Skeleton parse failed");
    return {
      sourceClaims: [{ id: "c1", claim: "Process input according to instructions", category: "general", dependencies: [] }],
      allowedTopics: [],
      forbiddenTopics: ["AI ethics", "climate policy", "sustainability"],
      keyTerms: {},
      outputFormat: "text",
      structuralRequirements: [],
      mustReferenceEarlier: false,
      referenceInstructions: "",
      requiresBalance: false,
      balanceDescription: "",
      totalTargetWords: 0,
      wordsPerChunk: 800,
      logicalSections: [],
    };
  }
  parsed.allowedTopics = parsed.allowedTopics || [];
  parsed.forbiddenTopics = parsed.forbiddenTopics || ["AI ethics", "climate policy", "sustainability", "education reform", "business strategy", "modern applications"];
  parsed.structuralRequirements = parsed.structuralRequirements || [];
  parsed.mustReferenceEarlier = parsed.mustReferenceEarlier || false;
  parsed.requiresBalance = parsed.requiresBalance || false;
  parsed.totalTargetWords = parsed.totalTargetWords || 0;
  parsed.wordsPerChunk = parsed.wordsPerChunk || 800;
  parsed.logicalSections = parsed.logicalSections || [];
  return parsed as GlobalSkeleton;
}

function buildChunkPlans(
  skeleton: GlobalSkeleton,
  numChunks: number,
  priorQuotables: string[][]
): ChunkPlan[] {
  const plans: ChunkPlan[] = [];
  const claimsPerChunk = Math.ceil(skeleton.sourceClaims.length / numChunks);
  for (let i = 0; i < numChunks; i++) {
    const position: "first" | "middle" | "final" =
      i === 0 ? "first" : i === numChunks - 1 ? "final" : "middle";
    const startIdx = i * claimsPerChunk;
    const endIdx = Math.min(startIdx + claimsPerChunk, skeleton.sourceClaims.length);
    const claimsToAddress = skeleton.sourceClaims.slice(startIdx, endIdx).map(c => c.id);
    const structuralRequirementsForThisChunk = skeleton.structuralRequirements
      .filter(sr => sr.appliesTo === "all" || sr.appliesTo === position)
      .map(sr => sr.id);
    let mustReference: string[] = [];
    if (position === "final" && skeleton.mustReferenceEarlier && priorQuotables.length > 0) {
      const firstChunkQuotables = priorQuotables[0] || [];
      mustReference = firstChunkQuotables.slice(0, Math.min(5, firstChunkQuotables.length));
    }
    plans.push({
      chunkIndex: i,
      position,
      claimsToAddress,
      structuralRequirementsForThisChunk,
      mustReference,
      targetWords: skeleton.wordsPerChunk,
      section: skeleton.logicalSections[i] || `Section ${i + 1}`,
    });
  }
  return plans;
}

// =============================================================================
// PASS 2: PROCESS CHUNKS WITH FULL ENFORCEMENT
// =============================================================================
async function processChunk(
  plan: ChunkPlan,
  totalChunks: number,
  skeleton: GlobalSkeleton,
  priorDeltas: ChunkDelta[],
  priorOutputs: string[],
  userPrompt: string
): Promise<{ output: string; delta: ChunkDelta }> {
  const claimsForChunk = skeleton.sourceClaims
    .filter(c => plan.claimsToAddress.includes(c.id))
    .map(c => `[${c.id}] ${c.claim}`)
    .join("\n");
  const structuralReqs = skeleton.structuralRequirements
    .filter(sr => plan.structuralRequirementsForThisChunk.includes(sr.id))
    .map(sr => `- ${sr.requirement}`)
    .join("\n");
  let backRefInstructions = "";
  if (plan.position === "final" && skeleton.mustReferenceEarlier && plan.mustReference.length > 0) {
    backRefInstructions = `
=== MANDATORY BACK-REFERENCES ===
You MUST explicitly reference these statements from earlier in the text:
${plan.mustReference.map((q, i) => `${i + 1}. "${q}"`).join("\n")}
USE PHRASES LIKE:
- "As you argued earlier..."
- "Remember when you said..."
- "You initially claimed that..."
- "Going back to your first point about..."
- "This connects to what you said at the start..."
THIS IS MANDATORY. Output will be rejected without these back-references.
`;
  }
  const topicBoundaries = `
=== TOPIC BOUNDARIES (STRICTLY ENFORCED) ===
ALLOWED TOPICS: ${skeleton.allowedTopics.length > 0 ? skeleton.allowedTopics.join(", ") : "ONLY topics from the source claims above"}
FORBIDDEN TOPICS (INSTANT REJECTION):
${skeleton.forbiddenTopics.join(", ")}
If you start writing about ANY forbidden topic, STOP. Delete it. Return to allowed topics.
Do NOT introduce examples from forbidden domains.
Do NOT make analogies to forbidden topics.
Do NOT discuss implications for forbidden areas.
`;
  const priorSummary = priorDeltas.length > 0
    ? priorDeltas.map((d, i) =>
        `Chunk ${i + 1}: Claims ${d.claimsAddressed.join(", ")}. Quotables: "${d.quotableContent.slice(0, 2).join('", "')}"`
      ).join("\n")
    : "This is the first chunk.";
  let balanceInstructions = "";
  if (skeleton.requiresBalance && skeleton.outputFormat === "dialogue") {
    balanceInstructions = `
=== SPEAKER BALANCE (MANDATORY) ===
${skeleton.balanceDescription || "Both speakers must be equally persuasive. Neither consistently wins or concedes."}
- Count exchanges won by each speaker
- If one is dominating, give the other a strong counter
- Do NOT have one speaker always agreeing or backing down
`;
  }
  const systemPrompt = `You are generating chunk ${plan.chunkIndex + 1} of ${totalChunks}.
Position: ${plan.position.toUpperCase()}
Format: ${skeleton.outputFormat}
Target: ~${plan.targetWords} words
=== CLAIMS TO ADDRESS IN THIS CHUNK (address ALL of these) ===
${claimsForChunk}
=== STRUCTURAL REQUIREMENTS ===
${structuralReqs || "None"}
${backRefInstructions}
${topicBoundaries}
${balanceInstructions}
=== PRIOR CHUNKS ===
${priorSummary}
=== KEY TERMS ===
${JSON.stringify(skeleton.keyTerms, null, 2)}
=== USER'S TASK ===
${userPrompt}
RULES:
1. Address ALL your assigned claims
2. Stay STRICTLY within allowed topics
3. If FINAL chunk: include back-references if required
4. Generate "quotableContent" - specific memorable statements later chunks can reference
5. For dialogues: track speaker balance
Return JSON:
{
  "output": "Your generated text",
  "claimsAddressed": ["c1", "c2"],
  "quotableContent": ["Memorable statement 1", "Memorable statement 2", "Memorable statement 3"],
  "topicsIntroduced": ["topic1"],
  "speakerBalance": {"speaker1": 3, "speaker2": 3}
}`;
  const result = await callLLM(systemPrompt, `Generate chunk ${plan.chunkIndex + 1}. Stay on topic. Address all assigned claims.`, true);
  try {
    const parsed = JSON.parse(result);
    return {
      output: parsed.output || "",
      delta: {
        claimsAddressed: parsed.claimsAddressed || [],
        quotableContent: parsed.quotableContent || [],
        topicsIntroduced: parsed.topicsIntroduced || [],
        wordCount: countWords(parsed.output || ""),
        speakerBalance: parsed.speakerBalance,
        violations: [],
      },
    };
  } catch {
    return {
      output: result,
      delta: {
        claimsAddressed: plan.claimsToAddress,
        quotableContent: [],
        topicsIntroduced: [],
        wordCount: countWords(result),
        violations: ["JSON parse failed"],
      },
    };
  }
}
async function validateChunk(
  output: string,
  plan: ChunkPlan,
  skeleton: GlobalSkeleton,
  delta: ChunkDelta
): Promise<{ valid: boolean; violations: string[] }> {
  const violations: string[] = [];
  // 1. Topic validation
  const topicCheckPrompt = `Check if text stays within allowed topics.
ALLOWED: ${skeleton.allowedTopics.join(", ") || "Only topics from source claims"}
FORBIDDEN: ${skeleton.forbiddenTopics.join(", ")}
TEXT:
${output.substring(0, 4000)}
Return JSON:
{
  "staysOnTopic": true/false,
  "forbiddenMentioned": [],
  "driftDescription": null or "description"
}`;
  try {
    const topicResult = await callLLM("Strict topic checker.", topicCheckPrompt, true);
    const parsed = JSON.parse(topicResult);
    if (!parsed.staysOnTopic) {
      violations.push(`TOPIC_DRIFT: ${parsed.driftDescription}`);
    }
    if (parsed.forbiddenMentioned?.length > 0) {
      violations.push(`FORBIDDEN_TOPICS: ${parsed.forbiddenMentioned.join(", ")}`);
    }
  } catch {}
  // 2. Back-reference validation for final chunk
  if (plan.position === "final" && skeleton.mustReferenceEarlier && plan.mustReference.length > 0) {
    const backRefPrompt = `Check for explicit back-references.
MUST REFERENCE:
${plan.mustReference.map((r, i) => `${i + 1}. "${r}"`).join("\n")}
TEXT:
${output}
Return JSON:
{
  "referencesFound": [1, 2],
  "referencesMissing": [3],
  "hasExplicitPhrases": true/false
}`;
    try {
      const backRefResult = await callLLM("Back-reference checker.", backRefPrompt, true);
      const parsed = JSON.parse(backRefResult);
      if (parsed.referencesMissing?.length > 0) {
        violations.push(`MISSING_BACKREFS: ${parsed.referencesMissing.length} of ${plan.mustReference.length} required`);
      }
      if (!parsed.hasExplicitPhrases) {
        violations.push(`NO_BACKREF_PHRASES: Missing "as you said earlier" type phrases`);
      }
    } catch {}
  }
  // 3. Claims coverage
  const missedClaims = plan.claimsToAddress.filter(c => !delta.claimsAddressed.includes(c));
  if (missedClaims.length > 0) {
    violations.push(`MISSED_CLAIMS: ${missedClaims.join(", ")}`);
  }
  return { valid: violations.length === 0, violations };
}
// =============================================================================
// PASS 3: STITCH AND REPAIR
// =============================================================================
async function runStitchPass(
  skeleton: GlobalSkeleton,
  allDeltas: ChunkDelta[],
  allOutputs: string[]
): Promise<StitchValidation> {
  const allAddressed = new Set(allDeltas.flatMap(d => d.claimsAddressed));
  const claimsCovered: Record<string, boolean> = {};
  const claimsMissing: string[] = [];
  for (const claim of skeleton.sourceClaims) {
    const covered = allAddressed.has(claim.id);
    claimsCovered[claim.id] = covered;
    if (!covered) claimsMissing.push(`${claim.id}: ${claim.claim}`);
  }
  const topicViolations = allDeltas.flatMap(d =>
    d.violations.filter(v => v.startsWith("TOPIC") || v.startsWith("FORBIDDEN"))
  );
  const structuralViolations = allDeltas.flatMap(d =>
    d.violations.filter(v => v.includes("BACKREF"))
  );
  let balanceIssue: string | null = null;
  if (skeleton.requiresBalance) {
    let s1 = 0, s2 = 0;
    for (const d of allDeltas) {
      if (d.speakerBalance) {
        s1 += d.speakerBalance.speaker1;
        s2 += d.speakerBalance.speaker2;
      }
    }
    if (Math.abs(s1 - s2) > 3) {
      balanceIssue = `Imbalanced: Speaker1=${s1}, Speaker2=${s2}`;
    }
  }
  const backReferenceCheck = {
    required: skeleton.mustReferenceEarlier,
    satisfied: !structuralViolations.some(v => v.includes("BACKREF")),
    details: structuralViolations.find(v => v.includes("BACKREF")) || "OK",
  };
  const repairPlan: { chunkIndex: number; issue: string; action: string }[] = [];
  for (let i = 0; i < allDeltas.length; i++) {
    for (const v of allDeltas[i].violations) {
      if (v.startsWith("TOPIC") || v.startsWith("FORBIDDEN")) {
        repairPlan.push({
          chunkIndex: i,
          issue: v,
          action: `Regenerate chunk ${i + 1} removing off-topic content`,
        });
      }
    }
  }
  if (skeleton.mustReferenceEarlier && !backReferenceCheck.satisfied) {
    repairPlan.push({
      chunkIndex: allDeltas.length - 1,
      issue: "Missing back-references in final chunk",
      action: `Add explicit references to: ${allDeltas[0]?.quotableContent?.slice(0, 3).join("; ")}`,
    });
  }
  let coherenceScore: "pass" | "needs_repair" | "critical_failure";
  const critical = topicViolations.length + (!backReferenceCheck.satisfied && backReferenceCheck.required ? 1 : 0);
  const moderate = claimsMissing.length;
  if (critical > 2 || moderate > skeleton.sourceClaims.length * 0.3) {
    coherenceScore = "critical_failure";
  } else if (critical > 0 || moderate > 0 || balanceIssue) {
    coherenceScore = "needs_repair";
  } else {
    coherenceScore = "pass";
  }
  return {
    claimsCovered,
    claimsMissing,
    topicViolations,
    structuralViolations,
    balanceIssue,
    backReferenceCheck,
    repairPlan,
    coherenceScore,
  };
}
async function executeRepair(
  repair: { chunkIndex: number; issue: string; action: string },
  skeleton: GlobalSkeleton,
  existingOutputs: string[],
  allDeltas: ChunkDelta[],
  userPrompt: string
): Promise<string> {
  const isTopicRepair = repair.issue.includes("TOPIC") || repair.issue.includes("FORBIDDEN");
  const isBackRefRepair = repair.issue.includes("BACKREF") || repair.issue.includes("back-reference");
  let instructions = "";
  if (isTopicRepair) {
    instructions = `
PROBLEM: ${repair.issue}
REMOVE all mentions of: ${skeleton.forbiddenTopics.join(", ")}
STAY WITHIN: ${skeleton.allowedTopics.join(", ") || "source claim topics only"}
Rewrite removing off-topic content entirely.`;
  } else if (isBackRefRepair) {
    instructions = `
PROBLEM: Final chunk lacks required back-references.
MUST ADD references to:
${allDeltas[0]?.quotableContent?.slice(0, 3).map((q, i) => `${i + 1}. "${q}"`).join("\n")}
Use: "As you argued earlier...", "Remember your point about...", etc.`;
  } else {
    instructions = `PROBLEM: ${repair.issue}\nACTION: ${repair.action}`;
  }
  const systemPrompt = `Repair this chunk.
ORIGINAL:
${existingOutputs[repair.chunkIndex]}
${instructions}
USER TASK: ${userPrompt}
Generate repaired version.`;
  return await callLLM(systemPrompt, "Execute repair.", false);
}
// =============================================================================
// MAIN SERVICE CLASS
// =============================================================================
export class CoherenceService {
  async createSession(userId: number, sessionType: string, userPrompt: string): Promise<number> {
    const [session] = await db
      .insert(coherentSessions)
      .values({ userId, sessionType, userPrompt, status: "pending" })
      .returning();
    return session.id;
  }
  async getSkeletonFromDB(sessionId: number): Promise<GlobalSkeleton | null> {
    const [session] = await db.select().from(coherentSessions).where(eq(coherentSessions.id, sessionId));
    return (session?.globalSkeleton as GlobalSkeleton) || null;
  }
  async getPriorDeltas(sessionId: number, beforeIndex: number): Promise<ChunkDelta[]> {
    const chunks = await db
      .select()
      .from(coherentChunks)
      .where(eq(coherentChunks.sessionId, sessionId))
      .orderBy(asc(coherentChunks.chunkIndex));
    return chunks.filter(c => c.chunkIndex < beforeIndex && c.chunkDelta).map(c => c.chunkDelta as ChunkDelta);
  }
  async getPriorOutputs(sessionId: number, beforeIndex: number): Promise<string[]> {
    const chunks = await db
      .select()
      .from(coherentChunks)
      .where(eq(coherentChunks.sessionId, sessionId))
      .orderBy(asc(coherentChunks.chunkIndex));
    return chunks.filter(c => c.chunkIndex < beforeIndex && c.chunkOutput).map(c => c.chunkOutput as string);
  }
  async *processLargeDocument(
    userId: number,
    sessionType: string,
    userPrompt: string,
    inputText: string
  ): AsyncGenerator<StreamEvent> {
    const wordCount = countWords(inputText);
    const targetChunks = Math.max(2, Math.ceil(wordCount / MAX_WORDS_PER_CHUNK));
    console.log(`[Coherence] ${wordCount} words → ${targetChunks} chunks`);
    const sessionId = await this.createSession(userId, sessionType, userPrompt);
    yield { type: "status", data: `Session ${sessionId}` };
    try {
      yield { type: "status", data: "Pass 1: Building skeleton..." };
      const skeleton = await buildGlobalSkeleton(userPrompt, inputText, targetChunks);
      await db.update(coherentSessions).set({
        globalSkeleton: skeleton,
        totalChunks: targetChunks,
        status: "skeleton_complete",
        updatedAt: new Date(),
      }).where(eq(coherentSessions.id, sessionId));
      yield {
        type: "skeleton",
        data: {
          claims: skeleton.sourceClaims.length,
          structural: skeleton.structuralRequirements.length,
          mustReferenceEarlier: skeleton.mustReferenceEarlier,
          requiresBalance: skeleton.requiresBalance,
          forbidden: skeleton.forbiddenTopics,
        },
      };
      yield { type: "status", data: "Pass 2: Processing chunks..." };
      await db.update(coherentSessions).set({ status: "chunking", updatedAt: new Date() }).where(eq(coherentSessions.id, sessionId));
      const allDeltas: ChunkDelta[] = [];
      const allOutputs: string[] = [];
      const allQuotables: string[][] = [];
      const priorWordCounts: number[] = [];
      for (let i = 0; i < targetChunks; i++) {
        yield { type: "status", data: `Chunk ${i + 1}/${targetChunks}` };
        const priorDeltas = await this.getPriorDeltas(sessionId, i);
        const priorOutputs = await this.getPriorOutputs(sessionId, i);
        const previousChunk = priorOutputs.length > 0 ? priorOutputs[priorOutputs.length - 1] : null;
        const plans = buildChunkPlans(skeleton, targetChunks, allQuotables);
        const plan = plans[i];
        const optimalWords = computeOptimalWordCount(skeleton.totalTargetWords, i, targetChunks, priorWordCounts);
        plan.targetWords = optimalWords;
        await db.insert(coherentChunks).values({
          sessionId,
          chunkIndex: i,
          chunkType: "output",
          chunkText: JSON.stringify(plan),
        });
        let result = null;
        let retries = 0;
        while (!result && retries < MAX_CHUNK_RETRIES) {
          try {
            const candidate = await processChunk(plan, targetChunks, skeleton, priorDeltas, priorOutputs, userPrompt);
            const validation = await validateChunk(candidate.output, plan, skeleton, candidate.delta);
            if (validation.valid) {
              const modifiedOutput = await compareAndModifyChunk(
                candidate.output,
                userPrompt,
                previousChunk,
                optimalWords
              );
              candidate.output = modifiedOutput;
              candidate.delta.wordCount = countWords(modifiedOutput);
              result = candidate;
            } else {
              candidate.delta.violations = validation.violations;
              retries++;
              if (retries >= MAX_CHUNK_RETRIES) result = candidate;
            }
          } catch (e: any) {
            retries++;
            if (retries >= MAX_CHUNK_RETRIES) throw new Error(`Chunk ${i + 1}: ${e.message}`);
          }
        }
        if (!result) throw new Error(`Chunk ${i + 1} failed`);
        await db.update(coherentChunks).set({
          chunkOutput: result.output,
          chunkDelta: result.delta,
          processedAt: new Date(),
        }).where(and(eq(coherentChunks.sessionId, sessionId), eq(coherentChunks.chunkIndex, i)));
        await db.update(coherentSessions).set({ processedChunks: i + 1, updatedAt: new Date() }).where(eq(coherentSessions.id, sessionId));
        allDeltas.push(result.delta);
        allOutputs.push(result.output);
        allQuotables.push(result.delta.quotableContent);
        priorWordCounts.push(result.delta.wordCount);
        yield {
          type: "chunk",
          data: {
            index: i,
            position: plan.position,
            claims: result.delta.claimsAddressed,
            words: result.delta.wordCount,
            violations: result.delta.violations,
            output: result.output,
          },
        };
        if (i < targetChunks - 1) {
          yield { type: "pause", data: { seconds: CHUNK_PAUSE_MS / 1000 } };
          await sleep(CHUNK_PAUSE_MS);
        }
      }
      yield { type: "status", data: "Pass 3: Stitching..." };
      await db.update(coherentSessions).set({ status: "stitching", updatedAt: new Date() }).where(eq(coherentSessions.id, sessionId));
      const dbSkeleton = await this.getSkeletonFromDB(sessionId);
      if (!dbSkeleton) throw new Error("No skeleton for stitch");
      const stitchResult = await runStitchPass(dbSkeleton, allDeltas, allOutputs);
      await db.insert(stitchResults).values({
        sessionId,
        conflicts: stitchResult.claimsMissing,
        repairs: stitchResult.repairPlan,
        finalValidation: {
          topicViolations: stitchResult.topicViolations,
          backRef: stitchResult.backReferenceCheck,
          balance: stitchResult.balanceIssue,
        },
        coherenceScore: stitchResult.coherenceScore,
      });
      yield {
        type: "stitch",
        data: {
          score: stitchResult.coherenceScore,
          missing: stitchResult.claimsMissing.length,
          topicViolations: stitchResult.topicViolations.length,
          backRefOK: stitchResult.backReferenceCheck.satisfied,
          repairs: stitchResult.repairPlan.length,
        },
      };
      if (stitchResult.repairPlan.length > 0) {
        yield { type: "status", data: `Repairing ${stitchResult.repairPlan.length} issues...` };
        for (const repair of stitchResult.repairPlan) {
          const fixed = await executeRepair(repair, dbSkeleton, allOutputs, allDeltas, userPrompt);
          allOutputs[repair.chunkIndex] = fixed;
          yield { type: "repair", data: { chunk: repair.chunkIndex, issue: repair.issue } };
          await sleep(CHUNK_PAUSE_MS);
        }
      }
      await db.update(coherentSessions).set({ status: "complete", updatedAt: new Date() }).where(eq(coherentSessions.id, sessionId));
      yield {
        type: "complete",
        data: {
          sessionId,
          score: stitchResult.coherenceScore,
          words: countWords(allOutputs.join("\n\n")),
          claims: `${Object.values(stitchResult.claimsCovered).filter(v => v).length}/${skeleton.sourceClaims.length}`,
          output: allOutputs.join("\n\n"),
        },
      };
    } catch (error: any) {
      await db.update(coherentSessions).set({ status: "failed", updatedAt: new Date() }).where(eq(coherentSessions.id, sessionId));
      yield { type: "error", data: error.message };
    }
  }
  async getSessionStatus(sessionId: number) {
    const [session] = await db.select().from(coherentSessions).where(eq(coherentSessions.id, sessionId));
    if (!session) return null;
    const chunks = await db.select().from(coherentChunks).where(eq(coherentChunks.sessionId, sessionId)).orderBy(asc(coherentChunks.chunkIndex));
    const [stitch] = await db.select().from(stitchResults).where(eq(stitchResults.sessionId, sessionId));
    return { session, chunks, stitchResult: stitch };
  }
  async getAllChunkOutputs(sessionId: number): Promise<string> {
    const chunks = await db.select().from(coherentChunks).where(eq(coherentChunks.sessionId, sessionId)).orderBy(asc(coherentChunks.chunkIndex));
    return chunks.filter(c => c.chunkOutput).map(c => c.chunkOutput).join("\n\n");
  }
}
export const coherenceService = new CoherenceService();