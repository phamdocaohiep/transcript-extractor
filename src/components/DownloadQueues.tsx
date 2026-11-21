import { useCallback, useEffect, useState } from 'react';
import { VideoDownload, type QueueState } from './VideoDownload';

interface Entry {
  id: number;
  title: string;
  closed?: boolean;
}

function supports(url?: string) {
  if (!url) return false;
  try {
    const address = new URL(url);
    return (
      address.protocol === 'https:' &&
      /(^|\.)(youtube\.com|udemy\.com|coursera\.org)$/.test(address.hostname)
    );
  } catch {
    return false;
  }
}

// Workers stay mounted when selection changes. Each owns its source tab,
// cancellation controller, permission pause and existing per-tab download lock.
export function DownloadQueues({
  screen,
  onBusyChange,
  visible = true,
}: {
  screen: 'main' | 'settings';
  onBusyChange: (busy: boolean) => void;
  visible?: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<number>();
  const [states, setStates] = useState<Record<number, QueueState>>({});
  const [message, setMessage] = useState('');
  const busy = Object.values(states).some(state => state.busy);

  const receive = useCallback((id: number, state: QueueState) => {
    setStates(previous => {
      const old = previous[id];
      if (
        old &&
        Object.keys(state).every(
          key => old[key as keyof QueueState] === state[key as keyof QueueState]
        )
      )
        return previous;
      return { ...previous, [id]: state };
    });
  }, []);

  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const update = (follow = true) => {
      const current = ++revision;
      void chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) => {
          if (disposed || current !== revision || tab?.id === undefined || !supports(tab.url))
            return;
          const id = tab.id;
          setEntries(previous =>
            previous.some(entry => entry.id === id)
              ? previous
              : [...previous, { id, title: tab.title || 'Untitled tab' }]
          );
          setSelected(previous => (follow ? id : (previous ?? id)));
        })
        .catch(() => {
          if (!disposed) setMessage('Could not read the active tab. Reopen the panel to retry.');
        });
    };
    const changed = (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (info.title)
        setEntries(previous =>
          previous.map(entry => (entry.id === id ? { ...entry, title: info.title! } : entry))
        );
      if (tab.active && info.status === 'complete') update(false);
    };
    const removed = (id: number) => {
      revision++;
      setEntries(previous =>
        previous.map(entry => (entry.id === id ? { ...entry, closed: true } : entry))
      );
      setStates(previous => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    };
    const activated = () => update();
    update();
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(changed);
    chrome.tabs.onRemoved.addListener(removed);
    return () => {
      disposed = true;
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(changed);
      chrome.tabs.onRemoved.removeListener(removed);
    };
  }, []);

  async function addOpenTabs() {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const next = tabs
        .filter(tab => tab.id !== undefined && supports(tab.url))
        .map(tab => ({ id: tab.id!, title: tab.title || 'Untitled tab' }));
      setEntries(previous => [
        ...previous,
        ...next.filter(tab => !previous.some(entry => entry.id === tab.id)),
      ]);
      setSelected(previous => previous ?? next[0]?.id);
      setMessage(next.length ? '' : 'Open a YouTube or Udemy page to add a queue.');
    } catch {
      setMessage('Could not read open tabs. Try again.');
    }
  }

  return (
    <>
      <section className="te-glass p-5 flex flex-col gap-3" aria-label="Download queues">
        <h2 className="font-semibold">Download queues</h2>
        <p className="te-muted text-sm">
          Each tab has its own queue. Downloads continue when you switch tabs. Keep this panel and
          source tabs open.
        </p>
        <button className="te-btn" onClick={() => void addOpenTabs()}>
          Add open tabs
        </button>
        {message && <p role="status">{message}</p>}
        {!entries.length && <p>Open a YouTube or Udemy page to start downloading.</p>}
        <ul className="flex flex-col gap-2">
          {entries.map((entry, index) => {
            const state = states[entry.id];
            const status = entry.closed
              ? 'Tab closed — stopped'
              : state?.needsAccess
                ? 'Waiting for permission'
                : state?.busy
                  ? 'Working'
                  : state?.error
                    ? 'Needs attention'
                    : 'Ready';
            return (
              <li key={entry.id}>
                <button
                  className="te-btn w-full text-left"
                  aria-current={selected === entry.id ? 'true' : undefined}
                  onClick={() => setSelected(entry.id)}
                >
                  <span className="block break-words">{state?.title || entry.title}</span>
                  <span className="block te-muted text-sm">
                    Queue {index + 1} · {status}
                    {state?.total ? ` · ${state.saved}/${state.total} saved` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {entries.map(entry => (
        <div key={entry.id} hidden={selected !== entry.id}>
          {entry.closed ? (
            <p role="status">
              The source tab was closed. Its download stopped. Reopen the source page to resume
              saved progress.
            </p>
          ) : (
            <VideoDownload
              sourceTabId={entry.id}
              screen={screen}
              active={visible && selected === entry.id}
              settingsLocked={busy}
              onStateChange={receive}
            />
          )}
        </div>
      ))}
    </>
  );
}
