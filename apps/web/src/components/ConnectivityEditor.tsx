import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Globe2, GripVertical, Plus, Route, Trash2 } from "lucide-react";
import { FieldHelp } from "./FieldHelp";

let draftSequence = 0;

function draftId(prefix: string): string {
  draftSequence += 1;
  return `${prefix}-${draftSequence}`;
}

export type DraftRoute = {
  key: string;
  path: string;
  serviceUrl: string;
  kind: "service" | "command_agent";
};

export type DraftPublication = {
  key: string;
  suffix: string;
  // When true, `customLabel` is used verbatim as the full subdomain label
  // instead of the tunnel-id-derived `suffix`.
  useCustomLabel: boolean;
  customLabel: string;
  routes: DraftRoute[];
};

export function createDraftPublication(serviceUrl = ""): DraftPublication {
  return {
    key: draftId("publication"),
    suffix: "",
    useCustomLabel: false,
    customLabel: "",
    routes: [{ key: draftId("route"), path: "/", serviceUrl, kind: "service" }]
  };
}

export function createCommandAgentDraftPublication(): DraftPublication {
  return {
    key: draftId("publication"),
    suffix: "",
    useCustomLabel: false,
    customLabel: "",
    routes: [{ key: draftId("route"), path: "/exec", serviceUrl: "", kind: "command_agent" }]
  };
}

export function validatePublications(publications: DraftPublication[]): string | null {
  if (publications.length === 0) return "Add at least one subdomain";
  const labelKeys = new Set<string>();
  let commandAgentRoutes = 0;
  let sshRoutes = 0;
  for (const publication of publications) {
    const customLabel = publication.customLabel.trim().toLowerCase();
    const suffix = publication.suffix.trim().toLowerCase();
    if (publication.useCustomLabel) {
      if (!customLabel) return "Enter a subdomain, or switch back to Auto";
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(customLabel)) {
        return "Subdomains can contain lowercase letters, numbers, and inner hyphens";
      }
    } else if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)?$/.test(suffix)) {
      return "Suffixes can contain lowercase letters, numbers, and inner hyphens";
    }
    const labelKey = publication.useCustomLabel ? `custom:${customLabel}` : `suffix:${suffix}`;
    if (labelKeys.has(labelKey)) return "Each subdomain must be unique";
    labelKeys.add(labelKey);
    if (publication.routes.length === 0) return "Each subdomain needs at least one route";
    const paths = new Set<string>();
    for (const route of publication.routes) {
      if (route.kind === "command_agent") commandAgentRoutes += 1;
      const path = route.path.trim();
      if (!path.startsWith("/")) return "Every path must start with /";
      if (paths.has(path)) return `Path ${path} is duplicated within a subdomain`;
      paths.add(path);
      if (route.kind === "service") {
        try {
          const url = new URL(route.serviceUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ssh:") return "Service URLs must use HTTP, HTTPS, or SSH";
          if (url.protocol === "ssh:") sshRoutes += 1;
        } catch {
          return "Enter a valid service URL for every route";
        }
      }
    }
  }
  if (commandAgentRoutes > 1) return "Only one command agent route can be configured per tunnel";
  if (sshRoutes > 1) return "Only one ssh:// route can be configured per tunnel";
  return null;
}

export function connectivityPayload(publications: DraftPublication[]) {
  return publications.map((publication) => ({
    suffix: publication.suffix.trim().toLowerCase(),
    ...(publication.useCustomLabel && publication.customLabel.trim() ? { customLabel: publication.customLabel.trim().toLowerCase() } : {}),
    routes: publication.routes.map((route) => ({
      kind: route.kind,
      path: route.path.trim(),
      ...(route.kind === "service" ? { serviceUrl: route.serviceUrl.trim() } : {})
    }))
  }));
}

function hostnameLabel(tunnelId: string, publication: DraftPublication): string {
  if (publication.useCustomLabel) return publication.customLabel.trim().toLowerCase() || "subdomain";
  const normalized = tunnelId
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const baseLabel = normalized || "tunnel-id";
  return publication.suffix.trim() ? `${baseLabel}-${publication.suffix.trim().toLowerCase()}` : baseLabel;
}

export function ConnectivityEditor({
  tunnelId,
  zoneName,
  publications,
  onChange
}: {
  tunnelId: string;
  zoneName?: string | undefined;
  publications: DraftPublication[];
  onChange: (publications: DraftPublication[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const updatePublication = (index: number, update: (publication: DraftPublication) => DraftPublication) => {
    onChange(publications.map((publication, publicationIndex) => publicationIndex === index ? update(publication) : publication));
  };
  const reorderRoutes = (publicationIndex: number, event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    updatePublication(publicationIndex, (publication) => {
      const oldIndex = publication.routes.findIndex((route) => route.key === event.active.id);
      const newIndex = publication.routes.findIndex((route) => route.key === event.over!.id);
      if (oldIndex < 0 || newIndex < 0) return publication;
      const reordered = arrayMove(publication.routes, oldIndex, newIndex);
      return { ...publication, routes: [...reordered.filter((route) => route.path.trim() !== "/"), ...reordered.filter((route) => route.path.trim() === "/")] };
    });
  };
  return (
    <div className="connectivity-editor">
      <div className="connectivity-editor-heading">
        <div><h3>Published subdomains</h3><span>One tunnel serves every hostname and route below.</span></div>
        <button className="button button-secondary button-small" type="button" onClick={() => onChange([...publications, createDraftPublication()])}><Plus size={14} />Subdomain</button>
      </div>
      <div className="publication-editor-list">
        {publications.map((publication, publicationIndex) => {
          const preview = `${hostnameLabel(tunnelId, publication)}.${zoneName || "selected-zone"}`;
          return (
            <section className="publication-editor" key={publication.key}>
              <header>
                <span className="publication-glyph"><Globe2 size={16} /></span>
                <div><strong>Subdomain {publicationIndex + 1}</strong><code>{preview}</code></div>
                <button className="icon-button account-delete" type="button" title="Remove subdomain" aria-label={`Remove subdomain ${publicationIndex + 1}`} disabled={publications.length === 1} onClick={() => onChange(publications.filter((_, index) => index !== publicationIndex))}><Trash2 size={15} /></button>
              </header>
              <div className="command-mode-toggle" role="tablist" aria-label="Subdomain naming">
                <button type="button" role="tab" aria-selected={!publication.useCustomLabel} className={!publication.useCustomLabel ? "active" : ""} onClick={() => updatePublication(publicationIndex, (current) => ({ ...current, useCustomLabel: false }))}>Auto</button>
                <button type="button" role="tab" aria-selected={publication.useCustomLabel} className={publication.useCustomLabel ? "active" : ""} onClick={() => updatePublication(publicationIndex, (current) => ({ ...current, useCustomLabel: true }))}>Custom</button>
              </div>
              {publication.useCustomLabel
                ? <label className="field"><span className="field-label">Subdomain <FieldHelp text="The full subdomain label, used exactly as typed - it does not need to contain the Tunnel ID. Must be unique within the zone." /></span><input value={publication.customLabel} onChange={(event) => updatePublication(publicationIndex, (current) => ({ ...current, customLabel: event.target.value }))} placeholder="checkout" maxLength={63} /></label>
                : <label className="field"><span className="field-label">Suffix <FieldHelp text="Optional. Leave blank to use the Tunnel ID as the hostname, or enter a suffix to create Tunnel ID-suffix. Only one subdomain can have a blank suffix." /></span><input value={publication.suffix} onChange={(event) => updatePublication(publicationIndex, (current) => ({ ...current, suffix: event.target.value }))} placeholder="api" maxLength={30} /></label>}
              <div className="route-editor">
                <div className="route-editor-heading"><span><Route size={14} />Ingress routes</span><button type="button" onClick={() => updatePublication(publicationIndex, (current) => ({ ...current, routes: [...current.routes, { key: draftId("route"), path: "/api", serviceUrl: "", kind: "service" }] }))}><Plus size={13} />Path</button></div>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => reorderRoutes(publicationIndex, event)}>
                  <SortableContext items={publication.routes.map((route) => route.key)} strategy={verticalListSortingStrategy}>
                    {publication.routes.map((route, routeIndex) => (
                      <SortableRouteRow
                        key={route.key}
                        route={route}
                        routeCount={publication.routes.length}
                        onChange={(update) => updatePublication(publicationIndex, (current) => ({ ...current, routes: current.routes.map((item, index) => index === routeIndex ? { ...item, ...update } : item) }))}
                        onRemove={() => updatePublication(publicationIndex, (current) => ({ ...current, routes: current.routes.filter((_, index) => index !== routeIndex) }))}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SortableRouteRow({
  route,
  routeCount,
  onChange,
  onRemove
}: {
  route: DraftRoute;
  routeCount: number;
  onChange: (update: Partial<Pick<DraftRoute, "path" | "serviceUrl" | "kind">>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: route.key });
  return (
    <div
      className={`route-editor-row ${isDragging ? "route-editor-row-dragging" : ""}`}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button className="route-drag-handle" type="button" title="Drag to reorder" aria-label={`Reorder path ${route.path}`} {...attributes} {...listeners}><GripVertical size={16} /></button>
      <label className="field"><span className="field-label">Path prefix <FieldHelp text="The URL path prefix matched on this hostname. Drag routes into priority order. Use / as the fallback; it is always kept last." /></span><input value={route.path} onChange={(event) => onChange({ path: event.target.value })} placeholder="/" required /></label>
      <label className="field"><span className="field-label">Route type <FieldHelp text="Choose Command agent to expose the cfman script runner on this subdomain and path. Only one command agent route is allowed per tunnel." /></span><select value={route.kind} onChange={(event) => onChange({ kind: event.target.value as DraftRoute["kind"] })}><option value="service">Local service</option><option value="command_agent">Command agent</option></select></label>
      <label className="field"><span className="field-label">Local service URL <FieldHelp text={route.kind === "command_agent" ? "The command agent is installed by the enrollment script and listens on localhost:47831." : "The HTTP service reachable from the cloudflared machine. Use localhost for a service on the same host or a LAN IP for another POS machine."} /></span><input type="url" value={route.kind === "command_agent" ? "http://127.0.0.1:47831" : route.serviceUrl} onChange={(event) => onChange({ serviceUrl: event.target.value })} placeholder={route.kind === "command_agent" ? "Managed by cfman" : "http://localhost:8080"} disabled={route.kind === "command_agent"} required={route.kind === "service"} /></label>
      <button className="icon-button account-delete" type="button" title="Remove path" aria-label={`Remove path ${route.path}`} disabled={routeCount === 1} onClick={onRemove}><Trash2 size={15} /></button>
    </div>
  );
}
