import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { player } from './engine/player.ts';
import { useStore } from './store.ts';

// Handy when poking at the app from the browser console.
(window as unknown as Record<string, unknown>).studio = { player, store: useStore };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
