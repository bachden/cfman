import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Save, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import type { NotificationChannel, NotificationMessage } from "../types";
import { FieldHelp } from "./FieldHelp";
import { Modal } from "./Modal";
import { SideDrawer } from "./SideDrawer";
import { StatusBadge } from "./StatusBadge";

type TelegramConfig = { chatId: string; parseMode: "none" | "markdown" | "html"; disableNotification: boolean };

const emptyForm = {
  key: "",
  name: "",
  description: "",
  enabled: true,
  chatId: "",
  parseMode: "none" as TelegramConfig["parseMode"],
  disableNotification: false,
  botToken: ""
};

type ChannelForm = typeof emptyForm;

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function ChannelDrawer({
  channelId,
  onClose,
  width,
  onResize
}: {
  channelId: string | null;
  onClose: () => void;
  width: number;
  onResize: (width: number) => void;
}) {
  const queryClient = useQueryClient();
  const isNew = channelId === null;
  const [form, setForm] = useState<ChannelForm>(emptyForm);
  const [loadedChannelId, setLoadedChannelId] = useState<string | null>(null);
  const [testBody, setTestBody] = useState("cfman test message");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [messagePage, setMessagePage] = useState(1);

  const { data } = useQuery({
    queryKey: ["notifications", "channel", channelId],
    queryFn: () => api.get<{ channel: NotificationChannel }>(`/api/notifications/channels/${channelId}`),
    enabled: Boolean(channelId)
  });

  const { data: messageData } = useQuery({
    queryKey: ["notifications", "messages", channelId, messagePage],
    queryFn: () => api.get<{ messages: NotificationMessage[]; pagination: { page: number; totalPages: number; total: number } }>(`/api/notifications/channels/${channelId}/messages?page=${messagePage}&pageSize=10`),
    enabled: Boolean(channelId)
  });

  useEffect(() => {
    const channel = data?.channel;
    if (!channel || loadedChannelId === channel.id) return;
    const config = channel.config as Partial<TelegramConfig>;
    setLoadedChannelId(channel.id);
    setForm({
      key: channel.key,
      name: channel.name,
      description: channel.description,
      enabled: channel.enabled,
      chatId: config.chatId ?? "",
      parseMode: config.parseMode ?? "none",
      disableNotification: Boolean(config.disableNotification),
      botToken: ""
    });
  }, [data, loadedChannelId]);

  const channel = data?.channel;
  const storedTokenHint = channel?.secretHints.botToken;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["notifications"] });
  };

  const save = useMutation({
    mutationFn: () => {
      const config = { chatId: form.chatId.trim(), parseMode: form.parseMode, disableNotification: form.disableNotification };
      if (isNew) {
        return api.post<{ channel: NotificationChannel }>("/api/notifications/channels", {
          key: form.key.trim(),
          name: form.name.trim(),
          type: "telegram",
          description: form.description.trim(),
          enabled: form.enabled,
          config,
          secrets: { botToken: form.botToken.trim() }
        });
      }
      return api.patch<{ channel: NotificationChannel }>(`/api/notifications/channels/${channelId}`, {
        name: form.name.trim(),
        description: form.description.trim(),
        enabled: form.enabled,
        config,
        // An untouched token field leaves the stored credential alone.
        ...(form.botToken.trim() ? { secrets: { botToken: form.botToken.trim() } } : {})
      });
    },
    onSuccess: async () => {
      setForm((current) => ({ ...current, botToken: "" }));
      await invalidate();
      toast.success(isNew ? "Channel created" : "Channel saved");
      if (isNew) onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to save the channel")
  });

  const sendTest = useMutation({
    mutationFn: () => api.post<{ messageId: string }>(`/api/notifications/channels/${channelId}/send`, { body: testBody }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Message sent");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to send the message")
  });

  const remove = useMutation({
    mutationFn: () => api.delete<{ success: boolean }>(`/api/notifications/channels/${channelId}`),
    onSuccess: async () => {
      setDeleteOpen(false);
      await invalidate();
      toast.success("Channel deleted");
      onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to delete the channel")
  });

  const canSave = form.name.trim().length > 0
    && form.chatId.trim().length > 0
    && (!isNew || (/^[a-z0-9][a-z0-9_-]*$/.test(form.key.trim()) && form.botToken.trim().length > 0));

  const title = <div className="drawer-heading">
    <strong>{isNew ? "New notification channel" : form.name || "Notification channel"}</strong>
    {!isNew && <code className="automation-key-chip">{form.key}</code>}
    {!isNew && channel?.supportsButtons && <span className="automation-buttons-chip" title={`A rule script can ask a question here with up to ${channel.maxButtons} buttons`}>buttons</span>}
    {!isNew && channel && <StatusBadge status={channel.enabled ? "enabled" : "inactive"} label={channel.enabled ? "enabled" : "disabled"} />}
  </div>;

  return <SideDrawer open title={title} focusKey={channelId ?? "new-channel"} onClose={onClose} width={width} onResize={onResize}>
    <div className="automation-drawer">
      <section className="automation-section">
        <header><h3>Identity</h3><span>Rule scripts address this channel by its key.</span></header>
        <div className="automation-identity-grid">
          <label className="field"><span className="field-label">Key <FieldHelp text="Lowercase letters, digits, hyphen, or underscore. Set once at creation; rules reference the channel by this key, so it cannot change later." /></span><input value={form.key} disabled={!isNew} placeholder="ops-telegram" onChange={(event) => setForm((current) => ({ ...current, key: event.target.value.toLowerCase() }))} /></label>
          <label className="field"><span className="field-label">Name</span><input value={form.name} placeholder="Ops channel" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
          <label className="field"><span className="field-label">Description</span><input value={form.description} placeholder="Optional description" onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
          <label className="switch-control automation-enabled-toggle"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} /><span /><strong>{form.enabled ? "Enabled" : "Disabled"}</strong></label>
        </div>
      </section>

      <section className="automation-section">
        <header><h3>Telegram bot</h3><span>Messages are delivered with the bot API's sendMessage method.</span></header>
        <div className="automation-identity-grid">
          <label className="field"><span className="field-label">Chat ID <FieldHelp text="Numeric chat id (including a negative group id) or a public @channelusername. The bot must already be a member of that chat." /></span><input value={form.chatId} placeholder="-1001234567890" onChange={(event) => setForm((current) => ({ ...current, chatId: event.target.value }))} /></label>
          <label className="field"><span className="field-label">Parse mode <FieldHelp text="How Telegram interprets the message text. MarkdownV2 and HTML reject malformed markup, which fails the send; plain text never does." /></span>
            <select value={form.parseMode} onChange={(event) => setForm((current) => ({ ...current, parseMode: event.target.value as TelegramConfig["parseMode"] }))}>
              <option value="none">Plain text</option>
              <option value="markdown">MarkdownV2</option>
              <option value="html">HTML</option>
            </select>
          </label>
          <label className="field"><span className="field-label">Bot token {storedTokenHint && <FieldHelp text="A token is already stored. Leave this empty to keep it, or type a new one to replace it." />}</span><input type="password" autoComplete="new-password" value={form.botToken} placeholder={storedTokenHint ? `Stored: ${storedTokenHint}` : "123456:ABC-DEF..."} onChange={(event) => setForm((current) => ({ ...current, botToken: event.target.value }))} /></label>
          <label className="switch-control automation-enabled-toggle"><input type="checkbox" checked={form.disableNotification} onChange={(event) => setForm((current) => ({ ...current, disableNotification: event.target.checked }))} /><span /><strong>Silent delivery</strong></label>
        </div>
        {channel?.lastError && <div className="automation-run-error">Last send failed: {channel.lastError}</div>}
      </section>

      <div className="form-actions automation-form-actions">
        {!isNew && <button className="button button-danger" type="button" onClick={() => setDeleteOpen(true)}><Trash2 size={15} />Delete</button>}
        <button className="button button-primary" type="button" disabled={!canSave || save.isPending} onClick={() => save.mutate()}><Save size={15} />{save.isPending ? "Saving..." : isNew ? "Create channel" : "Save changes"}</button>
      </div>

      {!isNew && <section className="automation-section">
        <header><h3>Send a message</h3><span>Goes to the same chat cfman.sendMessage writes to.</span></header>
        <textarea className="automation-message-input" rows={3} value={testBody} onChange={(event) => setTestBody(event.target.value)} />
        <div className="form-actions"><button className="button button-secondary" type="button" disabled={!testBody.trim() || sendTest.isPending} onClick={() => sendTest.mutate()}><Send size={15} />{sendTest.isPending ? "Sending..." : "Send message"}</button></div>
      </section>}

      {!isNew && <section className="automation-section">
        <header><h3>Message log</h3><span>{messageData?.pagination.total ?? 0} message(s)</span></header>
        <div className="table-scroll"><table><thead><tr><th>Sent</th><th>Status</th><th>Source</th><th>Body</th></tr></thead><tbody>
          {(messageData?.messages ?? []).length === 0
            ? <tr><td colSpan={4}><div className="quiet-empty">Nothing sent through this channel yet.</div></td></tr>
            : messageData!.messages.map((message) => <tr key={message.id}>
              <td>{formatTimestamp(message.createdAt)}</td>
              <td><StatusBadge status={message.status === "sent" ? "succeeded" : "failed"} label={message.status} /></td>
              <td>{message.ruleKey ? `rule · ${message.ruleKey}` : message.requestedVia === "mcp" ? "AI" : "manual"}</td>
              <td><div className="automation-message-body">{message.error ? <span className="automation-run-error">{message.error}</span> : null}<pre>{message.body}</pre></div></td>
            </tr>)}
        </tbody></table></div>
        {messageData && messageData.pagination.totalPages > 1 && <div className="table-pagination"><span>{messageData.pagination.total} total</span><div>
          <button className="icon-button" type="button" title="Previous page" aria-label="Previous message page" disabled={messagePage <= 1} onClick={() => setMessagePage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button>
          <span>Page {messagePage} of {messageData.pagination.totalPages}</span>
          <button className="icon-button" type="button" title="Next page" aria-label="Next message page" disabled={messagePage >= messageData.pagination.totalPages} onClick={() => setMessagePage((page) => page + 1)}><ChevronRight size={15} /></button>
        </div></div>}
      </section>}
    </div>

    <Modal open={deleteOpen} title="Delete channel" onClose={() => setDeleteOpen(false)}>
      <div className="delete-confirmation">
        <p>Deleting <strong>{form.name}</strong> also deletes its message log. A channel whose key is still named by a rule script cannot be deleted.</p>
        <div className="form-actions">
          <button className="button button-secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</button>
          <button className="button button-danger" type="button" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={15} />{remove.isPending ? "Deleting..." : "Delete channel"}</button>
        </div>
      </div>
    </Modal>
  </SideDrawer>;
}
