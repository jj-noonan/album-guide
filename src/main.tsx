import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted so the app has no CDN dependency and works offline.
//
// Jost, and not casually. Its `a` is single-storey — a circle with a stem —
// and the logo's `a` is a drawn tape reel that replaces that glyph. Outfit,
// which this used before, has a double-storey `a`, so the reel sat in the word
// looking like something dropped in from another alphabet. 600 and 700 are
// carried because the interface uses them; the brand itself is 400 and 500.
import '@fontsource/jost/400.css';
import '@fontsource/jost/500.css';
import '@fontsource/jost/600.css';
import '@fontsource/jost/700.css';
// Tokens first: the component styles below resolve --ag-* from here.
import './brand-tokens.css';
import './index.css';
import App from './App.tsx';
import { ToastHost } from './components/Toast';
import { pendingMbids } from './engine/ingest';

// The ingest queue lives in localStorage; this is how it gets to the crawler:
//   copy(segueQueue().join('\n'))   then   pbpaste | python3 scripts/ingest_mbids.py
(window as unknown as { segueQueue: () => string[] }).segueQueue = pendingMbids;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost>
      <App />
    </ToastHost>
  </StrictMode>,
);
