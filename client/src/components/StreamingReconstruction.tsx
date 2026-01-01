import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Download, Square, Copy, Clock, FileText, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ProcessingProgress {
  sessionId: number;
  stage: 'skeleton' | 'chunking' | 'stitching' | 'repair' | 'complete' | 'aborted';
  currentChunk: number;
  totalChunks: number;
  chunkOutput?: string;
  elapsedMs: number;
  estimatedRemainingMs?: number;
}

interface StreamingReconstructionProps {
  inputText: string;
  customInstructions?: string;
  audienceParameters?: string;
  rigorLevel?: string;
  onComplete: (output: string) => void;
  onAbort?: () => void;
}

type StreamingStage = 'idle' | 'skeleton' | 'chunking' | 'stitching' | 'complete' | 'aborted' | 'error';

export function StreamingReconstruction({
  inputText,
  customInstructions,
  audienceParameters,
  rigorLevel,
  onComplete,
  onAbort
}: StreamingReconstructionProps) {
  const [stage, setStage] = useState<StreamingStage>('idle');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [chunkOutputs, setChunkOutputs] = useState<string[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [estimatedRemainingMs, setEstimatedRemainingMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const { toast } = useToast();
  
  const wordCount = inputText.trim().split(/\s+/).length;
  const progressPercent = totalChunks > 0 ? (currentChunk / totalChunks) * 100 : 0;
  const combinedOutput = chunkOutputs.join('\n\n');
  const outputWordCount = combinedOutput.trim().split(/\s+/).filter(w => w.length > 0).length;
  
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
  };
  
  const getStageLabel = (s: StreamingStage): string => {
    switch (s) {
      case 'idle': return 'Ready';
      case 'skeleton': return 'Extracting Document Structure';
      case 'chunking': return `Processing Chunk ${currentChunk}/${totalChunks}`;
      case 'stitching': return 'Validating Cross-Chunk Coherence';
      case 'complete': return 'Complete';
      case 'aborted': return 'Aborted';
      case 'error': return 'Error';
    }
  };
  
  const startStreaming = useCallback(async () => {
    setIsProcessing(true);
    setStage('skeleton');
    setError(null);
    setChunkOutputs([]);
    setCurrentChunk(0);
    setTotalChunks(0);
    setElapsedMs(0);
    setEstimatedRemainingMs(null);
    
    abortControllerRef.current = new AbortController();
    
    try {
      const response = await fetch('/api/reconstruction/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: inputText,
          customInstructions,
          audienceParameters,
          rigorLevel
        }),
        signal: abortControllerRef.current.signal
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Streaming failed');
      }
      
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      if (!reader) {
        throw new Error('No response body');
      }
      
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            const eventType = line.slice(7).trim();
            continue;
          }
          
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.stage) {
                setStage(data.stage as StreamingStage);
                setSessionId(data.sessionId);
                setCurrentChunk(data.currentChunk);
                setTotalChunks(data.totalChunks);
                setElapsedMs(data.elapsedMs || 0);
                if (data.estimatedRemainingMs) {
                  setEstimatedRemainingMs(data.estimatedRemainingMs);
                }
                
                if (data.chunkOutput) {
                  setChunkOutputs(prev => [...prev, data.chunkOutput]);
                }
              }
              
              if (data.success && data.output) {
                setStage('complete');
                onComplete(data.output);
                toast({
                  title: "Reconstruction Complete",
                  description: `Processed ${data.chunksProcessed} chunks. Output: ${data.wordCount} words.`
                });
              }
              
              if (data.partialOutput !== undefined) {
                setStage('aborted');
                onComplete(data.partialOutput || combinedOutput);
                toast({
                  title: "Processing Aborted",
                  description: `Partial output saved: ${data.chunksProcessed} chunks processed.`,
                  variant: "default"
                });
              }
              
              if (data.message && !data.success && !data.stage) {
                setError(data.message);
                setStage('error');
                toast({
                  title: "Processing Error",
                  description: data.message,
                  variant: "destructive"
                });
              }
              
            } catch (e) {
              console.log('[SSE] Parse error:', e);
            }
          }
        }
      }
      
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setStage('aborted');
      } else {
        setError(err.message);
        setStage('error');
        toast({
          title: "Streaming Error",
          description: err.message,
          variant: "destructive"
        });
      }
    } finally {
      setIsProcessing(false);
    }
  }, [inputText, customInstructions, audienceParameters, rigorLevel, onComplete, toast, combinedOutput]);
  
  const handleAbort = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    if (sessionId) {
      try {
        const response = await fetch(`/api/reconstruction/abort/${sessionId}`, {
          method: 'POST'
        });
        
        if (response.ok) {
          const data = await response.json();
          onComplete(data.partialOutput || combinedOutput);
          toast({
            title: "Session Aborted",
            description: `Partial output saved: ${data.wordCount} words.`
          });
        }
      } catch (e) {
        console.error('[Abort] Error:', e);
      }
    }
    
    setStage('aborted');
    setIsProcessing(false);
    onAbort?.();
  }, [sessionId, combinedOutput, onComplete, onAbort, toast]);
  
  const handleCopyOutput = () => {
    navigator.clipboard.writeText(combinedOutput);
    toast({ title: "Copied to clipboard" });
  };
  
  const handleDownloadOutput = () => {
    const blob = new Blob([combinedOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconstruction_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  
  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Streaming Reconstruction
        </CardTitle>
        
        <div className="flex items-center gap-2">
          <Badge variant="outline">{wordCount.toLocaleString()} words input</Badge>
          {stage !== 'idle' && (
            <Badge 
              variant={stage === 'complete' ? 'default' : stage === 'error' ? 'destructive' : 'secondary'}
              className="capitalize"
            >
              {stage === 'chunking' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              {stage === 'complete' && <CheckCircle className="w-3 h-3 mr-1" />}
              {stage === 'error' && <AlertCircle className="w-3 h-3 mr-1" />}
              {getStageLabel(stage)}
            </Badge>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {stage === 'idle' && (
          <div className="text-center py-6">
            <p className="text-muted-foreground mb-4">
              This document is {wordCount.toLocaleString()} words and will be processed with streaming cross-chunk coherence.
            </p>
            <Button 
              data-testid="button-start-streaming"
              onClick={startStreaming}
              size="lg"
            >
              Start Streaming Reconstruction
            </Button>
          </div>
        )}
        
        {isProcessing && (
          <div className="space-y-3">
            <Progress value={progressPercent} className="h-2" />
            
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span>Elapsed: {formatTime(elapsedMs)}</span>
              </div>
              
              {estimatedRemainingMs && (
                <span>Est. remaining: {formatTime(estimatedRemainingMs)}</span>
              )}
            </div>
            
            <div className="flex gap-2">
              <Button
                data-testid="button-abort-streaming"
                variant="destructive"
                size="sm"
                onClick={handleAbort}
              >
                <Square className="w-4 h-4 mr-1" />
                Abort
              </Button>
            </div>
          </div>
        )}
        
        {chunkOutputs.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                Progressive Preview ({outputWordCount.toLocaleString()} words)
              </span>
              
              <div className="flex gap-2">
                <Button
                  data-testid="button-copy-partial"
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyOutput}
                >
                  <Copy className="w-4 h-4 mr-1" />
                  Copy
                </Button>
                
                <Button
                  data-testid="button-download-partial"
                  variant="ghost"
                  size="sm"
                  onClick={handleDownloadOutput}
                >
                  <Download className="w-4 h-4 mr-1" />
                  Download
                </Button>
              </div>
            </div>
            
            <ScrollArea className="h-[300px] border rounded-md">
              <Textarea
                data-testid="textarea-streaming-preview"
                value={combinedOutput}
                readOnly
                className="min-h-[280px] border-0 resize-none focus-visible:ring-0"
              />
            </ScrollArea>
          </div>
        )}
        
        {error && (
          <div className="p-4 border border-destructive rounded-md bg-destructive/10">
            <p className="text-destructive font-medium">Error: {error}</p>
          </div>
        )}
        
        {stage === 'complete' && (
          <div className="p-4 border border-green-500 rounded-md bg-green-500/10">
            <p className="text-green-700 dark:text-green-400 font-medium flex items-center gap-2">
              <CheckCircle className="w-5 h-5" />
              Reconstruction complete! Output: {outputWordCount.toLocaleString()} words
            </p>
          </div>
        )}
        
        {stage === 'aborted' && (
          <div className="p-4 border border-yellow-500 rounded-md bg-yellow-500/10">
            <p className="text-yellow-700 dark:text-yellow-400 font-medium">
              Processing was aborted. Partial output ({outputWordCount.toLocaleString()} words) has been saved.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
