import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { registerPushServiceWorker, pushSupport } from './lib/push';

if (pushSupport() === 'ok') {
  registerPushServiceWorker().catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
