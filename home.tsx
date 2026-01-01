import React, { useState } from 'react';
import { coherenceService } from './CoherenceService'; // Import the service

const Home = () => {
  const [prompt, setPrompt] = useState('');
  const [inputText, setInputText] = useState('');
  const [outline, setOutline] = useState('');
  const [document, setDocument] = useState('');
  const [loading, setLoading] = useState(false);

  const generateStrictOutline = async () => {
    setLoading(true);
    try {
      // Stream from coherenceService
      const generator = coherenceService.processLargeDocument(1, 'outline', prompt, inputText);
      let fullOutput = '';
      for await (const event of generator) {
        if (event.type === 'complete') {
          fullOutput = event.data.output;
          setOutline(fullOutput);
        }
      }
    } catch (error) {
      console.error(error);
    }
    setLoading(false);
  };

  const generateFullDocument = async () => {
    setLoading(true);
    try {
      const generator = coherenceService.processLargeDocument(1, 'document', prompt, inputText);
      let fullOutput = '';
      for await (const event of generator) {
        if (event.type === 'complete') {
          fullOutput = event.data.output;
          setDocument(fullOutput);
        }
      }
    } catch (error) {
      console.error(error);
    }
    setLoading(false);
  };

  return (
    <div>
      <div>
        <h2>Test Strict Outline Generator</h2>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Paste your user prompt / task here..."
        />
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Optional: paste, drag & drop, or upload source text..."
        />
        <button onClick={generateStrictOutline} disabled={loading}>
          Generate Strict Outline
        </button>
        <div>{outline}</div>
      </div>

      <div>
        <h2>Full Document Generator</h2>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="User Prompt / Task (drag & drop text file here)"
        />
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Input Text (for rewrites, summaries, etc. — optional)"
        />
        <button onClick={generateFullDocument} disabled={loading}>
          Generate Full Document
        </button>
        <div>{document}</div>
      </div>
    </div>
  );
};

export default Home;