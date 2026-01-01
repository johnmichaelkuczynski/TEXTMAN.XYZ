import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Progress } from '@/components/ui/progress';
import { 
  Play, Pause, RefreshCw, Copy, ChevronDown, ChevronUp,
  CheckCircle, AlertCircle, Clock, Loader2, FileText, Shield, MessageSquare, Target
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface PipelineStage {
  number: number;
  name: string;
  icon: typeof FileText;
  description: string;
}

const PIPELINE_STAGES: PipelineStage[] = [
  { number: 1, name: 'Reconstruction', icon: FileText, description: 'Conservative charitable interpretation' },
  { number: 2, name: 'Objections', icon: Target, description: 'Generate 25 objections with initial responses' },
  { number: 3, name: 'Enhanced Responses', icon: MessageSquare, description: 'Deepen and strengthen each response' },
  { number: 4, name: 'Bullet-proof Version', icon: Shield, description: 'Integrate all responses into final text' },
];

interface PipelineJob {
  id: number;
  status: string;
  currentStage: number;
  stageStatus: string;
  wordCounts: {
    original: number;
    reconstruction: number | null;
    objections: number | null;
    responses: number | null;
    bulletproof: number | null;
  };
  timing: {
    stage1Start: string | null;
    stage1End: string | null;
    stage2Start: string | null;
    stage2End: string | null;
    stage3Start: string | null;
    stage3End: string | null;
    stage4Start: string | null;
    stage4End: string | null;
    hcCheck: string | null;
  };
  hcResults: any;
  hcViolations: any;
  errorMessage: string | null;
}

interface ObjectionSummary {
  index: number;
  type: string;
  severity: string;
  claimTargeted: string;
  hasResponse: boolean;
  hasEnhancedResponse: boolean;
  integrated: boolean;
}

interface PipelineUIProps {
  onClose?: () => void;
}

export function PipelineUI({ onClose }: PipelineUIProps) {
  const { toast } = useToast();
  const [inputText, setInputText] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<number | null>(null);
  const [jobData, setJobData] = useState<PipelineJob | null>(null);
  const [objections, setObjections] = useState<ObjectionSummary[]>([]);
  const [outputs, setOutputs] = useState<{
    reconstruction: string | null;
    objections: string | null;
    responses: string | null;
    bulletproof: string | null;
  }>({ reconstruction: null, objections: null, responses: null, bulletproof: null });
  const [expandedSections, setExpandedSections] = useState<{ [key: string]: boolean }>({});
  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);

  const countWords = (text: string) => text.trim().split(/\s+/).filter(w => w).length;

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Copied', description: `${label} copied to clipboard` });
    } catch (e) {
      toast({ title: 'Copy failed', description: 'Could not copy to clipboard', variant: 'destructive' });
    }
  };

  const pollJobStatus = useCallback(async (jobId: number) => {
    try {
      const response = await fetch(`/api/pipeline/status/${jobId}`);
      const data = await response.json();
      
      if (data.success) {
        setJobData(data.job);
        setObjections(data.objections || []);
        
        if (data.job.status === 'complete' || data.job.status === 'completed_with_warnings' || data.job.status === 'failed') {
          setIsRunning(false);
          if (pollInterval) {
            clearInterval(pollInterval);
            setPollInterval(null);
          }
          
          const outputsResponse = await fetch(`/api/pipeline/outputs/${jobId}`);
          const outputsData = await outputsResponse.json();
          
          if (outputsData.success) {
            setOutputs({
              reconstruction: outputsData.reconstruction,
              objections: outputsData.objections,
              responses: outputsData.responses,
              bulletproof: outputsData.bulletproof,
            });
          }
          
          if (data.job.status === 'complete') {
            toast({ title: 'Pipeline Complete', description: 'All 4 stages finished successfully' });
          } else if (data.job.status === 'completed_with_warnings') {
            toast({ title: 'Pipeline Complete', description: 'Finished with some HC warnings', variant: 'default' });
          } else {
            toast({ title: 'Pipeline Failed', description: data.job.errorMessage || 'An error occurred', variant: 'destructive' });
          }
        }
      }
    } catch (error: any) {
      console.error('Poll error:', error);
    }
  }, [pollInterval, toast]);

  const startPipeline = async () => {
    if (!inputText.trim()) {
      toast({ title: 'Error', description: 'Please enter text to process', variant: 'destructive' });
      return;
    }
    
    const wordCount = countWords(inputText);
    if (wordCount < 100) {
      toast({ title: 'Error', description: 'Text must be at least 100 words', variant: 'destructive' });
      return;
    }
    
    setIsRunning(true);
    setJobData(null);
    setObjections([]);
    setOutputs({ reconstruction: null, objections: null, responses: null, bulletproof: null });
    
    try {
      const createResponse = await fetch('/api/pipeline/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          text: inputText,
          customInstructions: customInstructions || undefined
        })
      });
      
      const createData = await createResponse.json();
      
      if (!createData.success) {
        throw new Error(createData.message);
      }
      
      setCurrentJobId(createData.jobId);
      
      const runResponse = await fetch(`/api/pipeline/run/${createData.jobId}`, {
        method: 'POST'
      });
      
      const runData = await runResponse.json();
      
      if (!runData.success) {
        throw new Error(runData.message);
      }
      
      const interval = setInterval(() => pollJobStatus(createData.jobId), 3000);
      setPollInterval(interval);
      
      toast({ title: 'Pipeline Started', description: `Job ${createData.jobId} is now running` });
      
    } catch (error: any) {
      setIsRunning(false);
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  useEffect(() => {
    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [pollInterval]);

  const getStageStatus = (stageNum: number): 'pending' | 'running' | 'complete' | 'error' => {
    if (!jobData) return 'pending';
    
    if (jobData.status === 'failed' && jobData.currentStage === stageNum) {
      return 'error';
    }
    
    if (stageNum < (jobData.currentStage || 1)) {
      return 'complete';
    }
    
    if (stageNum === jobData.currentStage && jobData.stageStatus === 'running') {
      return 'running';
    }
    
    return 'pending';
  };

  const getStageWordCount = (stageNum: number): number | null => {
    if (!jobData) return null;
    switch (stageNum) {
      case 1: return jobData.wordCounts.reconstruction;
      case 2: return jobData.wordCounts.objections;
      case 3: return jobData.wordCounts.responses;
      case 4: return jobData.wordCounts.bulletproof;
      default: return null;
    }
  };

  const getStageDuration = (stageNum: number): string | null => {
    if (!jobData) return null;
    
    let start: string | null = null;
    let end: string | null = null;
    
    switch (stageNum) {
      case 1: start = jobData.timing.stage1Start; end = jobData.timing.stage1End; break;
      case 2: start = jobData.timing.stage2Start; end = jobData.timing.stage2End; break;
      case 3: start = jobData.timing.stage3Start; end = jobData.timing.stage3End; break;
      case 4: start = jobData.timing.stage4Start; end = jobData.timing.stage4End; break;
    }
    
    if (!start) return null;
    
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date();
    const durationMs = endDate.getTime() - startDate.getTime();
    const durationSec = Math.round(durationMs / 1000);
    
    if (durationSec < 60) return `${durationSec}s`;
    return `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
  };

  const overallProgress = !jobData ? 0 : (
    (jobData.status === 'complete' || jobData.status === 'completed_with_warnings') ? 100 :
    ((jobData.currentStage || 1) - 1) * 25 + 
    (jobData.stageStatus === 'running' ? 12 : 0)
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Shield className="w-5 h-5" />
            Full Pipeline Cross-Chunk Coherence (FPCC)
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            4-Stage Pipeline: Reconstruction, Objections, Enhanced Responses, Bullet-proof Version
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Textarea
              data-testid="input-pipeline-text"
              placeholder="Paste your text here (minimum 100 words)..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              className="min-h-[120px] resize-y"
              disabled={isRunning}
            />
            <div className="flex justify-between items-center text-sm text-muted-foreground">
              <span>{countWords(inputText).toLocaleString()} words</span>
              {inputText.length > 0 && countWords(inputText) < 100 && (
                <span className="text-destructive">Minimum 100 words required</span>
              )}
            </div>
          </div>
          
          <Collapsible open={expandedSections['instructions']}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleSection('instructions')}
                className="w-full justify-between"
                data-testid="button-toggle-instructions"
              >
                <span>Custom Instructions (Optional)</span>
                {expandedSections['instructions'] ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <Textarea
                data-testid="input-custom-instructions"
                placeholder="Add any special instructions for processing..."
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                className="min-h-[60px]"
                disabled={isRunning}
              />
            </CollapsibleContent>
          </Collapsible>
          
          <Button
            data-testid="button-start-pipeline"
            onClick={startPipeline}
            disabled={isRunning || countWords(inputText) < 100}
            className="w-full"
          >
            {isRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Processing Stage {jobData?.currentStage || 1} of 4...
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Run Full Pipeline
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {(isRunning || jobData) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Pipeline Progress
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={overallProgress} className="h-2" />
            
            <div className="grid grid-cols-4 gap-2">
              {PIPELINE_STAGES.map((stage) => {
                const status = getStageStatus(stage.number);
                const wordCount = getStageWordCount(stage.number);
                const duration = getStageDuration(stage.number);
                
                return (
                  <div
                    key={stage.number}
                    className={`p-3 rounded-md border text-center transition-colors ${
                      status === 'complete' ? 'bg-green-500/10 border-green-500/30' :
                      status === 'running' ? 'bg-blue-500/10 border-blue-500/30' :
                      status === 'error' ? 'bg-red-500/10 border-red-500/30' :
                      'bg-muted/50 border-border'
                    }`}
                    data-testid={`stage-${stage.number}`}
                  >
                    <div className="flex items-center justify-center mb-1">
                      {status === 'complete' ? (
                        <CheckCircle className="w-5 h-5 text-green-500" />
                      ) : status === 'running' ? (
                        <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                      ) : status === 'error' ? (
                        <AlertCircle className="w-5 h-5 text-red-500" />
                      ) : (
                        <stage.icon className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="text-xs font-medium">{stage.name}</div>
                    {wordCount && (
                      <div className="text-xs text-muted-foreground mt-1">{wordCount.toLocaleString()} words</div>
                    )}
                    {duration && (
                      <div className="text-xs text-muted-foreground">{duration}</div>
                    )}
                  </div>
                );
              })}
            </div>

            {jobData?.status === 'complete' || jobData?.status === 'completed_with_warnings' ? (
              <div className="flex items-center gap-2 p-2 rounded-md bg-green-500/10 border border-green-500/30">
                <CheckCircle className="w-4 h-4 text-green-500" />
                <span className="text-sm">
                  Pipeline complete
                  {jobData.status === 'completed_with_warnings' && ' (with HC warnings)'}
                </span>
              </div>
            ) : jobData?.status === 'failed' ? (
              <div className="flex items-center gap-2 p-2 rounded-md bg-red-500/10 border border-red-500/30">
                <AlertCircle className="w-4 h-4 text-red-500" />
                <span className="text-sm">{jobData.errorMessage || 'Pipeline failed'}</span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      {objections.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Objections Summary ({objections.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-5 gap-1">
              {objections.map((obj) => (
                <div
                  key={obj.index}
                  className={`p-2 rounded text-center text-xs border ${
                    obj.integrated ? 'bg-green-500/10 border-green-500/30' :
                    obj.hasEnhancedResponse ? 'bg-blue-500/10 border-blue-500/30' :
                    obj.hasResponse ? 'bg-yellow-500/10 border-yellow-500/30' :
                    'bg-muted/50 border-border'
                  }`}
                  title={`${obj.type} - ${obj.severity}: ${obj.claimTargeted?.substring(0, 100)}...`}
                  data-testid={`objection-${obj.index}`}
                >
                  <div className="font-medium">{obj.index}</div>
                  <Badge variant="outline" className="text-[10px] mt-1">
                    {obj.severity?.substring(0, 3).toUpperCase()}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="flex gap-4 mt-3 text-xs text-muted-foreground justify-center">
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded bg-muted border" /> Pending
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded bg-yellow-500/10 border-yellow-500/30 border" /> Initial Response
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded bg-blue-500/10 border-blue-500/30 border" /> Enhanced
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded bg-green-500/10 border-green-500/30 border" /> Integrated
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {(outputs.reconstruction || outputs.objections || outputs.responses || outputs.bulletproof) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Outputs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {outputs.reconstruction && (
              <Collapsible open={expandedSections['reconstruction']}>
                <CollapsibleTrigger asChild>
                  <div 
                    className="flex items-center justify-between p-3 rounded-md bg-muted/50 cursor-pointer hover-elevate"
                    onClick={() => toggleSection('reconstruction')}
                    data-testid="output-reconstruction-header"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      <span className="font-medium">Stage 1: Reconstruction</span>
                      <Badge variant="secondary">{countWords(outputs.reconstruction).toLocaleString()} words</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); copyToClipboard(outputs.reconstruction!, 'Reconstruction'); }}
                        data-testid="button-copy-reconstruction"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      {expandedSections['reconstruction'] ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 p-3 rounded-md bg-muted/30 max-h-[300px] overflow-auto text-sm whitespace-pre-wrap">
                    {outputs.reconstruction}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            {outputs.objections && (
              <Collapsible open={expandedSections['objections']}>
                <CollapsibleTrigger asChild>
                  <div 
                    className="flex items-center justify-between p-3 rounded-md bg-muted/50 cursor-pointer hover-elevate"
                    onClick={() => toggleSection('objections')}
                    data-testid="output-objections-header"
                  >
                    <div className="flex items-center gap-2">
                      <Target className="w-4 h-4" />
                      <span className="font-medium">Stage 2: Objections</span>
                      <Badge variant="secondary">{countWords(outputs.objections).toLocaleString()} words</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); copyToClipboard(outputs.objections!, 'Objections'); }}
                        data-testid="button-copy-objections"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      {expandedSections['objections'] ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 p-3 rounded-md bg-muted/30 max-h-[300px] overflow-auto text-sm whitespace-pre-wrap">
                    {outputs.objections}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            {outputs.responses && (
              <Collapsible open={expandedSections['responses']}>
                <CollapsibleTrigger asChild>
                  <div 
                    className="flex items-center justify-between p-3 rounded-md bg-muted/50 cursor-pointer hover-elevate"
                    onClick={() => toggleSection('responses')}
                    data-testid="output-responses-header"
                  >
                    <div className="flex items-center gap-2">
                      <MessageSquare className="w-4 h-4" />
                      <span className="font-medium">Stage 3: Enhanced Responses</span>
                      <Badge variant="secondary">{countWords(outputs.responses).toLocaleString()} words</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); copyToClipboard(outputs.responses!, 'Enhanced Responses'); }}
                        data-testid="button-copy-responses"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      {expandedSections['responses'] ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 p-3 rounded-md bg-muted/30 max-h-[300px] overflow-auto text-sm whitespace-pre-wrap">
                    {outputs.responses}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            {outputs.bulletproof && (
              <Collapsible open={expandedSections['bulletproof']}>
                <CollapsibleTrigger asChild>
                  <div 
                    className="flex items-center justify-between p-3 rounded-md bg-green-500/10 border border-green-500/30 cursor-pointer hover-elevate"
                    onClick={() => toggleSection('bulletproof')}
                    data-testid="output-bulletproof-header"
                  >
                    <div className="flex items-center gap-2">
                      <Shield className="w-4 h-4 text-green-600" />
                      <span className="font-medium">Stage 4: Bullet-proof Version</span>
                      <Badge variant="secondary">{countWords(outputs.bulletproof).toLocaleString()} words</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); copyToClipboard(outputs.bulletproof!, 'Bullet-proof Version'); }}
                        data-testid="button-copy-bulletproof"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      {expandedSections['bulletproof'] ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 p-3 rounded-md bg-muted/30 max-h-[400px] overflow-auto text-sm whitespace-pre-wrap">
                    {outputs.bulletproof}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </CardContent>
        </Card>
      )}

      {jobData?.hcViolations && Array.isArray(jobData.hcViolations) && jobData.hcViolations.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-yellow-500" />
              Horizontal Coherence Warnings ({jobData.hcViolations.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[200px] overflow-auto">
              {(jobData.hcViolations as any[]).map((violation: any, i: number) => (
                <div 
                  key={i}
                  className={`p-2 rounded text-sm ${
                    violation.severity === 'error' ? 'bg-red-500/10 border border-red-500/30' :
                    'bg-yellow-500/10 border border-yellow-500/30'
                  }`}
                  data-testid={`hc-violation-${i}`}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={violation.severity === 'error' ? 'destructive' : 'outline'}>
                      {violation.type}
                    </Badge>
                    <span className="text-muted-foreground">{violation.description}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
