import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './monaco.ts';
import './styles.css';
import './hosted.css';
import { App } from './App.tsx';
import { HostedApp } from './HostedApp.tsx';

const hostedApi = import.meta.env.VITE_BRANCHLIGHT_API_URL;
createRoot(document.getElementById('root')!).render(
  hostedApi ? <HostedApp apiUrl={hostedApi} /> : <App />,
);
