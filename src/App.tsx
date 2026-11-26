import { useState } from 'react';
import { AuthProvider } from './context/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MarketTicker } from './components/MarketTicker';
import { CatchReversalsPage } from './pages/CatchReversalsPage';
import { BrokerConnectPage } from './pages/BrokerConnectPage';
import type { AppPage } from './components/TopNav';

function StandaloneApp() {
  const [activePage, setActivePage] = useState<AppPage>('catch-reversals');
  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <button type="button" onClick={() => setActivePage('catch-reversals')} className="font-display text-lg font-extrabold tracking-tight text-slate-950">
            Catch Reversals Scanner
          </button>
          <nav className="flex items-center gap-2" aria-label="Main navigation">
            <button type="button" onClick={() => setActivePage('catch-reversals')} aria-current={activePage === 'catch-reversals' ? 'page' : undefined} className={`rounded-lg px-3 py-2 text-sm font-semibold ${activePage === 'catch-reversals' ? 'bg-emerald-50 text-emerald-800' : 'text-slate-600 hover:bg-slate-100'}`}>
              Scanner
            </button>
            <button type="button" onClick={() => setActivePage('broker')} aria-current={activePage === 'broker' ? 'page' : undefined} className={`rounded-lg px-3 py-2 text-sm font-semibold ${activePage === 'broker' ? 'bg-emerald-50 text-emerald-800' : 'text-slate-600 hover:bg-slate-100'}`}>
              Broker Connect
            </button>
          </nav>
        </div>
      </header>
      <MarketTicker />
      <main className="flex-1">
        {activePage === 'catch-reversals'
          ? <CatchReversalsPage onNavigate={setActivePage} />
          : <BrokerConnectPage onNavigate={setActivePage} />}
      </main>
      <footer className="mt-auto border-t border-slate-200 bg-white px-4 py-5 text-center text-xs text-slate-500">
        Catch Reversals Scanner · Nubra Finance integration · Technical screening only, not investment advice
      </footer>
    </div>
  );
}

export default function App() {
  return <ErrorBoundary><AuthProvider><StandaloneApp /></AuthProvider></ErrorBoundary>;
}
