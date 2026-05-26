import { BookOpen, Brain, Database, Home, ListChecks, PlayCircle, Settings } from 'lucide-preact';
import { navigate, type WorkbenchRoute } from '../state/store.js';

interface Props {
  route: WorkbenchRoute;
}

const ITEMS = [
  { view: 'start', label: 'Start', icon: Home },
  { view: 'sessions', label: 'Sessions', icon: PlayCircle },
  { view: 'review', label: 'Review', icon: ListChecks },
  { view: 'knowledge', label: 'Knowledge', icon: Database },
  { view: 'playbooks', label: 'Playbooks', icon: BookOpen },
  { view: 'system', label: 'System', icon: Settings },
] as const;

export function TopNav({ route }: Props) {
  return (
    <header class="workbench-topbar">
      <div class="brand-lockup">
        <Brain size={20} aria-hidden="true" />
        <div>
          <strong>Tuberosa</strong>
          <span>Context broker workbench</span>
        </div>
      </div>
      <nav class="primary-nav" aria-label="Workbench navigation">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.view}
              class={route.view === item.view ? 'active' : ''}
              onClick={() => navigate(item.view)}
              data-testid={`nav-${item.view}`}
            >
              <Icon size={16} aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
