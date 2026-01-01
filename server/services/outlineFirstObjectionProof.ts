import Anthropic from '@anthropic-ai/sdk';

interface DocumentSection {
  id: number;
  title: string;
  content: string;
  wordCount: number;
  relevantObjections: number[];
}

interface ParsedObjection {
  number: number;
  category: string;
  severity: 'devastating' | 'forceful' | 'minor';
  objection: string;
  response: string;
}

interface CrossChunkState {
  addressedObjections: number[];
  keyTerminology: Record<string, string>;
  styleNotes: string[];
  previousSectionSummary: string;
  cumulativeWordCount: number;
  targetWordCount: number;
}

interface SectionInfo {
  id: number;
  title: string;
  wordCount: number;
  objectionsMapped: number[];
}

interface ObjectionProofResult {
  success: boolean;
  output: string;
  sectionsProcessed: number;
  objectionsAddressed: number;
  sections?: SectionInfo[];
  objectionBreakdown?: { devastating: number; forceful: number; minor: number };
  error?: string;
}

interface ProgressCallback {
  (phase: string, current: number, total: number, message: string): void;
}

const WORD_THRESHOLD = 1200;
const TARGET_SECTION_SIZE = 1200;

/**
 * Detect if custom instructions specify a NON-ESSAY output format
 * (glossary, list, specific numbered items, etc.)
 * When detected, we bypass the section-based approach and use direct format rewrite
 */
function detectSpecialFormat(customInstructions: string | undefined): {
  isSpecialFormat: boolean;
  formatType: 'glossary' | 'list' | 'numbered_items' | 'essay';
  itemCount?: number;
  formatDescription?: string;
} {
  if (!customInstructions) {
    return { isSpecialFormat: false, formatType: 'essay' };
  }
  
  const instructions = customInstructions.toUpperCase();
  
  // Detect glossary format
  if (instructions.includes('GLOSSARY') || 
      (instructions.includes('TERM') && instructions.includes('DEFINITION')) ||
      (instructions.includes('BOLD') && instructions.includes('COLON'))) {
    const countMatch = customInstructions.match(/(?:EXACTLY\s+)?(\d+)\s+(?:TERMS?|ENTRIES|ITEMS)/i);
    return {
      isSpecialFormat: true,
      formatType: 'glossary',
      itemCount: countMatch ? parseInt(countMatch[1]) : undefined,
      formatDescription: customInstructions
    };
  }
  
  // Detect numbered list format (e.g., "10 quotes", "15 discoveries")
  const numberedItemMatch = customInstructions.match(/(?:EXACTLY\s+)?(\d+)\s+(QUOTES?|DISCOVERIES|FACTS?|EXAMPLES?|POINTS?|ITEMS?|ENTRIES|REASONS?)/i);
  if (numberedItemMatch) {
    return {
      isSpecialFormat: true,
      formatType: 'numbered_items',
      itemCount: parseInt(numberedItemMatch[1]),
      formatDescription: customInstructions
    };
  }
  
  // Detect explicit list format
  if (instructions.includes('DO NOT USE') && instructions.includes('PARAGRAPH') ||
      instructions.includes('NO PARAGRAPH') ||
      instructions.includes('LIST ONLY') ||
      instructions.includes('JUST') && (instructions.includes('ENTRIES') || instructions.includes('ITEMS'))) {
    return {
      isSpecialFormat: true,
      formatType: 'list',
      formatDescription: customInstructions
    };
  }
  
  return { isSpecialFormat: false, formatType: 'essay' };
}

/**
 * Detect if INPUT text is already in a numbered defense format
 * (e.g., reconstruction output that follows numbered claims pattern)
 * This ensures the objection-proof stage preserves the format from reconstruction
 */
function detectInputNumberedFormat(inputText: string): {
  isNumberedFormat: boolean;
  itemCount: number;
  hasQuotedClaims: boolean;
  items: Array<{ number: number; quotedClaim: string; content: string }>;
} {
  // Pattern: numbered items (1., 2., etc.) followed by quoted claims
  const numberedItemPattern = /^(\d+)\.\s+"([^"]+)"/gm;
  const matches = Array.from(inputText.matchAll(numberedItemPattern));
  
  if (matches.length >= 3) {
    // Extract each numbered item with its content
    const items: Array<{ number: number; quotedClaim: string; content: string }> = [];
    const lines = inputText.split('\n');
    let currentItem: { number: number; quotedClaim: string; content: string } | null = null;
    
    for (const line of lines) {
      const itemMatch = line.match(/^(\d+)\.\s+"([^"]+)"/);
      if (itemMatch) {
        if (currentItem) {
          items.push(currentItem);
        }
        currentItem = {
          number: parseInt(itemMatch[1]),
          quotedClaim: itemMatch[2],
          content: line
        };
      } else if (currentItem && line.trim()) {
        currentItem.content += '\n' + line;
      }
    }
    if (currentItem) {
      items.push(currentItem);
    }
    
    return {
      isNumberedFormat: true,
      itemCount: items.length,
      hasQuotedClaims: true,
      items
    };
  }
  
  // Also check for simpler numbered format without quotes
  const simpleNumberedPattern = /^(\d+)\.\s+/gm;
  const simpleMatches = Array.from(inputText.matchAll(simpleNumberedPattern));
  
  if (simpleMatches.length >= 3) {
    return {
      isNumberedFormat: true,
      itemCount: simpleMatches.length,
      hasQuotedClaims: false,
      items: []
    };
  }
  
  return {
    isNumberedFormat: false,
    itemCount: 0,
    hasQuotedClaims: false,
    items: []
  };
}

/**
 * Format-preserving rewrite for already-formatted input
 * Used when reconstruction output is in numbered format and needs to stay that way
 */
async function formatPreservingRewrite(
  formattedInput: string,
  objectionsOutput: string,
  inputFormat: ReturnType<typeof detectInputNumberedFormat>,
  customInstructions: string | undefined,
  onProgress?: ProgressCallback
): Promise<ObjectionProofResult> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  
  onProgress?.('analyzing', 1, 3, 'Preserving numbered format from reconstruction...');
  
  const formatConstraints = inputFormat.hasQuotedClaims 
    ? `EXACT ${inputFormat.itemCount} numbered items, each starting with the claim in quotes`
    : `EXACT ${inputFormat.itemCount} numbered items`;
  
  const systemPrompt = `You are an expert editor. Your task is to strengthen a document against objections while STRICTLY PRESERVING its format.

CRITICAL FORMAT PRESERVATION RULES:
${'═'.repeat(60)}
The input has EXACTLY ${inputFormat.itemCount} numbered items.
Your output MUST have EXACTLY ${inputFormat.itemCount} numbered items.
${inputFormat.hasQuotedClaims ? 'Each item MUST begin with the original quoted claim VERBATIM.' : ''}
DO NOT add new items. DO NOT remove items. DO NOT renumber.
Preserve the EXACT structure: item numbers, quoted claims, paragraph breaks.
${'═'.repeat(60)}

YOUR TASK:
1. For each numbered item, integrate objection responses to strengthen the defense
2. Keep the same item number and quoted claim header
3. Improve the content to address relevant objections
4. DO NOT change the format, numbering, or quoted claim text

${customInstructions ? `USER'S ORIGINAL FORMAT INSTRUCTIONS (must be maintained):\n${customInstructions}` : ''}`;

  const userPrompt = `DOCUMENT TO IMPROVE (preserve format exactly):
${formattedInput}

OBJECTIONS TO ADDRESS (integrate responses without changing format):
${objectionsOutput.substring(0, 5000)}

Output the improved document with EXACTLY ${inputFormat.itemCount} numbered items, preserving the exact format.`;

  onProgress?.('rewriting', 2, 3, `Strengthening ${inputFormat.itemCount} items against objections...`);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });

    const output = (response.content[0] as any).text;
    
    // Validate output format
    const outputFormat = detectInputNumberedFormat(output);
    
    onProgress?.('finalizing', 3, 3, `Format preserved: ${outputFormat.itemCount} items`);
    
    if (outputFormat.itemCount !== inputFormat.itemCount) {
      console.warn(`[FORMAT-PRESERVE] Item count mismatch: expected ${inputFormat.itemCount}, got ${outputFormat.itemCount}`);
    }
    
    return {
      success: true,
      output: output.trim(),
      sectionsProcessed: inputFormat.itemCount,
      objectionsAddressed: 0
    };
  } catch (error: any) {
    console.error("[FORMAT-PRESERVE] Error:", error);
    return {
      success: false,
      output: '',
      sectionsProcessed: 0,
      objectionsAddressed: 0,
      error: error.message
    };
  }
}

/**
 * Direct format-aware rewrite for non-essay formats (glossary, lists, etc.)
 * Bypasses section-based processing to respect exact format requirements
 */
async function directFormatRewrite(
  originalText: string,
  objectionsOutput: string,
  customInstructions: string,
  onProgress?: ProgressCallback
): Promise<ObjectionProofResult> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  
  onProgress?.('analyzing', 1, 3, 'Analyzing format requirements...');
  
  const formatInfo = detectSpecialFormat(customInstructions);
  
  onProgress?.('rewriting', 2, 3, 'Generating formatted output...');
  
  const systemPrompt = `You are a precise document formatter. Your ONLY job is to produce output that EXACTLY matches the format specifications.

CRITICAL FORMAT INSTRUCTIONS - THESE OVERRIDE EVERYTHING ELSE:
${'═'.repeat(60)}
${customInstructions}
${'═'.repeat(60)}

YOU MUST:
1. Follow the format instructions EXACTLY - no deviations
2. If instructed to produce ${formatInfo.itemCount || 'a specific number of'} items, produce EXACTLY that many
3. If instructed "NO paragraphs" - produce NO paragraphs
4. If instructed "NO numbered lists" - DO NOT use numbered lists
5. Match the EXACT format described (bold terms, colons, etc.)

YOU MUST NOT:
1. Add extra content beyond what is specified
2. Change the format to something "better" - follow instructions EXACTLY
3. Add explanations or commentary
4. Use a different structure than specified

The objections below should inform the CONTENT but NOT change the FORMAT.
Your output format MUST match the instructions EXACTLY.`;

  const userPrompt = `ORIGINAL TEXT TO TRANSFORM:
${originalText}

OBJECTIONS & COUNTER-ARGUMENTS TO CONSIDER (for content quality only - do NOT change format):
${objectionsOutput.substring(0, 3000)}

PRODUCE OUTPUT IN THE EXACT FORMAT SPECIFIED IN YOUR INSTRUCTIONS.
Output ONLY the formatted content - no meta-commentary.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });

    const output = (response.content[0] as any).text;
    
    onProgress?.('finalizing', 3, 3, 'Format output generated');
    
    // Return ONLY the formatted output - no extra headers or summaries
    // The user's format instructions demand clean output
    return {
      success: true,
      output: output.trim(),
      sectionsProcessed: 1,
      objectionsAddressed: 0
    };
    
  } catch (error: any) {
    console.error("[OBJECTION-PROOF] Format rewrite error:", error);
    return {
      success: false,
      output: '',
      sectionsProcessed: 0,
      objectionsAddressed: 0,
      error: `Format rewrite failed: ${error.message}`
    };
  }
}

export function shouldUseOutlineFirstObjectionProof(text: string): boolean {
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  return wordCount >= WORD_THRESHOLD;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function parseObjections(objectionsOutput: string): ParsedObjection[] {
  const objections: ParsedObjection[] = [];
  
  const categoryPatterns = [
    { pattern: /LOGICAL\s*(?:OBJECTIONS|AND\s*STRUCTURAL)/i, category: 'logical' },
    { pattern: /EVIDENTIAL\s*(?:OBJECTIONS|AND\s*FACTUAL)/i, category: 'evidential' },
    { pattern: /PRACTICAL\s*(?:OBJECTIONS|AND\s*IMPLEMENTATION)/i, category: 'practical' },
    { pattern: /AUDIENCE[- ]SPECIFIC/i, category: 'audience' },
    { pattern: /METHODOLOGICAL/i, category: 'methodological' }
  ];
  
  let currentCategory = 'general';
  const lines = objectionsOutput.split('\n');
  let currentObjection: Partial<ParsedObjection> | null = null;
  let inResponse = false;
  let responseBuffer = '';
  let objectionTextBuffer = '';
  
  for (const line of lines) {
    for (const { pattern, category } of categoryPatterns) {
      if (pattern.test(line)) {
        currentCategory = category;
        break;
      }
    }
    
    const objMatch = line.match(/^(?:\*\*)?OBJECTION\s*#?(\d+):?\*?\*?\s*(?:\[(DEVASTATING|FORCEFUL|MINOR)\])?\s*(.*)/i) ||
                     line.match(/^(\d+)\.\s*\*?\*?(?:OBJECTION|Objection)?:?\*?\*?\s*(?:\[(DEVASTATING|FORCEFUL|MINOR)\])?\s*(.*)/i);
    if (objMatch) {
      if (currentObjection && currentObjection.number) {
        if (objectionTextBuffer.trim()) {
          currentObjection.objection = objectionTextBuffer.trim();
        }
        currentObjection.response = responseBuffer.trim();
        objections.push(currentObjection as ParsedObjection);
      }
      
      const severityFromMatch = objMatch[2] ? objMatch[2].toLowerCase() as 'devastating' | 'forceful' | 'minor' : 'forceful';
      const objText = objMatch[3] || '';
      
      currentObjection = {
        number: parseInt(objMatch[1]),
        category: currentCategory,
        severity: severityFromMatch,
        objection: objText.trim(),
        response: ''
      };
      objectionTextBuffer = objText.trim();
      inResponse = false;
      responseBuffer = '';
      continue;
    }
    
    const severityMatch = line.match(/\[?(DEVASTATING|FORCEFUL|MINOR)\]?/i);
    if (severityMatch && currentObjection && !currentObjection.objection) {
      currentObjection.severity = severityMatch[1].toLowerCase() as 'devastating' | 'forceful' | 'minor';
    }
    
    if (/^\*?\*?(?:RESPONSE|Counter-?argument|Reply):?\*?\*?/i.test(line)) {
      inResponse = true;
      const afterColon = line.split(/:/)[1];
      if (afterColon) responseBuffer += afterColon.trim() + ' ';
      continue;
    }
    
    if (line.trim() === '---' || line.trim() === '═══════════════════════════════════════════════════') {
      continue;
    }
    
    if (inResponse && currentObjection) {
      responseBuffer += line.trim() + ' ';
    } else if (currentObjection && !inResponse && line.trim() && !line.startsWith('═')) {
      objectionTextBuffer += ' ' + line.trim();
    }
  }
  
  if (currentObjection && currentObjection.number) {
    if (objectionTextBuffer.trim() && !currentObjection.objection) {
      currentObjection.objection = objectionTextBuffer.trim();
    }
    currentObjection.response = responseBuffer.trim();
    objections.push(currentObjection as ParsedObjection);
  }
  
  return objections;
}

function createDeterministicSections(text: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  
  if (paragraphs.length === 0) {
    return [{
      id: 1,
      title: 'Full Document',
      content: text.trim(),
      wordCount: countWords(text),
      relevantObjections: []
    }];
  }
  
  // Check if the document has claim-based structure
  // Matches: "Claim 1:", "Position 1:", "1. Title", "1. "Quote"", numbered sections, etc.
  const claimPattern = /^(?:Claim\s*\d+[:.]|Position\s*\d+[:.]|Thesis\s*\d+[:.]|Point\s*\d+[:.]|\d+\.\s+[A-Z""])/i;
  const hasClaimStructure = paragraphs.some(p => claimPattern.test(p.trim()));
  
  console.log(`[OBJECTION-PROOF] Checking structure: hasClaimStructure=${hasClaimStructure}`);
  console.log(`[OBJECTION-PROOF] Sample first paragraphs: ${paragraphs.slice(0, 3).map(p => p.trim().substring(0, 60)).join(' | ')}`);
  
  if (hasClaimStructure) {
    // CLAIM-AWARE SECTIONING: Keep each claim with its following paragraphs as a unit
    let currentClaim: string[] = [];
    let currentClaimTitle = '';
    let sectionId = 1;
    
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i].trim();
      const isClaimHeader = claimPattern.test(para);
      
      if (isClaimHeader) {
        // Save previous claim section if exists
        if (currentClaim.length > 0) {
          const content = currentClaim.join('\n\n').trim();
          sections.push({
            id: sectionId,
            title: currentClaimTitle || `Section ${sectionId}`,
            content,
            wordCount: countWords(content),
            relevantObjections: []
          });
          sectionId++;
        }
        
        // Start new claim section
        currentClaim = [para];
        // Extract claim title - works with "Claim 1:", "1. Title", or "1. "Quote""
        const titleMatch = para.match(/^((?:Claim|Position|Thesis|Point)\s*\d+[:.]?\s*[""]?[^"""\n]{0,80}|\d+\.\s+[^.\n]{0,100})/i);
        currentClaimTitle = titleMatch ? titleMatch[1].trim() : `Section ${sectionId}`;
      } else {
        // Add to current claim section
        currentClaim.push(para);
      }
    }
    
    // Save final claim section
    if (currentClaim.length > 0) {
      const content = currentClaim.join('\n\n').trim();
      sections.push({
        id: sectionId,
        title: currentClaimTitle || `Section ${sectionId}`,
        content,
        wordCount: countWords(content),
        relevantObjections: []
      });
    }
    
    console.log(`[OBJECTION-PROOF] Detected claim-based structure: ${sections.length} claims`);
    return sections;
  }
  
  // FALLBACK: Word-count-based sectioning for non-claim-structured documents
  const totalWords = countWords(text);
  const targetSections = Math.max(2, Math.ceil(totalWords / TARGET_SECTION_SIZE));
  const targetWordsPerSection = Math.ceil(totalWords / targetSections);
  
  let currentSection: string[] = [];
  let currentWordCount = 0;
  let sectionId = 1;
  
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const paraWords = countWords(para);
    
    currentSection.push(para);
    currentWordCount += paraWords;
    
    const isLastParagraph = i === paragraphs.length - 1;
    const reachedTarget = currentWordCount >= targetWordsPerSection;
    const nextParaTooLarge = !isLastParagraph && (currentWordCount + countWords(paragraphs[i + 1]) > targetWordsPerSection * 1.5);
    
    if (isLastParagraph || (reachedTarget && (nextParaTooLarge || currentWordCount >= targetWordsPerSection))) {
      const content = currentSection.join('\n\n').trim();
      sections.push({
        id: sectionId,
        title: `Section ${sectionId}`,
        content,
        wordCount: countWords(content),
        relevantObjections: []
      });
      sectionId++;
      currentSection = [];
      currentWordCount = 0;
    }
  }
  
  if (currentSection.length > 0) {
    const content = currentSection.join('\n\n').trim();
    sections.push({
      id: sectionId,
      title: `Section ${sectionId}`,
      content,
      wordCount: countWords(content),
      relevantObjections: []
    });
  }
  
  return sections;
}

async function mapObjectionsToSectionsContentAware(
  sections: DocumentSection[],
  objections: ParsedObjection[],
  onProgress?: ProgressCallback
): Promise<DocumentSection[]> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  
  onProgress?.('mapping', 0, 1, 'Analyzing content to map objections...');
  
  if (sections.length === 1) {
    sections[0].relevantObjections = objections.map(o => o.number);
    return sections;
  }
  
  const sectionPreviews = sections.map(s => {
    const content = s.content;
    const words = content.split(/\s+/);
    let preview: string;
    if (words.length <= 400) {
      preview = content;
    } else {
      const firstHalf = words.slice(0, 200).join(' ');
      const lastHalf = words.slice(-150).join(' ');
      preview = `${firstHalf}\n[...middle content omitted...]\n${lastHalf}`;
    }
    return {
      id: s.id,
      preview,
      wordCount: s.wordCount
    };
  });
  
  const objectionList = objections.map(o => ({
    number: o.number,
    severity: o.severity,
    category: o.category,
    text: o.objection.substring(0, 250)
  }));

  const systemPrompt = `You are analyzing document sections to determine where each objection should be addressed.

RULES FOR MAPPING:
1. Map each objection to the section(s) where the objectionable content actually appears
2. DEVASTATING objections MUST be mapped to sections containing the vulnerable claims
3. An objection can map to multiple sections if the issue spans sections
4. Every objection MUST appear in at least one section
5. Global objections (about overall approach/methodology) should go in introduction OR conclusion

Return a JSON object mapping objection numbers to section ID arrays:
{
  "1": [1, 2],
  "2": [2],
  "3": [1, 3],
  ...
}

IMPORTANT: Every objection number must appear as a key with at least one section.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `SECTIONS:\n${JSON.stringify(sectionPreviews, null, 2)}\n\nOBJECTIONS:\n${JSON.stringify(objectionList, null, 2)}\n\nMap each objection to the most relevant section(s).`
      }]
    });

    const responseText = (response.content[0] as any).text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) throw new Error("No JSON found in response");
    
    const mapping: Record<string, number[]> = JSON.parse(jsonMatch[0]);
    const validSectionIds = new Set(sections.map(s => s.id));
    
    for (const section of sections) {
      section.relevantObjections = [];
    }
    
    let invalidMappings = 0;
    for (const [objNumStr, sectionIds] of Object.entries(mapping)) {
      const objNum = parseInt(objNumStr);
      if (isNaN(objNum)) continue;
      
      const validIds = (Array.isArray(sectionIds) ? sectionIds : [sectionIds])
        .filter(id => validSectionIds.has(id));
      
      if (validIds.length === 0) {
        invalidMappings++;
        continue;
      }
      
      for (const sectionId of validIds) {
        const section = sections.find(s => s.id === sectionId);
        if (section && !section.relevantObjections.includes(objNum)) {
          section.relevantObjections.push(objNum);
        }
      }
    }
    
    if (invalidMappings > 0) {
      console.log(`[OBJECTION-PROOF] ${invalidMappings} mappings had invalid section IDs`);
    }
    
    const mappedObjNums = new Set(
      sections.flatMap(s => s.relevantObjections)
    );
    const unmapped = objections.filter(o => !mappedObjNums.has(o.number));
    
    if (unmapped.length > 0) {
      console.log(`[OBJECTION-PROOF] ${unmapped.length} objections unmapped, distributing...`);
      for (const obj of unmapped) {
        if (obj.severity === 'devastating') {
          sections[0].relevantObjections.push(obj.number);
        } else {
          const minSection = sections.reduce((min, s) => 
            s.relevantObjections.length < min.relevantObjections.length ? s : min
          );
          minSection.relevantObjections.push(obj.number);
        }
      }
    }
    
    console.log(`[OBJECTION-PROOF] Content-aware mapping complete:`, 
      sections.map(s => `S${s.id}: ${s.relevantObjections.length} objections`).join(', '));
    
    onProgress?.('mapping', 1, 1, 'Objection mapping complete');
    return sections;
    
  } catch (error: any) {
    console.error("[OBJECTION-PROOF] Content-aware mapping failed, using fallback:", error);
    return mapObjectionsToSectionsFallback(sections, objections);
  }
}

function mapObjectionsToSectionsFallback(
  sections: DocumentSection[],
  objections: ParsedObjection[]
): DocumentSection[] {
  const devastating = objections.filter(o => o.severity === 'devastating');
  const others = objections.filter(o => o.severity !== 'devastating');
  
  for (const section of sections) {
    section.relevantObjections = [];
  }
  
  for (const obj of devastating) {
    sections[0].relevantObjections.push(obj.number);
    if (sections.length > 1) {
      sections[sections.length - 1].relevantObjections.push(obj.number);
    }
  }
  
  const perSection = Math.ceil(others.length / sections.length);
  for (let i = 0; i < others.length; i++) {
    const sectionIdx = Math.min(Math.floor(i / perSection), sections.length - 1);
    sections[sectionIdx].relevantObjections.push(others[i].number);
  }
  
  return sections;
}

function extractClaimHeader(content: string): string | null {
  // Match various header styles:
  // - "Claim 1: "quoted text"" 
  // - "1. Title of the Section"
  // - "1. "quoted text""
  const patterns = [
    /^((?:Claim|Position|Thesis|Point)\s*\d+[:.]?\s*[""][^""]+[""])/im,  // Claim 1: "text"
    /^(\d+\.\s+[^.\n]+)/im  // 1. Title text (up to first period or newline)
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

function countParagraphs(text: string): number {
  return text.split(/\n\n+/).filter(p => p.trim().length > 0).length;
}

const FORBIDDEN_HEDGING_PHRASES = [
  'though we acknowledge',
  'though we must acknowledge',
  'while recognizing',
  'while acknowledging',
  'though this doesn\'t necessarily',
  'though this does not necessarily',
  'we must acknowledge that',
  'though one might argue',
  'while one might argue',
  'though it could be argued',
  'while it could be argued',
  'though this represents only',
  'while this represents only',
  'though we cannot definitively',
  'while we cannot definitively'
];

function detectHedging(content: string): string[] {
  const found: string[] = [];
  const lowerContent = content.toLowerCase();
  for (const phrase of FORBIDDEN_HEDGING_PHRASES) {
    if (lowerContent.includes(phrase)) {
      found.push(phrase);
    }
  }
  return found;
}

/**
 * Post-process final output to normalize section numbering.
 * Ensures sections are numbered sequentially (1, 2, 3...) with no gaps or duplicates.
 */
function normalizeSectionNumbering(output: string, expectedSectionCount: number): string {
  // Split by double newlines to process sections
  const parts = output.split(/\n\n+/);
  let currentSectionNumber = 0;
  const seenNumbers = new Set<number>();
  
  const normalizedParts = parts.map((part, index) => {
    // Check if this part starts with a section/claim header pattern
    const headerPatterns = [
      /^(\d+)\.\s+(.*)$/m,  // "1. Title" or "1. "Quote""
      /^(Claim|Position|Thesis|Point)\s+(\d+)[:.]?\s*(.*)/im,  // "Claim 1: text"
      /^Section\s+(\d+)[:.]?\s*(.*)/im  // "Section 1: text"
    ];
    
    let modifiedPart = part;
    
    for (const pattern of headerPatterns) {
      const match = part.match(pattern);
      if (match) {
        // Found a header - check if it needs renumbering
        let existingNumber: number;
        let prefix: string;
        let suffix: string;
        
        if (pattern.source.includes('Claim|Position|Thesis|Point')) {
          // "Claim 1: text" format
          prefix = match[1]; // "Claim"
          existingNumber = parseInt(match[2]);
          suffix = match[3] || '';
          
          currentSectionNumber++;
          if (existingNumber !== currentSectionNumber || seenNumbers.has(existingNumber)) {
            // Needs renumbering
            const oldHeader = match[0];
            const newHeader = `${prefix} ${currentSectionNumber}:${suffix ? ' ' + suffix : ''}`;
            modifiedPart = part.replace(oldHeader, newHeader);
            console.log(`[OBJECTION-PROOF] Renumbered: "${oldHeader.slice(0, 50)}..." -> "${newHeader.slice(0, 50)}..."`);
          }
          seenNumbers.add(currentSectionNumber);
        } else if (pattern.source.includes('Section')) {
          // "Section 1: text" format  
          existingNumber = parseInt(match[1]);
          suffix = match[2] || '';
          
          currentSectionNumber++;
          if (existingNumber !== currentSectionNumber || seenNumbers.has(existingNumber)) {
            const oldHeader = match[0];
            const newHeader = `Section ${currentSectionNumber}:${suffix ? ' ' + suffix : ''}`;
            modifiedPart = part.replace(oldHeader, newHeader);
            console.log(`[OBJECTION-PROOF] Renumbered: "${oldHeader.slice(0, 50)}..." -> "${newHeader.slice(0, 50)}..."`);
          }
          seenNumbers.add(currentSectionNumber);
        } else {
          // "1. Title" format
          existingNumber = parseInt(match[1]);
          suffix = match[2];
          
          currentSectionNumber++;
          if (existingNumber !== currentSectionNumber || seenNumbers.has(existingNumber)) {
            const oldHeader = match[0];
            const newHeader = `${currentSectionNumber}. ${suffix}`;
            modifiedPart = part.replace(oldHeader, newHeader);
            console.log(`[OBJECTION-PROOF] Renumbered: "${oldHeader.slice(0, 50)}..." -> "${newHeader.slice(0, 50)}..."`);
          }
          seenNumbers.add(currentSectionNumber);
        }
        break; // Only match one pattern per part
      }
    }
    
    return modifiedPart;
  });
  
  const result = normalizedParts.join('\n\n');
  
  // Log validation
  if (currentSectionNumber !== expectedSectionCount) {
    console.log(`[OBJECTION-PROOF] Warning: Found ${currentSectionNumber} sections, expected ${expectedSectionCount}`);
  } else {
    console.log(`[OBJECTION-PROOF] Section numbering validated: ${currentSectionNumber} sections numbered sequentially`);
  }
  
  return result;
}

function validateAndFixOutput(
  originalContent: string,
  rewrittenContent: string,
  originalHeader: string | null
): { content: string; fixes: string[]; needsRetry: boolean; retryReason?: string } {
  const fixes: string[] = [];
  let content = rewrittenContent;
  let needsRetry = false;
  let retryReason: string | undefined;
  
  // FIX 1: Ensure claim header is present at start
  if (originalHeader) {
    const headerNormalized = originalHeader.toLowerCase().replace(/\s+/g, ' ').trim();
    const contentStart = content.slice(0, 200).toLowerCase().replace(/\s+/g, ' ');
    
    if (!contentStart.includes(headerNormalized.slice(0, 50))) {
      // Header is missing - prepend it
      content = originalHeader + '\n\n' + content;
      fixes.push('Prepended missing claim header');
    }
  }
  
  // CHECK 2: Paragraph count validation - EXACT MATCH REQUIRED
  const originalParaCount = countParagraphs(originalContent);
  const rewrittenParaCount = countParagraphs(content);
  
  if (rewrittenParaCount !== originalParaCount) {
    fixes.push(`Paragraph count mismatch: original=${originalParaCount}, rewritten=${rewrittenParaCount}`);
    // Require exact match - any deviation triggers retry
    needsRetry = true;
    retryReason = `Paragraph count mismatch: expected exactly ${originalParaCount}, got ${rewrittenParaCount}`;
  }
  
  // CHECK 3: Hedging detection
  const hedgingFound = detectHedging(content);
  if (hedgingFound.length > 2) {
    fixes.push(`Excessive hedging detected: ${hedgingFound.slice(0, 3).join(', ')}...`);
    needsRetry = true;
    retryReason = `Too much hedging (${hedgingFound.length} forbidden phrases found)`;
  } else if (hedgingFound.length > 0) {
    fixes.push(`Minor hedging detected: ${hedgingFound.join(', ')}`);
  }
  
  return { content, fixes, needsRetry, retryReason };
}

async function rewriteSection(
  section: DocumentSection,
  objections: ParsedObjection[],
  state: CrossChunkState,
  customInstructions: string | undefined,
  sectionIndex: number,
  totalSections: number,
  onProgress?: ProgressCallback,
  retryCount: number = 0
): Promise<{ rewrittenContent: string; updatedState: CrossChunkState; error?: string }> {
  const MAX_RETRIES = 0;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  
  onProgress?.('rewriting', sectionIndex, totalSections, `Rewriting section ${sectionIndex + 1}/${totalSections}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
  
  const relevantObjections = objections.filter(o => section.relevantObjections.includes(o.number));
  const devastatingCount = relevantObjections.filter(o => o.severity === 'devastating').length;
  const forcefulCount = relevantObjections.filter(o => o.severity === 'forceful').length;
  const minorCount = relevantObjections.filter(o => o.severity === 'minor').length;
  
  // Extract the original claim header for validation
  const originalHeader = extractClaimHeader(section.content);
  const originalParaCount = countParagraphs(section.content);
  
  // Build stricter prompt on retry
  const stricterOnRetry = retryCount > 0 ? `

CRITICAL CORRECTION (previous attempt failed validation):
- You MUST output EXACTLY ${originalParaCount} paragraphs - no more, no less
- You MUST NOT use any hedging phrases like "though we acknowledge" or "while recognizing"
- Count your paragraphs before submitting - there must be exactly ${originalParaCount}` : '';

  // Parse section number from title for correct output numbering
  const sectionNumberMatch = section.title.match(/^(?:Section\s+)?(\d+)/i) || 
                              section.title.match(/^(\d+)\./);
  const expectedSectionNumber = sectionNumberMatch ? parseInt(sectionNumberMatch[1]) : sectionIndex + 1;
  
  // Build custom instructions block - these define the OUTPUT FORMAT and MUST be followed
  const customInstructionsBlock = customInstructions ? `
CRITICAL - ORIGINAL USER INSTRUCTIONS (MUST FOLLOW FOR OUTPUT FORMAT):
═══════════════════════════════════════════════════════════════
${customInstructions}
═══════════════════════════════════════════════════════════════
These instructions define the FORMAT of your output. The ONLY exception is that the document
may be LONGER to accommodate objection responses. But ALL OTHER formatting requirements 
(headers, structure, numbering, quotes, paragraph structure) MUST be followed exactly.
` : '';

  const systemPrompt = `You are an expert editor creating a BULLET-PROOF version of a document section.
${customInstructionsBlock}
CRITICAL STRUCTURAL RULES - ABSOLUTE REQUIREMENTS:
1. THIS IS SECTION ${expectedSectionNumber} - if adding section numbers, use "${expectedSectionNumber}." or "Section ${expectedSectionNumber}"
2. START with the EXACT claim header: ${originalHeader ? `"${originalHeader}"` : 'Preserve any header exactly as-is'}
3. OUTPUT EXACTLY ${originalParaCount} PARAGRAPHS (same as input) - THIS IS MANDATORY
4. DO NOT add new sections, duplicate content, or merge paragraphs
5. PRESERVE all quoted text VERBATIM - do not paraphrase claims in quotes
6. DO NOT use different section numbers - this section is #${expectedSectionNumber}${stricterOnRetry}

CONTEXT:
- This is section ${expectedSectionNumber} of ${totalSections}
- Current section has ${section.wordCount} words and ${originalParaCount} paragraphs
${state.previousSectionSummary ? `- Previous section context: "${state.previousSectionSummary}"` : '- This is the opening section'}
${state.addressedObjections.length > 0 ? `- Objections already addressed: #${state.addressedObjections.join(', #')}` : ''}

OBJECTIONS TO INTEGRATE (${relevantObjections.length} total: ${devastatingCount} devastating, ${forcefulCount} forceful, ${minorCount} minor):
${relevantObjections.map(o => `
[${o.severity.toUpperCase()}] #${o.number}: ${o.objection}
Counter-argument to integrate: ${o.response || 'Address with confidence'}
`).join('\n')}

HOW TO MAKE BULLET-PROOF (NOT bullet-apologetic):
1. INTEGRATE counter-arguments INTO confident assertions - NO hedging qualifiers
2. PREEMPTIVELY address objections by STRENGTHENING claims, not weakening them
3. BUILD objection-responses into the prose as if anticipating and DISMISSING criticism
4. ABSOLUTELY FORBIDDEN phrases (will cause rejection): "though we acknowledge", "while recognizing", "though this doesn't necessarily", "we must acknowledge that", "while acknowledging", "though one might argue"
5. Goal: CONFIDENT prose impervious to criticism, NOT tentative prose stuffed with qualifications

WRONG (hedging - will be rejected):
"Psychosis involves reality disconnection, though we must acknowledge that this represents one piece of evidence..."

RIGHT (bullet-proof - this is what we want):
"Psychosis involves reality disconnection - a claim supported by decades of clinical observation. Critics who point to overlapping symptoms miss the fundamental distinction..."

OUTPUT FORMAT:
${originalHeader ? `Line 1: ${originalHeader}` : 'Start with the original header if present'}
Then: Exactly ${originalParaCount} paragraphs of bullet-proof prose
Final line: SUMMARY: [10-15 word transition context]`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 6000,
      system: systemPrompt,
      messages: [{ role: "user", content: `REVISE this section to be bullet-proof. KEEP the exact header and exactly ${originalParaCount} paragraphs:\n\n${section.content}` }]
    });

    const responseText = (response.content[0] as any).text;
    
    let rewrittenContent = responseText;
    let summary = '';
    
    const summaryMatch = responseText.match(/SUMMARY:\s*(.+)$/im);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
      rewrittenContent = responseText.substring(0, summaryMatch.index).trim();
    }
    
    // POST-PROCESSING VALIDATION: Fix structural issues
    const { content: validatedContent, fixes, needsRetry, retryReason } = validateAndFixOutput(
      section.content,
      rewrittenContent,
      originalHeader
    );
    
    if (fixes.length > 0) {
      console.log(`[OBJECTION-PROOF] Section ${sectionIndex + 1} fixes applied: ${fixes.join('; ')}`);
    }
    
    // RETRY MECHANISM: If validation failed and we have retries left
    if (needsRetry && retryCount < MAX_RETRIES) {
      console.log(`[OBJECTION-PROOF] Section ${sectionIndex + 1} needs retry: ${retryReason}`);
      await new Promise(resolve => setTimeout(resolve, 500)); // Brief delay before retry
      return rewriteSection(
        section,
        objections,
        state,
        customInstructions,
        sectionIndex,
        totalSections,
        onProgress,
        retryCount + 1
      );
    }
    
    const updatedState: CrossChunkState = {
      addressedObjections: [...state.addressedObjections, ...relevantObjections.map(o => o.number)],
      keyTerminology: { ...state.keyTerminology },
      styleNotes: [...state.styleNotes],
      previousSectionSummary: summary || validatedContent.slice(-100),
      cumulativeWordCount: state.cumulativeWordCount + countWords(validatedContent),
      targetWordCount: state.targetWordCount
    };
    
    return { rewrittenContent: validatedContent, updatedState };
    
  } catch (error: any) {
    console.error(`[OBJECTION-PROOF] Section ${sectionIndex + 1} rewrite failed:`, error);
    return {
      rewrittenContent: section.content,
      updatedState: state,
      error: `Section ${sectionIndex + 1} failed: ${error.message}`
    };
  }
}

export async function generateOutlineFirstObjectionProof(
  originalText: string,
  objectionsOutput: string,
  customInstructions?: string,
  onProgress?: ProgressCallback
): Promise<ObjectionProofResult> {
  const errors: string[] = [];
  
  try {
    const totalWords = countWords(originalText);
    console.log(`[OBJECTION-PROOF] Starting outline-first processing for ${totalWords} words`);
    
    // CHECK FOR SPECIAL FORMAT FIRST - bypass section-based processing for glossaries, lists, etc.
    const formatInfo = detectSpecialFormat(customInstructions);
    if (formatInfo.isSpecialFormat && customInstructions) {
      console.log(`[OBJECTION-PROOF] Special format detected: ${formatInfo.formatType}${formatInfo.itemCount ? ` (${formatInfo.itemCount} items)` : ''}`);
      console.log(`[OBJECTION-PROOF] Bypassing section-based processing, using direct format rewrite`);
      return directFormatRewrite(originalText, objectionsOutput, customInstructions, onProgress);
    }
    
    // CHECK IF INPUT IS ALREADY IN NUMBERED FORMAT (from reconstruction)
    // If so, preserve that format rather than breaking it with section-based processing
    const inputFormat = detectInputNumberedFormat(originalText);
    if (inputFormat.isNumberedFormat && inputFormat.itemCount >= 3) {
      console.log(`[OBJECTION-PROOF] Input already in numbered format: ${inputFormat.itemCount} items, quoted claims: ${inputFormat.hasQuotedClaims}`);
      console.log(`[OBJECTION-PROOF] Using format-preserving rewrite to maintain structure`);
      return formatPreservingRewrite(originalText, objectionsOutput, inputFormat, customInstructions, onProgress);
    }
    
    onProgress?.('init', 0, 4, `Processing ${totalWords} word document...`);
    
    const objections = parseObjections(objectionsOutput);
    console.log(`[OBJECTION-PROOF] Parsed ${objections.length} objections`);
    
    if (objections.length === 0) {
      return {
        success: false,
        output: '',
        sectionsProcessed: 0,
        objectionsAddressed: 0,
        error: 'Could not parse objections. Ensure the objections are in the expected format (numbered list with categories).'
      };
    }
    
    onProgress?.('structure', 1, 4, 'Creating document sections...');
    let sections = createDeterministicSections(originalText);
    console.log(`[OBJECTION-PROOF] Created ${sections.length} sections`);
    
    onProgress?.('mapping', 2, 4, 'Mapping objections to sections...');
    sections = await mapObjectionsToSectionsContentAware(sections, objections, onProgress);
    
    const devastatingCount = objections.filter(o => o.severity === 'devastating').length;
    const forcefulCount = objections.filter(o => o.severity === 'forceful').length;
    console.log(`[OBJECTION-PROOF] Objection breakdown: ${devastatingCount} devastating, ${forcefulCount} forceful, ${objections.length - devastatingCount - forcefulCount} minor`);
    
    let state: CrossChunkState = {
      addressedObjections: [],
      keyTerminology: {},
      styleNotes: [],
      previousSectionSummary: '',
      cumulativeWordCount: 0,
      targetWordCount: totalWords
    };
    
    const rewrittenSections: string[] = [];
    
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      onProgress?.('rewriting', 3, 4, `Rewriting section ${i + 1}/${sections.length}...`);
      
      const { rewrittenContent, updatedState, error } = await rewriteSection(
        section,
        objections,
        state,
        customInstructions,
        i,
        sections.length,
        onProgress
      );
      
      if (error) {
        errors.push(error);
      }
      
      rewrittenSections.push(rewrittenContent);
      state = updatedState;
      
      if (i < sections.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    onProgress?.('finalizing', 4, 4, 'Assembling final document...');
    
    // Join sections and normalize section numbering to ensure no gaps/duplicates
    const rawOutput = rewrittenSections.join('\n\n');
    const finalOutput = normalizeSectionNumbering(rawOutput, sections.length);
    const addressedCount = new Set(state.addressedObjections).size;
    
    // Capture section info for display
    const sectionInfo: SectionInfo[] = sections.map(s => ({
      id: s.id,
      title: s.title,
      wordCount: s.wordCount,
      objectionsMapped: s.relevantObjections
    }));
    
    // Calculate objection breakdown (reuse earlier calculations)
    const finalDevastatingCount = objections.filter(o => o.severity === 'devastating').length;
    const finalForcefulCount = objections.filter(o => o.severity === 'forceful').length;
    const minorCount = objections.length - finalDevastatingCount - finalForcefulCount;
    
    const summary = `
${'═'.repeat(60)}
PROCESSING SUMMARY
${'═'.repeat(60)}
Original: ${totalWords} words | Rewritten: ${countWords(finalOutput)} words
Sections: ${sections.length} | Objections addressed: ${addressedCount}/${objections.length}
${errors.length > 0 ? `\nWarnings:\n${errors.join('\n')}` : ''}
${'═'.repeat(60)}`;

    return {
      success: true,
      output: finalOutput + summary,
      sectionsProcessed: sections.length,
      objectionsAddressed: addressedCount,
      sections: sectionInfo,
      objectionBreakdown: { devastating: finalDevastatingCount, forceful: finalForcefulCount, minor: minorCount }
    };
    
  } catch (error: any) {
    console.error("[OBJECTION-PROOF] Fatal error:", error);
    return {
      success: false,
      output: '',
      sectionsProcessed: 0,
      objectionsAddressed: 0,
      error: `Processing failed: ${error.message}`
    };
  }
}
