import { useState } from "react";
import { ArrowRight, Clapperboard, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "../lib/api.js";
import { AmbientScene } from "./AmbientScene.jsx";

export function Login({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
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
      <form onSubmit={submit} className="login-form"><label htmlFor="password">Workspace password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button className="button button-dark" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : "Enter workspace"}<ArrowRight size={16} /></button>{error && <p className="error-text">{error}</p>}</form>
      <span className="login-foot"><ShieldCheck size={14} /> Private by design <span>·</span> 21-day archive</span>
    </div>
    <div className="login-art"><div className="art-index">FRAME / 001 <span>CLIPPER STUDIO</span></div><AmbientScene active={false} /><div className="art-caption"><Sparkles size={15} /> LESS SCROLLING, MORE SIGNAL</div><div className="art-bottom">A small edit of what matters.</div></div>
  </main>;
}
