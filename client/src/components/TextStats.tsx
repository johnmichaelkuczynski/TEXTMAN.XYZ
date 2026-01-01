import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Bot, User, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface TextStatsProps {
  text: string;
  label?: string;
  showAiDetect?: boolean;
  variant?: "default" | "compact" | "prominent";
  targetWords?: number;
}

interface AIDetectionResult {
  aiScore: number;
  humanScore: number;
  isAI: boolean;
  confidence: number;
}

export function TextStats({ text, label, showAiDetect = true, variant = "default", targetWords }: TextStatsProps) {
  const [aiResult, setAiResult] = useState<AIDetectionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const charCount = text.length;
  
  const meetsTarget = targetWords ? wordCount >= targetWords : null;

  const handleAiDetect = async () => {
    if (text.trim().length < 50) {
      toast({
        title: "Text Too Short",
        description: "Text must be at least 50 characters for AI detection",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    setError(null);
    setAiResult(null);

    try {
      const response = await fetch("/api/detect-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "AI detection failed");
      }

      const result = await response.json();
      setAiResult(result);
    } catch (err: any) {
      setError(err.message || "Failed to detect AI");
      toast({
        title: "AI Detection Failed",
        description: err.message || "Could not analyze text",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const getAiScoreColor = (score: number) => {
    if (score >= 70) return "bg-red-500 text-white";
    if (score >= 40) return "bg-yellow-500 text-black";
    return "bg-green-500 text-white";
  };

  if (variant === "prominent") {
    return (
      <div 
        className="bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-700 rounded-lg p-3 mb-4"
        data-testid="text-stats-prominent"
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-sky-900 dark:text-sky-100">
              {wordCount.toLocaleString()} words
            </span>
            <span className="text-sm text-sky-600 dark:text-sky-400">
              ({charCount.toLocaleString()} chars)
            </span>
          </div>
          
          {targetWords && (
            <div className="flex items-center gap-2">
              <span 
                className={`text-lg font-bold flex items-center gap-1 ${
                  meetsTarget 
                    ? 'text-green-600 dark:text-green-400' 
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                {meetsTarget ? (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                    Target Met
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-5 h-5" />
                    Below Target
                  </>
                )}
              </span>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                (Target: {targetWords.toLocaleString()})
              </span>
            </div>
          )}
          
          {showAiDetect && (
            <div className="flex items-center gap-2">
              {loading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Checking AI...</span>
                </div>
              ) : aiResult ? (
                <Badge 
                  className={`${getAiScoreColor(aiResult.aiScore)} flex items-center gap-1`}
                  data-testid="badge-ai-score-prominent"
                >
                  <Bot className="w-4 h-4" />
                  {aiResult.aiScore}% AI
                </Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAiDetect}
                  disabled={text.trim().length < 50}
                  data-testid="button-ai-detect-prominent"
                >
                  <Bot className="w-4 h-4 mr-1" />
                  Check AI
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
        <span>{wordCount} words</span>
        <span>{charCount} chars</span>
        {showAiDetect && (
          <>
            {loading ? (
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                Checking...
              </span>
            ) : aiResult ? (
              <Badge className={`text-xs ${getAiScoreColor(aiResult.aiScore)}`}>
                {aiResult.aiScore}% AI
              </Badge>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleAiDetect}
                disabled={text.trim().length < 50}
                className="h-5 px-2 text-xs"
                data-testid="button-ai-detect-compact"
              >
                <Bot className="w-3 h-3 mr-1" />
                Check AI
              </Button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 py-1 px-2 bg-muted/30 rounded text-sm flex-wrap">
      <div className="flex items-center gap-4 text-muted-foreground">
        {label && <span className="font-medium text-foreground">{label}</span>}
        <span data-testid="text-word-count">{wordCount.toLocaleString()} words</span>
        <span data-testid="text-char-count">{charCount.toLocaleString()} chars</span>
      </div>
      
      {showAiDetect && (
        <div className="flex items-center gap-2">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Detecting AI...</span>
            </div>
          ) : aiResult ? (
            <div className="flex items-center gap-2">
              <Badge 
                className={`${getAiScoreColor(aiResult.aiScore)} flex items-center gap-1`}
                data-testid="badge-ai-score"
              >
                <Bot className="w-3 h-3" />
                {aiResult.aiScore}% AI
              </Badge>
              <Badge 
                variant="outline" 
                className="flex items-center gap-1"
                data-testid="badge-human-score"
              >
                <User className="w-3 h-3" />
                {aiResult.humanScore}% Human
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAiResult(null)}
                className="h-7 px-2 text-xs"
                data-testid="button-ai-reset"
              >
                Reset
              </Button>
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="w-4 h-4" />
              <span className="text-xs">{error}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleAiDetect}
                className="h-7 px-2 text-xs"
                data-testid="button-ai-retry"
              >
                Retry
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleAiDetect}
              disabled={text.trim().length < 50}
              className="h-7"
              data-testid="button-ai-detect"
            >
              <Bot className="w-4 h-4 mr-2" />
              Check AI (GPTZero)
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
