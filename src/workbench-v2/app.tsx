import { render } from 'preact';
import { ProgressRail } from './shell/ProgressRail.js';
import { AutoTour } from './shell/AutoTour.js';
import { DemoToggle } from './shell/DemoToggle.js';
import { Toasts } from './shell/Toasts.js';
import Ch01 from './chapters/Ch01_Hello.js';
import Ch02 from './chapters/Ch02_Problem.js';
import Ch03 from './chapters/Ch03_Anatomy.js';
import Ch04 from './chapters/Ch04_Pipeline.js';
import Ch05 from './chapters/Ch05_KnowledgeGraph.js';
import Ch06 from './chapters/Ch06_Reflections.js';
import Ch07 from './chapters/Ch07_TryIt.js';
import Ch08 from './chapters/Ch08_PlugIn.js';
import Ch09 from './chapters/Ch09_YourSessions.js';
import Ch10 from './chapters/Ch10_TuneOps.js';
import './styles/main.css';

function App() {
  return (
    <div class="workbench-shell">
      <ProgressRail />
      <main>
        <div style="position:fixed;top:12px;left:80px;z-index:39">
          <DemoToggle />
        </div>
        <AutoTour />
        <Ch01 />
        <Ch02 />
        <Ch03 />
        <Ch04 />
        <Ch05 />
        <Ch06 />
        <Ch07 />
        <Ch08 />
        <Ch09 />
        <Ch10 />
      </main>
      <Toasts />
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
