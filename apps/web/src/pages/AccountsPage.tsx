import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, CircleAlert, CloudCog, ExternalLink, KeyRound, LoaderCircle, MonitorCog, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../api";
import { CapacityBar } from "../components/CapacityBar";
import { FieldHelp } from "../components/FieldHelp";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import type { CloudflareAccount } from "../types";

export function AccountsPage() {
  const queryClient = useQueryClient();
  const [accountModal, setAccountModal] = useState(false);
  const [zoneAccount, setZoneAccount] = useState<CloudflareAccount | null>(null);
  const [rdpAccount, setRdpAccount] = useState<CloudflareAccount | null>(null);
  const [deleteAccount, setDeleteAccount] = useState<CloudflareAccount | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<{ accounts: CloudflareAccount[] }>("/api/accounts") });
  const sync = useMutation({
    mutationFn: (id: string) => api.post(`/api/accounts/${id}/sync`),
    onSuccess: async () => { toast.success("Account synchronized"); await queryClient.invalidateQueries({ queryKey: ["accounts"] }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Sync failed")
  });
  const syncAll = useMutation({
    mutationFn: () => api.post<{ success: boolean; results: Array<{ success: boolean; error?: string }> }>("/api/accounts/sync-all"),
    onSuccess: async (result) => { await queryClient.invalidateQueries({ queryKey: ["accounts"] }); await queryClient.invalidateQueries({ queryKey: ["dashboard"] }); const failed = result.results.filter((item) => !item.success).length; if (failed) toast.error(`${failed} account${failed === 1 ? "" : "s"} failed to sync`); else toast.success("Account pool synchronized"); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Sync failed")
  });
  return (
    <div className="page">
      <PageHeader title="Account pool" eyebrow="Cloudflare resources" actions={<><button className="button button-secondary" onClick={() => syncAll.mutate()} disabled={syncAll.isPending || sync.isPending}><RefreshCw size={15} />{syncAll.isPending ? "Syncing..." : "Sync all"}</button><button className="button button-primary" onClick={() => setAccountModal(true)}><Plus size={16} />Add account</button></>} />
      <div className="summary-strip">
        <div><span>Accounts</span><strong>{data?.accounts.length ?? 0}</strong></div>
        <div><span>Zones</span><strong>{data?.accounts.reduce((sum, item) => sum + item.zones.length, 0) ?? 0}</strong></div>
        <div><span>Allocated stores</span><strong>{data?.accounts.reduce((sum, item) => sum + item.storeCount, 0) ?? 0}</strong></div>
      </div>
      {isLoading ? <div className="loading-block" /> : data?.accounts.length === 0 ? (
        <section className="full-empty"><CloudCog size={28} /><h2>No Cloudflare accounts</h2><button className="button button-primary" onClick={() => setAccountModal(true)}><Plus size={16} />Add account</button></section>
      ) : (
        <div className="account-list">
          {data?.accounts.map((account) => (
            <section className="account-section" key={account.id}>
              <header className="account-header">
                <div className="account-identity"><span className="large-glyph"><CloudCog size={20} /></span><div><div className="title-line"><h2>{account.name}</h2><StatusBadge status={account.status} />{account.providerMode === "mock" && <span className="mode-label">TEST</span>}</div><span className="mono subdued">{account.cfAccountId ?? "Local mock provider"}</span></div></div>
                <div className="account-capacity"><span>Tunnel allocation</span><CapacityBar value={account.storeCount} limit={account.softTunnelLimit} compact /></div>
                <div className="account-actions">
                  <button className="button button-secondary" onClick={() => sync.mutate(account.id)} disabled={sync.isPending}><RefreshCw size={15} />Sync</button>
                  <button className="button button-secondary" onClick={() => setRdpAccount(account)}><MonitorCog size={15} />Support emails</button>
                  <button className="button button-secondary" onClick={() => setZoneAccount(account)}><Plus size={15} />Zone</button>
                  <button className="icon-button account-delete" onClick={() => setDeleteAccount(account)} aria-label={`Delete ${account.name}`} title="Delete account"><Trash2 size={16} /></button>
                </div>
              </header>
              {account.lastError && <div className="inline-alert">{account.lastError}</div>}
              <div className="table-scroll"><table className="zone-table"><thead><tr><th>Zone</th><th>Zone ID</th><th>DNS allocation</th><th>Status</th></tr></thead><tbody>
                {account.zones.length === 0 ? <tr><td colSpan={4}><div className="quiet-empty">No zones synchronized</div></td></tr> : account.zones.map((zone) => (
                  <tr key={zone.id}><td><div className="primary-cell"><strong>{zone.name}</strong><span>{zone.dnsRecordLimit.toLocaleString()} record limit</span></div></td><td className="mono subdued">{zone.cfZoneId ?? "mock"}</td><td><CapacityBar value={zone.storeCount} limit={zone.softStoreLimit} compact /></td><td><StatusBadge status={zone.status} /></td></tr>
                ))}
              </tbody></table></div>
            </section>
          ))}
        </div>
      )}
      <AddAccountModal open={accountModal} onClose={() => setAccountModal(false)} />
      <AddZoneModal account={zoneAccount} onClose={() => setZoneAccount(null)} />
      <RdpSettingsModal account={rdpAccount} onClose={() => setRdpAccount(null)} />
      <DeleteAccountModal account={deleteAccount} onClose={() => setDeleteAccount(null)} />
    </div>
  );
}

function AddAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [cfAccountId, setCfAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [tokenValidation, setTokenValidation] = useState<{ status: "idle" | "validating" | "valid" | "invalid"; message?: string }>({ status: "idle" });
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (body: unknown) => api.post("/api/accounts", body),
    onSuccess: async () => { toast.success("Account added"); await queryClient.invalidateQueries({ queryKey: ["accounts"] }); onClose(); },
    onError: (requestError) => setError(requestError instanceof ApiError ? requestError.message : "Unable to add account")
  });
  useEffect(() => {
    const accountId = cfAccountId.trim();
    const token = apiToken.trim();
    if (!accountId || !token) {
      setTokenValidation({ status: "idle" });
      return;
    }

    let active = true;
    setTokenValidation({ status: "validating", message: "Validating token..." });
    const timer = window.setTimeout(() => {
      void api.post<{ valid: boolean; status: string }>("/api/accounts/validate-token", { cfAccountId: accountId, apiToken: token })
        .then(() => {
          if (active) setTokenValidation({ status: "valid", message: "Token is active" });
        })
        .catch((requestError) => {
          if (active) setTokenValidation({ status: "invalid", message: requestError instanceof Error ? requestError.message : "Token validation failed" });
        });
    }, 350);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [cfAccountId, apiToken]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (tokenValidation.status !== "valid") {
      setError("Enter an active Cloudflare API token before adding the account");
      return;
    }
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      name: form.get("name"),
      providerMode: "live",
      cfAccountId: form.get("cfAccountId"),
      apiToken: form.get("apiToken"),
      softTunnelLimit: Number(form.get("softTunnelLimit")),
      rdpAllowedEmails: parseEmails(form.get("rdpAllowedEmails"))
    });
  };
  return (
    <Modal open={open} title="Add Cloudflare account" onClose={onClose} width="wide">
      <form className="form-stack" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <label className="field"><span className="field-label">Display name <FieldHelp text="An internal name used to identify this Cloudflare account in the account pool. It does not change anything in Cloudflare." /></span><input name="name" placeholder="Account 1" required /></label>
        <label className="field"><span className="field-label">Cloudflare Account ID <FieldHelp text="The 32-character account identifier shown on the Cloudflare account Overview page and in the dashboard URL after dash.cloudflare.com/." /></span><input name="cfAccountId" className="mono-input" autoComplete="off" value={cfAccountId} onChange={(event) => setCfAccountId(event.target.value)} required /></label>
        <ApiTokenGuide accountId={cfAccountId} />
        <label className={`field token-field token-field-${tokenValidation.status}`}>
          <span className="field-label">Cloudflare API token <FieldHelp text="Create an account-owned custom API token with the permissions listed above. Cloudflare shows its value once; Cloudflare Man validates it now and stores it encrypted after the account is added." /></span>
          <div className="input-status-control">
            <input name="apiToken" type="password" autoComplete="new-password" value={apiToken} onChange={(event) => setApiToken(event.target.value)} aria-describedby="token-validation-message" required />
            {tokenValidation.status === "validating" && <LoaderCircle className="spin-icon" size={16} />}
            {tokenValidation.status === "valid" && <CheckCircle2 size={16} />}
            {tokenValidation.status === "invalid" && <CircleAlert size={16} />}
          </div>
          {tokenValidation.status !== "idle" && <small id="token-validation-message" className="token-validation-message">{tokenValidation.message}</small>}
        </label>
        <label className="field"><span className="field-label">Support emails <FieldHelp text="One identity email per line. Each email is granted a Cloudflare Access policy to open browser RDP sessions for stores on this account - this is the account's only email list, not a separate contact address. Use the operators' login emails." /></span><textarea name="rdpAllowedEmails" rows={4} placeholder="operator@example.com" required /></label>
        <label className="field"><span className="field-label">Soft tunnel limit <FieldHelp text="A local allocation threshold for this account. Cloudflare Man stops assigning new stores at this number; it does not change the Cloudflare quota." /></span><input name="softTunnelLimit" type="number" min="1" max="1000" defaultValue="750" required /></label>
        <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={mutation.isPending || tokenValidation.status !== "valid"}>{mutation.isPending ? "Adding..." : "Add account"}</button></div>
      </form>
    </Modal>
  );
}

const apiTokenPermissions = [
  ["Account", "Account Settings", "Read", "Validate the account"],
  ["Account", "Cloudflare One Connector: cloudflared", "Write", "Manage tunnels and connector configurations"],
  ["Account", "Cloudflare One Networks", "Write", "Manage tunnel routes and virtual networks"],
  ["Account", "Zero Trust", "Write", "Create browser RDP targets"],
  ["Account", "Access: Apps and Policies", "Write", "Protect browser RDP sessions"],
  ["Zone", "DNS", "Write", "Create and update store hostnames"],
  ["Zone", "Zone", "Read", "Synchronize available zones"],
  ["Zone", "WAF", "Write", "Manage per-route source IP policies"],
] as const;

function ApiTokenGuide({ accountId }: { accountId: string }) {
  const tokenUrl = accountId.trim()
    ? `https://dash.cloudflare.com/${encodeURIComponent(accountId.trim())}/api-tokens`
    : "https://dash.cloudflare.com/";
  return (
    <section className="token-guide" aria-labelledby="token-guide-title">
      <header>
        <span className="token-guide-icon"><KeyRound size={17} /></span>
        <div>
          <h3 id="token-guide-title">Required API token permissions</h3>
          <p>Use an account-owned custom API token. Cloudflare Access service tokens are not supported here.</p>
        </div>
        <a className="text-link" href={tokenUrl} target="_blank" rel="noreferrer">Open API tokens <ExternalLink size={13} /></a>
      </header>
      <div className="permission-list">
        {apiTokenPermissions.map(([scope, permission, access, purpose]) => (
          <div className="permission-row" key={`${scope}-${permission}`}>
            <Check size={13} />
            <span className="permission-scope">{scope}</span>
            <strong>{permission}</strong>
            <span className={`permission-access permission-access-${access.toLowerCase()}`}>{access}</span>
            <small>{purpose}</small>
          </div>
        ))}
      </div>
      <div className="token-scope-note">
        <strong>Resource scope</strong>
        <span>Select the entire account. DNS and Zone permissions appear under the zone resource scope.</span>
      </div>
    </section>
  );
}

function DeleteAccountModal({ account, onClose }: { account: CloudflareAccount | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: () => api.delete(`/api/accounts/${account!.id}`),
    onSuccess: async () => {
      toast.success("Account deleted");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
      onClose();
    },
    onError: (requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to delete account")
  });
  const hasStores = (account?.storeCount ?? 0) > 0;
  return (
    <Modal open={Boolean(account)} title={`Delete ${account?.name ?? "account"}`} onClose={onClose}>
      <div className="delete-confirmation">
        {error && <div className="form-error">{error}</div>}
        {hasStores ? (
          <div className="inline-alert">This account is assigned to {account?.storeCount} store{account?.storeCount === 1 ? "" : "s"}. Reassign or delete them first.</div>
        ) : (
          <p>This removes the account and its synchronized zones from Cloudflare Man. Existing Cloudflare tunnels, DNS records, and Access policies are not deleted.</p>
        )}
        <div className="form-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button button-danger" type="button" onClick={() => mutation.mutate()} disabled={mutation.isPending || hasStores}><Trash2 size={15} />{mutation.isPending ? "Deleting..." : "Delete account"}</button>
        </div>
      </div>
    </Modal>
  );
}

function parseEmails(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(/[\n,]+/).map((email) => email.trim().toLowerCase()).filter(Boolean);
}

function RdpSettingsModal({ account, onClose }: { account: CloudflareAccount | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (rdpAllowedEmails: string[]) => api.patch(`/api/accounts/${account!.id}/rdp-settings`, { rdpAllowedEmails }),
    onSuccess: async () => { toast.success("Support emails updated"); await queryClient.invalidateQueries({ queryKey: ["accounts"] }); onClose(); },
    onError: (requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to update support emails")
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    mutation.mutate(parseEmails(form.get("rdpAllowedEmails")));
  };
  return <Modal open={Boolean(account)} title={`Support emails · ${account?.name ?? "account"}`} onClose={onClose}><form className="form-stack" onSubmit={submit}>{error && <div className="form-error">{error}</div>}<label className="field"><span className="field-label">Support emails <FieldHelp text="One identity email per line. Each email is granted a Cloudflare Access policy to open browser RDP sessions for stores on this account - this is the account's only email list, not a separate contact address." /></span><textarea name="rdpAllowedEmails" rows={4} defaultValue={account?.rdpAllowedEmails.join("\n") ?? ""} placeholder="operator@example.com" required /></label><div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={mutation.isPending}>{mutation.isPending ? "Updating..." : "Update policy"}</button></div></form></Modal>;
}

function AddZoneModal({ account, onClose }: { account: CloudflareAccount | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (body: unknown) => api.post(`/api/accounts/${account!.id}/zones`, body),
    onSuccess: async () => { toast.success("Zone added"); await queryClient.invalidateQueries({ queryKey: ["accounts"] }); onClose(); },
    onError: (requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to add zone")
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({ name: form.get("name"), cfZoneId: form.get("cfZoneId") || undefined, dnsRecordLimit: Number(form.get("dnsRecordLimit")), softStoreLimit: Number(form.get("softStoreLimit")) });
  };
  return <Modal open={Boolean(account)} title={`Add zone to ${account?.name ?? "account"}`} onClose={onClose}><form className="form-stack" onSubmit={submit}>{error && <div className="form-error">{error}</div>}<label className="field"><span className="field-label">Zone name <FieldHelp text="The active DNS zone name already added to this Cloudflare account. Find it under Websites in the Cloudflare dashboard." /></span><input name="name" placeholder="stores.example.com" required /></label>{account?.providerMode === "live" && <label className="field"><span className="field-label">Cloudflare Zone ID <FieldHelp text="The zone identifier shown on that domain's Overview page in the Cloudflare dashboard API section." /></span><input name="cfZoneId" className="mono-input" required /></label>}<div className="field-grid"><label className="field"><span className="field-label">DNS record limit <FieldHelp text="The planning ceiling used by Cloudflare Man for records in this zone. It does not change the actual Cloudflare DNS quota." /></span><input name="dnsRecordLimit" type="number" defaultValue="200" min="1" required /></label><label className="field"><span className="field-label">Soft store limit <FieldHelp text="Automatic allocation stops assigning stores to this zone at this number, leaving room below the DNS record limit." /></span><input name="softStoreLimit" type="number" defaultValue="150" min="1" required /></label></div><div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={mutation.isPending}>Add zone</button></div></form></Modal>;
}
