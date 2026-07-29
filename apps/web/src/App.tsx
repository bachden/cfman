import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Globe2 } from "lucide-react";
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "./api";
import { AppShell } from "./components/AppShell";
import { DrawerProvider } from "./components/DrawerProvider";
import { AccountsPage } from "./pages/AccountsPage";
import { AuditPage } from "./pages/AuditPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TunnelsPage } from "./pages/TunnelsPage";
import type { AppSettings, User } from "./types";

const ScriptsPage = lazy(() => import("./pages/ScriptsPage").then((module) => ({ default: module.ScriptsPage })));

function PublicBaseUrlBanner() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ settings: AppSettings }>("/api/settings")
  });
  const currentOrigin = window.location.origin;
  const hostname = window.location.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
  const update = useMutation({
    mutationFn: () => api.put<{ settings: AppSettings }>("/api/settings", { publicBaseUrl: currentOrigin }),
    onSuccess: (result) => {
      queryClient.setQueryData(["settings"], result);
      void queryClient.invalidateQueries();
      toast.success("Public base URL updated");
    },
    onError: () => toast.error("Unable to update public base URL")
  });
  if (isLoopback || !data || (data.settings.configured && data.settings.publicBaseUrl === currentOrigin)) return null;
  return <div className="public-base-url-banner" role="status"><Globe2 size={16} /><span>{data.settings.configured ? "Current host differs from the configured public base URL." : "Public base URL has not been configured."}</span><code>{currentOrigin}</code><button type="button" disabled={update.isPending} onClick={() => update.mutate()}><Check size={14} />{update.isPending ? "Updating..." : "Use current host"}</button></div>;
}

export default function App() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<{ user: User }>("/api/auth/me"),
    retry: false
  });
  if (isLoading) return <div className="app-loading"><div className="brand-spinner" /><span>cfman</span></div>;
  if (isError || !data) return <LoginPage onLogin={(user) => queryClient.setQueryData(["auth", "me"], { user })} />;
  const updatePasswordState = () => queryClient.setQueryData<{ user: User }>(["auth", "me"], (current) => current ? { user: { ...current.user, mustChangePassword: false } } : current);
  return <AppShell username={data.user.username}><DrawerProvider><PublicBaseUrlBanner />{data.user.mustChangePassword && <button className="password-banner" onClick={() => navigate("/settings")}><AlertTriangle size={16} /><span>The default password is still active.</span><strong>Change password</strong></button>}<Suspense fallback={<div className="app-loading"><div className="brand-spinner" /><span>Loading script editor...</span></div>}><Routes><Route path="/" element={<DashboardPage />} /><Route path="/accounts" element={<AccountsPage />} /><Route path="/tunnels" element={<TunnelsPage />} /><Route path="/onboarding" element={<OnboardingPage />} /><Route path="/scripts" element={<ScriptsPage />} /><Route path="/audit" element={<AuditPage />} /><Route path="/settings" element={<SettingsPage user={data.user} onLogout={() => queryClient.removeQueries({ queryKey: ["auth", "me"] })} onPasswordChanged={updatePasswordState} />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></Suspense></DrawerProvider></AppShell>;
}
