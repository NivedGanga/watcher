import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ApiProvider } from './lib/ApiContext';
import { AlertsProvider } from './lib/alerts';
import { SignIn } from './components/SignIn';
import { DashboardPage } from './pages/DashboardPage';
import { ApprovalPage } from './pages/ApprovalPage';
import { PlaceholderPage } from './pages/PlaceholderPage';

function Root() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <main className="center">
        <p>Loading…</p>
      </main>
    );
  }
  return user ? <DashboardPage /> : <SignIn />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ApiProvider>
          <AlertsProvider>
            <Routes>
              <Route path="/" element={<Root />} />
              <Route path="/device" element={<ApprovalPage />} />
              <Route path="/connect" element={<ApprovalPage />} />
              <Route path="/privacy" element={<PlaceholderPage title="Privacy" />} />
              <Route path="/terms" element={<PlaceholderPage title="Terms" />} />
            </Routes>
          </AlertsProvider>
        </ApiProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
