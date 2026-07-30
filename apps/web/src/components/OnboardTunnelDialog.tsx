import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../api";
import type { EnrollmentResult, Tunnel } from "../types";
import { connectivityPayload, createCommandAgentDraftPublication } from "./ConnectivityEditor";
import { useDrawers } from "./DrawerContext";
import { FieldHelp } from "./FieldHelp";
import { Modal } from "./Modal";

// The account/zone assignment is deliberately not asked here - the server
// already auto-picks the least-loaded active zone when zoneId is omitted
// (selectZone, apps/server/src/lib/tunnels.ts), and the tunnel always starts
// with just the command-agent route (createCommandAgentDraftPublication) so
// there is nothing else to configure before installing. Both can still be
// changed afterward from the drawer this opens into (Reassign zone, Edit
// connectivity).
export function OnboardTunnelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { openTunnelDrawer } = useDrawers();
  const [tenantCode, setTenantCode] = useState("");
  const [tunnelCode, setTunnelCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const { data: tenantCodesData } = useQuery({
    queryKey: ["tenant-codes"],
    queryFn: () => api.get<{ tenantCodes: string[] }>("/api/tunnels/tenant-codes"),
    enabled: open
  });
  const reset = () => { setTenantCode(""); setTunnelCode(""); setDisplayName(""); setError(""); };
  const mutation = useMutation({
    mutationFn: async () => {
      const created = await api.post<{ tunnel: Tunnel }>("/api/tunnels", {
        tenantCode: tenantCode.trim(),
        tunnelCode: tunnelCode.trim(),
        displayName: displayName.trim(),
        publications: connectivityPayload([createCommandAgentDraftPublication()])
      });
      const enrollment = await api.post<EnrollmentResult>(`/api/tunnels/${created.tunnel.id}/enrollments`, { expiresInHours: 24 });
      return { tunnel: created.tunnel, enrollment };
    },
    onSuccess: async ({ tunnel, enrollment }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["tenant-codes"] })
      ]);
      toast.success("Tunnel ready for installation");
      openTunnelDrawer(tunnel.id, "overall", enrollment.id);
      reset();
      onClose();
    },
    onError: (requestError) => setError(requestError instanceof ApiError ? requestError.message : "Unable to onboard tunnel")
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!tenantCode.trim() || !tunnelCode.trim()) {
      setError("Enter a tenant code and tunnel ID");
      return;
    }
    if (displayName.trim().length < 2) {
      setError("Enter a display name of at least 2 characters");
      return;
    }
    mutation.mutate();
  };
  const close = () => { reset(); onClose(); };
  return <Modal open={open} title="Onboard tunnel" onClose={close}>
    <form className="form-stack" onSubmit={submit}>
      {error && <div className="form-error">{error}</div>}
      <label className="field">
        <span className="field-label">Tenant code <FieldHelp text="A stable code assigned for the customer or tenant. It groups tunnels operationally but is not part of the generated subdomain. Pick an existing one or type a new one." /></span>
        <input list="onboard-tenant-codes" value={tenantCode} onChange={(event) => setTenantCode(event.target.value)} placeholder="TENANT" maxLength={80} required autoFocus />
        <datalist id="onboard-tenant-codes">{(tenantCodesData?.tenantCodes ?? []).map((code) => <option key={code} value={code} />)}</datalist>
      </label>
      <label className="field">
        <span className="field-label">Tunnel ID <FieldHelp text="The stable identifier used as the base subdomain name. It must be unique within the selected zone and should not change after onboarding." /></span>
        <input value={tunnelCode} onChange={(event) => setTunnelCode(event.target.value)} placeholder="001" maxLength={80} required />
      </label>
      <label className="field">
        <span className="field-label">Tunnel name <FieldHelp text="A human-readable name shown only in CFMan. Use the name operators use to recognize this location." /></span>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Tunnel 1" maxLength={160} required />
      </label>
      <div className="form-actions">
        <button className="button button-secondary" type="button" onClick={close}>Cancel</button>
        <button className="button button-primary" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Creating..." : "OK"}</button>
      </div>
    </form>
  </Modal>;
}
