import { coherenceService } from './src/CoherenceService'; // adjust if in different folder
(async () => {
  try {
    const gen = coherenceService.processLargeDocument(1, 'test', 'Create a short test outline', 'This is a test input text for coherence.');
    for await (const event of gen) {
      if (event.type === 'complete') {
        console.log('SUCCESS: Output generated');
        console.log(event.data.output.substring(0, 500));
      }
    }
  } catch (e) {
    console.error('FAIL:', e);
  }
})();
