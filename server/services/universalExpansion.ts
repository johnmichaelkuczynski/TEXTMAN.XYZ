/**
 * Universal Expansion Service
 * 
 * This service handles text expansion regardless of input length.
 * When user provides custom instructions specifying a target word count,
 * structure, chapters, or other expansion requirements, this service
 * delivers exactly what the user specifies.
 * 
 * PROTOCOL: User instructions are ALWAYS obeyed. No thresholds. No "simple mode".
 * The app does what the user wants. Period.
 */

import Anthropic from "@anthropic-ai/sdk";

interface ExpansionRequest {
  text: string;
  customInstructions: string;
  targetWordCount?: number;
  structure?: string[];
  constraints?: string[];
  aggressiveness?: "conservative" | "aggressive";
}

interface ExpansionResult {
  expandedText: string;
  inputWordCount: number;
  outputWordCount: number;
  sectionsGenerated: number;
  processingTimeMs: number;
}

interface ParsedInstructions {
  targetWordCount: number | null;
  structure: { name: string; wordCount: number }[];
  constraints: string[];
  citations: { type: string; count: number; timeframe?: string } | null;
  academicRegister: boolean;
  noBulletPoints: boolean;
  internalSubsections: boolean;
  literatureReview: boolean;
  philosophersToReference: string[];
}

const anthropic = new Anthropic();

/**
 * Parse custom instructions to extract expansion requirements
 */
export function parseExpansionInstructions(customInstructions: string): ParsedInstructions {
  const result: ParsedInstructions = {
    targetWordCount: null,
    structure: [],
    constraints: [],
    citations: null,
    academicRegister: false,
    noBulletPoints: false,
    internalSubsections: false,
    literatureReview: false,
    philosophersToReference: []
  };
  
  if (!customInstructions) return result;
  
  const text = customInstructions.toUpperCase();
  const originalText = customInstructions;
  
  // Parse target word count - multiple patterns
  const wordCountPatterns = [
    /EXPAND\s*(?:TO)?\s*([\d,]+(?:\.\d+)?)\s*(?:K)?\s*WORDS?/i,
    /([\d,]+(?:\.\d+)?)\s*(?:K)?\s*WORDS?\s*(?:THESIS|DISSERTATION|ESSAY|DOCUMENT|LENGTH)/i,
    /(?:THESIS|DISSERTATION|ESSAY|DOCUMENT)\s*(?:OF)?\s*([\d,]+(?:\.\d+)?)\s*(?:K)?\s*WORDS?/i,
    /TARGET\s*(?:OF)?\s*([\d,]+(?:\.\d+)?)\s*(?:K)?\s*WORDS?/i,
    /([\d,]+(?:\.\d+)?)\s*(?:K)?\s*WORDS?\s*TOTAL/i,
    /TURN\s*(?:THIS\s*)?INTO\s*(?:A\s*)?([\d,]+(?:\.\d+)?)\s*(?:K)?\s*WORD/i
  ];
  
  for (const pattern of wordCountPatterns) {
    const match = originalText.match(pattern);
    if (match) {
      let count = parseFloat(match[1].replace(/,/g, ''));
      // Check if it's in K format (e.g., "20K words")
      if (/K\s*WORDS?/i.test(match[0])) {
        count *= 1000;
      }
      // Sanity check - if number is too small, might be in thousands
      if (count < 500 && originalText.toUpperCase().includes('THESIS')) {
        count *= 1000;
      }
      result.targetWordCount = Math.round(count);
      console.log(`[Universal Expansion] Parsed target word count: ${result.targetWordCount} from "${match[0]}"`);
      break;
    }
  }
  
  // Parse structure with word counts
  const structurePattern = /([A-Z][A-Z\s\d:]+?)\s*\((\d+(?:,\d+)?)\s*words?\)/gi;
  let structureMatch;
  while ((structureMatch = structurePattern.exec(originalText)) !== null) {
    result.structure.push({
      name: structureMatch[1].trim(),
      wordCount: parseInt(structureMatch[2].replace(/,/g, ''))
    });
  }
  
  // Also look for numbered chapter structure
  const chapterPattern = /CHAPTER\s*(\d+)[:\s]+([^\n(]+)/gi;
  let chapterMatch: RegExpExecArray | null;
  while ((chapterMatch = chapterPattern.exec(originalText)) !== null) {
    const match = chapterMatch!;
    // Only add if not already captured with word count
    const chapterName = `CHAPTER ${match[1]}: ${match[2].trim()}`;
    if (!result.structure.some(s => s.name.includes(`CHAPTER ${match[1]}`))) {
      result.structure.push({
        name: chapterName,
        wordCount: 0 // Will be distributed later
      });
    }
  }
  
  // Parse citations requirement
  const citationPatterns = [
    /(?:REFERENCE|CITE)\s*(?:THE\s*)?TOP\s*(\d+)\s*(?:JOURNAL\s*)?ARTICLES?/i,
    /(\d+)\s*(?:JOURNAL\s*)?(?:ARTICLES?|SOURCES?|REFERENCES?|CITATIONS?)/i,
    /TOP\s*(\d+)\s*(?:JOURNAL\s*)?ARTICLES?/i
  ];
  
  for (const pattern of citationPatterns) {
    const match = originalText.match(pattern);
    if (match) {
      result.citations = {
        type: 'journal_articles',
        count: parseInt(match[1])
      };
      
      // Check for timeframe
      const timeframeMatch = originalText.match(/(?:FROM\s*)?(?:THE\s*)?(?:LAST|PAST)\s*(\d+)\s*YEARS?/i);
      if (timeframeMatch) {
        result.citations.timeframe = `last ${timeframeMatch[1]} years`;
      }
      break;
    }
  }
  
  // Parse philosophers to reference
  const philosopherPattern = /(?:CITE|REFERENCE)\s*(?:RELEVANT\s*)?PHILOSOPHERS?\s*\(([^)]+)\)/i;
  const philMatch = originalText.match(philosopherPattern);
  if (philMatch) {
    result.philosophersToReference = philMatch[1].split(/,\s*/).map(p => p.trim());
  } else {
    // Look for common philosopher names mentioned
    const knownPhilosophers = ['Searle', 'Chalmers', 'Nagel', 'Dennett', 'Kim', 'Block', 'Fodor', 'Putnam', 'Jackson', 'Levine'];
    for (const phil of knownPhilosophers) {
      if (originalText.includes(phil)) {
        result.philosophersToReference.push(phil);
      }
    }
  }
  
  // Parse constraints
  result.academicRegister = /ACADEMIC\s*REGISTER/i.test(text);
  result.noBulletPoints = /NO\s*BULLET\s*POINTS?|FULL\s*PROSE/i.test(text);
  result.internalSubsections = /INTERNAL\s*SUBSECTIONS?|EACH\s*CHAPTER\s*(?:MUST\s*)?HAVE\s*(?:INTERNAL\s*)?SUBSECTIONS?/i.test(text);
  result.literatureReview = /LITERATURE\s*REVIEW/i.test(text);
  
  // Extract other constraints as strings
  const constraintPatterns = [
    /MAINTAIN\s+[^.]+/gi,
    /MUST\s+[^.]+/gi,
    /IDENTIFY\s+[^.]+/gi,
    /STATE\s+[^.]+/gi
  ];
  
  for (const pattern of constraintPatterns) {
    const matches = originalText.match(pattern);
    if (matches) {
      result.constraints.push(...matches.map(m => m.trim()));
    }
  }
  
  return result;
}

/**
 * Check if custom instructions contain expansion requirements
 */
export function hasExpansionInstructions(customInstructions?: string): boolean {
  if (!customInstructions) return false;
  
  const parsed = parseExpansionInstructions(customInstructions);
  
  // Has expansion if:
  // 1. Target word count specified
  // 2. Structure with word counts specified
  // 3. Keywords indicating expansion
  
  if (parsed.targetWordCount && parsed.targetWordCount > 0) return true;
  if (parsed.structure.length > 0) return true;
  
  const expansionKeywords = [
    /EXPAND\s*TO/i,
    /TURN\s*(?:THIS\s*)?INTO\s*(?:A\s*)?\d/i,
    /\d+\s*WORD\s*(?:THESIS|DISSERTATION|ESSAY)/i,
    /MASTER'?S?\s*THESIS/i,
    /DOCTORAL\s*(?:THESIS|DISSERTATION)/i,
    /PHD\s*(?:THESIS|DISSERTATION)/i,
    /WRITE\s*(?:A\s*)?\d+\s*WORDS?/i
  ];
  
  return expansionKeywords.some(pattern => pattern.test(customInstructions));
}

/**
 * Generate a single section of the expanded document
 */
async function generateSection(
  sectionName: string,
  targetWordCount: number,
  originalText: string,
  fullOutline: string,
  previousSections: string,
  parsedInstructions: ParsedInstructions,
  customInstructions: string
): Promise<string> {
  
  const styleConstraints = [];
  if (parsedInstructions.academicRegister) styleConstraints.push("Use formal academic register throughout");
  if (parsedInstructions.noBulletPoints) styleConstraints.push("Write in full prose paragraphs only - NO bullet points");
  if (parsedInstructions.internalSubsections) styleConstraints.push("Include internal subsections with clear headings");
  
  const citationGuidance = parsedInstructions.citations 
    ? `Reference relevant academic sources (aim to cite ${parsedInstructions.citations.count} sources${parsedInstructions.citations.timeframe ? ` from ${parsedInstructions.citations.timeframe}` : ''} across the full document)`
    : '';
  
  const philosopherGuidance = parsedInstructions.philosophersToReference.length > 0
    ? `Engage with these philosophers where relevant: ${parsedInstructions.philosophersToReference.join(', ')}`
    : '';

  const prompt = `You are writing a section of an academic thesis/dissertation.

ORIGINAL SOURCE TEXT (the seed idea to expand):
${originalText}

FULL DOCUMENT OUTLINE:
${fullOutline}

PREVIOUS SECTIONS WRITTEN:
${previousSections || '[This is the first section]'}

═══════════════════════════════════════════════════════════════
SECTION TO WRITE NOW: ${sectionName}
TARGET LENGTH: ${targetWordCount} words (STRICT - must hit this target)
═══════════════════════════════════════════════════════════════

STYLE REQUIREMENTS:
${styleConstraints.join('\n')}
${citationGuidance}
${philosopherGuidance}

USER'S ORIGINAL INSTRUCTIONS:
${customInstructions}

CRITICAL REQUIREMENTS:
1. Write EXACTLY ${targetWordCount} words for this section (±5%)
2. This must be substantive academic prose, not filler
3. Develop the argument with evidence, examples, and analysis
4. Connect to previous sections and set up future ones
5. NO MARKDOWN FORMATTING - use plain text only
6. Include proper academic citations inline (Author, Year)
7. Each paragraph should advance the argument

Write the section now:`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: Math.ceil(targetWordCount * 2), // Allow plenty of room
    messages: [{ role: "user", content: prompt }]
  });

  const content = response.content[0].type === 'text' ? response.content[0].text : '';
  return content;
}

/**
 * Main expansion function - expands text according to user instructions
 */
export async function universalExpand(request: ExpansionRequest): Promise<ExpansionResult> {
  const startTime = Date.now();
  const { text, customInstructions, aggressiveness = "aggressive" } = request;
  
  const inputWordCount = text.trim().split(/\s+/).length;
  console.log(`[Universal Expansion] Starting expansion of ${inputWordCount} words`);
  console.log(`[Universal Expansion] Custom instructions: ${customInstructions?.substring(0, 200)}...`);
  
  // Parse the user's instructions
  const parsed = parseExpansionInstructions(customInstructions);
  console.log(`[Universal Expansion] Parsed target: ${parsed.targetWordCount} words`);
  console.log(`[Universal Expansion] Parsed structure: ${parsed.structure.length} sections`);
  
  // Determine target word count
  let targetWordCount = parsed.targetWordCount || request.targetWordCount;
  if (!targetWordCount) {
    // Default expansion if no target specified but expansion clearly requested
    targetWordCount = Math.max(inputWordCount * 10, 5000);
    console.log(`[Universal Expansion] No explicit target, defaulting to ${targetWordCount} words`);
  }
  
  // Build structure - either from parsed instructions or generate one
  let structure = parsed.structure;
  if (structure.length === 0) {
    // Generate default academic structure
    structure = [
      { name: "ABSTRACT", wordCount: Math.round(targetWordCount * 0.015) },
      { name: "INTRODUCTION", wordCount: Math.round(targetWordCount * 0.10) },
      { name: "LITERATURE REVIEW", wordCount: Math.round(targetWordCount * 0.20) },
      { name: "CHAPTER 1: CORE ARGUMENT", wordCount: Math.round(targetWordCount * 0.175) },
      { name: "CHAPTER 2: SUPPORTING ANALYSIS", wordCount: Math.round(targetWordCount * 0.175) },
      { name: "CHAPTER 3: CRITICAL EXAMINATION", wordCount: Math.round(targetWordCount * 0.175) },
      { name: "CHAPTER 4: IMPLICATIONS", wordCount: Math.round(targetWordCount * 0.10) },
      { name: "CONCLUSION", wordCount: Math.round(targetWordCount * 0.06) }
    ];
    console.log(`[Universal Expansion] Generated default structure with ${structure.length} sections`);
  } else {
    // Distribute remaining word count to sections without explicit counts
    const totalExplicit = structure.reduce((sum, s) => sum + s.wordCount, 0);
    const sectionsWithoutCount = structure.filter(s => s.wordCount === 0);
    if (sectionsWithoutCount.length > 0 && targetWordCount > totalExplicit) {
      const remaining = targetWordCount - totalExplicit;
      const perSection = Math.round(remaining / sectionsWithoutCount.length);
      for (const section of sectionsWithoutCount) {
        section.wordCount = perSection;
      }
    }
  }
  
  // Generate the full outline first
  const outlinePrompt = `You are creating a detailed outline for an academic thesis/dissertation.

ORIGINAL TEXT TO EXPAND:
${text}

TARGET: ${targetWordCount} word thesis/dissertation

STRUCTURE (each section with target word count):
${structure.map(s => `- ${s.name}: ${s.wordCount} words`).join('\n')}

USER INSTRUCTIONS:
${customInstructions}

Create a detailed outline that will guide writing each section. For each section, provide:
1. Main argument/thesis of that section
2. Key points to cover (3-5 bullet points)
3. Evidence/examples to include
4. How it connects to other sections

Return a comprehensive outline that will ensure argumentative coherence across the entire document.`;

  console.log(`[Universal Expansion] Generating outline...`);
  
  const outlineResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: outlinePrompt }]
  });
  
  const fullOutline = outlineResponse.content[0].type === 'text' ? outlineResponse.content[0].text : '';
  console.log(`[Universal Expansion] Outline generated (${fullOutline.length} chars)`);
  
  // Generate each section
  const sections: string[] = [];
  let previousSections = "";
  
  for (let i = 0; i < structure.length; i++) {
    const section = structure[i];
    console.log(`[Universal Expansion] Generating section ${i + 1}/${structure.length}: ${section.name} (${section.wordCount} words)`);
    
    const sectionContent = await generateSection(
      section.name,
      section.wordCount,
      text,
      fullOutline,
      previousSections,
      parsed,
      customInstructions
    );
    
    sections.push(`\n${'═'.repeat(60)}\n${section.name}\n${'═'.repeat(60)}\n\n${sectionContent}`);
    
    // Keep track of previous sections (abbreviated) for context
    previousSections += `\n\n[${section.name}]: ${sectionContent.substring(0, 500)}...`;
    
    // Small delay to avoid rate limiting
    if (i < structure.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Assemble final document
  const expandedText = sections.join('\n\n');
  const outputWordCount = expandedText.trim().split(/\s+/).length;
  const processingTimeMs = Date.now() - startTime;
  
  console.log(`[Universal Expansion] Complete: ${inputWordCount} → ${outputWordCount} words in ${processingTimeMs}ms`);
  
  return {
    expandedText,
    inputWordCount,
    outputWordCount,
    sectionsGenerated: structure.length,
    processingTimeMs
  };
}
