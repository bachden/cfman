import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Cloud,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  HardDrive,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Upload
} from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { CopyButton } from "../components/CopyButton";
import { FieldHelp } from "../components/FieldHelp";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import type { FolderListing, NotificationChannel, StorageEntry } from "../types";

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

function parentOf(path: string): string {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/");
}

function contentUrl(path: string, download: boolean): string {
  return `/api/files/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

export function FilesPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const path = (searchParams.get("path") ?? "").replace(/^\/+|\/+$/g, "");
  const [search, setSearch] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renaming, setRenaming] = useState<StorageEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<StorageEntry | null>(null);
  const [sending, setSending] = useState<StorageEntry | null>(null);
  const [sendChannelId, setSendChannelId] = useState("");
  const [caption, setCaption] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const navigate = (next: string) => setSearchParams(next ? { path: next } : {}, { replace: false });

  const { data, isLoading, error } = useQuery({
    queryKey: ["files", path],
    queryFn: () => api.get<FolderListing>(`/api/files${path ? `?path=${encodeURIComponent(path)}` : ""}`),
    retry: false
  });

  // Only loaded once a file is actually being sent: the channel list is not
  // part of browsing files.
  const { data: channelData } = useQuery({
    queryKey: ["notifications", "channels"],
    queryFn: () => api.get<{ channels: NotificationChannel[] }>("/api/notifications/channels"),
    enabled: Boolean(sending)
  });

  const sendableChannels = (channelData?.channels ?? []).filter((channel) => channel.supportsFiles && channel.enabled);
  const sendChannel = sendableChannels.find((channel) => channel.id === sendChannelId) ?? sendableChannels[0];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["files"] });

  const refresh = useMutation({
    mutationFn: () => queryClient.refetchQueries({ queryKey: ["files"], type: "active" }),
    onSuccess: () => toast.success("Folder refreshed"),
    onError: () => toast.error("Unable to refresh")
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => api.post<{ path: string }>("/api/files/folders", { path: joinPath(path, name) }),
    onSuccess: async (result) => {
      setNewFolderOpen(false);
      setNewFolderName("");
      await invalidate();
      toast.success(`Created ${result.path}`);
    },
    onError: (failure) => toast.error(failure instanceof Error ? failure.message : "Unable to create the folder")
  });

  const rename = useMutation({
    mutationFn: ({ entry, name }: { entry: StorageEntry; name: string }) =>
      api.post<{ from: string; to: string }>("/api/files/move", { from: entry.path, to: joinPath(parentOf(entry.path), name) }),
    onSuccess: async (result) => {
      setRenaming(null);
      await invalidate();
      toast.success(`Renamed to ${result.to}`);
    },
    onError: (failure) => toast.error(failure instanceof Error ? failure.message : "Unable to rename")
  });

  const remove = useMutation({
    mutationFn: (entry: StorageEntry) =>
      api.delete<{ path: string }>(`/api/files?path=${encodeURIComponent(entry.path)}${entry.kind === "folder" ? "&recursive=true" : ""}`),
    onSuccess: async (result) => {
      setDeleting(null);
      await invalidate();
      toast.success(`Deleted ${result.path}`);
    },
    onError: (failure) => toast.error(failure instanceof Error ? failure.message : "Unable to delete")
  });

  const sendToChannel = useMutation({
    mutationFn: ({ entry, channelId, body }: { entry: StorageEntry; channelId: string; body: string }) =>
      api.post<{ messageId: string }>(`/api/notifications/channels/${channelId}/send`, { body, files: [entry.path] }),
    onSuccess: () => {
      const name = sending?.name ?? "The file";
      setSending(null);
      setCaption("");
      toast.success(`Sent ${name} to ${sendChannel?.name ?? "the channel"}`);
    },
    onError: (failure) => toast.error(failure instanceof Error ? failure.message : "Unable to send the file")
  });

  // Uploaded one at a time, with the count shown as it goes: a browser cannot
  // report progress inside a fetch upload, so the honest signal is how many of
  // the chosen files have finished.
  const upload = async (files: File[]) => {
    if (!files.length) return;
    const limit = data?.storage.maxUploadBytes ?? Infinity;
    const tooLarge = files.filter((file) => file.size > limit);
    if (tooLarge.length) {
      toast.error(`${tooLarge[0]!.name} is larger than the ${formatSize(limit)} upload limit`);
      return;
    }
    setUploading({ done: 0, total: files.length });
    let failed = 0;
    for (const [index, file] of files.entries()) {
      try {
        await api.putFile(`/api/files/content?path=${encodeURIComponent(joinPath(path, file.name))}`, file);
      } catch (failure) {
        failed += 1;
        toast.error(`${file.name}: ${failure instanceof Error ? failure.message : "upload failed"}`);
      }
      setUploading({ done: index + 1, total: files.length });
    }
    setUploading(null);
    await invalidate();
    const uploaded = files.length - failed;
    if (uploaded) toast.success(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}`);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropActive(false);
    void upload([...event.dataTransfer.files]);
  };

  const storage = data?.storage;
  const entries = data?.entries ?? [];
  const term = search.trim().toLowerCase();
  const visible = term ? entries.filter((entry) => entry.name.toLowerCase().includes(term)) : entries;
  const segments = path ? path.split("/") : [];

  return <div className="page">
    <PageHeader
      title="Files"
      eyebrow="File storage"
      actions={<>
        <button className="button button-secondary" type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCw size={15} className={refresh.isPending ? "spin-icon" : undefined} />{refresh.isPending ? "Refreshing..." : "Refresh"}</button>
        <button className="button button-secondary" type="button" onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }}><FolderPlus size={16} />New folder</button>
        <button className="button button-primary" type="button" disabled={Boolean(uploading)} onClick={() => fileInput.current?.click()}>
          <Upload size={16} />{uploading ? `Uploading ${uploading.done}/${uploading.total}...` : "Upload"}
        </button>
      </>}
    />

    <input
      ref={fileInput}
      type="file"
      multiple
      className="file-input-hidden"
      onChange={(event) => {
        const chosen = [...(event.target.files ?? [])];
        event.target.value = "";
        void upload(chosen);
      }}
    />

    {storage && !storage.configured && <div className="file-storage-warning" role="alert">
      <strong>File storage is not usable.</strong>
      <span>{storage.error}</span>
      <span>Set it in the service environment and restart cfman.</span>
    </div>}

    <div className="toolbar file-toolbar">
      <nav className="file-breadcrumb" aria-label="Folder path">
        <button type="button" onClick={() => navigate("")} disabled={!path}>Storage root</button>
        {segments.map((segment, index) => {
          const target = segments.slice(0, index + 1).join("/");
          return <span key={target}><ChevronRight size={13} /><button type="button" onClick={() => navigate(target)} disabled={target === path}>{segment}</button></span>;
        })}
      </nav>
      <label className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter this folder" /></label>
      {storage && <span className="file-storage-chip" title={storage.driver === "s3" ? "S3-compatible object storage" : "A directory on the machine running cfman"}>
        {storage.driver === "s3" ? <Cloud size={13} /> : <HardDrive size={13} />}
        {storage.driver === "s3" ? "S3-compatible" : "Local directory"}
        <FieldHelp text={`Which storage is behind these paths is set in the service environment, not here. A path means the same thing either way, so an automation script or an enrolled machine addressing ${path ? `${path}/...` : "a file"} does not change when the storage does. Uploads from an enrolled machine land under ${storage.tunnelUploadPrefix}/<tenant code>/<tunnel code>/.`} />
      </span>}
    </div>

    <section
      className={`panel table-panel file-table-panel ${dropActive ? "file-drop-active" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDropActive(true); }}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      <div className="table-scroll"><table><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Type</th><th aria-label="Actions" /></tr></thead><tbody>
        {isLoading
          ? <tr><td colSpan={5}><div className="quiet-empty">Loading folder...</div></td></tr>
          : error
            ? <tr><td colSpan={5}><div className="quiet-empty">{error instanceof Error ? error.message : "Unable to read this folder"}</div></td></tr>
            : visible.length === 0
              ? <tr><td colSpan={5}><div className="quiet-empty">{term ? "Nothing in this folder matches." : "This folder is empty. Drop files here or use Upload."}</div></td></tr>
              : visible.map((entry) => <tr
                key={entry.path}
                className="data-row"
                tabIndex={0}
                onClick={() => { if (entry.kind === "folder") navigate(entry.path); }}
                onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && entry.kind === "folder") { event.preventDefault(); navigate(entry.path); } }}
              >
                <td><div className="primary-cell file-name-cell"><strong>
                  {entry.kind === "folder" ? <Folder size={14} className="file-folder-icon" /> : <FileIcon size={14} className="file-file-icon" />}
                  {entry.kind === "folder" ? entry.name : <a href={contentUrl(entry.path, false)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{entry.name}</a>}
                </strong><span>{entry.path}</span></div></td>
                <td>{formatSize(entry.size)}</td>
                <td>{formatTimestamp(entry.modifiedAt)}</td>
                <td>{entry.kind === "folder" ? "Folder" : entry.contentType ?? "—"}</td>
                <td onClick={(event) => event.stopPropagation()}><div className="file-row-actions">
                  <CopyButton value={entry.path} label="Copy path" iconOnly />
                  {entry.kind === "file" && <a className="icon-button" href={contentUrl(entry.path, true)} title="Download" aria-label={`Download ${entry.name}`}><Download size={15} /></a>}
                  {entry.kind === "file" && <button className="icon-button" type="button" title="Send to a notification channel" aria-label={`Send ${entry.name} to a notification channel`} onClick={() => { setSending(entry); setCaption(""); }}><Send size={15} /></button>}
                  <button className="icon-button" type="button" title="Rename" aria-label={`Rename ${entry.name}`} onClick={() => { setRenaming(entry); setRenameValue(entry.name); }}><Pencil size={15} /></button>
                  <button className="icon-button" type="button" title="Delete" aria-label={`Delete ${entry.name}`} onClick={() => setDeleting(entry)}><Trash2 size={15} /></button>
                </div></td>
              </tr>)}
      </tbody></table></div>
    </section>

    <Modal open={newFolderOpen} title="New folder" onClose={() => setNewFolderOpen(false)}>
      <form className="form-stack" onSubmit={(event) => { event.preventDefault(); if (newFolderName.trim()) createFolder.mutate(newFolderName.trim()); }}>
        <label className="field"><span className="field-label">Name</span><input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="installers" autoFocus /></label>
        <p className="field-note">Created in <code>{path || "the storage root"}</code>. A name may contain any character except <code>\ : * ? " &lt; &gt; |</code>.</p>
        <div className="form-actions">
          <button className="button button-secondary cancel-button-left" type="button" onClick={() => setNewFolderOpen(false)}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={!newFolderName.trim() || createFolder.isPending}>{createFolder.isPending ? "Creating..." : "Create folder"}</button>
        </div>
      </form>
    </Modal>

    <Modal open={Boolean(renaming)} title={`Rename ${renaming?.name ?? ""}`} onClose={() => setRenaming(null)}>
      <form className="form-stack" onSubmit={(event) => { event.preventDefault(); if (renaming && renameValue.trim()) rename.mutate({ entry: renaming, name: renameValue.trim() }); }}>
        <label className="field"><span className="field-label">New name</span><input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus /></label>
        <p className="field-note">Anything already addressing <code>{renaming?.path}</code> — an automation script, a machine's own script — keeps pointing at the old path and will stop finding it.</p>
        <div className="form-actions">
          <button className="button button-secondary cancel-button-left" type="button" onClick={() => setRenaming(null)}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={!renameValue.trim() || renameValue.trim() === renaming?.name || rename.isPending}>{rename.isPending ? "Renaming..." : "Rename"}</button>
        </div>
      </form>
    </Modal>

    <Modal open={Boolean(sending)} title={`Send ${sending?.name ?? ""}`} onClose={() => setSending(null)}>
      <form className="form-stack" onSubmit={(event) => {
        event.preventDefault();
        if (sending && sendChannel) sendToChannel.mutate({ entry: sending, channelId: sendChannel.id, body: caption });
      }}>
        {sendableChannels.length === 0
          ? <p className="field-note">No enabled notification channel can carry a file. Create a Telegram channel under Automation to send one from here.</p>
          : <>
            <label className="field"><span className="field-label">Channel</span>
              <select value={sendChannel?.id ?? ""} onChange={(event) => setSendChannelId(event.target.value)}>
                {sendableChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name} · {channel.target}</option>)}
              </select>
            </label>
            <label className="field"><span className="field-label">Caption <FieldHelp text="Optional text sent with the file. A file on its own is a valid message." /></span>
              <textarea className="automation-message-input" rows={3} value={caption} placeholder={`${sending?.name ?? ""} from cfman`} onChange={(event) => setCaption(event.target.value)} />
            </label>
            <p className="field-note">
              <code>{sending?.path}</code> ({formatSize(sending?.size ?? null)}) is sent from the file store as a document, so it arrives with its bytes intact. The same file goes out of an automation rule with <code>cfman.sendFile("{sendChannel?.key}", "{sending?.path}")</code>.
            </p>
            {sendChannel && (sending?.size ?? 0) > sendChannel.maxFileBytes && <p className="field-note">
              This file is larger than the {Math.floor(sendChannel.maxFileBytes / (1024 * 1024))} MB this channel accepts per file, so the send will be refused.
            </p>}
          </>}
        <div className="form-actions">
          <button className="button button-secondary cancel-button-left" type="button" onClick={() => setSending(null)}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={!sendChannel || sendToChannel.isPending}><Send size={15} />{sendToChannel.isPending ? "Sending..." : "Send file"}</button>
        </div>
      </form>
    </Modal>

    <Modal open={Boolean(deleting)} title={`Delete ${deleting?.name ?? ""}`} onClose={() => setDeleting(null)}>
      <div className="form-stack">
        <p className="field-note">
          {deleting?.kind === "folder"
            ? <><code>{deleting.path}</code> and everything inside it will be deleted from the storage. This cannot be undone.</>
            : <><code>{deleting?.path}</code> will be deleted from the storage. This cannot be undone.</>}
        </p>
        <div className="form-actions">
          <button className="button button-secondary cancel-button-left" type="button" onClick={() => setDeleting(null)}>Cancel</button>
          <button className="button button-danger" type="button" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>{remove.isPending ? "Deleting..." : deleting?.kind === "folder" ? "Delete folder" : "Delete file"}</button>
        </div>
      </div>
    </Modal>
  </div>;
}
