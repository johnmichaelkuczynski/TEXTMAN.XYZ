import Anthropic from '@anthropic-ai/sdk';

interface ArgumentStructure {
  thesis: string;
  mainClaims: Array<{
    claim: string;
    supportingPoints: string[];
    vulnerabilities: string[];
  }>;
  assumptions: string[];
  methodology: string[];
  conclusions: string[];
  audienceConsiderations: string[];
}

interface ObjectionBatch {
  category: string;
  objections: Array<{
    number: number;
    objection: string;
    response: string;
    severity: 'devastating' | 'forceful' | 'minor';
  }>;
}

interface OutlineFirstObjectionsResult {
  success: boolean;
  output: string;
  structure?: ArgumentStructure;
  error?: string;
}

const WORD_THRESHOLD = 1200;

export function shouldUseOutlineFirstObjections(text: string): boolean {
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  return wordCount >= WORD_THRESHOLD;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

async function extractArgumentStructure(
  text: string,
  audience: string,
  objective: string
): Promise<ArgumentStructure> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  
  const truncatedText = text.length > 120000 
    ? text.substring(0, 60000) + "\n\n[...middle section omitted for analysis...]\n\n" + text.substring(text.length - 50000)
    : text;

  const systemPrompt = `You are an expert argument analyst. Your task is to extract the core argument structure from a text for the purpose of generating comprehensive objections.

You must identify:
1. The central thesis or main claim
2. Each major supporting claim with its evidence points
3. Hidden assumptions the author makes
4. Methodological approaches used
5. Key conclusions drawn
6. Audience-specific concerns based on who will read this

Return your analysis as a JSON object with this exact structure:
{
  "thesis": "The central claim or argument",
  "mainClaims": [
    {
      "claim": "A major claim made",
      "supportingPoints": ["evidence 1", "evidence 2"],
      "vulnerabilities": ["potential weakness 1", "potential weakness 2"]
    }
  ],
  "assumptions": ["assumption 1", "assumption 2"],
  "methodology": ["methodological approach 1"],
  "conclusions": ["conclusion 1", "conclusion 2"],
  "audienceConsiderations": ["concern for this audience"]
}

Be thorough but focused. Identify 3-8 main claims depending on document complexity.`;

  const userPrompt = `## DOCUMENT TO ANALYZE:
${truncatedText}

## CONTEXT:
Target Audience: ${audience || 'General academic/professional audience'}
Objective: ${objective || 'Persuade and inform'}

Extract the argument structure as specified. Return ONLY valid JSON.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }]
  });

  const responseText = (response.content[0] as any).text;
  
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("No JSON found in response");
  } catch (parseError) {
    console.error("[OUTLINE-OBJECTIONS] Failed to parse argument structure:", parseError);
    return {
      thesis: "Unable to extract thesis - processing as single unit",
      mainClaims: [{
        claim: "Full document analysis",
        supportingPoints: [],
        vulnerabilities: []
      }],
      assumptions: [],
      methodology: [],
      conclusions: [],
      audienceConsiderations: []
    };
  }
}

async function generateObjectionsForCategory(
  structure: ArgumentStructure,
  category: 'logical' | 'evidential' | 'practical' | 'audience' | 'methodological',
  targetCount: number,
  startNumber: number,
  audience: string,
  customInstructions: string
): Promise<ObjectionBatch> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const categoryPrompts: Record<string, string> = {
    logical: `Generate objections focused on LOGICAL FLAWS:
- Internal contradictions
- Invalid inferences
- Circular reasoning
- False dichotomies
- Hasty generalizations
- Non sequiturs
Focus on the thesis: "${structure.thesis}"
And these main claims: ${structure.mainClaims.map(c => c.claim).join('; ')}`,
    
    evidential: `Generate objections focused on EVIDENCE AND SUPPORT:
- Missing evidence
- Weak evidence
- Alternative explanations
- Cherry-picking data
- Outdated sources
- Correlation vs causation errors
Analyze these supporting points and vulnerabilities: ${JSON.stringify(structure.mainClaims.map(c => ({ claim: c.claim, evidence: c.supportingPoints, weaknesses: c.vulnerabilities })))}`,
    
    practical: `Generate objections focused on PRACTICAL CONCERNS:
- Implementation challenges
- Cost/benefit issues
- Unintended consequences
- Feasibility problems
- Resource requirements
- Timing and urgency concerns
Based on these conclusions: ${structure.conclusions.join('; ')}`,
    
    audience: `Generate objections that the TARGET AUDIENCE would specifically raise:
- Emotional resistance
- Value conflicts
- Trust issues
- Competing priorities
- Personal experience contradictions
- Cultural/contextual concerns
Audience: ${audience || 'General'}
Their likely concerns: ${structure.audienceConsiderations.join('; ')}`,
    
    methodological: `Generate objections focused on METHODOLOGY AND ASSUMPTIONS:
- Hidden assumptions: ${structure.assumptions.join('; ')}
- Methodological flaws: ${structure.methodology.join('; ')}
- Scope limitations
- Definitional problems
- Framework limitations`
  };

  const systemPrompt = `You are an expert at generating comprehensive, well-reasoned objections. Generate exactly ${targetCount} objections for the specified category.

For each objection:
1. Frame it as something a critical reader would actually say/think
2. Provide a compelling counter-response
3. Rate severity: "devastating" (fundamental flaw), "forceful" (appears strong but addressable), or "minor" (easily dismissed)

Format as JSON array:
[
  {
    "number": ${startNumber},
    "objection": "The objection text",
    "response": "The counter-response",
    "severity": "devastating|forceful|minor"
  }
]`;

  const userPrompt = `${categoryPrompts[category]}

${customInstructions ? `\nADDITIONAL FOCUS: ${customInstructions}` : ''}

Generate exactly ${targetCount} objections (numbered ${startNumber} to ${startNumber + targetCount - 1}).
Return ONLY the JSON array.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }]
  });

  const responseText = (response.content[0] as any).text;

  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const objections = JSON.parse(jsonMatch[0]);
      return {
        category,
        objections: objections.map((obj: any, idx: number) => ({
          number: startNumber + idx,
          objection: obj.objection,
          response: obj.response,
          severity: obj.severity || 'forceful'
        }))
      };
    }
    throw new Error("No JSON array found");
  } catch (parseError) {
    console.error(`[OUTLINE-OBJECTIONS] Failed to parse ${category} objections:`, parseError);
    return {
      category,
      objections: []
    };
  }
}

function formatObjectionsOutput(
  batches: ObjectionBatch[],
  structure: ArgumentStructure,
  audience: string,
  objective: string,
  customInstructions: string,
  wordCount: number
): string {
  const allObjections = batches.flatMap(b => b.objections).sort((a, b) => a.number - b.number);
  
  const devastatingCount = allObjections.filter(o => o.severity === 'devastating').length;
  const forcefulCount = allObjections.filter(o => o.severity === 'forceful').length;
  const minorCount = allObjections.filter(o => o.severity === 'minor').length;

  let output = `═══════════════════════════════════════════════════
OBJECTIONS & COUNTER-ARGUMENTS (${allObjections.length} Items)
═══════════════════════════════════════════════════
Target Audience: ${audience || 'General'}
Objective: ${objective || 'Communicate effectively'}
Document Length: ${wordCount.toLocaleString()} words (outline-first analysis)
${customInstructions ? `Custom Focus: ${customInstructions.substring(0, 100)}${customInstructions.length > 100 ? '...' : ''}` : ''}
═══════════════════════════════════════════════════

ARGUMENT STRUCTURE ANALYZED:
Thesis: ${structure.thesis}
Main Claims: ${structure.mainClaims.length}
Key Assumptions: ${structure.assumptions.length}

SEVERITY SUMMARY:
- Devastating objections: ${devastatingCount}
- Forceful objections: ${forcefulCount}
- Minor objections: ${minorCount}

═══════════════════════════════════════════════════

`;

  for (const obj of allObjections) {
    const severityLabel = obj.severity === 'devastating' ? '[DEVASTATING]' :
                         obj.severity === 'forceful' ? '[FORCEFUL]' : '[MINOR]';
    
    output += `**OBJECTION #${obj.number}:** ${severityLabel}
${obj.objection}

**RESPONSE:**
${obj.response}

---

`;
  }

  return output.trim();
}

export async function outlineFirstObjections(
  text: string,
  audience: string = '',
  objective: string = '',
  customInstructions: string = ''
): Promise<OutlineFirstObjectionsResult> {
  const wordCount = countWords(text);
  console.log(`[OUTLINE-OBJECTIONS] Processing document of ${wordCount} words`);

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      success: false,
      output: '',
      error: 'Anthropic API key not configured'
    };
  }

  try {
    console.log(`[OUTLINE-OBJECTIONS] Phase 1: Extracting argument structure...`);
    const structure = await extractArgumentStructure(text, audience, objective);
    console.log(`[OUTLINE-OBJECTIONS] Found ${structure.mainClaims.length} main claims, ${structure.assumptions.length} assumptions`);

    console.log(`[OUTLINE-OBJECTIONS] Phase 2: Generating objections by category...`);
    
    const batchConfigs: Array<{ category: 'logical' | 'evidential' | 'practical' | 'audience' | 'methodological'; count: number }> = [
      { category: 'logical', count: 6 },
      { category: 'evidential', count: 6 },
      { category: 'practical', count: 5 },
      { category: 'audience', count: 4 },
      { category: 'methodological', count: 4 }
    ];

    let currentNumber = 1;
    const batches: ObjectionBatch[] = [];

    for (const config of batchConfigs) {
      console.log(`[OUTLINE-OBJECTIONS] Generating ${config.count} ${config.category} objections (starting at #${currentNumber})...`);
      
      const batch = await generateObjectionsForCategory(
        structure,
        config.category,
        config.count,
        currentNumber,
        audience,
        customInstructions
      );
      
      batches.push(batch);
      currentNumber += config.count;
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`[OUTLINE-OBJECTIONS] Phase 3: Formatting final output...`);
    const output = formatObjectionsOutput(batches, structure, audience, objective, customInstructions, wordCount);

    const totalGenerated = batches.reduce((sum, b) => sum + b.objections.length, 0);
    console.log(`[OUTLINE-OBJECTIONS] Successfully generated ${totalGenerated} objections`);

    return {
      success: true,
      output,
      structure
    };

  } catch (error: any) {
    console.error('[OUTLINE-OBJECTIONS] Error:', error);
    return {
      success: false,
      output: '',
      error: error.message || 'Outline-first objections generation failed'
    };
  }
}
