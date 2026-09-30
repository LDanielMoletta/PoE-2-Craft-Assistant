import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { OverlayHost } from './host.js';
import './ui/index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root nao encontrado no index.html');

createRoot(container).render(
  <StrictMode>
    <OverlayHost />
  </StrictMode>,
);
