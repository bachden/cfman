import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Cable as TunnelIcon, Check, Network } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../api";
import { ConnectivityEditor, connectivityPayload, createCommandAgentDraftPublication, validatePublications, type DraftPublication } from "../components/ConnectivityEditor";
import { FieldHelp } from "../components/FieldHelp";
import { PageHeader } from "../components/PageHeader";
import { EnrollmentCommands } from "../components/TunnelDrawer";
import { SearchableSelect } from "../components/SearchableSelect";
import type { CloudflareAccount, EnrollmentResult, Tunnel } from "../types";

export function OnboardingPage() {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ tunnel: Tunnel; enrollment: EnrollmentResult } | null>(null);
  const [error, setError] = useState("");
  const [tunnelCode, setTunnelCode] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [publications, setPublications] = useState<DraftPublication[]>([createCommandAgentDraftPublication()]);
  const { data: accountData } = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<{ accounts: CloudflareAccount[] }>("/api/accounts") });
  const mutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const created = await api.post<{ tunnel: Tunnel }>("/api/tunnels", body);
      const enrollment = await api.post<EnrollmentResult>(`/api/tunnels/${created.tunnel.id}/enrollments`, { expiresInHours: 24 });
      return { tunnel: created.tunnel, enrollment };
    },
    onSuccess: async (data) => { setResult(data); await queryClient.invalidateQueries(); toast.success("Tunnel ready for installation"); },
    onError: (requestError) => setError(requestError instanceof ApiError ? requestError.message : "Unable to onboard tunnel")
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!zoneId) {
      setError("Select an account and zone for this tunnel");
      return;
    }
    const connectivityError = validatePublications(publications);
    if (connectivityError) {
      setError(connectivityError);
      return;
    }
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      tenantCode: form.get("tenantCode"),
      tunnelCode,
      displayName: form.get("displayName"),
      zoneId,
      publications: connectivityPayload(publications)
    });
  };
  if (result) return <OnboardingResult result={result} onReset={() => setResult(null)} />;
  const hasCapacity = accountData?.accounts.some((account) => account.status === "active" && account.zones.some((zone) => zone.status === "active" && zone.tunnelCount < zone.softTunnelLimit));
  const zoneOptions = [
    { value: "", label: "Select account / zone" },
    ...(accountData?.accounts.flatMap((account) => account.zones
      .filter((zone) => account.status === "active" && zone.status === "active")
      .map((zone) => ({ value: zone.id, label: `${account.name} / ${zone.name} · ${zone.tunnelCount}/${zone.softTunnelLimit}` }))) ?? [])
  ];
  const selectedZone = accountData?.accounts.flatMap((account) => account.zones).find((zone) => zone.id === zoneId);
  return (
    <div className="page onboarding-page">
      <PageHeader title="Onboard new tunnel" eyebrow="Enrollment" />
      <div className="stepper"><div className="step active"><span>1</span><strong>Tunnel</strong></div><i /><div className="step"><span>2</span><strong>Install</strong></div><i /><div className="step"><span>3</span><strong>Connect</strong></div></div>
      <form className="onboarding-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        {!hasCapacity && <div className="inline-alert">Add an active account and zone before onboarding a tunnel.</div>}
        <section className="form-section"><header><span><TunnelIcon size={18} /></span><div><h2>Tunnel identity</h2></div></header><div className="field-grid"><label className="field"><span className="field-label">Tenant code <FieldHelp text="A stable code assigned for the customer or tenant. It groups tunnels operationally but is not part of the generated subdomain." /></span><input name="tenantCode" placeholder="TENANT" required /></label><label className="field"><span className="field-label">Tunnel ID <FieldHelp text="The stable identifier used as the base subdomain name. It must be unique within the selected zone and should not change after onboarding." /></span><input name="tunnelCode" value={tunnelCode} onChange={(event) => setTunnelCode(event.target.value)} placeholder="001" required /></label></div><label className="field"><span className="field-label">Display name <FieldHelp text="A human-readable name shown only in CFMan. Use the name operators use to recognize this location." /></span><input name="displayName" placeholder="Tunnel 1" required /></label></section>
        <section className="form-section"><header><span><Network size={18} /></span><div><h2>Connectivity</h2></div></header><div className="field"><span className="field-label">Account and zone assignment <FieldHelp text="The selected account owns the tunnel tunnel, and every subdomain below is created in this zone. Type to filter by account or zone name." /></span><SearchableSelect name="zoneId" options={zoneOptions} ariaLabel="Account and zone assignment" emptyMessage="No matching account or zone" onValueChange={setZoneId} /></div><ConnectivityEditor tunnelId={tunnelCode} zoneName={selectedZone?.name} publications={publications} onChange={setPublications} /></section>
        <div className="onboarding-actions"><button className="button button-primary" type="submit" disabled={!hasCapacity || !zoneId || mutation.isPending}>{mutation.isPending ? "Creating enrollment..." : "Create enrollment"}</button></div>
      </form>
    </div>
  );
}

function OnboardingResult({ result, onReset }: { result: { tunnel: Tunnel; enrollment: EnrollmentResult }; onReset: () => void }) {
  return <div className="page onboarding-page"><PageHeader title="Installation ready" eyebrow="Enrollment issued" actions={<button className="button button-secondary" onClick={onReset}><ArrowLeft size={15} />Another tunnel</button>} /><div className="success-banner"><span><Check size={22} /></span><div><strong>{result.tunnel.displayName}</strong><code>{result.tunnel.hostname}</code></div></div><section className="install-surface"><header><h2>Run at the tunnel</h2><span>{result.tunnel.tenantCode} / {result.tunnel.tunnelCode}</span></header><EnrollmentCommands result={result.enrollment} /></section><div className="connection-track"><div className="done"><i><Check size={13} /></i><span>Tunnel reserved</span></div><div className="current"><i>2</i><span>Awaiting installer</span></div><div><i>3</i><span>Connector online</span></div><div><i>4</i><span>Endpoint verified</span></div></div></div>;
}
