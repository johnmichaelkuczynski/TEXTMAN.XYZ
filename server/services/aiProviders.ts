import OpenAI from "openai";
import Anthropic from '@anthropic-ai/sdk';

/*
<important_code_snippet_instructions>
The newest OpenAI model is "gpt-4o" which was released May 13, 2024. Do not change this unless explicitly requested by the user.
The newest Anthropic model is "claude-sonnet-4-20250514", not "claude-3-7-sonnet-20250219", "claude-3-7-sonnet-20250219" nor "claude-3-sonnet-20240229". 
</important_code_snippet_instructions>
*/

// <important_do_not_delete>
const DEFAULT_OPENAI_MODEL = "gpt-4o";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
// </important_do_not_delete>

let openai: OpenAI | null = null;
let anthropic: Anthropic | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

function getAnthropic(): Anthropic {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

const PRESET_TEXT: Record<string,string> = {
  // Advanced Techniques
  "Mixed cadence + clause sprawl": "Alternate short and long sentences; allow some long sentences to wander with extra clauses.",
  "Asymmetric emphasis": "Over-elaborate one point; compress or skate past another.",
  "One aside": "Add a quick parenthetical or em-dash remark — factual, not jokey.",
  "Hedge twice": "Use two mild uncertainty markers (\"probably,\" \"seems,\" \"roughly,\" \"I think\").",
  "Local disfluency": "Keep one redundant or slightly awkward phrase that still makes sense.",
  "Analogy injection": "Insert a short, concrete comparison to something unrelated but illustrative.",
  "Topic snap": "Abruptly shift focus once, then return.",
  "Friction detail": "Drop in a small, seemingly unnecessary but real-world-plausible detail.",
  
  "Compression — light (−15%)": "Cut filler; merge short clauses; keep meaning. Target ≈15% shorter.",
  "Compression — medium (−30%)": "Trim hard; delete throat-clearing; tighten syntax. Target ≈30% shorter.",
  "Compression — heavy (−45%)": "Sever redundancies; collapse repeats; keep core claims. Target ≈45% shorter.",
  "Mixed cadence": "Alternate short (5–12 words) and long (20–35 words) sentences; avoid uniform rhythm.",
  "Clause surgery": "Reorder main/subordinate clauses in ~30% of sentences without changing meaning.",
  "Front-load claim": "Put the main conclusion in sentence 1; evidence follows.",
  "Back-load claim": "Delay the main conclusion to the final 2–3 sentences.",
  "Seam/pivot": "Drop smooth connectors once; allow one abrupt thematic pivot.",
  "Imply one step": "Omit one obvious inferential step; keep it implicit (context makes it recoverable).",
  "Conditional framing": "Recast one key sentence as: If/Unless …, then …. Keep content identical.",
  "Local contrast": "Use exactly one contrast marker (but/except/aside) to mark a boundary; add no new facts.",
  "Scope check": "Replace one absolute with a bounded form (e.g., 'in cases like these').",
  "Deflate jargon": "Swap nominalizations for plain verbs where safe (e.g., utilization→use).",
  "Kill stock transitions": "Delete 'Moreover/Furthermore/In conclusion' everywhere.",
  "Hedge once": "Use exactly one hedge: probably/roughly/more or less.",
  "Drop intensifiers": "Remove 'very/clearly/obviously/significantly'.",
  "Low-heat voice": "Prefer plain verbs; avoid showy synonyms.",
  "Concrete benchmark": "Replace one vague scale with a testable one (e.g., 'enough to X').",
  "Swap generic example": "If the source has an example, make it slightly more specific; else skip.",
  "Metric nudge": "Replace 'more/better' with a minimal, source-safe comparator (e.g., 'more than last case').",
  "Cull repeats": "Delete duplicated sentences/ideas; keep the strongest instance.",
  "No lists": "Output as continuous prose; remove bullets/numbering.",
  "No meta": "No prefaces/apologies/phrases like 'as requested'.",
  "Exact nouns": "Replace ambiguous pronouns with exact nouns.",
  "Quote once": "If the source has a strong phrase, quote it once; otherwise skip.",
  "Claim lock": "Do not add examples, scenarios, or data not present in the source.",
  "Entity lock": "Keep names, counts, and attributions exactly as given.",
  // Combo presets expand to atomic ones:
  "Lean & Sharp": "Compression — medium (−30%); Mixed cadence; Imply one step; Kill stock transitions",
  "Analytic": "Clause surgery; Front-load claim; Scope check; Exact nouns; No lists",
};

function expandPresets(selected: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const txt = PRESET_TEXT[name];
    if (!txt) return;
    if (txt.includes(";") && !txt.includes("…")) {
      // combo: split by ';' and add atomic names
      txt.split(";").map(s => s.trim()).forEach(alias => { if (PRESET_TEXT[alias] && !seen.has(alias)) { seen.add(alias); out.push(alias); }});
    } else {
      if (!seen.has(name)) { seen.add(name); out.push(name); }
    }
  };
  selected.forEach(add);
  return out;
}

function buildPresetBlock(selectedPresets?: string[], customInstructions?: string): string {
  const expanded = expandPresets(selectedPresets || []);
  const lines: string[] = [];
  expanded.forEach(name => { lines.push(`- ${PRESET_TEXT[name]}`); });
  const custom = (customInstructions || "").trim();
  if (custom) lines.push(`- ${custom}`);
  if (lines.length === 0) return "";
  return `Apply ONLY these additional rewrite instructions (no other goals):\n${lines.join("\n")}\n\n`;
}

function buildRewritePrompt(params: {
  inputText: string;
  styleText?: string;
  contentMixText?: string;
  selectedPresets?: string[];
  customInstructions?: string;
}): string {
  const hasStyle = !!(params.styleText && params.styleText.trim() !== "");
  const hasContent = !!(params.contentMixText && params.contentMixText.trim() !== "");
  const styleSample = hasStyle ? params.styleText! : `DEFAULT STYLE SAMPLE (The Raven Paradox):

Presumably, logically equivalent statements are confirmationally equivalent. In other words, if two statements entail each other, then anything that one confirms the one statement to a given degree also confirms the other statement to that degree. But this actually seems false when consider statement-pairs such as: 

(i) All ravens are black, 
and 
(ii) All non-black things are non-ravens, 

which, though logically equivalent, seem to confirmationally equivalent, in that a non-black non-raven confirms (ii) to a high degree but confirms (i) to no degree or at most to a low degree. 
A number of very contrived solutions to this paradox have been proposed, all of which either deny that there is a paradox or invent ad hoc systems of logic to validate the 'solution' in question. 
But the real solution is clear. First of all, it is only principled generalizations that can be confirmed. Supposing that you assert (i) with the intention of affirming a principled as opposed to an accidental generalization, you are saying that instances of the property of being a raven grounds or causes instances of blackness. Read thus, (i) is most certainly not equivalent with (ii) or with any variation thereof. Be it noted that while there is a natural nomic or causal reading ...[Truncated]`;

  let prompt = `Rewrite the text below so that its style matches, at a granular level, the style of the following style sample:\n"${styleSample}"\n\n`;

  if (hasContent) {
    prompt += `Judiciously integrate relevant ideas, examples, and details from the following content reference to enrich the rewrite:\n"${params.contentMixText}"\n\n`;
  }

  // <<< PRESETS/APPLIED INSTRUCTIONS HERE >>>
  prompt += buildPresetBlock(params.selectedPresets, params.customInstructions);

  prompt += `Text to rewrite:\n"${params.inputText}"`;
  return prompt;
}

export interface RewriteParams {
  inputText: string;
  styleText?: string;
  contentMixText?: string;
  customInstructions?: string;
  selectedPresets?: string[];
  mixingMode?: 'style' | 'content' | 'both';
}

// Provider priority order for failover (most preferred first)
const PROVIDER_PRIORITY = ['anthropic', 'openai', 'deepseek', 'grok'] as const;

// Check if a provider is configured (has API key)
function isProviderConfigured(provider: string): boolean {
  switch (provider) {
    case 'openai': return !!process.env.OPENAI_API_KEY;
    case 'anthropic': return !!process.env.ANTHROPIC_API_KEY;
    case 'deepseek': return !!process.env.DEEPSEEK_API_KEY;
    case 'grok': return !!process.env.GROK_API_KEY;
    case 'perplexity': return !!process.env.PERPLEXITY_API_KEY;
    default: return false;
  }
}

// Get configured providers in priority order
function getConfiguredProviders(): string[] {
  return PROVIDER_PRIORITY.filter(p => isProviderConfigured(p));
}

export class AIProviderService {
  // Automatic failover: tries providers in sequence until one succeeds
  async rewriteWithFailover(params: RewriteParams, preferredProvider?: string): Promise<string> {
    const configuredProviders = getConfiguredProviders();
    
    if (configuredProviders.length === 0) {
      throw new Error('No AI providers are configured. Please add API keys.');
    }
    
    // Build provider order: preferred first (if configured), then others
    let providerOrder: string[];
    if (preferredProvider && isProviderConfigured(preferredProvider)) {
      providerOrder = [preferredProvider, ...configuredProviders.filter(p => p !== preferredProvider)];
    } else {
      providerOrder = configuredProviders;
    }
    
    let lastError: Error | null = null;
    
    for (const provider of providerOrder) {
      try {
        console.log(`🔄 Trying provider: ${provider}`);
        const result = await this.rewriteSingle(provider, params);
        console.log(`✅ Success with provider: ${provider}`);
        return result;
      } catch (error: any) {
        console.warn(`⚠️ Provider ${provider} failed: ${error.message}`);
        lastError = error;
        // Continue to next provider
      }
    }
    
    // All providers failed
    throw new Error(`All AI providers failed. Last error: ${lastError?.message}`);
  }
  
  // Single provider call (internal use)
  private async rewriteSingle(provider: string, params: RewriteParams): Promise<string> {
    switch (provider) {
      case 'openai': return await this.rewriteWithOpenAI(params);
      case 'anthropic': return await this.rewriteWithAnthropic(params);
      case 'deepseek': return await this.rewriteWithDeepSeek(params);
      case 'grok': return await this.rewriteWithGrok(params);
      case 'perplexity': return await this.rewriteWithPerplexity(params);
      default: throw new Error(`Unknown provider: ${provider}`);
    }
  }

  async rewriteWithOpenAI(params: RewriteParams): Promise<string> {
    console.log("🔥 CALLING OPENAI API - Input length:", params.inputText?.length || 0);
    const prompt = buildRewritePrompt({
      inputText: params.inputText,
      styleText: params.styleText,
      contentMixText: params.contentMixText,
      selectedPresets: params.selectedPresets,
      customInstructions: params.customInstructions,
    });
    console.log("🔥 User prompt length:", prompt.length);
    
    try {
      console.log("🔥 About to make OpenAI API call...");
      const response = await getOpenAI().chat.completions.create({
        model: DEFAULT_OPENAI_MODEL,
        messages: [
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 4000,
      });

      console.log("🔥 OpenAI response received, length:", response.choices[0].message.content?.length || 0);
      return this.cleanMarkup(response.choices[0].message.content || "");
    } catch (error: any) {
      console.error("🔥 OpenAI API ERROR:", error);
      throw new Error(`OpenAI API error: ${error.message}`);
    }
  }

  async rewriteWithAnthropic(params: RewriteParams): Promise<string> {
    console.log("🔥 CALLING ANTHROPIC API - Input length:", params.inputText?.length || 0);
    const prompt = buildRewritePrompt({
      inputText: params.inputText,
      styleText: params.styleText,
      contentMixText: params.contentMixText,
      selectedPresets: params.selectedPresets,
      customInstructions: params.customInstructions,
    });
    console.log("🔥 User prompt length:", prompt.length);
    
    try {
      console.log("🔥 About to make Anthropic API call...");
      const response = await getAnthropic().messages.create({
        model: DEFAULT_ANTHROPIC_MODEL,
        messages: [
          { role: "user", content: prompt }
        ],
        max_tokens: 4000,
        temperature: 0.7,
      });

      const textBlock = response.content[0];
      const text = textBlock.type === 'text' ? textBlock.text : '';
      console.log("🔥 Anthropic response received, length:", text?.length || 0);
      return this.cleanMarkup(text || "");
    } catch (error: any) {
      console.error("🔥 ANTHROPIC API ERROR:", error);
      throw new Error(`Anthropic API error: ${error.message}`);
    }
  }

  async rewriteWithPerplexity(params: RewriteParams): Promise<string> {
    const prompt = buildRewritePrompt({
      inputText: params.inputText,
      styleText: params.styleText,
      contentMixText: params.contentMixText,
      selectedPresets: params.selectedPresets,
      customInstructions: params.customInstructions,
    });
    
    try {
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: "llama-3.1-sonar-small-128k-online",
          messages: [
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 4000,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Perplexity API error: ${response.statusText}`);
      }

      const data = await response.json();
      return this.cleanMarkup(data.choices[0].message.content || "");
    } catch (error: any) {
      throw new Error(`Perplexity API error: ${error.message}`);
    }
  }

  async rewriteWithDeepSeek(params: RewriteParams): Promise<string> {
    const prompt = buildRewritePrompt({
      inputText: params.inputText,
      styleText: params.styleText,
      contentMixText: params.contentMixText,
      selectedPresets: params.selectedPresets,
      customInstructions: params.customInstructions,
    });
    
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 4000,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`DeepSeek API error: ${response.statusText}`);
      }

      const data = await response.json();
      return this.cleanMarkup(data.choices[0].message.content || "");
    } catch (error: any) {
      throw new Error(`DeepSeek API error: ${error.message}`);
    }
  }

  async rewriteWithGrok(params: RewriteParams): Promise<string> {
    const prompt = buildRewritePrompt({
      inputText: params.inputText,
      styleText: params.styleText,
      contentMixText: params.contentMixText,
      selectedPresets: params.selectedPresets,
      customInstructions: params.customInstructions,
    });
    
    try {
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: "grok-3-latest",
          messages: [
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 4000,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Grok API error: ${response.statusText}`);
      }

      const data = await response.json();
      return this.cleanMarkup(data.choices[0].message.content || "");
    } catch (error: any) {
      throw new Error(`Grok API error: ${error.message}`);
    }
  }

  // Main rewrite method - uses automatic failover
  async rewrite(provider: string, params: RewriteParams): Promise<string> {
    console.log(`🔥 REWRITE REQUEST - Provider: ${provider}, Input length: ${params.inputText?.length || 0}`);
    // Use failover system - preferred provider first, then auto-cascade to others
    return await this.rewriteWithFailover(params, provider);
  }

  private cleanMarkup(text: string): string {
    return text
      // Remove markdown bold/italic markers
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      // Remove markdown headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove inline code backticks
      .replace(/`([^`]+)`/g, '$1')
      // Remove code block markers
      .replace(/```[\s\S]*?```/g, (match) => {
        return match.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
      })
      // Remove other common markdown symbols
      .replace(/~~([^~]+)~~/g, '$1') // strikethrough
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
      .replace(/>\s+/gm, '') // blockquotes
      // Remove excessive whitespace and clean up
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

export const aiProviderService = new AIProviderService();