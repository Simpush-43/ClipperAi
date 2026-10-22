import { useMemo, useState } from "react";
import { ArrowRight, Clapperboard, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "../lib/api.js";
import { AmbientScene } from "./AmbientScene.jsx";

const modeOptions = {
  login: "Login",
  signup: "Create account",
  reset: "Reset password",
};

export function Login({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const title = useMemo(() => modeOptions[mode] || "Login", [mode]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setInfo("");

    try {
      if (mode === "signup") {
        const result = await api("/api/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, password }),
        });
        onLogin(result.user);
        return;
      }

      if (mode === "reset") {
        const result = await api("/api/request-reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        setInfo(result.message || "If that account exists, a reset email was sent.");
        setMode("login");
        setPassword("");
        return;
      }

      await api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      onLogin();
    } catch (issue) {
      setError(issue.message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-screen">
    <div className="login-copy"><a className="brand" href="#"><span className="brand-symbol"><Clapperboard size={18} /></span> clipper<span className="brand-dot">.</span></a>
      <div className="login-heading"><span className="kicker">YOUR PRIVATE STUDIO</span><h1>Good moments<br /><em>don’t get lost.</em></h1><p>Turn long videos into a considered library of watchable moments.</p></div>
      <form onSubmit={submit} className="login-form">
        <div className="account-switch" role="tablist" aria-label="Authentication mode">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Login</button>
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Sign up</button>
          <button type="button" className={mode === "reset" ? "active" : ""} onClick={() => setMode("reset")}>Reset</button>
        </div>

        {mode === "signup" && (
          <label htmlFor="name">Full name
            <input id="name" type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Alex Morgan" required maxLength={100} />
          </label>
        )}

        <label htmlFor="email">Email
          <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required />
        </label>

        {mode !== "reset" && (
          <label htmlFor="password">Password
            <input id="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
        )}

        <button className="button button-dark" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : title}<ArrowRight size={16} /></button>
        {mode === "login" && <button type="button" className="google-button" onClick={() => window.location.assign("/api/auth/google")}><span className="google-mark">G</span>Continue with Google</button>}
        {mode === "login" && new URLSearchParams(window.location.search).has("authError") && <p className="error-text">Google sign-in did not complete. Please try again.</p>}
        {error && <p className="error-text">{error}</p>}
        {info && <p className="success-text">{info}</p>}
      </form>
      <span className="login-foot"><ShieldCheck size={14} /> Private by design <span>·</span> 21-day archive</span>
    </div>
    <div className="login-art"><div className="art-index">FRAME / 001 <span>CLIPPER STUDIO</span></div><AmbientScene active={false} /><div className="art-caption"><Sparkles size={15} /> LESS SCROLLING, MORE SIGNAL</div><div className="art-bottom">A small edit of what matters.</div></div>
  </main>;
}
