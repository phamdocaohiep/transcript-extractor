import { createRoot } from 'react-dom/client';
import './index.css';
import { VideoDownload } from './components/VideoDownload';
import { applyTheme } from './lib/theme';
applyTheme();
createRoot(document.getElementById('root')!).render(<VideoDownload />);
