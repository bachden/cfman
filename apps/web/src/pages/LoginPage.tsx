import { CloudCog, Eye, EyeOff, LockKeyhole, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import { FieldHelp } from "../components/FieldHelp";
import type { User } from "../types";

export function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const result = await api.post<{ user: User }>("/api/auth/login", { username, password });
      onLogin(result.user);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Unable to sign in");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="login-brand"><span><CloudCog size={23} /></span><strong>cfman</strong></div>
        <form onSubmit={submit}>
          <div className="login-heading"><h1>Sign in</h1><p>Tunnel operations</p></div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <label className="field">
            <span className="field-label">Username <FieldHelp text="The local CFMan administrator username, not a Cloudflare login. A new installation starts with root." /></span>
            <div className="input-with-icon"><UserRound size={17} /><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></div>
          </label>
          <label className="field">
            <span className="field-label">Password <FieldHelp text="The local CFMan administrator password. Do not enter your Cloudflare account password or API token here." /></span>
            <div className="input-with-icon"><LockKeyhole size={17} /><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          </label>
          <button className="button button-primary login-submit" type="submit" disabled={submitting}>{submitting ? "Signing in..." : "Sign in"}</button>
        </form>
        <div className="login-foot">Authorized personnel only</div>
      </div>
      <div className="login-context">
        <div className="network-lines" aria-hidden="true"><i /><i /><i /><i /></div>
        <div className="context-copy"><span>CFMan infrastructure</span><strong>Tunnel Network Operations</strong></div>
        <div className="context-stats"><div><strong>Control plane</strong><span>Cloudflare Tunnel</span></div><div><strong>Asia Pacific</strong><span>Operations region</span></div></div>
      </div>
    </div>
  );
}
