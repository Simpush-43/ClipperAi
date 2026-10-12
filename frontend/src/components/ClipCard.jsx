import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowRight, Check, CheckSquare, Clock3, Copy, ExternalLink, LoaderCircle, Play, RefreshCw, Send, Share2, Trash2, Video } from "lucide-react";
import { api } from "../lib/api.js";
import { dateLabel, duration } from "../utils/format.js";

export function ClipCard({ clip, onPlay, onDelete, onInstagramUpdate, onClipUpdate, notify }) {
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [showInstagram, setShowInstagram] = useState(false);
  const [instagramStatus, setInstagramStatus] = useState(clip.instagram?.status || "");
  const [instagramBusy, setInstagramBusy] = useState(false);
  const [instagramError, setInstagramError] = useState("");
  const [caption, setCaption] = useState(clip.caption || clip.instagram?.caption || clip.title || "");
  const [hashtagsText, setHashtagsText] = useState((clip.hashtags || []).join(" "));
  const [reviewStatus, setReviewStatus] = useState(clip.reviewStatus || "needs_review");
  const [checklist, setChecklist] = useState({ captionCopied: false, fileDownloaded: false, posted: false, ...(clip.postingChecklist || {}) });
  const [savingSocial, setSavingSocial] = useState(false);
  const [socialError, setSocialError] = useState("");

  useEffect(() => {
    if (!clip.hasThumbnail) return undefined;
    let active = true;
    api(`/api/clips/${clip.id}/playback`)
      .then(({ thumbnailUrl: url }) => { if (active && url) setThumbnailUrl(url); })
      .catch(() => { if (active) setThumbnailFailed(true); });
    return () => { active = false; };
  }, [clip.id, clip.hasThumbnail]);

  const previewUrl = thumbnailUrl || (!clip.hasThumbnail && clip.videoId
    ? `https://i.ytimg.com/vi/${encodeURIComponent(clip.videoId)}/hqdefault.jpg`
    : "");

  const expiresAt = new Date(clip.expiresAt || new Date(clip.createdAt).getTime() + 21 * 24 * 60 * 60 * 1000);
  const daysRemaining = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000));

  async function persistSocial(patch = {}) {
    setSavingSocial(true);
    setSocialError("");
    const next = {
      caption,
      hashtags: hashtagsText.split(/[\s,]+/).map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.startsWith("#") ? tag : `#${tag}`),
      reviewStatus,
      postingChecklist: checklist,
      ...patch,
    };
    try {
      const result = await api(`/api/clips/${clip.id}/social`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!result.updated) throw new Error("Clip was not found");
      onClipUpdate?.(clip.id, next);
      return next;
    } catch (error) {
      setSocialError(error.message);
      throw error;
    } finally {
      setSavingSocial(false);
    }
  }

  async function copyCaption() {
    const fullCaption = [caption.trim(), hashtagsText.trim()].filter(Boolean).join("\n\n");
    await navigator.clipboard.writeText(fullCaption);
    const nextChecklist = { ...checklist, captionCopied: true };
    setChecklist(nextChecklist);
    await persistSocial({ postingChecklist: nextChecklist });
    notify?.("Caption copied");
  }

  async function openDownload() {
    try {
      const links = await api(`/api/clips/${clip.id}/playback`);
      window.location.assign(links.downloadUrl);
      const nextChecklist = { ...checklist, fileDownloaded: true };
      setChecklist(nextChecklist);
      await persistSocial({ postingChecklist: nextChecklist });
    } catch (error) { setSocialError(error.message); }
  }

  async function shareClip() {
    try {
      const links = await api(`/api/clips/${clip.id}/playback`);
      const shareData = { title: clip.title || "Clip", text: caption || clip.title || "", url: links.url };
      if (navigator.share) await navigator.share(shareData);
      else {
        await navigator.clipboard.writeText(links.url);
        notify?.("Temporary share link copied (valid for 1 hour)");
      }
    } catch (error) {
      if (error.name !== "AbortError") setSocialError(error.message);
    }
  }

  async function markPosted() {
    const nextChecklist = { ...checklist, posted: true };
    setChecklist(nextChecklist);
    setReviewStatus("posted_manually");
    await persistSocial({ reviewStatus: "posted_manually", postingChecklist: nextChecklist });
  }

  async function prepareReel() {
    setInstagramBusy(true); setInstagramError("");
    try {
      const result = await api(`/api/clips/${clip.id}/instagram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption }),
      });
      setInstagramStatus(result.status);
      onInstagramUpdate?.(clip.id, { status: result.status, caption });
    } catch (error) { setInstagramError(error.message); }
    finally { setInstagramBusy(false); }
  }

  async function refreshReelStatus() {
    setInstagramBusy(true); setInstagramError("");
    try {
      const result = await api(`/api/clips/${clip.id}/instagram/status`);
      setInstagramStatus(result.status);
      onInstagramUpdate?.(clip.id, { status: result.status });
    } catch (error) { setInstagramError(error.message); }
    finally { setInstagramBusy(false); }
  }

  async function publishReel() {
    if (!window.confirm("Publish this Reel to the connected Instagram account now?")) return;
    setInstagramBusy(true); setInstagramError("");
    try {
      const result = await api(`/api/clips/${clip.id}/instagram/publish`, { method: "POST" });
      setInstagramStatus(result.status);
      onInstagramUpdate?.(clip.id, { status: result.status, mediaId: result.mediaId });
    } catch (error) { setInstagramError(error.message); }
    finally { setInstagramBusy(false); }
  }

  return <article className="clip-card">
    <button type="button" className="clip-preview" onClick={() => onPlay(clip)} aria-label={`Play ${clip.title || "clip"}`}>
      {previewUrl && !thumbnailFailed && <img src={previewUrl} alt={`Frame from ${clip.title || "clip"}`} loading="lazy" onError={() => setThumbnailFailed(true)} />}
      {!previewUrl && !thumbnailFailed && clip.hasThumbnail && <span className="thumbnail-loading"><LoaderCircle size={17} className="spin" /></span>}
      {(!previewUrl || thumbnailFailed) && <span className="thumbnail-fallback"><Video size={20} /></span>}
      <span className="preview-play"><Play size={16} fill="currentColor" /></span><span className="preview-duration"><Clock3 size={11} /> {duration(clip.start, clip.end)}</span>
    </button>
    <div className="clip-card-body"><div className="clip-title-row"><h3>{clip.title || "Untitled moment"}</h3><button type="button" className="icon-button" onClick={() => onDelete(clip)} title="Delete clip" aria-label={`Delete ${clip.title || "clip"}`}><Trash2 size={15} /></button></div>
      <div className="clip-card-meta"><span><Video size={12} /> {clip.videoId}</span><span>{dateLabel(clip.createdAt)}</span></div>
      <div className="clip-card-bottom"><span className={`ready-label review-${reviewStatus}`}><i /> {reviewStatus === "needs_review" ? "NEEDS REVIEW" : reviewStatus === "approved" ? "APPROVED" : "POSTED MANUALLY"}</span><button type="button" className="text-action" onClick={() => onPlay(clip)}>Watch clip <ArrowRight size={13} /></button></div>
      <div className="clip-social-row"><button type="button" className="instagram-action" onClick={() => setShowInstagram(!showInstagram)} aria-expanded={showInstagram}><Send size={13} /> {instagramStatus === "PUBLISHED" ? "Published" : "Manual post"}</button>{instagramStatus && <span className={`instagram-state ${instagramStatus === "PUBLISHED" ? "is-published" : ""}`}>{instagramStatus}</span>}</div>
      <div className={`expiry-note ${daysRemaining <= 3 ? "expiry-soon" : ""}`}><Clock3 size={12} /> {daysRemaining === 0 ? "Expires today" : `${daysRemaining} days left`} <span>·</span> {expiresAt.toLocaleDateString()}</div>
      {showInstagram && <div className="instagram-panel"><div className="caption-editor"><label htmlFor={`caption-${clip.id}`}>CAPTION</label><textarea id={`caption-${clip.id}`} maxLength={2200} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Write a caption for your post" disabled={instagramBusy || instagramStatus === "PUBLISHED"} /><span className="caption-count">{caption.length}/2200</span><label htmlFor={`hashtags-${clip.id}`}>HASHTAGS</label><input id={`hashtags-${clip.id}`} value={hashtagsText} onChange={(event) => setHashtagsText(event.target.value)} placeholder="#creator #reels #topic" disabled={instagramStatus === "PUBLISHED"} /><div className="caption-actions"><button type="button" className="instagram-secondary" onClick={copyCaption} disabled={savingSocial}><Copy size={13} /> Copy caption</button><button type="button" className="instagram-secondary" onClick={() => persistSocial()} disabled={savingSocial}>{savingSocial ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} Save text</button></div></div>
        <label className="review-select-label" htmlFor={`review-${clip.id}`}>REVIEW STATUS</label><select id={`review-${clip.id}`} className="review-select" value={reviewStatus} onChange={async (event) => { setReviewStatus(event.target.value); await persistSocial({ reviewStatus: event.target.value }); }}><option value="needs_review">Needs review</option><option value="approved">Approved</option><option value="posted_manually">Posted manually</option></select>
        <div className="manual-checklist"><span className="checklist-heading">MANUAL POST CHECKLIST</span><label><input type="checkbox" checked={Boolean(checklist.captionCopied)} onChange={async (event) => { const next = { ...checklist, captionCopied: event.target.checked }; setChecklist(next); await persistSocial({ postingChecklist: next }); }} /> Caption copied</label><label><input type="checkbox" checked={Boolean(checklist.fileDownloaded)} onChange={async (event) => { const next = { ...checklist, fileDownloaded: event.target.checked }; setChecklist(next); await persistSocial({ postingChecklist: next }); }} /> Clip downloaded</label><label><input type="checkbox" checked={Boolean(checklist.posted)} onChange={async (event) => { if (event.target.checked) await markPosted(); else { const next = { ...checklist, posted: false }; setChecklist(next); setReviewStatus("approved"); await persistSocial({ reviewStatus: "approved", postingChecklist: next }); } }} /> Posted manually</label></div>
        <div className="instagram-controls"><button type="button" className="instagram-primary" onClick={openDownload}><ArrowDownToLine size={13} /> Download clip</button><button type="button" className="instagram-secondary" onClick={shareClip}><Share2 size={13} /> Share</button><a className="instagram-secondary business-suite-link" href="https://business.facebook.com/latest/home" target="_blank" rel="noreferrer">Open Business Suite <ExternalLink size={12} /></a></div>
        {socialError && <p className="instagram-error">{socialError}</p>}
        <div className="instagram-controls instagram-api-controls">{instagramError && <p className="instagram-error">{instagramError}</p>}{!instagramStatus && <button className="instagram-secondary" onClick={prepareReel} disabled={instagramBusy}>{instagramBusy ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />} Optional: prepare via Meta API</button>}{instagramStatus && instagramStatus !== "PUBLISHED" && <button className="instagram-secondary" onClick={refreshReelStatus} disabled={instagramBusy}>{instagramBusy ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Check Meta status</button>}{instagramStatus === "FINISHED" && <button className="instagram-primary" onClick={publishReel} disabled={instagramBusy}><Send size={13} /> Publish now</button>}{instagramStatus === "PUBLISHED" && <span className="published-note"><Check size={13} /> Live on Instagram</span>}</div>
      </div>}
    </div>
  </article>;
}
