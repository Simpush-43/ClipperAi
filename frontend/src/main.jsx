import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownToLine, ArrowRight, CheckCircle2, ChevronDown, Clapperboard, Cloud,
  ExternalLink, Film, LoaderCircle, LogOut, Plus, RefreshCw, Search, ShieldCheck,
  Sparkles, Video, X, Send,
} from "lucide-react";
import { AmbientScene } from "./components/AmbientScene.jsx";
import { ClipCard } from "./components/ClipCard.jsx";
import { JobPanel } from "./components/JobPanel.jsx";
import { Login } from "./components/Login.jsx";
import { useClipLibrary } from "./hooks/useClipLibrary.js";
import { api } from "./lib/api.js";
import { duration } from "./utils/format.js";
import "./styles.css";

function App() {
  const [authenticated, setAuthenticated] = useState(null);
  const [url, setUrl] = useState("");
  const [maxClips, setMaxClips] = useState("6");
  const [job, setJob] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");
  const [playing, setPlaying] = useState(null);
  const [playbackUrl, setPlaybackUrl] = useState("");
  const [toast, setToast] = useState("");
  const [activeTab, setActiveTab] = useState("library");
  const [menuOpen, setMenuOpen] = useState(false);
  const [instagramSettingsOpen, setInstagramSettingsOpen] = useState(false);
  const [instagramUserId, setInstagramUserId] = useState("");
  const [instagramTokenConfigured, setInstagramTokenConfigured] = useState(false);
  const [instagramSettingsBusy, setInstagramSettingsBusy] = useState(false);
  const [instagramSettingsError, setInstagramSettingsError] = useState("");

  function notify(message) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3400);
  }

  const { clips, setClips, cursor, loadingClips, loadClips, removeClip } = useClipLibrary(
    () => setAuthenticated(false), notify,
  );

  useEffect(() => {
    api("/api/health").then(({ authenticated: value }) => setAuthenticated(value)).catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (authenticated) loadClips(true);
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    api("/api/settings/instagram")
      .then((settings) => {
        setInstagramUserId(settings.userId || "");
        setInstagramTokenConfigured(settings.tokenConfigured);
      })
      .catch((error) => notify(error.message));
  }, [authenticated]);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const updated = await api(`/api/jobs/${job.id}`);
        setJob(updated);
        if (["complete", "failed"].includes(updated.status)) {
          window.clearInterval(timer);
          if (updated.status === "complete") {
            notify(`${updated.clipCount || "Your"} clips are ready in the library`);
            loadClips(true);
          }
        }
      } catch (error) {
        notify(error.message);
        window.clearInterval(timer);
      }
    }, 1600);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  async function submitVideo(event) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const created = await api("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), maxClips: Number(maxClips) }),
      });
      setJob(created);
      setActiveTab("create");
    } catch (error) {
      notify(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function playClip(clip) {
    setPlaying(clip);
    setPlaybackUrl("");
    try {
      const result = await api(`/api/clips/${clip.id}/playback`);
      setPlaybackUrl(result.url);
    } catch (error) {
      notify(error.message);
      setPlaying(null);
    }
  }

  async function deleteClip(clip) {
    if (!window.confirm(`Permanently delete “${clip.title || "this clip"}”?`)) return;
    try {
      await api(`/api/clips/${clip.id}`, { method: "DELETE" });
      removeClip(clip.id);
      notify("Clip deleted from R2 and the library");
    } catch (error) {
      notify(error.message);
    }
  }

  function updateClip(clipId, updates) {
    setClips((items) => items.map((clip) => clip.id === clipId ? { ...clip, ...updates } : clip));
  }

  async function logout() {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    setAuthenticated(false);
    setClips([]);
    setJob(null);
  }

  async function saveInstagramSettings(event) {
    event.preventDefault();
    setInstagramSettingsBusy(true);
    setInstagramSettingsError("");
    try {
      const settings = await api("/api/settings/instagram", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: instagramUserId }),
      });
      setInstagramUserId(settings.userId);
      setInstagramTokenConfigured(settings.tokenConfigured);
      setInstagramSettingsOpen(false);
      notify("Instagram account saved for future Reel uploads");
    } catch (error) {
      setInstagramSettingsError(error.message);
    } finally {
      setInstagramSettingsBusy(false);
    }
  }

  if (authenticated === null) return <div className="boot-screen"><div className="boot-mark"><Clapperboard size={20} /></div><span>Opening your studio</span><LoaderCircle className="spin" size={15} /></div>;
  if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />;

  const filtered = clips.filter((clip) => `${clip.title} ${clip.videoId}`.toLowerCase().includes(search.toLowerCase()));
  const busy = job && ["queued", "running"].includes(job.status);

  return <div className="app-layout">
    <aside className="rail">
      <a href="#home" className="rail-brand" title="Clipper"><Clapperboard size={19} /></a><div className="rail-divider" />
      <button className={`rail-link ${activeTab === "library" ? "rail-active" : ""}`} onClick={() => { setActiveTab("library"); setMenuOpen(false); }} title="Library"><Film size={18} /><span>Library</span></button>
      <button className={`rail-link ${activeTab === "create" ? "rail-active" : ""}`} onClick={() => { setActiveTab("create"); setMenuOpen(false); }} title="Create"><Plus size={19} /><span>Create</span></button>
      <div className="rail-bottom"><div className="rail-status"><span className="status-pulse" /><span>R2 READY</span></div><button className="rail-link rail-logout" onClick={logout} title="Sign out"><LogOut size={17} /><span>Sign out</span></button></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div className="top-brand"><span className="mobile-brand"><Clapperboard size={16} /></span><span>Clipper <b>/</b> {activeTab === "create" ? "New edit" : "Library"}</span></div><div className="top-actions"><span className="secure-label"><ShieldCheck size={14} /> PRIVATE WORKSPACE</span><button className="user-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Open account menu">P<ChevronDown size={13} /></button>{menuOpen && <div className="user-dropdown"><span>Local workspace</span><button onClick={() => { setMenuOpen(false); setInstagramSettingsOpen(true); }}><Send size={14} /> Instagram account</button><button onClick={logout}><LogOut size={14} /> Sign out</button></div>}</div></header>
      <div className="page-content">
        <section className="welcome-row"><div><div className="date-kicker">CLIPPER STUDIO <span>·</span> PRIVATE MEDIA WORKSPACE</div><h1>{activeTab === "create" ? <>Shape the long<br /><em>into the lasting.</em></> : <>The signal is<br /><em>in the edit.</em></>}</h1><p>{activeTab === "create" ? "Give a video a starting point. We’ll find the moments worth keeping." : "A private archive for the moments that hold attention."}</p></div><div className={`signal-panel ${busy ? "signal-active" : ""}`}><div className="signal-label"><span>{busy ? "PROCESSING SIGNAL" : "STUDIO SIGNAL"}</span><span>{busy ? job.stage.replaceAll("_", " ").toUpperCase() : "SIGNAL / 001"}</span></div><AmbientScene active={Boolean(busy)} /><div className="signal-foot"><span><i /> {busy ? job.message : "ENGINE STANDBY"}</span><Cloud size={14} /></div></div></section>

        <section className="create-panel"><div className="create-heading"><div className="create-icon"><Video size={17} /></div><div><h2>Start with a video</h2><p>Paste a YouTube link and we’ll find the moments with a pulse.</p></div><span className="step-label">01 <span>/</span> SOURCE</span></div>
          <form className="url-form" onSubmit={submitVideo}><label className="url-box"><Video size={17} /><input type="url" placeholder="https://youtube.com/watch?v=..." value={url} onChange={(event) => setUrl(event.target.value)} required disabled={Boolean(busy)} /><span>YOUTUBE URL</span></label><label className="clip-count-select"><span>CLIPS</span><select value={maxClips} onChange={(event) => setMaxClips(event.target.value)} disabled={Boolean(busy)}>{[3, 4, 6, 8, 10, 12].map((count) => <option key={count} value={count}>{count}</option>)}</select><ChevronDown size={13} /></label><button className="button button-generate" disabled={submitting || Boolean(busy)}>{submitting ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}<span>{busy ? "Processing" : "Create clips"}</span><ArrowRight size={16} /></button></form>
          <div className="privacy-foot"><ShieldCheck size={13} /> Video is processed for clips; finished clips are saved to your private cloud library. <span>Auto-cleared after 21 days.</span></div>
          {job && <JobPanel job={job} />}
        </section>

        <section className="library-section"><div className="section-heading"><div><div className="date-kicker">THE ARCHIVE</div><h2>Your clip library <span className="clip-count-badge">{clips.length}</span></h2></div><button className="refresh-button" onClick={() => loadClips(true)} disabled={loadingClips}>{loadingClips ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Refresh</button></div>
          <div className="library-toolbar"><label className="search-field"><Search size={15} /><input type="search" placeholder="Search titles or source video..." value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label><div className="filter-label"><span className="filter-dot" /> ALL CLIPS <ChevronDown size={13} /></div></div>
          {loadingClips && clips.length === 0 ? <div className="skeleton-grid">{[0, 1, 2].map((item) => <div className="skeleton-card" key={item}><div /><span /><i /></div>)}</div> : filtered.length ? <div className="clip-grid">{filtered.map((clip) => <ClipCard key={clip.id} clip={clip} onPlay={playClip} onDelete={deleteClip} onClipUpdate={updateClip} notify={notify} />)}</div> : <div className="empty-library"><div className="empty-icon"><Film size={22} /></div><h3>{search ? "No clips match that search" : "Your archive is waiting"}</h3><p>{search ? "Try a different title or source video ID." : "Paste a YouTube link above and your finished clips will land here."}</p></div>}
          {cursor && <div className="more-row"><button className="button button-outline" onClick={() => loadClips(false)} disabled={loadingClips}>{loadingClips ? <LoaderCircle size={15} className="spin" /> : "Load older clips"}<ArrowDownToLine size={14} /></button></div>}
        </section>
        <footer className="workspace-footer"><span>CLIPPER <b>STUDIO</b></span><span><span className="footer-dot" /> PRIVATE R2 STORAGE <span className="footer-separator">/</span> 21 DAY RETENTION</span></footer>
      </div>
    </main>
    {playing && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setPlaying(null); setPlaybackUrl(""); } }}><section className="video-modal"><div className="modal-heading"><div><span className="date-kicker">PLAYING SELECTED MOMENT</span><h2>{playing.title || "Untitled clip"}</h2><p>{playing.videoId} <span>·</span> {duration(playing.start, playing.end)}</p></div><button className="modal-close" onClick={() => { setPlaying(null); setPlaybackUrl(""); }} aria-label="Close player"><X size={18} /></button></div>{playbackUrl ? <video src={playbackUrl} controls autoPlay playsInline /> : <div className="video-loading"><LoaderCircle size={22} className="spin" /><span>Preparing secure playback</span></div>}<a className="original-link" href={`https://youtu.be/${playing.videoId}?t=${Math.floor(playing.start)}`} target="_blank" rel="noreferrer">View original moment <ExternalLink size={13} /></a></section></div>}
    {instagramSettingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setInstagramSettingsOpen(false); }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="instagram-settings-title"><div className="modal-heading"><div><span className="date-kicker">CONNECTED ACCOUNT</span><h2 id="instagram-settings-title">Instagram</h2><p>Save the Professional Account ID used for future Reel uploads.</p></div><button className="modal-close" onClick={() => setInstagramSettingsOpen(false)} aria-label="Close Instagram settings"><X size={18} /></button></div><form onSubmit={saveInstagramSettings}><label htmlFor="instagram-user-id">INSTAGRAM PROFESSIONAL ACCOUNT ID</label><input id="instagram-user-id" inputMode="numeric" pattern="[0-9]{5,30}" value={instagramUserId} onChange={(event) => setInstagramUserId(event.target.value)} placeholder="e.g. 1784…" required /><p className="settings-help">This is the numeric Instagram Business/Creator account ID, not your @username.</p><div className={`token-status ${instagramTokenConfigured ? "token-ready" : "token-missing"}`}><span />{instagramTokenConfigured ? "Meta access token configured on server" : "Meta access token not configured on server"}</div>{instagramSettingsError && <p className="instagram-error">{instagramSettingsError}</p>}<div className="settings-actions"><button type="button" className="instagram-secondary" onClick={() => setInstagramSettingsOpen(false)}>Cancel</button><button type="submit" className="instagram-primary" disabled={instagramSettingsBusy}>{instagramSettingsBusy ? <LoaderCircle size={14} className="spin" /> : null}Save account</button></div></form></section></div>}
    {toast && <div className="toast"><CheckCircle2 size={16} />{toast}</div>}
  </div>;
}

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
